import { store } from '../store.js';
import { buildAuthUrl, buildConnectRequest, parseFrame, getSessionKey } from './protocol.js';

const HEARTBEAT_INTERVAL = 30_000;
const RECONNECT_BASE = 1000;
const RECONNECT_CAP = 30_000;
const CONNECT_SEND_DELAY = 750;

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let connectTimer = null;
let reconnectAttempt = 0;
let authenticated = false;
let connectSent = false;
let currentAuthToken = null;
let connectId = null;
let eventHandlers = new Map();

function setState(connectionState, error = null) {
  store.update('connection', { state: connectionState, error });
}

function getReconnectDelay() {
  const base = Math.min(RECONNECT_BASE * 2 ** reconnectAttempt, RECONNECT_CAP);
  const jitter = base * 0.3 * Math.random();
  return base + jitter;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function sendConnect() {
  if (connectSent) return;
  connectSent = true;
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  const frame = buildConnectRequest(currentAuthToken);
  connectId = frame.id;
  send(frame);
  console.log('[gateway] sent connect request', frame);
}

function emit(event, data) {
  const handlers = eventHandlers.get(event) || new Set();
  const wildcardHandlers = eventHandlers.get('*') || new Set();
  handlers.forEach((fn) => fn(data));
  wildcardHandlers.forEach((fn) => fn(data));
}

function handleMessage(raw, settings) {
  const frame = parseFrame(raw);
  console.log('[gateway frame]', frame);

  // Challenge received - send connect immediately (no device auth, skip signing)
  if (frame.type === 'event' && frame.event === 'connect.challenge') {
    sendConnect();
    return;
  }

  // Hello-ok response to our connect request
  if (frame.type === 'res' && frame.id === connectId) {
    if (frame.ok !== false && !frame.error) {
      authenticated = true;
      reconnectAttempt = 0;
      setState('CONNECTED');
      startHeartbeat();
      flushQueue(settings);
      emit('connected', frame);
      console.log('[gateway] connected (hello-ok)', frame);
    } else {
      const err = frame.error?.message || 'Connect rejected';
      console.error('[gateway] connect failed:', err);
      setState('DISCONNECTED', err);
      cleanup();
    }
    return;
  }

  // Forward all other frames to listeners
  emit(frame.type || 'message', frame);
  if (frame.event) {
    emit(frame.event, frame);
  }
}

function cleanup() {
  stopHeartbeat();
  authenticated = false;
  connectSent = false;
  currentAuthToken = null;
  connectId = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  if (ws) {
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }
}

function scheduleReconnect(settings) {
  const delay = getReconnectDelay();
  reconnectAttempt++;
  setState('RECONNECTING');
  reconnectTimer = setTimeout(() => {
    gateway.connect(settings);
  }, delay);
}

export const gateway = {
  connect(settings) {
    cleanup();
    setState('CONNECTING');

    const { gatewayUrl, authToken } = settings;
    currentAuthToken = authToken;
    const url = buildAuthUrl(gatewayUrl, authToken);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      setState('DISCONNECTED', err.message);
      return;
    }

    ws.onopen = () => {
      console.log('[gateway] WebSocket open, waiting for challenge...');
      // Send connect after delay if no challenge arrives (mirrors Studio behavior)
      connectTimer = setTimeout(() => sendConnect(), CONNECT_SEND_DELAY);
    };

    ws.onmessage = (event) => handleMessage(event.data, settings);

    ws.onerror = () => {};

    ws.onclose = () => {
      const prevState = store.get().connection.state;
      cleanup();
      if (prevState === 'CONNECTED' || prevState === 'CONNECTING') {
        scheduleReconnect(settings);
      } else {
        setState('DISCONNECTED');
      }
    };
  },

  disconnect() {
    cleanup();
    setState('DISCONNECTED');
  },

  sendMessage(text) {
    if (!authenticated) return Promise.reject(new Error('Not authenticated'));
    const { settings } = store.get();
    const sessionKey = getSessionKey(settings.agentId);
    const payload = {
      type: 'message',
      sessionKey,
      text,
      id: crypto.randomUUID(),
    };
    if (send(payload)) {
      return Promise.resolve(payload);
    }
    return Promise.reject(new Error('Not connected'));
  },

  on(event, handler) {
    if (!eventHandlers.has(event)) {
      eventHandlers.set(event, new Set());
    }
    eventHandlers.get(event).add(handler);
    return () => eventHandlers.get(event).delete(handler);
  },

  off(event, handler) {
    eventHandlers.get(event)?.delete(handler);
  },

  async testConnection(url, token) {
    return new Promise((resolve) => {
      let testWs;
      let sent = false;
      const timer = setTimeout(() => {
        testWs?.close();
        resolve({ ok: false, error: 'Connection timeout (5s)' });
      }, 5000);

      try {
        testWs = new WebSocket(buildAuthUrl(url, token));
      } catch (err) {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
        return;
      }

      function doSendConnect() {
        if (sent) return;
        sent = true;
        const frame = buildConnectRequest(token);
        testWs.send(JSON.stringify(frame));
        return frame.id;
      }

      let testConnectId;
      let sendTimer;

      testWs.onopen = () => {
        sendTimer = setTimeout(() => {
          testConnectId = doSendConnect();
        }, CONNECT_SEND_DELAY);
      };

      testWs.onmessage = (event) => {
        const frame = parseFrame(event.data);

        if (frame.event === 'connect.challenge') {
          if (sendTimer) clearTimeout(sendTimer);
          testConnectId = doSendConnect();
          return;
        }

        if (frame.type === 'res' && frame.id === testConnectId) {
          clearTimeout(timer);
          testWs.close();
          if (frame.ok !== false && !frame.error) {
            resolve({ ok: true });
          } else {
            resolve({ ok: false, error: frame.error?.message || 'Auth rejected' });
          }
        }
      };

      testWs.onerror = () => {
        clearTimeout(timer);
        resolve({ ok: false, error: 'Connection failed - check URL and network' });
      };
    });
  },

  get isConnected() {
    return authenticated && store.get().connection.state === 'CONNECTED';
  },
};

function flushQueue(settings) {
  const { pendingQueue } = store.get();
  if (pendingQueue.length === 0) return;

  const sessionKey = getSessionKey(settings.agentId);

  for (const item of pendingQueue) {
    const payload = {
      type: 'message',
      sessionKey,
      text: item.text,
      id: item.idempotencyKey,
    };
    if (send(payload)) {
      store.dequeue(item.idempotencyKey);
    }
  }
}

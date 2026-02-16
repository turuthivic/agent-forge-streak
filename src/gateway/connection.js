import { store } from '../store.js';
import {
  buildConnect,
  buildChatSend,
  buildPing,
  parseFrame,
  isResponse,
  getSessionKey,
} from './protocol.js';

const HEARTBEAT_INTERVAL = 30_000;
const RECONNECT_BASE = 1000;
const RECONNECT_CAP = 30_000;

let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let pendingRequests = new Map(); // id -> { resolve, reject, timeout }
let eventHandlers = new Map(); // event name -> Set<handler>

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
      send(buildPing());
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

function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const req = { type: 'req', id: crypto.randomUUID(), method, params };
    const timeout = setTimeout(() => {
      pendingRequests.delete(req.id);
      reject(new Error(`Request ${method} timed out`));
    }, 15_000);

    pendingRequests.set(req.id, { resolve, reject, timeout });

    if (!send(req)) {
      clearTimeout(timeout);
      pendingRequests.delete(req.id);
      reject(new Error('Not connected'));
    }
  });
}

function handleMessage(raw) {
  const frame = parseFrame(raw);

  // Handle response frames
  if (frame.type === 'res' && pendingRequests.has(frame.id)) {
    const { resolve, timeout } = pendingRequests.get(frame.id);
    clearTimeout(timeout);
    pendingRequests.delete(frame.id);
    resolve(frame);
    return;
  }

  // Handle event frames
  if (frame.type === 'event') {
    const handlers = eventHandlers.get(frame.event) || new Set();
    const wildcardHandlers = eventHandlers.get('*') || new Set();
    handlers.forEach((fn) => fn(frame));
    wildcardHandlers.forEach((fn) => fn(frame));
    return;
  }
}

function cleanup() {
  stopHeartbeat();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  pendingRequests.forEach(({ reject, timeout }) => {
    clearTimeout(timeout);
    reject(new Error('Connection closed'));
  });
  pendingRequests.clear();
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

    try {
      ws = new WebSocket(gatewayUrl);
    } catch (err) {
      setState('DISCONNECTED', err.message);
      return;
    }

    ws.onopen = () => {
      const connectFrame = buildConnect(authToken);
      const connectId = connectFrame.id;

      // Set up a one-time handler for the connect response
      pendingRequests.set(connectId, {
        resolve: (frame) => {
          if (frame.result && !frame.error) {
            reconnectAttempt = 0;
            setState('CONNECTED');
            startHeartbeat();
            flushQueue(settings);
            // Emit connect event to listeners
            const handlers = eventHandlers.get('connected') || new Set();
            handlers.forEach((fn) => fn());
          } else {
            const err = frame.error?.message || 'Handshake rejected';
            setState('DISCONNECTED', err);
            cleanup();
          }
        },
        reject: () => setState('DISCONNECTED', 'Handshake timeout'),
        timeout: setTimeout(() => {
          pendingRequests.delete(connectId);
          setState('DISCONNECTED', 'Handshake timeout');
          cleanup();
        }, 10_000),
      });

      send(connectFrame);
    };

    ws.onmessage = (event) => handleMessage(event.data);

    ws.onerror = () => {
      // onerror is followed by onclose, so just let onclose handle state
    };

    ws.onclose = () => {
      const wasConnected = store.get().connection.state === 'CONNECTED';
      cleanup();
      if (wasConnected || store.get().connection.state === 'CONNECTING') {
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
    const { settings } = store.get();
    const sessionKey = getSessionKey(settings.agentId);
    return request('chat.send', {
      sessionKey,
      message: { text },
      idempotencyKey: crypto.randomUUID(),
    });
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
      const timer = setTimeout(() => {
        testWs?.close();
        resolve({ ok: false, error: 'Connection timeout (5s)' });
      }, 5000);

      try {
        testWs = new WebSocket(url);
      } catch (err) {
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
        return;
      }

      testWs.onopen = () => {
        const frame = buildConnect(token);
        const connectId = frame.id;

        testWs.onmessage = (event) => {
          const res = parseFrame(event.data);
          if (isResponse(res, connectId)) {
            clearTimeout(timer);
            testWs.close();
            if (res.result && !res.error) {
              resolve({ ok: true });
            } else {
              resolve({ ok: false, error: res.error?.message || 'Auth rejected' });
            }
          }
        };

        testWs.send(JSON.stringify(frame));
      };

      testWs.onerror = () => {
        clearTimeout(timer);
        resolve({ ok: false, error: 'Connection failed - check URL and network' });
      };
    });
  },

  get isConnected() {
    return store.get().connection.state === 'CONNECTED';
  },
};

function flushQueue(settings) {
  const { pendingQueue } = store.get();
  if (pendingQueue.length === 0) return;

  const sessionKey = getSessionKey(settings.agentId);

  for (const item of pendingQueue) {
    request('chat.send', {
      sessionKey,
      message: { text: item.text },
      idempotencyKey: item.idempotencyKey,
    })
      .then(() => store.dequeue(item.idempotencyKey))
      .catch(() => {
        // Will retry on next reconnect
      });
  }
}

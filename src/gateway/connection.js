import { store } from '../store.js';
import {
  buildAuthUrl, buildConnectRequest, parseFrame, getSessionKey,
  CLIENT_ID, CLIENT_MODE, ROLE, SCOPES,
} from './protocol.js';
import {
  getOrCreateDeviceIdentity, buildDeviceAuthPayload, signPayload,
} from './device-identity.js';

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
let challengeNonce = null;
let deviceIdentity = null;
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
  let lastTick = Date.now();
  gateway.on('tick', () => { lastTick = Date.now(); });
  heartbeatTimer = setInterval(() => {
    if (Date.now() - lastTick > HEARTBEAT_INTERVAL * 3) {
      console.log('[gateway] heartbeat timeout, reconnecting...');
      const { settings } = store.get();
      cleanup();
      scheduleReconnect(settings);
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

async function sendConnect() {
  if (connectSent) return;
  connectSent = true;
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }

  // Build signed device block
  let device = null;
  if (deviceIdentity) {
    const signedAtMs = Date.now();
    const payload = buildDeviceAuthPayload({
      deviceId: deviceIdentity.id,
      clientId: CLIENT_ID,
      clientMode: CLIENT_MODE,
      role: ROLE,
      scopes: SCOPES,
      signedAtMs,
      token: currentAuthToken || null,
      nonce: challengeNonce || undefined,
    });
    const signature = await signPayload(deviceIdentity.keyPair.privateKey, payload);
    device = {
      id: deviceIdentity.id,
      publicKey: deviceIdentity.publicKeyRaw,
      signature,
      signedAt: signedAtMs,
      nonce: challengeNonce || undefined,
    };
  }

  const frame = buildConnectRequest(currentAuthToken, device, challengeNonce);
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

  // Challenge received — extract nonce and send signed connect
  if (frame.type === 'event' && frame.event === 'connect.challenge') {
    challengeNonce = frame.payload?.nonce || null;
    sendConnect();
    return;
  }

  // Response to our connect request
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
      const errCode = frame.error?.code || '';
      const errMsg = frame.error?.message || 'Connect rejected';

      // Device not paired yet — show pairing UI
      if (errCode === 'NOT_PAIRED' || errMsg.includes('NOT_PAIRED')) {
        console.log('[gateway] device not paired, awaiting approval');
        setState('PAIRING', deviceIdentity?.id || null);
        // Keep connection open — gateway may close us, then we reconnect
        return;
      }

      console.error('[gateway] connect failed:', errMsg);
      setState('DISCONNECTED', errMsg);
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
  challengeNonce = null;
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
  async connect(settings) {
    cleanup();
    setState('CONNECTING');

    const { gatewayUrl, authToken } = settings;
    currentAuthToken = authToken;

    // Load or create device identity
    try {
      deviceIdentity = await getOrCreateDeviceIdentity();
      console.log('[gateway] device identity:', deviceIdentity.id);
    } catch (err) {
      console.warn('[gateway] failed to load device identity, connecting without it:', err);
      deviceIdentity = null;
    }

    const url = buildAuthUrl(gatewayUrl, authToken);

    try {
      ws = new WebSocket(url);
    } catch (err) {
      setState('DISCONNECTED', err.message);
      return;
    }

    ws.onopen = () => {
      console.log('[gateway] WebSocket open, waiting for challenge...');
      connectTimer = setTimeout(() => sendConnect(), CONNECT_SEND_DELAY);
    };

    ws.onmessage = (event) => handleMessage(event.data, settings);

    ws.onerror = () => {};

    ws.onclose = () => {
      const prevState = store.get().connection.state;
      cleanup();
      if (prevState === 'CONNECTED' || prevState === 'CONNECTING' || prevState === 'PAIRING') {
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
      type: 'req',
      id: crypto.randomUUID(),
      method: 'chat.send',
      params: {
        sessionKey,
        message: text,
        idempotencyKey: crypto.randomUUID(),
      },
    };
    console.log('[gateway] sending chat.send', payload);
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
    let identity = null;
    try {
      identity = await getOrCreateDeviceIdentity();
    } catch { /* continue without device identity */ }

    return new Promise((resolve) => {
      let testWs;
      let sent = false;
      let testNonce = null;
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

      async function doSendConnect() {
        if (sent) return;
        sent = true;

        let device = null;
        if (identity) {
          const signedAtMs = Date.now();
          const payload = buildDeviceAuthPayload({
            deviceId: identity.id,
            clientId: CLIENT_ID,
            clientMode: CLIENT_MODE,
            role: ROLE,
            scopes: SCOPES,
            signedAtMs,
            token: token || null,
            nonce: testNonce || undefined,
          });
          const signature = await signPayload(identity.keyPair.privateKey, payload);
          device = {
            id: identity.id,
            publicKey: identity.publicKeyRaw,
            signature,
            signedAt: signedAtMs,
            nonce: testNonce || undefined,
          };
        }

        const frame = buildConnectRequest(token, device, testNonce);
        testWs.send(JSON.stringify(frame));
        return frame.id;
      }

      let testConnectId;
      let sendTimer;

      testWs.onopen = () => {
        sendTimer = setTimeout(async () => {
          testConnectId = await doSendConnect();
        }, CONNECT_SEND_DELAY);
      };

      testWs.onmessage = async (event) => {
        const frame = parseFrame(event.data);

        if (frame.event === 'connect.challenge') {
          if (sendTimer) clearTimeout(sendTimer);
          testNonce = frame.payload?.nonce || null;
          testConnectId = await doSendConnect();
          return;
        }

        if (frame.type === 'res' && frame.id === testConnectId) {
          clearTimeout(timer);
          testWs.close();
          if (frame.ok !== false && !frame.error) {
            resolve({ ok: true });
          } else {
            const errCode = frame.error?.code || '';
            const errMsg = frame.error?.message || 'Auth rejected';
            if (errCode === 'NOT_PAIRED' || errMsg.includes('NOT_PAIRED')) {
              resolve({ ok: false, error: `Device not paired. Run on VM:\nopenclaw devices approve`, deviceId: identity?.id });
            } else {
              resolve({ ok: false, error: errMsg });
            }
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

  get deviceId() {
    return deviceIdentity?.id || null;
  },
};

function flushQueue(settings) {
  const { pendingQueue } = store.get();
  if (pendingQueue.length === 0) return;

  const sessionKey = getSessionKey(settings.agentId);

  for (const item of pendingQueue) {
    const payload = {
      type: 'req',
      id: crypto.randomUUID(),
      method: 'chat.send',
      params: {
        sessionKey,
        message: item.text,
        idempotencyKey: item.idempotencyKey,
      },
    };
    if (send(payload)) {
      store.dequeue(item.idempotencyKey);
    }
  }
}

const STORAGE_KEY = 'forge_state';
const DEVICE_KEY = 'forge_device_id';

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

const defaultState = {
  settings: {
    gatewayUrl: '',
    authToken: '',
    agentId: 'agent:main',
  },
  tasks: {
    day: null,
    stats: { streak: 0, hearts: 0, xp: 0, level: 1 },
    items: [],
    rawMessage: null,
  },
  connection: {
    state: 'DISCONNECTED', // DISCONNECTED | CONNECTING | CONNECTED | RECONNECTING
    error: null,
  },
  pendingQueue: [],
  deviceId: getDeviceId(),
};

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        ...defaultState,
        ...parsed,
        connection: { ...defaultState.connection },
        deviceId: getDeviceId(),
      };
    }
  } catch { /* ignore corrupt data */ }
  return { ...defaultState };
}

function saveState(state) {
  const { connection, ...persistable } = state;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
}

let state = loadState();
const listeners = new Set();

export const store = {
  get() {
    return state;
  },

  set(partial) {
    state = { ...state, ...partial };
    saveState(state);
    listeners.forEach((fn) => fn(state));
  },

  update(path, value) {
    const keys = path.split('.');
    const newState = { ...state };
    let obj = newState;
    for (let i = 0; i < keys.length - 1; i++) {
      obj[keys[i]] = { ...obj[keys[i]] };
      obj = obj[keys[i]];
    }
    obj[keys[keys.length - 1]] = value;
    state = newState;
    saveState(state);
    listeners.forEach((fn) => fn(state));
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // Queue management for offline completions
  enqueue(item) {
    state = { ...state, pendingQueue: [...state.pendingQueue, item] };
    saveState(state);
    listeners.forEach((fn) => fn(state));
  },

  dequeue(idempotencyKey) {
    state = {
      ...state,
      pendingQueue: state.pendingQueue.filter((i) => i.idempotencyKey !== idempotencyKey),
    };
    saveState(state);
    listeners.forEach((fn) => fn(state));
  },

  clearQueue() {
    state = { ...state, pendingQueue: [] };
    saveState(state);
    listeners.forEach((fn) => fn(state));
  },
};

export function buildRequest(method, params = {}) {
  return {
    type: 'req',
    id: crypto.randomUUID(),
    method,
    params,
  };
}

export function buildConnect(authToken) {
  return buildRequest('connect', {
    auth: { token: authToken },
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      name: 'forge-pwa',
      version: '1.0.0',
    },
  });
}

export function buildChatSend(sessionKey, text) {
  return buildRequest('chat.send', {
    sessionKey,
    message: { text },
    idempotencyKey: crypto.randomUUID(),
  });
}

export function buildPing() {
  return buildRequest('ping', {});
}

export function parseFrame(data) {
  try {
    const frame = typeof data === 'string' ? JSON.parse(data) : data;
    return frame;
  } catch {
    return { type: 'unknown', raw: data };
  }
}

export function isResponse(frame, requestId) {
  return frame.type === 'res' && frame.id === requestId;
}

export function isEvent(frame) {
  return frame.type === 'event';
}

export function getSessionKey(agentId) {
  return `${agentId}:webchat:dm:forge-pwa`;
}

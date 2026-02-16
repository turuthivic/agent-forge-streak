export function buildAuthUrl(gatewayUrl, authToken) {
  const sep = gatewayUrl.includes('?') ? '&' : '?';
  return `${gatewayUrl}${sep}token=${encodeURIComponent(authToken)}`;
}

export function buildConnectRequest(authToken) {
  return {
    type: 'req',
    id: crypto.randomUUID(),
    method: 'connect',
    params: {
      auth: { token: authToken },
      minProtocol: 1,
      maxProtocol: 3,
      client: {
        id: 'webchat',
        mode: 'webchat',
        version: 'dev',
        platform: navigator.platform || 'web',
      },
    },
  };
}

export function parseFrame(data) {
  try {
    return typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return { type: 'unknown', raw: data };
  }
}

export function getSessionKey(agentId) {
  return `${agentId}:webchat:dm:forge-pwa`;
}

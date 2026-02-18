export function buildAuthUrl(gatewayUrl, authToken) {
  const sep = gatewayUrl.includes('?') ? '&' : '?';
  return `${gatewayUrl}${sep}token=${encodeURIComponent(authToken)}`;
}

export const CLIENT_ID = 'webchat';
export const CLIENT_MODE = 'webchat';
export const ROLE = 'operator';
export const SCOPES = ['operator.read', 'operator.write', 'operator.admin'];

export function buildConnectRequest(authToken, device, nonce) {
  return {
    type: 'req',
    id: crypto.randomUUID(),
    method: 'connect',
    params: {
      auth: { token: authToken },
      role: ROLE,
      scopes: SCOPES,
      minProtocol: 3,
      maxProtocol: 3,
      caps: [],
      commands: [],
      permissions: {},
      locale: navigator.language || 'en',
      userAgent: 'agent-forge-streak/dev',
      client: {
        id: CLIENT_ID,
        mode: CLIENT_MODE,
        version: 'dev',
        platform: navigator.platform || 'web',
      },
      device: device || undefined,
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
  return `agent:${agentId}:main`;
}

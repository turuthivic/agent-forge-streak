import { store } from '../store.js';
import { gateway } from '../gateway/connection.js';
import { showToast } from './status.js';

export function renderSettings(container) {
  const { settings } = store.get();

  container.innerHTML = `
    <div class="view">
      <h1>Settings</h1>
      <form class="settings-form" id="settingsForm">
        <div class="form-group">
          <label for="gatewayUrl">Gateway URL</label>
          <input
            type="url"
            id="gatewayUrl"
            placeholder="wss://machine.tailnet.ts.net"
            value="${escapeAttr(settings.gatewayUrl)}"
            required
          />
        </div>
        <div class="form-group">
          <label for="authToken">Auth Token</label>
          <input
            type="password"
            id="authToken"
            placeholder="Enter your auth token"
            value="${escapeAttr(settings.authToken)}"
            required
          />
        </div>
        <div class="form-group">
          <label for="agentId">Agent ID</label>
          <input
            type="text"
            id="agentId"
            placeholder="personal"
            value="${escapeAttr(settings.agentId)}"
          />
        </div>
        <div class="settings-actions">
          <button type="button" id="testBtn" class="btn-secondary">Test</button>
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  `;

  const form = document.getElementById('settingsForm');
  const testBtn = document.getElementById('testBtn');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveSettings();
    window.location.hash = '';
  });

  testBtn.addEventListener('click', () => testConnection());
}

function saveSettings() {
  const gatewayUrl = document.getElementById('gatewayUrl').value.trim();
  const authToken = document.getElementById('authToken').value.trim();
  const agentId = document.getElementById('agentId').value.trim() || 'personal';

  store.update('settings', { gatewayUrl, authToken, agentId });
  showToast('Settings saved', 'success');
}

async function testConnection() {
  const testBtn = document.getElementById('testBtn');
  const url = document.getElementById('gatewayUrl').value.trim();
  const token = document.getElementById('authToken').value.trim();

  if (!url || !token) {
    showToast('URL and token are required', 'error');
    return;
  }

  testBtn.disabled = true;
  testBtn.textContent = 'Testing...';

  try {
    const result = await gateway.testConnection(url, token);
    if (result.ok) {
      showToast('Connected successfully!', 'success');
    } else {
      showToast(`Failed: ${result.error}`, 'error');
    }
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = 'Test';
  }
}

function escapeAttr(str) {
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

import './styles.css';
import { store } from './store.js';
import { renderSettings } from './ui/settings.js';
import { renderMain } from './ui/tasks.js';
import { renderStatus, showToast } from './ui/status.js';
import { gateway } from './gateway/connection.js';

const app = document.getElementById('app');

function route() {
  const hash = window.location.hash;

  if (hash === '#settings') {
    renderSettings(app);
  } else {
    renderMainView();
  }
}

function renderMainView() {
  const { settings } = store.get();

  if (!settings.gatewayUrl) {
    window.location.hash = '#settings';
    return;
  }

  renderMain(app);
  connectIfNeeded();
}

function connectIfNeeded() {
  const { settings, connection } = store.get();
  if (!settings.gatewayUrl) return;
  if (connection.state === 'CONNECTED' || connection.state === 'CONNECTING') return;

  gateway.connect(settings);
}

// Boot
window.addEventListener('hashchange', route);
renderStatus();
route();

// Reconnect on online
window.addEventListener('online', () => {
  showToast('Back online', 'success');
  connectIfNeeded();
});

window.addEventListener('offline', () => {
  showToast('Offline - tasks cached locally', 'error');
});

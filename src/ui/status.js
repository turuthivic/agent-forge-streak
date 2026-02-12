let toastContainer = null;

export function renderStatus() {
  // Create toast container if it doesn't exist
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
}

export function showToast(message, type = 'info') {
  renderStatus();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  toastContainer.appendChild(toast);

  // Remove after animation completes
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

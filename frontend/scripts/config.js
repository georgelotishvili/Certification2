(() => {
  const globalObject = typeof window !== 'undefined' ? window : {};
  
  // Use current origin if no API_BASE specified
  const currentOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  
  const defaults = {
    API_BASE: currentOrigin,
    ABOUT_LABEL: 'წესები და პირობები',
  };

  // Local development: redirect API calls to backend port
  if (currentOrigin === 'http://127.0.0.1:3000' || currentOrigin === 'http://localhost:3000') {
    defaults.API_BASE = currentOrigin.replace(':3000', ':8000');
  }

  const metaOverrides = {};
  try {
    const metaConfig = document.querySelector('meta[name="app-config"]');
    if (metaConfig?.content) {
      const parsed = JSON.parse(metaConfig.content);
      if (parsed && typeof parsed === 'object') {
        Object.assign(metaOverrides, parsed);
      }
    }
  } catch {}

  const metaApiBase = document.querySelector('meta[name="api-base"]');
  if (metaApiBase?.content) {
    metaOverrides.API_BASE = metaApiBase.content.trim() || currentOrigin;
  }

  const existing = (globalObject.APP_CONFIG && typeof globalObject.APP_CONFIG === 'object')
    ? globalObject.APP_CONFIG
    : {};

  const merged = {
    ...defaults,
    ...existing,
    ...metaOverrides,
  };

  // Ensure API_BASE is never empty
  if (!merged.API_BASE) {
    merged.API_BASE = currentOrigin;
  }

  globalObject.APP_CONFIG = Object.freeze(merged);

  // Global toast function
  function getToastContainer() {
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:99999;display:flex;flex-direction:column;gap:8px;';
      document.body.appendChild(container);
    }
    return container;
  }

  globalObject.showToast = function(message, type = 'info') {
    const container = getToastContainer();
    const toast = document.createElement('div');
    const bgColor = type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#333';
    toast.style.cssText = `background:${bgColor};color:#fff;padding:12px 20px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);font-size:14px;max-width:320px;opacity:0;transform:translateX(100%);transition:all 0.3s ease;`;
    toast.textContent = String(message || '');
    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateX(0)';
    });
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  };
})();

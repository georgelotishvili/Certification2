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
  function ensureToastStyles() {
    if (document.getElementById('toast-styles')) return;
    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = `
      #toast-container {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 99999;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
      }
      .toast {
        min-width: 240px;
        max-width: 360px;
        display: grid;
        grid-template-columns: 24px 1fr;
        align-items: center;
        gap: 10px;
        color: #fff;
        padding: 12px 14px;
        border-radius: 6px;
        box-shadow: 0 18px 38px rgba(15, 23, 42, 0.22);
        font-size: 14px;
        line-height: 1.45;
        opacity: 0;
        transform: translateX(100%);
        transition: opacity 0.25s ease, transform 0.25s ease;
        pointer-events: auto;
      }
      .toast-success { background: #15803d; }
      .toast-error { background: #b91c1c; }
      .toast-info { background: #1f2937; }
      .toast-icon {
        width: 22px;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      .toast-icon svg {
        width: 20px;
        height: 20px;
        fill: none;
        stroke: currentColor;
        stroke-width: 2.4;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .toast-success .toast-icon {
        animation: toastCheck 0.38s ease both;
      }
      .toast-message {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      @keyframes toastCheck {
        0% { transform: scale(0.72); opacity: 0; }
        100% { transform: scale(1); opacity: 1; }
      }
      @media (max-width: 520px) {
        #toast-container {
          left: 12px;
          right: 12px;
          top: 12px;
        }
        .toast {
          max-width: none;
          width: 100%;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function getToastContainer() {
    ensureToastStyles();
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  globalObject.showToast = function(message, type = 'info') {
    const container = getToastContainer();
    const toast = document.createElement('div');
    const normalizedType = ['success', 'error', 'info'].includes(type) ? type : 'info';
    const icon = normalizedType === 'success'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>'
      : normalizedType === 'error'
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 8v5"></path><path d="M12 16h.01"></path></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>';
    toast.className = `toast toast-${normalizedType}`;
    toast.setAttribute('role', normalizedType === 'error' ? 'alert' : 'status');
    toast.innerHTML = `<span class="toast-icon">${icon}</span><span class="toast-message"></span>`;
    toast.querySelector('.toast-message').textContent = String(message || '');
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

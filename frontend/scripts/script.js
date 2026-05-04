document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === 'string')
    ? window.APP_CONFIG.API_BASE
    : 'http://127.0.0.1:8000';
  const FOUNDER_EMAIL = 'naormala@gmail.com';
  const KEYS = {
    AUTH: 'authLoggedIn',
    CURRENT_USER: 'currentUser',
    USED_CODES: 'usedCodes',
    SAVED_EMAIL: 'savedEmail',
  };

  const DOM = {
    body: document.body,
    root: document.documentElement,
    burger: document.querySelector('.burger'),
    overlay: document.querySelector('.overlay'),
    drawer: document.querySelector('.drawer'),
    drawerClose: document.querySelector('.drawer-close'),
    drawerLinks: Array.from(document.querySelectorAll('.drawer-nav a')),
    drawerSubmenu: document.querySelector('.drawer-submenu'),
    drawerAuthBanner: document.querySelector('.drawer-auth-banner'),
    loginBtn: document.querySelector('.login-btn'),
    drawerLoginBtn: document.querySelector('.drawer-login'),
    loginModal: document.getElementById('loginModal'),
    modalClose: document.getElementById('modalClose'),
    modalButtons: document.querySelector('.modal-buttons'),
    loginForm: document.getElementById('loginForm'),
    registerForm: document.getElementById('registerForm'),
    forgotPasswordForm: document.getElementById('forgotPasswordForm'),
    loginOption: document.querySelector('.login-option'),
    registerOption: document.querySelector('.register-option'),
    forgotPasswordLink: document.getElementById('forgotPasswordLink'),
    fullscreenBlank: document.getElementById('fullscreenBlank'),
    blankClose: document.getElementById('blankClose'),
    authBanner: document.querySelector('.auth-banner'),
    adminLink: document.querySelector('.admin-link'),
    footerForm: document.querySelector('.footer-form'),
  };

  const regionsForIsolation = Array.from(document.querySelectorAll('header, .nav-bar, main, footer, .overlay, .drawer, #loginModal'));

  const GEORGIA_TIME_ZONE = 'Asia/Tbilisi';
  const ISO_NO_TZ_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/;
  const ISO_WITH_SPACE_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/;
  let tbilisiFormatter = null;

  function getTbilisiFormatter() {
    if (!tbilisiFormatter) {
      tbilisiFormatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: GEORGIA_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }
    return tbilisiFormatter;
  }

  function normalizeIsoString(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    if (trimmed.endsWith('Z')) return trimmed;
    if (/[+-]\d{2}:?\d{2}$/.test(trimmed)) return trimmed;
    if (ISO_NO_TZ_REGEX.test(trimmed)) return `${trimmed}Z`;
    if (ISO_WITH_SPACE_REGEX.test(trimmed)) return `${trimmed.replace(' ', 'T')}Z`;
    return trimmed;
  }

  function parseUtcDate(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const normalized = normalizeIsoString(String(value));
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const utils = {
    on: (element, event, handler) => element && element.addEventListener(event, handler),
    isValidEmail: (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    getTrimmed: (formData, name) => (formData.get(name) || '').toString().trim(),
    validatePassword: (password) => {
      // Backend-თან თანმიმდევრული ვალიდაცია
      if (password.length < 8) {
        return { valid: false, message: 'პაროლი უნდა იყოს მინიმუმ 8 სიმბოლო' };
      }
      if (!/[A-ZА-Яა-ჰ]/.test(password)) {
        return { valid: false, message: 'პაროლი უნდა შეიცავდეს მინიმუმ ერთ დიდ ასოს' };
      }
      if (!/[a-zа-яა-ჰ]/.test(password)) {
        return { valid: false, message: 'პაროლი უნდა შეიცავდეს მინიმუმ ერთ პატარა ასოს' };
      }
      if (!/\d/.test(password)) {
        return { valid: false, message: 'პაროლი უნდა შეიცავდეს მინიმუმ ერთ რიცხვს' };
      }
      return { valid: true, message: '' };
    },
    formatDateTime: (value) => {
      const date = parseUtcDate(value);
      if (!date) return String(value || '');
      try {
        const formatter = getTbilisiFormatter();
        const parts = formatter.formatToParts(date);
        const mapped = parts.reduce((acc, part) => {
          if (part.type !== 'literal') acc[part.type] = part.value;
          return acc;
        }, {});
        const day = mapped.day || '00';
        const month = mapped.month || '00';
        const year = mapped.year || '0000';
        const hour = mapped.hour || '00';
        const minute = mapped.minute || '00';
        return `${day}-${month}-${year} ${hour}:${minute}`;
      } catch {
        return String(value || '');
      }
    },
  };

  const fullscreenModule = createFullscreenModule();
  const authModule = createAuthModule();
  const registryModule = window.Registry.init({
    api: API_BASE,
    triggers: ['.nav-registry', '.drawer-registry'],
    beforeOpen: (el) => {
      try {
        if (el?.classList?.contains('drawer-registry')) {
          document.body.classList.remove('menu-open');
        }
      } catch {}
    },
    refreshRating: true,
  });
  const footerFormModule = createFooterFormModule();

  function createPasswordIcon(visible) {
    if (visible) {
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94"></path>
          <path d="M9.9 4.24A10.77 10.77 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19"></path>
          <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88"></path>
          <path d="M1 1l22 22"></path>
        </svg>`;
    }
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
        <circle cx="12" cy="12" r="3"></circle>
      </svg>`;
  }

  function setupPasswordToggles(root = document) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const inputs = Array.from(scope.querySelectorAll('input[type="password"]'));
    inputs.forEach((input) => {
      if (input.dataset.passwordToggleReady === 'true') return;
      input.dataset.passwordToggleReady = 'true';

      const wrapper = document.createElement('div');
      wrapper.className = 'password-field';
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'password-toggle';
      button.setAttribute('aria-label', 'პაროლის ჩვენება');
      button.setAttribute('aria-pressed', 'false');
      button.title = 'პაროლის ჩვენება';
      button.innerHTML = createPasswordIcon(false);
      wrapper.appendChild(button);

      button.addEventListener('click', () => {
        const visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        button.setAttribute('aria-label', visible ? 'პაროლის დამალვა' : 'პაროლის ჩვენება');
        button.setAttribute('aria-pressed', visible ? 'true' : 'false');
        button.title = visible ? 'პაროლის დამალვა' : 'პაროლის ჩვენება';
        button.innerHTML = createPasswordIcon(visible);
        input.focus();
      });
    });
  }

  function resetPasswordToggles(root = document) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const inputs = Array.from(scope.querySelectorAll('input[data-password-toggle-ready="true"]'));
    inputs.forEach((input) => {
      input.type = 'password';
      const button = input.closest('.password-field')?.querySelector('.password-toggle');
      if (!button) return;
      button.setAttribute('aria-label', 'პაროლის ჩვენება');
      button.setAttribute('aria-pressed', 'false');
      button.title = 'პაროლის ჩვენება';
      button.innerHTML = createPasswordIcon(false);
    });
  }

  function notify(message, type = 'info') {
    const text = String(message || '').trim();
    if (!text) return;
    if (typeof window.showToast === 'function') {
      window.showToast(text, type);
      return;
    }
    alert(text);
  }

  function setButtonLoading(button, loading, loadingText = 'იტვირთება...') {
    if (!button) return;
    if (loading) {
      if (button.dataset.loadingActive === 'true') return;
      button.dataset.loadingActive = 'true';
      button.dataset.loadingText = button.textContent || '';
      button.dataset.loadingDisabled = button.disabled ? 'true' : 'false';
      button.textContent = loadingText;
      button.disabled = true;
      button.classList.add('is-loading');
      return;
    }
    if (button.dataset.loadingActive !== 'true') return;
    button.textContent = button.dataset.loadingText || button.textContent;
    button.disabled = button.dataset.loadingDisabled === 'true';
    button.classList.remove('is-loading');
    delete button.dataset.loadingActive;
    delete button.dataset.loadingText;
    delete button.dataset.loadingDisabled;
  }

  function createCopyIcon() {
    return `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="9" y="9" width="11" height="11" rx="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>`;
  }

  async function copyText(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    try {
      if (navigator.clipboard?.writeText && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {}
    try {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch {
      return false;
    }
  }

  function attachCopyButton(target, options = {}) {
    const element = typeof target === 'string' ? document.querySelector(target) : target;
    if (!element || element.dataset.copyReady === 'true' || !element.parentNode) return null;
    element.dataset.copyReady = 'true';

    const wrapper = document.createElement('span');
    wrapper.className = options.wrapperClass || 'copy-value-wrap';
    element.parentNode.insertBefore(wrapper, element);
    wrapper.appendChild(element);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = options.buttonClass || 'copy-btn';
    button.title = options.title || 'კოდის კოპირება';
    button.setAttribute('aria-label', options.title || 'კოდის კოპირება');
    button.innerHTML = createCopyIcon();
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const value = String(options.value || element.textContent || '').trim();
      if (!value || value === '—') {
        notify('კოდი ჯერ არ არის ხელმისაწვდომი', 'error');
        return;
      }
      const copied = await copyText(value);
      notify(copied ? 'კოდი დაკოპირდა' : 'კოდის კოპირება ვერ მოხერხდა', copied ? 'success' : 'error');
    });
    wrapper.appendChild(button);
    return button;
  }

  function getPasswordStrength(password) {
    const value = String(password || '');
    if (!value) return { score: 0, label: '' };
    let score = 0;
    if (value.length >= 8) score += 1;
    if (value.length >= 12) score += 1;
    if (/[A-ZА-Яა-ჰ]/.test(value) && /[a-zа-яა-ჰ]/.test(value)) score += 1;
    if (/\d/.test(value)) score += 1;
    if (/[^A-Za-zА-Яа-яა-ჰ0-9]/.test(value)) score += 1;
    const capped = Math.min(score, 4);
    const labels = ['', 'სუსტი', 'საშუალო', 'კარგი', 'ძლიერი'];
    return { score: capped, label: labels[capped] || '' };
  }

  function shouldShowPasswordStrength(input) {
    const name = String(input?.name || input?.id || '').toLowerCase();
    if (!name) return false;
    if (name.includes('confirm') || name.includes('current')) return false;
    return name === 'password' || name.includes('newpassword') || name.includes('editnewpassword');
  }

  function setupPasswordStrength(root = document) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const inputs = Array.from(scope.querySelectorAll('input[type="password"], input[data-password-toggle-ready="true"]'));
    inputs.forEach((input) => {
      if (!shouldShowPasswordStrength(input) || input.dataset.passwordStrengthReady === 'true') return;
      input.dataset.passwordStrengthReady = 'true';

      const meter = document.createElement('div');
      meter.className = 'password-strength';
      meter.setAttribute('aria-live', 'polite');
      meter.innerHTML = `
        <div class="password-strength-bars" aria-hidden="true">
          <span></span><span></span><span></span><span></span>
        </div>
        <span class="password-strength-label"></span>`;

      const anchor = input.closest('.password-field') || input;
      anchor.parentNode?.insertBefore(meter, anchor.nextSibling);

      const update = () => {
        const { score, label } = getPasswordStrength(input.value);
        meter.dataset.score = String(score);
        meter.querySelector('.password-strength-label').textContent = label ? `პაროლი: ${label}` : '';
      };
      input.addEventListener('input', update);
      input.addEventListener('change', update);
      update();
    });
  }

  function resetPasswordStrength(root = document) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    Array.from(scope.querySelectorAll('input[data-password-strength-ready="true"]')).forEach((input) => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  // menu controls are handled by header.js
  fullscreenModule.init();
  authModule.init();
  footerFormModule.init();
  setupPasswordToggles();
  setupPasswordStrength();
  // profile navigation uses native anchors + delegated gating

  // Bind header-dependent handlers after header is dynamically loaded
  document.addEventListener('headerReady', () => {
    try {
      const isProfilePage = window.location.pathname.includes('my.html');
      // Refresh DOM references that live in the header
      DOM.burger = document.querySelector('.burger');
      DOM.overlay = document.querySelector('.overlay');
      DOM.drawer = document.querySelector('.drawer');
      DOM.drawerClose = document.querySelector('.drawer-close');
      DOM.drawerLinks = Array.from(document.querySelectorAll('.drawer-nav a'));
      DOM.drawerSubmenu = document.querySelector('.drawer-submenu');
      DOM.drawerAuthBanner = document.querySelector('.drawer-auth-banner');
      DOM.loginBtn = document.querySelector('.login-btn');
      DOM.drawerLoginBtn = document.querySelector('.drawer-login');
      DOM.loginModal = document.getElementById('loginModal');
      DOM.modalClose = document.getElementById('modalClose');
      DOM.modalButtons = document.querySelector('.modal-buttons');
      DOM.loginForm = document.getElementById('loginForm');
      DOM.registerForm = document.getElementById('registerForm');
      DOM.forgotPasswordForm = document.getElementById('forgotPasswordForm');
      DOM.loginOption = document.querySelector('.login-option');
      DOM.registerOption = document.querySelector('.register-option');
      DOM.forgotPasswordLink = document.getElementById('forgotPasswordLink');
      DOM.authBanner = document.querySelector('.auth-banner');

      // Initialize auth so login modal works on personal page too
      authModule.init();
      setupPasswordToggles();
      setupPasswordStrength();

      // Gating moved to delegated handler below

      // Registry triggers now handled via event delegation in registry.mini.js
    } catch {}
  });

  // Statements/profile gating handled by header.js

  // Global escape handling (modal first, then menu)
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (authModule.isModalOpen()) {
      authModule.closeModal();
      return;
    }
    if (registryModule.isOpen()) {
      registryModule.close();
      return;
    }
    if (document.body.classList.contains('menu-open')) {
      document.body.classList.remove('menu-open');
    }
  });

  // Expose fullscreen helpers if other scripts need them
  window.fullscreenOverlay = {
    open: fullscreenModule.open,
    close: fullscreenModule.close,
  };

  // Expose shared utils
  window.Utils = window.Utils || {};
  window.Utils.formatDateTime = utils.formatDateTime;
  window.Utils.parseUtcDate = parseUtcDate;
  window.Utils.validatePassword = utils.validatePassword;
  window.Utils.setupPasswordToggles = setupPasswordToggles;
  window.Utils.resetPasswordToggles = resetPasswordToggles;
  window.Utils.setupPasswordStrength = setupPasswordStrength;
  window.Utils.resetPasswordStrength = resetPasswordStrength;
  window.Utils.notify = notify;
  window.Utils.setButtonLoading = setButtonLoading;
  window.Utils.copyText = copyText;
  window.Utils.attachCopyButton = attachCopyButton;

  // Expose minimal auth helpers
  window.Auth = window.Auth || {};
  window.Auth.isLoggedIn = () => authModule.isLoggedIn?.() ?? false;
  window.Auth.getCurrentUser = () => authModule.getCurrentUser?.() ?? null;
  window.Auth.getSavedEmail = () => (localStorage.getItem(KEYS.SAVED_EMAIL) || '');
  window.Auth.getToken = () => (localStorage.getItem('auth_token') || '');
  window.Auth.getAuthHeaders = () => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      return { 'Authorization': 'Bearer ' + token };
    }
    return {};
  };
  window.Auth.isFounder = () => {
    try {
      return (localStorage.getItem(KEYS.SAVED_EMAIL) || '').toLowerCase() === FOUNDER_EMAIL.toLowerCase();
    } catch {
      return false;
    }
  };
  // Optional modal controls for independent header module
  window.Auth.openModal = () => authModule.openModal?.();
  window.Auth.closeModal = () => authModule.closeModal?.();

  // contact scroll: no contact links in header

  // layout module removed (nav logo handled in header.js)

  // menu module removed (handled by header.js)

  function createFullscreenModule() {
    let trapFocusHandler = null;
    let mustStayFullscreen = false;
    let previouslyFocused = null;
    let beforeUnloadHandler = null;

    const keyboardLocks = ['Escape', 'F11', 'F4'];

    function lockKeys() {
      try { navigator.keyboard?.lock?.(keyboardLocks); } catch {}
    }

    function unlockKeys() {
      try { navigator.keyboard?.unlock?.(); } catch {}
    }

    function enableBeforeUnload() {
      if (beforeUnloadHandler) return;
      beforeUnloadHandler = (event) => {
        if (!(DOM.fullscreenBlank && DOM.fullscreenBlank.classList.contains('show'))) return;
        event.preventDefault();
        event.returnValue = '';
      };
      window.addEventListener('beforeunload', beforeUnloadHandler);
    }

    function disableBeforeUnload() {
      if (!beforeUnloadHandler) return;
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      beforeUnloadHandler = null;
    }

    function setIsolated(value) {
      regionsForIsolation.forEach((element) => {
        if (!element) return;
        if (value) {
          element.setAttribute('inert', '');
          element.setAttribute('aria-hidden', 'true');
        } else {
          element.removeAttribute('inert');
          element.removeAttribute('aria-hidden');
        }
      });
    }

    function getVisibleFocusable() {
      if (!DOM.fullscreenBlank) return [];
      const nodes = DOM.fullscreenBlank.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      return Array.from(nodes).filter((element) => !element.hasAttribute('disabled') && element.offsetParent !== null && !element.closest('[hidden]'));
    }

    function open() {
      if (!DOM.fullscreenBlank) return;
      DOM.fullscreenBlank.classList.add('show');
      DOM.fullscreenBlank.setAttribute('aria-hidden', 'false');
      DOM.body.style.overflow = 'hidden';
      DOM.body.classList.remove('menu-open');
      setIsolated(true);
      previouslyFocused = document.activeElement;
      if (typeof window.hideAllConfirm === 'function') window.hideAllConfirm();
      mustStayFullscreen = true;
      try {
        const request = DOM.root.requestFullscreen || DOM.root.webkitRequestFullscreen || DOM.root.msRequestFullscreen;
        if (request) {
          const result = request.call(DOM.root, { navigationUI: 'hide' });
          if (result && typeof result.then === 'function') {
            result.then(lockKeys).catch(() => {});
          } else {
            lockKeys();
          }
        } else {
          lockKeys();
        }
      } catch {}
      enableBeforeUnload();
      setTimeout(() => DOM.blankClose?.focus(), 0);
      trapFocusHandler = (event) => {
        if (event.key !== 'Tab') return;
        event.preventDefault();
        const items = getVisibleFocusable();
        if (!items.length) return;
        const index = items.indexOf(document.activeElement);
        const nextIndex = event.shiftKey
          ? (index <= 0 ? items.length - 1 : index - 1)
          : (index === items.length - 1 ? 0 : index + 1);
        items[nextIndex].focus();
      };
      DOM.fullscreenBlank.addEventListener('keydown', trapFocusHandler);
    }

    function close() {
      if (!DOM.fullscreenBlank) return;
      DOM.fullscreenBlank.classList.remove('show');
      DOM.fullscreenBlank.setAttribute('aria-hidden', 'true');
      DOM.body.style.overflow = '';
      if (trapFocusHandler) {
        DOM.fullscreenBlank.removeEventListener('keydown', trapFocusHandler);
        trapFocusHandler = null;
      }
      setIsolated(false);
      mustStayFullscreen = false;
      disableBeforeUnload();
      unlockKeys();
      try {
        if (document.fullscreenElement) {
          const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
          if (exit) exit.call(document);
        }
      } catch {}
      try {
        if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
      } catch {}
    }

    function init() {
      utils.on(DOM.blankClose, 'click', close);
      utils.on(DOM.fullscreenBlank, 'click', (event) => {
        if (event.target === DOM.fullscreenBlank) close();
      });
    }

    return { init, open, close, mustStayFullscreen: () => mustStayFullscreen };
  }

  function createAuthModule() {
    const DEFAULT_BANNER_TEXT = 'გთხოვთ შეხვიდეთ სისტემაში';
    // NEED_REGISTER_TEXT removed: banner shows either default or user's name/code

    let activeView = 'options';

    function isLoggedIn() {
      return localStorage.getItem(KEYS.AUTH) === 'true';
    }

    function setLoggedIn(value) {
      localStorage.setItem(KEYS.AUTH, value ? 'true' : 'false');
    }

    function getCurrentUser() {
      try {
        const raw = localStorage.getItem(KEYS.CURRENT_USER);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    }

    function saveCurrentUser(user) {
      localStorage.setItem(KEYS.CURRENT_USER, JSON.stringify(user));
    }

    function getUsedCodes() {
      try {
        return new Set(JSON.parse(localStorage.getItem(KEYS.USED_CODES) || '[]'));
      } catch {
        return new Set();
      }
    }

    function saveUsedCodes(set) {
      localStorage.setItem(KEYS.USED_CODES, JSON.stringify(Array.from(set)));
    }

    function ensureProfileConsistency() {
      if (!isLoggedIn()) return;
      const savedEmailLower = (localStorage.getItem(KEYS.SAVED_EMAIL) || '').toLowerCase();
      const user = getCurrentUser();
      if (user && String(user.email || '').toLowerCase() !== savedEmailLower) {
        try { localStorage.removeItem(KEYS.CURRENT_USER); } catch {}
      }
    }

    function normalizeAuthState() {
      const logged = isLoggedIn();
      const user = getCurrentUser();
      if (logged && !user) {
        setLoggedIn(false);
      }
      if (!logged && user) {
        try { localStorage.removeItem(KEYS.CURRENT_USER); } catch {}
      }
    }

    function updateAdminLinkVisibility() {
      if (!DOM.adminLink) return;
      const user = getCurrentUser();
      const visible = isLoggedIn() && ((user && !!user.isAdmin) || (window.Auth?.isFounder?.() === true));
      DOM.adminLink.style.display = visible ? '' : 'none';
    }

    function updateBanner() {
      const user = getCurrentUser();
      let text = DEFAULT_BANNER_TEXT;
      if (isLoggedIn() && user) text = `${user.firstName} ${user.lastName} — ${user.code}`;
      if (DOM.authBanner) DOM.authBanner.textContent = text;
      if (DOM.drawerAuthBanner) DOM.drawerAuthBanner.textContent = text;
    }

    async function refreshUserFromServer() {
      if (!isLoggedIn()) return;
      const token = localStorage.getItem('auth_token');
      if (!token) return;
      
      try {
        const response = await fetch(`${API_BASE}/users/me`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Cache-Control': 'no-cache',
          },
        });
        
        if (!response.ok) {
          if (response.status === 401) {
            setLoggedIn(false);
            try { localStorage.removeItem(KEYS.CURRENT_USER); } catch {}
            updateAuthUI();
            updateBanner();
            updateAdminLinkVisibility();
          }
          return;
        }
        
        const userData = await response.json();
        const normalizedUser = {
          id: userData.id,
          firstName: userData.first_name,
          lastName: userData.last_name,
          code: userData.code,
          isAdmin: !!userData.is_admin,
          email: userData.email,
        };
        
        saveCurrentUser(normalizedUser);
        updateBanner();
        updateAdminLinkVisibility();
      } catch (error) {
        console.error('Failed to refresh user data:', error);
      }
    }

    function updateAuthUI() {
      const logged = isLoggedIn();
      if (DOM.loginBtn) DOM.loginBtn.textContent = logged ? 'გასვლა' : 'შესვლა';
      if (DOM.drawerLoginBtn) DOM.drawerLoginBtn.textContent = logged ? 'გასვლა' : 'შესვლა';
    }

    function setView(view) {
      activeView = view;
      if (!DOM.modalButtons) return;
      const is = (name) => activeView === name;
      DOM.modalButtons.style.display = is('options') ? 'flex' : 'none';
      if (DOM.registerForm) DOM.registerForm.style.display = is('register') ? 'block' : 'none';
      if (DOM.loginForm) DOM.loginForm.style.display = is('login') ? 'block' : 'none';
      if (DOM.forgotPasswordForm) DOM.forgotPasswordForm.style.display = is('forgot') ? 'block' : 'none';
    }

    function showOptions() { setView('options'); }
    function showLogin() { setView('login'); }
    function showRegister() { setView('register'); }
    function showForgot() {
      setView('forgot');
      resetForgotFlow();
      const forgotEmailInput = DOM.forgotPasswordForm?.querySelector('input[name="email"]');
      const loginEmail = DOM.loginForm?.querySelector('input[name="email"]')?.value?.trim();
      const savedEmail = localStorage.getItem(KEYS.SAVED_EMAIL);
      if (forgotEmailInput && !forgotEmailInput.value) {
        forgotEmailInput.value = loginEmail || savedEmail || '';
      }
    }

    function openModal() {
      if (!DOM.loginModal) return;
      DOM.loginModal.classList.add('show');
      DOM.body.style.overflow = 'hidden';
      const savedEmail = localStorage.getItem(KEYS.SAVED_EMAIL);
      if (DOM.loginForm) {
        const emailInput = DOM.loginForm.querySelector('input[name="email"]');
        if (emailInput && savedEmail) emailInput.value = savedEmail;
      }
    }

    function closeModal() {
      if (!DOM.loginModal) return;
      DOM.loginModal.classList.remove('show');
      DOM.body.style.overflow = '';
      DOM.loginForm?.reset?.();
      DOM.registerForm?.reset?.();
      DOM.forgotPasswordForm?.reset?.();
      resetPasswordToggles(DOM.loginModal || document);
      resetPasswordStrength(DOM.loginModal || document);
      resetForgotFlow();
      resetRegisterFlow();
      showOptions();
    }

    function isModalOpen() {
      return DOM.loginModal?.classList.contains('show');
    }

    function handleAuthButtonClick(fromDrawer) {
      normalizeAuthState();
      const logged = isLoggedIn();
      if (!logged) {
        if (fromDrawer) document.body.classList.remove('menu-open');
        openModal();
        showOptions();
        return;
      }
      performLogout();
      if (fromDrawer) document.body.classList.remove('menu-open');
    }

    function performLogout() {
      if (!isLoggedIn()) return;
      if (!confirm('ნამდვილად გსურთ გასვლა?')) return;
      setLoggedIn(false);
      try {
        localStorage.removeItem(KEYS.CURRENT_USER);
      } catch {}
      updateAuthUI();
      updateBanner();
      updateAdminLinkVisibility();
      document.dispatchEvent(new CustomEvent('auth:logout'));
      notify('გასვლა შესრულებულია', 'success');
      closeModal();
    }

    function generateUniqueCode() {
      const used = getUsedCodes();
      for (let i = 0; i < 10000; i += 1) {
        const code = String(Math.floor(1e9 + Math.random() * 9e9));
        if (!used.has(code)) return code;
      }
      return String(Date.now()).slice(-10);
    }

    async function handleLoginSubmit(event) {
      event.preventDefault();
      if (!DOM.loginForm) return;
      const formData = new FormData(DOM.loginForm);
      const email = utils.getTrimmed(formData, 'email');
      const password = utils.getTrimmed(formData, 'password');
      if (!email) return notify('გთხოვთ შეიყვანოთ ელფოსტა', 'error');
      if (!utils.isValidEmail(email)) return notify('ელფოსტა არასწორია', 'error');
      if (!password) return notify('გთხოვთ შეიყვანოთ პაროლი', 'error');
      localStorage.setItem(KEYS.SAVED_EMAIL, email);
      const user = getCurrentUser();
      const loginEmailLower = email.toLowerCase();
      if (user && String(user.email || '').toLowerCase() !== loginEmailLower) {
        try { localStorage.removeItem(KEYS.CURRENT_USER); } catch {}
      }

      const submitButton = event.submitter || DOM.loginForm.querySelector('.submit');
      setButtonLoading(submitButton, true, 'მოწმდება...');
      try {
        const response = await fetch(`${API_BASE}/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache',
          },
          body: JSON.stringify({
            email: email,
            password: password,
          }),
        });
        if (response.ok) {
          const data = await response.json();
          // Store token if provided (for future authenticated requests)
          if (data.token) {
            try {
              localStorage.setItem('auth_token', data.token);
            } catch {}
          }
          // Normalize user data from response
          const userData = data.user || data;
          const normalizedUser = {
            id: userData.id,
            firstName: userData.first_name,
            lastName: userData.last_name,
            code: userData.code,
            isAdmin: !!userData.is_admin,
            email: userData.email,
          };
          saveCurrentUser(normalizedUser);
          setLoggedIn(true);
          updateAuthUI();
          updateBanner();
          updateAdminLinkVisibility();
          document.dispatchEvent(new CustomEvent('auth:login', { detail: { user: normalizedUser } }));
          closeModal();
          DOM.loginForm?.reset?.();
          showOptions();
          notify('ავტორიზაცია შესრულებულია', 'success');
          return;
        }
      } catch (error) {
        console.error('Login error:', error);
      } finally {
        setButtonLoading(submitButton, false);
      }
      // Login failed - ensure UI shows logged out state
      setLoggedIn(false);
      updateAuthUI();
      updateBanner();
      updateAdminLinkVisibility();
      notify('ელფოსტა/პაროლი ვერ გადამოწმდა. შეგიძლიათ გამოიყენოთ გვერდი შეზღუდული ფუნქციონალით ან გაიაროთ რეგისტრაცია.', 'error');
      // Allow limited login flow even if profile not found
      closeModal();
      DOM.loginForm?.reset?.();
      showOptions();
    }

    let forgotPasswordEmail = '';
    const OTP_SECONDS = 300;
    const otpTimers = { forgot: null, register: null };

    function formatOtpTime(seconds) {
      const safe = Math.max(0, Number(seconds) || 0);
      const minutes = String(Math.floor(safe / 60)).padStart(2, '0');
      const rest = String(safe % 60).padStart(2, '0');
      return `${minutes}:${rest}`;
    }

    function getOtpInfoElement(type) {
      const selector = type === 'register'
        ? '#registerStep2 .verification-info'
        : '#forgotStep2 .verification-info';
      return document.querySelector(selector);
    }

    function stopOtpTimer(type) {
      if (otpTimers[type]) {
        clearInterval(otpTimers[type]);
        otpTimers[type] = null;
      }
    }

    function resetOtpInfo(type) {
      stopOtpTimer(type);
      const info = getOtpInfoElement(type);
      if (!info) return;
      info.innerHTML = '4-ნიშნა კოდი გაგზავნილია თქვენს ელფოსტაზე';
    }

    function startOtpTimer(type) {
      stopOtpTimer(type);
      const info = getOtpInfoElement(type);
      if (!info) return;

      let remaining = OTP_SECONDS;
      const render = () => {
        const finished = remaining <= 0;
        info.innerHTML = `
          <span>4-ნიშნა კოდი გაგზავნილია თქვენს ელფოსტაზე</span>
          <span class="otp-countdown">${finished ? 'კოდის დრო ამოიწურა' : formatOtpTime(remaining)}</span>
          <button type="button" class="otp-resend"${finished ? '' : ' hidden'}>ხელახლა გაგზავნა</button>`;
        const resend = info.querySelector('.otp-resend');
        resend?.addEventListener('click', (event) => {
          event.preventDefault();
          if (type === 'register') {
            handleRegisterSendCode(event);
          } else {
            resendForgotCode(event);
          }
        });
      };

      render();
      otpTimers[type] = setInterval(() => {
        remaining -= 1;
        render();
        if (remaining <= 0) stopOtpTimer(type);
      }, 1000);
    }

    function showForgotStep(step) {
      const step1 = document.getElementById('forgotStep1');
      const step2 = document.getElementById('forgotStep2');
      if (step1) step1.style.display = step === 1 ? 'block' : 'none';
      if (step2) step2.style.display = step === 2 ? 'block' : 'none';
    }

    function resetForgotFlow() {
      forgotPasswordEmail = '';
      showForgotStep(1);
      resetOtpInfo('forgot');
    }

    async function requestForgotCode(email) {
      const response = await fetch(`${API_BASE}/auth/forgot-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        let detail = '';
        try {
          const json = await response.json();
          detail = json?.detail || '';
        } catch {}
        throw new Error(detail || 'კოდის გაგზავნა ვერ მოხერხდა');
      }

      try {
        return await response.json();
      } catch {
        return {};
      }
    }

    async function resendForgotCode(event) {
      const button = event?.currentTarget || null;
      const email = forgotPasswordEmail || utils.getTrimmed(new FormData(DOM.forgotPasswordForm), 'email');
      if (!email || !utils.isValidEmail(email)) {
        notify('ელფოსტა არასწორია', 'error');
        return;
      }
      setButtonLoading(button, true, 'იგზავნება...');
      try {
        const result = await requestForgotCode(email);
        forgotPasswordEmail = email;
        localStorage.setItem(KEYS.SAVED_EMAIL, email);
        startOtpTimer('forgot');
        notify(result.message || 'აღდგენის კოდი ხელახლა გაიგზავნა', 'success');
      } catch (error) {
        notify(error.message || 'კოდის გაგზავნა ვერ მოხერხდა', 'error');
      } finally {
        setButtonLoading(button, false);
      }
    }

    async function handleForgotSubmit(event) {
      event.preventDefault();
      if (!DOM.forgotPasswordForm) return;
      const formData = new FormData(DOM.forgotPasswordForm);
      const submitButton = event.submitter || DOM.forgotPasswordForm.querySelector(forgotPasswordEmail ? '#forgotStep2 .submit' : '#forgotStep1 .submit');

      try {
        if (!forgotPasswordEmail) {
          const email = utils.getTrimmed(formData, 'email');
          if (!email) return notify('გთხოვთ შეიყვანოთ ელფოსტა', 'error');
          if (!utils.isValidEmail(email)) return notify('ელფოსტა არასწორია', 'error');

          setButtonLoading(submitButton, true, 'იგზავნება...');
          const result = await requestForgotCode(email);
          forgotPasswordEmail = email;
          localStorage.setItem(KEYS.SAVED_EMAIL, email);
          showForgotStep(2);
          startOtpTimer('forgot');
          notify(result.message || 'თუ ელფოსტა რეგისტრირებულია, აღდგენის კოდი გამოგეგზავნათ', 'success');
          return;
        }

        const resetCode = utils.getTrimmed(formData, 'resetCode');
        const newPassword = utils.getTrimmed(formData, 'newPassword');
        const confirmNewPassword = utils.getTrimmed(formData, 'confirmNewPassword');

        if (!resetCode || resetCode.length !== 4) return notify('გთხოვთ შეიყვანოთ 4-ნიშნა კოდი', 'error');
        const passwordCheck = utils.validatePassword(newPassword);
        if (!passwordCheck.valid) return notify(passwordCheck.message, 'error');
        if (newPassword !== confirmNewPassword) return notify('პაროლები არ ემთხვევა', 'error');

        setButtonLoading(submitButton, true, 'იცვლება...');
        const response = await fetch(`${API_BASE}/auth/reset-password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: forgotPasswordEmail,
            verification_code: resetCode,
            new_password: newPassword,
            confirm_new_password: confirmNewPassword,
          }),
        });

        if (!response.ok) {
          let detail = '';
          try {
            const json = await response.json();
            detail = json?.detail || '';
          } catch {}
          notify(detail || 'პაროლის შეცვლა ვერ მოხერხდა', 'error');
          return;
        }

        const result = await response.json();
        notify(result.message || 'პაროლი წარმატებით შეიცვალა', 'success');
        closeModal();
        DOM.forgotPasswordForm?.reset?.();
        resetForgotFlow();
        showLogin();
      } catch (error) {
        notify(error.message || 'ქსელური პრობლემა - სცადეთ მოგვიანებით', 'error');
      } finally {
        setButtonLoading(submitButton, false);
      }
    }

    // Registration state
    let registerData = null;

    function showRegisterStep(step) {
      const step1 = document.getElementById('registerStep1');
      const step2 = document.getElementById('registerStep2');
      if (step1) step1.style.display = step === 1 ? 'block' : 'none';
      if (step2) step2.style.display = step === 2 ? 'block' : 'none';
    }

    function resetRegisterFlow() {
      registerData = null;
      showRegisterStep(1);
      resetOtpInfo('register');
    }

    async function handleRegisterSendCode(event) {
      event?.preventDefault?.();
      if (!DOM.registerForm) return;
      const formData = new FormData(DOM.registerForm);
      const personalId = utils.getTrimmed(formData, 'personalId');
      const firstName = utils.getTrimmed(formData, 'firstName');
      const lastName = utils.getTrimmed(formData, 'lastName');
      const phone = utils.getTrimmed(formData, 'phone');
      const email = utils.getTrimmed(formData, 'email');
      const password = utils.getTrimmed(formData, 'password');
      const confirmPassword = utils.getTrimmed(formData, 'confirmPassword');
      
      if (personalId.length !== 11 || !/^[0-9]{11}$/.test(personalId)) return notify('პირადი ნომერი უნდა იყოს 11 ციფრი', 'error');
      if (!firstName || !lastName) return notify('გთხოვთ შეიყვანოთ სახელი და გვარი', 'error');
      if (!/^[0-9]{9}$/.test(phone)) return notify('ტელეფონი უნდა იყოს 9 ციფრი (მაგ: 599123456)', 'error');
      if (!utils.isValidEmail(email)) return notify('ელფოსტა არასწორია', 'error');
      const passwordCheck = utils.validatePassword(password);
      if (!passwordCheck.valid) return notify(passwordCheck.message, 'error');
      if (password !== confirmPassword) return notify('პაროლები არ ემთხვევა', 'error');

      const button = event?.currentTarget || document.getElementById('registerSendCodeBtn');
      setButtonLoading(button, true, 'იგზავნება...');
      try {
        const response = await fetch(`${API_BASE}/users/send-verification-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, purpose: 'register' }),
        });
        if (!response.ok) {
          let detail = '';
          try {
            const json = await response.json();
            detail = json?.detail || '';
          } catch {}
          notify(detail || 'კოდის გაგზავნა ვერ მოხერხდა', 'error');
          return;
        }
        // Save registration data and show step 2
        registerData = { personalId, firstName, lastName, phone, email, password };
        showRegisterStep(2);
        startOtpTimer('register');
        notify('ვერიფიკაციის კოდი გაიგზავნა ელფოსტაზე', 'success');
      } catch {
        notify('ქსელური პრობლემა - სცადეთ მოგვიანებით', 'error');
      } finally {
        setButtonLoading(button, false);
      }
    }

    async function handleRegisterSubmit(event) {
      event.preventDefault();
      if (!DOM.registerForm || !registerData) return;
      
      const formData = new FormData(DOM.registerForm);
      const verificationCode = utils.getTrimmed(formData, 'verificationCode');
      
      if (!verificationCode || verificationCode.length !== 4) {
        return notify('გთხოვთ შეიყვანოთ 4-ნიშნა კოდი', 'error');
      }

      const submitButton = event.submitter || DOM.registerForm.querySelector('#registerStep2 .submit');
      setButtonLoading(submitButton, true, 'რეგისტრირდება...');
      try {
        const response = await fetch(`${API_BASE}/users/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personal_id: registerData.personalId,
            first_name: registerData.firstName,
            last_name: registerData.lastName,
            phone: registerData.phone,
            email: registerData.email,
            password: registerData.password,
            verification_code: verificationCode,
          }),
        });
        if (!response.ok) {
          let detail = '';
          try {
            const json = await response.json();
            detail = json?.detail || '';
          } catch {}
          if (response.status === 409) {
            notify(detail || 'ეს მონაცემები სისტემაში უკვე რეგისტრირებულია', 'error');
            return;
          }
          notify(detail || 'რეგისტრაცია ვერ შესრულდა', 'error');
          return;
        }
        const data = await response.json();
        const normalizedUser = {
          id: data.id,
          firstName: data.first_name || registerData.firstName,
          lastName: data.last_name || registerData.lastName,
          code: data.code,
          isAdmin: !!data.is_admin,
          email: data.email,
        };
        saveCurrentUser(normalizedUser);
        localStorage.setItem(KEYS.SAVED_EMAIL, registerData.email);
        setLoggedIn(true);
        updateAuthUI();
        updateBanner();
        updateAdminLinkVisibility();
        document.dispatchEvent(new CustomEvent('auth:login', { detail: { user: normalizedUser } }));
        notify('რეგისტრაცია მიღებულია!', 'success');
        closeModal();
        DOM.registerForm?.reset?.();
        resetRegisterFlow();
        showOptions();
      } catch {
        notify('ქსელური პრობლემა - სცადეთ მოგვიანებით', 'error');
      } finally {
        setButtonLoading(submitButton, false);
      }
    }

    function handleRegisterBack() {
      showRegisterStep(1);
      resetOtpInfo('register');
    }

    function init() {
      utils.on(DOM.loginBtn, 'click', () => handleAuthButtonClick(false));
      utils.on(DOM.drawerLoginBtn, 'click', () => handleAuthButtonClick(true));
      utils.on(DOM.modalClose, 'click', closeModal);
      // Removed overlay click handler - modal should only close via close button
      utils.on(DOM.loginOption, 'click', showLogin);
      utils.on(DOM.registerOption, 'click', showRegister);
      utils.on(DOM.forgotPasswordLink, 'click', (event) => { event.preventDefault(); showForgot(); });
      utils.on(DOM.loginForm, 'submit', handleLoginSubmit);
      utils.on(DOM.forgotPasswordForm, 'submit', handleForgotSubmit);
      const backToLoginBtn = DOM.forgotPasswordForm?.querySelector('.back-to-login');
      utils.on(backToLoginBtn, 'click', () => {
        resetForgotFlow();
        showLogin();
      });
      const forgotBackBtn = document.getElementById('forgotBackBtn');
      utils.on(forgotBackBtn, 'click', () => {
        resetForgotFlow();
      });
      utils.on(DOM.registerForm, 'submit', handleRegisterSubmit);
      
      // Registration verification flow
      const registerSendCodeBtn = document.getElementById('registerSendCodeBtn');
      const registerBackBtn = document.getElementById('registerBackBtn');
      utils.on(registerSendCodeBtn, 'click', handleRegisterSendCode);
      utils.on(registerBackBtn, 'click', handleRegisterBack);

      normalizeAuthState();
      updateAuthUI();
      ensureProfileConsistency();
      updateBanner();
      updateAdminLinkVisibility();
      refreshUserFromServer();
    }

    return {
      init,
      openModal,
      closeModal,
      showRegister,
      isModalOpen,
      updateBanner,
      updateAdminLinkVisibility,
      getCurrentUser,
      saveCurrentUser,
      setLoggedIn,
      isLoggedIn,
      generateUniqueCode,
      getUsedCodes,
      saveUsedCodes,
    };
  }

  /* Registry module moved to window.Registry (registry.mini.js) */

  // Exam dropdown/navigation now handled by header.js

  function createFooterFormModule(deps = {}) {
    const { statementsModule } = deps;
    let messageField = null;

    function ensureAuth(event) {
      if (authModule.isLoggedIn()) return;
      if (event?.cancelable) event.preventDefault();
      alert('გთხოვთ გაიაროთ ავტორიზაცია');
      messageField?.blur?.();
    }

    async function handleSubmit(event) {
      event.preventDefault();
      if (!DOM.footerForm) return;
      if (!authModule.isLoggedIn()) {
        alert('გთხოვთ გაიაროთ ავტორიზაცია');
        return;
      }
      const formData = new FormData(DOM.footerForm);
      const message = utils.getTrimmed(formData, 'message');
      if (!message) return alert('გთხოვთ შეიყვანოთ შეტყობინება');
      const actorEmail = (window.Auth?.getSavedEmail?.() || '').trim();
      if (!actorEmail) {
        alert('ავტორიზაცია ვერ დადასტურდა');
        return;
      }

      // Build multipart/form-data payload (backend expects Form(...) + File(...))
      const payload = new FormData();
      payload.set('message', message);
      try {
        const fileInput = DOM.footerForm.querySelector('input[type="file"], input[name="attachment"]');
        const file = fileInput && fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
        if (file) payload.set('attachment', file);
      } catch {}
      const submitBtn = DOM.footerForm.querySelector('button[type="submit"]');
      submitBtn?.setAttribute('disabled', 'true');
      try {
        const response = await fetch(`${API_BASE}/statements`, {
          method: 'POST',
          headers: {
            // Do NOT set Content-Type manually; browser will add multipart/form-data with boundary
            ...window.Auth.getAuthHeaders(),
          },
          body: payload,
          credentials: 'include',
        });
        if (!response.ok) {
          let detail = '';
          try {
            const json = await response.clone().json();
            detail = json?.detail || '';
          } catch {
            try {
              detail = (await response.clone().text()).trim();
            } catch {}
          }
          throw new Error(detail || 'გაგზავნა ვერ შესრულდა');
        }
        const data = await response.json();
        alert('თქვენი განცხადება მიღებულია!');
        DOM.footerForm.reset();
        statementsModule?.handleNewStatement?.(data);
      } catch (error) {
        console.error('Failed to submit statement', error);
        alert(error.message || 'გაგზავნა ვერ შესრულდა');
      } finally {
        submitBtn?.removeAttribute('disabled');
      }
    }

    function init() {
      if (!DOM.footerForm) return;
      messageField = DOM.footerForm.querySelector('textarea[name="message"]');
      utils.on(DOM.footerForm, 'submit', handleSubmit);
      utils.on(messageField, 'mousedown', ensureAuth);
      utils.on(messageField, 'focus', ensureAuth);
    }

    return { init };
  }
});


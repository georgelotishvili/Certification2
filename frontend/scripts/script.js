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

  // menu controls are handled by header.js
  fullscreenModule.init();
  authModule.init();
  footerFormModule.init();
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
    function showForgot() { setView('forgot'); }

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
      alert('გასვლა შესრულებულია');
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

    function handleLoginSubmit(event) {
      event.preventDefault();
      if (!DOM.loginForm) return;
      const formData = new FormData(DOM.loginForm);
      const email = utils.getTrimmed(formData, 'email');
      const password = utils.getTrimmed(formData, 'password');
      if (!email) return alert('გთხოვთ შეიყვანოთ ელფოსტა');
      if (!utils.isValidEmail(email)) return alert('ელფოსტა არასწორია');
      if (!password) return alert('გთხოვთ შეიყვანოთ პაროლი');
      localStorage.setItem(KEYS.SAVED_EMAIL, email);
      const user = getCurrentUser();
      const loginEmailLower = email.toLowerCase();
      if (user && String(user.email || '').toLowerCase() !== loginEmailLower) {
        try { localStorage.removeItem(KEYS.CURRENT_USER); } catch {}
      }

      (async () => {
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
            return;
          }
        } catch (error) {
          console.error('Login error:', error);
        }
        // Login failed - ensure UI shows logged out state
        setLoggedIn(false);
        updateAuthUI();
        updateBanner();
        updateAdminLinkVisibility();
        alert('ელფოსტა/პაროლი ვერ გადამოწმდა. შეგიძლიათ გამოიყენოთ გვერდი შეზღუდული ფუნქციონალით ან გაიაროთ რეგისტრაცია.');
        // Allow limited login flow even if profile not found
        closeModal();
        DOM.loginForm?.reset?.();
        showOptions();
      })();
    }

    function handleForgotSubmit(event) {
      event.preventDefault();
      if (!DOM.forgotPasswordForm) return;
      const formData = new FormData(DOM.forgotPasswordForm);
      const email = utils.getTrimmed(formData, 'email');
      if (!email) return alert('გთხოვთ შეიყვანოთ ელფოსტა');
      if (!utils.isValidEmail(email)) return alert('ელფოსტა არასწორია');
      
      (async () => {
        try {
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
            alert(detail || 'პაროლის აღდგენა ვერ მოხერხდა');
            return;
          }
          
          const result = await response.json();
          alert(result.message || 'თუ ელფოსტა რეგისტრირებულია, პაროლი გამოგეგზავნათ');
          closeModal();
          DOM.forgotPasswordForm?.reset?.();
          showOptions();
        } catch {
          alert('ქსელური პრობლემა - სცადეთ მოგვიანებით');
        }
      })();
    }

    // Registration state
    let registerData = null;

    function showRegisterStep(step) {
      const step1 = document.getElementById('registerStep1');
      const step2 = document.getElementById('registerStep2');
      if (step1) step1.style.display = step === 1 ? 'block' : 'none';
      if (step2) step2.style.display = step === 2 ? 'block' : 'none';
    }

    async function handleRegisterSendCode() {
      if (!DOM.registerForm) return;
      const formData = new FormData(DOM.registerForm);
      const personalId = utils.getTrimmed(formData, 'personalId');
      const firstName = utils.getTrimmed(formData, 'firstName');
      const lastName = utils.getTrimmed(formData, 'lastName');
      const phone = utils.getTrimmed(formData, 'phone');
      const email = utils.getTrimmed(formData, 'email');
      const password = utils.getTrimmed(formData, 'password');
      const confirmPassword = utils.getTrimmed(formData, 'confirmPassword');
      
      if (personalId.length !== 11 || !/^[0-9]{11}$/.test(personalId)) return alert('პირადი ნომერი უნდა იყოს 11 ციფრი');
      if (!firstName || !lastName) return alert('გთხოვთ შეიყვანოთ სახელი და გვარი');
      if (!/^[0-9]{9}$/.test(phone)) return alert('ტელეფონი უნდა იყოს 9 ციფრი (მაგ: 599123456)');
      if (!utils.isValidEmail(email)) return alert('ელფოსტა არასწორია');
      const passwordCheck = utils.validatePassword(password);
      if (!passwordCheck.valid) return alert(passwordCheck.message);
      if (password !== confirmPassword) return alert('პაროლები არ ემთხვევა');

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
          alert(detail || 'კოდის გაგზავნა ვერ მოხერხდა');
          return;
        }
        // Save registration data and show step 2
        registerData = { personalId, firstName, lastName, phone, email, password };
        showRegisterStep(2);
      } catch {
        alert('ქსელური პრობლემა - სცადეთ მოგვიანებით');
      }
    }

    function handleRegisterSubmit(event) {
      event.preventDefault();
      if (!DOM.registerForm || !registerData) return;
      
      const formData = new FormData(DOM.registerForm);
      const verificationCode = utils.getTrimmed(formData, 'verificationCode');
      
      if (!verificationCode || verificationCode.length !== 4) {
        return alert('გთხოვთ შეიყვანოთ 4-ნიშნა კოდი');
      }

      (async () => {
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
              alert(detail || 'ეს მონაცემები სისტემაში უკვე რეგისტრირებულია');
              return;
            }
            alert(detail || 'რეგისტრაცია ვერ შესრულდა');
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
          alert('რეგისტრაცია მიღებულია!');
          closeModal();
          DOM.registerForm?.reset?.();
          registerData = null;
          showRegisterStep(1);
          showOptions();
        } catch {
          alert('ქსელური პრობლემა - სცადეთ მოგვიანებით');
        }
      })();
    }

    function handleRegisterBack() {
      showRegisterStep(1);
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
      utils.on(backToLoginBtn, 'click', showLogin);
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


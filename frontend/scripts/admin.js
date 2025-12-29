document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === 'string')
    ? window.APP_CONFIG.API_BASE
    : 'http://127.0.0.1:8000';
  const KEYS = {
    AUTH: 'authLoggedIn',
    SAVED_EMAIL: 'savedEmail',
    CURRENT_USER: 'currentUser',
    EXAM_DURATION: 'examDuration',
    ADMIN_PWD: 'adminGatePassword',
    BLOCKS: 'examBlocks_v1',
  };
  const FOUNDER_EMAIL = 'naormala@gmail.com';

  const DOM = {
    body: document.body,
    burger: document.querySelector('.burger'),
    overlay: document.querySelector('.overlay'),
    drawerClose: document.querySelector('.drawer-close'),
    loginBtn: document.querySelector('.login-btn'),
    drawerLoginBtn: document.querySelector('.drawer-login'),
    drawerLinks: Array.from(document.querySelectorAll('.drawer-nav a')),
    navLinks: Array.from(document.querySelectorAll('.nav a, .drawer-nav a')),
    sections: {
      exam: document.getElementById('exam-settings'),
      registrations: document.getElementById('registrations-section'),
      multiApartment: document.getElementById('multi-apartment-section'),
      multiFunctional: document.getElementById('multi-functional-section'),
      guide: document.getElementById('guide-section'),
      app: document.getElementById('app-section'),
    },
    durationInput: document.getElementById('examDuration'),
    saveDurationBtn: document.getElementById('saveExamDuration'),
    durationFlash: document.getElementById('durationFlash'),
    gatePwdInput: document.getElementById('adminGatePassword'),
    gatePwdSaveBtn: document.getElementById('saveAdminGatePassword'),
    // Multi-apartment settings
    multiApartmentDurationInput: document.getElementById('multiApartmentDuration'),
    multiApartmentDurationSaveBtn: document.getElementById('saveMultiApartmentDuration'),
    multiApartmentDurationFlash: document.getElementById('multiApartmentDurationFlash'),
    multiApartmentGatePwdInput: document.getElementById('multiApartmentAdminGatePassword'),
    multiApartmentGatePwdSaveBtn: document.getElementById('saveMultiApartmentAdminGatePassword'),
    multiApartmentGatePwdFlash: document.getElementById('multiApartmentGatePwdFlash'),
    // Multi-functional settings
    multiFunctionalDurationInput: document.getElementById('multiFunctionalDuration'),
    multiFunctionalDurationSaveBtn: document.getElementById('saveMultiFunctionalDuration'),
    multiFunctionalDurationFlash: document.getElementById('multiFunctionalDurationFlash'),
    multiFunctionalGatePwdInput: document.getElementById('multiFunctionalAdminGatePassword'),
    multiFunctionalGatePwdSaveBtn: document.getElementById('saveMultiFunctionalAdminGatePassword'),
    multiFunctionalGatePwdFlash: document.getElementById('multiFunctionalGatePwdFlash'),
    blocksGrid: document.querySelector('.exam-blocks-grid'),
    blocksCount: document.getElementById('adminBlocksCount'),
    questionsCount: document.getElementById('adminQuestionsCount'),
    usersGrid: document.getElementById('usersGrid'),
    usersSearch: document.getElementById('usersSearch'),
    usersSort: document.getElementById('usersSort'),
    onlyAdmins: document.getElementById('onlyAdmins'),
    filterArchitects: document.getElementById('filterArchitects'),
    filterExperts: document.getElementById('filterExperts'),
    filterCertified: document.getElementById('filterCertified'),
    candidateResultsOverlay: document.getElementById('candidateResultsOverlay'),
    candidateResultsList: document.getElementById('candidateResultsList'),
    candidateResultsFullName: document.getElementById('candidateResultsFullName'),
    candidateResultsCode: document.getElementById('candidateResultsCode'),
    candidateResultsPersonalId: document.getElementById('candidateResultsPersonalId'),
    candidateResultsClose: document.getElementById('candidateResultsClose'),
    userStatementsOverlay: document.getElementById('userStatementsOverlay'),
    userStatementsList: document.getElementById('userStatementsList'),
    userStatementsMeta: document.getElementById('userStatementsMeta'),
    userStatementsClose: document.getElementById('userStatementsClose'),
    userCertificateOverlay: document.getElementById('userCertificateOverlay'),
    userCertificateClose: document.getElementById('userCertificateClose'),
    userCertificateDownload: document.getElementById('userCertificateDownload'),
    certificateCard: document.getElementById('certificateCard'),
    certificateStatusBadge: document.getElementById('certificateStatusBadge'),
    userCertificateDelete: document.getElementById('userCertificateDelete'),
    certificateEditBtn: document.getElementById('certificateEditBtn'),
    certificateEmptyState: document.getElementById('certificateEmptyState'),
    certificateEmptyCreate: document.getElementById('certificateEmptyCreate'),
    certificateForm: document.getElementById('certificateForm'),
    certificateFormCode: document.getElementById('certificateFormCode'),
    certificateFormCodeDisplay: document.getElementById('certificateFormCodeDisplay'),
    certificateFormLevel: document.getElementById('certificateFormLevel'),
    certificateFormStatus: document.getElementById('certificateFormStatus'),
    certificateFormIssueDate: document.getElementById('certificateFormIssueDate'),
    certificateFormValidityTerm: document.getElementById('certificateFormValidityTerm'),
    certificateFormValidUntil: document.getElementById('certificateFormValidUntil'),
    certificateFormValidUntilDisplay: document.getElementById('certificateFormValidUntilDisplay'),
    certificateFormScore: document.getElementById('certificateFormScore'),
    certificateFormSubmit: document.getElementById('certificateFormSubmit'),
    certificateFormName: document.getElementById('certificateFormName'),
    certificateFormPhone: document.getElementById('certificateFormPhone'),
    certificateFormEmail: document.getElementById('certificateFormEmail'),
    resultDetailOverlay: document.getElementById('resultDetailOverlay'),
    resultDetailExamTitle: document.getElementById('resultDetailExamTitle'),
    resultDetailStatus: document.getElementById('resultDetailStatus'),
    resultDetailCandidate: document.getElementById('resultDetailCandidate'),
    resultDetailPersonalId: document.getElementById('resultDetailPersonalId'),
    resultDetailCode: document.getElementById('resultDetailCode'),
    resultDetailStartedAt: document.getElementById('resultDetailStartedAt'),
    resultDetailFinishedAt: document.getElementById('resultDetailFinishedAt'),
    resultDetailDuration: document.getElementById('resultDetailDuration'),
    resultDetailScore: document.getElementById('resultDetailScore'),
    resultBlockStats: document.getElementById('resultBlockStats'),
    resultDetailSummary: document.getElementById('resultDetailSummary'),
    resultQuestionList: document.getElementById('resultQuestionList'),
    resultDetailDownload: document.getElementById('resultDetailDownload'),
    resultDetailMedia: document.getElementById('resultDetailMedia'),
    resultDetailScreenMedia: document.getElementById('resultDetailScreenMedia'),
    resultDetailClose: document.getElementById('resultDetailClose'),
    resultMediaSection: document.getElementById('resultMediaSection'),
    resultMediaPlayer: document.getElementById('resultMediaPlayer'),
    resultMediaDownload: document.getElementById('resultMediaDownload'),
    resultMediaInfo: document.getElementById('resultMediaInfo'),
    userEditOverlay: document.getElementById('userEditOverlay'),
    userEditForm: document.getElementById('userEditForm'),
    userEditClose: document.getElementById('userEditClose'),
    userEditCancel: document.getElementById('userEditCancel'),
    userEditTitle: document.getElementById('userEditTitle'),
    userEditFirstName: document.getElementById('userEditFirstName'),
    userEditLastName: document.getElementById('userEditLastName'),
    userEditPersonalId: document.getElementById('userEditPersonalId'),
    userEditPhone: document.getElementById('userEditPhone'),
    userEditEmail: document.getElementById('userEditEmail'),
    userEditCode: document.getElementById('userEditCode'),
    userEditSave: document.getElementById('userEditSave'),
  };

  const NAV_TARGETS = {
    'გამოცდა': 'exam',
    'რეგისტრაციები': 'registrations',
    'რეგისტრირებული პირები': 'registrations',
    'მრავალბინიანი': 'multiApartment',
    'მრავალფუნქციური': 'multiFunctional',
    'გზამკვლევი': 'guide',
    'APP': 'app',
  };

  const on = (element, event, handler) => element && element.addEventListener(event, handler);
  const activeOverlays = new Set();

  const shared = window.AdminShared || {};
  const modules = window.AdminModules || {};
  const {
    showToast = () => {},
    formatDateTime = (value) => String(value ?? ''),
    formatDuration = () => '—',
    arrayBufferToBase64 = () => '',
    loadExternalScript = () => Promise.resolve(),
    escapeHtml = (value) => String(value ?? ''),
    handleAdminErrorResponse = async () => {},
    deliverPdf = async () => false,
    preparePdfSaveHandle = async () => ({ handle: null, aborted: false }),
  } = shared;

  function getNavTarget(link) {
    if (!link) return null;
    const explicit = String(link.getAttribute('data-target') || '').trim();
    if (explicit) return explicit;
    const label = (link.textContent || '').trim();
    return NAV_TARGETS[label] || null;
  }

  function openOverlay(element) {
    if (!element) return;
    activeOverlays.add(element);
    element.classList.add('open');
    element.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');
  }

  function closeOverlay(element) {
    if (!element) return;
    activeOverlays.delete(element);
    element.classList.remove('open');
    element.setAttribute('aria-hidden', 'true');
    if (!activeOverlays.size) {
      document.body.classList.remove('modal-open');
    }
  }

  function showSection(name) {
    const activeName = typeof name === 'string' ? name : null;
    Object.entries(DOM.sections).forEach(([key, el]) => {
      if (!el) return;
      el.style.display = activeName && key === activeName ? 'block' : 'none';
    });

    DOM.navLinks.forEach((link) => {
      const target = getNavTarget(link);
      const isActive = !!activeName && target === activeName;
      link.classList.toggle('active', isActive);
      if (isActive) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    });
  }

  function getCurrentUser() {
    try {
      const raw = localStorage.getItem(KEYS.CURRENT_USER);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function getSavedEmail() {
    try { return (window.Auth?.getSavedEmail?.() || localStorage.getItem(KEYS.SAVED_EMAIL) || '').trim(); } catch { return ''; }
  }

  function isLoggedIn() {
    try { return !!(window.Auth?.isLoggedIn?.() || (localStorage.getItem(KEYS.AUTH) === 'true')); } catch { return false; }
  }

  function isFounderActor() {
    try {
      if (window.Auth?.isFounder?.()) return true;
      return getSavedEmail().toLowerCase() === FOUNDER_EMAIL.toLowerCase();
    } catch {
      return false;
    }
  }

  function getAdminHeaders() {
    return {};
  }

  function getActorEmail() { return getSavedEmail(); }

  function getActorHeaders() {
    // Try window.Auth first, fallback to direct localStorage access
    if (window.Auth?.getAuthHeaders) {
      return window.Auth.getAuthHeaders();
    }
    // Fallback: get token directly from localStorage
    const token = localStorage.getItem('auth_token');
    if (token) {
      return { 'Authorization': 'Bearer ' + token };
    }
    return {};
  }

  async function ensureAdminAccess() {
    const redirectToHome = () => {
      alert('ადმინისტრატორის გვერდზე დაშვება აქვს მხოლოდ ადმინს');
      window.location.href = 'index.html';
      return false;
    };

    const loggedIn = isLoggedIn();
    const savedEmail = getSavedEmail().toLowerCase();
    const isLocalAdmin = !!getCurrentUser()?.isAdmin;
    const isFounder = isFounderActor();

    if (!loggedIn || !savedEmail || (!isFounder && !isLocalAdmin)) {
      return redirectToHome();
    }

    try {
      const response = await fetch(`${API_BASE}/admin/auth/verify`, {
        headers: { ...getAdminHeaders(), ...getActorHeaders(), 'Cache-Control': 'no-cache' },
        credentials: 'include',
      });
      if (response.ok) return true;
      if (response.status === 401) return redirectToHome();
    } catch {}

    showToast('ადმინის ავტორიზაცია ვერ დადასტურდა', 'error');
    return redirectToHome();
  }

  function wireNavigation({ users, multiApartment, multiFunctional, guide, appFiles }) {
    const setMenu = (open) => {
      DOM.body?.classList.toggle('menu-open', open);
      if (DOM.burger) DOM.burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const closeMenu = () => setMenu(false);
    const toggleMenu = () => setMenu(!DOM.body?.classList.contains('menu-open'));

    on(DOM.burger, 'click', toggleMenu);
    on(DOM.overlay, 'click', closeMenu);
    on(DOM.drawerClose, 'click', closeMenu);
    DOM.drawerLinks.forEach((link) => on(link, 'click', closeMenu));

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeMenu();
    });

    const goHome = () => { window.location.href = 'index.html'; };
    on(DOM.loginBtn, 'click', goHome);
    on(DOM.drawerLoginBtn, 'click', goHome);

    DOM.navLinks.forEach((link) => {
      on(link, 'click', (event) => {
        const targetSection = getNavTarget(link);
        if (!targetSection) return;
        event.preventDefault();
        closeMenu();
        showSection(targetSection);
        const moduleMap = {
          registrations: users,
          multiApartment,
          multiFunctional,
          guide,
          app: appFiles,
        };
        moduleMap[targetSection]?.render?.();
      });
    });
  }

  const statementsEventHandlers = [];
  window.addEventListener('admin:statementsSeen', (event) => {
    statementsEventHandlers.forEach((handler) => {
      try { handler(event); } catch {}
    });
  });

  void bootstrapAdmin();

  async function bootstrapAdmin() {
    const moduleContextBase = {
      DOM,
      API_BASE,
      on,
      showToast,
      escapeHtml,
      formatDateTime,
      formatDuration,
      arrayBufferToBase64,
      loadExternalScript,
      handleAdminErrorResponse,
      deliverPdf,
      preparePdfSaveHandle,
      getAdminHeaders,
      getActorHeaders,
      getActorEmail,
      openOverlay,
      closeOverlay,
      isFounderActor,
    };

    const noop = () => {};
    const noopObj = { init: noop };
    const createModule = (factory, fallback = noopObj) => factory ? factory(moduleContextBase) : fallback;
    const createModuleWithContext = (factory, context, fallback = noopObj) => factory ? factory(context) : fallback;

    const examSettings = createModule(modules.createExamSettingsModule, { init: noop });
    const blocksModule = createModule(modules.createBlocksModule, { init: noop, render: noop, reload: noop });
    const resultsModule = createModule(modules.createResultsModule, { init: noop, open: noop, close: noop });
    const statementsModule = createModuleWithContext(modules.createStatementsModule, { ...moduleContextBase }, 
      { init: noop, open: noop, close: noop, downloadStatementPdf: noop, markStatementsSeen: noop });
    
    const certificateModule = createModuleWithContext(modules.createCertificateModule, {
      ...moduleContextBase,
      onUserCertificateUpdated: (userId, certificateData) => {
        usersModule.updateUserCardColor?.(userId, certificateData);
      },
    }, { init: noop, open: noop, close: noop });

    const usersModule = createModuleWithContext(modules.createUsersModule, {
      ...moduleContextBase,
      onShowResults: resultsModule.open,
      onShowStatements: statementsModule.open,
      onShowCertificate: certificateModule.open,
    }, { init: noop, render: noop, updateUserCardColor: noop });

    const multiApartmentModule = createModule(modules.createMultiApartmentModule, { init: noop, render: noop });
    const multiFunctionalModule = createModule(modules.createMultiFunctionalModule, { init: noop, render: noop });
    const guideModule = createModule(modules.createGuideModule, { init: noop, render: noop, reload: noop });
    const appFilesModule = createModule(modules.createAppFilesModule, { init: noop, render: noop, reload: noop });

    const hasAccess = await ensureAdminAccess();
    if (!hasAccess) return;

    wireNavigation({ users: usersModule, multiApartment: multiApartmentModule, multiFunctional: multiFunctionalModule, guide: guideModule, appFiles: appFilesModule });

    examSettings.init();
    blocksModule.init();
    resultsModule.init();
    statementsModule.init();
    certificateModule.init();
    usersModule.init();
    multiApartmentModule.init();
    multiFunctionalModule.init();
    guideModule.init();
    appFilesModule.init();

    usersModule.refreshUnseenSummary?.();

    statementsEventHandlers.push((event) => {
      const detail = event.detail || {};
      if (detail.userId != null) {
        usersModule.updateUserUnseenStatus?.(detail.userId, detail.hasUnseen, detail.remainingCount);
      }
      if (detail.refreshSummary !== false) {
        usersModule.refreshUnseenSummary?.();
      }
    });

    // Default landing section (matches the first nav item in admin.html)
    showSection('registrations');
    usersModule.render?.();
  }
});



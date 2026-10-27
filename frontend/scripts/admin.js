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
    drawerLinks: Array.from(document.querySelectorAll('.drawer-nav a:not(.drawer-other-trigger)')),
    navLinks: Array.from(document.querySelectorAll('.nav a:not(.other-trigger), .drawer-nav a:not(.drawer-other-trigger)')),
    sections: {
      exam: document.getElementById('exam-settings'),
      registrations: document.getElementById('registrations-section'),
      multiApartment: document.getElementById('multi-apartment-section'),
      multiFunctional: document.getElementById('multi-functional-section'),
      guide: document.getElementById('guide-section'),
      regulations: document.getElementById('regulations-section'),
      documents: document.getElementById('documents-section'),
      app: document.getElementById('app-section'),
      applicationForm: document.getElementById('application-form-section'),
      publicAi: document.getElementById('public-ai-section'),
    },
    durationInput: document.getElementById('examDuration'),
    saveDurationBtn: document.getElementById('saveExamDuration'),
    durationFlash: document.getElementById('durationFlash'),
    gatePwdInput: document.getElementById('adminGatePassword'),
    gatePwdSaveBtn: document.getElementById('saveAdminGatePassword'),
    taxonomyChapterSelect: document.getElementById('taxonomyChapterSelect'),
    taxonomyChapterDropdown: document.getElementById('taxonomyChapterDropdown'),
    taxonomyChapterLabel: document.getElementById('taxonomyChapterLabel'),
    taxonomyChapterMenu: document.getElementById('taxonomyChapterMenu'),
    taxonomyOpenChapterCreator: document.getElementById('openTaxonomyChapterCreator'),
    taxonomyChapterCreator: document.getElementById('taxonomyChapterCreator'),
    taxonomyChapterName: document.getElementById('taxonomyChapterName'),
    taxonomySaveChapterBtn: document.getElementById('saveTaxonomyChapter'),
    taxonomyCloseChapterCreator: document.getElementById('closeTaxonomyChapterCreator'),
    taxonomySubchapterSelect: document.getElementById('taxonomySubchapterSelect'),
    taxonomySubchapterDropdown: document.getElementById('taxonomySubchapterDropdown'),
    taxonomySubchapterLabel: document.getElementById('taxonomySubchapterLabel'),
    taxonomySubchapterMenu: document.getElementById('taxonomySubchapterMenu'),
    taxonomyOpenSubchapterCreator: document.getElementById('openTaxonomySubchapterCreator'),
    taxonomySubchapterCreator: document.getElementById('taxonomySubchapterCreator'),
    taxonomySubchapterName: document.getElementById('taxonomySubchapterName'),
    taxonomySaveSubchapterBtn: document.getElementById('saveTaxonomySubchapter'),
    taxonomyCloseSubchapterCreator: document.getElementById('closeTaxonomySubchapterCreator'),
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
    resetUsersFilters: document.getElementById('resetUsersFilters'),
    onlyAdmins: document.getElementById('onlyAdmins'),
    filterArchitects: document.getElementById('filterArchitects'),
    filterExperts: document.getElementById('filterExperts'),
    filterMunicipal: document.getElementById('filterMunicipal'),
    filterCertified: document.getElementById('filterCertified'),
    filterSuspendedExpired: document.getElementById('filterSuspendedExpired'),
    filterExamCandidates: document.getElementById('filterExamCandidates'),
    filterExamCandidatesChip: document.getElementById('filterExamCandidatesChip'),
    filterExamCandidatesBadge: document.getElementById('filterExamCandidatesBadge'),
    filterCertCandidates: document.getElementById('filterCertCandidates'),
    filterCertCandidatesChip: document.getElementById('filterCertCandidatesChip'),
    filterCertCandidatesBadge: document.getElementById('filterCertCandidatesBadge'),
    filterStatements: document.getElementById('filterStatements'),
    filterStatementsBadge: document.getElementById('filterStatementsBadge'),
    filterPendingStatements: document.getElementById('filterPendingStatements'),
    filterPendingStatementsBadge: document.getElementById('filterPendingStatementsBadge'),
    filterAllStatements: document.getElementById('filterAllStatements'),
    filterAllStatementsBadge: document.getElementById('filterAllStatementsBadge'),
    statementsDate: document.getElementById('statementsDate'),
    clearStatementsDate: document.getElementById('clearStatementsDate'),
    filterSentExam: document.getElementById('filterSentExam'),
    filterSentRejection: document.getElementById('filterSentRejection'),
    filterSentCertificate: document.getElementById('filterSentCertificate'),
    filterSentFail: document.getElementById('filterSentFail'),
    filterSentCustom: document.getElementById('filterSentCustom'),
    sentLettersDate: document.getElementById('sentLettersDate'),
    clearSentLettersDate: document.getElementById('clearSentLettersDate'),
    filterExamMorning: document.getElementById('filterExamMorning'),
    filterExamEvening: document.getElementById('filterExamEvening'),
    filterCertificateHandover: document.getElementById('filterCertificateHandover'),
    examScheduleDate: document.getElementById('examScheduleDate'),
    clearExamScheduleDate: document.getElementById('clearExamScheduleDate'),
    filterExamPassed: document.getElementById('filterExamPassed'),
    filterExamFailed: document.getElementById('filterExamFailed'),
    filterPendingPassLetter: document.getElementById('filterPendingPassLetter'),
    filterPendingPassLetterChip: document.getElementById('filterPendingPassLetterChip'),
    filterPendingPassLetterBadge: document.getElementById('filterPendingPassLetterBadge'),
    filterPendingFailLetter: document.getElementById('filterPendingFailLetter'),
    filterPendingFailLetterChip: document.getElementById('filterPendingFailLetterChip'),
    filterPendingFailLetterBadge: document.getElementById('filterPendingFailLetterBadge'),
    examResultDate: document.getElementById('examResultDate'),
    clearExamResultDate: document.getElementById('clearExamResultDate'),
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
    certificateTransitionalBox: document.getElementById('certificateTransitionalBox'),
    certificateTransitionalDeadlineInput: document.getElementById('certificateTransitionalDeadlineInput'),
    certificateTransitionalDeadlineSave: document.getElementById('certificateTransitionalDeadlineSave'),
    certificateFormNotifyEditor: document.getElementById('certificateFormNotifyEditor'),
    certificateFormNotifyEditBtn: document.getElementById('certificateFormNotifyEditBtn'),
    certificateFormNotifyReset: document.getElementById('certificateFormNotifyReset'),
    certificateFormNotifySaveTemplate: document.getElementById('certificateFormNotifySaveTemplate'),
    certificateFormNotifySubject: document.getElementById('certificateFormNotifySubject'),
    certificateFormNotifyBody: document.getElementById('certificateFormNotifyBody'),
    certificateFormSendNotification: document.getElementById('certificateFormSendNotification'),
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
    resultDetailStatusBanner: document.getElementById('resultDetailStatusBanner'),
    resultDetailSummary: document.getElementById('resultDetailSummary'),
    resultQuestionList: document.getElementById('resultQuestionList'),
    resultDetailDownloadShort: document.getElementById('resultDetailDownloadShort'),
    resultDetailDownload: document.getElementById('resultDetailDownload'),
    resultDetailMedia: document.getElementById('resultDetailMedia'),
    resultDetailScreenMedia: document.getElementById('resultDetailScreenMedia'),
    resultDetailClose: document.getElementById('resultDetailClose'),
    resultMediaSection: document.getElementById('resultMediaSection'),
    resultMediaPlayer: document.getElementById('resultMediaPlayer'),
    resultMediaDownload: document.getElementById('resultMediaDownload'),
    resultMediaInfo: document.getElementById('resultMediaInfo'),
    // Project results (multi-apartment/multi-functional)
    projectResultsOverlay: document.getElementById('projectResultsOverlay'),
    projectResultsList: document.getElementById('projectResultsList'),
    projectResultsFullName: document.getElementById('projectResultsFullName'),
    projectResultsType: document.getElementById('projectResultsType'),
    projectResultsClose: document.getElementById('projectResultsClose'),
    projectDetailOverlay: document.getElementById('projectDetailOverlay'),
    projectDetailProjectName: document.getElementById('projectDetailProjectName'),
    projectDetailStatus: document.getElementById('projectDetailStatus'),
    projectDetailCandidate: document.getElementById('projectDetailCandidate'),
    projectDetailProjectCode: document.getElementById('projectDetailProjectCode'),
    projectDetailStartedAt: document.getElementById('projectDetailStartedAt'),
    projectDetailFinishedAt: document.getElementById('projectDetailFinishedAt'),
    projectDetailDuration: document.getElementById('projectDetailDuration'),
    projectDetailScore: document.getElementById('projectDetailScore'),
    projectDetailStatusBanner: document.getElementById('projectDetailStatusBanner'),
    projectDetailSummary: document.getElementById('projectDetailSummary'),
    projectAnswerList: document.getElementById('projectAnswerList'),
    projectDetailDownloadShort: document.getElementById('projectDetailDownloadShort'),
    projectDetailDownload: document.getElementById('projectDetailDownload'),
    projectDetailClose: document.getElementById('projectDetailClose'),
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
    'დოკუმენტები': 'documents',
    'დამატება': 'documents',
    'APP': 'app',
    'საჯარო AI': 'publicAi',
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

  const FOUNDER_ONLY_SECTIONS = new Set(['exam', 'multiApartment', 'multiFunctional']);
  let verifiedIsFounder = null;

  function showSection(name) {
    const activeName = typeof name === 'string' ? name : null;
    if (activeName && FOUNDER_ONLY_SECTIONS.has(activeName) && !isFounderActor()) {
      return;
    }
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

    const otherChildTargets = new Set(['guide', 'regulations', 'applicationForm']);
    const isOtherChildActive = !!activeName && otherChildTargets.has(activeName);
    document.querySelector('.other-trigger')?.classList.toggle('active', isOtherChildActive);
    document.querySelector('.drawer-other-trigger')?.classList.toggle('active', isOtherChildActive);
    window.dispatchEvent(new CustomEvent('admin:sectionChanged', { detail: { section: activeName } }));
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
    if (typeof verifiedIsFounder === 'boolean') return verifiedIsFounder;
    try {
      if (window.Auth?.isFounder?.()) return true;
      const cur = getCurrentUser();
      if (cur && (cur.isFounder === true || cur.is_founder === true)) return true;
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
      if (response.ok) {
        const founderHdr = (response.headers?.get?.('X-Is-Founder') || '').toLowerCase();
        if (founderHdr === 'true' || founderHdr === 'false') {
          verifiedIsFounder = founderHdr === 'true';
        }
        return true;
      }
      if (response.status === 401) return redirectToHome();
    } catch {}

    showToast('ადმინის ავტორიზაცია ვერ დადასტურდა', 'error');
    return redirectToHome();
  }

  function wireNavigation({ users, multiApartment, multiFunctional, guide, regulations, documents, appFiles, applicationForm, publicAi }) {
    const setMenu = (open) => {
      DOM.body?.classList.toggle('menu-open', open);
      if (DOM.burger) DOM.burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    const closeMenu = () => setMenu(false);
    const toggleMenu = () => setMenu(!DOM.body?.classList.contains('menu-open'));

    on(DOM.burger, 'click', toggleMenu);
    on(DOM.overlay, 'click', closeMenu);
    on(DOM.drawerClose, 'click', closeMenu);
    DOM.drawerLinks.forEach((link) => {
      on(link, 'click', (event) => {
        const targetSection = getNavTarget(link);
        if (targetSection && FOUNDER_ONLY_SECTIONS.has(targetSection) && !isFounderActor()) {
          event.preventDefault();
          return;
        }
        closeMenu();
      });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeMenu();
        closeOtherDropdown();
        closeDrawerOtherSubmenu();
      }
    });

    const goHome = () => { window.location.href = 'index.html'; };
    on(DOM.loginBtn, 'click', goHome);
    on(DOM.drawerLoginBtn, 'click', goHome);

    // "სხვადასხვა" dropdown handling
    const navOther = document.querySelector('.nav-other');
    const otherTrigger = document.querySelector('.other-trigger');
    const otherDropdown = document.querySelector('.other-dropdown');
    const drawerOtherTrigger = document.querySelector('.drawer-other-trigger');
    const drawerOtherSubmenu = document.querySelector('.drawer-other-submenu');

    function closeOtherDropdown() {
      otherDropdown?.classList.remove('show');
      navOther?.classList.remove('open');
      otherTrigger?.setAttribute('aria-expanded', 'false');
    }
    function toggleOtherDropdown(e) {
      e?.preventDefault();
      e?.stopPropagation();
      const willOpen = !otherDropdown?.classList.contains('show');
      otherDropdown?.classList.toggle('show', willOpen);
      navOther?.classList.toggle('open', willOpen);
      otherTrigger?.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      otherTrigger?.blur?.();
    }
    function closeDrawerOtherSubmenu() {
      if (drawerOtherSubmenu) drawerOtherSubmenu.hidden = true;
    }
    function toggleDrawerOtherSubmenu(e) {
      e?.preventDefault();
      e?.stopPropagation();
      if (drawerOtherSubmenu) drawerOtherSubmenu.hidden = !drawerOtherSubmenu.hidden;
    }

    on(otherTrigger, 'click', toggleOtherDropdown);
    on(drawerOtherTrigger, 'click', toggleDrawerOtherSubmenu);

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.nav-other')) closeOtherDropdown();
    });

    DOM.navLinks.forEach((link) => {
      on(link, 'click', (event) => {
        const targetSection = getNavTarget(link);
        if (!targetSection) return;
        event.preventDefault();
        link.blur?.();
        if (FOUNDER_ONLY_SECTIONS.has(targetSection) && !isFounderActor()) {
          return;
        }
        closeMenu();
        closeOtherDropdown();
        closeDrawerOtherSubmenu();
        showSection(targetSection);
        const moduleMap = {
          registrations: users,
          multiApartment,
          multiFunctional,
          guide,
          regulations,
          documents,
          app: appFiles,
          applicationForm,
          publicAi,
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
    const projectResultsModule = createModuleWithContext(modules.createProjectResultsModule, { ...moduleContextBase },
      { init: noop, open: noop, openMultiApartment: noop, openMultiFunctional: noop, close: noop });
    const statementsModule = createModuleWithContext(modules.createStatementsModule, { ...moduleContextBase }, 
      { init: noop, open: noop, close: noop, downloadStatementPdf: noop, markStatementsSeen: noop });
    
    const certificateModule = createModuleWithContext(modules.createCertificateModule, {
      ...moduleContextBase,
      onUserCertificateUpdated: (userId, certificateData) => {
        if (userId != null) {
          usersModule.updateUserCardColor?.(userId, certificateData);
        }
        usersModule.refreshLiveUserStates?.({ force: true });
        try {
          window.dispatchEvent(new CustomEvent('admin:certificateUpdated', { detail: { userId, certificateData } }));
        } catch {}
      },
    }, { init: noop, open: noop, close: noop });

    const examSchedulesModule = createModuleWithContext(modules.createExamSchedulesModule, {
      ...moduleContextBase,
      downloadStatementPdf: statementsModule.downloadStatementPdf,
    }, { mount: noop });
    const usersModule = createModuleWithContext(modules.createUsersModule, {
      ...moduleContextBase,
      examSchedules: examSchedulesModule,
      onShowResults: resultsModule.open,
      onShowStatements: statementsModule.open,
      onShowCertificate: certificateModule.open,
      onShowMultiApartmentResults: projectResultsModule.openMultiApartment,
      onShowMultiFunctionalResults: projectResultsModule.openMultiFunctional,
    }, { init: noop, render: noop, updateUserCardColor: noop });

    const multiApartmentModule = createModule(modules.createMultiApartmentModule, { init: noop, render: noop });
    const multiFunctionalModule = createModule(modules.createMultiFunctionalModule, { init: noop, render: noop });
    const guideModule = createModule(modules.createGuideModule, { init: noop, render: noop, reload: noop });
    const regulationsModule = createModule(modules.createRegulationsModule, { init: noop, render: noop, reload: noop });
    const appFilesModule = createModule(modules.createAppFilesModule, { init: noop, render: noop, reload: noop });
    const applicationFormModule = createModule(modules.createApplicationFormModule, { init: noop, render: noop, reload: noop });
    const documentsModule = createModule(modules.createDocumentsModule, { init: noop, render: noop });
    const aiAssistantModule = createModuleWithContext(modules.createAiAssistantModule, {
      ...moduleContextBase,
      onLetterSent: () => {
        usersModule.refreshLiveUserStates?.({ force: true });
        usersModule.refreshUnseenSummary?.();
      },
    }, { init: noop });
    const publicAiModule = createModuleWithContext(modules.createPublicAiAdminModule, {
      ...moduleContextBase,
      onSettingsSaved: () => {
        aiAssistantModule.refreshStatus?.();
      },
    }, { init: noop, render: noop });

    const hasAccess = await ensureAdminAccess();
    if (!hasAccess) return;

    wireNavigation({ users: usersModule, multiApartment: multiApartmentModule, multiFunctional: multiFunctionalModule, guide: guideModule, regulations: regulationsModule, documents: documentsModule, appFiles: appFilesModule, applicationForm: applicationFormModule, publicAi: publicAiModule });

    if (isFounderActor()) {
      examSettings.init();
      blocksModule.init();
      multiApartmentModule.init();
      multiFunctionalModule.init();
    } else {
      FOUNDER_ONLY_SECTIONS.forEach((secKey) => {
        const secEl = DOM.sections[secKey];
        if (secEl) {
          secEl.style.display = 'none';
          secEl.innerHTML = '';
        }
      });
    }
    resultsModule.init();
    projectResultsModule.init();
    statementsModule.init();
    certificateModule.init();
    usersModule.init();
    guideModule.init();
    regulationsModule.init();
    documentsModule.init();
    appFilesModule.init();
    applicationFormModule.init();
    aiAssistantModule.init();
    publicAiModule.init();
    initAdminCertBookingsModule(moduleContextBase);

    usersModule.refreshUnseenSummary?.();

    statementsEventHandlers.push((event) => {
      const detail = event.detail || {};
      if (detail.userId != null) {
        usersModule.updateUserUnseenStatus?.(detail.userId, detail.hasUnseen, detail.remainingCount, detail.hasPending, detail.pendingCount);
        usersModule.refreshLiveUserStates?.({ force: true });
      }
      if (detail.refreshSummary !== false) {
        usersModule.refreshUnseenSummary?.();
      }
    });

    // Default landing section (matches the first nav item in admin.html)
    showSection('registrations');
    usersModule.render?.();
  }

  function initAdminCertBookingsModule(ctx) {
    const MONTHS_KA = [
      'იანვარი', 'თებერვალი', 'მარტი', 'აპრილი', 'მაისი', 'ივნისი',
      'ივლისი', 'აგვისტო', 'სექტემბერი', 'ოქტომბერი', 'ნოემბერი', 'დეკემბერი',
    ];
    const MONTHS_SHORT_KA = [
      'იან', 'თებ', 'მარ', 'აპრ', 'მაი', 'ივნ',
      'ივლ', 'აგვ', 'სექ', 'ოქტ', 'ნოე', 'დეკ',
    ];
    const WEEKDAYS_FULL_KA = [
      'ორშაბათი', 'სამშაბათი', 'ოთხშაბათი', 'ხუთშაბათი', 'პარასკევი', 'შაბათი', 'კვირა',
    ];
    const DEFAULT_SLOTS = [
      '11:00', '11:20', '11:40',
      '12:00', '12:20', '12:40',
      '13:00', '13:20', '13:40',
      '14:00', '14:20', '14:40',
      '15:00', '15:20', '15:40',
    ];

    const dom = {
      headerBtn: document.getElementById('adminCertBookingsBtn'),
      headerBadge: document.getElementById('adminCertBookingsBadge'),
      drawerBtn: document.getElementById('drawerCertBookingsBtn'),
      overlay: document.getElementById('adminCertBookingsOverlay'),
      closeBtn: document.getElementById('adminCertBookingsClose'),
      refreshBtn: document.getElementById('adminCertBookingsRefreshBtn'),
      summaryMeta: document.getElementById('adminCertBookingsSummaryMeta'),
      weekdaysGroup: document.getElementById('adminCbWeekdaysGroup'),
      applyYearBtn: document.getElementById('adminCbApplyYearBtn'),
      applyMonthBtn: document.getElementById('adminCbApplyMonthBtn'),
      clearMonthBtn: document.getElementById('adminCbClearMonthBtn'),
      monthsStrip: document.getElementById('adminCbMonthsStrip'),
      prevMonthBtn: document.getElementById('adminCbPrevMonth'),
      nextMonthBtn: document.getElementById('adminCbNextMonth'),
      calTitle: document.getElementById('adminCbCalTitle'),
      calGrid: document.getElementById('adminCbCalGrid'),
      selectedDayTitle: document.getElementById('adminCbSelectedDayTitle'),
      selectedDaySub: document.getElementById('adminCbSelectedDaySub'),
      enableDayBtn: document.getElementById('adminCbEnableDayBtn'),
      disableDayBtn: document.getElementById('adminCbDisableDayBtn'),
      slotsGrid: document.getElementById('adminCbSlotsGrid'),
      candidateCard: document.getElementById('adminCbCandidateCard'),
      candName: document.getElementById('adminCbCandName'),
      candDateTime: document.getElementById('adminCbCandDateTime'),
      candCategory: document.getElementById('adminCbCandCategory'),
      candPersonalId: document.getElementById('adminCbCandPersonalId'),
      candPhone: document.getElementById('adminCbCandPhone'),
      candEmail: document.getElementById('adminCbCandEmail'),
      candCode: document.getElementById('adminCbCandCode'),
      candLetterDate: document.getElementById('adminCbCandLetterDate'),
      candDeadline: document.getElementById('adminCbCandDeadline'),
      cancelBookingBtn: document.getElementById('adminCbCancelBookingBtn'),
      listCount: document.getElementById('adminCbListCount'),
      bookingsList: document.getElementById('adminCbBookingsList'),
    };

    let overview = null;
    let currentYear = new Date().getFullYear();
    let currentMonth = new Date().getMonth(); // 0..11
    let selectedDateStr = null;
    let inspectedBooking = null;
    let isBusy = false;

    function slotEndTime(slot) {
      try {
        const [hh, mm] = slot.split(':').map(Number);
        const total = hh * 60 + mm + 20;
        return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      } catch {
        return slot;
      }
    }

    function formatKaDate(dateStr) {
      if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr || '—';
      const [y, m, d] = dateStr.split('-');
      return `${d}.${m}.${y}`;
    }

    function getCheckedWeekdays() {
      if (!dom.weekdaysGroup) return [0, 1, 2, 3, 4];
      return Array.from(dom.weekdaysGroup.querySelectorAll('input[type="checkbox"]:checked'))
        .map((inp) => Number(inp.value))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 4);
    }

    function syncWeekdayCheckboxesFromTemplate() {
      const tplDays = overview?.weekday_template?.weekdays;
      if (!dom.weekdaysGroup || !Array.isArray(tplDays)) return;
      const set = new Set(tplDays.map(Number));
      dom.weekdaysGroup.querySelectorAll('input[type="checkbox"]').forEach((inp) => {
        inp.checked = set.has(Number(inp.value));
      });
    }

    function syncHeaderBadge() {
      const upcomingCount = Number(overview?.summary?.upcoming_active_count || 0);
      if (dom.headerBadge) {
        if (upcomingCount > 0) {
          dom.headerBadge.hidden = false;
          dom.headerBadge.textContent = String(upcomingCount);
        } else {
          dom.headerBadge.hidden = true;
        }
      }
      if (dom.headerBtn) {
        dom.headerBtn.classList.toggle('has-upcoming', upcomingCount > 0);
      }
      if (dom.summaryMeta && overview) {
        dom.summaryMeta.textContent = `აქტიური მომავალი ჯავშნები: ${upcomingCount} · დღეს: ${overview.summary?.today_active_count || 0} · მონიშნული სამუშაო დღეები (1 წელში): ${overview.summary?.enabled_days_count || 0}`;
      }
    }

    function getBookingsByDateMap() {
      const map = {};
      const list = Array.isArray(overview?.bookings) ? overview.bookings : [];
      list.forEach((b) => {
        if (b.raw_status !== 'active') return;
        if (!map[b.booking_date]) map[b.booking_date] = [];
        map[b.booking_date].push(b);
      });
      return map;
    }

    function renderMonthsStrip() {
      if (!dom.monthsStrip) return;
      dom.monthsStrip.innerHTML = '';
      const todayStr = overview?.today || new Date().toISOString().slice(0, 10);
      const [startY, startM] = todayStr.split('-').map(Number);

      const bookingsByMonth = {};
      (overview?.bookings || []).forEach((b) => {
        if (b.raw_status !== 'active') return;
        const ym = b.booking_date.slice(0, 7);
        bookingsByMonth[ym] = (bookingsByMonth[ym] || 0) + 1;
      });

      const frag = document.createDocumentFragment();
      for (let i = 0; i < 12; i += 1) {
        const d = new Date(startY, (startM - 1) + i, 1);
        const y = d.getFullYear();
        const m = d.getMonth();
        const ymKey = `${y}-${String(m + 1).padStart(2, '0')}`;
        const bCount = bookingsByMonth[ymKey] || 0;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'admin-cb-month-pill';
        if (y === currentYear && m === currentMonth) {
          btn.classList.add('is-active');
        }
        btn.innerHTML = `
          <span>${MONTHS_SHORT_KA[m]} ${y}</span>
          ${bCount > 0 ? `<span class="m-sub">${bCount} ჯავშ.</span>` : ''}
        `;
        btn.addEventListener('click', () => {
          currentYear = y;
          currentMonth = m;
          renderMonthsStrip();
          renderCalendar();
        });
        frag.appendChild(btn);
      }
      dom.monthsStrip.appendChild(frag);
    }

    function renderCandidateCard() {
      if (!dom.candidateCard) return;
      if (!inspectedBooking) {
        dom.candidateCard.hidden = true;
        return;
      }
      const b = inspectedBooking;
      const u = b.user || {};
      dom.candidateCard.hidden = false;
      if (dom.candName) dom.candName.textContent = u.full_name || '—';
      if (dom.candDateTime) dom.candDateTime.textContent = `${b.booking_date_ka} · ${b.time_range || b.slot_time} (${b.status_label || ''})`;
      if (dom.candCategory) dom.candCategory.textContent = u.category_label || u.category || '—';
      if (dom.candPersonalId) dom.candPersonalId.textContent = u.personal_id || '—';
      if (dom.candPhone) dom.candPhone.textContent = u.phone || '—';
      if (dom.candEmail) dom.candEmail.textContent = u.email || '—';
      if (dom.candCode) dom.candCode.textContent = u.code || '—';
      if (dom.candLetterDate) dom.candLetterDate.textContent = b.letter_sent_ka || '—';
      if (dom.candDeadline) dom.candDeadline.textContent = b.deadline_ka ? `${b.deadline_ka}-მდე` : '—';
      if (dom.cancelBookingBtn) {
        dom.cancelBookingBtn.hidden = b.raw_status !== 'active';
      }
    }

    function renderSelectedDayPanel() {
      if (!dom.slotsGrid || !dom.selectedDayTitle || !dom.selectedDaySub) return;
      dom.slotsGrid.innerHTML = '';

      if (!selectedDateStr) {
        dom.selectedDayTitle.textContent = 'აირჩიეთ სამუშაო დღე კალენდარში';
        dom.selectedDaySub.textContent = '20-წუთიანი შუალედების სამართავად ან ჯავშნის სანახავად';
        if (dom.enableDayBtn) dom.enableDayBtn.disabled = true;
        if (dom.disableDayBtn) dom.disableDayBtn.disabled = true;
        renderCandidateCard();
        return;
      }

      const [sy, sm, sd] = selectedDateStr.split('-').map(Number);
      const dObj = new Date(sy, sm - 1, sd);
      const wIdx = (dObj.getDay() + 6) % 7;
      const isWeekend = wIdx >= 5;

      dom.selectedDayTitle.textContent = `${formatKaDate(selectedDateStr)} (${WEEKDAYS_FULL_KA[wIdx]})`;

      const enabledSlots = new Set(overview?.availability?.[selectedDateStr] || []);
      const dayBookingsMap = {};
      (overview?.bookings || []).forEach((b) => {
        if (b.booking_date === selectedDateStr && b.raw_status === 'active') {
          dayBookingsMap[b.slot_time] = b;
        }
      });

      dom.selectedDaySub.textContent = isWeekend
        ? 'შაბათ-კვირა დაბლოკილია'
        : `ჩართულია ${enabledSlots.size}/15 სლოტი · დააკლიკეთ სლოტს ჩასართავად/გასათიშად ან დამჯავშნის სანახავად`;

      if (dom.enableDayBtn) dom.enableDayBtn.disabled = isWeekend || isBusy;
      if (dom.disableDayBtn) dom.disableDayBtn.disabled = isWeekend || isBusy;

      const allSlots = overview?.all_slots || DEFAULT_SLOTS;
      const frag = document.createDocumentFragment();

      allSlots.forEach((slotTime) => {
        const isEnabled = enabledSlots.has(slotTime);
        const booked = dayBookingsMap[slotTime] || null;
        const endStr = slotEndTime(slotTime);

        const card = document.createElement('div');
        card.className = 'admin-cb-slot-item';
        if (isEnabled) card.classList.add('is-enabled');
        if (booked) card.classList.add('is-booked');
        if (inspectedBooking && booked && inspectedBooking.id === booked.id) {
          card.classList.add('is-inspected');
        }

        const timeEl = document.createElement('div');
        timeEl.className = 'admin-cb-slot-time';
        timeEl.textContent = `${slotTime}–${endStr}`;

        const statusEl = document.createElement('div');
        statusEl.className = 'admin-cb-slot-status';
        if (booked) {
          statusEl.textContent = `👤 ${booked.user?.full_name || 'დაჯავშნილია'}`;
        } else if (isEnabled) {
          statusEl.textContent = '✓ თავისუფალი';
        } else {
          statusEl.textContent = 'გათიშული';
        }

        card.appendChild(timeEl);
        card.appendChild(statusEl);

        card.addEventListener('click', () => {
          if (booked) {
            inspectedBooking = booked;
            renderSelectedDayPanel();
            dom.candidateCard?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
            return;
          }
          if (isWeekend || isBusy) return;
          const nextSlots = new Set(enabledSlots);
          if (nextSlots.has(slotTime)) nextSlots.delete(slotTime);
          else nextSlots.add(slotTime);
          void updateSingleDayAvailability(selectedDateStr, Array.from(nextSlots));
        });

        frag.appendChild(card);
      });

      dom.slotsGrid.appendChild(frag);
      renderCandidateCard();
    }

    function renderCalendar() {
      if (!dom.calGrid || !dom.calTitle) return;
      dom.calTitle.textContent = `${MONTHS_KA[currentMonth]} ${currentYear}`;
      dom.calGrid.innerHTML = '';

      const firstDay = new Date(currentYear, currentMonth, 1);
      const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
      const startOffset = (firstDay.getDay() + 6) % 7; // Monday = 0 .. Sunday = 6
      const todayStr = overview?.today || new Date().toISOString().slice(0, 10);
      const bookingsByDate = getBookingsByDateMap();

      const frag = document.createDocumentFragment();
      for (let i = 0; i < startOffset; i += 1) {
        const empty = document.createElement('div');
        empty.className = 'admin-cb-day-cell is-empty';
        frag.appendChild(empty);
      }

      for (let day = 1; day <= daysInMonth; day += 1) {
        const mm = String(currentMonth + 1).padStart(2, '0');
        const dd = String(day).padStart(2, '0');
        const dateStr = `${currentYear}-${mm}-${dd}`;
        const dObj = new Date(currentYear, currentMonth, day);
        const wIdx = (dObj.getDay() + 6) % 7;
        const isWeekend = wIdx >= 5;
        const isPast = dateStr < todayStr;

        const enabledSlots = overview?.availability?.[dateStr] || [];
        const dayBookings = bookingsByDate[dateStr] || [];

        const cell = document.createElement('div');
        cell.className = 'admin-cb-day-cell';
        if (isWeekend) cell.classList.add('is-weekend');
        if (isPast) cell.classList.add('is-past');
        if (!isWeekend && enabledSlots.length > 0) cell.classList.add('is-enabled');
        if (dayBookings.length > 0) cell.classList.add('has-bookings');
        if (selectedDateStr === dateStr) cell.classList.add('is-selected');

        const numEl = document.createElement('span');
        numEl.className = 'admin-cb-day-num';
        numEl.textContent = String(day);
        cell.appendChild(numEl);

        const badgesWrap = document.createElement('div');
        badgesWrap.className = 'admin-cb-day-badges';

        if (dayBookings.length > 0) {
          const bPill = document.createElement('span');
          bPill.className = 'admin-cb-booked-pill';
          bPill.textContent = dayBookings.length === 1
            ? dayBookings[0].slot_time
            : `${dayBookings.length} ჯავშანი`;
          badgesWrap.appendChild(bPill);
        } else if (!isWeekend && enabledSlots.length > 0) {
          const sPill = document.createElement('span');
          sPill.className = 'admin-cb-slot-pill';
          sPill.textContent = `${enabledSlots.length}/15 სლოტი`;
          badgesWrap.appendChild(sPill);
        }

        cell.appendChild(badgesWrap);

        if (!isWeekend) {
          cell.addEventListener('click', () => {
            selectedDateStr = dateStr;
            if (dayBookings.length > 0) {
              inspectedBooking = dayBookings[0];
            } else if (inspectedBooking && inspectedBooking.booking_date !== dateStr) {
              inspectedBooking = null;
            }
            renderCalendar();
            renderSelectedDayPanel();
          });

          // Double-click workday to quickly toggle all 15 slots on/off
          cell.addEventListener('dblclick', (e) => {
            e.preventDefault();
            if (isBusy) return;
            const nextSlots = enabledSlots.length > 0 ? [] : (overview?.all_slots || DEFAULT_SLOTS);
            void updateSingleDayAvailability(dateStr, nextSlots);
          });
        }

        frag.appendChild(cell);
      }

      dom.calGrid.appendChild(frag);
    }

    function renderBookingsList() {
      if (!dom.bookingsList || !dom.listCount) return;
      const all = Array.isArray(overview?.bookings) ? overview.bookings : [];
      dom.listCount.textContent = `${all.length} ჯავშანი`;
      dom.bookingsList.innerHTML = '';

      if (!all.length) {
        const empty = document.createElement('div');
        empty.className = 'import-preview-empty';
        empty.textContent = 'ჯავშნები ჯერ არ ფიქსირდება.';
        dom.bookingsList.appendChild(empty);
        return;
      }

      const frag = document.createDocumentFragment();
      all.forEach((b) => {
        const row = document.createElement('div');
        row.className = `admin-cb-booking-row is-${b.status || 'active'}`;

        const left = document.createElement('div');
        left.className = 'admin-cb-booking-row-left';

        const dt = document.createElement('span');
        dt.className = 'admin-cb-booking-dt';
        dt.textContent = `${b.booking_date_ka} · ${b.time_range || b.slot_time}`;

        const person = document.createElement('span');
        person.className = 'admin-cb-booking-person';
        person.textContent = b.user?.full_name || '—';

        const meta = document.createElement('span');
        meta.className = 'admin-cb-booking-meta';
        meta.textContent = `პ/ნ: ${b.user?.personal_id || '—'} · ტელ: ${b.user?.phone || '—'} · კატეგორია ${b.user?.category || '—'}`;

        left.appendChild(dt);
        left.appendChild(person);
        left.appendChild(meta);

        const rightWrap = document.createElement('div');
        rightWrap.className = 'admin-cb-booking-row-right';

        const badge = document.createElement('span');
        badge.className = `cert-booking-status-badge is-${b.status || 'active'}`;
        badge.textContent = b.status_label || 'აქტიური';

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'admin-cb-booking-delete';
        delBtn.title = 'სიიდან წაშლა';
        delBtn.setAttribute('aria-label', 'სიიდან წაშლა');
        delBtn.textContent = '×';
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void handleDismissBookingRowByAdmin(b);
        });

        rightWrap.appendChild(badge);
        rightWrap.appendChild(delBtn);

        row.appendChild(left);
        row.appendChild(rightWrap);

        row.addEventListener('click', () => {
          selectedDateStr = b.booking_date;
          inspectedBooking = b;
          const [by, bm] = b.booking_date.split('-').map(Number);
          currentYear = by;
          currentMonth = bm - 1;
          renderMonthsStrip();
          renderCalendar();
          renderSelectedDayPanel();
          dom.candidateCard?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
        });

        frag.appendChild(row);
      });
      dom.bookingsList.appendChild(frag);
    }

    function renderAll() {
      syncHeaderBadge();
      renderMonthsStrip();
      renderCalendar();
      renderSelectedDayPanel();
      renderBookingsList();
    }

    async function fetchOverview(syncTemplate = false) {
      try {
        const res = await fetch(`${ctx.API_BASE}/admin/cert-bookings/overview`, {
          headers: { ...ctx.getAdminHeaders(), ...ctx.getActorHeaders(), 'Cache-Control': 'no-cache' },
          credentials: 'include',
        });
        if (!res.ok) return;
        overview = await res.json();
        if (syncTemplate) {
          syncWeekdayCheckboxesFromTemplate();
        }
        if (!selectedDateStr && overview.today) {
          selectedDateStr = overview.today;
          const [ty, tm] = overview.today.split('-').map(Number);
          currentYear = ty;
          currentMonth = tm - 1;
        }
        if (inspectedBooking) {
          inspectedBooking = (overview.bookings || []).find((x) => x.id === inspectedBooking.id) || null;
        }
        renderAll();
      } catch {}
    }

    async function updateSingleDayAvailability(dateStr, slots) {
      if (isBusy) return;
      isBusy = true;
      try {
        const res = await fetch(`${ctx.API_BASE}/admin/cert-bookings/availability/${encodeURIComponent(dateStr)}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...ctx.getAdminHeaders(),
            ...ctx.getActorHeaders(),
          },
          body: JSON.stringify({ slots }),
          credentials: 'include',
        });
        if (!res.ok) {
          await ctx.handleAdminErrorResponse(res, 'დღის განრიგის განახლება ვერ მოხერხდა');
          return;
        }
        overview = await res.json();
        renderAll();
      } catch {
        ctx.showToast('ქსელური შეცდომა', 'error');
      } finally {
        isBusy = false;
      }
    }

    async function runBulkOperation(mode) {
      if (isBusy) return;
      const weekdays = getCheckedWeekdays();
      if ((mode === 'apply_year' || mode === 'apply_month') && !weekdays.length) {
        ctx.showToast('გთხოვთ მონიშნოთ მინიმუმ ერთი სამუშაო დღე', 'error');
        return;
      }
      isBusy = true;
      try {
        const res = await fetch(`${ctx.API_BASE}/admin/cert-bookings/availability/bulk`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...ctx.getAdminHeaders(),
            ...ctx.getActorHeaders(),
          },
          body: JSON.stringify({
            mode,
            weekdays,
            slots: overview?.all_slots || DEFAULT_SLOTS,
            year: currentYear,
            month: currentMonth + 1,
          }),
          credentials: 'include',
        });
        if (!res.ok) {
          await ctx.handleAdminErrorResponse(res, 'განრიგის გავრცელება ვერ მოხერხდა');
          return;
        }
        overview = await res.json();
        renderAll();
        const msgMap = {
          apply_year: '1-წლიანი სამუშაო განრიგი წარმატებით გავრცელდა (შაბათ-კვირის გარეშე)',
          apply_month: 'თვის სამუშაო განრიგი განახლდა',
          clear_month: 'თვის თავისუფალი დღეები გასუფთავდა',
        };
        ctx.showToast(msgMap[mode] || 'განრიგი განახლდა', 'success');
      } catch {
        ctx.showToast('ქსელური შეცდომა', 'error');
      } finally {
        isBusy = false;
      }
    }

    async function handleCancelBookingByAdmin() {
      if (!inspectedBooking || isBusy) return;
      const b = inspectedBooking;
      if (!confirm(`ნამდვილად გსურთ ${b.user?.full_name || 'კანდიდატის'} ჯავშნის (${b.booking_date_ka} ${b.slot_time}) გაუქმება?`)) {
        return;
      }
      isBusy = true;
      try {
        const res = await fetch(`${ctx.API_BASE}/admin/cert-bookings/${encodeURIComponent(b.id)}`, {
          method: 'DELETE',
          headers: { ...ctx.getAdminHeaders(), ...ctx.getActorHeaders() },
          credentials: 'include',
        });
        if (!res.ok) {
          await ctx.handleAdminErrorResponse(res, 'ჯავშნის გაუქმება ვერ მოხერხდა');
          return;
        }
        overview = await res.json();
        inspectedBooking = (overview.bookings || []).find((x) => x.id === b.id) || null;
        renderAll();
        ctx.showToast('ჯავშანი გაუქმდა', 'success');
      } catch {
        ctx.showToast('ქსელური შეცდომა', 'error');
      } finally {
        isBusy = false;
      }
    }

    async function handleDismissBookingRowByAdmin(b) {
      if (!b?.id || isBusy) return;
      if (b.status === 'active') {
        if (!confirm(`ნამდვილად გსურთ ${b.user?.full_name || 'კანდიდატის'} აქტიური ჯავშნის (${b.booking_date_ka} ${b.slot_time}) გაუქმება და სიიდან წაშლა?`)) {
          return;
        }
      }
      isBusy = true;
      try {
        const res = await fetch(`${ctx.API_BASE}/admin/cert-bookings/${encodeURIComponent(b.id)}?dismiss=true`, {
          method: 'DELETE',
          headers: { ...ctx.getAdminHeaders(), ...ctx.getActorHeaders() },
          credentials: 'include',
        });
        if (!res.ok) {
          await ctx.handleAdminErrorResponse(res, 'ჯავშნის წაშლა ვერ მოხერხდა');
          return;
        }
        overview = await res.json();
        if (inspectedBooking && inspectedBooking.id === b.id) {
          inspectedBooking = (overview.bookings || []).find((x) => x.id === b.id) || null;
        }
        renderAll();
        ctx.showToast(b.status === 'active' ? 'ჯავშანი გაუქმდა და წაიშალა სიიდან' : 'ჩანაწერი წაიშალა სიიდან', 'success');
      } catch {
        ctx.showToast('ქსელური შეცდომა', 'error');
      } finally {
        isBusy = false;
      }
    }

    function openAdminBookingsModal() {
      if (!dom.overlay) return;
      ctx.openOverlay(dom.overlay);
      void fetchOverview(true);
    }

    function closeAdminBookingsModal() {
      if (!dom.overlay) return;
      ctx.closeOverlay(dom.overlay);
    }

    ctx.on(dom.headerBtn, 'click', openAdminBookingsModal);
    ctx.on(dom.drawerBtn, 'click', () => {
      document.body.classList.remove('menu-open');
      openAdminBookingsModal();
    });
    ctx.on(dom.closeBtn, 'click', closeAdminBookingsModal);
    ctx.on(dom.refreshBtn, 'click', () => void fetchOverview(false));
    ctx.on(dom.overlay, 'click', (e) => {
      if (e.target === dom.overlay) closeAdminBookingsModal();
    });

    ctx.on(dom.applyYearBtn, 'click', () => void runBulkOperation('apply_year'));
    ctx.on(dom.applyMonthBtn, 'click', () => void runBulkOperation('apply_month'));
    ctx.on(dom.clearMonthBtn, 'click', () => void runBulkOperation('clear_month'));

    ctx.on(dom.prevMonthBtn, 'click', () => {
      currentMonth -= 1;
      if (currentMonth < 0) {
        currentMonth = 11;
        currentYear -= 1;
      }
      renderMonthsStrip();
      renderCalendar();
    });
    ctx.on(dom.nextMonthBtn, 'click', () => {
      currentMonth += 1;
      if (currentMonth > 11) {
        currentMonth = 0;
        currentYear += 1;
      }
      renderMonthsStrip();
      renderCalendar();
    });

    ctx.on(dom.enableDayBtn, 'click', () => {
      if (!selectedDateStr) return;
      void updateSingleDayAvailability(selectedDateStr, overview?.all_slots || DEFAULT_SLOTS);
    });
    ctx.on(dom.disableDayBtn, 'click', () => {
      if (!selectedDateStr) return;
      void updateSingleDayAvailability(selectedDateStr, []);
    });
    ctx.on(dom.cancelBookingBtn, 'click', handleCancelBookingByAdmin);
    window.addEventListener('admin:certificateUpdated', () => void fetchOverview(false));

    void fetchOverview(true);
  }
});



(function (global) {
  function createUsersModule(context = {}) {
    const {
      DOM,
      API_BASE,
      on,
      formatDateTime,
      escapeHtml,
      isFounderActor,
      getAdminHeaders,
      getActorHeaders,
      showToast = () => {},
      handleAdminErrorResponse = () => {},
      openOverlay = () => {},
      closeOverlay = () => {},
      examSchedules,
    } = context;
    const { onShowResults, onShowStatements, onShowCertificate, onShowMultiApartmentResults, onShowMultiFunctionalResults } = context;
    const navLinks = DOM.navLinks || [];
    const LIVE_REFRESH_MS = 5000;
    const PAGE_SIZE = 50;
    const SEARCH_DELAY_MS = 250;
    const EXAM_STAGES = [
      { key: 'theory', label: 'ეტაპი 1', title: 'ეტაპი 1 — თეორიული გამოცდა' },
      { key: 'project_stage_1', label: 'ეტაპი 2', title: 'ეტაპი 2 — მრავალბინიანი შენობის პროექტი' },
      { key: 'project_stage_2', label: 'ეტაპი 3', title: 'ეტაპი 3 — მრავალფუნქციური შენობის პროექტი' },
    ];
    const STAGE_STATUS_META = Object.freeze({
      available: { key: 'available', label: 'ჩართულია' },
      started: { key: 'started', label: 'მიმდინარეობს' },
      completed: { key: 'completed', label: 'დასრულებულია' },
      expired: { key: 'expired', label: 'ვადა ამოიწურა' },
      none: { key: 'none', label: 'გამორთულია' },
      permanent: { key: 'permanent', label: 'მუდმივია' },
      pending: { key: 'pending', label: 'ინახება…' },
    });
    const STAGE_CONTRACT_STATUSES = new Set(['none', 'available', 'started', 'completed', 'expired']);
    const STARTED_STAGE_REGRANT_WARNING = 'ეს ეტაპი უკვე მიმდინარეობს. ხელახლა დაშვება გამოიყენეთ მხოლოდ ახალი ცდის საჭიროებისას. არსებული შედეგები არ წაიშლება. გსურთ ხელახლა დაშვება?';

    let cachedItems = [];
    const cachedUsersById = new Map();
    const cardsById = new Map();
    let currentPage = 1;
    let displayedPage = 1;
    let totalUsers = 0;
    let paginatedList = false;
    let globalUnseenUsers = null;
    let globalPendingUsers = null;
    let globalPendingPassUsers = null;
    let globalPendingFailUsers = null;
    let globalExamCandidates = null;
    let globalCertCandidates = null;
    let searchTimer = null;
    let renderController = null;
    let renderInFlight = false;
    let liveRefreshQueued = false;
    let listIsStale = false;
    let editActiveUser = null;
    let editInitialValues = null;
    let editInitialCode = '';
    let editSubmitting = false;
    let liveRefreshTimer = null;
    let liveRefreshInFlight = false;
    let usersRenderVersion = 0;
    let statementsStateVersion = 0;
    let schedulesStateVersion = 0;
    let examPermissionsStateVersion = 0;
    const adminRoleSavingIds = new Set();
    const candidateSavingIds = new Set();
    const examStageSaves = new Map();

    const CANDIDATE_CATEGORIES = [
      { value: 'A', shortLabel: 'A', fullLabel: 'კატეგორია A' },
      { value: 'B', shortLabel: 'B', fullLabel: 'კატეგორია B' },
      { value: 'C', shortLabel: 'C', fullLabel: 'კატეგორია C' },
      { value: 'B_A', shortLabel: 'B/A', fullLabel: 'კატეგორია B ან A' },
      { value: 'C_A', shortLabel: 'C/A', fullLabel: 'კატეგორია C ან A' },
    ];

    function normalizeCandidateCategory(cat, fallback = 'A') {
      const raw = String(cat || '').trim().toUpperCase();
      return CANDIDATE_CATEGORIES.some((c) => c.value === raw) ? raw : fallback;
    }

    function syncCandidateControls(card, user) {
      if (!card || !user) return;
      const id = String(user.id);
      const isSaving = candidateSavingIds.has(id);
      const status = user.candidate_status === 'exam_candidate' || user.candidate_status === 'cert_candidate'
        ? user.candidate_status
        : '';
      const isCert = status === 'cert_candidate';
      const cat = normalizeCandidateCategory(user.candidate_category || user.requested_category, 'A');

      const chip = card.querySelector('.user-candidate-chip');
      if (chip) {
        chip.hidden = !status;
        chip.classList.toggle('is-exam-candidate', status === 'exam_candidate');
        chip.classList.toggle('is-cert-candidate', isCert);
        chip.title = isCert
          ? 'სერტიფიკატის კანდიდატი — მოხსენით მონიშვნა სტატუსის გასაუქმებლად'
          : 'გამოცდის კანდიდატი — მოხსენით მონიშვნა სტატუსის გასაუქმებლად';
      }
      const chk = card.querySelector('.chk-candidate-status');
      if (chk) {
        chk.checked = !!status;
        chk.disabled = isSaving;
      }
      const lbl = card.querySelector('.user-candidate-chip-label');
      if (lbl) {
        lbl.textContent = isCert ? 'სერტიფიკატის კანდ.' : 'გამოცდის კანდ.';
      }
      const sel = card.querySelector('.sel-candidate-category');
      if (sel) {
        sel.value = cat;
        sel.disabled = isSaving;
      }
      const manualStatusSel = card.querySelector('.sel-manual-candidate-status');
      if (manualStatusSel) {
        manualStatusSel.value = status;
        manualStatusSel.disabled = isSaving;
      }
      const manualCatSel = card.querySelector('.sel-manual-candidate-category');
      if (manualCatSel) {
        manualCatSel.value = cat;
        manualCatSel.disabled = isSaving || !status;
      }
    }

    function stageSaveKey(userId, stage) {
      return `${userId}:${stage}`;
    }

    function hasPendingStage(userId) {
      return EXAM_STAGES.some(({ key }) => examStageSaves.has(stageSaveKey(userId, key)));
    }

    function hasPermanentExamAccess(user) {
      return !!(user?.is_admin || user?.is_founder);
    }

    function hasStageState(user, stage) {
      const permission = user?.exam_stage_permissions?.[stage];
      return typeof permission?.granted === 'boolean'
        && STAGE_CONTRACT_STATUSES.has(permission?.status);
    }

    function stageGranted(user, stage) {
      if (hasPermanentExamAccess(user)) return true;
      if (hasStageState(user, stage)) {
        const permission = user.exam_stage_permissions[stage];
        return permission.granted === true && permission.status === 'available';
      }
      // Missing entries in a new-format response must not inherit the legacy
      // all-exam flag. An older backend has only one selected stage; an older
      // flag without a stage represents the historical theory permission.
      if (user?.exam_stage_permissions != null) return false;
      return !!user?.exam_permission && stage === (user?.exam_stage || 'theory');
    }

    function stageStatusView(user, stage, pending = null) {
      if (hasPermanentExamAccess(user)) return STAGE_STATUS_META.permanent;
      if (pending) return STAGE_STATUS_META.pending;
      if (hasStageState(user, stage)) {
        return STAGE_STATUS_META[user.exam_stage_permissions[stage].status] || STAGE_STATUS_META.none;
      }
      return stageGranted(user, stage) ? STAGE_STATUS_META.available : STAGE_STATUS_META.none;
    }

    function syncExamControls(card, user) {
      if (!card || !user) return;
      const id = String(user.id);
      EXAM_STAGES.forEach(({ key }) => {
        const input = card.querySelector(`.chk-exam[data-exam-stage="${key}"]`);
        if (!input) return;
        const pending = examStageSaves.get(stageSaveKey(id, key));
        input.checked = hasPermanentExamAccess(user) ? true : pending ? pending.desired : stageGranted(user, key);
        input.disabled = listIsStale || hasPermanentExamAccess(user) || adminRoleSavingIds.has(id)
          || !!pending || !hasStageState(user, key);
        input.setAttribute('aria-busy', pending ? 'true' : 'false');
        const statusNode = card.querySelector(`.user-exam-stage-status[data-exam-stage-status="${key}"]`);
        if (statusNode) {
          const status = stageStatusView(user, key, pending);
          statusNode.textContent = status.label;
          statusNode.setAttribute('data-status', status.key);
        }
      });
      const admin = card.querySelector('.chk-admin');
      if (admin) {
        if (!adminRoleSavingIds.has(id)) admin.checked = hasPermanentExamAccess(user);
        admin.disabled = !!user.is_founder || !isFounderActor() || adminRoleSavingIds.has(id) || hasPendingStage(id);
      }
      syncCandidateControls(card, user);
    }

    function mergeUserState(existing, incoming) {
      const next = { ...incoming };
      if (incoming.exam_stage_permissions) {
        next.exam_stage_permissions = { ...existing.exam_stage_permissions, ...incoming.exam_stage_permissions };
        EXAM_STAGES.forEach(({ key }) => {
          if (examStageSaves.has(stageSaveKey(existing.id, key))) {
            next.exam_stage_permissions[key] = existing.exam_stage_permissions?.[key];
          }
        });
      }
      return Object.assign(existing, next);
    }

    const editOverlay = DOM.userEditOverlay;
    const editForm = DOM.userEditForm;
    const editTitle = DOM.userEditTitle;
    const editCloseBtn = DOM.userEditClose;
    const editCancelBtn = DOM.userEditCancel;
    const editSaveBtn = DOM.userEditSave;
    const editCodeField = DOM.userEditCode;

    const editFields = {
      personal_id: DOM.userEditPersonalId,
      first_name: DOM.userEditFirstName,
      last_name: DOM.userEditLastName,
      phone: DOM.userEditPhone,
      email: DOM.userEditEmail,
    };

    function selectedStatementsDate() {
      return DOM.statementsDate?.value || '';
    }

    function syncStatementFilterControls() {
      if (DOM.statementsDate) DOM.statementsDate.disabled = false;
      if (DOM.clearStatementsDate) {
        DOM.clearStatementsDate.disabled = !selectedStatementsDate();
      }
      syncResetFiltersButton();
    }

    function hasExamScheduleFilter() {
      return !!(
        DOM.examScheduleDate?.value
        || DOM.filterExamMorning?.checked
        || DOM.filterExamEvening?.checked
        || DOM.filterCertificateHandover?.checked
      );
    }

    function syncExamScheduleFilterControls() {
      if (DOM.clearExamScheduleDate) {
        DOM.clearExamScheduleDate.disabled = !DOM.examScheduleDate?.value;
      }
      syncResetFiltersButton();
    }

    function hasExamResultFilter() {
      return !!(
        DOM.examResultDate?.value
        || DOM.filterExamPassed?.checked
        || DOM.filterExamFailed?.checked
        || DOM.filterPendingPassLetter?.checked
        || DOM.filterPendingFailLetter?.checked
      );
    }

    function syncExamResultFilterControls() {
      if (DOM.clearExamResultDate) {
        DOM.clearExamResultDate.disabled = !DOM.examResultDate?.value;
      }
      syncResetFiltersButton();
    }

    function hasAnyActiveUsersFilter() {
      return !!(
        String(DOM.usersSearch?.value || '').trim()
        || (DOM.usersSort?.value && DOM.usersSort.value !== 'date_desc')
        || DOM.onlyAdmins?.checked
        || DOM.filterArchitects?.checked
        || DOM.filterExperts?.checked
        || DOM.filterMunicipal?.checked
        || DOM.filterCertified?.checked
        || DOM.filterSuspendedExpired?.checked
        || DOM.filterExamCandidates?.checked
        || DOM.filterCertCandidates?.checked
        || DOM.filterStatements?.checked
        || DOM.filterPendingStatements?.checked
        || selectedStatementsDate()
        || hasExamScheduleFilter()
        || hasExamResultFilter()
      );
    }

    function syncResetFiltersButton() {
      if (!DOM.resetUsersFilters) return;
      DOM.resetUsersFilters.hidden = !hasAnyActiveUsersFilter();
    }

    function resetAllUsersFilters() {
      if (DOM.usersSearch) DOM.usersSearch.value = '';
      if (DOM.usersSort) DOM.usersSort.value = 'date_desc';
      if (DOM.onlyAdmins) DOM.onlyAdmins.checked = false;
      if (DOM.filterArchitects) DOM.filterArchitects.checked = false;
      if (DOM.filterExperts) DOM.filterExperts.checked = false;
      if (DOM.filterMunicipal) DOM.filterMunicipal.checked = false;
      if (DOM.filterCertified) DOM.filterCertified.checked = false;
      if (DOM.filterSuspendedExpired) DOM.filterSuspendedExpired.checked = false;
      if (DOM.filterExamCandidates) DOM.filterExamCandidates.checked = false;
      if (DOM.filterCertCandidates) DOM.filterCertCandidates.checked = false;
      if (DOM.filterStatements) DOM.filterStatements.checked = false;
      if (DOM.filterPendingStatements) DOM.filterPendingStatements.checked = false;
      if (DOM.statementsDate) DOM.statementsDate.value = '';
      if (DOM.filterExamMorning) DOM.filterExamMorning.checked = false;
      if (DOM.filterExamEvening) DOM.filterExamEvening.checked = false;
      if (DOM.filterCertificateHandover) DOM.filterCertificateHandover.checked = false;
      if (DOM.examScheduleDate) DOM.examScheduleDate.value = '';
      if (DOM.filterExamPassed) DOM.filterExamPassed.checked = false;
      if (DOM.filterExamFailed) DOM.filterExamFailed.checked = false;
      if (DOM.filterPendingPassLetter) DOM.filterPendingPassLetter.checked = false;
      if (DOM.filterPendingFailLetter) DOM.filterPendingFailLetter.checked = false;
      if (DOM.examResultDate) DOM.examResultDate.value = '';
      syncStatementFilterControls();
      syncExamScheduleFilterControls();
      syncExamResultFilterControls();
      syncResetFiltersButton();
      return render();
    }

    function updateStatementFilterBadges(unseenUsersCount, pendingUsersCount) {
      if (DOM.filterStatementsBadge) {
        const n = Math.max(0, Number(unseenUsersCount) || 0);
        DOM.filterStatementsBadge.textContent = String(n);
        DOM.filterStatementsBadge.hidden = n === 0;
      }
      if (DOM.filterPendingStatementsBadge) {
        const m = Math.max(0, Number(pendingUsersCount) || 0);
        DOM.filterPendingStatementsBadge.textContent = String(m);
        DOM.filterPendingStatementsBadge.hidden = m === 0;
      }
    }

    function updateExamOutcomeFilterBadges(pendingPassCount, pendingFailCount) {
      const passN = Math.max(0, Number(pendingPassCount) || 0);
      const failN = Math.max(0, Number(pendingFailCount) || 0);
      if (DOM.filterPendingPassLetterBadge) {
        DOM.filterPendingPassLetterBadge.textContent = String(passN);
        DOM.filterPendingPassLetterBadge.hidden = passN === 0;
      }
      if (DOM.filterPendingPassLetterChip) {
        DOM.filterPendingPassLetterChip.classList.toggle('has-pending-pass-alert', passN > 0);
      }
      if (DOM.filterPendingFailLetterBadge) {
        DOM.filterPendingFailLetterBadge.textContent = String(failN);
        DOM.filterPendingFailLetterBadge.hidden = failN === 0;
      }
      if (DOM.filterPendingFailLetterChip) {
        DOM.filterPendingFailLetterChip.classList.toggle('has-pending-fail-alert', failN > 0);
      }
    }

    function updateCandidateFilterBadges(examCandCount, certCandCount) {
      const examN = Math.max(0, Number(examCandCount) || 0);
      const certN = Math.max(0, Number(certCandCount) || 0);
      if (DOM.filterExamCandidatesBadge) {
        DOM.filterExamCandidatesBadge.textContent = String(examN);
        DOM.filterExamCandidatesBadge.hidden = examN === 0;
      }
      if (DOM.filterCertCandidatesBadge) {
        DOM.filterCertCandidatesBadge.textContent = String(certN);
        DOM.filterCertCandidatesBadge.hidden = certN === 0;
      }
    }

    const pagination = {
      container: DOM.usersPagination || document.getElementById?.('usersPagination'),
      previous: DOM.usersPagePrevious || document.getElementById?.('usersPagePrevious'),
      next: DOM.usersPageNext || document.getElementById?.('usersPageNext'),
      status: DOM.usersPageStatus || document.getElementById?.('usersPageStatus'),
    };
    const listNotice = {
      container: DOM.usersListNotice || document.getElementById?.('usersListNotice'),
      text: DOM.usersListNoticeText || document.getElementById?.('usersListNoticeText'),
      retry: DOM.usersListRetry || document.getElementById?.('usersListRetry'),
    };

    function setListNotice(message = '', retry = false) {
      if (listNotice.container) listNotice.container.hidden = !message;
      if (listNotice.text) listNotice.text.textContent = message;
      if (listNotice.retry) listNotice.retry.hidden = !retry;
    }

    function setListStale(stale) {
      listIsStale = stale;
      cardsById.forEach((card, id) => {
        syncExamControls(card, cachedUsersById.get(id));
      });
    }

    function wouldRemoveUnfinishedEditor(items) {
      const nextIds = new Set(items.map((user) => String(user.id)));
      return [...cardsById].some(([id, card]) => {
        if (nextIds.has(id)) return false;
        if (adminRoleSavingIds.has(id) || candidateSavingIds.has(id) || hasPendingStage(id)) return true;
        if (!card.classList.contains('open')) return false;
        const panel = card.querySelector('.user-exam-schedules');
        const date = card.querySelector('.exam-schedule-date');
        const morning = card.querySelector('.exam-schedule-morning');
        const evening = card.querySelector('.exam-schedule-evening');
        return panel?.getAttribute?.('aria-busy') === 'true' || panel?.dataset?.dirty === 'true'
          || (!!date?.value && !morning?.checked && !evening?.checked);
      });
    }

    function deferEditorRemoval(items) {
      if (!wouldRemoveUnfinishedEditor(items)) return false;
      items.forEach((user) => {
        // Do not acknowledge a changed display revision before its name/contact
        // fields have actually been rendered; a later poll must still fetch it.
        const state = Object.fromEntries(['id', 'exam_permission', 'exam_stage_permissions', 'has_unseen_statements',
          'unseen_statement_count', 'has_pending_statements', 'pending_statement_count',
          'candidate_status', 'candidate_category', 'requested_category']
          .map((key) => [key, user[key]]));
        applyLiveUserState(state);
      });
      setListStale(true);
      setListNotice('სია შეიცვალა. შეყვანილი მონაცემების შესანარჩუნებლად განახლება გადაიდო — დაასრულეთ მოქმედება და დახურეთ გახსნილი ბარათი.', true);
      return true;
    }

    async function fetchUsers({ live = false, signal } = {}) {
      if (!DOM.usersGrid) return { items: [] };
      const params = new URLSearchParams();
      const search = String(DOM.usersSearch?.value || '').trim();
      if (search) params.set('search', search);
      if (DOM.onlyAdmins?.checked) params.set('only_admins', 'true');
      params.set('paginated', 'true');
      params.set('page', String(currentPage));
      params.set('size', String(PAGE_SIZE));
      if (live) params.set('live', 'true');
      if (DOM.filterStatements?.checked) params.set('new_statements', 'true');
      if (DOM.filterPendingStatements?.checked) params.set('pending_statements', 'true');
      const qualification = DOM.filterSuspendedExpired?.checked ? 'suspended_expired'
        : DOM.filterCertified?.checked ? 'certified'
          : DOM.filterArchitects?.checked ? 'architect'
            : DOM.filterExperts?.checked ? 'expert'
              : DOM.filterMunicipal?.checked ? 'municipal'
                : DOM.filterExamCandidates?.checked ? 'exam_candidate'
                  : DOM.filterCertCandidates?.checked ? 'cert_candidate' : '';
      if (qualification) params.set('qualification', qualification);
      const statementDate = selectedStatementsDate();
      if (statementDate) params.set('statement_date', statementDate);
      if (DOM.filterExamMorning?.checked) params.set('exam_morning', 'true');
      if (DOM.filterExamEvening?.checked) params.set('exam_evening', 'true');
      if (DOM.filterCertificateHandover?.checked) params.set('certificate_handover', 'true');
      if (DOM.examScheduleDate?.value) params.set('exam_date', DOM.examScheduleDate.value);
      if (DOM.filterExamPassed?.checked) params.set('exam_passed', 'true');
      if (DOM.filterExamFailed?.checked) params.set('exam_failed', 'true');
      if (DOM.filterPendingPassLetter?.checked) params.set('pending_pass_letter', 'true');
      if (DOM.filterPendingFailLetter?.checked) params.set('pending_fail_letter', 'true');
      if (DOM.examResultDate?.value) params.set('exam_result_date', DOM.examResultDate.value);
      params.set('sort', DOM.usersSort?.value || 'date_desc');
      const response = await fetch(`${API_BASE}/admin/users?${params.toString()}`, {
        headers: { ...getAdminHeaders(), ...getActorHeaders() },
        signal,
      });
      if (!response.ok) throw new Error('users failed');
      return await response.json();
    }

    function isRegistrationsVisible() {
      const section = DOM.sections?.registrations;
      if (!section) return true;
      return section.style.display !== 'none';
    }

    function findUserCard(userId) {
      return cardsById.get(String(userId)) || null;
    }

    function mergeCachedUser(user) {
      if (!user || user.id == null) return;
      const existing = cachedUsersById.get(String(userIdOf(user)));
      // Card callbacks retain the same object and always see the newest data.
      if (existing) mergeUserState(existing, user);
    }

    function userIdOf(user) {
      return user?.id;
    }

    function applyLiveUserState(user) {
      if (!user || user.id == null) return;
      mergeCachedUser(user);

      const card = findUserCard(user.id);
      if (!card) return;

      syncExamControls(card, cachedUsersById.get(String(user.id)) || user);

      setCardUnseenState(card, user.has_unseen_statements, user.has_pending_statements);
      card.dataset.unseenCount = String(user.unseen_statement_count || 0);
      if (user.pending_statement_count != null) {
        card.dataset.pendingCount = String(user.pending_statement_count || 0);
      }
    }

    function updatePagination(data) {
      paginatedList = data?.paginated === true;
      if (paginatedList) {
        currentPage = data.page;
        displayedPage = data.page;
        totalUsers = data.total;
        globalUnseenUsers = data.global_unseen_users;
        if (data.global_pending_users != null) {
          globalPendingUsers = data.global_pending_users;
        }
        if (data.global_pending_pass_users != null) {
          globalPendingPassUsers = data.global_pending_pass_users;
        }
        if (data.global_pending_fail_users != null) {
          globalPendingFailUsers = data.global_pending_fail_users;
        }
        if (data.global_exam_candidates != null) {
          globalExamCandidates = data.global_exam_candidates;
        }
        if (data.global_cert_candidates != null) {
          globalCertCandidates = data.global_cert_candidates;
        }
        updateNavBadge(globalUnseenUsers > 0);
        updateStatementFilterBadges(globalUnseenUsers, globalPendingUsers);
        updateExamOutcomeFilterBadges(globalPendingPassUsers, globalPendingFailUsers);
        updateCandidateFilterBadges(globalExamCandidates, globalCertCandidates);
      }
      const pages = Math.max(1, Math.ceil(totalUsers / PAGE_SIZE));
      if (pagination.container) pagination.container.hidden = !paginatedList;
      if (pagination.previous) pagination.previous.disabled = currentPage <= 1 || renderInFlight;
      if (pagination.next) pagination.next.disabled = currentPage >= pages || renderInFlight;
      if (pagination.status) pagination.status.textContent = totalUsers
        ? `${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(currentPage * PAGE_SIZE, totalUsers)} / ${totalUsers} პირი`
        : 'პირები ვერ მოიძებნა';
    }

    async function refreshLiveUserStates(options = {}) {
      const force = !!options.force;
      if (!DOM.usersGrid) return;
      if (!force && document.hidden) return;
      if (!force && !isRegistrationsVisible()) return;
      if (renderInFlight || searchTimer) return;
      if (liveRefreshInFlight) {
        if (force) liveRefreshQueued = true;
        return;
      }

      liveRefreshInFlight = true;
      const requestVersion = usersRenderVersion;
      const statementVersion = statementsStateVersion;
      const scheduleVersion = schedulesStateVersion;
      const permissionVersion = examPermissionsStateVersion;
      try {
        const data = await fetchUsers({ live: true });
        if (requestVersion !== usersRenderVersion || statementVersion !== statementsStateVersion
          || scheduleVersion !== schedulesStateVersion || permissionVersion !== examPermissionsStateVersion) return;
        const items = Array.isArray(data?.items) ? data.items : [];
        if (data.paginated) {
          const membershipChanged = data.page !== currentPage || items.length !== cachedItems.length
            || items.some((user, index) => String(user.id) !== String(cachedItems[index]?.id)
              || user.display_revision !== cachedItems[index]?.display_revision);
          if (membershipChanged) {
            if (deferEditorRemoval(items)) return;
            await render({ preserveExisting: true, keepPage: true });
          } else {
            items.forEach(applyLiveUserState);
            updatePagination(data);
            setListStale(false);
            setListNotice();
          }
          return;
        }
        const dateMembershipChanged = (selectedStatementsDate() || hasExamScheduleFilter() || hasExamResultFilter()) && (
          items.length !== cachedItems.length ||
          items.some((user, index) => String(user.id) !== String(cachedItems[index]?.id))
        );
        if (dateMembershipChanged) {
          drawUsers(items, { preserveExisting: true });
        } else {
          items.forEach(applyLiveUserState);
        }
        updateNavBadge(cachedItems.some((user) => user.has_unseen_statements));
      } catch {
        // Live refresh is best-effort; manual refresh/render still shows errors.
      } finally {
        liveRefreshInFlight = false;
        if (liveRefreshQueued) {
          liveRefreshQueued = false;
          void refreshLiveUserStates({ force: true });
        }
      }
    }

    async function refreshAfterScheduleChange() {
      schedulesStateVersion += 1;
      return render({ preserveExisting: true, keepPage: true });
    }

    function startLiveRefresh() {
      if (liveRefreshTimer) return;
      liveRefreshTimer = setInterval(() => refreshLiveUserStates(), LIVE_REFRESH_MS);
      on(window, 'focus', () => refreshLiveUserStates({ force: true }));
      on(document, 'visibilitychange', () => {
        if (!document.hidden) refreshLiveUserStates({ force: true });
      });
      on(window, 'admin:examResultsChanged', () => {
        schedulesStateVersion += 1;
        void render({ preserveExisting: true, keepPage: true });
      });
    }

    function examOutcomeBadgeMeta(examOutcome) {
      if (!examOutcome || !examOutcome.unacknowledged) return null;
      if (examOutcome.outcome === 'pass_bc') {
        return {
          cls: 'is-pass-bc',
          label: '✓ ჩააბარა (B/C)',
          title: 'გამოცდა ჩაბარებულია (B/C კატეგორია) — სერტიფიკატის გადაცემის შეტყობინება გასაგზავნია',
        };
      }
      if (examOutcome.outcome === 'pass_a') {
        return {
          cls: 'is-pass-a',
          label: '✓ ჩააბარა (A)',
          title: 'გამოცდა ჩაბარებულია (A კატეგორია) — სერტიფიკატის გადაცემის შეტყობინება გასაგზავნია',
        };
      }
      if (examOutcome.outcome === 'fail') {
        return {
          cls: 'is-fail',
          label: '✕ ჩაიჭრა',
          title: 'გამოცდა ვერ ჩააბარა — ჩაჭრის შეტყობინება გასაგზავნია',
        };
      }
      return null;
    }

    function syncExamOutcomeUI(card, user) {
      if (!card || !user) return;
      const meta = examOutcomeBadgeMeta(user.exam_outcome);
      const badge = card.querySelector('.user-exam-outcome-badge');
      if (badge) {
        badge.classList.remove('is-pass-bc', 'is-pass-a', 'is-fail');
        if (meta) {
          badge.textContent = meta.label;
          badge.title = meta.title;
          badge.classList.add(meta.cls);
          badge.hidden = false;
        } else {
          badge.textContent = '';
          badge.removeAttribute('title');
          badge.hidden = true;
        }
      }
      const isPendingPass = Boolean(
        user.exam_outcome?.unacknowledged &&
          (user.exam_outcome.outcome === 'pass_bc' || user.exam_outcome.outcome === 'pass_a')
      );
      const isPendingFail = Boolean(
        user.exam_outcome?.unacknowledged && user.exam_outcome.outcome === 'fail'
      );
      card.querySelector('.btn-certificate-handover')?.classList.toggle('has-pending-exam-pass', isPendingPass);
      card.querySelector('.btn-exam-fail-letter')?.classList.toggle('has-pending-exam-fail', isPendingFail);
    }

    function certificateDotMeta(certificateData) {
      const certificate = certificateData || {};
      const certLevel = certificate.level || '';
      const certStatus = certificate.status || '';
      if (!certLevel && !certStatus) return null;
      if (certStatus === 'suspended' || certStatus === 'expired') {
        return { cls: 'is-suspended', title: 'შეჩერებული / ვადაგასული სერტიფიკატი' };
      }
      if (certLevel === 'architect' || certLevel === 'architect_expert') {
        return { cls: 'is-architect', title: 'შენობა-ნაგებობის არქიტექტორი' };
      }
      if (certLevel === 'expert') {
        return { cls: 'is-expert', title: 'არქიტექტურული პროექტის ექსპერტი' };
      }
      if (certLevel === 'municipal') {
        return { cls: 'is-municipal', title: 'მუნიციპალიტეტის სპეციალისტი' };
      }
      return null;
    }

    function userRowHTML(user) {
      const fullNameRaw = `${(user.first_name || '').trim()} ${(user.last_name || '').trim()}`.trim() || '(უსახელო)';
      const founderRow = !!user.is_founder;
      const canEdit = isFounderActor();
      const checked = founderRow ? 'checked' : (user.is_admin ? 'checked' : '');
      const disabled = founderRow ? 'disabled' : (isFounderActor() ? '' : 'disabled');
      const safeId = escapeHtml(user.id);
      const examControls = EXAM_STAGES.map(({ key, label, title }) => {
        const pending = examStageSaves.get(stageSaveKey(user.id, key));
        const granted = hasPermanentExamAccess(user) || (pending ? pending.desired : stageGranted(user, key));
        const locked = listIsStale || hasPermanentExamAccess(user) || adminRoleSavingIds.has(String(user.id))
          || !!pending || !hasStageState(user, key);
        const status = stageStatusView(user, key, pending);
        const statusId = `exam-stage-status-${safeId}-${key}`;
        return `<label class="user-checkbox-label user-exam-stage-label" title="${title}">
          <input type="checkbox" class="chk-exam" data-exam-stage="${key}" aria-label="${title}" aria-describedby="${statusId}" ${granted ? 'checked' : ''} ${locked ? 'disabled' : ''} />
          <span class="user-exam-stage-copy">
            <span class="user-exam-stage-name">${label}</span>
            <span class="user-exam-stage-status" id="${statusId}" data-exam-stage-status="${key}" data-status="${status.key}" role="status" aria-live="polite">${status.label}</span>
          </span>
        </label>`;
      }).join('');
      const safeFullName = escapeHtml(fullNameRaw);
      const safePersonalId = escapeHtml(user.personal_id || '');
      const safePhone = escapeHtml(user.phone || '');
      const safeCode = escapeHtml(user.code || '');
      const safeEmail = escapeHtml(user.email || '');
      const safeRegistered = escapeHtml(formatDateTime(user.created_at));
      const dotMeta = certificateDotMeta(user.certificate || user.certificate_info);
      const outcomeMeta = examOutcomeBadgeMeta(user.exam_outcome);
      const candStatus = user.candidate_status === 'exam_candidate' || user.candidate_status === 'cert_candidate'
        ? user.candidate_status
        : '';
      const isCertCand = candStatus === 'cert_candidate';
      const candCategory = normalizeCandidateCategory(user.candidate_category || user.requested_category, 'A');
      const candChipOptions = CANDIDATE_CATEGORIES.map(({ value, shortLabel }) => (
        `<option value="${value}"${candCategory === value ? ' selected' : ''}>${shortLabel}</option>`
      )).join('');
      const candFullOptions = CANDIDATE_CATEGORIES.map(({ value, fullLabel }) => (
        `<option value="${value}"${candCategory === value ? ' selected' : ''}>${fullLabel}</option>`
      )).join('');
      const candChipClass = isCertCand ? 'is-cert-candidate' : (candStatus === 'exam_candidate' ? 'is-exam-candidate' : '');
      const candChipTitle = isCertCand
        ? 'სერტიფიკატის კანდიდატი — მოხსენით მონიშვნა სტატუსის გასაუქმებლად'
        : 'გამოცდის კანდიდატი — მოხსენით მონიშვნა სტატუსის გასაუქმებლად';
      
      return `
        <div class="block-tile block-card${user.has_unseen_statements ? ' has-new-statements' : (user.has_pending_statements ? ' has-pending-statements' : '')}" data-id="${safeId}">
          <div class="block-head user-block-head">
            <div class="user-name"><span class="user-cert-dot${dotMeta ? ` ${dotMeta.cls}` : ''}"${dotMeta ? ` title="${dotMeta.title}"` : ' hidden'}></span><span class="user-name-text">${safeFullName}</span><span class="user-exam-outcome-badge${outcomeMeta ? ` ${outcomeMeta.cls}` : ''}"${outcomeMeta ? ` title="${escapeHtml(outcomeMeta.title)}"` : ' hidden'}>${outcomeMeta ? escapeHtml(outcomeMeta.label) : ''}</span></div>
            <div class="user-controls">
              <div class="user-candidate-chip${candChipClass ? ` ${candChipClass}` : ''}" title="${candChipTitle}"${candStatus ? '' : ' hidden'}>
                <label class="user-candidate-chip-check">
                  <input type="checkbox" class="chk-candidate-status" ${candStatus ? 'checked' : ''} aria-label="კანდიდატის სტატუსი" />
                  <span class="user-candidate-chip-label">${isCertCand ? 'სერტიფიკატის კანდ.' : 'გამოცდის კანდ.'}</span>
                </label>
                <select class="sel-candidate-category" aria-label="კანდიდატის კატეგორია" title="არჩეული კატეგორიის შეცვლა">${candChipOptions}</select>
              </div>
              <label class="user-checkbox-label user-admin-check-label" title="${founderRow ? 'მუდმივი ადმინი' : 'ადმინი'}">
                <input type="checkbox" class="chk-admin" ${checked} ${disabled} />
                <span>ადმინი</span>
              </label>
              <div class="user-exam-stage-controls" role="group" aria-label="გამოცდის ეტაპებზე დაშვება">${examControls}</div>
            </div>
            <div class="user-actions">
              <button class="head-toggle" type="button" aria-expanded="false" title="ბარათის გახსნა / დახურვა">▾</button>
              <button class="head-delete" type="button" aria-label="წაშლა" title="წაშლა" ${founderRow || !isFounderActor() ? 'disabled' : ''} style="${founderRow ? 'display:none;' : ''}">×</button>
            </div>
          </div>
          <div class="block-questions" aria-hidden="true">
            <div class="questions-list">
              <div class="question-card user-detail-card open">
                <div class="user-details-grid">
                  <div class="user-details-column user-info-column">
                    <div class="user-section-title">პირადი მონაცემები</div>
                    <div class="user-info-grid">
                      <div class="user-info-item">
                        <span class="user-info-label">პირადი №:</span>
                        <strong class="user-info-value" data-user-field="personal_id">${safePersonalId || '—'}</strong>
                      </div>
                      <div class="user-info-item">
                        <span class="user-info-label">ტელეფონი:</span>
                        <strong class="user-info-value" data-user-field="phone">${safePhone || '—'}</strong>
                      </div>
                      <div class="user-info-item">
                        <span class="user-info-label">კოდი:</span>
                        <strong class="user-info-value is-code" data-user-field="code">${safeCode || '—'}</strong>
                      </div>
                      <div class="user-info-item">
                        <span class="user-info-label">მაილი:</span>
                        <strong class="user-info-value is-email" data-user-field="email" title="${safeEmail}">${safeEmail || '—'}</strong>
                      </div>
                      <div class="user-info-item">
                        <span class="user-info-label">რეგისტრაცია:</span>
                        <strong class="user-info-value" data-user-field="created_at">${safeRegistered || '—'}</strong>
                      </div>
                      <div class="user-info-item user-photo-item">
                        <span class="user-info-label">ფოტო:</span>
                        <div class="user-photo-controls">
                          <label class="photo-upload-btn" title="ფოტოს ატვირთვა">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                            <input type="file" class="photo-upload-input" accept=".jpg,.jpeg,.png,.webp" style="display:none;" />
                          </label>
                          <button type="button" class="photo-delete-btn" title="ფოტოს წაშლა" style="display:${user.photo_filename ? '' : 'none'};">×</button>
                          <span class="photo-filename" title="${user.photo_filename ? escapeHtml(user.photo_filename) : ''}">${user.photo_filename ? escapeHtml(user.photo_filename) : '—'}</span>
                        </div>
                      </div>
                      <div class="user-info-item user-candidate-info-item">
                        <span class="user-info-label">კანდიდატი:</span>
                        <div class="user-candidate-manual-controls">
                          <select class="sel-manual-candidate-status" aria-label="კანდიდატის სტატუსი">
                            <option value=""${!candStatus ? ' selected' : ''}>— არ არის —</option>
                            <option value="exam_candidate"${candStatus === 'exam_candidate' ? ' selected' : ''}>გამოცდის კანდ.</option>
                            <option value="cert_candidate"${candStatus === 'cert_candidate' ? ' selected' : ''}>სერტიფიკატის კანდ.</option>
                          </select>
                          <select class="sel-manual-candidate-category" aria-label="კანდიდატის კატეგორია"${!candStatus ? ' disabled' : ''}>${candFullOptions}</select>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="user-details-column user-actions-column">
                    <div class="user-section-title">ქმედებები</div>
                    <div class="user-action-buttons">
                      <button class="user-action-btn btn-user-announcements${user.has_unseen_statements ? ' has-new-statements' : (user.has_pending_statements ? ' has-pending-statements' : '')}" type="button">
                        <span>განცხადებები / წერილები</span>
                        <span class="btn-scheduled-exams-badge" hidden>0</span>
                      </button>
                      <button class="user-action-btn btn-user-results" type="button">გამოცდის შედეგები</button>
                      <button class="user-action-btn btn-user-certificate" type="button">სერტიფიკატი</button>
                      <button class="user-action-btn btn-user-multi-apartment" type="button">მრავალბინიანის შეფ: შედეგები</button>
                      <button class="user-action-btn btn-user-edit"${canEdit ? '' : ' disabled'} type="button">რედაქტირება</button>
                      <button class="user-action-btn btn-user-multi-functional" type="button">მრავალფუნქციურის შეფ: შედეგები</button>
                    </div>
                  </div>
                </div>
                <section class="user-exam-schedules" aria-label="გამოცდის დაგეგმვა"></section>
              </div>
            </div>
          </div>
        </div>`;
    }

    async function saveUserCandidateStatus(userId, nextStatus, nextCategory) {
      const id = String(userId);
      if (candidateSavingIds.has(id)) return false;
      const current = cachedUsersById.get(id);
      const card = findUserCard(id);
      candidateSavingIds.add(id);
      schedulesStateVersion += 1;
      if (card && current) syncCandidateControls(card, current);
      try {
        const response = await fetch(`${API_BASE}/admin/users/${id}/candidate-status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...getAdminHeaders(), ...getActorHeaders() },
          body: JSON.stringify({
            candidate_status: nextStatus || null,
            candidate_category: nextStatus ? normalizeCandidateCategory(nextCategory, 'A') : null,
          }),
        });
        if (!response.ok) throw new Error('failed');
        const updated = await response.json();
        candidateSavingIds.delete(id);
        mergeCachedUser({
          id: userId,
          candidate_status: updated.candidate_status ?? null,
          candidate_category: updated.candidate_category ?? null,
          requested_category: updated.requested_category ?? current?.requested_category ?? null,
        });
        const targetCard = findUserCard(id);
        if (targetCard) {
          syncCandidateControls(targetCard, cachedUsersById.get(id) || updated);
        }
        await render({ preserveExisting: true, keepPage: true });
        return true;
      } catch {
        candidateSavingIds.delete(id);
        const targetCard = findUserCard(id);
        if (targetCard && current) syncCandidateControls(targetCard, current);
        showToast('კანდიდატის სტატუსის განახლება ვერ შესრულდა', 'error');
        return false;
      }
    }

    function mountUserCard(card, user) {
      const schedulesController = examSchedules?.mount?.(card.querySelector('.user-exam-schedules'), user, {
        onChanged: refreshAfterScheduleChange,
      });
      const toggle = card.querySelector('.head-toggle');
      toggle?.addEventListener('click', () => {
        const isOpen = card.classList.contains('open');
        card.classList.toggle('open', !isOpen);
        card.querySelector('.block-questions')?.setAttribute('aria-hidden', isOpen ? 'true' : 'false');
        toggle.setAttribute('aria-expanded', isOpen ? 'false' : 'true');
        if (!isOpen) schedulesController?.load?.();
        else if (listIsStale) void refreshLiveUserStates({ force: true });
      });

      const candCheckbox = card.querySelector('.chk-candidate-status');
      candCheckbox?.addEventListener('change', async (event) => {
        const id = card.dataset.id;
        const current = cachedUsersById.get(String(id)) || user;
        if (!event.target.checked) {
          const statusLabel = current.candidate_status === 'cert_candidate'
            ? 'სერტიფიკატის კანდიდატის'
            : 'გამოცდის კანდიდატის';
          if (!global.confirm(`დარწმუნებული ხართ, რომ გსურთ ${statusLabel} სტატუსის გაუქმება?`)) {
            event.target.checked = true;
            return;
          }
          await saveUserCandidateStatus(id, null, null);
        }
      });

      const candCategorySelect = card.querySelector('.sel-candidate-category');
      candCategorySelect?.addEventListener('change', async (event) => {
        const id = card.dataset.id;
        const current = cachedUsersById.get(String(id)) || user;
        if (!current.candidate_status) return;
        await saveUserCandidateStatus(id, current.candidate_status, event.target.value);
      });

      const manualStatusSelect = card.querySelector('.sel-manual-candidate-status');
      const manualCategorySelect = card.querySelector('.sel-manual-candidate-category');
      manualStatusSelect?.addEventListener('change', async (event) => {
        const id = card.dataset.id;
        const current = cachedUsersById.get(String(id)) || user;
        const nextStatus = event.target.value || null;
        if (!nextStatus && current.candidate_status) {
          if (!global.confirm('დარწმუნებული ხართ, რომ გსურთ კანდიდატის სტატუსის გაუქმება?')) {
            syncCandidateControls(card, current);
            return;
          }
        }
        const nextCat = manualCategorySelect?.value || current.candidate_category || current.requested_category || 'A';
        await saveUserCandidateStatus(id, nextStatus, nextCat);
      });

      manualCategorySelect?.addEventListener('change', async (event) => {
        const id = card.dataset.id;
        const current = cachedUsersById.get(String(id)) || user;
        const activeStatus = manualStatusSelect?.value || current.candidate_status;
        if (!activeStatus) return;
        await saveUserCandidateStatus(id, activeStatus, event.target.value);
      });

      const checkbox = card.querySelector('.chk-admin');
      if (checkbox) {
        checkbox.addEventListener('change', async (event) => {
          const id = card.dataset.id;
          const desired = !!event.target.checked;
          if (user.is_founder || !isFounderActor() || adminRoleSavingIds.has(String(id)) || hasPendingStage(id)) {
            syncExamControls(card, cachedUsersById.get(String(id)) || user);
            return;
          }
          if (!global.confirm('დარწმუნებული ხართ, რომ შეცვალოთ ადმინის სტატუსი?')) {
            event.target.checked = !desired;
            return;
          }
          statementsStateVersion += 1;
          examPermissionsStateVersion += 1;
          adminRoleSavingIds.add(String(id));
          syncExamControls(card, user);
          try {
            const response = await fetch(`${API_BASE}/admin/users/${id}/admin`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', ...getAdminHeaders(), ...getActorHeaders() },
              body: JSON.stringify({ is_admin: desired }),
            });
            if (!response.ok) throw new Error('failed');
            statementsStateVersion += 1;
            examPermissionsStateVersion += 1;
            adminRoleSavingIds.delete(String(id));
            await render({ preserveExisting: true, keepPage: true });
          } catch {
            event.target.checked = !desired;
            alert('ვერ შეინახა სტატუსი');
          } finally {
            examPermissionsStateVersion += 1;
            adminRoleSavingIds.delete(String(id));
            syncExamControls(findUserCard(id), cachedUsersById.get(String(id)));
          }
        });
      }

      EXAM_STAGES.forEach(({ key }) => {
        const examCheckbox = card.querySelector(`.chk-exam[data-exam-stage="${key}"]`);
        if (!examCheckbox) return;
        examCheckbox.addEventListener('change', async (event) => {
          const id = card.dataset.id;
          const saveKey = stageSaveKey(id, key);
          const current = cachedUsersById.get(String(id)) || user;
          const desired = !!event.target.checked;
          if (hasPermanentExamAccess(current) || adminRoleSavingIds.has(String(id))
            || examStageSaves.has(saveKey) || !hasStageState(current, key)) {
            syncExamControls(card, current);
            return;
          }
          if (listIsStale) {
            syncExamControls(card, current);
            showToast('ჯერ განაახლეთ სია, რათა არჩეული ფილტრის შედეგები დადასტურდეს.', 'error');
            return;
          }
          const previous = stageGranted(current, key);
          if (desired === previous) return;
          const currentPermission = current.exam_stage_permissions[key];
          const replacesStarted = desired && currentPermission.status === 'started';
          if (replacesStarted && !global.confirm(STARTED_STAGE_REGRANT_WARNING)) {
            syncExamControls(card, current);
            return;
          }
          const payload = replacesStarted
            ? { granted: true, replace_started: true, expected_grant_id: currentPermission.grant_id }
            : { granted: desired };
          examPermissionsStateVersion += 1;
          examStageSaves.set(saveKey, { desired, previous });
          syncExamControls(card, current);
          try {
            const response = await fetch(`${API_BASE}/admin/users/${id}/exam-stage-permissions/${key}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', ...getAdminHeaders(), ...getActorHeaders() },
              body: JSON.stringify(payload),
            });
            if (!response.ok) throw new Error('failed');
            const updated = await response.json();
            if (String(updated?.id) !== String(id) || !hasStageState(updated, key)) throw new Error('invalid stage state');
            examPermissionsStateVersion += 1;
            examStageSaves.delete(saveKey);
            // Concurrent stage mutations can finish out of order. A response
            // is authoritative only for the stage this request changed.
            mergeCachedUser({ id, exam_stage_permissions: { [key]: updated.exam_stage_permissions[key] } });
          } catch {
            event.target.checked = previous;
            alert('ვერ შეინახა გამოცდის უფლება');
          } finally {
            examPermissionsStateVersion += 1;
            examStageSaves.delete(saveKey);
            syncExamControls(findUserCard(id), cachedUsersById.get(String(id)));
            await refreshLiveUserStates({ force: true });
          }
        });
      });

      const deleteBtn = card.querySelector('.head-delete');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
          const id = card.dataset.id;
          if (!global.confirm('დარწმუნებული ხართ, რომ გსურთ რეგისტრირებული პირის წაშლა?')) return;
          try {
            const response = await fetch(`${API_BASE}/admin/users/${id}`, {
              method: 'DELETE',
              headers: { ...getAdminHeaders(), ...getActorHeaders() },
            });
            if (!response.ok) throw new Error('failed');
            statementsStateVersion += 1;
            card.remove();
            cardsById.delete(String(id));
            cachedUsersById.delete(String(id));
            cachedItems = cachedItems.filter((item) => String(item.id) !== String(id));
            await render({ preserveExisting: true, keepPage: true });
          } catch {
            alert('წაშლა ვერ შესრულდა');
          }
        });
      }

      const announcementsBtn = card.querySelector('.btn-user-announcements');
      const resultsBtns = card.querySelectorAll('.btn-user-results');
      const certificateBtns = card.querySelectorAll('.btn-user-certificate');
      const editBtns = card.querySelectorAll('.btn-user-edit');
      const multiApartmentBtns = card.querySelectorAll('.btn-user-multi-apartment');
      const multiFunctionalBtns = card.querySelectorAll('.btn-user-multi-functional');
      
      announcementsBtn?.addEventListener('click', () => {
        if (typeof schedulesController?.openHistoryModal === 'function') {
          schedulesController.openHistoryModal();
        } else if (typeof onShowStatements === 'function') {
          onShowStatements(user);
        }
      });
      resultsBtns?.forEach((btn) => btn.addEventListener('click', () => {
        if (typeof onShowResults === 'function') {
          onShowResults(user);
        } else {
          alert('გამოცდის შედეგები — მალე დაემატება');
        }
      }));
      certificateBtns?.forEach((btn) => btn.addEventListener('click', () => {
        if (typeof onShowCertificate === 'function') {
          onShowCertificate(user);
        } else {
          alert('სერტიფიკატი — მალე დაემატება');
        }
      }));
      editBtns?.forEach((btn) => btn.addEventListener('click', () => openEditModal(user)));
      multiApartmentBtns?.forEach((btn) => btn.addEventListener('click', () => {
        if (typeof onShowMultiApartmentResults === 'function') {
          onShowMultiApartmentResults(user);
        } else {
          showMultiApartmentResults(user);
        }
      }));
      multiFunctionalBtns?.forEach((btn) => btn.addEventListener('click', () => {
        if (typeof onShowMultiFunctionalResults === 'function') {
          onShowMultiFunctionalResults(user);
        } else {
          alert('მრავალფუნქციურის შეფასების შედეგები — მალე დაემატება');
        }
      }));

      // Photo upload
      const photoInput = card.querySelector('.photo-upload-input');
      const photoFilename = card.querySelector('.photo-filename');
      const photoDeleteBtn = card.querySelector('.photo-delete-btn');

      if (photoInput) {
        photoInput.addEventListener('change', async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const formData = new FormData();
          formData.append('file', file);
          try {
            const response = await fetch(`${API_BASE}/admin/users/${user.id}/photo`, {
              method: 'POST',
              headers: { ...getAdminHeaders(), ...getActorHeaders() },
              body: formData,
            });
            if (!response.ok) {
              const data = await response.json().catch(() => ({}));
              alert(data.detail || 'ფოტოს ატვირთვა ვერ შესრულდა');
              return;
            }
            const data = await response.json();
            statementsStateVersion += 1;
            mergeCachedUser({ id: user.id, photo_filename: data.photo_filename || file.name });
            if (photoFilename) photoFilename.textContent = data.photo_filename || file.name;
            if (photoDeleteBtn) photoDeleteBtn.style.display = '';
            showToast('ფოტო წარმატებით აიტვირთა');
          } catch {
            alert('ფოტოს ატვირთვა ვერ შესრულდა');
          }
          photoInput.value = '';
        });
      }

      if (photoDeleteBtn) {
        photoDeleteBtn.addEventListener('click', async () => {
          if (!global.confirm('დარწმუნებული ხართ, რომ გსურთ ფოტოს წაშლა?')) return;
          try {
            const response = await fetch(`${API_BASE}/admin/users/${user.id}/photo`, {
              method: 'DELETE',
              headers: { ...getAdminHeaders(), ...getActorHeaders() },
            });
            if (!response.ok) throw new Error('failed');
            statementsStateVersion += 1;
            mergeCachedUser({ id: user.id, photo_filename: null });
            if (photoFilename) photoFilename.textContent = '—';
            photoDeleteBtn.style.display = 'none';
            showToast('ფოტო წაიშალა');
          } catch {
            alert('ფოტოს წაშლა ვერ შესრულდა');
          }
        });
      }
    }

    function setCardUnseenState(card, hasUnseen, hasPending) {
      if (!card) return;
      const pending = hasPending == null ? card.dataset.hasPendingStatements === 'true' : !!hasPending;
      card.dataset.hasPendingStatements = String(pending);
      card.classList.toggle('has-new-statements', !!hasUnseen);
      card.classList.toggle('has-pending-statements', !hasUnseen && pending);
      // Keep cards mounted so live updates can reveal new statements without
      // rebuilding the list or closing expanded cards.
      const showNew = !!DOM.filterStatements?.checked;
      const showPending = !!DOM.filterPendingStatements?.checked;
      const matchesStatus = (showNew && hasUnseen) || (showPending && !hasUnseen && pending);
      // A date independently selects every sender from that day, regardless
      // of status. Without a date, the two checkboxes select red OR blue cards.
      const hiddenByStatementFilter = !selectedStatementsDate()
        && (showNew || showPending) && !matchesStatus;
      card.style.display = hiddenByStatementFilter ? 'none' : '';
      const announcementsButton = card.querySelector('.btn-user-announcements');
      if (announcementsButton) {
        announcementsButton.classList.toggle('has-new-statements', !!hasUnseen);
        announcementsButton.classList.toggle('has-pending-statements', !hasUnseen && pending);
      }
    }

    function drawUsers(items, { preserveExisting = false } = {}) {
      if (!DOM.usersGrid) return;
      const existingCards = new Map();
      if (preserveExisting) {
        Array.from(DOM.usersGrid.querySelectorAll('.block-card')).forEach((card) => {
          existingCards.set(String(card.dataset.id), card);
        });
      } else {
        DOM.usersGrid.innerHTML = '';
        cardsById.clear();
      }
      cachedItems = (items || []).map((user) => {
        const existing = cachedUsersById.get(String(user.id));
        return existing ? mergeUserState(existing, user) : user;
      });
      cachedUsersById.clear();
      cachedItems.forEach((user) => cachedUsersById.set(String(user.id), user));
      
      // Apply certificate and candidate filters
      let filteredItems = cachedItems;
      const filterArchitects = DOM.filterArchitects?.checked;
      const filterExperts = DOM.filterExperts?.checked;
      const filterMunicipal = DOM.filterMunicipal?.checked;
      const filterCertified = DOM.filterCertified?.checked;
      const filterSuspendedExpired = DOM.filterSuspendedExpired?.checked;
      const filterExamCandidates = DOM.filterExamCandidates?.checked;
      const filterCertCandidates = DOM.filterCertCandidates?.checked;
      
      if (!paginatedList && (filterArchitects || filterExperts || filterMunicipal || filterCertified || filterSuspendedExpired || filterExamCandidates || filterCertCandidates)) {
        filteredItems = filteredItems.filter((user) => {
          const certificate = user.certificate || user.certificate_info || {};
          const certLevel = certificate.level || '';
          const certStatus = certificate.status || '';
          const hasCertificate = !!certificate.level;
          
          if (filterExamCandidates) {
            return user.candidate_status === 'exam_candidate';
          }
          if (filterCertCandidates) {
            return user.candidate_status === 'cert_candidate';
          }
          if (filterSuspendedExpired) {
            return certStatus === 'suspended' || certStatus === 'expired';
          }
          if (filterCertified) {
            return hasCertificate && (certLevel === 'architect' || certLevel === 'expert' || certLevel === 'municipal');
          }
          if (filterArchitects) {
            return certLevel === 'architect' || certLevel === 'architect_expert';
          }
          if (filterExperts) {
            return certLevel === 'expert';
          }
          if (filterMunicipal) {
            return certLevel === 'municipal';
          }
          return true;
        });
      }
      
      filteredItems.forEach((user) => {
        const existingCard = existingCards.get(String(user.id));
        if (existingCard) {
          existingCards.delete(String(user.id));
          applyLiveUserState(user);
          updateUserDisplay(existingCard, user);
          DOM.usersGrid.appendChild(existingCard);
          return;
        }
        const wrapper = document.createElement('div');
        wrapper.innerHTML = userRowHTML(user);
        const card = wrapper.firstElementChild;
        if (card) {
          card.dataset.unseenCount = String(user.unseen_statement_count || 0);
          card.dataset.pendingCount = String(user.pending_statement_count || 0);
          setCardUnseenState(card, user.has_unseen_statements, user.has_pending_statements);
          mountUserCard(card, user);
          cardsById.set(String(user.id), card);
          DOM.usersGrid.appendChild(card);
        }
      });
      existingCards.forEach((card, id) => {
        card.remove();
        cardsById.delete(id);
      });
      const computedUnseen = globalUnseenUsers == null
        ? cachedItems.filter((user) => user.has_unseen_statements).length
        : globalUnseenUsers;
      const computedPending = globalPendingUsers == null
        ? cachedItems.filter((user) => !user.has_unseen_statements && user.has_pending_statements).length
        : globalPendingUsers;
      const computedExamCands = globalExamCandidates == null
        ? cachedItems.filter((user) => user.candidate_status === 'exam_candidate').length
        : globalExamCandidates;
      const computedCertCands = globalCertCandidates == null
        ? cachedItems.filter((user) => user.candidate_status === 'cert_candidate').length
        : globalCertCandidates;
      updateNavBadge(computedUnseen > 0);
      updateStatementFilterBadges(computedUnseen, computedPending);
      updateCandidateFilterBadges(computedExamCands, computedCertCands);
    }

    function updateUserDisplay(card, user) {
      const nameText = card.querySelector('.user-name-text') || card.querySelector('.user-name');
      if (nameText) nameText.textContent = `${user.first_name || ''} ${user.last_name || ''}`.trim() || '(უსახელო)';
      for (const field of ['personal_id', 'phone', 'code', 'email', 'created_at']) {
        const node = card.querySelector(`[data-user-field="${field}"]`);
        if (node) node.textContent = field === 'created_at' ? formatDateTime(user[field]) : user[field] || '—';
      }
      const admin = card.querySelector('.chk-admin');
      if (admin && !adminRoleSavingIds.has(String(user.id))) admin.checked = !!(user.is_admin || user.is_founder);
      syncExamControls(card, user);
      const filename = card.querySelector('.photo-filename');
      if (filename) filename.textContent = user.photo_filename || '—';
      const deletePhoto = card.querySelector('.photo-delete-btn');
      if (deletePhoto) deletePhoto.style.display = user.photo_filename ? 'inline-flex' : 'none';
      updateUserCardColor(user.id, user.certificate || user.certificate_info, false);
      syncExamOutcomeUI(card, user);
    }

    function normalizeUserValue(value) {
      return (value == null ? '' : String(value)).trim();
    }

    function collectEditValues() {
      const nextValues = {};
      Object.entries(editFields).forEach(([key, input]) => {
        if (!input) return;
        nextValues[key] = normalizeUserValue(input.value);
      });
      return nextValues;
    }

    function validateEditValues(values) {
      if (!values) return 'მონაცემები ვერ მოიძებნა';
      if (!values.first_name) return 'სახელი აუცილებელია';
      if (!values.last_name) return 'გვარი აუცილებელია';
      if (!values.personal_id) return 'პირადი ნომერი აუცილებელია';
      if (!/^\d{11}$/.test(values.personal_id)) return 'პირადი ნომერი უნდა შედგებოდეს 11 ციფრისგან';
      if (!values.phone) return 'ტელეფონის ნომერი აუცილებელია';
      if (!values.email) return 'ელფოსტა აუცილებელია';
      return null;
    }

    function diffEditValues(values, base) {
      const payload = {};
      Object.keys(editFields).forEach((key) => {
        const current = values[key] ?? '';
        const previous = base?.[key] ?? '';
        if (current !== previous) {
          payload[key] = current;
        }
      });
      return payload;
    }

    function setEditSubmitting(state) {
      editSubmitting = state;
      if (editSaveBtn) {
        editSaveBtn.disabled = !!state;
        editSaveBtn.textContent = state ? 'ინახება...' : 'შენახვა';
      }
      Object.values(editFields).forEach((input) => {
        if (!input) return;
        input.disabled = !!state;
      });
    }

    async function handleEditSubmit(event) {
      event?.preventDefault?.();
      if (editSubmitting) return;
      if (!editActiveUser || !editInitialValues) return;
      const values = collectEditValues();
      const validationError = validateEditValues(values);
      if (validationError) {
        showToast(validationError, 'error');
        return;
      }
      const payload = diffEditValues(values, editInitialValues);
      if (!Object.keys(payload).length) {
        showToast('ცვლილებები არ არის დასამახსოვრებლად');
        return;
      }

      setEditSubmitting(true);
      try {
        const response = await fetch(`${API_BASE}/admin/users/${editActiveUser.id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'მონაცემების განახლება ვერ შესრულდა', showToast);
          return;
        }
        const data = await response.json();
        statementsStateVersion += 1;
        const nextItems = cachedItems.map((item) => (String(item.id) === String(data.id) ? { ...item, ...data } : item));
        drawUsers(nextItems);
        showToast('მონაცემები წარმატებით განახლდა');
        closeEditModal();
        if (paginatedList) void render({ preserveExisting: true, keepPage: true });
      } catch {
        showToast('მონაცემების განახლება ვერ შესრულდა', 'error');
      } finally {
        setEditSubmitting(false);
      }
    }

    function handleEditBackdrop(event) {
      if (event.target === editOverlay) {
        closeEditModal();
      }
    }

    function handleEditKeydown(event) {
      if (event.key === 'Escape' && editOverlay?.classList.contains('open')) {
        closeEditModal();
      }
    }

    function setupEditModal() {
      if (!editOverlay || !editForm) return;
      on(editForm, 'submit', handleEditSubmit);
      on(editCloseBtn, 'click', closeEditModal);
      on(editCancelBtn, 'click', (event) => {
        event.preventDefault();
        closeEditModal();
      });
      on(editOverlay, 'click', handleEditBackdrop);
      on(document, 'keydown', handleEditKeydown);
    }

    function openEditModal(user) {
      if (!isFounderActor()) {
        showToast('მხოლოდ მთავარ ადმინს შეუძლია მონაცემების რედაქტირება', 'error');
        return;
      }
      if (!editOverlay || !editForm || !user) return;
      editActiveUser = { ...user };
      editInitialValues = {
        personal_id: normalizeUserValue(user.personal_id),
        first_name: normalizeUserValue(user.first_name),
        last_name: normalizeUserValue(user.last_name),
        phone: normalizeUserValue(user.phone),
        email: normalizeUserValue(user.email),
      };
      editInitialCode = normalizeUserValue(user.code);

      if (editTitle) {
        editTitle.textContent = 'მონაცემების რედაქტირება';
      }

      Object.entries(editFields).forEach(([key, input]) => {
        if (!input) return;
        input.value = editInitialValues[key] || '';
        input.disabled = false;
      });
      if (editCodeField) {
        editCodeField.value = editInitialCode;
        editCodeField.readOnly = true;
      }
      if (editSaveBtn) {
        editSaveBtn.disabled = false;
        editSaveBtn.textContent = 'შენახვა';
      }
      editSubmitting = false;
      openOverlay(editOverlay);
      requestAnimationFrame(() => {
        editFields.first_name?.focus();
        if (editFields.first_name) {
          editFields.first_name.selectionStart = editFields.first_name.value.length;
          editFields.first_name.selectionEnd = editFields.first_name.value.length;
        }
      });
    }

    function closeEditModal() {
      if (!editOverlay) return;
      closeOverlay(editOverlay);
      editActiveUser = null;
      editInitialValues = null;
      editInitialCode = '';
      editSubmitting = false;
      if (editForm) {
        editForm.reset();
      }
      if (editCodeField) {
        editCodeField.value = '';
        editCodeField.readOnly = true;
      }
    }

    async function render({ preserveExisting = false, keepPage = false } = {}) {
      if (!DOM.usersGrid) return;
      syncResetFiltersButton();
      if (searchTimer) { clearTimeout(searchTimer); searchTimer = null; }
      if (!keepPage) currentPage = 1;
      renderController?.abort();
      renderController = typeof AbortController === 'function' ? new AbortController() : null;
      const requestVersion = ++usersRenderVersion;
      const statementVersion = statementsStateVersion;
      const scheduleVersion = schedulesStateVersion;
      const permissionVersion = examPermissionsStateVersion;
      renderInFlight = true;
      setListStale(true);
      setListNotice('მონაცემები ახლდება — ნაჩვენებია წინა შედეგები.');
      DOM.usersGrid.setAttribute('aria-busy', 'true');
      if (pagination.previous) pagination.previous.disabled = true;
      if (pagination.next) pagination.next.disabled = true;
      try {
        const data = await fetchUsers({ signal: renderController?.signal });
        if (requestVersion !== usersRenderVersion) return;
        // A statement action may finish while a filter render is loading. Fetch
        // fresh state rather than leaving the cleared grid empty or reviving old colors.
        if (statementVersion !== statementsStateVersion || scheduleVersion !== schedulesStateVersion
          || permissionVersion !== examPermissionsStateVersion) {
          return render({ preserveExisting: true, keepPage: true });
        }
        if (preserveExisting && data.paginated && deferEditorRemoval(data.items || [])) return;
        updatePagination(data);
        drawUsers(Array.isArray(data?.items) ? data.items : [], { preserveExisting });
        setListStale(false);
        setListNotice();
      } catch (error) {
        if (requestVersion !== usersRenderVersion) return;
        if (error?.name === 'AbortError') return;
        currentPage = displayedPage;
        // A failed refresh must not wipe the currently visible people.
        if (!cachedItems.length) DOM.usersGrid.innerHTML = '<div class="block-tile">ჩატვირთვის შეცდომა</div>';
        setListNotice('სიის განახლება ვერ მოხერხდა — ნაჩვენებია წინა შედეგები და ისინი შესაძლოა არჩეულ ფილტრს არ შეესაბამებოდეს. გამოცდაზე დაშვებამდე ხელახლა სცადეთ.', true);
        showToast('სიის განახლება ვერ მოხერხდა. სცადეთ ხელახლა.', 'error');
      } finally {
        if (requestVersion === usersRenderVersion) {
          renderInFlight = false;
          DOM.usersGrid.setAttribute('aria-busy', 'false');
          if (pagination.previous) pagination.previous.disabled = currentPage <= 1;
          if (pagination.next) pagination.next.disabled = currentPage * PAGE_SIZE >= totalUsers;
        }
      }
    }

    function init() {
      on(DOM.usersSearch, 'input', () => {
        syncResetFiltersButton();
        // Invalidate old responses immediately, not only after the debounce.
        ++usersRenderVersion;
        renderController?.abort();
        renderInFlight = false;
        setListStale(true);
        setListNotice('მონაცემები ახლდება — ნაჩვენებია წინა შედეგები.');
        if (pagination.previous) pagination.previous.disabled = true;
        if (pagination.next) pagination.next.disabled = true;
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { searchTimer = null; void render(); }, SEARCH_DELAY_MS);
      });
      on(DOM.resetUsersFilters, 'click', resetAllUsersFilters);
      on(listNotice.retry, 'click', () => render({ preserveExisting: true, keepPage: true }));
      on(pagination.previous, 'click', () => {
        if (renderInFlight || searchTimer || currentPage <= 1) return;
        currentPage -= 1;
        return render({ keepPage: true });
      });
      on(pagination.next, 'click', () => {
        if (renderInFlight || searchTimer || currentPage * PAGE_SIZE >= totalUsers) return;
        currentPage += 1;
        return render({ keepPage: true });
      });
      on(DOM.usersSort, 'change', render);
      on(DOM.onlyAdmins, 'change', render);
      on(DOM.filterStatements, 'change', render);
      on(DOM.filterPendingStatements, 'change', render);
      on(DOM.statementsDate, 'change', () => {
        syncStatementFilterControls();
        return render();
      });
      on(DOM.clearStatementsDate, 'click', () => {
        if (DOM.statementsDate) DOM.statementsDate.value = '';
        syncStatementFilterControls();
        return render();
      });
      syncStatementFilterControls();
      on(DOM.filterExamMorning, 'change', render);
      on(DOM.filterExamEvening, 'change', render);
      on(DOM.filterCertificateHandover, 'change', render);
      on(DOM.examScheduleDate, 'change', () => {
        syncExamScheduleFilterControls();
        return render();
      });
      on(DOM.clearExamScheduleDate, 'click', () => {
        if (DOM.examScheduleDate) DOM.examScheduleDate.value = '';
        syncExamScheduleFilterControls();
        return render();
      });
      syncExamScheduleFilterControls();
      on(DOM.filterExamPassed, 'change', () => {
        if (DOM.filterExamPassed?.checked) {
          if (DOM.filterPendingPassLetter) DOM.filterPendingPassLetter.checked = false;
          if (DOM.filterPendingFailLetter) DOM.filterPendingFailLetter.checked = false;
        }
        syncExamResultFilterControls();
        return render();
      });
      on(DOM.filterExamFailed, 'change', () => {
        if (DOM.filterExamFailed?.checked) {
          if (DOM.filterPendingPassLetter) DOM.filterPendingPassLetter.checked = false;
          if (DOM.filterPendingFailLetter) DOM.filterPendingFailLetter.checked = false;
        }
        syncExamResultFilterControls();
        return render();
      });
      on(DOM.filterPendingPassLetter, 'change', () => {
        if (DOM.filterPendingPassLetter?.checked) {
          if (DOM.filterExamPassed) DOM.filterExamPassed.checked = false;
          if (DOM.filterExamFailed) DOM.filterExamFailed.checked = false;
        }
        syncExamResultFilterControls();
        return render();
      });
      on(DOM.filterPendingFailLetter, 'change', () => {
        if (DOM.filterPendingFailLetter?.checked) {
          if (DOM.filterExamPassed) DOM.filterExamPassed.checked = false;
          if (DOM.filterExamFailed) DOM.filterExamFailed.checked = false;
        }
        syncExamResultFilterControls();
        return render();
      });
      on(DOM.examResultDate, 'change', () => {
        syncExamResultFilterControls();
        return render();
      });
      on(DOM.clearExamResultDate, 'click', () => {
        if (DOM.examResultDate) DOM.examResultDate.value = '';
        syncExamResultFilterControls();
        return render();
      });
      syncExamResultFilterControls();
      const qualificationCheckboxes = [
        DOM.filterArchitects,
        DOM.filterExperts,
        DOM.filterMunicipal,
        DOM.filterCertified,
        DOM.filterSuspendedExpired,
        DOM.filterExamCandidates,
        DOM.filterCertCandidates,
      ].filter(Boolean);
      qualificationCheckboxes.forEach((checkbox) => {
        on(checkbox, 'change', () => {
          if (checkbox.checked) {
            qualificationCheckboxes.forEach((other) => {
              if (other !== checkbox) other.checked = false;
            });
          }
          return render();
        });
      });
      syncResetFiltersButton();
      setupEditModal();
      startLiveRefresh();
    }

    function updateUserUnseenStatus(userId, hasUnseen, count, hasPending, pendingCount) {
      // A successful statement action is newer than any list response already in flight.
      statementsStateVersion += 1;
      const pendingChanges = {};
      if (hasPending != null) pendingChanges.has_pending_statements = !!hasPending;
      if (pendingCount != null) pendingChanges.pending_statement_count = pendingCount || 0;
      else if (hasPending === false) pendingChanges.pending_statement_count = 0;
      const existing = cachedUsersById.get(String(userId));
      if (existing) {
        const wasRed = !!existing.has_unseen_statements;
        const wasBlue = !wasRed && !!existing.has_pending_statements;
        const nextRed = !!hasUnseen;
        const nextPending = hasPending != null ? !!hasPending : !!existing.has_pending_statements;
        const nextBlue = !nextRed && nextPending;
        if (globalUnseenUsers != null) {
          globalUnseenUsers = Math.max(0, globalUnseenUsers + Number(nextRed) - Number(wasRed));
        }
        if (globalPendingUsers != null) {
          globalPendingUsers = Math.max(0, globalPendingUsers + Number(nextBlue) - Number(wasBlue));
        }
        Object.assign(existing, {
          has_unseen_statements: !!hasUnseen,
          unseen_statement_count: count || 0,
          ...pendingChanges,
        });
      }
      const card = findUserCard(userId);
      if (card) {
        setCardUnseenState(card, hasUnseen, hasPending);
        card.dataset.unseenCount = String(count || 0);
        if (pendingChanges.pending_statement_count != null) {
          card.dataset.pendingCount = String(pendingChanges.pending_statement_count);
        }
      }
      const computedUnseen = globalUnseenUsers == null
        ? cachedItems.filter((item) => item.has_unseen_statements).length
        : globalUnseenUsers;
      const computedPending = globalPendingUsers == null
        ? cachedItems.filter((item) => !item.has_unseen_statements && item.has_pending_statements).length
        : globalPendingUsers;
      updateNavBadge(computedUnseen > 0);
      updateStatementFilterBadges(computedUnseen, computedPending);
      if (paginatedList) void render({ preserveExisting: true, keepPage: true });
    }

    function updateUserCardColor(userId, certificateData, refresh = true) {
      if (refresh) statementsStateVersion += 1;
      const patch = { id: userId, certificate: certificateData, certificate_info: certificateData };
      if (certificateData && certificateData.level) {
        patch.candidate_status = null;
        patch.candidate_category = null;
      }
      const mergedUser = mergeCachedUser(patch);
      if (refresh && paginatedList) void render({ preserveExisting: true, keepPage: true });
      const card = findUserCard(userId);
      if (!card) return;
      if (mergedUser) {
        syncCandidateControls(card, mergedUser);
      }
      
      const nameElement = card.querySelector('.user-name');
      if (!nameElement) return;
      nameElement.style.color = '';

      let dotEl = nameElement.querySelector('.user-cert-dot');
      if (!dotEl) {
        dotEl = document.createElement('span');
        dotEl.className = 'user-cert-dot';
        nameElement.prepend(dotEl);
      }

      const dotMeta = certificateDotMeta(certificateData);
      if (dotMeta) {
        dotEl.className = `user-cert-dot ${dotMeta.cls}`;
        dotEl.title = dotMeta.title;
        dotEl.hidden = false;
      } else {
        dotEl.className = 'user-cert-dot';
        dotEl.removeAttribute('title');
        dotEl.hidden = true;
      }
    }

    function updateNavBadge(hasAny) {
      navLinks.forEach((link) => {
        const label = (link.textContent || '').trim();
        if (label === 'რეგისტრაციები' || label === 'რეგისტრირებული პირები') {
          link.classList.toggle('has-new-statements', !!hasAny);
        }
      });
    }

    async function refreshUnseenSummary() {
      const statementVersion = statementsStateVersion;
      const requestVersion = usersRenderVersion;
      try {
        const response = await fetch(`${API_BASE}/admin/statements/summary`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) throw new Error('summary failed');
        const data = await response.json();
        if (statementVersion !== statementsStateVersion || requestVersion !== usersRenderVersion) return;
        if (data?.unseen_users != null) globalUnseenUsers = Number(data.unseen_users) || 0;
        if (data?.pending_users != null) globalPendingUsers = Number(data.pending_users) || 0;
        if (data?.pending_pass_users != null) globalPendingPassUsers = Number(data.pending_pass_users) || 0;
        if (data?.pending_fail_users != null) globalPendingFailUsers = Number(data.pending_fail_users) || 0;
        if (data?.exam_candidates != null) globalExamCandidates = Number(data.exam_candidates) || 0;
        if (data?.cert_candidates != null) globalCertCandidates = Number(data.cert_candidates) || 0;
        updateNavBadge(!!data?.has_unseen);
        updateStatementFilterBadges(
          globalUnseenUsers ?? (data?.has_unseen ? 1 : 0),
          globalPendingUsers ?? 0
        );
        updateExamOutcomeFilterBadges(
          globalPendingPassUsers ?? 0,
          globalPendingFailUsers ?? 0
        );
        updateCandidateFilterBadges(
          globalExamCandidates ?? 0,
          globalCertCandidates ?? 0
        );
      } catch {}
    }

    async function showMultiApartmentResults(user) {
      try {
        const response = await fetch(`${API_BASE}/admin/multi-apartment/evaluations/${user.id}`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          alert(error.detail || 'შედეგების ჩატვირთვა ვერ მოხერხდა');
          return;
        }
        
        const data = await response.json();
        const items = data.items || [];
        
        if (items.length === 0) {
          alert('მომხმარებელს ჯერ არ აქვს მრავალბინიანის შეფასების შედეგები');
          return;
        }
        
        // Show in modal
        const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'მომხმარებელი';
        showModal(`მრავალბინიანი: ${userName}`, buildResultsTable(items));
        
      } catch (e) {
        console.error('Error fetching multi-apartment results:', e);
        alert('შედეგების ჩატვირთვა ვერ მოხერხდა');
      }
    }
    
    function createResultsCell(tagName, text, centered = false) {
      const cell = document.createElement(tagName);
      cell.style.padding = '8px';
      cell.style.textAlign = centered ? 'center' : 'left';
      cell.textContent = String(text ?? '');
      return cell;
    }

    function renderResultsRows(body, items) {
      items.forEach((item) => {
        const percentage = Number.isFinite(Number(item?.percentage)) ? Number(item.percentage) : 0;
        const wrongCount = Number.isFinite(Number(item?.wrongCount)) ? Number(item.wrongCount) : 0;
        const row = document.createElement('tr');
        row.style.borderBottom = '1px solid #e5e7eb';
        row.appendChild(createResultsCell('td', new Date(item?.createdAt).toLocaleString('ka-GE')));
        row.appendChild(createResultsCell('td', item?.projectName || item?.projectCode || ''));

        const percentageCell = createResultsCell('td', `${percentage.toFixed(1)}%`, true);
        percentageCell.style.fontWeight = 'bold';
        percentageCell.style.color = percentage >= 75 ? '#22c55e' : percentage >= 70 ? '#eab308' : '#ef4444';
        row.appendChild(percentageCell);

        const wrongCell = createResultsCell('td', wrongCount, true);
        wrongCell.style.fontWeight = 'bold';
        wrongCell.style.color = wrongCount <= 1 ? '#22c55e' : wrongCount === 2 ? '#eab308' : '#ef4444';
        row.appendChild(wrongCell);
        body.appendChild(row);
      });
    }

    function buildResultsTable(items) {
      const content = document.createElement('div');
      content.style.cssText = 'max-height:400px;overflow-y:auto;';
      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;font-size:14px;';
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      headRow.style.background = '#f3f4f6';
      [['თარიღი', false], ['პროექტი', false], ['პროცენტი', true], ['არასწორი', true]].forEach(([label, centered]) => {
        const cell = createResultsCell('th', label, centered);
        cell.style.borderBottom = '2px solid #e5e7eb';
        headRow.appendChild(cell);
      });
      head.appendChild(headRow);
      table.appendChild(head);

      const body = document.createElement('tbody');
      renderResultsRows(body, items);
      table.appendChild(body);
      content.appendChild(table);
      return content;
    }

    function showModal(title, content) {
      // Remove existing modal if any
      const existing = document.getElementById('ma-results-modal');
      if (existing) existing.remove();
      
      const modal = document.createElement('div');
      modal.id = 'ma-results-modal';
      modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
      modal.innerHTML = `
        <div style="background:white;border-radius:12px;max-width:600px;width:90%;max-height:90vh;overflow:hidden;box-shadow:0 20px 25px -5px rgba(0,0,0,0.1);">
          <div style="padding:16px 20px;border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;">
            <h3 id="ma-results-title" style="margin:0;font-size:18px;color:#1f2937;"></h3>
            <button id="close-ma-modal" style="background:none;border:none;font-size:24px;cursor:pointer;color:#6b7280;">&times;</button>
          </div>
          <div id="ma-results-body" style="padding:20px;"></div>
        </div>
      `;

      modal.querySelector('#ma-results-title').textContent = String(title || '');
      if (content) modal.querySelector('#ma-results-body').appendChild(content);
      
      document.body.appendChild(modal);
      
      modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.id === 'close-ma-modal') {
          modal.remove();
        }
      });
    }

    return {
      init,
      render: () => render(),
      updateUserUnseenStatus,
      updateUserCardColor,
      refreshUnseenSummary,
      refreshLiveUserStates,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createUsersModule = createUsersModule;
})(window);

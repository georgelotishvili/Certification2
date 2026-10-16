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
    const examStageSaves = new Map();

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
    }

    function hasExamScheduleFilter() {
      return !!(DOM.examScheduleDate?.value || DOM.filterExamMorning?.checked || DOM.filterExamEvening?.checked);
    }

    function syncExamScheduleFilterControls() {
      if (DOM.clearExamScheduleDate) {
        DOM.clearExamScheduleDate.disabled = !DOM.examScheduleDate?.value;
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
        if (adminRoleSavingIds.has(id) || hasPendingStage(id)) return true;
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
          'unseen_statement_count', 'has_pending_statements', 'pending_statement_count']
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
      const qualification = DOM.filterCertified?.checked ? 'certified'
        : DOM.filterArchitects?.checked ? 'architect'
          : DOM.filterExperts?.checked ? 'expert' : DOM.filterMunicipal?.checked ? 'municipal' : '';
      if (qualification) params.set('qualification', qualification);
      const statementDate = selectedStatementsDate();
      if (statementDate) params.set('statement_date', statementDate);
      if (DOM.filterExamMorning?.checked) params.set('exam_morning', 'true');
      if (DOM.filterExamEvening?.checked) params.set('exam_evening', 'true');
      if (DOM.examScheduleDate?.value) params.set('exam_date', DOM.examScheduleDate.value);
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
      const existing = cachedUsersById.get(String(user.id));
      // Card callbacks retain the same object and always see the newest data.
      if (existing) mergeUserState(existing, user);
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
        updateNavBadge(globalUnseenUsers > 0);
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
        const dateMembershipChanged = (selectedStatementsDate() || hasExamScheduleFilter()) && (
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
      
      // Determine certificate level color
      const certificate = user.certificate || user.certificate_info || {};
      const certLevel = certificate.level || '';
      const certStatus = certificate.status || '';
      let nameColor = '#0f172a'; // default
      
      // გაუქმებული ან ვადაგასული სერტიფიკატი - ნაცრისფერი
      if (certStatus === 'suspended' || certStatus === 'expired') {
        nameColor = '#6b7280'; // ნაცრისფერი
      } else if (certLevel === 'architect' || certLevel === 'architect_expert') {
        nameColor = '#1e40af'; // დაბალანსებული ლურჯი
      } else if (certLevel === 'expert') {
        nameColor = '#991b1b'; // დაბალანსებული წითელი
      } else if (certLevel === 'municipal') {
        nameColor = '#065f46'; // დაბალანსებული მწვანე
      }
      
      return `
        <div class="block-tile block-card${user.has_unseen_statements ? ' has-new-statements' : (user.has_pending_statements ? ' has-pending-statements' : '')}" data-id="${safeId}">
          <div class="block-head user-block-head">
            <div class="user-name" style="font-size:16px;font-weight:700;color:${nameColor};">${safeFullName}</div>
            <div class="user-controls">
              <label class="user-checkbox-label" title="${founderRow ? 'მუდმივი ადმინი' : 'ადმინი'}">
                <input type="checkbox" class="chk-admin" ${checked} ${disabled} />
                <span>ადმინი</span>
              </label>
              <div class="user-exam-stage-controls" role="group" aria-label="გამოცდის ეტაპებზე დაშვება">${examControls}</div>
            </div>
            <div class="user-actions">
              <button class="head-toggle" type="button" aria-expanded="false">▾</button>
              <button class="head-delete" type="button" aria-label="წაშლა" title="წაშლა" ${founderRow || !isFounderActor() ? 'disabled' : ''} style="${founderRow ? 'display:none;' : ''}">×</button>
            </div>
          </div>
          <div class="block-questions" aria-hidden="true">
            <div class="questions-list">
              <div class="question-card open">
                <div class="user-details-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:12px;">
                  <div>
                    <div style="font-weight:700;color:#065f46;margin-bottom:8px;">ფოტო</div>
                    <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">
                      <label class="photo-upload-btn" title="ფოტოს ატვირთვა" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6366f1" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                        <input type="file" class="photo-upload-input" accept=".jpg,.jpeg,.png,.webp" style="display:none;" />
                      </label>
                      <button type="button" class="photo-delete-btn" title="ფოტოს წაშლა" style="display:${user.photo_filename ? 'inline-flex' : 'none'};align-items:center;justify-content:center;width:32px;height:32px;border:2px solid #fca5a5;border-radius:6px;background:#fef2f2;color:#dc2626;cursor:pointer;font-size:16px;font-weight:bold;">×</button>
                      <span class="photo-filename" style="font-size:13px;color:#525252;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${user.photo_filename ? escapeHtml(user.photo_filename) : '—'}</span>
                    </div>
                    <div style="color:#525252;font-size:13px;line-height:1.8;">
                      <div>პირადი №: <strong data-user-field="personal_id">${safePersonalId}</strong></div>
                      <div>ტელეფონი: <strong data-user-field="phone">${safePhone}</strong></div>
                      <div>კოდი: <strong data-user-field="code" style="color:#6d28d9;">${safeCode}</strong></div>
                      <div>მაილი: <strong data-user-field="email" style="color:#065f46;">${safeEmail}</strong></div>
                      <div>რეგისტრაცია: <strong data-user-field="created_at">${safeRegistered}</strong></div>
                    </div>
                  </div>
                  <div>
                    <div style="font-weight:700;color:#065f46;margin-bottom:8px;">ქმედებები</div>
                    <div class="user-action-buttons" style="margin-top:12px;display:grid;grid-template-columns:1fr 1fr;gap:6px;width:100%;">
                      <div style="display:flex;flex-direction:column;gap:6px;">
                        <button class="btn-user-announcements" type="button" style="width:100%;padding:6px 12px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;font-size:13px;">განცხადებები</button>
                        <button class="btn-user-certificate" type="button" style="width:100%;padding:6px 12px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;font-size:13px;">სერტიფიკატი</button>
                        <button class="btn-user-edit"${canEdit ? '' : ' disabled'} type="button" style="width:100%;padding:6px 12px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;font-size:13px;${canEdit ? '' : 'opacity:0.6;cursor:not-allowed;'}">რედაქტირება</button>
                      </div>
                      <div style="display:flex;flex-direction:column;gap:6px;">
                        <button class="btn-user-results" type="button" style="width:100%;padding:6px 12px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;font-size:13px;">გამოცდის შედეგები</button>
                        <button class="btn-user-multi-apartment" type="button" style="width:100%;padding:6px 12px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;font-size:13px;">მრავალბინიანის შეფ: შედეგები</button>
                        <button class="btn-user-multi-functional" type="button" style="width:100%;padding:6px 12px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;font-size:13px;">მრავალფუნქციურის შეფ: შედეგები</button>
                      </div>
                    </div>
                  </div>
                </div>
                <section class="user-exam-schedules" aria-label="გამოცდის დაგეგმვა"></section>
              </div>
            </div>
          </div>
        </div>`;
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
        if (typeof onShowStatements === 'function') {
          onShowStatements(user);
        } else {
          alert('განცხადებები — მალე დაემატება');
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
      
      // Apply certificate filters
      let filteredItems = cachedItems;
      const filterArchitects = DOM.filterArchitects?.checked;
      const filterExperts = DOM.filterExperts?.checked;
      const filterMunicipal = DOM.filterMunicipal?.checked;
      const filterCertified = DOM.filterCertified?.checked;
      
      if (!paginatedList && (filterArchitects || filterExperts || filterMunicipal || filterCertified)) {
        filteredItems = filteredItems.filter((user) => {
          const certificate = user.certificate || user.certificate_info || {};
          const certLevel = certificate.level || '';
          const hasCertificate = !!certificate.level;
          
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
      updateNavBadge(globalUnseenUsers == null
        ? cachedItems.some((user) => user.has_unseen_statements) : globalUnseenUsers > 0);
    }

    function updateUserDisplay(card, user) {
      const name = card.querySelector('.user-name');
      if (name) name.textContent = `${user.first_name || ''} ${user.last_name || ''}`.trim() || '(უსახელო)';
      for (const field of ['personal_id', 'phone', 'code', 'email', 'created_at']) {
        const node = card.querySelector(`[data-user-field="${field}"]`);
        if (node) node.textContent = field === 'created_at' ? formatDateTime(user[field]) : user[field] || '';
      }
      const admin = card.querySelector('.chk-admin');
      if (admin && !adminRoleSavingIds.has(String(user.id))) admin.checked = !!(user.is_admin || user.is_founder);
      syncExamControls(card, user);
      const filename = card.querySelector('.photo-filename');
      if (filename) filename.textContent = user.photo_filename || '—';
      const deletePhoto = card.querySelector('.photo-delete-btn');
      if (deletePhoto) deletePhoto.style.display = user.photo_filename ? 'inline-flex' : 'none';
      updateUserCardColor(user.id, user.certificate || user.certificate_info, false);
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
      on(DOM.filterArchitects, 'change', () => {
        // Ensure only one certificate filter is active at a time
        if (DOM.filterArchitects?.checked) {
          if (DOM.filterExperts) DOM.filterExperts.checked = false;
          if (DOM.filterMunicipal) DOM.filterMunicipal.checked = false;
          if (DOM.filterCertified) DOM.filterCertified.checked = false;
        }
        return render();
      });
      on(DOM.filterExperts, 'change', () => {
        if (DOM.filterExperts?.checked) {
          if (DOM.filterArchitects) DOM.filterArchitects.checked = false;
          if (DOM.filterMunicipal) DOM.filterMunicipal.checked = false;
          if (DOM.filterCertified) DOM.filterCertified.checked = false;
        }
        return render();
      });
      on(DOM.filterMunicipal, 'change', () => {
        if (DOM.filterMunicipal?.checked) {
          if (DOM.filterArchitects) DOM.filterArchitects.checked = false;
          if (DOM.filterExperts) DOM.filterExperts.checked = false;
          if (DOM.filterCertified) DOM.filterCertified.checked = false;
        }
        return render();
      });
      on(DOM.filterCertified, 'change', () => {
        if (DOM.filterCertified?.checked) {
          if (DOM.filterArchitects) DOM.filterArchitects.checked = false;
          if (DOM.filterExperts) DOM.filterExperts.checked = false;
          if (DOM.filterMunicipal) DOM.filterMunicipal.checked = false;
        }
        return render();
      });
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
        if (globalUnseenUsers != null) {
          globalUnseenUsers = Math.max(0, globalUnseenUsers + Number(!!hasUnseen) - Number(!!existing.has_unseen_statements));
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
      updateNavBadge(globalUnseenUsers == null
        ? cachedItems.some((item) => item.has_unseen_statements) : globalUnseenUsers > 0);
      if (paginatedList) void render({ preserveExisting: true, keepPage: true });
    }

    function updateUserCardColor(userId, certificateData, refresh = true) {
      if (refresh) statementsStateVersion += 1;
      mergeCachedUser({ id: userId, certificate: certificateData, certificate_info: certificateData });
      if (refresh && paginatedList) void render({ preserveExisting: true, keepPage: true });
      const card = findUserCard(userId);
      if (!card) return;
      
      const nameElement = card.querySelector('.user-name');
      if (!nameElement) return;
      
      // Determine color based on certificate level
      const certificate = certificateData || {};
      const certLevel = certificate.level || '';
      const certStatus = certificate.status || '';
      let nameColor = '#0f172a'; // default
      
      // გაუქმებული ან ვადაგასული სერტიფიკატი - ნაცრისფერი
      if (certStatus === 'suspended' || certStatus === 'expired') {
        nameColor = '#6b7280'; // ნაცრისფერი
      } else if (certLevel === 'architect' || certLevel === 'architect_expert') {
        nameColor = '#1e40af'; // დაბალანსებული ლურჯი
      } else if (certLevel === 'expert') {
        nameColor = '#991b1b'; // დაბალანსებული წითელი
      } else if (certLevel === 'municipal') {
        nameColor = '#065f46'; // დაბალანსებული მწვანე
      }
      
      nameElement.style.color = nameColor;
      
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
        updateNavBadge(!!data?.has_unseen);
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

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
    } = context;
    const { onShowResults, onShowStatements, onShowCertificate, onShowMultiApartmentResults, onShowMultiFunctionalResults } = context;
    const navLinks = DOM.navLinks || [];

    let cachedItems = [];
    let editActiveUser = null;
    let editInitialValues = null;
    let editInitialCode = '';
    let editSubmitting = false;

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

    async function fetchUsers() {
      if (!DOM.usersGrid) return { items: [] };
      const params = new URLSearchParams();
      const search = String(DOM.usersSearch?.value || '').trim();
      if (search) params.set('search', search);
      if (DOM.onlyAdmins?.checked) params.set('only_admins', 'true');
      params.set('sort', DOM.usersSort?.value || 'date_desc');
      const response = await fetch(`${API_BASE}/admin/users?${params.toString()}`, {
        headers: { ...getAdminHeaders(), ...getActorHeaders() },
      });
      if (!response.ok) throw new Error('users failed');
      return await response.json();
    }

    function userRowHTML(user) {
      const fullNameRaw = `${(user.first_name || '').trim()} ${(user.last_name || '').trim()}`.trim() || '(უსახელო)';
      const founderRow = !!user.is_founder;
      const canEdit = isFounderActor();
      const checked = founderRow ? 'checked' : (user.is_admin ? 'checked' : '');
      const disabled = founderRow ? 'disabled' : (isFounderActor() ? '' : 'disabled');
      // exam_permission: მთავარ ადმინს ყოველთვის true, სხვა ადმინებს თუ is_admin = true, მაშინ exam_permission-იც true
      const examChecked = founderRow ? 'checked' : (user.exam_permission ? 'checked' : '');
      const examDisabled = founderRow ? 'disabled' : '';
      const safeId = escapeHtml(user.id);
      const safeFullName = escapeHtml(fullNameRaw);
      const safePersonalId = escapeHtml(user.personal_id || '');
      const safePhone = escapeHtml(user.phone || '');
      const safeCode = escapeHtml(user.code || '');
      const safeEmail = escapeHtml(user.email || '');
      const safeRegistered = escapeHtml(formatDateTime(user.created_at));
      
      // Determine certificate level color
      const certificate = user.certificate || user.certificate_info || {};
      const certLevel = certificate.level || '';
      let nameColor = '#0f172a'; // default
      if (certLevel === 'architect' || certLevel === 'architect_expert') {
        nameColor = '#2563eb'; // მკვეთრი ლურჯი
      } else if (certLevel === 'expert') {
        nameColor = '#dc2626'; // მკვეთრი წითელი
      }
      
      return `
        <div class="block-tile block-card${user.has_unseen_statements ? ' has-new-statements' : ''}" data-id="${safeId}">
          <div class="block-head user-block-head">
            <div class="user-name" style="font-size:16px;font-weight:700;color:${nameColor};">${safeFullName}</div>
            <div class="user-controls">
              <label class="user-checkbox-label" title="${founderRow ? 'მუდმივი ადმინი' : 'ადმინი'}">
                <input type="checkbox" class="chk-admin" ${checked} ${disabled} />
                <span>ადმინი</span>
              </label>
              <label class="user-checkbox-label" title="გამოცდა">
                <input type="checkbox" class="chk-exam" ${examChecked} ${examDisabled} />
                <span>გამოცდა</span>
              </label>
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
                      <div>პირადი №: <strong>${safePersonalId}</strong></div>
                      <div>ტელეფონი: <strong>${safePhone}</strong></div>
                      <div>კოდი: <strong style="color:#6d28d9;">${safeCode}</strong></div>
                      <div>მაილი: <strong style="color:#065f46;">${safeEmail}</strong></div>
                      <div>რეგისტრაცია: <strong>${safeRegistered}</strong></div>
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
              </div>
            </div>
          </div>
        </div>`;
    }

    function mountUserCard(card, user) {
      const toggle = card.querySelector('.head-toggle');
      toggle?.addEventListener('click', () => {
        const isOpen = card.classList.contains('open');
        card.classList.toggle('open', !isOpen);
        card.querySelector('.block-questions')?.setAttribute('aria-hidden', isOpen ? 'true' : 'false');
      });

      const checkbox = card.querySelector('.chk-admin');
      if (checkbox) {
        checkbox.addEventListener('change', async (event) => {
          const id = card.dataset.id;
          const desired = !!event.target.checked;
          if (!global.confirm('დარწმუნებული ხართ, რომ შეცვალოთ ადმინის სტატუსი?')) {
            event.target.checked = !desired;
            return;
          }
          try {
            const response = await fetch(`${API_BASE}/admin/users/${id}/admin`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', ...getAdminHeaders(), ...getActorHeaders() },
              body: JSON.stringify({ is_admin: desired }),
            });
            if (!response.ok) throw new Error('failed');
          } catch {
            event.target.checked = !desired;
            alert('ვერ შეინახა სტატუსი');
          }
        });
      }

      const examCheckbox = card.querySelector('.chk-exam');
      if (examCheckbox) {
        examCheckbox.addEventListener('change', async (event) => {
          const id = card.dataset.id;
          const desired = !!event.target.checked;
          try {
            const response = await fetch(`${API_BASE}/admin/users/${id}/exam-permission`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', ...getAdminHeaders(), ...getActorHeaders() },
              body: JSON.stringify({ exam_permission: desired }),
            });
            if (!response.ok) throw new Error('failed');
          } catch {
            event.target.checked = !desired;
            alert('ვერ შეინახა გამოცდის უფლება');
          }
        });
      }

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
            card.remove();
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
            if (photoFilename) photoFilename.textContent = '—';
            photoDeleteBtn.style.display = 'none';
            showToast('ფოტო წაიშალა');
          } catch {
            alert('ფოტოს წაშლა ვერ შესრულდა');
          }
        });
      }
    }

    function setCardUnseenState(card, hasUnseen) {
      if (!card) return;
      card.classList.toggle('has-new-statements', !!hasUnseen);
      const announcementsButton = card.querySelector('.btn-user-announcements');
      if (announcementsButton) {
        announcementsButton.classList.toggle('has-new-statements', !!hasUnseen);
      }
    }

    function drawUsers(items) {
      if (!DOM.usersGrid) return;
      DOM.usersGrid.innerHTML = '';
      cachedItems = items || [];
      
      // Apply certificate filters
      let filteredItems = items || [];
      const filterArchitects = DOM.filterArchitects?.checked;
      const filterExperts = DOM.filterExperts?.checked;
      const filterCertified = DOM.filterCertified?.checked;
      
      if (filterArchitects || filterExperts || filterCertified) {
        filteredItems = filteredItems.filter((user) => {
          const certificate = user.certificate || user.certificate_info || {};
          const certLevel = certificate.level || '';
          const hasCertificate = !!certificate.level;
          
          if (filterCertified) {
            return hasCertificate && (certLevel === 'architect' || certLevel === 'expert');
          }
          if (filterArchitects) {
            return certLevel === 'architect' || certLevel === 'architect_expert';
          }
          if (filterExperts) {
            return certLevel === 'expert';
          }
          return true;
        });
      }
      
      filteredItems.forEach((user) => {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = userRowHTML(user);
        const card = wrapper.firstElementChild;
        if (card) {
          card.dataset.unseenCount = String(user.unseen_statement_count || 0);
          setCardUnseenState(card, user.has_unseen_statements);
          mountUserCard(card, user);
          DOM.usersGrid.appendChild(card);
        }
      });
      updateNavBadge(cachedItems.some((user) => user.has_unseen_statements));
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
        const nextItems = cachedItems.map((item) => (String(item.id) === String(data.id) ? { ...item, ...data } : item));
        drawUsers(nextItems);
        showToast('მონაცემები წარმატებით განახლდა');
        closeEditModal();
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

    async function render() {
      if (!DOM.usersGrid) return;
      DOM.usersGrid.innerHTML = '';
      try {
        const data = await fetchUsers();
        cachedItems = Array.isArray(data?.items) ? data.items : [];
        drawUsers(cachedItems);
      } catch {
        DOM.usersGrid.innerHTML = '<div class="block-tile">ჩატვირთვის შეცდომა</div>';
      }
    }

    function init() {
      on(DOM.usersSearch, 'input', render);
      on(DOM.usersSort, 'change', render);
      on(DOM.onlyAdmins, 'change', render);
      on(DOM.filterArchitects, 'change', () => {
        // Ensure only one certificate filter is active at a time
        if (DOM.filterArchitects?.checked) {
          if (DOM.filterExperts) DOM.filterExperts.checked = false;
          if (DOM.filterCertified) DOM.filterCertified.checked = false;
        }
        render();
      });
      on(DOM.filterExperts, 'change', () => {
        if (DOM.filterExperts?.checked) {
          if (DOM.filterArchitects) DOM.filterArchitects.checked = false;
          if (DOM.filterCertified) DOM.filterCertified.checked = false;
        }
        render();
      });
      on(DOM.filterCertified, 'change', () => {
        if (DOM.filterCertified?.checked) {
          if (DOM.filterArchitects) DOM.filterArchitects.checked = false;
          if (DOM.filterExperts) DOM.filterExperts.checked = false;
        }
        render();
      });
      setupEditModal();
    }

    function updateUserUnseenStatus(userId, hasUnseen, count) {
      const card = DOM.usersGrid?.querySelector(`.block-card[data-id="${userId}"]`);
      if (!card) return;
      setCardUnseenState(card, hasUnseen);
      card.dataset.unseenCount = String(count || 0);
      const index = cachedItems.findIndex((item) => String(item.id) === String(userId));
      if (index !== -1) {
        cachedItems[index] = {
          ...cachedItems[index],
          has_unseen_statements: !!hasUnseen,
          unseen_statement_count: count || 0,
        };
      }
      updateNavBadge(cachedItems.some((item) => item.has_unseen_statements));
    }

    function updateUserCardColor(userId, certificateData) {
      const card = DOM.usersGrid?.querySelector(`.block-card[data-id="${userId}"]`);
      if (!card) return;
      
      const nameElement = card.querySelector('.user-name');
      if (!nameElement) return;
      
      // Determine color based on certificate level
      const certificate = certificateData || {};
      const certLevel = certificate.level || '';
      let nameColor = '#0f172a'; // default
      if (certLevel === 'architect' || certLevel === 'architect_expert') {
        nameColor = '#2563eb'; // მკვეთრი ლურჯი
      } else if (certLevel === 'expert') {
        nameColor = '#dc2626'; // მკვეთრი წითელი
      }
      
      nameElement.style.color = nameColor;
      
      // Update cached data
      const index = cachedItems.findIndex((item) => String(item.id) === String(userId));
      if (index !== -1) {
        cachedItems[index] = {
          ...cachedItems[index],
          certificate: certificateData,
          certificate_info: certificateData,
        };
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
      try {
        const response = await fetch(`${API_BASE}/admin/statements/summary`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) throw new Error('summary failed');
        const data = await response.json();
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
        
        // Build results HTML
        let html = `<div style="max-height:400px;overflow-y:auto;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <thead>
              <tr style="background:#f3f4f6;">
                <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e7eb;">თარიღი</th>
                <th style="padding:8px;text-align:left;border-bottom:2px solid #e5e7eb;">პროექტი</th>
                <th style="padding:8px;text-align:center;border-bottom:2px solid #e5e7eb;">პროცენტი</th>
                <th style="padding:8px;text-align:center;border-bottom:2px solid #e5e7eb;">არასწორი</th>
              </tr>
            </thead>
            <tbody>`;
        
        items.forEach((item) => {
          const date = new Date(item.createdAt).toLocaleString('ka-GE');
          const percentColor = item.percentage >= 75 ? '#22c55e' : item.percentage >= 70 ? '#eab308' : '#ef4444';
          const wrongColor = item.wrongCount <= 1 ? '#22c55e' : item.wrongCount === 2 ? '#eab308' : '#ef4444';
          
          html += `<tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:8px;">${date}</td>
            <td style="padding:8px;">${item.projectName || item.projectCode}</td>
            <td style="padding:8px;text-align:center;font-weight:bold;color:${percentColor}">${item.percentage.toFixed(1)}%</td>
            <td style="padding:8px;text-align:center;font-weight:bold;color:${wrongColor}">${item.wrongCount}</td>
          </tr>`;
        });
        
        html += '</tbody></table></div>';
        
        // Show in modal
        const userName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'მომხმარებელი';
        showModal(`მრავალბინიანი: ${userName}`, html);
        
      } catch (e) {
        console.error('Error fetching multi-apartment results:', e);
        alert('შედეგების ჩატვირთვა ვერ მოხერხდა');
      }
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
            <h3 style="margin:0;font-size:18px;color:#1f2937;">${title}</h3>
            <button id="close-ma-modal" style="background:none;border:none;font-size:24px;cursor:pointer;color:#6b7280;">&times;</button>
          </div>
          <div style="padding:20px;">${content}</div>
        </div>
      `;
      
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
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createUsersModule = createUsersModule;
})(window);

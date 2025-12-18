document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === 'string')
    ? window.APP_CONFIG.API_BASE
    : 'http://127.0.0.1:8000';
  const SAVED_EMAIL_KEY = 'savedEmail';
  const FOUNDER_EMAIL = 'naormala@gmail.com';

  const DOM = {
    usersGrid: document.getElementById('usersGrid'),
    usersSearch: document.getElementById('usersSearch'),
    usersSort: document.getElementById('usersSort'),
    onlyAdmins: document.getElementById('onlyAdmins'),
    deleteAllBtn: document.getElementById('btnDeleteAllUsers'),
  };

  const utils = {
    on: (element, event, handler) => element && element.addEventListener(event, handler),
    formatDateTime: (iso) => {
      try {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return String(iso || '');
        const pad = (value) => String(value).padStart(2, '0');
        return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
      } catch {
        return String(iso || '');
      }
    },
  };

  const state = {
    items: [],
    loading: false,
  };

  const access = {
    isFounderActor() {
      return (localStorage.getItem(SAVED_EMAIL_KEY) || '').toLowerCase() === FOUNDER_EMAIL.toLowerCase();
    },
    adminHeaders() {
      const actor = (localStorage.getItem(SAVED_EMAIL_KEY) || '').trim();
      return actor ? { 'x-actor-email': actor } : {};
    },
  };

  const api = {
    async fetchUsers() {
      const params = new URLSearchParams();
      const query = String(DOM.usersSearch?.value || '').trim();
      if (query) params.set('search', query);
      if (DOM.onlyAdmins?.checked) params.set('only_admins', 'true');
      params.set('sort', DOM.usersSort?.value || 'date_desc');
      const response = await fetch(`${API_BASE}/admin/users?${params.toString()}`, {
        headers: { ...access.adminHeaders() },
      });
      if (!response.ok) throw new Error('users failed');
      return await response.json();
    },
    async updateAdminStatus(id, isAdmin) {
      const response = await fetch(`${API_BASE}/admin/users/${id}/admin`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...access.adminHeaders() },
        body: JSON.stringify({ is_admin: !!isAdmin }),
      });
      if (!response.ok) throw new Error('failed');
    },
    async updateExamPermission(id, hasPermission) {
      const response = await fetch(`${API_BASE}/admin/users/${id}/exam-permission`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...access.adminHeaders() },
        body: JSON.stringify({ exam_permission: !!hasPermission }),
      });
      if (!response.ok) throw new Error('failed');
    },
    async deleteUser(id) {
      const response = await fetch(`${API_BASE}/admin/users/${id}`, {
        method: 'DELETE',
        headers: { ...access.adminHeaders() },
      });
      if (!response.ok) throw new Error('failed');
    },
    async deleteAllUsers() {
      const response = await fetch(`${API_BASE}/admin/users`, {
        method: 'DELETE',
        headers: { ...access.adminHeaders() },
      });
      if (!response.ok) throw new Error('failed');
    },
  };

  const render = {
    setGridContent(html) {
      if (DOM.usersGrid) DOM.usersGrid.innerHTML = html;
    },
    showLoading() {
      render.setGridContent('<div class="block-tile">იტვირთება...</div>');
    },
    showError() {
      render.setGridContent('<div class="block-tile">ჩატვირთვის შეცდომა</div>');
    },
    showEmpty() {
      render.setGridContent('<div class="block-tile">მონაცემები ვერ მოიძებნა</div>');
    },
    drawUsers(items) {
      if (!DOM.usersGrid) return;
      if (!items.length) {
        render.showEmpty();
        return;
      }
      const fragment = document.createDocumentFragment();
      items.forEach((user) => {
        const card = createUserCard(user);
        if (card) fragment.appendChild(card);
      });
      DOM.usersGrid.innerHTML = '';
      DOM.usersGrid.appendChild(fragment);
    },
  };

  function createUserCard(user) {
    const founderRow = !!user.is_founder;
    const isChecked = founderRow ? 'checked' : (user.is_admin ? 'checked' : '');
    const disableAdminToggle = founderRow ? 'disabled' : (access.isFounderActor() ? '' : 'disabled');
    const disableDelete = founderRow || !access.isFounderActor() ? 'disabled' : '';
    // exam_permission: მთავარ ადმინს ყოველთვის true, სხვა ადმინებს თუ is_admin = true, მაშინ exam_permission-იც true
    const examChecked = founderRow ? 'checked' : (user.exam_permission ? 'checked' : '');
    const disableExamToggle = founderRow ? 'disabled' : '';
    const fullName = `${(user.first_name || '').trim()} ${(user.last_name || '').trim()}`.trim() || '(უსახელო)';

    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div class="block-tile block-card" data-id="${user.id}">
        <div class="block-head" style="grid-template-columns:auto 1fr auto;">
          <div class="block-order"></div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <div style="font-size:16px;font-weight:700;color:#0f172a;">${fullName}</div>
            <div style="font-size:13px;color:#525252;">
              <span style="color:#6d28d9;font-weight:600;">კოდი: ${user.code || ''}</span> •
              <span style="color:#065f46;">${user.email || ''}</span>
            </div>
          </div>
          <button class="head-toggle" type="button" aria-expanded="false">▾</button>
        </div>
        <div class="block-questions" aria-hidden="true">
          <div class="questions-list">
            <div class="question-card open">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;padding:12px;">
                <div>
                  <div style="font-weight:700;color:#065f46;margin-bottom:8px;">კონტაქტი</div>
                  <div style="color:#525252;font-size:13px;line-height:1.8;">
                    <div>პირადი №: <strong>${user.personal_id}</strong></div>
                    <div>ტელეფონი: <strong>${user.phone}</strong></div>
                    <div>რეგისტრაცია: <strong>${utils.formatDateTime(user.created_at)}</strong></div>
                  </div>
                </div>
                <div>
                  <div style="font-weight:700;color:#065f46;margin-bottom:8px;">ქმედებები</div>
                  <div style="display:flex;flex-direction:column;gap:8px;">
                    <label class="a-correct-wrap" title="${founderRow ? 'მუდმივი ადმინი' : 'ადმინი'}" style="width:fit-content;">
                      <input type="checkbox" class="chk-admin" ${isChecked} ${disableAdminToggle} />
                      <span>ადმინი</span>
                    </label>
                    <label class="a-correct-wrap" title="გამოცდა" style="width:fit-content;">
                      <input type="checkbox" class="chk-exam" ${examChecked} ${disableExamToggle} />
                      <span>გამოცდა</span>
                    </label>
                    <button class="btn-delete" ${disableDelete} style="width:fit-content;padding:6px 12px;">წაშლა</button>
                  </div>
                  <div class="user-action-buttons" style="margin-top:12px;display:flex;flex-direction:column;gap:6px;width:100%;">
                    <button class="btn-user-announcements" style="width:100%;padding:6px 12px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;font-size:13px;">განცხადებები</button>
                    <button class="btn-user-results" style="width:100%;padding:6px 12px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;font-size:13px;">გამოცდის შედეგები</button>
                    <button class="btn-user-certificate" style="width:100%;padding:6px 12px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;font-size:13px;">სერტიფიკატი</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const card = wrapper.firstElementChild;
    if (!card) return null;

    const toggle = card.querySelector('.head-toggle');
    toggle?.addEventListener('click', () => {
      const open = card.classList.contains('open');
      card.classList.toggle('open', !open);
      card.querySelector('.block-questions')?.setAttribute('aria-hidden', open ? 'true' : 'false');
    });

    const announcementsBtn = card.querySelector('.btn-user-announcements');
    const actionsWrap = card.querySelector('.user-action-buttons');
    if (actionsWrap && !actionsWrap.querySelector('.btn-user-results')) {
      const resultsFallbackBtn = document.createElement('button');
      resultsFallbackBtn.className = 'btn-user-results';
      resultsFallbackBtn.type = 'button';
      resultsFallbackBtn.textContent = 'გამოცდის შედეგები';
      resultsFallbackBtn.style.cssText = 'width:100%;padding:6px 12px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;font-size:13px;';
      actionsWrap.appendChild(resultsFallbackBtn);
    }
    if (actionsWrap && !actionsWrap.querySelector('.btn-user-certificate')) {
      const certFallbackBtn = document.createElement('button');
      certFallbackBtn.className = 'btn-user-certificate';
      certFallbackBtn.type = 'button';
      certFallbackBtn.textContent = 'სერტიფიკატი';
      certFallbackBtn.style.cssText = 'width:100%;padding:6px 12px;border:2px solid #c7d2fe;border-radius:6px;background:#eef2ff;cursor:pointer;font-size:13px;';
      actionsWrap.appendChild(certFallbackBtn);
    }
    const resultsBtns = card.querySelectorAll('.btn-user-results');
    const certificateBtns = card.querySelectorAll('.btn-user-certificate');
    announcementsBtn?.addEventListener('click', () => alert('განცხადებები — მალე დაემატება'));
    resultsBtns?.forEach((btn) => btn.addEventListener('click', () => alert('გამოცდის შედეგები — მალე დაემატება')));
    certificateBtns?.forEach((btn) => btn.addEventListener('click', () => alert('სერტიფიკატი — მალე დაემატება')));

    const adminCheckbox = card.querySelector('.chk-admin');
    if (adminCheckbox && !adminCheckbox.disabled) {
      adminCheckbox.addEventListener('change', async (event) => {
        const want = !!event.target.checked;
        if (!confirm('ნამდვილად გსურთ ადმინის სტატუსის ცვლილება?')) {
          event.target.checked = !want;
          return;
        }
        try {
          await api.updateAdminStatus(user.id, want);
          mutateUser(user.id, { is_admin: want });
        } catch {
          event.target.checked = !want;
          alert('ვერ შეინახა სტატუსი');
        }
      });
    }

    const examCheckbox = card.querySelector('.chk-exam');
    if (examCheckbox && !examCheckbox.disabled) {
      examCheckbox.addEventListener('change', async (event) => {
        const want = !!event.target.checked;
        try {
          await api.updateExamPermission(user.id, want);
          mutateUser(user.id, { exam_permission: want });
        } catch {
          event.target.checked = !want;
          alert('ვერ შეინახა გამოცდის უფლება');
        }
      });
    }

    const deleteBtn = card.querySelector('.btn-delete');
    if (deleteBtn && !deleteBtn.disabled) {
      deleteBtn.addEventListener('click', async () => {
        if (!confirm('ნამდვილად გსურთ ჩანაწერის წაშლა?')) return;
        try {
          await api.deleteUser(user.id);
          removeUser(user.id);
        } catch {
          alert('წაშლა ვერ შესრულდა');
        }
      });
    }

    return card;
  }

  function mutateUser(id, patch) {
    const index = state.items.findIndex((user) => user.id === id);
    if (index !== -1) {
      state.items[index] = { ...state.items[index], ...patch };
    }
  }

  function removeUser(id) {
    state.items = state.items.filter((user) => user.id !== id);
    render.drawUsers(state.items);
  }

  async function renderUsers() {
    if (!DOM.usersGrid) return;
    state.loading = true;
    render.showLoading();
    try {
      const data = await api.fetchUsers();
      state.items = Array.isArray(data?.items) ? data.items : [];
      render.drawUsers(state.items);
    } catch {
      render.showError();
    } finally {
      state.loading = false;
    }
  }

  async function handleDeleteAll() {
    if (!DOM.deleteAllBtn) return;
    if (!access.isFounderActor()) {
      alert('ამ ქმედების შესრულება შეუძლია მხოლოდ დამფუძნებელს');
      return;
    }
    if (!confirm('ნამდვილად გსურთ ყველა რეგისტრაციის წაშლა (დამფუძნებლის გარდა)?')) return;
    DOM.deleteAllBtn.disabled = true;
    try {
      await api.deleteAllUsers();
      try {
        localStorage.removeItem('currentUser');
        localStorage.setItem('authLoggedIn', 'false');
        localStorage.removeItem('usedCodes');
      } catch {}
      await renderUsers();
      alert('ყველა რეგისტრაცია წაიშალა (დამფუძნებლის გარდა).');
    } catch {
      alert('სულად წაშლა ვერ შესრულდა');
    } finally {
      DOM.deleteAllBtn.disabled = false;
    }
  }

  function initDeleteAllButton() {
    if (!DOM.deleteAllBtn) return;
    if (!access.isFounderActor()) {
      try {
        DOM.deleteAllBtn.setAttribute('disabled', '');
        DOM.deleteAllBtn.style.opacity = '.5';
        DOM.deleteAllBtn.style.cursor = 'not-allowed';
      } catch {}
    }
    utils.on(DOM.deleteAllBtn, 'click', handleDeleteAll);
  }

  function initFilters() {
    utils.on(DOM.usersSearch, 'input', () => renderUsers());
    utils.on(DOM.usersSort, 'change', () => renderUsers());
    utils.on(DOM.onlyAdmins, 'change', () => renderUsers());
  }

  initDeleteAllButton();
  initFilters();
  renderUsers();
});



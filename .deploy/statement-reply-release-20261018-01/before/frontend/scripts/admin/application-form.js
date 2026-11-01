(function (global) {
  function createApplicationFormModule(context) {
    const {
      API_BASE,
      on,
      escapeHtml,
      showToast,
      handleAdminErrorResponse,
      getAdminHeaders,
      getActorHeaders,
    } = context;

    const state = { file: null, loading: false };

    const DOM = {
      grid: document.getElementById('appFormGrid'),
      addBtn: document.getElementById('appFormAddBtn'),
      fileInput: document.getElementById('appFormFileInput'),
    };

    function ensureDom() {
      return !!(DOM.grid && DOM.addBtn && DOM.fileInput);
    }

    async function fetchInfo() {
      if (!DOM.grid) return;
      state.loading = true;
      DOM.grid.innerHTML = '<div class="empty-state">იტვირთება...</div>';
      try {
        const response = await fetch(`${API_BASE}/application-form/info`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) {
          DOM.grid.innerHTML = '<div class="empty-state">ჩატვირთვა ვერ მოხერხდა</div>';
          return;
        }
        const data = await response.json();
        state.file = data.available ? data : null;
        render();
      } catch {
        DOM.grid.innerHTML = '<div class="empty-state">ჩატვირთვა ვერ მოხერხდა</div>';
      } finally {
        state.loading = false;
      }
    }

    function render() {
      if (!DOM.grid) return;
      DOM.grid.innerHTML = '';

      if (!state.file) {
        const empty = document.createElement('div');
        empty.className = 'empty-state block-tile add-tile';
        empty.innerHTML = '<span class="add-text">განაცხადის ფორმა არ არის ატვირთული</span>';
        DOM.grid.appendChild(empty);
        return;
      }

      const card = document.createElement('div');
      card.className = 'block-tile block-card guide-video-card app-file-card';
      card.innerHTML = `
        <div class="block-head guide-head app-file-head">
          <div class="guide-title app-file-title">
            <div class="guide-filename" title="${escapeHtml(state.file.filename || '')}">${escapeHtml(state.file.filename || 'ფაილი')}</div>
          </div>
          <div class="app-file-actions">
            <button class="primary-btn app-form-download" type="button">ჩამოტვირთვა</button>
            <button class="head-delete app-form-delete" type="button" aria-label="ფაილის წაშლა" title="წაშლა">×</button>
          </div>
        </div>
      `;
      DOM.grid.appendChild(card);
    }

    async function uploadFile(file) {
      if (!file) return;
      try {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch(`${API_BASE}/admin/application-form`, {
          method: 'POST',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
          body: formData,
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ფაილის ატვირთვა ვერ მოხერხდა', showToast);
          return;
        }
        showToast('განაცხადის ფორმა ატვირთულია', 'success');
        await fetchInfo();
      } catch {
        showToast('ფაილის ატვირთვა ვერ მოხერხდა', 'error');
      }
    }

    async function deleteFile() {
      if (!global.confirm('დარწმუნებული ხართ, რომ გინდათ განაცხადის ფორმის წაშლა?')) return;
      try {
        const response = await fetch(`${API_BASE}/admin/application-form`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok && response.status !== 404) {
          await handleAdminErrorResponse(response, 'წაშლა ვერ მოხერხდა', showToast);
          return;
        }
        state.file = null;
        render();
        showToast('განაცხადის ფორმა წაიშალა', 'success');
      } catch {
        showToast('წაშლა ვერ მოხერხდა', 'error');
      }
    }

    function downloadFile() {
      if (!state.file) return;
      const link = document.createElement('a');
      link.href = `${API_BASE}/application-form/download`;
      link.download = state.file.filename || 'form';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    function handleGridClick(event) {
      const target = event.target;
      if (!target) return;
      if (target.classList.contains('app-form-delete')) {
        void deleteFile();
        return;
      }
      if (target.classList.contains('app-form-download')) {
        downloadFile();
        return;
      }
    }

    function init() {
      if (!ensureDom()) return;
      on(DOM.grid, 'click', handleGridClick);
      on(DOM.addBtn, 'click', () => DOM.fileInput?.click());
      on(DOM.fileInput, 'change', (e) => {
        const file = e.target?.files?.[0];
        e.target.value = '';
        void uploadFile(file);
      });
      void fetchInfo();
    }

    return {
      init,
      render: () => render(),
      reload: () => fetchInfo(),
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createApplicationFormModule = createApplicationFormModule;
})(window);

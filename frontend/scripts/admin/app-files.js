(function (global) {
  function createAppFilesModule(context) {
    const {
      API_BASE,
      on,
      escapeHtml,
      showToast,
      handleAdminErrorResponse,
      getAdminHeaders,
      getActorHeaders,
      formatDateTime,
    } = context;

    const state = {
      items: [],
      loading: false,
    };

    const DOM = {
      grid: document.getElementById('appFilesGrid'),
      addBtn: document.getElementById('appAddFileBtn'),
      fileInput: document.getElementById('appFileInput'),
    };

    function ensureDom() {
      return !!(DOM.grid && DOM.addBtn && DOM.fileInput);
    }

    async function fetchFiles() {
      if (!DOM.grid) return;
      state.loading = true;
      DOM.grid.innerHTML = '<div class="empty-state">იტვირთება...</div>';
      try {
        const response = await fetch(`${API_BASE}/admin/app-files`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ფაილების ჩატვირთვა ვერ მოხერხდა', showToast);
          return;
        }
        const data = await response.json();
        state.items = Array.isArray(data) ? data.slice() : [];
        render();
      } catch {
        showToast('ფაილების ჩატვირთვა ვერ მოხერხდა', 'error');
        DOM.grid.innerHTML = '<div class="empty-state statements-error">ფაილების ჩატვირთვა ვერ მოხერხდა</div>';
      } finally {
        state.loading = false;
      }
    }

    function formatSize(bytes) {
      if (!bytes || typeof bytes !== 'number' || bytes <= 0) return '';
      const mb = bytes / (1024 * 1024);
      if (mb < 1) {
        const kb = bytes / 1024;
        return `${kb.toFixed(0)} KB`;
      }
      return `${mb.toFixed(1)} MB`;
    }

    function render() {
      if (!DOM.grid) return;
      DOM.grid.innerHTML = '';

      if (!state.items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state block-tile add-tile';
        empty.innerHTML = '<span class="add-text">ამ ეტაპზე საინსტალაციო ფაილი არ არის ატვირთული</span>';
        DOM.grid.appendChild(empty);
        return;
      }

      state.items.forEach((file) => {
        const card = document.createElement('div');
        card.className = 'block-tile block-card guide-video-card app-file-card';
        card.dataset.fileId = String(file.id);

        const sizeText = formatSize(file.size_bytes);
        const createdText = file.created_at ? formatDateTime(file.created_at) : '';

        card.innerHTML = `
          <div class="block-head guide-head app-file-head">
            <div class="guide-title app-file-title">
              <div class="guide-filename" title="${escapeHtml(file.filename || '')}">
                ${escapeHtml(file.filename || 'ფაილი')}
              </div>
              <div class="guide-meta">
                ${sizeText ? `<span>${escapeHtml(sizeText)}</span>` : ''}
                ${createdText ? `<span>${escapeHtml(createdText)}</span>` : ''}
              </div>
            </div>
            <div class="app-file-actions">
              <button class="primary-btn app-file-download" type="button">ჩამოტვირთვა</button>
              <button class="head-delete" type="button" aria-label="ფაილის წაშლა" title="წაშლა">×</button>
            </div>
          </div>
        `;

        DOM.grid.appendChild(card);
      });
    }

    async function uploadFile(file) {
      if (!file) return;
      try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`${API_BASE}/admin/app-files`, {
          method: 'POST',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
          body: formData,
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ფაილის ატვირთვა ვერ მოხერხდა', showToast);
          return;
        }
        const created = await response.json();
        if (!created || typeof created !== 'object') {
          await fetchFiles();
          showToast('ფაილი ატვირთულია', 'success');
          return;
        }
        state.items.unshift(created);
        render();
        showToast('ფაილი ატვირთულია', 'success');
      } catch {
        showToast('ფაილის ატვირთვა ვერ მოხერხდა', 'error');
      }
    }

    async function deleteFile(fileId) {
      const confirmDelete = global.confirm('დარწმუნებული ხართ, რომ გინდათ ფაილის წაშლა?');
      if (!confirmDelete) return;

      try {
        const response = await fetch(`${API_BASE}/admin/app-files/${encodeURIComponent(fileId)}`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok && response.status !== 404) {
          await handleAdminErrorResponse(response, 'ფაილის წაშლა ვერ მოხერხდა', showToast);
          return;
        }
        state.items = state.items.filter((f) => String(f.id) !== String(fileId));
        render();
        showToast('ფაილი წაიშალა', 'success');
      } catch {
        showToast('ფაილის წაშლა ვერ მოხერხდა', 'error');
      }
    }

    async function downloadFile(fileId) {
      const file = state.items.find((f) => String(f.id) === String(fileId));
      if (!file) return;

      try {
        const response = await fetch(`${API_BASE}${file.url}`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) {
          showToast('ფაილის ჩამოტვირთვა ვერ მოხერხდა', 'error');
          return;
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = file.filename || 'file';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } catch {
        showToast('ფაილის ჩამოტვირთვა ვერ მოხერხდა', 'error');
      }
    }

    function handleGridClick(event) {
      const target = event.target;
      if (!target || !DOM.grid) return;

      const card = target.closest('.app-file-card');
      if (!card) return;

      const fileId = card.dataset.fileId;
      if (!fileId) return;

      if (target.classList.contains('head-delete')) {
        void deleteFile(fileId);
        return;
      }

      if (target.classList.contains('app-file-download')) {
        downloadFile(fileId);
        return;
      }
    }

    function handleAddClick() {
      if (!DOM.fileInput) return;
      DOM.fileInput.click();
    }

    function handleFileChange(event) {
      const input = event.target;
      if (!input || !input.files || !input.files.length) return;
      const file = input.files[0];
      // Reset input so selecting the same file again still fires change
      input.value = '';
      void uploadFile(file);
    }

    function init() {
      if (!ensureDom()) return;
      on(DOM.grid, 'click', handleGridClick);
      on(DOM.addBtn, 'click', handleAddClick);
      on(DOM.fileInput, 'change', handleFileChange);
      void fetchFiles();
    }

    return {
      init,
      render: () => render(),
      reload: () => fetchFiles(),
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createAppFilesModule = createAppFilesModule;
})(window);

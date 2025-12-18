(function (global) {
  function createGuideModule(context) {
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
      grid: document.getElementById('guideVideosGrid'),
      addBtn: document.getElementById('guideAddVideoBtn'),
      fileInput: document.getElementById('guideFileInput'),
    };

    function ensureDom() {
      return !!(DOM.grid && DOM.addBtn && DOM.fileInput);
    }

    function sortItems() {
      state.items.sort((a, b) => {
        const ao = typeof a.order_index === 'number' ? a.order_index : 0;
        const bo = typeof b.order_index === 'number' ? b.order_index : 0;
        if (ao !== bo) return ao - bo;
        return a.id - b.id;
      });
    }

    async function fetchVideos() {
      if (!DOM.grid) return;
      state.loading = true;
      DOM.grid.innerHTML = '<div class="empty-state">იტვირთება...</div>';
      try {
        const response = await fetch(`${API_BASE}/admin/guide/videos`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ვიდეოების ჩატვირთვა ვერ მოხერხდა', showToast);
          return;
        }
        const data = await response.json();
        state.items = Array.isArray(data) ? data.slice() : [];
        sortItems();
        render();
      } catch {
        showToast('ვიდეოების ჩატვირთვა ვერ მოხერხდა', 'error');
        DOM.grid.innerHTML = '<div class="empty-state statements-error">ვიდეოების ჩატვირთვა ვერ მოხერხდა</div>';
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
        empty.innerHTML = '<span class="add-text">ამ ეტაპზე გზამკვლევის ვიდეო არ არის ატვირთული</span>';
        DOM.grid.appendChild(empty);

        return;
      }

      state.items.forEach((video, index) => {
        const card = document.createElement('div');
        card.className = 'block-tile block-card guide-video-card';
        card.dataset.videoId = String(video.id);

        const atTop = index === 0;
        const atBottom = index === state.items.length - 1;
        const sizeText = formatSize(video.size_bytes);
        const createdText = video.created_at ? formatDateTime(video.created_at) : '';

        card.innerHTML = `
          <div class="block-head guide-head">
            <div class="block-order">
              <button class="i-btn up" ${atTop ? 'disabled' : ''} aria-label="ზემოთ">▲</button>
              <button class="i-btn down" ${atBottom ? 'disabled' : ''} aria-label="ქვემოთ">▼</button>
            </div>
            <div class="guide-title">
              <div class="guide-filename" title="${escapeHtml(video.filename || '')}">
                ${escapeHtml(video.filename || 'ვიდეო')}
              </div>
              <div class="guide-meta">
                ${sizeText ? `<span>${escapeHtml(sizeText)}</span>` : ''}
                ${createdText ? `<span>${escapeHtml(createdText)}</span>` : ''}
              </div>
            </div>
            <button class="head-delete" type="button" aria-label="ვიდეოს წაშლა" title="წაშლა">×</button>
          </div>
        `;

        DOM.grid.appendChild(card);
      });
    }

    async function uploadVideo(file) {
      if (!file) return;
      try {
        const maxBytes = 1024 * 1024 * 1024; // 1GB
        if (file.size && file.size > maxBytes) {
          showToast('ვიდეოს მაქსიმალური ზომა 1GB-ია', 'error');
          return;
        }

        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch(`${API_BASE}/admin/guide/videos`, {
          method: 'POST',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
          body: formData,
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ვიდეოს ატვირთვა ვერ მოხერხდა', showToast);
          return;
        }
        const created = await response.json();
        if (!created || typeof created !== 'object') {
          await fetchVideos();
          showToast('ვიდეო ატვირთულია', 'success');
          return;
        }
        state.items.push(created);
        sortItems();
        render();
        showToast('ვიდეო ატვირთულია', 'success');
      } catch {
        showToast('ვიდეოს ატვირთვა ვერ მოხერხდა', 'error');
      }
    }

    async function persistOrder() {
      if (!state.items.length) return;
      try {
        const payload = {
          ids: state.items.map((v) => v.id),
        };
        const response = await fetch(`${API_BASE}/admin/guide/videos/reorder`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ვიდეოების დალაგება ვერ შენახულია', showToast);
        }
      } catch {
        showToast('ვიდეოების დალაგება ვერ შენახულია', 'error');
      }
    }

    function moveVideo(videoId, direction) {
      const index = state.items.findIndex((v) => String(v.id) === String(videoId));
      if (index === -1) return;

      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= state.items.length) return;

      const tmp = state.items[targetIndex];
      state.items[targetIndex] = state.items[index];
      state.items[index] = tmp;

      render();
      void persistOrder();
    }

    async function deleteVideo(videoId) {
      const confirmDelete = global.confirm('დარწმუნებული ხართ, რომ გინდათ ვიდეოს წაშლა?');
      if (!confirmDelete) return;

      try {
        const response = await fetch(`${API_BASE}/admin/guide/videos/${encodeURIComponent(videoId)}`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok && response.status !== 404) {
          await handleAdminErrorResponse(response, 'ვიდეოს წაშლა ვერ მოხერხდა', showToast);
          return;
        }
        state.items = state.items.filter((v) => String(v.id) !== String(videoId));
        render();
        showToast('ვიდეო წაიშალა', 'success');
      } catch {
        showToast('ვიდეოს წაშლა ვერ მოხერხდა', 'error');
      }
    }

    function handleGridClick(event) {
      const target = event.target;
      if (!target || !DOM.grid) return;

      const card = target.closest('.guide-video-card');
      if (!card) return;

      const videoId = card.dataset.videoId;
      if (!videoId) return;

      if (target.classList.contains('up')) {
        moveVideo(videoId, 'up');
        return;
      }

      if (target.classList.contains('down')) {
        moveVideo(videoId, 'down');
        return;
      }

      if (target.classList.contains('head-delete')) {
        void deleteVideo(videoId);
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
      void uploadVideo(file);
    }

    function init() {
      if (!ensureDom()) return;
      on(DOM.grid, 'click', handleGridClick);
      on(DOM.addBtn, 'click', handleAddClick);
      on(DOM.fileInput, 'change', handleFileChange);
      void fetchVideos();
    }

    return {
      init,
      render: () => render(),
      reload: () => fetchVideos(),
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createGuideModule = createGuideModule;
})(window);



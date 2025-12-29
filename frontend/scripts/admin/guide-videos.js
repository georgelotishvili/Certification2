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
      saveTimer: null,
    };

    const DOM = {
      grid: document.getElementById('guideVideosGrid'),
    };

    function ensureDom() {
      return !!DOM.grid;
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

    function isEditorFocused() {
      const active = document.activeElement;
      if (!active || !DOM.grid) return false;
      if (!DOM.grid.contains(active)) return false;
      return active.tagName === 'TEXTAREA' || active.tagName === 'INPUT';
    }

    function render() {
      if (!DOM.grid) return;
      DOM.grid.innerHTML = '';

      state.items.forEach((video, index) => {
        const card = document.createElement('div');
        card.className = 'block-tile block-card guide-video-card';
        card.dataset.videoId = String(video.id);

        const atTop = index === 0;
        const atBottom = index === state.items.length - 1;
        const createdText = video.created_at ? formatDateTime(video.created_at) : '';

        card.innerHTML = `
          <div class="block-head guide-head">
            <div class="block-order">
              <button class="i-btn up" ${atTop ? 'disabled' : ''} aria-label="ზემოთ">▲</button>
              <button class="i-btn down" ${atBottom ? 'disabled' : ''} aria-label="ქვემოთ">▼</button>
            </div>
            <div class="guide-fields">
              <input class="guide-title-input" type="text" placeholder="სათაური" value="${escapeHtml(video.title || '')}" aria-label="ვიდეოს სათაური" />
              <input class="guide-url-input" type="url" placeholder="ვიდეოს ლინკი (YouTube, Vimeo...)" value="${escapeHtml(video.url || '')}" aria-label="ვიდეოს ლინკი" />
            </div>
            <div class="guide-actions">
              ${createdText ? `<span class="guide-meta">${escapeHtml(createdText)}</span>` : ''}
              <button class="head-delete" type="button" aria-label="ვიდეოს წაშლა" title="წაშლა">×</button>
            </div>
          </div>
        `;

        DOM.grid.appendChild(card);
      });

      // Add tile at the end
      const addTile = document.createElement('button');
      addTile.type = 'button';
      addTile.id = 'addGuideVideoTile';
      addTile.className = 'block-tile add-tile';
      addTile.setAttribute('aria-label', 'ვიდეოს დამატება');
      addTile.innerHTML = '<span class="add-icon" aria-hidden="true">+</span><span class="add-text">ვიდეოს დამატება</span>';
      DOM.grid.appendChild(addTile);
    }

    function scheduleSave(videoId) {
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => {
        state.saveTimer = null;
        void saveVideo(videoId);
      }, 400);
    }

    async function saveVideo(videoId) {
      const video = state.items.find((v) => String(v.id) === String(videoId));
      if (!video) return;

      try {
        const response = await fetch(`${API_BASE}/admin/guide/videos/${encodeURIComponent(videoId)}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({
            title: video.title || '',
            url: video.url || '',
          }),
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ვიდეოს შენახვა ვერ მოხერხდა', showToast);
        }
      } catch {
        showToast('ვიდეოს შენახვა ვერ მოხერხდა', 'error');
      }
    }

    async function createVideo() {
      try {
        const response = await fetch(`${API_BASE}/admin/guide/videos`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({
            title: '',
            url: '',
          }),
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ვიდეოს დამატება ვერ მოხერხდა', showToast);
          return;
        }
        const created = await response.json();
        if (created && typeof created === 'object') {
          state.items.push(created);
          sortItems();
          render();
          // Focus the URL input of the new card
          const newCard = DOM.grid?.querySelector?.(`.guide-video-card[data-video-id="${created.id}"]`);
          if (newCard) {
            const urlInput = newCard.querySelector('.guide-url-input');
            if (urlInput) {
              urlInput.focus();
              urlInput.select();
            }
          }
        }
      } catch {
        showToast('ვიდეოს დამატება ვერ მოხერხდა', 'error');
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

      // Add video tile
      if (target.closest?.('#addGuideVideoTile')) {
        void createVideo();
        return;
      }

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

    function handleGridFocusout(event) {
      const target = event.target;
      if (!target) return;

      const card = target.closest?.('.guide-video-card');
      if (!card) return;

      const videoId = card.dataset.videoId;
      if (!videoId) return;

      const video = state.items.find((v) => String(v.id) === String(videoId));
      if (!video) return;

      if (target.classList.contains('guide-title-input')) {
        video.title = String(target.value || '').trim();
        scheduleSave(videoId);
        return;
      }

      if (target.classList.contains('guide-url-input')) {
        video.url = String(target.value || '').trim();
        scheduleSave(videoId);
        return;
      }
    }

    function handleGridKeydown(event) {
      if (event.key !== 'Enter') return;
      const target = event.target;
      if (!target) return;

      const card = target.closest?.('.guide-video-card');
      if (!card) return;

      const videoId = card.dataset.videoId;
      if (!videoId) return;

      const video = state.items.find((v) => String(v.id) === String(videoId));
      if (!video) return;

      if (target.classList.contains('guide-title-input')) {
        video.title = String(target.value || '').trim();
        scheduleSave(videoId);
        return;
      }

      if (target.classList.contains('guide-url-input')) {
        video.url = String(target.value || '').trim();
        scheduleSave(videoId);
        return;
      }
    }

    function init() {
      if (!ensureDom()) return;
      on(DOM.grid, 'click', handleGridClick);
      on(DOM.grid, 'focusout', handleGridFocusout);
      on(DOM.grid, 'keydown', handleGridKeydown);
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

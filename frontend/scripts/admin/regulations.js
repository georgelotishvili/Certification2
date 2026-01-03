(function (global) {
  function createRegulationsModule(context) {
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
      grid: document.getElementById('regulationsGrid'),
      fileInput: null, // შეიქმნება დინამიურად
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

    async function fetchRegulations() {
      if (!DOM.grid) return;
      state.loading = true;
      DOM.grid.innerHTML = '<div class="empty-state">იტვირთება...</div>';
      try {
        const response = await fetch(`${API_BASE}/admin/regulations`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'რეგულაციების ჩატვირთვა ვერ მოხერხდა', showToast);
          return;
        }
        const data = await response.json();
        state.items = Array.isArray(data) ? data.slice() : [];
        sortItems();
        render();
      } catch {
        showToast('რეგულაციების ჩატვირთვა ვერ მოხერხდა', 'error');
        DOM.grid.innerHTML = '<div class="empty-state statements-error">რეგულაციების ჩატვირთვა ვერ მოხერხდა</div>';
      } finally {
        state.loading = false;
      }
    }

    function render() {
      if (!DOM.grid) return;
      DOM.grid.innerHTML = '';

      state.items.forEach((reg, index) => {
        const card = document.createElement('div');
        card.className = 'block-tile block-card regulation-card';
        card.dataset.regulationId = String(reg.id);

        const atTop = index === 0;
        const atBottom = index === state.items.length - 1;
        const hasFile = !!reg.filename;

        card.innerHTML = `
          <div class="block-head guide-head">
            <div class="block-order">
              <button class="i-btn up" ${atTop ? 'disabled' : ''} aria-label="ზემოთ">▲</button>
              <button class="i-btn down" ${atBottom ? 'disabled' : ''} aria-label="ქვემოთ">▼</button>
            </div>
            <div class="guide-fields regulation-fields">
              <input class="guide-title-input regulation-title-input" type="text" placeholder="დადგენილების სახელი" value="${escapeHtml(reg.title || '')}" aria-label="დადგენილების სახელი" />
              <div class="regulation-file-row">
                ${hasFile 
                  ? `<button class="regulation-change-file" type="button">შეცვლა</button>
                     <span class="regulation-filename">${escapeHtml(reg.filename)}</span>`
                  : `<button class="regulation-upload-btn" type="button">ფაილის ატვირთვა</button>`
                }
              </div>
            </div>
            <div class="guide-actions regulation-actions">
              <button class="head-delete" type="button" aria-label="დადგენილების წაშლა" title="წაშლა">×</button>
            </div>
          </div>
        `;

        DOM.grid.appendChild(card);
      });

      // Add tile at the end
      const addTile = document.createElement('button');
      addTile.type = 'button';
      addTile.id = 'addRegulationTile';
      addTile.className = 'block-tile add-tile';
      addTile.setAttribute('aria-label', 'დადგენილების დამატება');
      addTile.innerHTML = '<span class="add-icon" aria-hidden="true">+</span><span class="add-text">დადგენილების დამატება</span>';
      DOM.grid.appendChild(addTile);

      // Hidden file input for uploads
      if (!DOM.fileInput) {
        DOM.fileInput = document.createElement('input');
        DOM.fileInput.type = 'file';
        DOM.fileInput.accept = '.pdf';
        DOM.fileInput.style.display = 'none';
        DOM.fileInput.id = 'regulationFileInput';
        document.body.appendChild(DOM.fileInput);
        on(DOM.fileInput, 'change', handleFileSelect);
      }
    }

    function scheduleSave(regulationId) {
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => {
        state.saveTimer = null;
        void saveRegulation(regulationId);
      }, 400);
    }

    async function saveRegulation(regulationId) {
      const reg = state.items.find((r) => String(r.id) === String(regulationId));
      if (!reg) return;

      try {
        const response = await fetch(`${API_BASE}/admin/regulations/${encodeURIComponent(regulationId)}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({
            title: reg.title || '',
          }),
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'დადგენილების შენახვა ვერ მოხერხდა', showToast);
        }
      } catch {
        showToast('დადგენილების შენახვა ვერ მოხერხდა', 'error');
      }
    }

    // Track which regulation is being uploaded to
    let uploadingToId = null;

    function handleFileSelect(event) {
      const file = event.target.files?.[0];
      if (!file) return;
      
      if (uploadingToId) {
        void uploadFileToRegulation(uploadingToId, file);
      }
      
      // Clear input for next use
      event.target.value = '';
      uploadingToId = null;
    }

    async function createRegulation() {
      try {
        const response = await fetch(`${API_BASE}/admin/regulations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({
            title: '',
          }),
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'დადგენილების დამატება ვერ მოხერხდა', showToast);
          return;
        }
        const created = await response.json();
        if (created && typeof created === 'object') {
          state.items.push(created);
          sortItems();
          render();
          // Focus the title input of the new card
          const newCard = DOM.grid?.querySelector?.(`.regulation-card[data-regulation-id="${created.id}"]`);
          if (newCard) {
            const titleInput = newCard.querySelector('.regulation-title-input');
            if (titleInput) {
              titleInput.focus();
              titleInput.select();
            }
          }
        }
      } catch {
        showToast('დადგენილების დამატება ვერ მოხერხდა', 'error');
      }
    }

    async function uploadFileToRegulation(regulationId, file) {
      if (!file || !regulationId) return;

      const formData = new FormData();
      formData.append('file', file);

      try {
        const response = await fetch(`${API_BASE}/admin/regulations/${encodeURIComponent(regulationId)}/upload`, {
          method: 'POST',
          headers: {
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: formData,
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ფაილის ატვირთვა ვერ მოხერხდა', showToast);
          return;
        }
        const updated = await response.json();
        if (updated && typeof updated === 'object') {
          // Update the item in state
          const idx = state.items.findIndex((r) => String(r.id) === String(regulationId));
          if (idx !== -1) {
            state.items[idx] = { ...state.items[idx], ...updated };
          }
          render();
          showToast('ფაილი აიტვირთა', 'success');
        }
      } catch {
        showToast('ფაილის ატვირთვა ვერ მოხერხდა', 'error');
      }
    }

    async function persistOrder() {
      if (!state.items.length) return;
      try {
        const payload = {
          ids: state.items.map((r) => r.id),
        };
        const response = await fetch(`${API_BASE}/admin/regulations/reorder`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'დადგენილებების დალაგება ვერ შენახულია', showToast);
        }
      } catch {
        showToast('დადგენილებების დალაგება ვერ შენახულია', 'error');
      }
    }

    function moveRegulation(regulationId, direction) {
      const index = state.items.findIndex((r) => String(r.id) === String(regulationId));
      if (index === -1) return;

      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= state.items.length) return;

      const tmp = state.items[targetIndex];
      state.items[targetIndex] = state.items[index];
      state.items[index] = tmp;

      render();
      void persistOrder();
    }

    async function deleteRegulation(regulationId) {
      const confirmDelete = global.confirm('დარწმუნებული ხართ, რომ გინდათ დადგენილების წაშლა?');
      if (!confirmDelete) return;

      try {
        const response = await fetch(`${API_BASE}/admin/regulations/${encodeURIComponent(regulationId)}`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok && response.status !== 404) {
          await handleAdminErrorResponse(response, 'დადგენილების წაშლა ვერ მოხერხდა', showToast);
          return;
        }
        state.items = state.items.filter((r) => String(r.id) !== String(regulationId));
        render();
        showToast('დადგენილება წაიშალა', 'success');
      } catch {
        showToast('დადგენილების წაშლა ვერ მოხერხდა', 'error');
      }
    }

    function handleGridClick(event) {
      const target = event.target;
      if (!target || !DOM.grid) return;

      // Add regulation tile - create new empty regulation
      if (target.closest?.('#addRegulationTile')) {
        void createRegulation();
        return;
      }

      const card = target.closest('.regulation-card');
      if (!card) return;

      const regulationId = card.dataset.regulationId;
      if (!regulationId) return;

      if (target.classList.contains('up')) {
        moveRegulation(regulationId, 'up');
        return;
      }

      if (target.classList.contains('down')) {
        moveRegulation(regulationId, 'down');
        return;
      }

      if (target.classList.contains('head-delete')) {
        void deleteRegulation(regulationId);
        return;
      }

      // Upload file button or change file button
      if (target.classList.contains('regulation-upload-btn') || target.classList.contains('regulation-change-file')) {
        uploadingToId = regulationId;
        DOM.fileInput?.click();
        return;
      }
    }

    function handleGridFocusout(event) {
      const target = event.target;
      if (!target) return;

      const card = target.closest?.('.regulation-card');
      if (!card) return;

      const regulationId = card.dataset.regulationId;
      if (!regulationId) return;

      const reg = state.items.find((r) => String(r.id) === String(regulationId));
      if (!reg) return;

      if (target.classList.contains('regulation-title-input')) {
        reg.title = String(target.value || '').trim();
        scheduleSave(regulationId);
        return;
      }
    }

    function handleGridKeydown(event) {
      if (event.key !== 'Enter') return;
      const target = event.target;
      if (!target) return;

      const card = target.closest?.('.regulation-card');
      if (!card) return;

      const regulationId = card.dataset.regulationId;
      if (!regulationId) return;

      const reg = state.items.find((r) => String(r.id) === String(regulationId));
      if (!reg) return;

      if (target.classList.contains('regulation-title-input')) {
        reg.title = String(target.value || '').trim();
        scheduleSave(regulationId);
        return;
      }
    }

    function init() {
      if (!ensureDom()) return;
      on(DOM.grid, 'click', handleGridClick);
      on(DOM.grid, 'focusout', handleGridFocusout);
      on(DOM.grid, 'keydown', handleGridKeydown);
      void fetchRegulations();
    }

    return {
      init,
      render: () => render(),
      reload: () => fetchRegulations(),
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createRegulationsModule = createRegulationsModule;
})(window);


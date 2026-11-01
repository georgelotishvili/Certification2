(function (global) {
  function createExamSettingsModule(context) {
    const {
      DOM,
      API_BASE,
      on,
      getAdminHeaders,
      getActorHeaders,
      showToast,
      escapeHtml,
      handleAdminErrorResponse,
    } = context;

    const state = {
      gatePwdTimer: null,
      settings: null,
      taxonomy: [],
    };

    function populateFields(settings) {
      if (!settings) return;
      if (DOM.durationInput) {
        const value = Number(settings.durationMinutes || 0);
        DOM.durationInput.value = value ? String(value) : '';
      }
      if (DOM.gatePwdInput) DOM.gatePwdInput.value = settings.gatePassword || '';
    }

    async function fetchSettings() {
      const response = await fetch(`${API_BASE}/admin/exam/settings`, {
        headers: { ...getAdminHeaders(), ...getActorHeaders() },
      });
      if (!response.ok) throw new Error('failed');
      return await response.json();
    }

    function normalizeTaxonomy(chapters) {
      return (Array.isArray(chapters) ? chapters : []).map((chapter) => ({
        id: Number(chapter?.id) || 0,
        name: String(chapter?.name || ''),
        orderIndex: Number(chapter?.orderIndex ?? chapter?.order_index) || 0,
        subchapters: (Array.isArray(chapter?.subchapters) ? chapter.subchapters : []).map((subchapter) => ({
          id: Number(subchapter?.id) || 0,
          chapterId: Number(subchapter?.chapterId ?? subchapter?.chapter_id) || 0,
          name: String(subchapter?.name || ''),
          orderIndex: Number(subchapter?.orderIndex ?? subchapter?.order_index) || 0,
        })).filter((subchapter) => subchapter.id > 0),
      })).filter((chapter) => chapter.id > 0);
    }

    function renderTaxonomyControls() {
      if (!DOM.taxonomyChapterSelect || !DOM.taxonomySubchapterSelect) return;
      const selectedChapter = Number(DOM.taxonomyChapterSelect.value) || 0;
      const selectedSubchapter = Number(DOM.taxonomySubchapterSelect.value) || 0;
      if (selectedChapter && !state.taxonomy.some((chapter) => chapter.id === selectedChapter)) {
        DOM.taxonomyChapterSelect.value = '';
      }

      const activeChapterId = Number(DOM.taxonomyChapterSelect.value) || 0;
      const activeChapter = state.taxonomy.find((chapter) => chapter.id === activeChapterId);
      const subchapters = activeChapter?.subchapters || [];
      if (selectedSubchapter && !subchapters.some((subchapter) => subchapter.id === selectedSubchapter)) {
        DOM.taxonomySubchapterSelect.value = '';
      }
      const activeSubchapterId = Number(DOM.taxonomySubchapterSelect.value) || 0;
      const activeSubchapter = subchapters.find((subchapter) => subchapter.id === activeSubchapterId);

      if (DOM.taxonomyChapterLabel) DOM.taxonomyChapterLabel.textContent = activeChapter?.name || 'თავი';
      if (DOM.taxonomySubchapterLabel) DOM.taxonomySubchapterLabel.textContent = activeSubchapter?.name || (activeChapterId ? 'ქვეთავი' : 'ჯერ აირჩიეთ თავი');
      if (DOM.taxonomySubchapterDropdown) DOM.taxonomySubchapterDropdown.disabled = !activeChapterId;
      if (DOM.taxonomyOpenSubchapterCreator) DOM.taxonomyOpenSubchapterCreator.disabled = !activeChapterId;

      renderTaxonomyMenu(DOM.taxonomyChapterMenu, state.taxonomy, 'chapter', activeChapterId, 'თავები არ არის');
      renderTaxonomyMenu(DOM.taxonomySubchapterMenu, subchapters, 'subchapter', activeSubchapterId, activeChapterId ? 'ქვეთავები არ არის' : 'ჯერ აირჩიეთ თავი');
    }

    function renderTaxonomyMenu(menu, items, type, selectedId, emptyLabel) {
      if (!menu) return;
      if (!items.length) {
        menu.innerHTML = `<div class="taxonomy-menu-empty">${escapeHtml(emptyLabel)}</div>`;
        return;
      }
      menu.innerHTML = items.map((item) => `
        <div class="taxonomy-menu-row${item.id === selectedId ? ' selected' : ''}" role="option" aria-selected="${item.id === selectedId ? 'true' : 'false'}">
          <button class="taxonomy-menu-item" type="button" data-action="select-taxonomy" data-type="${escapeHtml(type)}" data-id="${escapeHtml(item.id)}">
            ${escapeHtml(item.name)}
          </button>
          <button class="taxonomy-menu-delete" type="button" data-action="delete-taxonomy" data-type="${escapeHtml(type)}" data-id="${escapeHtml(item.id)}" data-name="${escapeHtml(item.name)}" aria-label="წაშლა" title="წაშლა">×</button>
        </div>
      `).join('');
    }

    async function loadTaxonomy() {
      try {
        const response = await fetch(`${API_BASE}/taxonomy/chapters`);
        if (!response.ok) throw new Error('failed');
        state.taxonomy = normalizeTaxonomy(await response.json());
      } catch {
        state.taxonomy = [];
        showToast('თავების ჩატვირთვა ვერ მოხერხდა', 'error');
      }
      renderTaxonomyControls();
    }

    function notifyTaxonomyUpdated(detail = {}) {
      global.dispatchEvent(new CustomEvent('exam-taxonomy-updated', { detail }));
    }

    function normalizeName(value) {
      return String(value || '').trim().toLowerCase();
    }

    function findChapterByName(name) {
      const target = normalizeName(name);
      return state.taxonomy.find((chapter) => normalizeName(chapter.name) === target) || null;
    }

    function findSubchapterByName(chapterId, name) {
      const target = normalizeName(name);
      const chapter = state.taxonomy.find((item) => item.id === Number(chapterId));
      return (chapter?.subchapters || []).find((subchapter) => normalizeName(subchapter.name) === target) || null;
    }

    function setCreatorOpen(creator, input, open) {
      if (!creator) return;
      creator.hidden = !open;
      if (open && input) {
        setTimeout(() => input.focus(), 0);
      }
    }

    function toggleChapterCreator() {
      setCreatorOpen(DOM.taxonomyChapterCreator, DOM.taxonomyChapterName, !!DOM.taxonomyChapterCreator?.hidden);
      setCreatorOpen(DOM.taxonomySubchapterCreator, DOM.taxonomySubchapterName, false);
      closeTaxonomyMenus();
    }

    function toggleSubchapterCreator() {
      const chapterId = Number(DOM.taxonomyChapterSelect?.value || 0);
      if (!chapterId) {
        showToast('ჯერ აირჩიეთ თავი', 'error');
        return;
      }
      setCreatorOpen(DOM.taxonomySubchapterCreator, DOM.taxonomySubchapterName, !!DOM.taxonomySubchapterCreator?.hidden);
      setCreatorOpen(DOM.taxonomyChapterCreator, DOM.taxonomyChapterName, false);
      closeTaxonomyMenus();
    }

    function closeChapterCreator() {
      if (DOM.taxonomyChapterName) DOM.taxonomyChapterName.value = '';
      setCreatorOpen(DOM.taxonomyChapterCreator, DOM.taxonomyChapterName, false);
    }

    function closeSubchapterCreator() {
      if (DOM.taxonomySubchapterName) DOM.taxonomySubchapterName.value = '';
      setCreatorOpen(DOM.taxonomySubchapterCreator, DOM.taxonomySubchapterName, false);
    }

    function setTaxonomyMenuOpen(type, open) {
      const menu = type === 'chapter' ? DOM.taxonomyChapterMenu : DOM.taxonomySubchapterMenu;
      const dropdown = type === 'chapter' ? DOM.taxonomyChapterDropdown : DOM.taxonomySubchapterDropdown;
      if (!menu || !dropdown) return;
      menu.hidden = !open;
      dropdown.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function closeTaxonomyMenus() {
      setTaxonomyMenuOpen('chapter', false);
      setTaxonomyMenuOpen('subchapter', false);
    }

    function toggleTaxonomyMenu(type) {
      if (type === 'subchapter' && !Number(DOM.taxonomyChapterSelect?.value || 0)) {
        showToast('ჯერ აირჩიეთ თავი', 'error');
        return;
      }
      const menu = type === 'chapter' ? DOM.taxonomyChapterMenu : DOM.taxonomySubchapterMenu;
      const willOpen = !!menu?.hidden;
      closeChapterCreator();
      closeSubchapterCreator();
      closeTaxonomyMenus();
      setTaxonomyMenuOpen(type, willOpen);
    }

    function selectTaxonomyItem(type, id) {
      if (type === 'chapter') {
        if (DOM.taxonomyChapterSelect) DOM.taxonomyChapterSelect.value = String(id || '');
        if (DOM.taxonomySubchapterSelect) DOM.taxonomySubchapterSelect.value = '';
      } else if (type === 'subchapter' && DOM.taxonomySubchapterSelect) {
        DOM.taxonomySubchapterSelect.value = String(id || '');
      }
      closeTaxonomyMenus();
      renderTaxonomyControls();
    }

    function confirmTaxonomyDelete(type, name) {
      const first = type === 'chapter'
        ? `ეს თავი "${name}" წაიშლება თავის ქვეთავებთან ერთად. აღდგენას ვეღარ შეძლებთ. ასევე წაიშლება ყველა საგამოცდო ბლოკი, კითხვა და პასუხი, რომელიც ამ თავზე იყო მიბმული. გსურთ გაგრძელება?`
        : `ეს ქვეთავი "${name}" წაიშლება. აღდგენას ვეღარ შეძლებთ. ასევე წაიშლება ყველა საგამოცდო ბლოკი, კითხვა და პასუხი, რომელიც ამ ქვეთავზე იყო მიბმული. გსურთ გაგრძელება?`;
      if (!global.confirm(first)) return false;
      return global.confirm('დარწმუნებული ხართ რომ ნამდვილად გსურთ წაშლა?');
    }

    async function deleteTaxonomyItem(type, id, name) {
      const numericId = Number(id) || 0;
      if (!numericId || !confirmTaxonomyDelete(type, name)) return;
      const url = type === 'chapter'
        ? `${API_BASE}/taxonomy/chapters/${numericId}`
        : `${API_BASE}/taxonomy/subchapters/${numericId}`;
      try {
        const response = await fetch(url, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'წაშლა ვერ მოხერხდა', showToast);
          return;
        }
        if (type === 'chapter' && DOM.taxonomyChapterSelect?.value === String(numericId)) {
          DOM.taxonomyChapterSelect.value = '';
          if (DOM.taxonomySubchapterSelect) DOM.taxonomySubchapterSelect.value = '';
        }
        if (type === 'subchapter' && DOM.taxonomySubchapterSelect?.value === String(numericId)) {
          DOM.taxonomySubchapterSelect.value = '';
        }
        closeTaxonomyMenus();
        await loadTaxonomy();
        notifyTaxonomyUpdated({ reloadBlocks: true });
        showToast(type === 'chapter' ? 'თავი წაშლილია' : 'ქვეთავი წაშლილია');
      } catch {
        showToast('წაშლა ვერ მოხერხდა', 'error');
      }
    }

    async function addChapter() {
      const name = String(DOM.taxonomyChapterName?.value || '').trim();
      if (!name) {
        showToast('ჩაწერეთ თავის სახელი', 'error');
        return;
      }
      try {
        const response = await fetch(`${API_BASE}/taxonomy/chapters`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAdminHeaders(), ...getActorHeaders() },
          body: JSON.stringify({ name }),
        });
        if (!response.ok) {
          if (response.status === 409) {
            await loadTaxonomy();
            const existing = findChapterByName(name);
            if (existing) {
              if (DOM.taxonomyChapterSelect) DOM.taxonomyChapterSelect.value = String(existing.id);
              if (DOM.taxonomyChapterName) DOM.taxonomyChapterName.value = '';
              renderTaxonomyControls();
              setCreatorOpen(DOM.taxonomyChapterCreator, DOM.taxonomyChapterName, false);
              notifyTaxonomyUpdated();
              showToast('ეს თავი უკვე არსებობს და არჩეულია');
              return;
            }
          }
          await handleAdminErrorResponse(response, 'თავის დამატება ვერ მოხერხდა', showToast);
          return;
        }
        const chapter = await response.json();
        if (DOM.taxonomyChapterName) DOM.taxonomyChapterName.value = '';
        await loadTaxonomy();
        if (DOM.taxonomyChapterSelect) DOM.taxonomyChapterSelect.value = String(chapter?.id || '');
        renderTaxonomyControls();
        setCreatorOpen(DOM.taxonomyChapterCreator, DOM.taxonomyChapterName, false);
        notifyTaxonomyUpdated();
        showToast('თავი დამატებულია');
      } catch {
        showToast('თავის დამატება ვერ მოხერხდა', 'error');
      }
    }

    async function addSubchapter() {
      const chapterId = Number(DOM.taxonomyChapterSelect?.value || 0);
      const name = String(DOM.taxonomySubchapterName?.value || '').trim();
      if (!chapterId) {
        showToast('აირჩიეთ თავი', 'error');
        return;
      }
      if (!name) {
        showToast('ჩაწერეთ ქვეთავის სახელი', 'error');
        return;
      }
      try {
        const response = await fetch(`${API_BASE}/taxonomy/subchapters`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getAdminHeaders(), ...getActorHeaders() },
          body: JSON.stringify({ chapterId, name }),
        });
        if (!response.ok) {
          if (response.status === 409) {
            await loadTaxonomy();
            if (DOM.taxonomyChapterSelect) DOM.taxonomyChapterSelect.value = String(chapterId);
            const existing = findSubchapterByName(chapterId, name);
            if (existing) {
              if (DOM.taxonomySubchapterSelect) DOM.taxonomySubchapterSelect.value = String(existing.id);
              if (DOM.taxonomySubchapterName) DOM.taxonomySubchapterName.value = '';
              renderTaxonomyControls();
              setCreatorOpen(DOM.taxonomySubchapterCreator, DOM.taxonomySubchapterName, false);
              notifyTaxonomyUpdated();
              showToast('ეს ქვეთავი უკვე არსებობს და არჩეულია');
              return;
            }
          }
          await handleAdminErrorResponse(response, 'ქვეთავის დამატება ვერ მოხერხდა', showToast);
          return;
        }
        const subchapter = await response.json();
        if (DOM.taxonomySubchapterName) DOM.taxonomySubchapterName.value = '';
        await loadTaxonomy();
        if (DOM.taxonomyChapterSelect) DOM.taxonomyChapterSelect.value = String(chapterId);
        if (DOM.taxonomySubchapterSelect) DOM.taxonomySubchapterSelect.value = String(subchapter?.id || '');
        renderTaxonomyControls();
        setCreatorOpen(DOM.taxonomySubchapterCreator, DOM.taxonomySubchapterName, false);
        notifyTaxonomyUpdated();
        showToast('ქვეთავი დამატებულია');
      } catch {
        showToast('ქვეთავის დამატება ვერ მოხერხდა', 'error');
      }
    }

    async function persistSettings(patch = {}, { notifyDuration = false, notifyPassword = false } = {}) {
      const current = state.settings || {};
      const payload = {
        examId: patch.examId ?? current.examId ?? 1,
        title: patch.title ?? current.title ?? '',
        durationMinutes: patch.durationMinutes ?? current.durationMinutes ?? 60,
        gatePassword: patch.gatePassword ?? current.gatePassword ?? '',
      };
      try {
        const response = await fetch(`${API_BASE}/admin/exam/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAdminHeaders(), ...getActorHeaders() },
          body: JSON.stringify(payload),
        });
        if (!response.ok) throw new Error('failed');
        const data = await response.json();
        state.settings = data;
        populateFields(state.settings);
        if (notifyDuration && DOM.durationFlash) {
          const value = Number(state.settings.durationMinutes || 0);
          DOM.durationFlash.textContent = `ხანგრძლივობა შეიცვალა: ${value} წუთი`;
          DOM.durationFlash.style.display = 'block';
          setTimeout(() => {
            if (DOM.durationFlash) DOM.durationFlash.style.display = 'none';
          }, 3000);
        }
        if (notifyPassword) {
          showToast('ადმინისტრატორის პაროლი შენახულია');
        }
      } catch {
        showToast('პარამეტრების შენახვა ვერ მოხერხდა', 'error');
      }
    }

    async function loadSettings() {
      try {
        state.settings = await fetchSettings();
      } catch {
        showToast('პარამეტრების ჩატვირთვა ვერ მოხერხდა', 'error');
        state.settings = { examId: 1, title: '', durationMinutes: 60, gatePassword: '' };
      }
      populateFields(state.settings);
    }

    function saveDuration() {
      const value = Number(DOM.durationInput?.value || 0);
      if (!value || value < 1) {
        alert('გთხოვთ შეიყვანოთ სწორი დრო (მინიმუმ 1 წუთი)');
        return;
      }
      void persistSettings({ durationMinutes: value }, { notifyDuration: true });
    }

    function saveGatePassword() {
      const value = String(DOM.gatePwdInput?.value || '').trim();
      if (!value) {
        showToast('გთხოვთ შეიყვანოთ პაროლი', 'error');
        return;
      }
      void persistSettings({ gatePassword: value }, { notifyPassword: true });
    }

    function handleGatePwdKeydown(event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      saveGatePassword();
    }

    function handleGatePwdInput() {
      clearTimeout(state.gatePwdTimer);
      state.gatePwdTimer = setTimeout(() => {
        const value = String(DOM.gatePwdInput?.value || '').trim();
        if (!value) return;
        void persistSettings({ gatePassword: value });
      }, 600);
    }

    function handleTaxonomyKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeChapterCreator();
        closeSubchapterCreator();
        return;
      }
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (event.target === DOM.taxonomyChapterName) {
        void addChapter();
        return;
      }
      if (event.target === DOM.taxonomySubchapterName) {
        void addSubchapter();
      }
    }

    function handleChapterChange() {
      renderTaxonomyControls();
      setCreatorOpen(DOM.taxonomySubchapterCreator, DOM.taxonomySubchapterName, false);
    }

    function handleTaxonomyMenuClick(event) {
      const actionTarget = event.target?.closest?.('[data-action]');
      if (!actionTarget) return;
      const type = actionTarget.dataset.type;
      const id = Number(actionTarget.dataset.id) || 0;
      if (!type || !id) return;
      event.preventDefault();
      event.stopPropagation();
      if (actionTarget.dataset.action === 'select-taxonomy') {
        selectTaxonomyItem(type, id);
        return;
      }
      if (actionTarget.dataset.action === 'delete-taxonomy') {
        void deleteTaxonomyItem(type, id, actionTarget.dataset.name || '');
      }
    }

    function handleOutsideTaxonomyClick(event) {
      if (event.target?.closest?.('.taxonomy-combo')) return;
      closeTaxonomyMenus();
    }

    function init() {
      void loadSettings();
      void loadTaxonomy();
      on(DOM.saveDurationBtn, 'click', saveDuration);
      on(DOM.gatePwdSaveBtn, 'click', saveGatePassword);
      on(DOM.gatePwdInput, 'keydown', handleGatePwdKeydown);
      on(DOM.gatePwdInput, 'input', handleGatePwdInput);
      on(DOM.taxonomyChapterDropdown, 'click', () => toggleTaxonomyMenu('chapter'));
      on(DOM.taxonomySubchapterDropdown, 'click', () => toggleTaxonomyMenu('subchapter'));
      on(DOM.taxonomyChapterMenu, 'click', handleTaxonomyMenuClick);
      on(DOM.taxonomySubchapterMenu, 'click', handleTaxonomyMenuClick);
      on(DOM.taxonomyOpenChapterCreator, 'click', toggleChapterCreator);
      on(DOM.taxonomyOpenSubchapterCreator, 'click', toggleSubchapterCreator);
      on(DOM.taxonomySaveChapterBtn, 'click', addChapter);
      on(DOM.taxonomySaveSubchapterBtn, 'click', addSubchapter);
      on(DOM.taxonomyCloseChapterCreator, 'click', closeChapterCreator);
      on(DOM.taxonomyCloseSubchapterCreator, 'click', closeSubchapterCreator);
      on(DOM.taxonomyChapterSelect, 'change', handleChapterChange);
      on(DOM.taxonomyChapterName, 'keydown', handleTaxonomyKeydown);
      on(DOM.taxonomySubchapterName, 'keydown', handleTaxonomyKeydown);
      document.addEventListener('click', handleOutsideTaxonomyClick);
    }

    return { init };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createExamSettingsModule = createExamSettingsModule;
})(window);



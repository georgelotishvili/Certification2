(function (global) {
  function createExamSettingsModule(context) {
    const {
      DOM,
      API_BASE,
      on,
      getAdminHeaders,
      getActorHeaders,
      showToast,
    } = context;

    const state = {
      gatePwdTimer: null,
      settings: null,
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

    function init() {
      void loadSettings();
      on(DOM.saveDurationBtn, 'click', saveDuration);
      on(DOM.gatePwdSaveBtn, 'click', saveGatePassword);
      on(DOM.gatePwdInput, 'keydown', handleGatePwdKeydown);
      on(DOM.gatePwdInput, 'input', handleGatePwdInput);
    }

    return { init };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createExamSettingsModule = createExamSettingsModule;
})(window);



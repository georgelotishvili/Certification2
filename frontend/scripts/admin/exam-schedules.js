(function (global) {
  function createExamSchedulesModule(context = {}) {
    const {
      API_BASE,
      getAdminHeaders = () => ({}),
      getActorHeaders = () => ({}),
      showToast = () => {},
      handleAdminErrorResponse = async () => {},
    } = context;
    const mountedPanels = new WeakMap();

    function mount(panel, user, { onChanged = () => {} } = {}) {
      if (!panel || user?.id == null) return { load: async () => {} };
      const mountToken = {};
      mountedPanels.set(panel, mountToken);
      const isCurrent = () => mountedPanels.get(panel) === mountToken;
      panel.innerHTML = `
        <h3 class="exam-schedule-title">გამოცდა</h3>
        <div class="exam-schedule-controls">
          <label class="exam-schedule-date-label">გამოცდის თარიღი
            <input class="exam-schedule-date users-filter-date" type="date" />
          </label>
          <label class="users-filter-label"><input class="exam-schedule-morning" type="checkbox" /><span>დილით</span></label>
          <label class="users-filter-label"><input class="exam-schedule-evening" type="checkbox" /><span>საღამოს</span></label>
        </div>
        <p class="exam-schedule-hint">აირჩიეთ თარიღი და მონიშნეთ ჯგუფი — ჩანაწერი შეინახება. ძველი ჩანაწერები ისტორიაში რჩება და მხოლოდ „წაშლა“ ღილაკით იშლება. გამოცდაზე დაშვება ცალკე, ხელით ირთვება.</p>
        <p class="exam-schedule-status" role="status" aria-live="polite"></p>
        <div class="exam-schedule-history" aria-label="გამოცდების დაგეგმვის ისტორია"></div>`;
      const dateInput = panel.querySelector('.exam-schedule-date');
      const morning = panel.querySelector('.exam-schedule-morning');
      const evening = panel.querySelector('.exam-schedule-evening');
      const history = panel.querySelector('.exam-schedule-history');
      const status = panel.querySelector('.exam-schedule-status');
      const endpoint = `${API_BASE}/admin/users/${encodeURIComponent(user.id)}/exam-schedules`;
      let items = [];
      let busy = false;

      function setStatus(message, isError = false) {
        status.textContent = message;
        status.classList.toggle('is-error', isError);
      }

      function setBusy(value) {
        busy = value;
        panel.setAttribute('aria-busy', String(value));
        [dateInput, morning, evening, ...history.querySelectorAll('.exam-schedule-delete')]
          .forEach((control) => { control.disabled = value; });
      }

      function renderHistory() {
        history.innerHTML = '';
        if (!items.length) {
          const empty = document.createElement('p');
          empty.className = 'exam-schedule-empty';
          empty.textContent = 'გამოცდა ჯერ არ არის დაგეგმილი.';
          history.appendChild(empty);
          return;
        }
        const sortedItems = [...items].sort((a, b) => (
          String(b.exam_date).localeCompare(String(a.exam_date))
          || String(a.period).localeCompare(String(b.period))
          || Number(b.id) - Number(a.id)
        ));
        sortedItems.forEach((item) => {
          const row = document.createElement('div');
          row.className = 'exam-schedule-row';
          const description = document.createElement('span');
          const dateParts = String(item.exam_date || '').split('-');
          const dateLabel = dateParts.length === 3 ? dateParts.reverse().join('-') : String(item.exam_date || '');
          const periodLabel = item.period === 'morning' ? 'დილით' : 'საღამოს';
          description.textContent = `${dateLabel} — ${periodLabel}`;
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.className = 'exam-schedule-delete';
          remove.dataset.id = String(item.id);
          remove.textContent = 'წაშლა';
          remove.setAttribute('aria-label', `${dateLabel} — ${periodLabel}: დაგეგმვის ჩანაწერის წაშლა`);
          remove.disabled = busy;
          remove.addEventListener('click', () => deleteSchedule(item));
          row.appendChild(description);
          row.appendChild(remove);
          history.appendChild(row);
        });
      }

      async function reportResponseError(response, message) {
        const fallback = response.status === 409
          ? 'ამ თარიღისა და ჯგუფის გამოცდა უკვე დაგეგმილია.' : message;
        setStatus(fallback, true);
        await handleAdminErrorResponse(response, fallback, showToast);
      }

      async function notifyChanged() {
        // Saving succeeded even if a later list refresh temporarily fails.
        try { await onChanged({ userId: user.id }); } catch {}
      }

      async function load() {
        if (busy || !isCurrent()) return;
        setBusy(true);
        setStatus('ისტორია იტვირთება...');
        try {
          const response = await fetch(endpoint, {
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          });
          if (!isCurrent()) return;
          if (!response.ok) {
            await reportResponseError(response, 'გამოცდების ისტორია ვერ ჩაიტვირთა. ხელახლა გახსენით ბარათი.');
            return;
          }
          const data = await response.json();
          if (!isCurrent()) return;
          items = Array.isArray(data?.items) ? data.items : [];
          renderHistory();
          setStatus('');
        } catch {
          if (isCurrent()) setStatus('გამოცდების ისტორია ვერ ჩაიტვირთა. ხელახლა გახსენით ბარათი.', true);
        } finally {
          if (isCurrent()) setBusy(false);
        }
      }

      function isValidDate(value) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const parsed = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
      }

      async function saveSchedule(period, checkbox) {
        if (busy || !checkbox.checked || !isCurrent()) return;
        const examDate = dateInput.value;
        if (!isValidDate(examDate)) {
          checkbox.checked = false;
          setStatus('ჯერ აირჩიეთ გამოცდის თარიღი.', true);
          dateInput.focus();
          return;
        }
        const other = period === 'morning' ? evening : morning;
        other.checked = false;
        setBusy(true);
        setStatus('ინახება...');
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getAdminHeaders(), ...getActorHeaders() },
            body: JSON.stringify({ exam_date: examDate, period }),
          });
          if (!isCurrent()) return;
          if (!response.ok) {
            checkbox.checked = false;
            await reportResponseError(response, 'გამოცდის დაგეგმვა ვერ შეინახა.');
            return;
          }
          const item = await response.json();
          if (!isCurrent()) return;
          items = [...items.filter((existing) => String(existing.id) !== String(item.id)), item];
          renderHistory();
          setStatus('გამოცდა დაგეგმილია. გამოცდაზე დაშვება არ შეცვლილა.');
          await notifyChanged();
        } catch {
          if (!isCurrent()) return;
          checkbox.checked = false;
          setStatus('შენახვის დადასტურება ვერ მივიღეთ. ხელახლა გახსენით ბარათი და გადაამოწმეთ ისტორია.', true);
        } finally {
          if (isCurrent()) setBusy(false);
        }
      }

      async function deleteSchedule(item) {
        if (busy || !isCurrent() || !global.confirm('წაიშალოს მხოლოდ გამოცდის დაგეგმვის ეს ჩანაწერი? გამოცდის შედეგები და დაშვების უფლება არ შეიცვლება.')) return;
        setBusy(true);
        setStatus('იშლება...');
        try {
          const response = await fetch(`${endpoint}/${encodeURIComponent(item.id)}`, {
            method: 'DELETE',
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          });
          if (!isCurrent()) return;
          if (!response.ok) {
            await reportResponseError(response, 'დაგეგმვის ჩანაწერი ვერ წაიშალა.');
            return;
          }
          items = items.filter((existing) => String(existing.id) !== String(item.id));
          if (dateInput.value === item.exam_date) {
            (item.period === 'morning' ? morning : evening).checked = false;
          }
          renderHistory();
          setStatus('დაგეგმვის ჩანაწერი წაიშალა.');
          await notifyChanged();
        } catch {
          if (!isCurrent()) return;
          setStatus('წაშლის დადასტურება ვერ მივიღეთ. ხელახლა გახსენით ბარათი და გადაამოწმეთ ისტორია.', true);
        } finally {
          if (isCurrent()) setBusy(false);
        }
      }

      dateInput.addEventListener('change', () => {
        if (busy) return;
        morning.checked = false;
        evening.checked = false;
        setStatus('');
      });
      morning.addEventListener('change', () => saveSchedule('morning', morning));
      evening.addEventListener('change', () => saveSchedule('evening', evening));
      return { load };
    }

    return { mount };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createExamSchedulesModule = createExamSchedulesModule;
})(window);

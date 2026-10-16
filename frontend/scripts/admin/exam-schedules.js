(function (global) {
  const DEFAULT_EXAM_SUBJECT = 'სერტიფიცირების გამოცდის დაგეგმვა — {date}, {time}';
  const DEFAULT_EXAM_BODY = [
    'მოგესალმებით,',
    '',
    'გაცნობებთ, რომ თქვენი სერტიფიცირების გამოცდა დაგეგმილია {date}-ში ({period}), {time} საათზე (თბილისის დროით).',
    '',
    'კანდიდატის მონაცემები:',
    '• სახელი, გვარი: {name}',
    '• პირადი ნომერი: {personal_id}',
    '• უნიკალური კოდი: {code}',
    '• გამოცდის თარიღი და დრო: {date}, {time} სთ ({period})',
    '• საგამოცდო ცენტრის მისამართი: ქ. თბილისი, მირიან მეფის ქუჩა №98, მე-2 სართული, საოფისე ფართი №6',
    '',
    'გთხოვთ, საგამოცდო ცენტრში გამოცხადდეთ გამოცდის დაწყებამდე 30 წუთით ადრე და თან იქონიოთ პირადობის დამადასტურებელი მოქმედი დოკუმენტი.',
    '',
    'პატივისცემით,',
    'საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი (GIPC)',
    'https://gipc.org.ge',
  ].join('\n');

  function formatDisplayDate(isoDate) {
    const raw = String(isoDate || '').trim();
    const parts = raw.split('-');
    if (parts.length === 3 && parts[0].length === 4) {
      return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return raw;
  }

  function periodLabelText(period) {
    if (period === 'morning') return 'დილით';
    if (period === 'evening') return 'საღამოს';
    return '';
  }

  function generateUuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }

  function isValidTime(value) {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim());
  }

  function createExamSchedulesModule(context = {}) {
    const {
      API_BASE,
      getAdminHeaders = () => ({}),
      getActorHeaders = () => ({}),
      showToast = () => {},
      handleAdminErrorResponse = async () => {},
      escapeHtml = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    } = context;

    const mountedPanels = new WeakMap();
    let sharedTemplate = {
      kind: 'exam',
      subject: DEFAULT_EXAM_SUBJECT,
      body: DEFAULT_EXAM_BODY,
      updated_at: null,
      attachment_filename: null,
      attachment_size_bytes: null,
    };
    let sharedTemplateLoaded = false;

    function candidateTokens(user, isoDate, timeValue, periodValue) {
      const fullName = `${user?.first_name || ''} ${user?.last_name || ''}`.trim() || '(უსახელო)';
      const personalId = String(user?.personal_id || '—').trim();
      const code = String(user?.code || user?.unique_code || '—').trim();
      const dateStr = isValidDate(isoDate) ? formatDisplayDate(isoDate) : '[თარიღი]';
      const timeStr = isValidTime(timeValue) ? String(timeValue).trim() : '[საათი]';
      const periodStr = periodLabelText(periodValue) || (isValidTime(timeValue) ? (timeValue < '12:00' ? 'დილით' : 'საღამოს') : 'დილით/საღამოს');
      return {
        name: fullName,
        personal_id: personalId,
        code,
        date: dateStr,
        time: timeStr,
        period: periodStr,
      };
    }

    function applyTemplateTokens(text, tokens) {
      let result = String(text || '');
      const replacements = [
        [/\{name\}|\[სახელი და გვარი\]|\[სახელი,\s*გვარი\]/gi, tokens.name],
        [/\{personal_id\}|\[პირადი ნომერი\]/gi, tokens.personal_id],
        [/\{code\}|\[უნიკალური კოდი\]/gi, tokens.code],
        [/\{date\}|\[გამოცდის თარიღი\]|\[თარიღი\]/gi, tokens.date],
        [/\{time\}|\[საათი\]/gi, tokens.time],
        [/\{period\}|\[ცვლა\]|\[დილით\/საღამოს\]/gi, tokens.period],
      ];
      for (const [pattern, val] of replacements) {
        result = result.replace(pattern, () => val);
      }
      return result;
    }

    function convertRenderedToTemplate(renderedText, tokens) {
      let result = String(renderedText || '');
      const pairs = [
        [tokens.name, '{name}'],
        [tokens.personal_id, '{personal_id}'],
        [tokens.code, '{code}'],
        [tokens.date, '{date}'],
        [tokens.time, '{time}'],
        [tokens.period, '{period}'],
      ];
      for (const [literal, placeholder] of pairs) {
        if (literal && literal !== '—' && literal !== '(უსახელო)' && !literal.startsWith('[')) {
          result = result.split(literal).join(placeholder);
        }
      }
      result = result
        .replace(/\[თარიღი\]|\[გამოცდის თარიღი\]/g, '{date}')
        .replace(/\[საათი\]/g, '{time}')
        .replace(/\[დილით\/საღამოს\]|\[ცვლა\]/g, '{period}');
      return result;
    }

    function mount(panel, user, { onChanged = () => {} } = {}) {
      if (!panel || user?.id == null) return { load: async () => {} };
      const mountToken = {};
      mountedPanels.set(panel, mountToken);
      const isCurrent = () => mountedPanels.get(panel) === mountToken;

      const safeEmail = escapeHtml(user.email || '—');
      panel.innerHTML = `
        <div class="exam-schedule-header-row">
          <h3 class="exam-schedule-title">გამოცდის დაგეგმვა</h3>
          <div class="exam-schedule-editing-banner" hidden>
            <span class="exam-schedule-editing-label"></span>
            <button type="button" class="exam-schedule-cancel-edit-btn">რედაქტირების გაუქმება</button>
          </div>
        </div>

        <div class="exam-schedule-controls">
          <label class="exam-schedule-date-label">გამოცდის თარიღი
            <input class="exam-schedule-date users-filter-date" type="date" />
          </label>
          <label class="users-filter-label"><input class="exam-schedule-morning" type="checkbox" /><span>დილით</span></label>
          <label class="users-filter-label"><input class="exam-schedule-evening" type="checkbox" /><span>საღამოს</span></label>
          <label class="exam-schedule-time-label">საათი
            <input class="exam-schedule-time users-filter-date" type="time" step="60" />
          </label>
        </div>

        <div class="exam-schedule-letter-box">
          <div class="exam-schedule-letter-toolbar">
            <span class="exam-schedule-letter-title">ავტომატური წერილი (მიმღები: <strong>${safeEmail}</strong>)</span>
            <div class="exam-schedule-letter-actions">
              <button type="button" class="exam-schedule-text-edit-btn">რედაქტირება</button>
              <button type="button" class="exam-schedule-save-template-btn" hidden>სტანდარტულ ტექსტად შენახვა</button>
              <button type="button" class="exam-schedule-reset-text-btn" hidden>სტანდარტულის დაბრუნება</button>
            </div>
          </div>
          <label class="exam-schedule-field-label">წერილის სათაური
            <input type="text" class="exam-schedule-subject" maxlength="200" readonly />
          </label>
          <label class="exam-schedule-field-label">წერილის ტექსტი
            <textarea class="exam-schedule-body" rows="7" maxlength="10000" readonly></textarea>
          </label>
        </div>

        <div class="exam-schedule-footer-row">
          <div class="exam-schedule-attachment-wrap">
            <label class="exam-schedule-file-btn">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              <span>ფაილის მიბმა</span>
              <input type="file" class="exam-schedule-file-input" accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.zip,.rar" hidden />
            </label>
            <span class="exam-schedule-file-name">ფაილი არ არის მიბმული</span>
            <button type="button" class="exam-schedule-file-clear" title="ფაილის მოხსნა" hidden>×</button>
          </div>
          <div class="exam-schedule-submit-wrap">
            <button type="button" class="exam-schedule-next-btn">შემდეგი</button>
          </div>
        </div>

        <p class="exam-schedule-hint">აირჩიეთ თარიღი, დილა/საღამო და საათი — კანდიდატის მონაცემები და დრო წერილში ავტომატურად ჩაჯდება. დააჭირეთ „შემდეგი“-ს, სადაც შეგიძლიათ აირჩიოთ: შენახვა და გაგზავნა (სტანდარტულად), მხოლოდ შენახვა ან მხოლოდ გაგზავნა.</p>
        <p class="exam-schedule-status" role="status" aria-live="polite"></p>
        <div class="exam-schedule-history" aria-label="გამოცდების დაგეგმვის ისტორია"></div>
      `;

      const dateInput = panel.querySelector('.exam-schedule-date');
      const morning = panel.querySelector('.exam-schedule-morning');
      const evening = panel.querySelector('.exam-schedule-evening');
      const timeInput = panel.querySelector('.exam-schedule-time');
      const subjectInput = panel.querySelector('.exam-schedule-subject');
      const bodyInput = panel.querySelector('.exam-schedule-body');
      const textEditBtn = panel.querySelector('.exam-schedule-text-edit-btn');
      const saveTemplateBtn = panel.querySelector('.exam-schedule-save-template-btn');
      const resetTextBtn = panel.querySelector('.exam-schedule-reset-text-btn');
      const fileInput = panel.querySelector('.exam-schedule-file-input');
      const fileNameSpan = panel.querySelector('.exam-schedule-file-name');
      const fileClearBtn = panel.querySelector('.exam-schedule-file-clear');
      const nextBtn = panel.querySelector('.exam-schedule-next-btn');
      const editingBanner = panel.querySelector('.exam-schedule-editing-banner');
      const editingLabel = panel.querySelector('.exam-schedule-editing-label');
      const cancelEditBtn = panel.querySelector('.exam-schedule-cancel-edit-btn');
      const history = panel.querySelector('.exam-schedule-history');
      const status = panel.querySelector('.exam-schedule-status');

      const schedulesEndpoint = `${API_BASE}/admin/users/${encodeURIComponent(user.id)}/exam-schedules`;
      const lettersEndpoint = `${API_BASE}/admin/users/${encodeURIComponent(user.id)}/planning-letters`;
      const templatesEndpoint = `${API_BASE}/admin/planning-templates`;

      let scheduleItems = [];
      let letterItems = [];
      let busy = false;
      let textEditable = false;
      let textCustomized = false;
      let selectedFile = null;
      let useTemplateFile = true;
      let keepExistingFile = false;
      let editingRecord = null; // { scheduleId, letterId, date, period, time, subject, body, attachmentFilename }
      let lastTokens = candidateTokens(user, '', '', '');

      function currentPeriod() {
        if (morning.checked) return 'morning';
        if (evening.checked) return 'evening';
        if (isValidTime(timeInput.value)) {
          return timeInput.value < '12:00' ? 'morning' : 'evening';
        }
        return '';
      }

      function syncDirtyFlag() {
        const isDirty = !!(
          dateInput.value
          || morning.checked
          || evening.checked
          || timeInput.value
          || selectedFile
          || editingRecord
          || textCustomized
        );
        panel.dataset.dirty = isDirty ? 'true' : 'false';
      }

      function refreshRenderedText({ forceTemplate = false } = {}) {
        const nextTokens = candidateTokens(user, dateInput.value, timeInput.value, currentPeriod());
        if (forceTemplate || !textCustomized) {
          subjectInput.value = applyTemplateTokens(sharedTemplate.subject || DEFAULT_EXAM_SUBJECT, nextTokens);
          bodyInput.value = applyTemplateTokens(sharedTemplate.body || DEFAULT_EXAM_BODY, nextTokens);
        } else {
          // Even when customized, update the date/time/period tokens live when date/time inputs change
          let nextSubject = subjectInput.value;
          let nextBody = bodyInput.value;
          if (lastTokens.date && lastTokens.date !== nextTokens.date) {
            nextSubject = nextSubject.split(lastTokens.date).join(nextTokens.date);
            nextBody = nextBody.split(lastTokens.date).join(nextTokens.date);
          }
          if (lastTokens.time && lastTokens.time !== nextTokens.time) {
            nextSubject = nextSubject.split(lastTokens.time).join(nextTokens.time);
            nextBody = nextBody.split(lastTokens.time).join(nextTokens.time);
          }
          if (lastTokens.period && lastTokens.period !== nextTokens.period) {
            nextBody = nextBody.split(`(${lastTokens.period})`).join(`(${nextTokens.period})`);
          }
          subjectInput.value = applyTemplateTokens(nextSubject, nextTokens);
          bodyInput.value = applyTemplateTokens(nextBody, nextTokens);
        }
        lastTokens = nextTokens;
      }

      function setTextEditable(editable) {
        textEditable = !!editable;
        subjectInput.readOnly = !textEditable;
        bodyInput.readOnly = !textEditable;
        subjectInput.classList.toggle('is-editable', textEditable);
        bodyInput.classList.toggle('is-editable', textEditable);
        textEditBtn.textContent = textEditable ? 'რედაქტირების დასრულება' : 'რედაქტირება';
        textEditBtn.classList.toggle('is-active', textEditable);
        saveTemplateBtn.hidden = !textEditable;
        resetTextBtn.hidden = !textEditable && !textCustomized;
      }

      function updateAttachmentUI() {
        if (selectedFile) {
          fileNameSpan.textContent = selectedFile.name;
          fileClearBtn.hidden = false;
        } else if (keepExistingFile && editingRecord?.attachmentFilename) {
          fileNameSpan.textContent = `${editingRecord.attachmentFilename} (მიმაგრებული)`;
          fileClearBtn.hidden = false;
        } else if (useTemplateFile && sharedTemplate.attachment_filename) {
          fileNameSpan.textContent = `${sharedTemplate.attachment_filename} (შაბლონის დანართი)`;
          fileClearBtn.hidden = false;
        } else {
          fileNameSpan.textContent = 'ფაილი არ არის მიბმული';
          fileClearBtn.hidden = true;
        }
        syncDirtyFlag();
      }

      function setStatus(message, isError = false) {
        status.textContent = message;
        status.classList.toggle('is-error', isError);
      }

      function setBusy(value) {
        busy = value;
        panel.setAttribute('aria-busy', String(value));
        const controls = [
          dateInput, morning, evening, timeInput,
          subjectInput, bodyInput, textEditBtn, saveTemplateBtn, resetTextBtn,
          fileInput, fileClearBtn, nextBtn, cancelEditBtn,
          ...history.querySelectorAll('button'),
        ];
        controls.forEach((control) => {
          if (control) control.disabled = value;
        });
      }

      function resetFormToDefault() {
        editingRecord = null;
        editingBanner.hidden = true;
        editingLabel.textContent = '';
        dateInput.value = '';
        morning.checked = false;
        evening.checked = false;
        timeInput.value = '';
        selectedFile = null;
        fileInput.value = '';
        keepExistingFile = false;
        useTemplateFile = true;
        textCustomized = false;
        setTextEditable(false);
        refreshRenderedText({ forceTemplate: true });
        updateAttachmentUI();
        syncDirtyFlag();
      }

      function startEditingRecord(combinedItem) {
        editingRecord = combinedItem;
        dateInput.value = combinedItem.examDate || '';
        morning.checked = combinedItem.period === 'morning';
        evening.checked = combinedItem.period === 'evening';
        timeInput.value = combinedItem.eventTime || (combinedItem.period === 'morning' ? '10:00' : '14:00');
        selectedFile = null;
        fileInput.value = '';
        keepExistingFile = !!combinedItem.attachmentFilename;
        useTemplateFile = !keepExistingFile;

        lastTokens = candidateTokens(user, dateInput.value, timeInput.value, combinedItem.period);
        if (combinedItem.subject && combinedItem.body) {
          subjectInput.value = combinedItem.subject;
          bodyInput.value = combinedItem.body;
          textCustomized = true;
        } else {
          textCustomized = false;
          refreshRenderedText({ forceTemplate: true });
        }

        const dateLabel = formatDisplayDate(combinedItem.examDate);
        const periodLabel = periodLabelText(combinedItem.period);
        const timeLabel = combinedItem.eventTime ? ` (${combinedItem.eventTime})` : '';
        editingLabel.textContent = `რედაქტირება: ${dateLabel} — ${periodLabel}${timeLabel}`;
        editingBanner.hidden = false;
        setTextEditable(true);
        updateAttachmentUI();
        setStatus('ჩანაწერი გადმოტანილია სარედაქტირებლად. შეცვალეთ მონაცემები და დააჭირეთ „შემდეგი“-ს.');
        dateInput.focus();
      }

      function buildCombinedHistory() {
        const lettersByScheduleId = new Map();
        const standaloneLetters = [];
        const sortedLetters = [...letterItems].sort((a, b) => Number(b.id) - Number(a.id));

        for (const letter of sortedLetters) {
          if (letter.kind && letter.kind !== 'exam') continue;
          if (letter.exam_schedule_id != null) {
            const key = String(letter.exam_schedule_id);
            if (!lettersByScheduleId.has(key)) {
              lettersByScheduleId.set(key, letter);
            }
          } else {
            standaloneLetters.push(letter);
          }
        }

        const combined = [];
        const matchedLetterIds = new Set();

        for (const sched of scheduleItems) {
          let letter = lettersByScheduleId.get(String(sched.id)) || null;
          if (!letter) {
            letter = sortedLetters.find(
              (l) => !matchedLetterIds.has(l.id)
                && l.event_date === sched.exam_date
                && l.period === sched.period
            ) || null;
          }
          if (letter) matchedLetterIds.add(letter.id);
          combined.push({
            key: `sched-${sched.id}`,
            scheduleId: sched.id,
            letterId: letter ? letter.id : null,
            examDate: sched.exam_date,
            period: sched.period,
            eventTime: letter ? letter.event_time : '',
            subject: letter ? letter.subject : '',
            body: letter ? letter.body : '',
            status: letter ? letter.status : 'saved',
            error: letter ? letter.error : null,
            attachmentFilename: letter ? letter.attachment_filename : null,
            isStandaloneLetter: false,
          });
        }

        for (const letter of standaloneLetters) {
          if (matchedLetterIds.has(letter.id)) continue;
          combined.push({
            key: `letter-${letter.id}`,
            scheduleId: null,
            letterId: letter.id,
            examDate: letter.event_date,
            period: letter.period || (letter.event_time < '12:00' ? 'morning' : 'evening'),
            eventTime: letter.event_time || '',
            subject: letter.subject || '',
            body: letter.body || '',
            status: letter.status || 'sent',
            error: letter.error || null,
            attachmentFilename: letter.attachment_filename || null,
            isStandaloneLetter: true,
          });
        }

        combined.sort((a, b) => (
          String(b.examDate || '').localeCompare(String(a.examDate || ''))
          || String(b.eventTime || '').localeCompare(String(a.eventTime || ''))
          || String(a.period || '').localeCompare(String(b.period || ''))
          || Number(b.scheduleId || b.letterId || 0) - Number(a.scheduleId || a.letterId || 0)
        ));
        return combined;
      }

      function statusBadgeMeta(item) {
        if (item.isStandaloneLetter) {
          if (item.status === 'failed') return { label: 'მხოლოდ გაგზავნა (შეცდომა)', cls: 'is-error' };
          return { label: 'მხოლოდ გაგზავნილი', cls: 'is-sent-only' };
        }
        if (!item.letterId || item.status === 'saved') {
          return { label: 'მხოლოდ შენახული', cls: 'is-saved-only' };
        }
        if (item.status === 'failed') {
          return { label: 'შენახულია (მეილი ვერ გაიგზავნა)', cls: 'is-error' };
        }
        if (item.status === 'uncertain') {
          return { label: 'შენახულია (გაგზავნა გადასამოწმებელია)', cls: 'is-warning' };
        }
        return { label: 'შენახული და გაგზავნილი', cls: 'is-sent' };
      }

      async function downloadLetterAttachment(letterId, filename) {
        try {
          const response = await fetch(`${lettersEndpoint}/${encodeURIComponent(letterId)}/attachment`, {
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          });
          if (!response.ok) {
            await handleAdminErrorResponse(response, 'მიმაგრებული ფაილი ვერ ჩამოიტვირთა.', showToast);
            return;
          }
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename || 'attachment';
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch {
          showToast('მიმაგრებული ფაილი ვერ ჩამოიტვირთა.', 'error');
        }
      }

      function renderHistory() {
        history.innerHTML = '';
        const combined = buildCombinedHistory();
        if (!combined.length) {
          const empty = document.createElement('p');
          empty.className = 'exam-schedule-empty';
          empty.textContent = 'გამოცდა ჯერ არ არის დაგეგმილი.';
          history.appendChild(empty);
          return;
        }

        combined.forEach((item) => {
          const row = document.createElement('div');
          row.className = 'exam-schedule-row';

          const infoWrap = document.createElement('div');
          infoWrap.className = 'exam-schedule-row-info';

          const description = document.createElement('span');
          description.className = 'exam-schedule-row-main';
          const dateLabel = formatDisplayDate(item.examDate);
          const periodLabel = periodLabelText(item.period);
          const timePart = item.eventTime ? ` — ${item.eventTime} სთ` : '';
          description.textContent = `${dateLabel} — ${periodLabel}${timePart}`;
          infoWrap.appendChild(description);

          const badgeInfo = statusBadgeMeta(item);
          const badge = document.createElement('span');
          badge.className = `exam-schedule-badge ${badgeInfo.cls}`;
          badge.textContent = badgeInfo.label;
          if (item.error) badge.title = item.error;
          infoWrap.appendChild(badge);

          if (item.attachmentFilename && item.letterId) {
            const fileBtn = document.createElement('button');
            fileBtn.type = 'button';
            fileBtn.className = 'exam-schedule-attachment-link';
            fileBtn.textContent = `📎 ${item.attachmentFilename}`;
            fileBtn.addEventListener('click', () => downloadLetterAttachment(item.letterId, item.attachmentFilename));
            infoWrap.appendChild(fileBtn);
          }

          const actionsWrap = document.createElement('div');
          actionsWrap.className = 'exam-schedule-row-actions';

          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'exam-schedule-edit';
          editBtn.textContent = 'რედაქტირება';
          editBtn.disabled = busy;
          editBtn.addEventListener('click', () => startEditingRecord(item));
          actionsWrap.appendChild(editBtn);

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'exam-schedule-delete';
          if (item.scheduleId != null) removeBtn.dataset.id = String(item.scheduleId);
          removeBtn.textContent = 'წაშლა';
          removeBtn.setAttribute('aria-label', `${dateLabel} — ${periodLabel}: დაგეგმვის ჩანაწერის წაშლა`);
          removeBtn.disabled = busy;
          removeBtn.addEventListener('click', () => deleteHistoryItem(item));
          actionsWrap.appendChild(removeBtn);

          row.appendChild(infoWrap);
          row.appendChild(actionsWrap);
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
        try { await onChanged({ userId: user.id }); } catch {}
      }

      async function load() {
        if (busy || !isCurrent()) return;
        setBusy(true);
        setStatus('ისტორია იტვირთება...');
        try {
          const requests = [
            fetch(schedulesEndpoint, { headers: { ...getAdminHeaders(), ...getActorHeaders() } }),
            fetch(lettersEndpoint, { headers: { ...getAdminHeaders(), ...getActorHeaders() } }).catch(() => null),
          ];
          if (!sharedTemplateLoaded) {
            requests.push(
              fetch(templatesEndpoint, { headers: { ...getAdminHeaders(), ...getActorHeaders() } }).catch(() => null)
            );
          }
          const [schedRes, lettersRes, tmplRes] = await Promise.all(requests);
          if (!isCurrent()) return;

          if (tmplRes && tmplRes.ok) {
            const tmplData = await tmplRes.json().catch(() => null);
            const examTmpl = Array.isArray(tmplData?.items)
              ? tmplData.items.find((t) => t.kind === 'exam')
              : null;
            if (examTmpl) {
              // If the DB has the old placeholder-blocked default template, upgrade it in memory unless customized
              const hasBlockedPlaceholders = /\[შეავსეთ/.test(String(examTmpl.body || ''));
              const normalizedBody = (hasBlockedPlaceholders ? DEFAULT_EXAM_BODY : (examTmpl.body || DEFAULT_EXAM_BODY))
                .replace(/^(?:მოგესალმებით,\s*)?ბატონო\/ქალბატონო[^\n]*\n*/, 'მოგესალმებით,\n\n');
              sharedTemplate = {
                ...examTmpl,
                subject: hasBlockedPlaceholders ? DEFAULT_EXAM_SUBJECT : (examTmpl.subject || DEFAULT_EXAM_SUBJECT),
                body: normalizedBody,
              };
              sharedTemplateLoaded = true;
            }
          }

          if (!schedRes || !schedRes.ok) {
            if (schedRes) {
              await reportResponseError(schedRes, 'გამოცდების ისტორია ვერ ჩაიტვირთა. ხელახლა გახსენით ბარათი.');
            } else {
              setStatus('გამოცდების ისტორია ვერ ჩაიტვირთა. ხელახლა გახსენით ბარათი.', true);
            }
            return;
          }

          const schedData = await schedRes.json();
          if (!isCurrent()) return;
          scheduleItems = Array.isArray(schedData?.items) ? schedData.items : [];

          if (lettersRes && lettersRes.ok) {
            const lettersData = await lettersRes.json().catch(() => null);
            letterItems = Array.isArray(lettersData?.items) ? lettersData.items : [];
          }

          if (!textCustomized && !editingRecord) {
            refreshRenderedText({ forceTemplate: true });
            updateAttachmentUI();
          }
          renderHistory();
          setStatus('');
        } catch {
          if (isCurrent()) setStatus('გამოცდების ისტორია ვერ ჩაიტვირთა. ხელახლა გახსენით ბარათი.', true);
        } finally {
          if (isCurrent()) setBusy(false);
        }
      }

      async function saveStandardTemplate() {
        if (busy || !isCurrent()) return;
        const currentTokens = candidateTokens(user, dateInput.value, timeInput.value, currentPeriod());
        const templateSubject = convertRenderedToTemplate(subjectInput.value.trim(), currentTokens);
        const templateBody = convertRenderedToTemplate(bodyInput.value.trim(), currentTokens);
        if (!templateSubject || !templateBody) {
          setStatus('შაბლონის სათაური და ტექსტი არ უნდა იყოს ცარიელი.', true);
          return;
        }
        setBusy(true);
        setStatus('სტანდარტული ტექსტი ინახება...');
        try {
          const formData = new FormData();
          formData.append('subject', templateSubject);
          formData.append('body', templateBody);
          if (selectedFile) {
            formData.append('attachment', selectedFile);
          } else if (!useTemplateFile && sharedTemplate.attachment_filename) {
            formData.append('remove_attachment', 'true');
          }
          const response = await fetch(`${templatesEndpoint}/exam`, {
            method: 'PUT',
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
            body: formData,
          });
          if (!isCurrent()) return;
          if (!response.ok) {
            await reportResponseError(response, 'სტანდარტული ტექსტი ვერ შეინახა.');
            return;
          }
          const saved = await response.json();
          sharedTemplate = {
            ...sharedTemplate,
            ...saved,
          };
          sharedTemplateLoaded = true;
          textCustomized = false;
          refreshRenderedText({ forceTemplate: true });
          setTextEditable(false);
          setStatus('სტანდარტული ტექსტი წარმატებით შეინახა.');
          showToast('სტანდარტული წერილის შაბლონი განახლდა');
        } catch {
          if (isCurrent()) setStatus('სტანდარტული ტექსტის შენახვა ვერ მოხერხდა.', true);
        } finally {
          if (isCurrent()) setBusy(false);
        }
      }

      function openConfirmationModal() {
        if (busy || !isCurrent()) return;
        const examDate = dateInput.value;
        if (!isValidDate(examDate)) {
          setStatus('ჯერ აირჩიეთ გამოცდის თარიღი.', true);
          dateInput.focus();
          return;
        }
        let period = currentPeriod();
        if (!period) {
          setStatus('აირჩიეთ „დილით“ ან „საღამოს“, ან მიუთითეთ საათი.', true);
          morning.focus();
          return;
        }
        if (!morning.checked && !evening.checked) {
          if (period === 'morning') morning.checked = true;
          else evening.checked = true;
        }
        let examTime = timeInput.value.trim();
        if (!isValidTime(examTime)) {
          setStatus('გთხოვთ მიუთითოთ გამოცდის საათი (მაგ.: 10:00 ან 14:00).', true);
          timeInput.focus();
          return;
        }

        // Make sure tokens are up to date in the text
        refreshRenderedText();

        const finalSubject = subjectInput.value.trim();
        const finalBody = bodyInput.value.trim();
        if (!finalSubject || !finalBody) {
          setStatus('წერილის სათაური და ტექსტი აუცილებელია.', true);
          return;
        }

        const existingOverlay = document.querySelector('.exam-schedule-confirm-overlay');
        if (existingOverlay) existingOverlay.remove();

        const dateLabel = formatDisplayDate(examDate);
        const periodLabel = periodLabelText(period);
        const candidateName = `${user.first_name || ''} ${user.last_name || ''}`.trim() || '(უსახელო)';
        const attachmentLabel = selectedFile
          ? selectedFile.name
          : (keepExistingFile && editingRecord?.attachmentFilename)
            ? editingRecord.attachmentFilename
            : (useTemplateFile && sharedTemplate.attachment_filename)
              ? sharedTemplate.attachment_filename
              : 'ფაილის გარეშე';

        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay exam-schedule-confirm-overlay open';
        overlay.setAttribute('aria-hidden', 'false');
        overlay.innerHTML = `
          <div class="modal exam-schedule-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="examScheduleConfirmTitle">
            <div class="modal-header">
              <h3 class="modal-title" id="examScheduleConfirmTitle">${editingRecord ? 'დაგეგმილი გამოცდის რედაქტირება' : 'გამოცდის დაგეგმვის დადასტურება'}</h3>
              <button class="modal-close exam-schedule-modal-close" type="button" aria-label="დახურვა">×</button>
            </div>
            <div class="modal-body exam-schedule-confirm-body">
              <div class="exam-schedule-confirm-summary">
                <div><strong>კანდიდატი:</strong> ${escapeHtml(candidateName)} (${escapeHtml(user.personal_id || '—')}, კოდი: ${escapeHtml(user.code || '—')})</div>
                <div><strong>მიმღების მეილი:</strong> ${escapeHtml(user.email || '—')}</div>
                <div><strong>გამოცდის დრო:</strong> ${escapeHtml(dateLabel)} — ${escapeHtml(periodLabel)}, ${escapeHtml(examTime)} სთ</div>
                <div><strong>მიმაგრებული ფაილი:</strong> ${escapeHtml(attachmentLabel)}</div>
              </div>

              <div class="exam-schedule-confirm-preview">
                <div class="exam-schedule-confirm-preview-subject"><strong>სათაური:</strong> ${escapeHtml(finalSubject)}</div>
                <pre class="exam-schedule-confirm-preview-text">${escapeHtml(finalBody)}</pre>
              </div>

              <div class="exam-schedule-mode-group" role="radiogroup" aria-label="აირჩიეთ მოქმედება">
                <div class="exam-schedule-mode-heading">აირჩიეთ მოქმედება:</div>
                <label class="exam-schedule-mode-option is-selected">
                  <input type="radio" name="examScheduleActionMode" value="save_and_send" checked />
                  <div class="exam-schedule-mode-content">
                    <span class="exam-schedule-mode-title">შენახვა და გაგზავნა (სტანდარტული)</span>
                    <span class="exam-schedule-mode-desc">შეინახავს გამოცდის დაგეგმვას სისტემაში და გაუგზავნის წერილს კანდიდატს ოფიციალური მეილიდან.</span>
                  </div>
                </label>
                <label class="exam-schedule-mode-option">
                  <input type="radio" name="examScheduleActionMode" value="save_only" />
                  <div class="exam-schedule-mode-content">
                    <span class="exam-schedule-mode-title">მხოლოდ შენახვა</span>
                    <span class="exam-schedule-mode-desc">შეინახავს მხოლოდ გამოცდის დაგეგმვას სისტემაში, მეილზე წერილის გაგზავნის გარეშე.</span>
                  </div>
                </label>
                <label class="exam-schedule-mode-option">
                  <input type="radio" name="examScheduleActionMode" value="send_only" />
                  <div class="exam-schedule-mode-content">
                    <span class="exam-schedule-mode-title">მხოლოდ გაგზავნა</span>
                    <span class="exam-schedule-mode-desc">გაუგზავნის მხოლოდ წერილს კანდიდატს მეილზე, დაგეგმვის ცხრილში ცვლილების გარეშე.</span>
                  </div>
                </label>
              </div>
            </div>
            <div class="modal-footer exam-schedule-confirm-footer">
              <button type="button" class="btn-secondary exam-schedule-modal-edit">რედაქტირება / უკან</button>
              <button type="button" class="btn-primary exam-schedule-modal-submit">დადასტურება</button>
            </div>
          </div>
        `;

        document.body.appendChild(overlay);

        const radioInputs = overlay.querySelectorAll('input[name="examScheduleActionMode"]');
        radioInputs.forEach((radio) => {
          radio.addEventListener('change', () => {
            overlay.querySelectorAll('.exam-schedule-mode-option').forEach((opt) => {
              const input = opt.querySelector('input[type="radio"]');
              opt.classList.toggle('is-selected', !!input?.checked);
            });
          });
        });

        const closeModal = () => {
          overlay.remove();
        };

        overlay.querySelector('.exam-schedule-modal-close')?.addEventListener('click', closeModal);
        overlay.querySelector('.exam-schedule-modal-edit')?.addEventListener('click', () => {
          closeModal();
          setTextEditable(true);
          bodyInput.focus();
        });
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) closeModal();
        });

        const submitBtn = overlay.querySelector('.exam-schedule-modal-submit');
        submitBtn?.addEventListener('click', async () => {
          const selectedRadio = overlay.querySelector('input[name="examScheduleActionMode"]:checked');
          const actionMode = selectedRadio ? selectedRadio.value : 'save_and_send';
          closeModal();
          await executeScheduleAction({
            actionMode,
            examDate,
            period,
            examTime,
            subject: finalSubject,
            body: finalBody,
          });
        });
      }

      async function executeScheduleAction({ actionMode, examDate, period, examTime, subject, body }) {
        if (busy || !isCurrent()) return;
        setBusy(true);
        const modeProgressText = actionMode === 'save_only'
          ? 'ინახება...'
          : actionMode === 'send_only'
            ? 'იგზავნება წერილი...'
            : 'ინახება და იგზავნება წერილი...';
        setStatus(modeProgressText);

        try {
          const formData = new FormData();
          formData.append('kind', 'exam');
          formData.append('event_date', examDate);
          formData.append('event_time', examTime);
          formData.append('period', period);
          formData.append('action_mode', actionMode);
          formData.append('subject', subject);
          formData.append('body', body);
          formData.append('request_id', generateUuid());
          formData.append('expected_to_email', user.email || '');
          formData.append('confirmed', 'true');
          formData.append('use_template_attachment', String(useTemplateFile && !selectedFile && !keepExistingFile));
          if (sharedTemplate.updated_at && useTemplateFile && !selectedFile && !keepExistingFile) {
            formData.append('template_updated_at', sharedTemplate.updated_at);
          }
          if (editingRecord?.scheduleId != null) {
            formData.append('schedule_id', String(editingRecord.scheduleId));
          }
          if (editingRecord?.letterId != null) {
            formData.append('edit_letter_id', String(editingRecord.letterId));
          }
          if (keepExistingFile && editingRecord?.letterId != null && !selectedFile) {
            formData.append('keep_existing_attachment', 'true');
          }
          if (selectedFile) {
            formData.append('attachment', selectedFile);
          }

          const response = await fetch(lettersEndpoint, {
            method: 'POST',
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
            body: formData,
          });
          if (!isCurrent()) return;
          if (!response.ok) {
            await reportResponseError(response, 'ოპერაცია ვერ შესრულდა.');
            return;
          }
          const savedLetter = await response.json();
          if (!isCurrent()) return;

          // Reload schedules & letters to reflect exact DB state
          const [schedRes, lettersRes] = await Promise.all([
            fetch(schedulesEndpoint, { headers: { ...getAdminHeaders(), ...getActorHeaders() } }).catch(() => null),
            fetch(lettersEndpoint, { headers: { ...getAdminHeaders(), ...getActorHeaders() } }).catch(() => null),
          ]);
          if (!isCurrent()) return;
          if (schedRes && schedRes.ok) {
            const sData = await schedRes.json().catch(() => null);
            if (Array.isArray(sData?.items)) scheduleItems = sData.items;
          }
          if (lettersRes && lettersRes.ok) {
            const lData = await lettersRes.json().catch(() => null);
            if (Array.isArray(lData?.items)) letterItems = lData.items;
          }

          resetFormToDefault();
          renderHistory();

          if (actionMode === 'save_only') {
            setStatus('გამოცდის დაგეგმვა შეინახა (წერილის გაგზავნის გარეშე).');
            showToast('გამოცდის დაგეგმვა შეინახა');
          } else if (actionMode === 'send_only') {
            if (savedLetter.status === 'failed') {
              setStatus(savedLetter.error || 'წერილის გაგზავნა ვერ მოხერხდა.', true);
              showToast(savedLetter.error || 'წერილის გაგზავნა ვერ მოხერხდა', 'error');
            } else {
              setStatus('წერილი წარმატებით გაიგზავნა კანდიდატის მეილზე.');
              showToast('წერილი გაიგზავნა');
            }
          } else {
            if (savedLetter.status === 'failed') {
              setStatus(`გამოცდა შეინახა, მაგრამ მეილის გაგზავნა ვერ მოხერხდა: ${savedLetter.error || ''}`, true);
              showToast('გამოცდა შეინახა, მაგრამ მეილი ვერ გაიგზავნა', 'error');
            } else {
              setStatus('გამოცდა დაგეგმილია და წერილი გაგზავნილია კანდიდატის მეილზე.');
              showToast('გამოცდა დაიგეგმა და წერილი გაიგზავნა');
            }
          }
          await notifyChanged();
        } catch {
          if (!isCurrent()) return;
          setStatus('დადასტურება ვერ მივიღეთ. ხელახლა გახსენით ბარათი და გადაამოწმეთ ისტორია.', true);
        } finally {
          if (isCurrent()) setBusy(false);
        }
      }

      async function deleteHistoryItem(item) {
        if (busy || !isCurrent()) return;
        const confirmMsg = item.isStandaloneLetter
          ? 'წაიშალოს გაგზავნილი წერილის ეს ჩანაწერი ისტორიიდან?'
          : 'წაიშალოს გამოცდის დაგეგმვის ეს ჩანაწერი? გამოცდის შედეგები და დაშვების უფლება არ შეიცვლება.';
        if (!global.confirm(confirmMsg)) return;

        setBusy(true);
        setStatus('იშლება...');
        try {
          const deleteUrl = item.scheduleId != null
            ? `${schedulesEndpoint}/${encodeURIComponent(item.scheduleId)}`
            : `${lettersEndpoint}/${encodeURIComponent(item.letterId)}`;
          const response = await fetch(deleteUrl, {
            method: 'DELETE',
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          });
          if (!isCurrent()) return;
          if (!response.ok) {
            await reportResponseError(response, 'დაგეგმვის ჩანაწერი ვერ წაიშალა.');
            return;
          }
          if (item.scheduleId != null) {
            scheduleItems = scheduleItems.filter((existing) => String(existing.id) !== String(item.scheduleId));
            letterItems = letterItems.filter((existing) => String(existing.exam_schedule_id) !== String(item.scheduleId));
          } else if (item.letterId != null) {
            letterItems = letterItems.filter((existing) => String(existing.id) !== String(item.letterId));
          }
          if (editingRecord && (
            (item.scheduleId != null && editingRecord.scheduleId === item.scheduleId)
            || (item.letterId != null && editingRecord.letterId === item.letterId)
          )) {
            resetFormToDefault();
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

      // Event Listeners
      dateInput.addEventListener('change', () => {
        if (busy) return;
        setStatus('');
        refreshRenderedText();
        syncDirtyFlag();
      });

      morning.addEventListener('change', () => {
        if (busy) return;
        if (morning.checked) {
          evening.checked = false;
          if (!timeInput.value) timeInput.value = '10:00';
        }
        setStatus('');
        refreshRenderedText();
        syncDirtyFlag();
      });

      evening.addEventListener('change', () => {
        if (busy) return;
        if (evening.checked) {
          morning.checked = false;
          if (!timeInput.value) timeInput.value = '14:00';
        }
        setStatus('');
        refreshRenderedText();
        syncDirtyFlag();
      });

      timeInput.addEventListener('input', () => {
        if (busy) return;
        if (isValidTime(timeInput.value) && !morning.checked && !evening.checked) {
          if (timeInput.value < '12:00') morning.checked = true;
          else evening.checked = true;
        }
        setStatus('');
        refreshRenderedText();
        syncDirtyFlag();
      });

      timeInput.addEventListener('change', () => {
        if (busy) return;
        if (isValidTime(timeInput.value)) {
          if (timeInput.value < '12:00') {
            morning.checked = true;
            evening.checked = false;
          } else {
            evening.checked = true;
            morning.checked = false;
          }
        }
        setStatus('');
        refreshRenderedText();
        syncDirtyFlag();
      });

      textEditBtn.addEventListener('click', () => {
        if (busy) return;
        setTextEditable(!textEditable);
        if (textEditable) bodyInput.focus();
      });

      subjectInput.addEventListener('input', () => {
        textCustomized = true;
        resetTextBtn.hidden = false;
        syncDirtyFlag();
      });

      bodyInput.addEventListener('input', () => {
        textCustomized = true;
        resetTextBtn.hidden = false;
        syncDirtyFlag();
      });

      saveTemplateBtn.addEventListener('click', () => {
        void saveStandardTemplate();
      });

      resetTextBtn.addEventListener('click', () => {
        if (busy) return;
        textCustomized = false;
        refreshRenderedText({ forceTemplate: true });
        setStatus('სტანდარტული ტექსტი აღდგენილია.');
        syncDirtyFlag();
      });

      fileInput.addEventListener('change', () => {
        if (busy) return;
        const file = fileInput.files?.[0] || null;
        if (file) {
          selectedFile = file;
          keepExistingFile = false;
        }
        updateAttachmentUI();
      });

      fileClearBtn.addEventListener('click', () => {
        if (busy) return;
        selectedFile = null;
        fileInput.value = '';
        keepExistingFile = false;
        useTemplateFile = false;
        updateAttachmentUI();
      });

      cancelEditBtn.addEventListener('click', () => {
        if (busy) return;
        resetFormToDefault();
        setStatus('რედაქტირების რეჟიმი გაუქმდა.');
      });

      nextBtn.addEventListener('click', () => {
        openConfirmationModal();
      });

      // Initialize rendered text with candidate's info right away
      refreshRenderedText({ forceTemplate: true });
      updateAttachmentUI();

      return { load };
    }

    return { mount };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createExamSchedulesModule = createExamSchedulesModule;
})(window);

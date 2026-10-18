(function (global) {
  function createAiAssistantModule(context) {
    const {
      API_BASE,
      on,
      showToast,
      escapeHtml,
      getAdminHeaders,
      getActorHeaders,
      onLetterSent,
    } = context;

    const STORAGE_KEY_HISTORY = 'gipc_ai_chat_history_v1';
    let isOpen = false;
    let isExpanded = false;
    let isSettingsOpen = false;
    let isSending = false;
    let aiStatus = {
      configured: false,
      masked_key: null,
      model: 'gemini-4-argon',
      allowed_models: ['gemini-4-argon'],
      custom_system_prompt: '',
      default_system_prompt: '',
      quick_stats: { unseen_statements: 0, pending_statements: 0 },
    };

    let messages = [];
    let fabEl = null;
    let fabBadgeEl = null;
    let fabDotEl = null;
    let panelEl = null;
    let messagesContainerEl = null;
    let inputEl = null;
    let sendBtnEl = null;
    let settingsDrawerEl = null;
    let modelBadgeEl = null;

    const TEMPLATE_MODE_LABELS = {
      exam: 'გამოცდის დაგეგმვა (დადებითი პასუხი)',
      rejection: 'უარყოფითი პასუხი (განაცხადის უარყოფა)',
      certificate: 'სერტიფიკატის გადაცემა (ჩაბარების წერილი)',
      exam_fail: 'ჩაჭრის შეტყობინება',
      custom: 'სხვა შეტყობინება',
    };

    function generateUuid() {
      if (global.crypto?.randomUUID) return global.crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }

    function loadHistory() {
      try {
        const raw = global.sessionStorage?.getItem?.(STORAGE_KEY_HISTORY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            messages = parsed.slice(-30);
          }
        }
      } catch {
        messages = [];
      }
    }

    function saveHistory() {
      try {
        global.sessionStorage?.setItem?.(
          STORAGE_KEY_HISTORY,
          JSON.stringify(messages.slice(-30))
        );
      } catch {}
    }

    function formatMarkdownSimple(text) {
      const safe = escapeHtml(String(text || ''));
      const lines = safe.split(/\r?\n/);
      const htmlLines = [];
      let inList = false;

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const bulletMatch = line.match(/^\s*[-*•]\s+(.*)$/);
        const numMatch = line.match(/^\s*(\d+[.)])\s+(.*)$/);

        if (bulletMatch || numMatch) {
          if (!inList) {
            htmlLines.push('<ul class="ai-msg-list">');
            inList = true;
          }
          const itemContent = bulletMatch ? bulletMatch[1] : `${numMatch[1]} ${numMatch[2]}`;
          htmlLines.push(`<li>${formatInlineMarkdown(itemContent)}</li>`);
          continue;
        }

        if (inList) {
          htmlLines.push('</ul>');
          inList = false;
        }

        if (/^#{1,3}\s+/.test(line)) {
          const headingText = line.replace(/^#{1,3}\s+/, '');
          htmlLines.push(`<div class="ai-msg-heading">${formatInlineMarkdown(headingText)}</div>`);
        } else if (!line.trim()) {
          htmlLines.push('<div class="ai-msg-spacer"></div>');
        } else {
          htmlLines.push(`<p class="ai-msg-p">${formatInlineMarkdown(line)}</p>`);
        }
      }

      if (inList) {
        htmlLines.push('</ul>');
      }
      return htmlLines.join('');
    }

    function formatInlineMarkdown(str) {
      return str
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    }

    async function fetchStatus() {
      try {
        const resp = await fetch(`${API_BASE}/admin/ai/status`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!resp.ok) return;
        const data = await resp.json();
        aiStatus = { ...aiStatus, ...data };
        syncStatusUI();
      } catch {}
    }

    function syncStatusUI() {
      if (fabDotEl) {
        fabDotEl.className = `ai-fab-status-dot ${aiStatus.configured ? 'is-ready' : 'is-unconfigured'}`;
        fabDotEl.title = aiStatus.configured
          ? `Gemini 4 Argon ჩართულია (${aiStatus.model})`
          : 'საჭიროა Gemini API Key-ს მითითება';
      }
      const pendingCount = Number(aiStatus.quick_stats?.pending_statements || 0);
      if (fabBadgeEl) {
        fabBadgeEl.textContent = String(pendingCount);
        fabBadgeEl.hidden = pendingCount <= 0;
      }
      if (modelBadgeEl) {
        modelBadgeEl.textContent = aiStatus.configured
          ? '● Gemini 4 Argon'
          : '⚠ API Key არ არის შეყვანილი';
        modelBadgeEl.className = `ai-panel-model-badge ${aiStatus.configured ? 'is-ready' : 'is-unconfigured'}`;
      }
    }

    function buildUI() {
      if (panelEl) return;

      fabEl = document.createElement('button');
      fabEl.type = 'button';
      fabEl.id = 'aiAssistantFab';
      fabEl.className = 'ai-assistant-fab';
      fabEl.innerHTML = `
        <span class="ai-fab-icon">✨</span>
        <span class="ai-fab-label">AI ასისტენტი</span>
        <span class="ai-fab-status-dot is-unconfigured"></span>
        <span class="ai-fab-badge" hidden>0</span>
      `;
      fabDotEl = fabEl.querySelector('.ai-fab-status-dot');
      fabBadgeEl = fabEl.querySelector('.ai-fab-badge');
      on(fabEl, 'click', () => togglePanel());
      document.body.appendChild(fabEl);

      panelEl = document.createElement('aside');
      panelEl.id = 'aiAssistantPanel';
      panelEl.className = 'ai-assistant-panel';
      panelEl.hidden = true;
      panelEl.innerHTML = `
        <div class="ai-panel-header">
          <div class="ai-panel-title-wrap">
            <div class="ai-panel-title-row">
              <span class="ai-panel-sparkle">✨</span>
              <h3 class="ai-panel-title">GIPC AI მრჩეველი</h3>
              <span class="ai-panel-model-badge is-unconfigured">Gemini 4 Argon</span>
            </div>
            <p class="ai-panel-subtitle">განცხადებების, დოკუმენტების და საიტის ანალიზი • წერილები იგზავნება მხოლოდ თქვენი დასტურით</p>
          </div>
          <div class="ai-panel-header-actions">
            <button type="button" class="ai-panel-icon-btn ai-btn-settings" title="Gemini API Key და პარამეტრები">⚙️</button>
            <button type="button" class="ai-panel-icon-btn ai-btn-expand" title="ფანჯრის გაფართოება / დაპატარავება">⛶</button>
            <button type="button" class="ai-panel-icon-btn ai-btn-clear" title="ჩატის გასუფთავება">🗑️</button>
            <button type="button" class="ai-panel-icon-btn ai-btn-close" title="დახურვა">×</button>
          </div>
        </div>

        <div class="ai-settings-drawer" hidden>
          <div class="ai-settings-inner">
            <div class="ai-settings-head">
              <strong>⚙️ Gemini 4 Argon — კონფიგურაცია</strong>
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" class="ai-key-link">🔑 API Key-ს აღება (Google AI Studio)</a>
            </div>
            <label class="ai-settings-label">
              <span>Gemini API Key <small class="ai-masked-key-hint"></small></span>
              <input type="password" class="ai-settings-input ai-input-apikey" placeholder="ჩასვით AIza... გასაღები (ცარიელი = უცვლელი)" autocomplete="off" />
            </label>
            <label class="ai-settings-label">
              <span>Gemini მოდელი</span>
              <select class="ai-settings-select ai-select-model">
                <option value="gemini-4-argon">gemini-4-argon (Gemini 4 Argon)</option>
              </select>
            </label>
            <label class="ai-settings-label">
              <span>დამატებითი ინსტრუქცია (სურვილისამებრ — ძირითადი უსაფრთხოების პრომპტი ყოველთვის აქტიურია)</span>
              <textarea class="ai-settings-textarea ai-input-custom-prompt" rows="3" placeholder="მაგ: ყურადღება გაამახვილე სტაჟის ცნობებზე..."></textarea>
            </label>
            <div class="ai-settings-actions">
              <button type="button" class="secondary-btn ai-settings-cancel">დახურვა</button>
              <button type="button" class="primary-btn ai-settings-save">შენახვა</button>
            </div>
          </div>
        </div>

        <div class="ai-quick-actions-bar">
          <button type="button" class="ai-quick-chip" data-mode="site_analysis">📊 საიტის სრული ანალიზი</button>
          <button type="button" class="ai-quick-chip" data-mode="statements_analysis">📨 უპასუხო განცხადებები და ფაილები</button>
          <button type="button" class="ai-quick-chip" data-mode="exam_analysis">🎓 გამოცდის შედეგები და ვადები</button>
        </div>

        <div class="ai-messages-container"></div>

        <form class="ai-input-bar">
          <textarea class="ai-chat-input" rows="2" placeholder="დაუსვით კითხვა ან დაავალეთ განცხადების/დოკუმენტის შემოწმება... (Enter - გაგზავნა)"></textarea>
          <button type="submit" class="ai-chat-send-btn">გაგზავნა ➤</button>
        </form>
      `;

      document.body.appendChild(panelEl);

      modelBadgeEl = panelEl.querySelector('.ai-panel-model-badge');
      messagesContainerEl = panelEl.querySelector('.ai-messages-container');
      inputEl = panelEl.querySelector('.ai-chat-input');
      sendBtnEl = panelEl.querySelector('.ai-chat-send-btn');
      settingsDrawerEl = panelEl.querySelector('.ai-settings-drawer');

      on(panelEl.querySelector('.ai-btn-close'), 'click', () => togglePanel(false));
      on(panelEl.querySelector('.ai-btn-expand'), 'click', () => {
        isExpanded = !isExpanded;
        panelEl.classList.toggle('is-expanded', isExpanded);
      });
      on(panelEl.querySelector('.ai-btn-clear'), 'click', () => {
        messages = [];
        saveHistory();
        renderMessages();
      });
      on(panelEl.querySelector('.ai-btn-settings'), 'click', () => {
        toggleSettingsDrawer(!isSettingsOpen);
      });
      on(panelEl.querySelector('.ai-settings-cancel'), 'click', () => {
        toggleSettingsDrawer(false);
      });
      on(panelEl.querySelector('.ai-settings-save'), 'click', () => {
        void saveSettings();
      });

      panelEl.querySelectorAll('.ai-quick-chip').forEach((chip) => {
        on(chip, 'click', () => {
          const mode = chip.getAttribute('data-mode') || 'site_analysis';
          const labelMap = {
            site_analysis: '📊 ჩაატარე საიტის მიმდინარე მდგომარეობის სრული ანალიზი და მოამზადე სამოქმედო გეგმა.',
            statements_analysis: '📨 შეისწავლე ყველა უპასუხო განცხადება და მათზე მიბმული დოკუმენტები, შეაფასე და მოამზადე სარეკომენდაციო პასუხები.',
            exam_analysis: '🎓 გააანალიზე გამოცდების შედეგები, კანდიდატები და 30-დღიანი ვადები.',
          };
          void sendChatMessage(labelMap[mode] || chip.textContent, { mode });
        });
      });

      const formEl = panelEl.querySelector('.ai-input-bar');
      on(formEl, 'submit', (e) => {
        e.preventDefault();
        const text = String(inputEl?.value || '').trim();
        if (!text || isSending) return;
        inputEl.value = '';
        void sendChatMessage(text, { mode: 'chat' });
      });

      on(inputEl, 'keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          formEl.requestSubmit();
        }
      });
    }

    function toggleSettingsDrawer(force) {
      isSettingsOpen = typeof force === 'boolean' ? force : !isSettingsOpen;
      if (!settingsDrawerEl) return;
      settingsDrawerEl.hidden = !isSettingsOpen;
      if (isSettingsOpen) {
        const maskedHint = settingsDrawerEl.querySelector('.ai-masked-key-hint');
        const modelSelect = settingsDrawerEl.querySelector('.ai-select-model');
        const customPromptInput = settingsDrawerEl.querySelector('.ai-input-custom-prompt');
        const keyInput = settingsDrawerEl.querySelector('.ai-input-apikey');
        if (maskedHint) {
          maskedHint.textContent = aiStatus.masked_key
            ? `(შენახულია: ${aiStatus.masked_key})`
            : '(ჯერ არ არის შენახული)';
        }
        if (keyInput) keyInput.value = '';
        if (modelSelect) modelSelect.value = aiStatus.model || 'gemini-4-argon';
        if (customPromptInput) customPromptInput.value = aiStatus.custom_system_prompt || '';
      }
    }

    async function saveSettings() {
      const keyInput = settingsDrawerEl?.querySelector('.ai-input-apikey');
      const modelSelect = settingsDrawerEl?.querySelector('.ai-select-model');
      const customPromptInput = settingsDrawerEl?.querySelector('.ai-input-custom-prompt');
      const saveBtn = settingsDrawerEl?.querySelector('.ai-settings-save');

      const payload = {
        model: modelSelect?.value || 'gemini-4-argon',
        custom_system_prompt: customPromptInput?.value || '',
      };
      const typedKey = String(keyInput?.value || '').trim();
      if (typedKey) {
        payload.api_key = typedKey;
      }

      if (saveBtn) saveBtn.disabled = true;
      try {
        const resp = await fetch(`${API_BASE}/admin/ai/settings`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          throw new Error('პარამეტრების შენახვა ვერ მოხერხდა');
        }
        const data = await resp.json();
        aiStatus = { ...aiStatus, ...data };
        syncStatusUI();
        toggleSettingsDrawer(false);
        showToast('Gemini-ს პარამეტრები შეინახა');
        renderMessages();
      } catch (err) {
        showToast(err?.message || 'შენახვა ვერ მოხერხდა', 'error');
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    function togglePanel(force) {
      buildUI();
      isOpen = typeof force === 'boolean' ? force : !isOpen;
      panelEl.hidden = !isOpen;
      fabEl?.classList.toggle('is-open', isOpen);
      if (isOpen) {
        void fetchStatus().then(() => {
          if (!aiStatus.configured) {
            toggleSettingsDrawer(true);
          }
          renderMessages();
          inputEl?.focus();
        });
      }
    }

    function createProposalCardElement(proposal, msgObj, proposalIndex) {
      const card = document.createElement('div');
      card.className = `ai-letter-confirm-card ${proposal.sent ? 'is-sent' : ''}`;

      const modeLabel = TEMPLATE_MODE_LABELS[proposal.template_mode] || proposal.template_mode;
      const showDateTime = proposal.template_mode === 'exam' || proposal.template_mode === 'certificate';

      card.innerHTML = `
        <div class="ai-letter-card-head">
          <span class="ai-letter-card-badge">${
            proposal.sent
              ? `✓ გაგზავნილია ${proposal.sentDocNumber ? `(№ ${escapeHtml(proposal.sentDocNumber)})` : ''}`
              : '⚠️ წერილის გაგზავნა საჭიროებს თქვენს დადასტურებას'
          }</span>
          <span class="ai-letter-card-type">${escapeHtml(modeLabel)}</span>
        </div>

        <div class="ai-letter-card-summary">
          <div class="ai-letter-summary-row">
            <strong>📍 სად / ვის ეგზავნება:</strong>
            <span>${escapeHtml(proposal.user_name)} (პ/ნ: ${escapeHtml(proposal.personal_id || '—')}) — <code>${escapeHtml(proposal.to_email)}</code></span>
          </div>
          <div class="ai-letter-summary-row">
            <strong>💡 რატომ იგზავნება:</strong>
            <span>${escapeHtml(proposal.reason || '—')}</span>
          </div>
          <div class="ai-letter-summary-row">
            <strong>🎓 კატეგორია:</strong>
            <select class="ai-letter-cat-select" ${proposal.sent ? 'disabled' : ''}>
              <option value="A" ${proposal.candidate_category === 'A' ? 'selected' : ''}>კატეგორია A</option>
              <option value="B" ${proposal.candidate_category === 'B' ? 'selected' : ''}>კატეგორია B</option>
              <option value="C" ${proposal.candidate_category === 'C' ? 'selected' : ''}>კატეგორია C</option>
              <option value="B_A" ${proposal.candidate_category === 'B_A' ? 'selected' : ''}>კატეგორია B ან A</option>
              <option value="C_A" ${proposal.candidate_category === 'C_A' ? 'selected' : ''}>კატეგორია C ან A</option>
            </select>
          </div>
          ${
            showDateTime
              ? `
            <div class="ai-letter-summary-row ai-letter-datetime-row">
              <label><strong>📅 თარიღი:</strong> <input type="date" class="ai-letter-date-input" value="${escapeHtml(proposal.event_date || '')}" ${proposal.sent ? 'disabled' : ''} /></label>
              <label><strong>🕒 საათი:</strong> <input type="time" class="ai-letter-time-input" value="${escapeHtml(proposal.event_time || '10:00')}" ${proposal.sent ? 'disabled' : ''} /></label>
              <label><strong>ცვლა:</strong>
                <select class="ai-letter-period-select" ${proposal.sent ? 'disabled' : ''}>
                  <option value="morning" ${proposal.period === 'morning' ? 'selected' : ''}>დილის ცვლა</option>
                  <option value="evening" ${proposal.period === 'evening' ? 'selected' : ''}>საღამოს ცვლა</option>
                </select>
              </label>
            </div>
          `
              : ''
          }
        </div>

        <div class="ai-letter-card-editor">
          <label class="ai-letter-field-label">
            <span>✉️ წერილის სათაური:</span>
            <input type="text" class="ai-letter-subject-input" value="${escapeHtml(proposal.subject || '')}" ${proposal.sent ? 'disabled' : ''} />
          </label>
          <label class="ai-letter-field-label">
            <span>📝 წერილის სრული ტექსტი (შეგიძლიათ ჩაასწოროთ გაგზავნამდე):</span>
            <textarea class="ai-letter-body-textarea" rows="7" ${proposal.sent ? 'disabled' : ''}>${escapeHtml(proposal.body || '')}</textarea>
          </label>
        </div>

        <div class="ai-letter-card-actions">
          ${
            proposal.sent
              ? `<span class="ai-letter-sent-confirm-note">✅ წერილი დადასტურებულია და გაგზავნილია</span>`
              : `<button type="button" class="ai-letter-confirm-send-btn">✅ ვადასტურებ და გაიგზავნოს</button>`
          }
        </div>
      `;

      const confirmBtn = card.querySelector('.ai-letter-confirm-send-btn');
      if (confirmBtn) {
        on(confirmBtn, 'click', async () => {
          const catSelect = card.querySelector('.ai-letter-cat-select');
          const dateInput = card.querySelector('.ai-letter-date-input');
          const timeInput = card.querySelector('.ai-letter-time-input');
          const periodSelect = card.querySelector('.ai-letter-period-select');
          const subjectInput = card.querySelector('.ai-letter-subject-input');
          const bodyInput = card.querySelector('.ai-letter-body-textarea');

          const finalSubject = String(subjectInput?.value || '').trim();
          const finalBody = String(bodyInput?.value || '').trim();
          const finalCategory = String(catSelect?.value || proposal.candidate_category || 'A').trim();
          const finalDate = String(dateInput?.value || proposal.event_date || '').trim();
          const finalTime = String(timeInput?.value || proposal.event_time || '10:00').trim();
          const finalPeriod = showDateTime
            ? String(periodSelect?.value || proposal.period || 'morning').trim()
            : proposal.period;

          if (!finalSubject || !finalBody) {
            showToast('წერილის სათაური და ტექსტი სავალდებულოა', 'error');
            return;
          }

          const confirmText = [
            `დაადასტურეთ წერილის გაგზავნა:`,
            `• მიმღები: ${proposal.user_name} (${proposal.to_email})`,
            `• ტიპი: ${modeLabel}`,
            `• დასაბუთება: ${proposal.reason || '—'}`,
            `• სათაური: ${finalSubject}`,
            ``,
            `ნამდვილად გსურთ წერილის გაგზავნა?`,
          ].join('\n');

          if (!global.confirm(confirmText)) return;

          confirmBtn.disabled = true;
          confirmBtn.textContent = 'იგზავნება...';

          try {
            const formData = new FormData();
            formData.append('kind', proposal.kind || 'exam');
            formData.append('event_date', finalDate);
            formData.append('event_time', finalTime);
            formData.append('period', finalPeriod);
            formData.append('subject', finalSubject);
            formData.append('body', finalBody);
            formData.append('request_id', generateUuid());
            formData.append('expected_to_email', proposal.to_email);
            formData.append('confirmed', 'true');
            formData.append('action_mode', 'save_and_send');
            formData.append('use_template_attachment', 'true');
            if (proposal.template_updated_at) {
              formData.append('template_updated_at', proposal.template_updated_at);
            }
            if (finalCategory) {
              formData.append('candidate_category', finalCategory);
            }
            if (proposal.statement_id != null) {
              formData.append('statement_id', String(proposal.statement_id));
            }

            const resp = await fetch(
              `${API_BASE}/admin/users/${encodeURIComponent(proposal.user_id)}/planning-letters`,
              {
                method: 'POST',
                headers: { ...getAdminHeaders(), ...getActorHeaders() },
                body: formData,
              }
            );
            if (!resp.ok) {
              let errDetail = 'წერილის გაგზავნა ვერ მოხერხდა';
              try {
                const errJson = await resp.json();
                if (errJson?.detail) errDetail = String(errJson.detail);
              } catch {}
              throw new Error(errDetail);
            }
            const result = await resp.json();
            proposal.sent = true;
            proposal.sentDocNumber = result?.doc_number || '';
            proposal.subject = finalSubject;
            proposal.body = finalBody;
            proposal.candidate_category = finalCategory;
            proposal.event_date = finalDate;
            proposal.event_time = finalTime;
            proposal.period = finalPeriod;
            saveHistory();
            renderMessages();
            showToast(`წერილი წარმატებით გაიგზავნა (${proposal.to_email})`);
            onLetterSent?.(proposal.user_id, result);
            void fetchStatus();
          } catch (err) {
            confirmBtn.disabled = false;
            confirmBtn.textContent = '✅ ვადასტურებ და გაიგზავნოს';
            showToast(err?.message || 'წერილის გაგზავნა ვერ მოხერხდა', 'error');
          }
        });
      }

      return card;
    }

    function renderMessages() {
      if (!messagesContainerEl) return;
      messagesContainerEl.innerHTML = '';

      if (!messages.length) {
        const welcome = document.createElement('div');
        welcome.className = 'ai-welcome-box';
        welcome.innerHTML = `
          <div class="ai-welcome-title">👋 გამარჯობა! მე ვარ GIPC-ის AI ოპერატიული მრჩეველი (Gemini 4 Argon).</div>
          <p class="ai-welcome-text">
            შემიძლია შევისწავლო შემოსული განცხადებები, წავიკითხო მიბმული PDF/Word/სურათი დოკუმენტები,
            გადავამოწმო გამოცდების შედეგები და მოგიმზადოთ სამოქმედო გეგმა და საპასუხო წერილები.
          </p>
          <div class="ai-welcome-safety">
            🔒 <strong>უსაფრთხოების გარანტია:</strong> წერილი არასდროს იგზავნება თავისით — თითოეულ შეთავაზებულ წერილზე
            ჩატში გამოგიჩნდებათ აღწერა (სად, რატომ და რა იგზავნება) და მხოლოდ თქვენი დადასტურების შემდეგ გაიგზავნება.
          </div>
        `;
        messagesContainerEl.appendChild(welcome);
        return;
      }

      messages.forEach((msg) => {
        const itemEl = document.createElement('div');
        itemEl.className = `ai-msg-item ${msg.role === 'user' ? 'is-user' : 'is-assistant'}`;

        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';

        if (Array.isArray(msg.inspected_attachments) && msg.inspected_attachments.length > 0) {
          const filesBar = document.createElement('div');
          filesBar.className = 'ai-msg-files-inspected';
          filesBar.innerHTML = `📎 შესწავლილი დოკუმენტები: <strong>${escapeHtml(
            msg.inspected_attachments.join(', ')
          )}</strong>`;
          bubble.appendChild(filesBar);
        }

        const contentDiv = document.createElement('div');
        contentDiv.className = 'ai-msg-content';
        contentDiv.innerHTML = formatMarkdownSimple(msg.content);
        bubble.appendChild(contentDiv);

        itemEl.appendChild(bubble);

        if (Array.isArray(msg.proposed_letters) && msg.proposed_letters.length > 0) {
          msg.proposed_letters.forEach((prop, idx) => {
            itemEl.appendChild(createProposalCardElement(prop, msg, idx));
          });
        }

        messagesContainerEl.appendChild(itemEl);
      });

      if (isSending) {
        const loadingEl = document.createElement('div');
        loadingEl.className = 'ai-msg-item is-assistant is-loading';
        loadingEl.innerHTML = `
          <div class="ai-msg-bubble">
            <span class="ai-typing-indicator">✨ Gemini 4 Argon სწავლობს ბაზას და მიბმულ დოკუმენტებს...</span>
          </div>
        `;
        messagesContainerEl.appendChild(loadingEl);
      }

      messagesContainerEl.scrollTop = messagesContainerEl.scrollHeight;
    }

    async function sendChatMessage(
      text,
      { mode = 'chat', statementId = null, userId = null } = {}
    ) {
      if (isSending) return;
      buildUI();
      if (!isOpen) togglePanel(true);

      const userMessage = {
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
      };
      messages.push(userMessage);
      saveHistory();
      isSending = true;
      if (sendBtnEl) sendBtnEl.disabled = true;
      renderMessages();

      try {
        const apiMessages = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const resp = await fetch(`${API_BASE}/admin/ai/chat`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({
            messages: apiMessages,
            mode,
            statement_id: statementId,
            user_id: userId,
          }),
        });

        if (!resp.ok) {
          let detail = 'AI ასისტენტთან დაკავშირება ვერ მოხერხდა';
          try {
            const errJson = await resp.json();
            if (errJson?.detail) detail = String(errJson.detail);
          } catch {}
          if (resp.status === 400 && detail.includes('API Key')) {
            toggleSettingsDrawer(true);
          }
          throw new Error(detail);
        }

        const data = await resp.json();
        messages.push({
          role: 'assistant',
          content: data.reply || 'ანალიზი დასრულებულია.',
          proposed_letters: Array.isArray(data.proposed_letters) ? data.proposed_letters : [],
          inspected_attachments: Array.isArray(data.inspected_attachments)
            ? data.inspected_attachments
            : [],
          timestamp: new Date().toISOString(),
        });
        saveHistory();
      } catch (err) {
        messages.push({
          role: 'assistant',
          content: `⚠️ **შეცდომა:** ${err?.message || 'მოთხოვნა ვერ შესრულდა.'}`,
          proposed_letters: [],
          inspected_attachments: [],
          timestamp: new Date().toISOString(),
        });
        saveHistory();
      } finally {
        isSending = false;
        if (sendBtnEl) sendBtnEl.disabled = false;
        renderMessages();
      }
    }

    function analyzeStatement({
      statementId,
      docNumber,
      userId,
      userName,
      hasAttachment,
      attachmentFilename,
    }) {
      const docPart = docNumber ? ` (№ ${docNumber})` : '';
      const filePart = hasAttachment
        ? ` და მასზე მიბმული დოკუმენტი "${attachmentFilename || 'ფაილი'}"`
        : '';
      const prompt = `გთხოვ დეტალურად შეისწავლო ${userName || 'განმცხადებლის'} შემოსული განცხადება${docPart}${filePart}. შეაფასე რამდენად აკმაყოფილებს მოთხოვნებს და მოამზადე შესაბამისი სარეკომენდაციო საპასუხო წერილი დასადასტურებლად.`;
      void sendChatMessage(prompt, {
        mode: 'statements_analysis',
        statementId,
        userId,
      });
    }

    function init() {
      loadHistory();
      buildUI();
      void fetchStatus();

      global.addEventListener('admin:aiAnalyzeStatement', (event) => {
        const detail = event?.detail || {};
        if (detail.statementId != null) {
          analyzeStatement(detail);
        }
      });
    }

    return {
      init,
      open: () => togglePanel(true),
      close: () => togglePanel(false),
      analyzeStatement,
      refreshStatus: fetchStatus,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createAiAssistantModule = createAiAssistantModule;
})(window);

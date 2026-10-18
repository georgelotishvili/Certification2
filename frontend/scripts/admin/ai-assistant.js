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
    let isSettingsModalOpen = false;
    let isSending = false;
    let aiStatus = {
      configured: false,
      gemini_configured: false,
      openai_configured: false,
      masked_key: null,
      masked_gemini_key: null,
      masked_openai_key: null,
      model: 'gemini-4-argon',
      model_label: 'Gemini 4 Argon',
      provider: 'gemini',
      reasoning_level: 'high',
      reasoning_level_label: 'High (მაღალი / ღრმა ანალიზი)',
      reasoning_level_short: 'High',
      custom_system_prompt: '',
      default_system_prompt: '',
      quick_stats: { unseen_statements: 0, pending_statements: 0 },
    };

    const MODEL_OPTIONS = [
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon', provider: 'gemini', sub: 'Google Gemini 4' },
      { id: 'chatgpt-sol', label: 'ChatGPT Sol', provider: 'openai', sub: 'OpenAI ChatGPT' },
      { id: 'chatgpt-astra', label: 'ChatGPT Astra', provider: 'openai', sub: 'OpenAI ChatGPT' },
    ];

    const LEVEL_OPTIONS = [
      { id: 'standard', label: 'Standard', desc: 'სწრაფი' },
      { id: 'medium', label: 'Medium', desc: 'დაბალანსებული' },
      { id: 'high', label: 'High', desc: 'მაღალი' },
      { id: 'ultra', label: 'Ultra', desc: 'ულტრა' },
    ];

    let messages = [];
    let fabEl = null;
    let fabBadgeEl = null;
    let fabDotEl = null;
    let panelEl = null;
    let messagesContainerEl = null;
    let inputEl = null;
    let sendBtnEl = null;
    let headerConfigBtnEl = null;
    let settingsModalOverlayEl = null;

    let draftModel = 'gemini-4-argon';
    let draftLevel = 'high';

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

    function getActiveModelLabel() {
      const found = MODEL_OPTIONS.find((m) => m.id === aiStatus.model);
      return found ? found.label : aiStatus.model_label || 'Gemini 4 Argon';
    }

    function getActiveLevelShortLabel() {
      const found = LEVEL_OPTIONS.find((l) => l.id === aiStatus.reasoning_level);
      return found ? found.label : aiStatus.reasoning_level_short || 'High';
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
      const modelLabel = getActiveModelLabel();
      const levelShort = getActiveLevelShortLabel();

      if (fabDotEl) {
        fabDotEl.className = `ai-fab-status-dot ${aiStatus.configured ? 'is-ready' : 'is-unconfigured'}`;
        fabDotEl.title = aiStatus.configured
          ? `${modelLabel} • ${levelShort} ჩართულია`
          : 'საჭიროა API Key-ს მითითება';
      }
      const pendingCount = Number(aiStatus.quick_stats?.pending_statements || 0);
      if (fabBadgeEl) {
        fabBadgeEl.textContent = String(pendingCount);
        fabBadgeEl.hidden = pendingCount <= 0;
      }
      if (headerConfigBtnEl) {
        const dotHtml = `<span class="ai-header-config-dot ${aiStatus.configured ? 'is-ready' : 'is-unconfigured'}"></span>`;
        headerConfigBtnEl.innerHTML = `${dotHtml}<span>⚙️ ${escapeHtml(modelLabel)} • ${escapeHtml(levelShort)}</span><span class="ai-header-config-caret">▾</span>`;
        headerConfigBtnEl.className = `ai-header-config-btn ${aiStatus.configured ? 'is-ready' : 'is-unconfigured'}`;
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

      // Clean, uncluttered chat window
      panelEl = document.createElement('aside');
      panelEl.id = 'aiAssistantPanel';
      panelEl.className = 'ai-assistant-panel';
      panelEl.hidden = true;
      panelEl.innerHTML = `
        <div class="ai-panel-header">
          <div class="ai-panel-title-row">
            <span class="ai-panel-sparkle">✨</span>
            <h3 class="ai-panel-title">AI ჩატი</h3>
          </div>
          <button type="button" class="ai-header-config-btn is-unconfigured" title="AI მოდელის, დონის, პარამეტრებისა და სწრაფი ანალიზის ფანჯარა">
            <span class="ai-header-config-dot is-unconfigured"></span>
            <span>⚙️ Gemini 4 Argon • High</span>
            <span class="ai-header-config-caret">▾</span>
          </button>
          <div class="ai-panel-header-actions">
            <button type="button" class="ai-panel-icon-btn ai-btn-expand" title="ფანჯრის გაფართოება / დაპატარავება">⛶</button>
            <button type="button" class="ai-panel-icon-btn ai-btn-clear" title="ჩატის გასუფთავება">🗑️</button>
            <button type="button" class="ai-panel-icon-btn ai-btn-close" title="დახურვა">×</button>
          </div>
        </div>

        <div class="ai-messages-container"></div>

        <form class="ai-input-bar">
          <textarea class="ai-chat-input" rows="1" placeholder="დაწერეთ შეტყობინება... (Enter - გაგზავნა)"></textarea>
          <button type="submit" class="ai-chat-send-btn">გაგზავნა ➤</button>
        </form>
      `;

      document.body.appendChild(panelEl);

      // Separate modal window for Model, Reasoning Level, API Keys & Quick Actions
      settingsModalOverlayEl = document.createElement('div');
      settingsModalOverlayEl.id = 'aiSettingsModalOverlay';
      settingsModalOverlayEl.className = 'ai-settings-modal-overlay';
      settingsModalOverlayEl.hidden = true;
      settingsModalOverlayEl.innerHTML = `
        <div class="ai-settings-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="aiSettingsModalTitle">
          <div class="ai-settings-modal-header">
            <h3 id="aiSettingsModalTitle" class="ai-settings-modal-title">⚙️ AI მოდელი, დონე და მართვა</h3>
            <button type="button" class="ai-settings-modal-close" title="დახურვა">×</button>
          </div>

          <div class="ai-settings-modal-body">
            <div class="ai-modal-section">
              <div class="ai-modal-section-title">1. აირჩიეთ ხელოვნური ინტელექტი (Model)</div>
              <div class="ai-model-cards-grid">
                ${MODEL_OPTIONS.map(
                  (m) => `
                  <button type="button" class="ai-model-card" data-model-id="${m.id}">
                    <span class="ai-model-card-name">${escapeHtml(m.label)}</span>
                    <span class="ai-model-card-sub">${escapeHtml(m.sub)}</span>
                  </button>
                `
                ).join('')}
              </div>
            </div>

            <div class="ai-modal-section">
              <div class="ai-modal-section-title">2. აზროვნების / ინტელექტის დონე (Level)</div>
              <div class="ai-level-pills-grid">
                ${LEVEL_OPTIONS.map(
                  (l) => `
                  <button type="button" class="ai-level-pill" data-level-id="${l.id}">
                    <span class="ai-level-pill-name">${escapeHtml(l.label)}</span>
                    <span class="ai-level-pill-desc">${escapeHtml(l.desc)}</span>
                  </button>
                `
                ).join('')}
              </div>
            </div>

            <div class="ai-modal-section">
              <div class="ai-modal-section-title">3. სწრაფი ანალიზის ბრძანებები</div>
              <div class="ai-modal-quick-grid">
                <button type="button" class="ai-quick-chip" data-mode="site_analysis">📊 საიტის სრული ანალიზი</button>
                <button type="button" class="ai-quick-chip" data-mode="statements_analysis">📨 უპასუხო განცხადებები და ფაილები</button>
                <button type="button" class="ai-quick-chip" data-mode="exam_analysis">📋 კანდიდატები და 30-დღიანი ვადები</button>
              </div>
            </div>

            <div class="ai-modal-section">
              <div class="ai-modal-section-title">4. API გასაღებები (API Keys)</div>
              <div class="ai-keys-grid">
                <label class="ai-settings-label">
                  <span>
                    Gemini API Key (Gemini 4 Argon)
                    <small class="ai-masked-gemini-hint"></small>
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" class="ai-key-link">🔑 გასაღების აღება</a>
                  </span>
                  <input type="password" class="ai-settings-input ai-input-gemini-key" placeholder="AIza... (ცარიელი = უცვლელი)" autocomplete="off" />
                </label>
                <label class="ai-settings-label">
                  <span>
                    OpenAI API Key (ChatGPT Sol / Astra)
                    <small class="ai-masked-openai-hint"></small>
                    <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="ai-key-link">🔑 გასაღების აღება</a>
                  </span>
                  <input type="password" class="ai-settings-input ai-input-openai-key" placeholder="sk-... (ცარიელი = უცვლელი)" autocomplete="off" />
                </label>
              </div>
            </div>

            <div class="ai-modal-section">
              <label class="ai-settings-label">
                <span>5. დამატებითი ინსტრუქცია (სურვილისამებრ — უსაფრთხოების პრომპტი ყოველთვის ჩართულია)</span>
                <textarea class="ai-settings-textarea ai-input-custom-prompt" rows="2" placeholder="მაგ: ყურადღება გაამახვილე სტაჟის ცნობებზე..."></textarea>
              </label>
            </div>
          </div>

          <div class="ai-settings-modal-footer">
            <button type="button" class="secondary-btn ai-settings-cancel">დახურვა</button>
            <button type="button" class="primary-btn ai-settings-save">შენახვა</button>
          </div>
        </div>
      `;

      document.body.appendChild(settingsModalOverlayEl);

      headerConfigBtnEl = panelEl.querySelector('.ai-header-config-btn');
      messagesContainerEl = panelEl.querySelector('.ai-messages-container');
      inputEl = panelEl.querySelector('.ai-chat-input');
      sendBtnEl = panelEl.querySelector('.ai-chat-send-btn');

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
      on(headerConfigBtnEl, 'click', () => {
        openSettingsModal();
      });

      on(settingsModalOverlayEl.querySelector('.ai-settings-modal-close'), 'click', () => {
        closeSettingsModal();
      });
      on(settingsModalOverlayEl.querySelector('.ai-settings-cancel'), 'click', () => {
        closeSettingsModal();
      });
      on(settingsModalOverlayEl, 'click', (e) => {
        if (e.target === settingsModalOverlayEl) {
          closeSettingsModal();
        }
      });
      on(settingsModalOverlayEl.querySelector('.ai-settings-save'), 'click', () => {
        void saveSettings();
      });

      settingsModalOverlayEl.querySelectorAll('.ai-model-card').forEach((btn) => {
        on(btn, 'click', () => {
          draftModel = btn.getAttribute('data-model-id') || 'gemini-4-argon';
          syncModalSelectionUI();
        });
      });

      settingsModalOverlayEl.querySelectorAll('.ai-level-pill').forEach((btn) => {
        on(btn, 'click', () => {
          draftLevel = btn.getAttribute('data-level-id') || 'high';
          syncModalSelectionUI();
        });
      });

      settingsModalOverlayEl.querySelectorAll('.ai-quick-chip').forEach((chip) => {
        on(chip, 'click', () => {
          const mode = chip.getAttribute('data-mode') || 'site_analysis';
          const labelMap = {
            site_analysis: '📊 ჩაატარე საიტის მიმდინარე მდგომარეობის სრული ანალიზი და მოამზადე სამოქმედო გეგმა.',
            statements_analysis: '📨 შეისწავლე ყველა უპასუხო განცხადება და მათზე მიბმული დოკუმენტები, შეაფასე და მოამზადე სარეკომენდაციო პასუხები.',
            exam_analysis: '📋 გააანალიზე კანდიდატების სტატუსები და სერტიფიკატის კანდიდატების 30-დღიანი ვადები.',
          };
          closeSettingsModal();
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

    function syncModalSelectionUI() {
      if (!settingsModalOverlayEl) return;
      settingsModalOverlayEl.querySelectorAll('.ai-model-card').forEach((btn) => {
        const id = btn.getAttribute('data-model-id');
        btn.classList.toggle('is-active', id === draftModel);
      });
      settingsModalOverlayEl.querySelectorAll('.ai-level-pill').forEach((btn) => {
        const id = btn.getAttribute('data-level-id');
        btn.classList.toggle('is-active', id === draftLevel);
      });
    }

    function openSettingsModal() {
      buildUI();
      isSettingsModalOpen = true;
      draftModel = aiStatus.model || 'gemini-4-argon';
      draftLevel = aiStatus.reasoning_level || 'high';
      syncModalSelectionUI();

      const geminiHint = settingsModalOverlayEl.querySelector('.ai-masked-gemini-hint');
      const openaiHint = settingsModalOverlayEl.querySelector('.ai-masked-openai-hint');
      const geminiInput = settingsModalOverlayEl.querySelector('.ai-input-gemini-key');
      const openaiInput = settingsModalOverlayEl.querySelector('.ai-input-openai-key');
      const customPromptInput = settingsModalOverlayEl.querySelector('.ai-input-custom-prompt');

      if (geminiHint) {
        geminiHint.textContent = aiStatus.masked_gemini_key
          ? `(შენახულია: ${aiStatus.masked_gemini_key})`
          : '(არ არის შენახული)';
      }
      if (openaiHint) {
        openaiHint.textContent = aiStatus.masked_openai_key
          ? `(შენახულია: ${aiStatus.masked_openai_key})`
          : '(არ არის შენახული)';
      }
      if (geminiInput) geminiInput.value = '';
      if (openaiInput) openaiInput.value = '';
      if (customPromptInput) customPromptInput.value = aiStatus.custom_system_prompt || '';

      settingsModalOverlayEl.hidden = false;
    }

    function closeSettingsModal() {
      isSettingsModalOpen = false;
      if (settingsModalOverlayEl) {
        settingsModalOverlayEl.hidden = true;
      }
    }

    async function saveSettings() {
      if (!settingsModalOverlayEl) return;
      const geminiInput = settingsModalOverlayEl.querySelector('.ai-input-gemini-key');
      const openaiInput = settingsModalOverlayEl.querySelector('.ai-input-openai-key');
      const customPromptInput = settingsModalOverlayEl.querySelector('.ai-input-custom-prompt');
      const saveBtn = settingsModalOverlayEl.querySelector('.ai-settings-save');

      const payload = {
        model: draftModel || 'gemini-4-argon',
        reasoning_level: draftLevel || 'high',
        custom_system_prompt: customPromptInput?.value || '',
      };

      const typedGemini = String(geminiInput?.value || '').trim();
      const typedOpenai = String(openaiInput?.value || '').trim();
      if (typedGemini) {
        payload.gemini_api_key = typedGemini;
      }
      if (typedOpenai) {
        payload.openai_api_key = typedOpenai;
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
        closeSettingsModal();
        showToast(`არჩეულია: ${getActiveModelLabel()} (${getActiveLevelShortLabel()})`);
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
          renderMessages();
          inputEl?.focus();
        });
      }
    }

    function createProposalCardElement(proposal) {
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
            <textarea class="ai-letter-body-textarea" rows="6" ${proposal.sent ? 'disabled' : ''}>${escapeHtml(proposal.body || '')}</textarea>
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

      if (!messages.length && !isSending) {
        const emptyHint = document.createElement('div');
        emptyHint.className = 'ai-empty-chat-hint';
        emptyHint.innerHTML = `
          <span>💬 დაწერეთ შეტყობინება ქვემოთ ან დააჭირეთ ზემოთ <strong>⚙️ ${escapeHtml(getActiveModelLabel())} • ${escapeHtml(getActiveLevelShortLabel())}</strong> ღილაკს მოდელის/ანალიზის ასარჩევად.</span>
        `;
        messagesContainerEl.appendChild(emptyHint);
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
          msg.proposed_letters.forEach((prop) => {
            itemEl.appendChild(createProposalCardElement(prop));
          });
        }

        messagesContainerEl.appendChild(itemEl);
      });

      if (isSending) {
        const loadingEl = document.createElement('div');
        loadingEl.className = 'ai-msg-item is-assistant is-loading';
        loadingEl.innerHTML = `
          <div class="ai-msg-bubble">
            <span class="ai-typing-indicator">✨ ${escapeHtml(getActiveModelLabel())} (${escapeHtml(getActiveLevelShortLabel())}) ამუშავებს მოთხოვნას...</span>
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
            openSettingsModal();
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

    const FORBIDDEN_EXAM_SECTIONS = new Set(['exam', 'multiApartment', 'multiFunctional']);

    function init() {
      loadHistory();
      buildUI();
      void fetchStatus();

      global.addEventListener('admin:sectionChanged', (event) => {
        const sec = event?.detail?.section || '';
        const isForbidden = FORBIDDEN_EXAM_SECTIONS.has(sec);
        if (isForbidden) {
          closeSettingsModal();
          togglePanel(false);
          if (fabEl) fabEl.hidden = true;
        } else {
          if (fabEl) fabEl.hidden = false;
        }
      });

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

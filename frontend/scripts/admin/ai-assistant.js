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
      system_prompt: null,
      system_prompt_customized: false,
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
    let promptBoardOverlayEl = null;
    let attachmentsPreviewBarEl = null;
    let attachFileInputEl = null;
    let folderInputEl = null;
    let computerConnectBtnEl = null;

    let pendingAttachments = [];
    let localComputerDirHandle = null;
    let localComputerFolderName = '';
    let localComputerFiles = [];

    let draftModel = 'gemini-4-argon';
    let draftLevel = 'high';
    let draftSystemPrompt = '';

    const TEMPLATE_MODE_LABELS = {
      exam: 'გამოცდის დაგეგმვა (დადებითი პასუხი)',
      rejection: 'უარყოფითი პასუხი (განაცხადის უარყოფა)',
      certificate: 'სერტიფიკატის გადაცემა (ჩაბარების წერილი)',
      exam_fail: 'ჩაჭრის შეტყობინება',
      custom: 'სხვა შეტყობინება',
    };

    const ICONS = {
      sparkle: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M3 5h4"/></svg>`,
      sliders: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="2" x2="6" y1="14" y2="14"/><line x1="10" x2="14" y1="8" y2="8"/><line x1="18" x2="22" y1="16" y2="16"/></svg>`,
      chevronDown: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
      folder: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
      expand: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/></svg>`,
      trash: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,
      close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
      chart: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>`,
      inbox: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/></svg>`,
      clock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
      paperclip: `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
      send: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
    };

    function generateUuid() {
      if (global.crypto?.randomUUID) return global.crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
    }

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('ფაილის წაკითხვა ვერ მოხერხდა'));
        reader.readAsDataURL(file);
      });
    }

    function base64ToBlob(b64Data, contentType = 'application/octet-stream') {
      const clean = String(b64Data || '').includes(',')
        ? String(b64Data).split(',')[1]
        : String(b64Data || '');
      const byteCharacters = atob(clean);
      const byteArrays = [];
      for (let offset = 0; offset < byteCharacters.length; offset += 512) {
        const slice = byteCharacters.slice(offset, offset + 512);
        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i += 1) {
          byteNumbers[i] = slice.charCodeAt(i);
        }
        byteArrays.push(new Uint8Array(byteNumbers));
      }
      return new Blob(byteArrays, { type: contentType });
    }

    async function addFilesToPendingAttachments(fileList) {
      if (!fileList || !fileList.length) return;
      for (const file of Array.from(fileList)) {
        if (pendingAttachments.length >= 6) {
          showToast('ერთ შეტყობინებაზე მაქსიმუმ 6 ფაილის მიბმა შეიძლება', 'error');
          break;
        }
        if (file.size > 15 * 1024 * 1024) {
          showToast(`ფაილი "${file.name}" ძალიან დიდია (მაქს. 15MB)`, 'error');
          continue;
        }
        try {
          const dataUrl = await readFileAsDataUrl(file);
          const commaIdx = dataUrl.indexOf(',');
          const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
          const mime = file.type || 'application/octet-stream';
          pendingAttachments.push({
            filename: file.name || `screenshot-${Date.now()}.png`,
            mime_type: mime,
            data_base64: b64,
            preview_url: mime.startsWith('image/') ? dataUrl : null,
            file_obj: file,
          });
        } catch {
          showToast(`ფაილის "${file.name}" მიბმა ვერ მოხერხდა`, 'error');
        }
      }
      renderPendingAttachments();
    }

    function renderPendingAttachments() {
      if (!attachmentsPreviewBarEl) return;
      if (!pendingAttachments.length) {
        attachmentsPreviewBarEl.hidden = true;
        attachmentsPreviewBarEl.innerHTML = '';
        return;
      }
      attachmentsPreviewBarEl.hidden = false;
      attachmentsPreviewBarEl.innerHTML = pendingAttachments
        .map(
          (att, idx) => `
          <div class="ai-pending-att-chip">
            ${
              att.preview_url
                ? `<img src="${att.preview_url}" alt="${escapeHtml(att.filename)}" class="ai-pending-att-thumb" />`
                : `<span class="ai-pending-att-icon">${ICONS.inbox}</span>`
            }
            <span class="ai-pending-att-name" title="${escapeHtml(att.filename)}">${escapeHtml(att.filename)}</span>
            <button type="button" class="ai-pending-att-remove" data-att-idx="${idx}" title="მოხსნა">${ICONS.close}</button>
          </div>
        `
        )
        .join('');
      attachmentsPreviewBarEl.querySelectorAll('.ai-pending-att-remove').forEach((btn) => {
        on(btn, 'click', () => {
          const i = Number(btn.getAttribute('data-att-idx'));
          if (!Number.isNaN(i)) {
            pendingAttachments.splice(i, 1);
            renderPendingAttachments();
          }
        });
      });
    }

    const IDB_NAME = 'gipc_ai_local_fs_v1';
    const IDB_STORE = 'handles';
    const IDB_KEY = 'computer_dir_handle';
    let savedHandleNeedsPermission = false;

    function openHandleDb() {
      return new Promise((resolve, reject) => {
        if (!global.indexedDB) {
          reject(new Error('IndexedDB unavailable'));
          return;
        }
        const req = global.indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    async function saveDirHandleToIdb(dirHandle) {
      try {
        const db = await openHandleDb();
        await new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readwrite');
          tx.objectStore(IDB_STORE).put(dirHandle, IDB_KEY);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      } catch {}
    }

    async function loadDirHandleFromIdb() {
      try {
        const db = await openHandleDb();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      } catch {
        return null;
      }
    }

    async function restoreSavedComputerFolder() {
      if (localComputerFiles.length > 0) return;
      const savedHandle = await loadDirHandleFromIdb();
      if (!savedHandle || typeof savedHandle.queryPermission !== 'function') return;
      try {
        localComputerDirHandle = savedHandle;
        localComputerFolderName = savedHandle.name || 'doc 2';
        const perm = await savedHandle.queryPermission({ mode: 'read' });
        if (perm === 'granted') {
          savedHandleNeedsPermission = false;
          localComputerFiles = await scanDirectoryHandle(savedHandle);
        } else {
          savedHandleNeedsPermission = true;
        }
        syncComputerBtnUI();
      } catch {}
    }

    async function scanDirectoryHandle(dirHandle, prefix = '', depth = 0, out = []) {
      if (depth > 3 || out.length >= 400) return out;
      for await (const [name, handle] of dirHandle.entries()) {
        if (out.length >= 400) break;
        if (name.startsWith('.') || name.startsWith('~$')) continue;
        const relPath = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'file') {
          try {
            const file = await handle.getFile();
            out.push({
              path: relPath,
              name: file.name,
              size_bytes: file.size,
              last_modified: file.lastModified || 0,
              mime_type: file.type || '',
              handle,
              file,
            });
          } catch {}
        } else if (handle.kind === 'directory' && depth < 2) {
          await scanDirectoryHandle(handle, relPath, depth + 1, out);
        }
      }
      return out;
    }

    function syncComputerBtnUI() {
      if (!computerConnectBtnEl) return;
      if (localComputerFiles.length > 0) {
        computerConnectBtnEl.classList.add('is-connected');
        computerConnectBtnEl.innerHTML = `${ICONS.folder}<span>${escapeHtml(localComputerFolderName || 'კომპიუტერი')} (${localComputerFiles.length})</span>`;
        computerConnectBtnEl.title = `დაკავშირებულია ცოცხალ რეჟიმში: "${localComputerFolderName}" (${localComputerFiles.length} ფაილი). ყოველი შეტყობინებისას იკითხება უახლესი ვერსია. დააჭირეთ სხვა საქაღალდის ასარჩევად.`;
      } else if (savedHandleNeedsPermission && localComputerDirHandle) {
        computerConnectBtnEl.classList.remove('is-connected');
        computerConnectBtnEl.innerHTML = `${ICONS.folder}<span>${escapeHtml(localComputerFolderName)} (ჩართვა)</span>`;
        computerConnectBtnEl.title = `დამახსოვრებულია საქაღალდე "${localComputerFolderName}". დააჭირეთ წვდომის გასააქტიურებლად (ან Shift+კლიკი სხვა საქაღალდის ასარჩევად).`;
      } else {
        computerConnectBtnEl.classList.remove('is-connected');
        computerConnectBtnEl.innerHTML = `${ICONS.folder}<span>კომპიუტერი</span>`;
        computerConnectBtnEl.title = 'კომპიუტერის საქაღალდესთან (მაგ. doc 2) ცოცხალი წვდომის ჩართვა';
      }
    }

    async function connectLocalComputerFolder(event) {
      if (
        savedHandleNeedsPermission &&
        localComputerDirHandle &&
        !event?.shiftKey &&
        typeof localComputerDirHandle.requestPermission === 'function'
      ) {
        try {
          let perm = await localComputerDirHandle.requestPermission({ mode: 'readwrite' });
          if (perm !== 'granted') {
            perm = await localComputerDirHandle.requestPermission({ mode: 'read' });
          }
          if (perm === 'granted') {
            savedHandleNeedsPermission = false;
            localComputerFiles = await scanDirectoryHandle(localComputerDirHandle);
            syncComputerBtnUI();
            showToast(
              `საქაღალდე "${localComputerFolderName}" გააქტიურდა (${localComputerFiles.length} ფაილი — ცოცხალი სინქრონიზაცია)`
            );
            renderMessages();
            return;
          }
        } catch {}
      }

      if (typeof global.showDirectoryPicker === 'function') {
        try {
          let dirHandle;
          try {
            dirHandle = await global.showDirectoryPicker({ mode: 'readwrite' });
          } catch {
            dirHandle = await global.showDirectoryPicker({ mode: 'read' });
          }
          localComputerDirHandle = dirHandle;
          localComputerFolderName = dirHandle.name || 'საქაღალდე';
          savedHandleNeedsPermission = false;
          await saveDirHandleToIdb(dirHandle);
          localComputerFiles = await scanDirectoryHandle(dirHandle);
          syncComputerBtnUI();
          showToast(
            `კომპიუტერის საქაღალდე "${localComputerFolderName}" დაკავშირებულია (${localComputerFiles.length} ფაილი — ცოცხალი წაკითხვა)`
          );
          renderMessages();
          return;
        } catch (err) {
          if (err?.name === 'AbortError') return;
        }
      }
      folderInputEl?.click();
    }

    async function resolveComputerFileObj(pathOrName) {
      if (!pathOrName) return null;
      const target = String(pathOrName).trim().toLowerCase();
      if (!target) return null;
      for (const att of pendingAttachments) {
        if (att.filename.toLowerCase() === target && att.file_obj) {
          return att.file_obj;
        }
      }
      let match =
        localComputerFiles.find((f) => f.path.toLowerCase() === target) ||
        localComputerFiles.find((f) => f.name.toLowerCase() === target) ||
        localComputerFiles.find(
          (f) => f.name.toLowerCase().includes(target) || target.includes(f.name.toLowerCase())
        );
      if (!match) return null;
      // Always read fresh from handle first so live edits on disk are immediately reflected
      if (match.handle) {
        try {
          const freshFile = await match.handle.getFile();
          match.file = freshFile;
          match.size_bytes = freshFile.size;
          match.last_modified = freshFile.lastModified || 0;
          return freshFile;
        } catch {}
      }
      if (match.file) return match.file;
      return null;
    }

    async function triggerFileDownload(dlItem, { saveToConnectedFolder = false } = {}) {
      if (!dlItem) return;
      try {
        let blob = null;
        let filename = dlItem.filename || 'download.txt';
        if (dlItem.mode === 'stored' && dlItem.download_url) {
          const resp = await fetch(`${API_BASE}${dlItem.download_url}`, {
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          });
          if (!resp.ok) throw new Error('ფაილის ჩამოწერა ვერ მოხერხდა');
          blob = await resp.blob();
        } else if (dlItem.data_base64) {
          blob = base64ToBlob(dlItem.data_base64, dlItem.mime_type || 'application/octet-stream');
        }
        if (!blob) return;

        if (saveToConnectedFolder && localComputerDirHandle?.getFileHandle) {
          try {
            const fileHandle = await localComputerDirHandle.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(blob);
            await writable.close();
            showToast(`ფაილი "${filename}" შეინახა საქაღალდეში "${localComputerFolderName}"`);
            return;
          } catch {}
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        showToast(`ფაილი "${filename}" ჩამოიწერა კომპიუტერში`);
      } catch (err) {
        showToast(err?.message || 'ფაილის ჩამოწერა ვერ მოხერხდა', 'error');
      }
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
        const stripped = messages.slice(-30).map((m) => ({
          ...m,
          user_attachments: Array.isArray(m.user_attachments)
            ? m.user_attachments.map((a) => ({
                filename: a.filename,
                mime_type: a.mime_type,
              }))
            : undefined,
        }));
        global.sessionStorage?.setItem?.(STORAGE_KEY_HISTORY, JSON.stringify(stripped));
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
        headerConfigBtnEl.innerHTML = `${dotHtml}${ICONS.sliders}<span class="ai-header-config-text">${escapeHtml(modelLabel)} • ${escapeHtml(levelShort)}</span><span class="ai-header-config-caret">${ICONS.chevronDown}</span>`;
        headerConfigBtnEl.className = `ai-header-config-btn ${aiStatus.configured ? 'is-ready' : 'is-unconfigured'}`;
      }
      syncComputerBtnUI();
    }

    function buildUI() {
      if (panelEl) return;

      fabEl = document.createElement('button');
      fabEl.type = 'button';
      fabEl.id = 'aiAssistantFab';
      fabEl.className = 'ai-assistant-fab';
      fabEl.innerHTML = `
        <span class="ai-fab-icon">${ICONS.sparkle}</span>
        <span class="ai-fab-label">AI ასისტენტი</span>
        <span class="ai-fab-status-dot is-unconfigured"></span>
        <span class="ai-fab-badge" hidden>0</span>
      `;
      fabDotEl = fabEl.querySelector('.ai-fab-status-dot');
      fabBadgeEl = fabEl.querySelector('.ai-fab-badge');
      on(fabEl, 'click', () => togglePanel());
      document.body.appendChild(fabEl);

      // Clean, light, modern chat window with top quick-analysis toolbar
      panelEl = document.createElement('aside');
      panelEl.id = 'aiAssistantPanel';
      panelEl.className = 'ai-assistant-panel';
      panelEl.hidden = true;
      panelEl.innerHTML = `
        <div class="ai-panel-header">
          <div class="ai-panel-header-left">
            <div class="ai-panel-title-row">
              <span class="ai-panel-brand-badge">${ICONS.sparkle}</span>
              <h3 class="ai-panel-title">AI ჩატი</h3>
            </div>
            <button type="button" class="ai-header-config-btn is-unconfigured" title="AI მოდელის, აზროვნების დონისა და API გასაღების პარამეტრები">
              <span class="ai-header-config-dot is-unconfigured"></span>
              ${ICONS.sliders}
              <span class="ai-header-config-text">Gemini 4 Argon • High</span>
              <span class="ai-header-config-caret">${ICONS.chevronDown}</span>
            </button>
          </div>
          <div class="ai-panel-header-actions">
            <button type="button" class="ai-computer-connect-btn" title="კომპიუტერის საქაღალდესთან წვდომის ჩართვა (ფაილების ძებნა, წაკითხვა, ჩამოწერა და წერილზე მიბმა)">${ICONS.folder}<span>კომპიუტერი</span></button>
            <button type="button" class="ai-panel-icon-btn ai-btn-expand" title="ფანჯრის გაფართოება / დაპატარავება">${ICONS.expand}</button>
            <button type="button" class="ai-panel-icon-btn ai-btn-clear" title="ჩატის გასუფთავება">${ICONS.trash}</button>
            <button type="button" class="ai-panel-icon-btn ai-btn-close" title="დახურვა">${ICONS.close}</button>
          </div>
        </div>

        <div class="ai-quick-toolbar" role="toolbar" aria-label="სწრაფი ანალიზის ბრძანებები">
          <button type="button" class="ai-quick-chip" data-mode="site_analysis" title="საიტის მიმდინარე მდგომარეობის სრული ანალიზი">
            ${ICONS.chart}
            <span>საიტის ანალიზი</span>
          </button>
          <button type="button" class="ai-quick-chip" data-mode="statements_analysis" title="უპასუხო განცხადებებისა და მიბმული ფაილების ანალიზი">
            ${ICONS.inbox}
            <span>განცხადებები და ფაილები</span>
          </button>
          <button type="button" class="ai-quick-chip" data-mode="exam_analysis" title="კანდიდატების სტატუსებისა და 30-დღიანი ვადების ანალიზი">
            ${ICONS.clock}
            <span>კანდიდატები და ვადები</span>
          </button>
        </div>

        <div class="ai-messages-container"></div>

        <div class="ai-attachments-preview-bar" hidden></div>

        <form class="ai-input-bar">
          <input type="file" class="ai-chat-file-input" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip" hidden />
          <input type="file" class="ai-chat-folder-input" webkitdirectory directory multiple hidden />
          <button type="button" class="ai-chat-attach-btn" title="სკრინის ან ფაილის მიბმა კომპიუტერიდან (ან დააჭირეთ Ctrl+V სკრინის ჩასასმელად)">${ICONS.paperclip}</button>
          <textarea class="ai-chat-input" rows="1" placeholder="დასვით კითხვა..."></textarea>
          <button type="submit" class="ai-chat-send-btn"><span>გაგზავნა</span>${ICONS.send}</button>
        </form>
      `;

      document.body.appendChild(panelEl);

      // Separate modal window for Model, Reasoning Level, and API Keys
      settingsModalOverlayEl = document.createElement('div');
      settingsModalOverlayEl.id = 'aiSettingsModalOverlay';
      settingsModalOverlayEl.className = 'ai-settings-modal-overlay';
      settingsModalOverlayEl.hidden = true;
      settingsModalOverlayEl.innerHTML = `
        <div class="ai-settings-modal-dialog" role="dialog" aria-modal="true" aria-labelledby="aiSettingsModalTitle">
          <div class="ai-settings-modal-header">
            <h3 id="aiSettingsModalTitle" class="ai-settings-modal-title">${ICONS.sliders}<span>AI მოდელი, დონე და მართვა</span></h3>
            <button type="button" class="ai-settings-modal-close" title="დახურვა">${ICONS.close}</button>
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
              <div class="ai-modal-section-title">3. API გასაღებები (API Keys)</div>
              <div class="ai-keys-grid">
                <label class="ai-settings-label">
                  <span>
                    Gemini API Key (Gemini 4 Argon)
                    <small class="ai-masked-gemini-hint"></small>
                    <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" class="ai-key-link">გასაღების აღება ↗</a>
                  </span>
                  <input type="text" name="gipc_ai_gemini_api_token" class="ai-settings-input ai-masked-key-input ai-input-gemini-key" placeholder="AIza... (ცარიელი = უცვლელი)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-form-type="other" />
                </label>
                <label class="ai-settings-label">
                  <span>
                    OpenAI API Key (ChatGPT Sol / Astra)
                    <small class="ai-masked-openai-hint"></small>
                    <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="ai-key-link">გასაღების აღება ↗</a>
                  </span>
                  <input type="text" name="gipc_ai_openai_api_token" class="ai-settings-input ai-masked-key-input ai-input-openai-key" placeholder="sk-... (ცარიელი = უცვლელი)" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" data-lpignore="true" data-1p-ignore="true" data-form-type="other" />
                </label>
              </div>
            </div>

            <div class="ai-modal-section">
              <div class="ai-modal-section-title">4. ძირითადი პრომპტი (System Prompt)</div>
              <button type="button" class="ai-open-prompt-board-btn">
                <span class="ai-open-prompt-board-left">
                  ${ICONS.inbox}
                  <span>ძირითადი პრომპტის დაფის გახსნა (ნახვა / შეცვლა / წაშლა)</span>
                </span>
                <span class="ai-prompt-status-badge">აქტიურია</span>
              </button>
            </div>
          </div>

          <div class="ai-settings-modal-footer">
            <button type="button" class="secondary-btn ai-settings-cancel">დახურვა</button>
            <button type="button" class="primary-btn ai-settings-save">შენახვა</button>
          </div>
        </div>
      `;

      document.body.appendChild(settingsModalOverlayEl);

      // Dedicated Board Modal for viewing, editing, or deleting the Main System Prompt
      promptBoardOverlayEl = document.createElement('div');
      promptBoardOverlayEl.id = 'aiPromptBoardOverlay';
      promptBoardOverlayEl.className = 'ai-prompt-board-overlay';
      promptBoardOverlayEl.hidden = true;
      promptBoardOverlayEl.innerHTML = `
        <div class="ai-prompt-board-dialog" role="dialog" aria-modal="true" aria-labelledby="aiPromptBoardTitle">
          <div class="ai-prompt-board-header">
            <div class="ai-prompt-board-title-group">
              <h3 id="aiPromptBoardTitle" class="ai-prompt-board-title">${ICONS.inbox}<span>ძირითადი პრომპტის დაფა (System Prompt)</span></h3>
              <span class="ai-prompt-char-count">0 სიმბოლო</span>
            </div>
            <button type="button" class="ai-prompt-board-close" title="დახურვა">${ICONS.close}</button>
          </div>

          <div class="ai-prompt-board-body">
            <div class="ai-prompt-board-hint">
              აქ მოცემულია ხელოვნური ინტელექტის ძირითადი პრომპტი. შეგიძლიათ თავისუფლად ჩაასწოროთ ტექსტი, მთლიანად წაშალოთ და ჩაწეროთ თქვენი პრომპტი, ან დააბრუნოთ საწყისი ვერსია.
            </div>
            <textarea class="ai-prompt-board-textarea" rows="18" spellcheck="false" placeholder="ჩაწერეთ ძირითადი პრომპტი აქ..."></textarea>
          </div>

          <div class="ai-prompt-board-footer">
            <div class="ai-prompt-board-left-actions">
              <button type="button" class="ai-prompt-clear-btn" title="პრომპტის სრულად წაშლა / გასუფთავება">
                ${ICONS.trash}
                <span>პრომპტის წაშლა</span>
              </button>
              <button type="button" class="ai-prompt-restore-btn" title="ქარხნული (საწყისი) პრომპტის დაბრუნება">
                <span>↺ საწყისი პრომპტის აღდგენა</span>
              </button>
            </div>
            <div class="ai-prompt-board-right-actions">
              <button type="button" class="secondary-btn ai-prompt-cancel-btn">დახურვა</button>
              <button type="button" class="primary-btn ai-prompt-save-btn">პრომპტის შენახვა</button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(promptBoardOverlayEl);

      headerConfigBtnEl = panelEl.querySelector('.ai-header-config-btn');
      computerConnectBtnEl = panelEl.querySelector('.ai-computer-connect-btn');
      messagesContainerEl = panelEl.querySelector('.ai-messages-container');
      attachmentsPreviewBarEl = panelEl.querySelector('.ai-attachments-preview-bar');
      attachFileInputEl = panelEl.querySelector('.ai-chat-file-input');
      folderInputEl = panelEl.querySelector('.ai-chat-folder-input');
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
      on(computerConnectBtnEl, 'click', (e) => {
        void connectLocalComputerFolder(e);
      });
      on(panelEl.querySelector('.ai-chat-attach-btn'), 'click', () => {
        attachFileInputEl?.click();
      });
      on(attachFileInputEl, 'change', () => {
        if (attachFileInputEl?.files?.length) {
          void addFilesToPendingAttachments(attachFileInputEl.files);
          attachFileInputEl.value = '';
        }
      });
      on(folderInputEl, 'change', () => {
        const files = Array.from(folderInputEl?.files || []);
        if (files.length) {
          const firstRel = files[0].webkitRelativePath || '';
          localComputerFolderName = firstRel.includes('/') ? firstRel.split('/')[0] : 'კომპიუტერი';
          localComputerFiles = files.slice(0, 400).map((f) => ({
            path: f.webkitRelativePath || f.name,
            name: f.name,
            size_bytes: f.size,
            mime_type: f.type || '',
            file: f,
          }));
          syncComputerBtnUI();
          showToast(
            `კომპიუტერის საქაღალდე "${localComputerFolderName}" დაკავშირებულია (${localComputerFiles.length} ფაილი)`
          );
          renderMessages();
          folderInputEl.value = '';
        }
      });

      // Clipboard screenshot paste (Ctrl+V)
      on(panelEl, 'paste', (e) => {
        const items = e.clipboardData?.items;
        if (!items) return;
        const pastedFiles = [];
        for (const item of Array.from(items)) {
          if (item.kind === 'file') {
            const f = item.getAsFile();
            if (f) {
              const ext = (f.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
              const namedFile =
                f.name && f.name !== 'image.png'
                  ? f
                  : new File([f], `screenshot-${Date.now()}.${ext}`, { type: f.type || 'image/png' });
              pastedFiles.push(namedFile);
            }
          }
        }
        if (pastedFiles.length > 0) {
          e.preventDefault();
          void addFilesToPendingAttachments(pastedFiles);
        }
      });

      // Drag and drop files/screenshots onto chat panel
      on(panelEl, 'dragover', (e) => {
        e.preventDefault();
        panelEl.classList.add('is-dragover');
      });
      on(panelEl, 'dragleave', (e) => {
        if (e.target === panelEl) {
          panelEl.classList.remove('is-dragover');
        }
      });
      on(panelEl, 'drop', (e) => {
        e.preventDefault();
        panelEl.classList.remove('is-dragover');
        if (e.dataTransfer?.files?.length) {
          void addFilesToPendingAttachments(e.dataTransfer.files);
        }
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
      on(settingsModalOverlayEl.querySelector('.ai-open-prompt-board-btn'), 'click', () => {
        openPromptBoardModal();
      });

      const boardTextarea = promptBoardOverlayEl.querySelector('.ai-prompt-board-textarea');
      on(boardTextarea, 'input', () => {
        updatePromptCharCount(boardTextarea.value);
      });
      on(promptBoardOverlayEl.querySelector('.ai-prompt-board-close'), 'click', () => {
        closePromptBoardModal();
      });
      on(promptBoardOverlayEl.querySelector('.ai-prompt-cancel-btn'), 'click', () => {
        closePromptBoardModal();
      });
      on(promptBoardOverlayEl, 'click', (e) => {
        if (e.target === promptBoardOverlayEl) {
          closePromptBoardModal();
        }
      });
      on(promptBoardOverlayEl.querySelector('.ai-prompt-clear-btn'), 'click', () => {
        if (!boardTextarea) return;
        boardTextarea.value = '';
        updatePromptCharCount('');
        boardTextarea.focus();
        showToast('პრომპტის ველი გასუფთავდა — შეგიძლიათ ჩაწეროთ ახალი ან დააჭიროთ შენახვას');
      });
      on(promptBoardOverlayEl.querySelector('.ai-prompt-restore-btn'), 'click', () => {
        if (!boardTextarea) return;
        boardTextarea.value = aiStatus.default_system_prompt || '';
        updatePromptCharCount(boardTextarea.value);
        boardTextarea.focus();
        showToast('საწყისი პრომპტი ჩაისვა დაფაზე');
      });
      on(promptBoardOverlayEl.querySelector('.ai-prompt-save-btn'), 'click', () => {
        void savePromptFromBoard();
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

      panelEl.querySelectorAll('.ai-quick-chip').forEach((chip) => {
        on(chip, 'click', () => {
          const mode = chip.getAttribute('data-mode') || 'site_analysis';
          const labelMap = {
            site_analysis: 'ჩაატარე საიტის მიმდინარე მდგომარეობის სრული ანალიზი და მოამზადე სამოქმედო გეგმა.',
            statements_analysis: 'შეისწავლე ყველა უპასუხო განცხადება და მათზე მიბმული დოკუმენტები, შეაფასე და მოამზადე სარეკომენდაციო პასუხები.',
            exam_analysis: 'გააანალიზე კანდიდატების სტატუსები და სერტიფიკატის კანდიდატების 30-დღიანი ვადები.',
          };
          void sendChatMessage(labelMap[mode] || chip.textContent.trim(), { mode });
        });
      });

      function syncAdminInputHeight() {
        if (!inputEl) return;
        inputEl.style.height = '40px';
        const nextH = Math.min(110, Math.max(40, inputEl.scrollHeight));
        inputEl.style.height = `${nextH}px`;
        inputEl.style.overflowY = inputEl.scrollHeight > 110 ? 'auto' : 'hidden';
      }

      on(inputEl, 'input', syncAdminInputHeight);

      const formEl = panelEl.querySelector('.ai-input-bar');
      on(formEl, 'submit', (e) => {
        e.preventDefault();
        const text = String(inputEl?.value || '').trim();
        if ((!text && !pendingAttachments.length) || isSending) return;
        inputEl.value = '';
        syncAdminInputHeight();
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
      syncPromptBadgeUI();
    }

    function getEffectiveSystemPrompt() {
      if (aiStatus.system_prompt !== null && aiStatus.system_prompt !== undefined) {
        return String(aiStatus.system_prompt);
      }
      return String(aiStatus.default_system_prompt || '');
    }

    function syncPromptBadgeUI() {
      if (!settingsModalOverlayEl) return;
      const badge = settingsModalOverlayEl.querySelector('.ai-prompt-status-badge');
      if (!badge) return;
      const trimmed = String(draftSystemPrompt || '').trim();
      if (!trimmed) {
        badge.textContent = 'წაშლილია (ცარიელი)';
        badge.className = 'ai-prompt-status-badge is-empty';
      } else if (trimmed !== String(aiStatus.default_system_prompt || '').trim()) {
        badge.textContent = `შეცვლილია (${trimmed.length} სიმბოლო)`;
        badge.className = 'ai-prompt-status-badge is-custom';
      } else {
        badge.textContent = `აქტიურია (${trimmed.length} სიმბოლო)`;
        badge.className = 'ai-prompt-status-badge';
      }
    }

    function updatePromptCharCount(text) {
      if (!promptBoardOverlayEl) return;
      const counter = promptBoardOverlayEl.querySelector('.ai-prompt-char-count');
      if (!counter) return;
      const len = String(text || '').trim().length;
      counter.textContent = len > 0 ? `${len} სიმბოლო` : 'ცარიელია (0 სიმბოლო)';
    }

    function openPromptBoardModal() {
      buildUI();
      if (!promptBoardOverlayEl) return;
      const boardTextarea = promptBoardOverlayEl.querySelector('.ai-prompt-board-textarea');
      if (boardTextarea) {
        boardTextarea.value = draftSystemPrompt;
        updatePromptCharCount(draftSystemPrompt);
      }
      promptBoardOverlayEl.hidden = false;
      setTimeout(() => {
        boardTextarea?.focus();
      }, 30);
    }

    function closePromptBoardModal() {
      if (promptBoardOverlayEl) {
        promptBoardOverlayEl.hidden = true;
      }
    }

    async function savePromptFromBoard() {
      if (!promptBoardOverlayEl) return;
      const boardTextarea = promptBoardOverlayEl.querySelector('.ai-prompt-board-textarea');
      const saveBtn = promptBoardOverlayEl.querySelector('.ai-prompt-save-btn');
      const newPrompt = String(boardTextarea?.value || '').trim();
      draftSystemPrompt = newPrompt;
      syncPromptBadgeUI();

      if (saveBtn) saveBtn.disabled = true;
      try {
        const resp = await fetch(`${API_BASE}/admin/ai/settings`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({
            system_prompt: newPrompt,
          }),
        });
        if (!resp.ok) {
          throw new Error('პრომპტის შენახვა ვერ მოხერხდა');
        }
        const data = await resp.json();
        aiStatus = { ...aiStatus, ...data };
        draftSystemPrompt = getEffectiveSystemPrompt();
        syncPromptBadgeUI();
        closePromptBoardModal();
        showToast(newPrompt ? 'ძირითადი პრომპტი შენახულია' : 'ძირითადი პრომპტი წაშლილია');
      } catch (err) {
        showToast(err?.message || 'პრომპტის შენახვა ვერ მოხერხდა', 'error');
      } finally {
        if (saveBtn) saveBtn.disabled = false;
      }
    }

    function openSettingsModal() {
      buildUI();
      isSettingsModalOpen = true;
      draftModel = aiStatus.model || 'gemini-4-argon';
      draftLevel = aiStatus.reasoning_level || 'high';
      draftSystemPrompt = getEffectiveSystemPrompt();
      syncModalSelectionUI();

      const geminiHint = settingsModalOverlayEl.querySelector('.ai-masked-gemini-hint');
      const openaiHint = settingsModalOverlayEl.querySelector('.ai-masked-openai-hint');
      const geminiInput = settingsModalOverlayEl.querySelector('.ai-input-gemini-key');
      const openaiInput = settingsModalOverlayEl.querySelector('.ai-input-openai-key');

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
      const saveBtn = settingsModalOverlayEl.querySelector('.ai-settings-save');

      const payload = {
        model: draftModel || 'gemini-4-argon',
        reasoning_level: draftLevel || 'high',
        system_prompt: draftSystemPrompt,
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
        draftSystemPrompt = getEffectiveSystemPrompt();
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

    function createDownloadCardElement(dlItem) {
      const card = document.createElement('div');
      card.className = 'ai-download-file-card';
      const hasFolder = Boolean(localComputerDirHandle?.getFileHandle);
      card.innerHTML = `
        <div class="ai-download-card-info">
          <span class="ai-download-card-icon">📥</span>
          <div>
            <div class="ai-download-card-title">${escapeHtml(dlItem.title || 'ფაილი მზად არის ჩამოსაწერად')}</div>
            <div class="ai-download-card-filename"><code>${escapeHtml(dlItem.filename || 'document')}</code></div>
          </div>
        </div>
        <div class="ai-download-card-actions">
          <button type="button" class="ai-download-btn">⬇️ კომპიუტერში ჩამოწერა</button>
          ${
            hasFolder
              ? `<button type="button" class="ai-save-folder-btn">💾 საქაღალდეში შენახვა</button>`
              : ''
          }
        </div>
      `;
      on(card.querySelector('.ai-download-btn'), 'click', () => {
        void triggerFileDownload(dlItem, { saveToConnectedFolder: false });
      });
      const folderBtn = card.querySelector('.ai-save-folder-btn');
      if (folderBtn) {
        on(folderBtn, 'click', () => {
          void triggerFileDownload(dlItem, { saveToConnectedFolder: true });
        });
      }
      return card;
    }

    function createProposalCardElement(proposal) {
      const card = document.createElement('div');
      card.className = `ai-letter-confirm-card ${proposal.sent ? 'is-sent' : ''}`;

      const modeLabel = TEMPLATE_MODE_LABELS[proposal.template_mode] || proposal.template_mode;
      const showDateTime = proposal.template_mode === 'exam' || proposal.template_mode === 'certificate';

      let selectedCustomFile = null;
      let removeAllAttachments = false;

      const computerOptionsHtml =
        localComputerFiles.length > 0
          ? `
          <select class="ai-letter-comp-file-select" ${proposal.sent ? 'disabled' : ''}>
            <option value="">📂 არჩევა დაკავშირებული საქაღალდიდან (${localComputerFiles.length})...</option>
            ${localComputerFiles
              .slice(0, 150)
              .map(
                (cf) =>
                  `<option value="${escapeHtml(cf.path)}" ${
                    proposal.computer_attachment_path === cf.path ||
                    proposal.computer_attachment_path === cf.name
                      ? 'selected'
                      : ''
                  }>${escapeHtml(cf.path)}</option>`
              )
              .join('')}
          </select>
        `
          : '';

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
          <div class="ai-letter-summary-row ai-letter-attachment-row">
            <strong>📎 მიბმული ფაილი:</strong>
            <div class="ai-letter-att-controls">
              <span class="ai-letter-att-status"></span>
              ${
                !proposal.sent
                  ? `
                <input type="file" class="ai-letter-custom-file-input" hidden />
                <button type="button" class="ai-letter-pick-file-btn">💻 კომპიუტერიდან მიბმა</button>
                ${computerOptionsHtml}
                <button type="button" class="ai-letter-clear-file-btn" title="მიბმული ფაილის მოხსნა">✕</button>
              `
                  : ''
              }
            </div>
          </div>
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

      const attStatusEl = card.querySelector('.ai-letter-att-status');
      const customFileInput = card.querySelector('.ai-letter-custom-file-input');
      const pickFileBtn = card.querySelector('.ai-letter-pick-file-btn');
      const compFileSelect = card.querySelector('.ai-letter-comp-file-select');
      const clearFileBtn = card.querySelector('.ai-letter-clear-file-btn');

      function updateAttachmentStatusText() {
        if (!attStatusEl) return;
        if (removeAllAttachments) {
          attStatusEl.textContent = 'ფაილის გარეშე';
          return;
        }
        if (selectedCustomFile) {
          attStatusEl.innerHTML = `💻 კომპიუტერიდან: <code>${escapeHtml(selectedCustomFile.name)}</code>`;
          return;
        }
        if (proposal.computer_attachment_path) {
          attStatusEl.innerHTML = `💻 კომპიუტერიდან: <code>${escapeHtml(proposal.computer_attachment_path)}</code>`;
          return;
        }
        if (proposal.stored_attachment?.source_type) {
          attStatusEl.innerHTML = `🗄️ საიტის ბაზიდან: <code>${escapeHtml(proposal.stored_attachment.source_type)} #${escapeHtml(String(proposal.stored_attachment.source_id || ''))}</code>`;
          return;
        }
        if (proposal.attachment_filename) {
          attStatusEl.innerHTML = `📄 შაბლონის ფაილი: <code>${escapeHtml(proposal.attachment_filename)}</code>`;
          return;
        }
        attStatusEl.textContent = 'დანართის გარეშე (შეგიძლიათ მიაბათ კომპიუტერიდან)';
      }

      if (proposal.computer_attachment_path) {
        void resolveComputerFileObj(proposal.computer_attachment_path).then((f) => {
          if (f) {
            selectedCustomFile = f;
            updateAttachmentStatusText();
          }
        });
      }
      updateAttachmentStatusText();

      if (pickFileBtn && customFileInput) {
        on(pickFileBtn, 'click', () => customFileInput.click());
        on(customFileInput, 'change', () => {
          if (customFileInput.files?.length) {
            selectedCustomFile = customFileInput.files[0];
            removeAllAttachments = false;
            updateAttachmentStatusText();
          }
        });
      }
      if (compFileSelect) {
        on(compFileSelect, 'change', async () => {
          const val = compFileSelect.value;
          if (!val) return;
          const f = await resolveComputerFileObj(val);
          if (f) {
            selectedCustomFile = f;
            proposal.computer_attachment_path = val;
            removeAllAttachments = false;
            updateAttachmentStatusText();
          } else {
            showToast('ფაილის წაკითხვა ვერ მოხერხდა', 'error');
          }
        });
      }
      if (clearFileBtn) {
        on(clearFileBtn, 'click', () => {
          selectedCustomFile = null;
          proposal.computer_attachment_path = null;
          proposal.stored_attachment = null;
          removeAllAttachments = true;
          if (compFileSelect) compFileSelect.value = '';
          updateAttachmentStatusText();
        });
      }

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

          let attachmentToSend = selectedCustomFile;
          if (!attachmentToSend && !removeAllAttachments && proposal.computer_attachment_path) {
            attachmentToSend = await resolveComputerFileObj(proposal.computer_attachment_path);
          }

          const attLabel = removeAllAttachments
            ? 'არ ებმება'
            : attachmentToSend
              ? `კომპიუტერიდან (${attachmentToSend.name})`
              : proposal.stored_attachment?.source_type
                ? `საიტის ბაზიდან (${proposal.stored_attachment.source_type})`
                : proposal.attachment_filename || 'შაბლონის მიხედვით';

          const confirmText = [
            `დაადასტურეთ წერილის გაგზავნა:`,
            `• მიმღები: ${proposal.user_name} (${proposal.to_email})`,
            `• ტიპი: ${modeLabel}`,
            `• დასაბუთება: ${proposal.reason || '—'}`,
            `• სათაური: ${finalSubject}`,
            `• დანართი ფაილი: ${attLabel}`,
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

            if (removeAllAttachments) {
              formData.append('use_template_attachment', 'false');
            } else if (attachmentToSend) {
              formData.append('use_template_attachment', 'false');
              formData.append('attachment', attachmentToSend, attachmentToSend.name);
            } else if (proposal.stored_attachment?.source_type) {
              const stType = proposal.stored_attachment.source_type;
              const stId = proposal.stored_attachment.source_id || 0;
              const fileResp = await fetch(
                `${API_BASE}/admin/ai/files/${encodeURIComponent(stType)}/${encodeURIComponent(stId)}`,
                { headers: { ...getAdminHeaders(), ...getActorHeaders() } }
              );
              if (fileResp.ok) {
                const blob = await fileResp.blob();
                const disp = fileResp.headers.get('Content-Disposition') || '';
                const fnMatch = disp.match(/filename="?([^";]+)"?/i);
                const fname = fnMatch ? fnMatch[1] : `${stType}-${stId}.pdf`;
                formData.append('use_template_attachment', 'false');
                formData.append('attachment', blob, fname);
              } else {
                formData.append('use_template_attachment', 'true');
              }
            } else {
              formData.append('use_template_attachment', 'true');
              if (proposal.template_updated_at) {
                formData.append('template_updated_at', proposal.template_updated_at);
              }
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
          <div class="ai-empty-chat-hint-icon">${ICONS.sparkle}</div>
          <span>აირჩიეთ სწრაფი ანალიზის ბრძანება ზედა პანელიდან, დაწერეთ შეტყობინება, ჩასვით სკრინი (<strong>Ctrl+V</strong>), მიაბით ფაილი ან დააკავშირეთ <strong>კომპიუტერი</strong>.</span>
        `;
        messagesContainerEl.appendChild(emptyHint);
        return;
      }

      messages.forEach((msg) => {
        const itemEl = document.createElement('div');
        itemEl.className = `ai-msg-item ${msg.role === 'user' ? 'is-user' : 'is-assistant'}`;

        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';

        if (Array.isArray(msg.user_attachments) && msg.user_attachments.length > 0) {
          const userAttRow = document.createElement('div');
          userAttRow.className = 'ai-msg-user-attachments';
          msg.user_attachments.forEach((ua) => {
            if (ua.preview_url) {
              const img = document.createElement('img');
              img.src = ua.preview_url;
              img.alt = ua.filename || 'screenshot';
              img.className = 'ai-msg-user-image';
              userAttRow.appendChild(img);
            } else {
              const badge = document.createElement('span');
              badge.className = 'ai-msg-user-file-badge';
              badge.textContent = ua.filename;
              userAttRow.appendChild(badge);
            }
          });
          bubble.appendChild(userAttRow);
        }

        const contentDiv = document.createElement('div');
        contentDiv.className = 'ai-msg-content';
        contentDiv.innerHTML = formatMarkdownSimple(msg.content);
        bubble.appendChild(contentDiv);

        itemEl.appendChild(bubble);

        if (Array.isArray(msg.download_files) && msg.download_files.length > 0) {
          msg.download_files.forEach((dlItem) => {
            itemEl.appendChild(createDownloadCardElement(dlItem));
          });
        }

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
            <span class="ai-typing-indicator">${ICONS.sparkle} <span>${escapeHtml(getActiveModelLabel())} (${escapeHtml(getActiveLevelShortLabel())}) ამუშავებს მოთხოვნას...</span></span>
          </div>
        `;
        messagesContainerEl.appendChild(loadingEl);
      }

      messagesContainerEl.scrollTop = messagesContainerEl.scrollHeight;
    }

    const DOC_CODE_TO_PREFIX = [
      { codes: ['gipc-sch-001', 'სერტიფიკაციის სქემა', 'წინაპირობ', 'კატეგორია', 'გარდამავალი', 'სტაჟ', 'დიპლომ', 'რესერტიფიცირებ'], prefixes: ['01_სერტიფიკაციის_სქემა'] },
      { codes: ['gipc-qm-001', 'ხარისხის მართვ', 'სახელმძღვანელო'], prefixes: ['02_ხარისხის_მართვის_სახელმძღვანელო'] },
      { codes: ['gipc-pol-001', 'მიუკერძოებლობ', 'ინტერესთა კონფლიქტ'], prefixes: ['03_მიუკერძოებლობის_პოლიტიკა', '13_ფორმა_მიუკერძოებლობის'] },
      { codes: ['gipc-pol-002', 'კონფიდენციალურ', 'პერსონალურ'], prefixes: ['04_კონფიდენციალურობის_პოლიტიკა', '14_ფორმა_კონფიდენციალურობის'] },
      { codes: ['gipc-pro-001', 'სერტიფიკაციის პროცედურ', 'განაცხად', 'დაშვებ', 'უარყოფ', 'ვერიფიკაცი', 'შეჩერებ', 'გაუქმებ', 'აღდგენ', '30 კალენდარულ', '30 დღ', '30-დღ'], prefixes: ['05_სერტიფიკაციის_პროცედურა', '12_ფორმა_განაცხადი'] },
      { codes: ['gipc-pro-002', 'გამოცდის ჩატარებ', 'გამოცდ', 'ტესტ', 'სესი', 'გადატან', 'დაგვიანებ', '350'], prefixes: ['06_გამოცდის_ჩატარების_პროცედურა', '10_საგამოცდო_ხელშეკრულება'] },
      { codes: ['gipc-pro-003', 'საჩივარ', 'საჩივრ', 'აპელაცი', 'გასაჩივრებ'], prefixes: ['07_საჩივრებისა_და_აპელაციების_პროცედურა'] },
      { codes: ['gipc-con-001', 'არქიტექტორის ხელშეკრულება', 'ხელშეკრულება', '3000', '3 000'], prefixes: ['08_სასერტიფიკაციო_ხელშეკრულება_არქიტექტორი'] },
      { codes: ['gipc-con-002', 'სპეციალისტის ხელშეკრულება', 'ხელშეკრულება'], prefixes: ['09a_სასერტიფიკაციო_ხელშეკრულება_სპეციალისტი'] },
      { codes: ['gipc-con-003', 'ექსპერტის ხელშეკრულება', 'ხელშეკრულება'], prefixes: ['09_სასერტიფიკაციო_ხელშეკრულება_ექსპერტი'] },
      { codes: ['gipc-con-004', 'საგამოცდო ხელშეკრულება'], prefixes: ['10_საგამოცდო_ხელშეკრულება'] },
      { codes: ['gipc-pro-004', 'შიდა აუდიტ', 'gipc-frm-020', 'ia-2026'], prefixes: ['11_შიდა_აუდიტის_პროცედურა', '18_შიდა_აუდიტის_ანგარიში'] },
      { codes: ['gipc-pro-005', 'დოკუმენტაციის კონტროლ', 'რეესტრ', 'gipc-rec-001', 'განადგურებ', 'განაწილებ', 'ცვლილებ'], prefixes: ['15_დოკუმენტაციის_კონტროლის_პროცედურა', '26_ხარისხის_დოკუმენტების_რეესტრი', '24_გარე_დოკუმენტების_რეესტრი'] },
      { codes: ['gipc-pro-006', 'სიმბოლო', 'ლოგო', 'აკრედიტაციის სიმბოლო'], prefixes: ['20_აკრედიტაციის_სიმბოლოს_გამოყენების_პროცედურა'] },
      { codes: ['gipc-frm-023', 'შაბლონ', 'წერილ', 'შეტყობინებ'], prefixes: ['27_შეტყობინებების_შაბლონები'] },
      { codes: ['gipc-web-001', 'ვებგვერდ', 'საიტ', 'საჯარო რეესტრ', 'ჩვენს შესახებ'], prefixes: ['28_ვებგვერდზე_განსათავსებელი_სავალდებულო_ინფორმაცია', 'ჩვენს შესახებ'] },
      { codes: ['gipc-jd-001', 'gipc-jd-002', 'gipc-jd-003', 'მენეჯერ', 'ზედამხედველ', 'თანამდებობრივ', 'qm-comp'], prefixes: ['16_თანამდებობრივი_ინსტრუქცია_ხარისხის_მენეჯერი', '17_თანამდებობრივი_ინსტრუქცია_საგამოცდო_მენეჯერი', '29_თანამდებობრივი_ინსტრუქცია_საგამოცდო_ზედამხედველი'] },
      { codes: ['მენეჯმენტის მიმოხილვ', 'gipc-frm-022', 'mr-2026', 'მაკორექტირებელ', 'gipc-frm-021', 'ca-2026'], prefixes: ['19_მენეჯმენტის_მიმოხილვის_ოქმი', '21_ფორმა_მაკორექტირებელი_ქმედება'] },
      { codes: ['კითხვარ', 'მეპინგ', '17024', 'ისო'], prefixes: ['00_კითხვარის_მეპინგი'] },
    ];

    function normalizeDocKey(filename) {
      return String(filename || '')
        .toLowerCase()
        .replace(/\.[^.]+$/, '')
        .replace(/_\u10d0\u10e0\u10d2\u10dd\u10dc$/i, '');
    }

    async function collectMatchingComputerAttachments(userText, mode = 'chat') {
      if (localComputerDirHandle && !savedHandleNeedsPermission) {
        try {
          localComputerFiles = await scanDirectoryHandle(localComputerDirHandle);
          syncComputerBtnUI();
        } catch {}
      }
      if (!localComputerFiles.length) return [];

      // Group files by canonical document base key so if both .docx and .md exist,
      // we pick the most recently modified version (or .md if timestamps are equal/older).
      const groups = new Map();
      for (const entry of localComputerFiles) {
        const lowerName = entry.name.toLowerCase();
        if (!lowerName.endsWith('.md') && !lowerName.endsWith('.docx') && !lowerName.endsWith('.pdf') && !lowerName.endsWith('.txt')) {
          continue;
        }
        const key = normalizeDocKey(entry.name);
        if (!groups.has(key)) {
          groups.set(key, { key, md: null, docx: null, other: null });
        }
        const g = groups.get(key);
        if (lowerName.endsWith('.md')) g.md = entry;
        else if (lowerName.endsWith('.docx')) g.docx = entry;
        else g.other = entry;
      }

      function pickFreshestEntry(g) {
        if (g.docx && g.md) {
          // If the .docx file was edited more recently than the .md file, read the live .docx!
          if ((g.docx.last_modified || 0) > (g.md.last_modified || 0) + 2000) {
            return g.docx;
          }
          return g.md;
        }
        return g.md || g.docx || g.other;
      }

      const lower = String(userText || '').toLowerCase();
      const scored = [];

      for (const g of groups.values()) {
        const entry = pickFreshestEntry(g);
        if (!entry) continue;
        let score = 0;
        const keyLower = g.key;
        const nameLower = entry.name.toLowerCase();

        // Direct filename or stem match
        if (lower && (lower.includes(nameLower) || (keyLower.length >= 4 && lower.includes(keyLower)))) {
          score += 100;
        }

        // Topic / GIPC document code match
        for (const rule of DOC_CODE_TO_PREFIX) {
          if (rule.prefixes.some((pref) => keyLower.startsWith(pref.toLowerCase()))) {
            if (rule.codes.some((kw) => lower.includes(kw))) {
              score += 50;
            }
          }
        }

        // Mode-based core operational documents
        if (mode === 'site_analysis' || mode === 'statements_analysis' || mode === 'exam_analysis') {
          if (
            keyLower.startsWith('01_სერტიფიკაციის_სქემა') ||
            keyLower.startsWith('05_სერტიფიკაციის_პროცედურა') ||
            keyLower.startsWith('27_შეტყობინებების_შაბლონები') ||
            keyLower.startsWith('28_ვებგვერდზე_განსათავსებელი')
          ) {
            score += 35;
          }
        }

        if (score > 0) {
          scored.push({ entry, score });
        }
      }

      scored.sort((a, b) => b.score - a.score);

      const matched = [];
      for (const item of scored.slice(0, 5)) {
        const fileObj = await resolveComputerFileObj(item.entry.path);
        if (fileObj && fileObj.size <= 12 * 1024 * 1024) {
          try {
            const dataUrl = await readFileAsDataUrl(fileObj);
            const commaIdx = dataUrl.indexOf(',');
            matched.push({
              filename: fileObj.name,
              mime_type: fileObj.type || 'application/octet-stream',
              data_base64: commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl,
            });
          } catch {}
        }
      }
      return matched;
    }

    async function sendChatMessage(
      text,
      { mode = 'chat', statementId = null, userId = null } = {}
    ) {
      if (isSending) return;
      buildUI();
      if (!isOpen) togglePanel(true);

      const currentAttachments = pendingAttachments.slice();
      pendingAttachments = [];
      renderPendingAttachments();

      const displayText =
        text ||
        (currentAttachments.length
          ? `📎 მიბმულია: ${currentAttachments.map((a) => a.filename).join(', ')}`
          : '');

      const userMessage = {
        role: 'user',
        content: displayText,
        user_attachments: currentAttachments.map((a) => ({
          filename: a.filename,
          mime_type: a.mime_type,
          preview_url: a.preview_url,
        })),
        timestamp: new Date().toISOString(),
      };
      messages.push(userMessage);
      saveHistory();
      isSending = true;
      if (sendBtnEl) sendBtnEl.disabled = true;
      renderMessages();

      try {
        const autoMatchedComputerAttachments = await collectMatchingComputerAttachments(text, mode);
        const combinedAttachments = [
          ...currentAttachments.map((a) => ({
            filename: a.filename,
            mime_type: a.mime_type,
            data_base64: a.data_base64,
          })),
          ...autoMatchedComputerAttachments,
        ].slice(0, 8);

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
            attachments: combinedAttachments,
            computer_files: localComputerFiles.slice(0, 400).map((cf) => ({
              path: cf.path,
              name: cf.name,
              size_bytes: cf.size_bytes,
              mime_type: cf.mime_type,
            })),
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
        const dlFiles = Array.isArray(data.download_files) ? data.download_files : [];
        messages.push({
          role: 'assistant',
          content: data.reply || 'ანალიზი დასრულებულია.',
          proposed_letters: Array.isArray(data.proposed_letters) ? data.proposed_letters : [],
          download_files: dlFiles,
          inspected_attachments: Array.isArray(data.inspected_attachments)
            ? data.inspected_attachments
            : [],
          timestamp: new Date().toISOString(),
        });
        saveHistory();

        for (const dl of dlFiles) {
          if (dl.auto_download !== false) {
            void triggerFileDownload(dl, { saveToConnectedFolder: false });
          }
        }
      } catch (err) {
        messages.push({
          role: 'assistant',
          content: `⚠️ **შეცდომა:** ${err?.message || 'მოთხოვნა ვერ შესრულდა.'}`,
          proposed_letters: [],
          download_files: [],
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
      void restoreSavedComputerFolder();

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

  function createPublicAiAdminModule(context) {
    const {
      API_BASE,
      on,
      showToast,
      escapeHtml,
      getAdminHeaders,
      getActorHeaders,
      onSettingsSaved,
    } = context;

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

    let mountEl = null;
    let isLoaded = false;
    let isSaving = false;
    let isUploadingKb = false;

    let pubState = {
      public_enabled: true,
      public_configured: false,
      public_use_shared_key: true,
      masked_gemini_key: null,
      masked_openai_key: null,
      masked_public_gemini_key: null,
      masked_public_openai_key: null,
      public_model: 'gemini-4-argon',
      public_model_label: 'Gemini 4 Argon',
      public_reasoning_level: 'high',
      public_reasoning_level_short: 'High',
      public_system_prompt: '',
      public_system_prompt_customized: false,
      default_public_system_prompt: '',
    };

    let kbState = {
      total_files: 0,
      total_size_bytes: 0,
      total_chars: 0,
      items: [],
    };

    let draftEnabled = true;
    let draftUseSharedKey = true;
    let draftModel = 'gemini-4-argon';
    let draftLevel = 'high';
    let draftPrompt = '';
    let kbSearchQuery = '';
    let kbFolderFilter = 'all';

    function formatBytes(bytes) {
      const b = Number(bytes || 0);
      if (b < 1024) return `${b} B`;
      if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
      return `${(b / (1024 * 1024)).toFixed(2)} MB`;
    }

    function getEffectivePublicPrompt(stateObj) {
      if (stateObj.public_system_prompt !== null && stateObj.public_system_prompt !== undefined && String(stateObj.public_system_prompt).trim() !== '') {
        return String(stateObj.public_system_prompt);
      }
      return String(stateObj.default_public_system_prompt || '');
    }

    async function loadData() {
      try {
        const [settingsResp, kbResp] = await Promise.all([
          fetch(`${API_BASE}/admin/ai/public-settings`, {
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          }),
          fetch(`${API_BASE}/admin/ai/knowledge-base`, {
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          }),
        ]);
        if (settingsResp.ok) {
          const sData = await settingsResp.json();
          pubState = { ...pubState, ...sData };
          draftEnabled = Boolean(pubState.public_enabled);
          draftUseSharedKey = Boolean(pubState.public_use_shared_key);
          draftModel = pubState.public_model || 'gemini-4-argon';
          draftLevel = pubState.public_reasoning_level || 'high';
          draftPrompt = getEffectivePublicPrompt(pubState);
        }
        if (kbResp.ok) {
          const kData = await kbResp.json();
          kbState = {
            total_files: Number(kData.total_files || 0),
            total_size_bytes: Number(kData.total_size_bytes || 0),
            total_chars: Number(kData.total_chars || 0),
            items: Array.isArray(kData.items) ? kData.items : [],
          };
        }
        isLoaded = true;
        renderMount();
      } catch (err) {
        showToast('საჯარო AI-ს პარამეტრების ჩატვირთვა ვერ მოხერხდა', 'error');
      }
    }

    function buildMountSkeleton() {
      mountEl = document.getElementById('publicAiAdminMount');
      if (!mountEl || mountEl.dataset.initialized === 'true') return;
      mountEl.dataset.initialized = 'true';

      mountEl.innerHTML = `
        <div class="pub-ai-admin-grid">
          <!-- Card 1: Public AI Settings, Keys & System Prompt -->
          <div class="pub-ai-admin-card">
            <div class="pub-ai-card-header">
              <div class="pub-ai-card-title-wrap">
                <div class="pub-ai-card-badge-row">
                  <span class="pub-ai-status-pill" id="pubAiStatusPill">მოწმდება...</span>
                  <span class="pub-ai-model-summary" id="pubAiModelSummary">Gemini 4 Argon • High</span>
                </div>
                <h3 class="pub-ai-card-title">საჯარო AI ასისტენტის მართვა (საჯარო გვერდების კონსულტანტი)</h3>
                <p class="pub-ai-card-subtitle">მართეთ საჯარო გვერდებზე განთავსებული AI კონსულტანტის ჩართულობა, მოდელი, API გასაღები (Key) და სტანდარტული პრომპტი.</p>
              </div>
              <div class="pub-ai-card-top-actions">
                <label class="pub-ai-enable-toggle" title="საჯარო გვერდებზე AI ასისტენტის ჩართვა / გამორთვა">
                  <input type="checkbox" id="pubAiEnabledCheckbox" checked />
                  <span class="pub-ai-enable-label">ჩართულია საჯარო გვერდებზე</span>
                </label>
                <button type="button" class="primary-btn" id="pubAiSaveTopBtn">პარამეტრების შენახვა</button>
              </div>
            </div>

            <div class="pub-ai-card-body">
              <div class="pub-ai-two-col">
                <div class="pub-ai-field-block">
                  <div class="pub-ai-block-title">1. ხელოვნური ინტელექტის მოდელი (Model)</div>
                  <div class="ai-model-cards-grid" id="pubAiModelGrid">
                    ${MODEL_OPTIONS.map(
                      (m) => `
                      <button type="button" class="ai-model-card" data-pub-model="${m.id}">
                        <span class="ai-model-card-name">${escapeHtml(m.label)}</span>
                        <span class="ai-model-card-sub">${escapeHtml(m.sub)}</span>
                      </button>
                    `
                    ).join('')}
                  </div>
                </div>

                <div class="pub-ai-field-block">
                  <div class="pub-ai-block-title">2. აზროვნების / ინტელექტის დონე (Level)</div>
                  <div class="ai-level-pills-grid" id="pubAiLevelGrid">
                    ${LEVEL_OPTIONS.map(
                      (l) => `
                      <button type="button" class="ai-level-pill" data-pub-level="${l.id}">
                        <span class="ai-level-pill-name">${escapeHtml(l.label)}</span>
                        <span class="ai-level-pill-desc">${escapeHtml(l.desc)}</span>
                      </button>
                    `
                    ).join('')}
                  </div>
                </div>
              </div>

              <div class="pub-ai-field-block pub-ai-keys-block">
                <div class="pub-ai-keys-head">
                  <div class="pub-ai-block-title">3. API გასაღების (Key) კონფიგურაცია</div>
                  <label class="pub-ai-shared-key-toggle">
                    <input type="checkbox" id="pubAiUseSharedKeyCheckbox" checked />
                    <span>გამოიყენოს ადმინის AI-ს საერთო API გასაღები (ორივე AI ერთ გასაღებზე)</span>
                  </label>
                </div>
                <div class="pub-ai-keys-grid">
                  <label class="ai-settings-label">
                    <span>
                      Gemini API Key (Gemini 4 Argon)
                      <small class="ai-masked-gemini-hint" id="pubAiGeminiKeyHint"></small>
                      <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener" class="ai-key-link">გასაღების აღება ↗</a>
                    </span>
                    <input type="text" id="pubAiGeminiKeyInput" name="gipc_pub_ai_gemini_key" class="ai-settings-input ai-masked-key-input" placeholder="AIza... (დატოვეთ ცარიელი თუ შეცვლა არ გსურთ)" autocomplete="off" spellcheck="false" data-lpignore="true" />
                  </label>
                  <label class="ai-settings-label">
                    <span>
                      OpenAI API Key (ChatGPT Sol / Astra)
                      <small class="ai-masked-openai-hint" id="pubAiOpenaiKeyHint"></small>
                      <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener" class="ai-key-link">გასაღების აღება ↗</a>
                    </span>
                    <input type="text" id="pubAiOpenaiKeyInput" name="gipc_pub_ai_openai_key" class="ai-settings-input ai-masked-key-input" placeholder="sk-... (დატოვეთ ცარიელი თუ შეცვლა არ გსურთ)" autocomplete="off" spellcheck="false" data-lpignore="true" />
                  </label>
                </div>
              </div>

              <div class="pub-ai-field-block pub-ai-prompt-block">
                <div class="pub-ai-prompt-head">
                  <div class="pub-ai-prompt-title-group">
                    <div class="pub-ai-block-title">4. საჯარო AI-ს სტანდარტული პრომპტი (System Prompt)</div>
                    <span class="ai-prompt-status-badge" id="pubAiPromptBadge">სტანდარტული</span>
                    <span class="ai-prompt-char-count" id="pubAiPromptCharCount">0 სიმბოლო</span>
                  </div>
                  <div class="pub-ai-prompt-actions">
                    <button type="button" class="ai-prompt-restore-btn" id="pubAiRestorePromptBtn" title="საწყისი სტანდარტული პრომპტის დაბრუნება">↺ სტანდარტული პრომპტის აღდგენა</button>
                    <button type="button" class="ai-prompt-clear-btn" id="pubAiClearPromptBtn" title="პრომპტის ველის გასუფთავება">გასუფთავება</button>
                  </div>
                </div>
                <div class="ai-prompt-board-hint">
                  ეს პრომპტი განსაზღვრავს საჯარო AI-ს ქცევას, ტონს და მკაცრ შეზღუდვას, რომ უპასუხოს მხოლოდ ქვემოთ ატვირთული დოკუმენტური ბაზის საფუძველზე. შეგიძლიათ ნებისმიერ დროს შეცვალოთ ან აღადგინოთ სტანდარტული ვერსია.
                </div>
                <textarea id="pubAiPromptTextarea" class="ai-prompt-board-textarea pub-ai-prompt-textarea" rows="13" spellcheck="false" placeholder="შეიყვანეთ საჯარო AI-ს სტანდარტული პრომპტი..."></textarea>
              </div>
            </div>

            <div class="pub-ai-card-footer">
              <span class="pub-ai-footer-note">🔒 საჯარო AI სრულად იზოლირებულია: არ აქვს წვდომა ინტერნეტთან, ადმინის კომპიუტერთან და კანდიდატების პირად მონაცემებთან.</span>
              <button type="button" class="primary-btn" id="pubAiSaveBottomBtn">პარამეტრებისა და პრომპტის შენახვა</button>
            </div>
          </div>

          <!-- Card 2: Shared Knowledge Base Documents (\`დოკუმენტები\`) -->
          <div class="pub-ai-admin-card">
            <div class="pub-ai-card-header">
              <div class="pub-ai-card-title-wrap">
                <div class="pub-ai-card-badge-row">
                  <span class="pub-ai-kb-count-badge" id="pubAiKbCountBadge">0 დოკუმენტი</span>
                  <span class="pub-ai-kb-shared-badge">🔗 საერთო ბაზა: ადმინის AI + საჯარო AI</span>
                </div>
                <h3 class="pub-ai-card-title">დოკუმენტების ცოდნის ბაზა („დოკუმენტები“ — ორივე AI-ს საერთო ბაზა)</h3>
                <p class="pub-ai-card-subtitle">აქ ატვირთული დოკუმენტები ავტომატურად ედება საფუძვლად როგორც <strong>საჯარო AI</strong>-ს, ისე <strong>ადმინის AI</strong>-ს. შეგიძლიათ ატვირთოთ ცალკეული ფაილები ან მთლიანი საქაღალდე.</p>
              </div>
              <div class="pub-ai-kb-upload-actions">
                <input type="file" id="pubAiKbFilesInput" multiple accept=".md,.txt,.docx,.pdf,.csv,.json,.html" hidden />
                <input type="file" id="pubAiKbFolderInput" webkitdirectory directory multiple hidden />
                <button type="button" class="primary-btn" id="pubAiUploadFilesBtn">📄 ფაილების ატვირთვა</button>
                <button type="button" class="secondary-btn" id="pubAiUploadFolderBtn">📁 საქაღალდის ატვირთვა</button>
                <button type="button" class="secondary-btn" id="pubAiRestoreKbBtn" title="საწყისი 45 დოკუმენტის (data + doc 2) აღდგენა">↺ საწყისი ბაზის აღდგენა (45 ფაილი)</button>
              </div>
            </div>

            <div class="pub-ai-card-body">
              <div class="pub-ai-kb-toolbar">
                <div class="pub-ai-kb-folder-tabs" id="pubAiKbFolderTabs"></div>
                <input type="search" id="pubAiKbSearchInput" class="pub-ai-kb-search" placeholder="ძებნა დოკუმენტის სახელით ან კოდით..." autocomplete="off" />
              </div>
              <div class="pub-ai-kb-list" id="pubAiKbList"></div>
            </div>
          </div>
        </div>
      `;

      const enabledCb = document.getElementById('pubAiEnabledCheckbox');
      const sharedKeyCb = document.getElementById('pubAiUseSharedKeyCheckbox');
      const promptTa = document.getElementById('pubAiPromptTextarea');
      const restorePromptBtn = document.getElementById('pubAiRestorePromptBtn');
      const clearPromptBtn = document.getElementById('pubAiClearPromptBtn');
      const saveTopBtn = document.getElementById('pubAiSaveTopBtn');
      const saveBottomBtn = document.getElementById('pubAiSaveBottomBtn');

      on(enabledCb, 'change', () => {
        draftEnabled = Boolean(enabledCb.checked);
        syncControlsUI();
      });

      on(sharedKeyCb, 'change', () => {
        draftUseSharedKey = Boolean(sharedKeyCb.checked);
        syncControlsUI();
      });

      mountEl.querySelectorAll('[data-pub-model]').forEach((btn) => {
        on(btn, 'click', () => {
          draftModel = btn.getAttribute('data-pub-model') || 'gemini-4-argon';
          syncControlsUI();
        });
      });

      mountEl.querySelectorAll('[data-pub-level]').forEach((btn) => {
        on(btn, 'click', () => {
          draftLevel = btn.getAttribute('data-pub-level') || 'high';
          syncControlsUI();
        });
      });

      on(promptTa, 'input', () => {
        draftPrompt = String(promptTa.value || '');
        syncPromptMetaUI();
      });

      on(restorePromptBtn, 'click', () => {
        draftPrompt = String(pubState.default_public_system_prompt || '');
        if (promptTa) promptTa.value = draftPrompt;
        syncPromptMetaUI();
        showToast('ჩაისვა საჯარო AI-ს სტანდარტული პრომპტი — დააჭირეთ შენახვას');
      });

      on(clearPromptBtn, 'click', () => {
        draftPrompt = '';
        if (promptTa) {
          promptTa.value = '';
          promptTa.focus();
        }
        syncPromptMetaUI();
      });

      on(saveTopBtn, 'click', () => void savePublicSettings());
      on(saveBottomBtn, 'click', () => void savePublicSettings());

      // Knowledge base actions
      const filesInput = document.getElementById('pubAiKbFilesInput');
      const folderInput = document.getElementById('pubAiKbFolderInput');
      const uploadFilesBtn = document.getElementById('pubAiUploadFilesBtn');
      const uploadFolderBtn = document.getElementById('pubAiUploadFolderBtn');
      const restoreKbBtn = document.getElementById('pubAiRestoreKbBtn');
      const kbSearchInput = document.getElementById('pubAiKbSearchInput');

      on(uploadFilesBtn, 'click', () => filesInput?.click());
      on(uploadFolderBtn, 'click', () => folderInput?.click());

      on(filesInput, 'change', () => {
        if (filesInput?.files?.length) {
          void uploadKnowledgeBaseFiles(filesInput.files, 'ატვირთული');
          filesInput.value = '';
        }
      });

      on(folderInput, 'change', () => {
        if (folderInput?.files?.length) {
          const firstRel = folderInput.files[0].webkitRelativePath || '';
          const folderName = firstRel.includes('/') ? firstRel.split('/')[0] : 'დოკუმენტები';
          void uploadKnowledgeBaseFiles(folderInput.files, folderName);
          folderInput.value = '';
        }
      });

      on(restoreKbBtn, 'click', () => {
        if (!global.confirm('აღდგეს საწყისი 45 დოკუმენტი (data + doc 2) ცოდნის ბაზაში?')) return;
        void restoreKnowledgeBaseDefaults();
      });

      on(kbSearchInput, 'input', () => {
        kbSearchQuery = String(kbSearchInput.value || '').trim().toLowerCase();
        renderKbList();
      });
    }

    function syncPromptMetaUI() {
      const badge = document.getElementById('pubAiPromptBadge');
      const countEl = document.getElementById('pubAiPromptCharCount');
      const trimmed = String(draftPrompt || '').trim();
      const defTrimmed = String(pubState.default_public_system_prompt || '').trim();

      if (countEl) {
        countEl.textContent = `${trimmed.length} სიმბოლო`;
      }
      if (badge) {
        if (!trimmed) {
          badge.textContent = 'ცარიელია (გამოიყენება სტანდარტული)';
          badge.className = 'ai-prompt-status-badge is-empty';
        } else if (trimmed !== defTrimmed) {
          badge.textContent = 'შეცვლილია';
          badge.className = 'ai-prompt-status-badge is-custom';
        } else {
          badge.textContent = 'სტანდარტული პრომპტი აქტიურია';
          badge.className = 'ai-prompt-status-badge';
        }
      }
    }

    function syncControlsUI() {
      if (!mountEl) return;
      const statusPill = document.getElementById('pubAiStatusPill');
      const modelSummary = document.getElementById('pubAiModelSummary');
      const enabledCb = document.getElementById('pubAiEnabledCheckbox');
      const sharedKeyCb = document.getElementById('pubAiUseSharedKeyCheckbox');
      const geminiHint = document.getElementById('pubAiGeminiKeyHint');
      const openaiHint = document.getElementById('pubAiOpenaiKeyHint');

      if (enabledCb) enabledCb.checked = draftEnabled;
      if (sharedKeyCb) sharedKeyCb.checked = draftUseSharedKey;

      const mObj = MODEL_OPTIONS.find((m) => m.id === draftModel) || MODEL_OPTIONS[0];
      const lObj = LEVEL_OPTIONS.find((l) => l.id === draftLevel) || LEVEL_OPTIONS[2];

      if (modelSummary) {
        modelSummary.textContent = `${mObj.label} • ${lObj.label}`;
      }

      if (statusPill) {
        if (!draftEnabled) {
          statusPill.textContent = 'გამორთულია საჯარო გვერდებზე';
          statusPill.className = 'pub-ai-status-pill is-disabled';
        } else if (pubState.public_configured) {
          statusPill.textContent = '● აქტიურია საჯარო გვერდებზე';
          statusPill.className = 'pub-ai-status-pill is-ready';
        } else {
          statusPill.textContent = '⚠️ საჭიროა API Key-ს შეყვანა';
          statusPill.className = 'pub-ai-status-pill is-unconfigured';
        }
      }

      mountEl.querySelectorAll('[data-pub-model]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.getAttribute('data-pub-model') === draftModel);
      });

      mountEl.querySelectorAll('[data-pub-level]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.getAttribute('data-pub-level') === draftLevel);
      });

      const effGemMask = draftUseSharedKey
        ? pubState.masked_gemini_key || pubState.masked_public_gemini_key
        : pubState.masked_public_gemini_key;
      const effOaMask = draftUseSharedKey
        ? pubState.masked_openai_key || pubState.masked_public_openai_key
        : pubState.masked_public_openai_key;

      if (geminiHint) {
        geminiHint.textContent = effGemMask
          ? `(შენახულია: ${effGemMask})`
          : '(არ არის შენახული)';
      }
      if (openaiHint) {
        openaiHint.textContent = effOaMask
          ? `(შენახულია: ${effOaMask})`
          : '(არ არის შენახული)';
      }

      syncPromptMetaUI();
    }

    function renderKbList() {
      const countBadge = document.getElementById('pubAiKbCountBadge');
      const tabsEl = document.getElementById('pubAiKbFolderTabs');
      const listEl = document.getElementById('pubAiKbList');
      if (!listEl) return;

      if (countBadge) {
        countBadge.textContent = `${kbState.total_files} დოკუმენტი • ${formatBytes(kbState.total_size_bytes)}`;
      }

      const folders = Array.from(new Set(kbState.items.map((it) => it.folder || 'დოკუმენტები')));
      if (tabsEl) {
        const allButtons = [
          `<button type="button" class="pub-ai-folder-tab ${kbFolderFilter === 'all' ? 'is-active' : ''}" data-folder="all">ყველა (${kbState.items.length})</button>`,
          ...folders.map((f) => {
            const c = kbState.items.filter((it) => (it.folder || 'დოკუმენტები') === f).length;
            return `<button type="button" class="pub-ai-folder-tab ${kbFolderFilter === f ? 'is-active' : ''}" data-folder="${escapeHtml(f)}">📁 ${escapeHtml(f)} (${c})</button>`;
          }),
        ];
        tabsEl.innerHTML = allButtons.join('');
        tabsEl.querySelectorAll('[data-folder]').forEach((btn) => {
          on(btn, 'click', () => {
            kbFolderFilter = btn.getAttribute('data-folder') || 'all';
            renderKbList();
          });
        });
      }

      const filtered = kbState.items.filter((it) => {
        if (kbFolderFilter !== 'all' && (it.folder || 'დოკუმენტები') !== kbFolderFilter) {
          return false;
        }
        if (!kbSearchQuery) return true;
        const hay = `${it.filename || ''} ${it.folder || ''} ${it.rel_path || ''}`.toLowerCase();
        return hay.includes(kbSearchQuery);
      });

      if (!filtered.length) {
        listEl.innerHTML = `<div class="pub-ai-kb-empty">დოკუმენტები ვერ მოიძებნა.</div>`;
        return;
      }

      listEl.innerHTML = filtered
        .map(
          (it) => `
          <div class="pub-ai-kb-item">
            <div class="pub-ai-kb-item-main">
              <span class="pub-ai-kb-folder-tag">${escapeHtml(it.folder || 'დოკუმენტები')}</span>
              <span class="pub-ai-kb-filename" title="${escapeHtml(it.rel_path || it.filename)}">${escapeHtml(it.filename)}</span>
            </div>
            <div class="pub-ai-kb-item-meta">
              <span>${formatBytes(it.size_bytes)}</span>
              <span>•</span>
              <span>${Number(it.char_count || 0).toLocaleString()} სიმბოლო</span>
              <button type="button" class="pub-ai-kb-delete-btn" data-del-doc="${escapeHtml(it.id)}" title="დოკუმენტის წაშლა ბაზიდან">✕</button>
            </div>
          </div>
        `
        )
        .join('');

      listEl.querySelectorAll('[data-del-doc]').forEach((btn) => {
        on(btn, 'click', () => {
          const docId = btn.getAttribute('data-del-doc');
          if (docId) void deleteKnowledgeBaseFile(docId);
        });
      });
    }

    function renderMount() {
      buildMountSkeleton();
      if (!mountEl) return;
      const promptTa = document.getElementById('pubAiPromptTextarea');
      if (promptTa && document.activeElement !== promptTa) {
        promptTa.value = draftPrompt;
      }
      syncControlsUI();
      renderKbList();
    }

    async function savePublicSettings() {
      if (isSaving) return;
      isSaving = true;
      const saveTopBtn = document.getElementById('pubAiSaveTopBtn');
      const saveBottomBtn = document.getElementById('pubAiSaveBottomBtn');
      const gemInput = document.getElementById('pubAiGeminiKeyInput');
      const oaInput = document.getElementById('pubAiOpenaiKeyInput');
      const promptTa = document.getElementById('pubAiPromptTextarea');

      if (saveTopBtn) saveTopBtn.disabled = true;
      if (saveBottomBtn) saveBottomBtn.disabled = true;

      const currentPrompt = promptTa ? String(promptTa.value || '').trim() : draftPrompt.trim();
      const defPrompt = String(pubState.default_public_system_prompt || '').trim();

      const payload = {
        public_enabled: draftEnabled,
        public_use_shared_key: draftUseSharedKey,
        public_model: draftModel,
        public_reasoning_level: draftLevel,
        public_system_prompt: currentPrompt === defPrompt ? '' : currentPrompt,
      };

      const typedGem = String(gemInput?.value || '').trim();
      const typedOa = String(oaInput?.value || '').trim();
      if (typedGem) {
        payload.public_gemini_api_key = typedGem;
        if (draftUseSharedKey) {
          payload.gemini_api_key = typedGem;
        }
      }
      if (typedOa) {
        payload.public_openai_api_key = typedOa;
        if (draftUseSharedKey) {
          payload.openai_api_key = typedOa;
        }
      }

      try {
        const resp = await fetch(`${API_BASE}/admin/ai/public-settings`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          throw new Error('საჯარო AI-ს პარამეტრების შენახვა ვერ მოხერხდა');
        }
        const data = await resp.json();
        pubState = { ...pubState, ...data };
        draftEnabled = Boolean(pubState.public_enabled);
        draftUseSharedKey = Boolean(pubState.public_use_shared_key);
        draftModel = pubState.public_model || 'gemini-4-argon';
        draftLevel = pubState.public_reasoning_level || 'high';
        draftPrompt = getEffectivePublicPrompt(pubState);
        if (gemInput) gemInput.value = '';
        if (oaInput) oaInput.value = '';
        renderMount();
        onSettingsSaved?.();
        showToast('საჯარო AI-ს პარამეტრები წარმატებით შეინახა');
      } catch (err) {
        showToast(err?.message || 'შენახვა ვერ მოხერხდა', 'error');
      } finally {
        isSaving = false;
        if (saveTopBtn) saveTopBtn.disabled = false;
        if (saveBottomBtn) saveBottomBtn.disabled = false;
      }
    }

    async function uploadKnowledgeBaseFiles(fileList, folderName = 'ატვირთული') {
      if (isUploadingKb || !fileList?.length) return;
      const allowedExts = ['.md', '.txt', '.docx', '.pdf', '.csv', '.json', '.html', '.htm'];
      const validFiles = Array.from(fileList).filter((f) => {
        const name = String(f.name || '').toLowerCase();
        if (name.startsWith('.') || name.startsWith('~$')) return false;
        return allowedExts.some((ext) => name.endsWith(ext));
      });

      if (!validFiles.length) {
        showToast('ასატვირთად დაშვებულია .md, .txt, .docx, .pdf ფაილები', 'error');
        return;
      }

      isUploadingKb = true;
      const uploadFilesBtn = document.getElementById('pubAiUploadFilesBtn');
      const uploadFolderBtn = document.getElementById('pubAiUploadFolderBtn');
      if (uploadFilesBtn) uploadFilesBtn.disabled = true;
      if (uploadFolderBtn) uploadFolderBtn.disabled = true;

      try {
        // Upload in batches of 15 files to avoid request size limits
        let totalUploaded = 0;
        const batchSize = 15;
        for (let i = 0; i < validFiles.length; i += batchSize) {
          const batch = validFiles.slice(i, i + batchSize);
          const formData = new FormData();
          formData.append('folder_name', folderName);
          for (const f of batch) {
            const relName = f.webkitRelativePath || f.name;
            formData.append('files', f, relName);
          }
          const resp = await fetch(`${API_BASE}/admin/ai/knowledge-base/upload`, {
            method: 'POST',
            headers: {
              ...getAdminHeaders(),
              ...getActorHeaders(),
            },
            body: formData,
          });
          if (!resp.ok) {
            throw new Error('დოკუმენტების ატვირთვა ვერ მოხერხდა');
          }
          const data = await resp.json();
          totalUploaded += Number(data.uploaded_count || batch.length);
          kbState = {
            total_files: Number(data.total_files || 0),
            total_size_bytes: Number(data.total_size_bytes || 0),
            total_chars: Number(data.total_chars || 0),
            items: Array.isArray(data.items) ? data.items : [],
          };
        }
        renderKbList();
        showToast(`ცოდნის ბაზაში აიტვირთა/განახლდა ${totalUploaded} დოკუმენტი`);
      } catch (err) {
        showToast(err?.message || 'დოკუმენტების ატვირთვა ვერ მოხერხდა', 'error');
      } finally {
        isUploadingKb = false;
        if (uploadFilesBtn) uploadFilesBtn.disabled = false;
        if (uploadFolderBtn) uploadFolderBtn.disabled = false;
      }
    }

    async function deleteKnowledgeBaseFile(docId) {
      const target = kbState.items.find((it) => String(it.id) === String(docId));
      const name = target ? target.filename : docId;
      if (!global.confirm(`წაიშალოს დოკუმენტი "${name}" საერთო ცოდნის ბაზიდან?`)) return;
      try {
        const resp = await fetch(`${API_BASE}/admin/ai/knowledge-base/${encodeURIComponent(docId)}`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!resp.ok) throw new Error('დოკუმენტის წაშლა ვერ მოხერხდა');
        const data = await resp.json();
        kbState = {
          total_files: Number(data.total_files || 0),
          total_size_bytes: Number(data.total_size_bytes || 0),
          total_chars: Number(data.total_chars || 0),
          items: Array.isArray(data.items) ? data.items : [],
        };
        renderKbList();
        showToast(`დოკუმენტი "${name}" წაიშალა`);
      } catch (err) {
        showToast(err?.message || 'წაშლა ვერ მოხერხდა', 'error');
      }
    }

    async function restoreKnowledgeBaseDefaults() {
      try {
        const resp = await fetch(`${API_BASE}/admin/ai/knowledge-base/restore-defaults`, {
          method: 'POST',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!resp.ok) throw new Error('საწყისი ბაზის აღდგენა ვერ მოხერხდა');
        const data = await resp.json();
        kbState = {
          total_files: Number(data.total_files || 0),
          total_size_bytes: Number(data.total_size_bytes || 0),
          total_chars: Number(data.total_chars || 0),
          items: Array.isArray(data.items) ? data.items : [],
        };
        renderKbList();
        showToast(`საწყისი დოკუმენტური ბაზა აღდგენილია (${kbState.total_files} ფაილი)`);
      } catch (err) {
        showToast(err?.message || 'აღდგენა ვერ მოხერხდა', 'error');
      }
    }

    function init() {
      buildMountSkeleton();
    }

    function render() {
      buildMountSkeleton();
      void loadData();
    }

    return {
      init,
      render,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createAiAssistantModule = createAiAssistantModule;
  global.AdminModules.createPublicAiAdminModule = createPublicAiAdminModule;
})(window);

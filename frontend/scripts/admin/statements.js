/* global window */
(function (global) {
  function createStatementsModule(context = {}) {
    const {
      DOM,
      API_BASE,
      on,
      formatDateTime,
      escapeHtml,
      showToast = () => {},
      handleAdminErrorResponse = () => {},
      getAdminHeaders = () => ({}),
      getActorHeaders = () => ({}),
      openOverlay = () => {},
      closeOverlay = () => {},
      isFounderActor = () => false,
      loadExternalScript = () => Promise.resolve(),
      arrayBufferToBase64 = () => '',
      deliverPdf = async () => false,
      preparePdfSaveHandle = async () => ({ handle: null, aborted: false }),
    } = context;

    const overlay = DOM.userStatementsOverlay;
    const list = DOM.userStatementsList;
    const meta = DOM.userStatementsMeta;
    const closeBtn = DOM.userStatementsClose;

    let activeUser = null;
    let cache = [];
    let viewVersion = 0;
    const seenInFlight = new Set();
    const answersInFlight = new Set();
    let jsPdfLoader = null;
    let fontLoader = null;

    function setMeta() {
      if (!meta) return;
      if (!activeUser) {
        meta.textContent = '';
        return;
      }
      const name = `${(activeUser.first_name || '').trim()} ${(activeUser.last_name || '').trim()}`.trim();
      const parts = [];
      if (name) parts.push(name);
      if (activeUser.code) parts.push(`კოდი: ${escapeHtml(activeUser.code)}`);
      if (activeUser.email) parts.push(escapeHtml(activeUser.email));
      meta.textContent = parts.join(' · ');
    }

    function renderPlaceholder(message, modifier) {
      if (!list) return;
      const wrapper = document.createElement('div');
      wrapper.className = `statements-placeholder${modifier ? ` ${modifier}` : ''}`;
      wrapper.textContent = message;
      list.innerHTML = '';
      list.appendChild(wrapper);
    }

    function isCurrentView(version, userId) {
      return version === viewVersion && activeUser?.id === userId;
    }

    function notifyStatementState(serverState) {
      if (!activeUser) return;
      const unseen = serverState?.unseen_statement_count ?? cache.filter((item) => item.seen_at == null).length;
      const pending = serverState?.pending_statement_count ?? cache.filter((item) => item.seen_at != null && item.answered_at == null).length;
      window.dispatchEvent(new CustomEvent('admin:statementsSeen', {
        detail: {
          userId: activeUser.id,
          remainingCount: unseen,
          hasUnseen: unseen > 0,
          pendingCount: pending,
          hasPending: pending > 0,
          refreshSummary: true,
        },
      }));
    }

    function updateStatementElement(details, item) {
      const unseen = item.seen_at == null;
      const pending = !unseen && item.answered_at == null;
      details.classList.toggle('is-unseen', unseen);
      details.classList.toggle('is-pending', pending);
      const status = details.querySelector('.statement-status');
      if (status) status.textContent = unseen ? 'ახალი' : pending ? 'უპასუხო' : 'პასუხი გაცემულია';
      const checkbox = details.querySelector('.statement-answered-checkbox');
      if (checkbox && !checkbox.disabled) checkbox.checked = item.answered_at != null;
    }

    function bindAnswered(checkbox, statementId) {
      const version = viewVersion;
      const userId = activeUser?.id;
      on(checkbox, 'change', async () => {
        const key = `${version}:${statementId}`;
        if (!isCurrentView(version, userId) || answersInFlight.has(key)) return;
        const answered = checkbox.checked;
        answersInFlight.add(key);
        checkbox.disabled = true;
        try {
          const response = await fetch(`${API_BASE}/admin/statements/${statementId}/answered`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...getAdminHeaders(), ...getActorHeaders() },
            body: JSON.stringify({ answered }),
          });
          if (!isCurrentView(version, userId)) return;
          if (!response.ok) {
            await handleAdminErrorResponse(response, 'პასუხის სტატუსი ვერ შეინახა', showToast);
            return;
          }
          const data = await response.json();
          if (!isCurrentView(version, userId)) return;
          if (data.statement?.id !== statementId) throw new Error('Invalid statement response');
          cache = cache.map((item) => item.id === statementId ? { ...item, ...data.statement } : item);
          const currentDetails = list?.querySelector(`.statement-item[data-statement-id="${statementId}"]`);
          if (currentDetails) updateStatementElement(currentDetails, data.statement);
          notifyStatementState(data);
        } catch {
          if (isCurrentView(version, userId)) showToast('პასუხის სტატუსი ვერ შეინახა', 'error');
        } finally {
          answersInFlight.delete(key);
          if (isCurrentView(version, userId)) {
            const currentDetails = list?.querySelector(`.statement-item[data-statement-id="${statementId}"]`);
            const currentCheckbox = currentDetails?.querySelector('.statement-answered-checkbox');
            if (currentCheckbox) currentCheckbox.disabled = false;
            const item = cache.find((entry) => entry.id === statementId);
            if (item && currentDetails) updateStatementElement(currentDetails, item);
          }
        }
      });
    }

    function bindDelete(button, statementId) {
      if (!button) return;
      on(button, 'click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!global.confirm('ნამდვილად გსურთ განცხადების წაშლა?')) return;
        const version = viewVersion;
        const userId = activeUser?.id;
        try {
          const response = await fetch(`${API_BASE}/admin/statements/${statementId}`, {
            method: 'DELETE',
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          });
          if (!isCurrentView(version, userId)) return;
          if (!response.ok) {
            await handleAdminErrorResponse(response, 'განცხადების წაშლა ვერ შესრულდა', showToast);
            return;
          }
          cache = cache.filter((item) => item.id !== statementId);
          renderList(cache);
          notifyStatementState();
          showToast('განცხადება წაიშალა');
        } catch {
          showToast('განცხადების წაშლა ვერ შესრულდა', 'error');
        }
      });
    }

    function bindDownload(button, statement) {
      if (!button) return;
      on(button, 'click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          const code = (activeUser?.code || `user-${activeUser?.id || 'unknown'}`).toString().trim().replace(/\s+/g, '_');
          const filename = `statement_${code}_${statement.id}.pdf`;
          const prep = await preparePdfSaveHandle(filename, { showToast });
          if (prep?.aborted) return;
          await downloadStatementPdf(statement, { saveHandle: prep?.handle || null, filename });
        } catch {
          showToast('PDF ფაილის შექმნა ვერ მოხერხდა', 'error');
        }
      });
    }

    function renderList(items) {
      if (!list) return;
      if (!items.length) {
        renderPlaceholder('განცხადებები ვერ მოიძებნა', 'statements-empty');
        return;
      }
      const fragment = document.createDocumentFragment();
      items.forEach((item) => {
        const details = document.createElement('details');
        details.className = 'statement-item';
        details.dataset.statementId = String(item.id);
        details.setAttribute('role', 'listitem');

        const summary = document.createElement('summary');
        summary.className = 'statement-summary';

        const date = document.createElement('span');
        date.className = 'statement-date';
        date.textContent = formatDateTime(item.created_at);
        summary.appendChild(date);

        const docNumberText = (item.doc_number || '').trim();
        if (docNumberText) {
          const docNum = document.createElement('span');
          docNum.className = 'statement-doc-number';
          docNum.textContent = docNumberText;
          summary.appendChild(docNum);
        }

        const previewText = (item.message || '').replace(/\s+/g, ' ').trim();
        if (previewText) {
          const preview = document.createElement('span');
          preview.className = 'statement-preview';
          preview.textContent = previewText.length > 80 ? `${previewText.slice(0, 77)}…` : previewText;
          summary.appendChild(preview);
        }

        const status = document.createElement('span');
        status.className = 'statement-status';
        status.setAttribute('aria-live', 'polite');
        summary.appendChild(status);

        details.appendChild(summary);

        const messageWrapper = document.createElement('div');
        messageWrapper.className = 'statement-message';

        const message = document.createElement('div');
        message.className = 'statement-message-text';
        message.textContent = docNumberText
          ? `დოკუმენტის №: ${docNumberText}\n\n${item.message || ''}`
          : (item.message || '');
        messageWrapper.appendChild(message);

        const actions = document.createElement('div');
        actions.className = 'statement-actions';

        const replyBtn = document.createElement('button');
        replyBtn.type = 'button';
        replyBtn.className = 'exam-stmt-reply-btn statement-reply-btn';
        replyBtn.textContent = '↩ პასუხის გაცემა';
        replyBtn.setAttribute('aria-label', 'პასუხის გაცემა განცხადებაზე');
        replyBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const targetUser = activeUser;
          if (!targetUser) return;
          if (item.seen_at == null) {
            void markStatementsSeen([item.id]);
          }
          close();
          window.dispatchEvent(new CustomEvent('admin:openStatementReply', {
            detail: {
              userId: targetUser.id,
              returnToHistory: true,
              statementItem: {
                statementId: item.id,
                docNumber: docNumberText,
                body: item.message || '',
                statementRaw: item,
              },
            },
          }));
        });
        actions.appendChild(replyBtn);

        const answeredLabel = document.createElement('label');
        answeredLabel.className = 'statement-answered-label';
        const answeredCheckbox = document.createElement('input');
        answeredCheckbox.type = 'checkbox';
        answeredCheckbox.className = 'statement-answered-checkbox';
        answeredCheckbox.checked = item.answered_at != null;
        answeredCheckbox.disabled = answersInFlight.has(`${viewVersion}:${item.id}`);
        answeredCheckbox.setAttribute('aria-label', 'პასუხი გაცემულია');
        bindAnswered(answeredCheckbox, item.id);
        answeredLabel.appendChild(answeredCheckbox);
        const answeredText = document.createElement('span');
        answeredText.textContent = 'პასუხი გაცემულია';
        answeredLabel.appendChild(answeredText);
        actions.appendChild(answeredLabel);

        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'statement-download';
        downloadBtn.textContent = 'PDF ჩამოტვირთვა';
        downloadBtn.setAttribute('aria-label', 'განცხადების ჩამოტვირთვა PDF');
        bindDownload(downloadBtn, item);
        actions.appendChild(downloadBtn);

        // Attachment download button(s), if present
        const itemAttachments = Array.isArray(item.attachments) && item.attachments.length
          ? item.attachments
          : (item.attachment_filename ? [{ slot: 1, filename: item.attachment_filename }] : []);
        if (itemAttachments.length) {
          itemAttachments.forEach((att) => {
            if (!att?.filename) return;
            const slotNum = Number(att.slot) || 1;
            const attachBtn = document.createElement('button');
            attachBtn.type = 'button';
            attachBtn.className = 'statement-attachment-download';
            attachBtn.textContent = itemAttachments.length > 1
              ? `📎 ${att.filename}`
              : 'ფაილის ჩამოტვირთვა';
            attachBtn.setAttribute('aria-label', `ატვირთული ფაილის ჩამოტვირთვა: ${att.filename}`);
            attachBtn.addEventListener('click', async () => {
              try {
                const slotParam = slotNum > 1 ? `?slot=${encodeURIComponent(slotNum)}` : '';
                const url = `${API_BASE}/admin/statements/${encodeURIComponent(item.id)}/file${slotParam}`;
                const resp = await fetch(url, { headers: { ...getAdminHeaders(), ...getActorHeaders() } });
                if (!resp.ok) { showToast('ფაილის ჩამოტვირთვა ვერ მოხერხდა', 'error'); return; }
                const blob = await resp.blob();
                const link = document.createElement('a');
                link.href = URL.createObjectURL(blob);
                link.download = att.filename || 'file';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(link.href);
              } catch { showToast('ფაილის ჩამოტვირთვა ვერ მოხერხდა', 'error'); }
            });
            actions.appendChild(attachBtn);
          });
        }

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'statement-delete head-delete';
        deleteBtn.textContent = '×';
        deleteBtn.setAttribute('aria-label', 'წაშლა');
        deleteBtn.title = 'წაშლა';
        bindDelete(deleteBtn, item.id);
        actions.appendChild(deleteBtn);

        messageWrapper.appendChild(actions);

        details.appendChild(messageWrapper);
        updateStatementElement(details, item);
        fragment.appendChild(details);

        details.addEventListener('toggle', () => {
          if (details.open && details.classList.contains('is-unseen')) {
            return markStatementsSeen([item.id]);
          }
        });
      });
      list.innerHTML = '';
      list.appendChild(fragment);
    }

    async function loadStatements() {
      if (!activeUser) return;
      const version = viewVersion;
      const userId = activeUser.id;
      try {
        const response = await fetch(`${API_BASE}/admin/users/${userId}/statements`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!isCurrentView(version, userId)) return;
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'განცხადებების ჩატვირთვა ვერ შესრულდა', showToast);
          if (!isCurrentView(version, userId)) return;
          renderPlaceholder('განცხადებების ჩატვირთვა ვერ შესრულდა', 'statements-error');
          return;
        }
        const data = await response.json();
        if (!isCurrentView(version, userId)) return;
        cache = Array.isArray(data?.items) ? data.items : [];
        renderList(cache);
        notifyStatementState();
      } catch {
        if (isCurrentView(version, userId)) renderPlaceholder('განცხადებების ჩატვირთვა ვერ შესრულდა', 'statements-error');
      }
    }

    async function markStatementsSeen(ids) {
      if (!activeUser || !Array.isArray(ids) || !ids.length) return;
      const version = viewVersion;
      const userId = activeUser.id;
      ids = ids.filter((id) => !seenInFlight.has(`${version}:${id}`) && cache.some((item) => item.id === id && item.seen_at == null));
      if (!ids.length) return;
      ids.forEach((id) => seenInFlight.add(`${version}:${id}`));
      try {
        const response = await fetch(`${API_BASE}/admin/statements/mark-seen`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({ statement_ids: ids }),
        });
        if (!isCurrentView(version, userId)) return;
        if (!response.ok) throw new Error('mark failed');
        const nowIso = new Date().toISOString();
        cache = cache.map((item) => (ids.includes(item.id) && item.seen_at == null ? { ...item, seen_at: nowIso, seen_by: window.Auth?.getSavedEmail?.() || 'admin' } : item));
        if (list) {
          list.querySelectorAll('.statement-item').forEach((element) => {
            const statementId = Number(element.dataset.statementId);
            if (ids.includes(statementId)) {
              const item = cache.find((entry) => entry.id === statementId);
              if (item) updateStatementElement(element, item);
            }
          });
        }
        notifyStatementState();
      } catch {
        if (isCurrentView(version, userId)) showToast('განცხადება წაკითხულად ვერ მოინიშნა. სცადეთ ხელახლა გახსნა.', 'error');
      } finally {
        ids.forEach((id) => seenInFlight.delete(`${version}:${id}`));
      }
    }

    function open(user) {
      if (!overlay || !list) return;
      viewVersion += 1;
      activeUser = user || null;
      cache = [];
      setMeta();
      renderPlaceholder('იტვირთება...', 'statements-loading');
      openOverlay(overlay);
      return loadStatements();
    }

    function close() {
      if (!overlay) return;
      viewVersion += 1;
      closeOverlay(overlay);
      activeUser = null;
      cache = [];
      if (list) list.innerHTML = '';
      setMeta();
    }

    function handleBackdrop(event) {
      if (event.target === overlay) {
        close();
      }
    }

    async function ensureJsPdf() {
      if (global.jspdf?.jsPDF) return global.jspdf.jsPDF;
      if (!jsPdfLoader) {
        jsPdfLoader = loadExternalScript('../vendor/jspdf.umd.min.js').catch((error) => {
          jsPdfLoader = null;
          throw error;
        });
      }
      await jsPdfLoader;
      if (!global.jspdf?.jsPDF) {
        throw new Error('jsPDF unavailable');
      }
      return global.jspdf.jsPDF;
    }

    async function ensurePdfFont(doc) {
      const fontName = 'DejaVuSansUnicode';
      const fontList = doc.getFontList?.() || {};
      if (fontList[fontName]) {
        doc.setFont(fontName, 'normal');
        return fontName;
      }
      if (!fontLoader) {
        const fontUrl = new URL('../assets/fonts/dejavu-sans.ttf', global.location.href).toString();
        fontLoader = fetch(fontUrl)
          .then((response) => {
            if (!response.ok) throw new Error('Font download failed');
            return response.arrayBuffer();
          })
          .then((buffer) => arrayBufferToBase64(buffer))
          .catch((error) => {
            fontLoader = null;
            throw error;
          });
      }
      const base64 = await fontLoader;
      doc.addFileToVFS('DejaVuSans.ttf', base64);
      doc.addFont('DejaVuSans.ttf', fontName, 'normal');
      doc.addFont('DejaVuSans.ttf', fontName, 'bold');
      doc.addFont('DejaVuSans.ttf', fontName, 'italic');
      doc.addFont('DejaVuSans.ttf', fontName, 'bolditalic');
      doc.setFont(fontName, 'normal');
      return fontName;
    }

    async function downloadStatementPdf(statement, options = {}) {
      const targetUser = options.user || activeUser;
      if (!statement || !targetUser) throw new Error('Statement context missing');
      const jsPDF = await ensureJsPdf();
      const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
      const fontName = await ensurePdfFont(doc);

      const margin = 48;
      const pageWidth = doc.internal.pageSize.getWidth();
      const usableWidth = pageWidth - margin * 2;
      const pageHeight = doc.internal.pageSize.getHeight();
      const lineHeight = 18;
      let cursorY = margin;

      const ensureSpace = (height = lineHeight) => {
        if (cursorY + height > pageHeight - margin) {
          doc.addPage();
          cursorY = margin;
        }
      };

      const writeHeading = (text) => {
        ensureSpace(lineHeight * 2);
        doc.setFont(fontName, 'bold');
        doc.setFontSize(20);
        doc.text(text, margin, cursorY);
        cursorY += lineHeight * 1.5;
        doc.setFontSize(12);
      };

      const writeField = (label, value) => {
        const safeValue = value || '—';
        ensureSpace(lineHeight * 1.2);
        doc.setFont(fontName, 'bold');
        const labelText = `${label}:`;
        const labelWidth = doc.getTextWidth(labelText) + 6;
        doc.text(labelText, margin, cursorY);
        doc.setFont(fontName, 'normal');
        const split = doc.splitTextToSize(String(safeValue), usableWidth - labelWidth);
        doc.text(split, margin + labelWidth, cursorY);
        cursorY += lineHeight * Math.max(split.length, 1);
      };

      const writeParagraph = (label, text) => {
        ensureSpace(lineHeight * 1.5);
        doc.setFont(fontName, 'bold');
        doc.text(`${label}:`, margin, cursorY);
        cursorY += lineHeight;
        doc.setFont(fontName, 'normal');
        const lines = doc.splitTextToSize(text || '—', usableWidth);
        lines.forEach((line) => {
          ensureSpace(lineHeight);
          doc.text(line, margin, cursorY);
          cursorY += lineHeight;
        });
      };

      const fullName = `${(targetUser.first_name || '').trim()} ${(targetUser.last_name || '').trim()}`.trim();
      const personalId = targetUser.personal_id || '';
      const phone = targetUser.phone || '';
      const email = targetUser.email || '';
      const code = targetUser.code || '';
      const createdAt = formatDateTime(statement.created_at);
      const docNumber = (statement.doc_number || '').trim() || (
        statement.id != null
          ? `IN-${new Date(statement.created_at || Date.now()).getFullYear()}-${String(statement.id).padStart(4, '0')}`
          : ''
      );

      writeHeading('განცხადება');
      doc.setFontSize(12);

      if (docNumber) {
        writeField('დოკუმენტის №', docNumber);
      }
      writeField('სახელი, გვარი', fullName || '—');
      writeField('პირადი ნომერი', personalId);
      writeField('ტელეფონი', phone);
      writeField('ელფოსტა', email);
      writeField('უნიკალური კოდი', code);
      writeField('განცხადების თარიღი', createdAt || '—');

      writeParagraph('განცხადების ტექსტი', statement.message || '');

      const safeCode = (code || `user-${targetUser.id || 'unknown'}`).toString().trim().replace(/\s+/g, '_');
      const fileName = options.filename || `statement_${safeCode}_${statement.id}.pdf`;
      const prep = options.saveHandle !== undefined
        ? { handle: options.saveHandle, aborted: false }
        : await preparePdfSaveHandle(fileName, { showToast });
      if (prep?.aborted) return;
      await deliverPdf(doc, fileName, { showToast, handle: prep?.handle || null });
    }

    function init() {
      if (!overlay) return;
      on(closeBtn, 'click', close);
      on(overlay, 'click', handleBackdrop);
      on(document, 'keydown', (event) => {
        if (event.key === 'Escape' && overlay.classList.contains('open')) {
          close();
        }
      });
    }

    return {
      init,
      open,
      close,
      downloadStatementPdf,
      markStatementsSeen,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createStatementsModule = createStatementsModule;
})(window);



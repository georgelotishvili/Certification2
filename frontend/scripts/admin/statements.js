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
    let loading = false;
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

    function bindDelete(button, statementId) {
      if (!button) return;
      on(button, 'click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!global.confirm('ნამდვილად გსურთ განცხადების წაშლა?')) return;
        try {
          const response = await fetch(`${API_BASE}/admin/statements/${statementId}`, {
            method: 'DELETE',
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          });
          if (!response.ok) {
            await handleAdminErrorResponse(response, 'განცხადების წაშლა ვერ შესრულდა', showToast);
            return;
          }
          cache = cache.filter((item) => item.id !== statementId);
          renderList(cache);
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
      items.forEach((item, index) => {
        const details = document.createElement('details');
        details.className = 'statement-item';
        details.dataset.statementId = String(item.id);
        details.setAttribute('role', 'listitem');
        if (item.seen_at == null) {
          details.classList.add('is-unseen');
        }

        const summary = document.createElement('summary');
        summary.className = 'statement-summary';

        const date = document.createElement('span');
        date.className = 'statement-date';
        date.textContent = formatDateTime(item.created_at);
        summary.appendChild(date);

        const previewText = (item.message || '').replace(/\s+/g, ' ').trim();
        if (previewText) {
          const preview = document.createElement('span');
          preview.className = 'statement-preview';
          preview.textContent = previewText.length > 80 ? `${previewText.slice(0, 77)}…` : previewText;
          summary.appendChild(preview);
        }

        details.appendChild(summary);

        const messageWrapper = document.createElement('div');
        messageWrapper.className = 'statement-message';

        const message = document.createElement('div');
        message.className = 'statement-message-text';
        message.textContent = item.message || '';
        messageWrapper.appendChild(message);

        const actions = document.createElement('div');
        actions.className = 'statement-actions';

        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.className = 'statement-download';
        downloadBtn.textContent = 'PDF ჩამოტვირთვა';
        downloadBtn.setAttribute('aria-label', 'განცხადების ჩამოტვირთვა PDF');
        bindDownload(downloadBtn, item);
        actions.appendChild(downloadBtn);

        // Attachment download button, if present
        if (item.attachment_filename) {
          const actorEmail = (getActorHeaders()['x-actor-email'] || '').trim();
          const attachBtn = document.createElement('button');
          attachBtn.type = 'button';
          attachBtn.className = 'statement-attachment-download';
          attachBtn.textContent = 'ფაილის ჩამოტვირთვა';
          attachBtn.setAttribute('aria-label', 'ატვირთული ფაილის ჩამოტვირთვა');
          attachBtn.addEventListener('click', () => {
            const url = `${API_BASE}/admin/statements/${encodeURIComponent(item.id)}/file${actorEmail ? `?actor=${encodeURIComponent(actorEmail)}` : ''}`;
            window.open(url, '_blank');
          });
          actions.appendChild(attachBtn);
        }

        if (isFounderActor()) {
          const deleteBtn = document.createElement('button');
          deleteBtn.type = 'button';
          deleteBtn.className = 'statement-delete head-delete';
          deleteBtn.textContent = '×';
          deleteBtn.setAttribute('aria-label', 'წაშლა');
          deleteBtn.title = 'წაშლა';
          bindDelete(deleteBtn, item.id);
          actions.appendChild(deleteBtn);
        }

        messageWrapper.appendChild(actions);

        details.appendChild(messageWrapper);
        fragment.appendChild(details);

        details.addEventListener('toggle', () => {
          if (details.open && details.classList.contains('is-unseen')) {
            markStatementsSeen([item.id]);
          }
        });
      });
      list.innerHTML = '';
      list.appendChild(fragment);
    }

    async function loadStatements() {
      if (!activeUser || loading) return;
      loading = true;
      try {
        const response = await fetch(`${API_BASE}/admin/users/${activeUser.id}/statements`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'განცხადებების ჩატვირთვა ვერ შესრულდა', showToast);
          renderPlaceholder('განცხადებების ჩატვირთვა ვერ შესრულდა', 'statements-error');
          return;
        }
        const data = await response.json();
        cache = Array.isArray(data?.items) ? data.items : [];
        renderList(cache);
      } catch {
        renderPlaceholder('განცხადებების ჩატვირთვა ვერ შესრულდა', 'statements-error');
      } finally {
        loading = false;
      }
    }

    async function markStatementsSeen(ids) {
      if (!Array.isArray(ids) || !ids.length) return;
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
        if (!response.ok) throw new Error('mark failed');
        const nowIso = new Date().toISOString();
        cache = cache.map((item) => (ids.includes(item.id) ? { ...item, seen_at: nowIso, seen_by: getActorHeaders()['x-actor-email'] || 'admin' } : item));
        const remaining = cache.filter((item) => item.seen_at == null).length;
        if (list) {
          list.querySelectorAll('.statement-item').forEach((element) => {
            const statementId = Number(element.dataset.statementId);
            if (ids.includes(statementId)) {
              element.classList.remove('is-unseen');
            }
          });
        }
        window.dispatchEvent(new CustomEvent('admin:statementsSeen', {
          detail: {
            userId: activeUser?.id,
            ids,
            remainingCount: remaining,
            hasUnseen: remaining > 0,
            refreshSummary: remaining <= 0,
          },
        }));
      } catch {}
    }

    function open(user) {
      if (!overlay || !list) return;
      activeUser = user || null;
      setMeta();
      renderPlaceholder('იტვირთება...', 'statements-loading');
      openOverlay(overlay);
      loadStatements();
    }

    function close() {
      if (!overlay) return;
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
        const CDN_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
        jsPdfLoader = loadExternalScript(CDN_SRC).catch((error) => {
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
      if (!statement || !activeUser) throw new Error('Statement context missing');
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

      const fullName = `${(activeUser.first_name || '').trim()} ${(activeUser.last_name || '').trim()}`.trim();
      const personalId = activeUser.personal_id || '';
      const phone = activeUser.phone || '';
      const email = activeUser.email || '';
      const code = activeUser.code || '';
      const createdAt = formatDateTime(statement.created_at);

      writeHeading('განცხადება');
      doc.setFontSize(12);

      writeField('სახელი, გვარი', fullName || '—');
      writeField('პირადი ნომერი', personalId);
      writeField('ტელეფონი', phone);
      writeField('ელფოსტა', email);
      writeField('უნიკალური კოდი', code);
      writeField('განცხადების თარიღი', createdAt || '—');

      writeParagraph('განცხადების ტექსტი', statement.message || '');

      const safeCode = code || `user-${activeUser.id || 'unknown'}`;
      const fileName = options.filename || `statement_${safeCode}_${statement.id}.pdf`;
      await deliverPdf(doc, fileName, { showToast, handle: options.saveHandle || null });
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



(function (global) {
  function createProjectResultsModule(context) {
    const {
      DOM,
      API_BASE,
      on,
      showToast,
      formatDateTime,
      formatDuration,
      arrayBufferToBase64,
      loadExternalScript,
      getAdminHeaders,
      getActorHeaders,
      openOverlay,
      closeOverlay,
      escapeHtml,
      isFounderActor = () => false,
      deliverPdf = async () => false,
      preparePdfSaveHandle = async () => ({ handle: null, aborted: false }),
    } = context;

    const state = {
      currentUser: null,
      projectType: null, // 'multi-apartment' or 'multi-functional'
      results: [],
      detail: null,
      loading: false,
      detailLoading: false,
    };

    const PDF_COLORS = {
      text: '#0f172a',
      muted: '#64748b',
      success: '#1f8a4d',
      danger: '#c73631',
      cardBackground: '#f8fafc',
      cardBorder: '#d0d8ea',
    };

    function answerStatusMeta(answer) {
      if (!answer) {
        return { label: 'უცნობია', tag: 'neutral' };
      }
      if (answer.isSelected && answer.isCorrect) {
        return { label: 'სწორია', tag: 'success' };
      }
      if (answer.isSelected && !answer.isCorrect) {
        return { label: 'არასწორია', tag: 'error' };
      }
      if (!answer.isSelected && answer.isCorrect) {
        return { label: 'სწორი (არ მონიშნული)', tag: 'neutral' };
      }
      return { label: '', tag: 'neutral' };
    }

    function buildAnswerCard(answer, index) {
      const card = document.createElement('article');
      card.className = 'result-question-card';

      const statusData = answerStatusMeta(answer);
      const showStatus = statusData.label !== '';

      const head = document.createElement('div');
      head.className = 'result-question-card-head';

      const headTop = document.createElement('div');
      headTop.className = 'result-question-card-head-top';

      const metaWrap = document.createElement('div');
      metaWrap.className = 'result-question-card-head-meta';
      
      const numItem = document.createElement('span');
      numItem.className = 'meta-item';
      const numLabel = document.createElement('span');
      numLabel.className = 'label';
      numLabel.textContent = 'პასუხი №';
      numItem.appendChild(numLabel);
      const numValue = document.createElement('span');
      numValue.textContent = String(index + 1);
      numItem.appendChild(numValue);
      metaWrap.appendChild(numItem);

      if (showStatus) {
        const statusTag = document.createElement('span');
        statusTag.className = `result-tag ${statusData.tag}`;
        statusTag.textContent = statusData.label;
        headTop.append(metaWrap, statusTag);
      } else {
        headTop.appendChild(metaWrap);
      }

      head.appendChild(headTop);
      card.appendChild(head);

      const answerText = document.createElement('div');
      answerText.className = 'result-question-text';
      answerText.textContent = answer.text || '';
      card.appendChild(answerText);

      // Badge indicators
      const badgeWrap = document.createElement('div');
      badgeWrap.className = 'answer-badges';
      badgeWrap.style.cssText = 'display:flex;gap:8px;margin-top:8px;';

      if (answer.isSelected) {
        const selectedBadge = document.createElement('span');
        selectedBadge.className = 'option-badge selected-badge';
        selectedBadge.textContent = 'მონიშნული';
        selectedBadge.style.cssText = 'background:#dbeafe;color:#1e40af;padding:4px 10px;border-radius:4px;font-size:12px;';
        badgeWrap.appendChild(selectedBadge);
      }
      if (answer.isCorrect) {
        const correctBadge = document.createElement('span');
        correctBadge.className = 'option-badge correct-badge';
        correctBadge.textContent = 'სწორი';
        correctBadge.style.cssText = 'background:#dcfce7;color:#166534;padding:4px 10px;border-radius:4px;font-size:12px;';
        badgeWrap.appendChild(correctBadge);
      }

      if (badgeWrap.children.length > 0) {
        card.appendChild(badgeWrap);
      }

      return card;
    }

    function setCandidateHeader(user, type) {
      const first = (user?.first_name || user?.firstName || '').trim();
      const last = (user?.last_name || user?.lastName || '').trim();
      if (DOM.projectResultsFullName) {
        const fullName = `${first} ${last}`.trim() || 'უცნობი კანდიდატი';
        DOM.projectResultsFullName.textContent = fullName;
      }
      if (DOM.projectResultsType) {
        const typeName = type === 'multi-apartment' ? 'მრავალბინიანი' : 'მრავალფუნქციური';
        DOM.projectResultsType.textContent = typeName;
      }
    }

    function renderResultsList() {
      if (!DOM.projectResultsList) return;
      if (state.loading) {
        DOM.projectResultsList.innerHTML = '<div class="empty-state">იტვირთება...</div>';
        return;
      }
      if (!state.results.length) {
        DOM.projectResultsList.innerHTML = '<div class="empty-state">შედეგები არ მოიძებნა</div>';
        return;
      }
      const fragment = document.createDocumentFragment();
      state.results.forEach((item) => {
        const card = createAttemptCard(item);
        if (card) fragment.appendChild(card);
      });
      DOM.projectResultsList.innerHTML = '';
      DOM.projectResultsList.appendChild(fragment);
    }

    function createAttemptCard(item) {
      if (!item) return null;
      const card = document.createElement('div');
      card.className = 'attempt-card';
      card.setAttribute('role', 'listitem');
      
      const finishedAt = item.finishedAt ? formatDateTime(item.finishedAt) : formatDateTime(item.createdAt);
      const score = typeof item.percentage === 'number' ? Number(item.percentage).toFixed(1) : '0.0';
      const scoreColor = item.percentage >= 75 ? 'success' : item.percentage >= 70 ? 'neutral' : 'error';

      const safeFinishedAt = escapeHtml(finishedAt);
      const safeScore = escapeHtml(score);
      const safeProjectName = escapeHtml(item.projectName || item.projectCode || 'პროექტი');
      
      card.innerHTML = `
        <div class="attempt-info">
          <div class="attempt-date">პროექტი: <strong>${safeProjectName}</strong></div>
          <div class="attempt-status">
            <span class="result-tag ${scoreColor}">${safeScore}%</span>
            <span>სწორი: ${item.correctCount || 0}/${item.totalCorrectAnswers || 0}</span>
          </div>
          <div class="attempt-meta">თარიღი: ${safeFinishedAt}</div>
        </div>
        <div class="attempt-actions">
          <button type="button" class="secondary-btn" data-action="view">შედეგის ნახვა</button>
          ${
            isFounderActor()
              ? '<button type="button" class="attempt-delete" data-action="delete" aria-label="შედეგის წაშლა" title="წაშლა">×</button>'
              : ''
          }
        </div>
      `;

      const viewBtn = card.querySelector('[data-action="view"]');
      if (viewBtn) {
        viewBtn.addEventListener('click', () => handleView(item.id));
      }
      
      const deleteBtn = card.querySelector('[data-action="delete"]');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => handleDelete(item.id));
      }
      return card;
    }
    
    async function handleDelete(evaluationId) {
      if (!evaluationId || !isFounderActor()) return;
      
      const confirmed = window.confirm('ნამდვილად გსურთ შედეგის წაშლა? ეს ქმედება შეუქცევადია.');
      if (!confirmed) return;
      
      try {
        const endpoint = state.projectType === 'multi-apartment'
          ? `${API_BASE}/admin/multi-apartment/evaluations/${evaluationId}`
          : `${API_BASE}/admin/multi-functional/evaluations/${evaluationId}`;
        
        const response = await fetch(endpoint, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        
        if (!response.ok && response.status !== 204) {
          throw new Error('Delete failed');
        }
        
        // Remove from local state
        state.results = state.results.filter(r => r.id !== evaluationId);
        renderResultsList();
        
        // Close detail if viewing this evaluation
        if (state.detail?.id === evaluationId) {
          closeDetail();
        }
        
        showToast('შედეგი წაიშალა');
      } catch (error) {
        console.error('Delete error:', error);
        showToast('შედეგის წაშლა ვერ მოხერხდა', 'error');
      }
    }

    async function loadResults(user, type) {
      state.loading = true;
      renderResultsList();
      try {
        const endpoint = type === 'multi-apartment'
          ? `${API_BASE}/admin/multi-apartment/evaluations/${user.id}`
          : `${API_BASE}/admin/multi-functional/evaluations/${user.id}`;
        
        const response = await fetch(endpoint, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) throw new Error('failed');
        const data = await response.json();
        state.results = Array.isArray(data?.items) ? data.items : [];
      } catch {
        state.results = [];
        showToast('შედეგების ჩატვირთვა ვერ მოხერხდა', 'error');
      } finally {
        state.loading = false;
        renderResultsList();
      }
    }

    async function fetchResultDetail(evaluationId) {
      const endpoint = state.projectType === 'multi-apartment'
        ? `${API_BASE}/admin/multi-apartment/evaluations/detail/${evaluationId}`
        : `${API_BASE}/admin/multi-functional/evaluations/detail/${evaluationId}`;
      
      const response = await fetch(endpoint, {
        headers: { ...getAdminHeaders(), ...getActorHeaders() },
      });
      if (!response.ok) throw new Error('failed');
      return await response.json();
    }

    function renderDetailLoading() {
      if (DOM.projectDetailProjectName) DOM.projectDetailProjectName.textContent = 'იტვირთება...';
      if (DOM.projectDetailStatus) DOM.projectDetailStatus.innerHTML = '';
      if (DOM.projectDetailCandidate) DOM.projectDetailCandidate.textContent = '';
      if (DOM.projectDetailProjectCode) DOM.projectDetailProjectCode.textContent = '';
      if (DOM.projectDetailStartedAt) DOM.projectDetailStartedAt.textContent = '';
      if (DOM.projectDetailFinishedAt) DOM.projectDetailFinishedAt.textContent = '';
      if (DOM.projectDetailDuration) DOM.projectDetailDuration.textContent = '';
      if (DOM.projectDetailScore) DOM.projectDetailScore.textContent = '';
      if (DOM.projectDetailSummary) DOM.projectDetailSummary.textContent = '';
      if (DOM.projectAnswerList) DOM.projectAnswerList.innerHTML = '';
    }

    function renderDetail(detail) {
      if (!detail) return;
      
      const scoreColor = detail.percentage >= 75 ? 'success' : detail.percentage >= 70 ? 'neutral' : 'error';

      if (DOM.projectDetailProjectName) {
        DOM.projectDetailProjectName.textContent = detail.projectName || detail.projectCode || 'პროექტი';
      }
      if (DOM.projectDetailStatus) {
        DOM.projectDetailStatus.innerHTML = `<span class="result-tag ${scoreColor}">${Number(detail.percentage || 0).toFixed(1)}%</span>`;
      }
      
      const userName = state.currentUser
        ? `${(state.currentUser.first_name || '').trim()} ${(state.currentUser.last_name || '').trim()}`.trim()
        : 'უცნობი';
      if (DOM.projectDetailCandidate) DOM.projectDetailCandidate.textContent = userName;
      if (DOM.projectDetailProjectCode) DOM.projectDetailProjectCode.textContent = detail.projectCode || '—';
      if (DOM.projectDetailStartedAt) DOM.projectDetailStartedAt.textContent = formatDateTime(detail.startedAt);
      const finishedAtText = detail.finishedAt ? formatDateTime(detail.finishedAt) : 'არ დასრულებულა';
      if (DOM.projectDetailFinishedAt) DOM.projectDetailFinishedAt.textContent = finishedAtText;
      if (DOM.projectDetailDuration) {
        const mins = Math.floor((detail.durationSeconds || 0) / 60);
        const secs = (detail.durationSeconds || 0) % 60;
        DOM.projectDetailDuration.textContent = `${mins} წთ ${secs} წმ`;
      }
      if (DOM.projectDetailScore) {
        DOM.projectDetailScore.textContent = `${Number(detail.percentage || 0).toFixed(2)}%`;
      }
      if (DOM.projectDetailSummary) {
        DOM.projectDetailSummary.textContent = `სწორი: ${detail.correctCount || 0} • არასწორი: ${detail.wrongCount || 0} • სულ სწორი პასუხი: ${detail.totalCorrectAnswers || 0}`;
      }

      if (DOM.projectAnswerList) {
        DOM.projectAnswerList.innerHTML = '';
        (detail.answers || []).forEach((answer, index) => {
          if (!answer) return;
          const card = buildAnswerCard(answer, index);
          if (card) DOM.projectAnswerList.appendChild(card);
        });
      }
    }

    function closeDetail() {
      closeOverlay(DOM.projectDetailOverlay);
      state.detail = null;
    }

    async function handleView(evaluationId) {
      if (!evaluationId) return;
      state.detailLoading = true;
      renderDetailLoading();
      openOverlay(DOM.projectDetailOverlay);
      try {
        const detail = await fetchResultDetail(evaluationId);
        state.detail = detail;
        renderDetail(detail);
      } catch {
        showToast('დეტალური შედეგი ვერ ჩაიტვირთა', 'error');
        closeDetail();
      } finally {
        state.detailLoading = false;
      }
    }

    let jsPdfLoader = null;
    let fontLoader = null;

    async function ensurePdfFont(doc) {
      const fontName = 'DejaVuSansUnicode';
      const hasFont = doc.getFontList?.()?.[fontName];
      if (hasFont) {
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
      doc.setFont(fontName, 'normal');
      return fontName;
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
        throw new Error('jsPDF unavailable after loading');
      }
      return global.jspdf.jsPDF;
    }

    async function downloadCurrentPdf() {
      if (!state.detail) return;
      const typeName = state.projectType === 'multi-apartment' ? 'multi_apartment' : 'multi_functional';
      const code = state.detail.projectCode ? String(state.detail.projectCode).replace(/\s+/g, '_') : 'project';
      const filename = `${typeName}_${code}_${state.detail.id || ''}.pdf`;
      const prep = await preparePdfSaveHandle(filename, { showToast });
      if (prep?.aborted) return;
      await downloadPdf(state.detail, { saveHandle: prep?.handle || null, filename });
    }

    async function downloadPdf(detail, options = {}) {
      try {
        const jsPDF = await ensureJsPdf();
        const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
        const fontName = await ensurePdfFont(doc);
        const margin = 48;
        const pageWidth = doc.internal.pageSize.getWidth();
        const usableWidth = pageWidth - margin * 2;
        const pageHeight = doc.internal.pageSize.getHeight();
        const lineHeight = 16;
        let cursorY = margin;

        const hexToRgb = (hex) => {
          const normalized = (hex || '').replace('#', '');
          const bigint = parseInt(normalized, 16);
          if (Number.isNaN(bigint)) return { r: 0, g: 0, b: 0 };
          return {
            r: (bigint >> 16) & 0xff,
            g: (bigint >> 8) & 0xff,
            b: bigint & 0xff,
          };
        };

        const setTextColor = (hex) => {
          const { r, g, b } = hexToRgb(hex);
          doc.setTextColor(r, g, b);
        };

        const resetTextColor = () => setTextColor(PDF_COLORS.text);

        const ensureSpace = (height = 0) => {
          if (cursorY + height > pageHeight - margin) {
            doc.addPage();
            cursorY = margin;
            doc.setFont(fontName, 'normal');
            doc.setFontSize(12);
            resetTextColor();
          }
        };

        doc.setFont(fontName, 'normal');
        doc.setFontSize(12);
        resetTextColor();

        const typeName = state.projectType === 'multi-apartment' ? 'მრავალბინიანი' : 'მრავალფუნქციური';
        const userName = state.currentUser
          ? `${(state.currentUser.first_name || '').trim()} ${(state.currentUser.last_name || '').trim()}`.trim()
          : 'უცნობი';

        doc.setFont(fontName, 'bold');
        doc.setFontSize(18);
        doc.text(`${typeName} შეფასების შედეგი`, margin, cursorY);
        cursorY += lineHeight * 1.5;

        doc.setFontSize(12);
        doc.setFont(fontName, 'normal');

        const mins = Math.floor((detail.durationSeconds || 0) / 60);
        const secs = (detail.durationSeconds || 0) % 60;

        const infoLines = [
          `კანდიდატი: ${userName}`,
          `პროექტი: ${detail.projectName || detail.projectCode || '—'}`,
          `კოდი: ${detail.projectCode || '—'}`,
          `საერთო ქულა: ${Number(detail.percentage || 0).toFixed(2)}%`,
          `სწორი პასუხები: ${detail.correctCount || 0}`,
          `არასწორი პასუხები: ${detail.wrongCount || 0}`,
          `დაწყება: ${formatDateTime(detail.startedAt)}`,
          `დასრულება: ${detail.finishedAt ? formatDateTime(detail.finishedAt) : 'არ დასრულებულა'}`,
          `ხანგრძლივობა: ${mins} წთ ${secs} წმ`,
        ];

        const splitAndWrite = (text, { color = PDF_COLORS.text } = {}) => {
          setTextColor(color);
          const lines = doc.splitTextToSize(text, usableWidth);
          lines.forEach((line) => {
            if (cursorY > pageHeight - margin) {
              doc.addPage();
              cursorY = margin;
            }
            doc.text(line, margin, cursorY);
            cursorY += lineHeight;
          });
          resetTextColor();
        };

        infoLines.forEach((line) => splitAndWrite(line));
        cursorY += lineHeight;

        if (detail.answers?.length) {
          doc.setFont(fontName, 'bold');
          doc.text('პასუხების დეტალები', margin, cursorY);
          cursorY += lineHeight;
          doc.setFont(fontName, 'normal');

          detail.answers.forEach((answer, index) => {
            ensureSpace(lineHeight * 4);
            
            const markers = [];
            if (answer.isCorrect) markers.push('სწორი');
            if (answer.isSelected) markers.push('მონიშნული');
            const suffix = markers.length ? ` (${markers.join(', ')})` : '';
            
            let color = PDF_COLORS.text;
            if (answer.isSelected && answer.isCorrect) {
              color = PDF_COLORS.success;
            } else if (answer.isSelected && !answer.isCorrect) {
              color = PDF_COLORS.danger;
            }

            splitAndWrite(`${index + 1}. ${answer.text || '—'}${suffix}`, { color });
          });
        }

        const filename = options.filename || `project_result_${detail.id || ''}.pdf`;
        await deliverPdf(doc, filename, { showToast, handle: options.saveHandle || null });
      } catch {
        showToast('PDF ფაილის შექმნა ვერ მოხერხდა', 'error');
      }
    }

    function open(user, type) {
      state.currentUser = user || null;
      state.projectType = type;
      state.results = [];
      state.detail = null;
      setCandidateHeader(user, type);
      renderResultsList();
      openOverlay(DOM.projectResultsOverlay);
      void loadResults(user || {}, type);
    }

    function closeList() {
      closeDetail();
      closeOverlay(DOM.projectResultsOverlay);
      state.currentUser = null;
      state.projectType = null;
      state.results = [];
      renderResultsList();
    }

    function init() {
      on(DOM.projectResultsClose, 'click', closeList);
      DOM.projectResultsOverlay?.addEventListener('click', (event) => {
        if (event.target === DOM.projectResultsOverlay) closeList();
      });
      on(DOM.projectDetailClose, 'click', () => closeDetail());
      DOM.projectDetailOverlay?.addEventListener('click', (event) => {
        if (event.target === DOM.projectDetailOverlay) closeDetail();
      });
      on(DOM.projectDetailDownload, 'click', () => {
        void downloadCurrentPdf();
      });
    }

    return {
      open,
      openMultiApartment: (user) => open(user, 'multi-apartment'),
      openMultiFunctional: (user) => open(user, 'multi-functional'),
      close: closeList,
      init,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createProjectResultsModule = createProjectResultsModule;
})(window);


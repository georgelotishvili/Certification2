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
      warning: '#b45309',
      danger: '#c73631',
      cardBackground: '#f8fafc',
      cardBorder: '#d0d8ea',
    };

    function formatPercent(value) {
      const number = Number(value) || 0;
      return Number.isInteger(number) ? String(number) : number.toFixed(2);
    }

    function getPercentagePdfColor(percentage) {
      const pct = Number(percentage) || 0;
      if (pct >= 75) return PDF_COLORS.success;
      if (pct >= 70) return PDF_COLORS.warning;
      return PDF_COLORS.danger;
    }

    function getWrongCountPdfColor(wrongCount) {
      const wrong = Number(wrongCount) || 0;
      if (wrong <= 1) return PDF_COLORS.success;
      if (wrong === 2) return PDF_COLORS.warning;
      return PDF_COLORS.danger;
    }

    function getPracticalStatusMeta(percentage, wrongCount) {
      const pct = Number(percentage) || 0;
      const wrong = Number(wrongCount) || 0;
      const isRed = pct < 70 || wrong >= 3;
      const isYellow = !isRed && ((pct >= 70 && pct < 75) || wrong === 2);

      if (isRed) {
        return {
          level: 'red',
          className: 'is-red',
          tag: 'error',
          text: 'სამწუხაროდ, ამ ეტაპზე მინიმალური გამსვლელი ზღვარი ვერ გადაილახა. გისურვებთ წარმატებას შემდეგ მცდელობაზე!',
        };
      }
      if (isYellow) {
        return {
          level: 'yellow',
          className: 'is-yellow',
          tag: 'warning',
          text: 'გილოცავთ! თქვენ წარმატებით გადალახეთ A კატეგორიის დონე.',
        };
      }
      return {
        level: 'green',
        className: 'is-green',
        tag: 'success',
        text: 'გილოცავთ! თქვენ წარმატებით გადალახეთ B/C კატეგორიის დონე.',
      };
    }

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
      const practicalMeta = getPracticalStatusMeta(item.percentage, item.wrongCount);
      const scoreColor = practicalMeta.tag;

      const safeFinishedAt = escapeHtml(finishedAt);
      const safeScore = escapeHtml(score);
      const safeProjectName = escapeHtml(item.projectName || item.projectCode || 'პროექტი');
      
      card.innerHTML = `
        <div class="attempt-info">
          <div class="attempt-date">პროექტი: <strong>${safeProjectName}</strong></div>
          <div class="attempt-status">
            <span class="result-tag ${scoreColor}">${safeScore}%</span>
            <span>სწორი: ${item.correctCount || 0}/${item.totalCorrectAnswers || 0} • არასწორი: ${item.wrongCount || 0}</span>
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
        try {
          global.dispatchEvent(new CustomEvent('admin:examResultsChanged', { detail: { userId: state.currentUser?.id } }));
        } catch {}
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
      if (DOM.projectDetailStatusBanner) {
        DOM.projectDetailStatusBanner.hidden = true;
        DOM.projectDetailStatusBanner.textContent = '';
        DOM.projectDetailStatusBanner.className = 'admin-result-status-banner';
      }
      if (DOM.projectDetailSummary) DOM.projectDetailSummary.textContent = '';
      if (DOM.projectAnswerList) DOM.projectAnswerList.innerHTML = '';
    }

    function renderDetail(detail) {
      if (!detail) return;
      
      const practicalMeta = getPracticalStatusMeta(detail.percentage, detail.wrongCount);
      const scoreColor = practicalMeta.tag;

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
      if (DOM.projectDetailStatusBanner) {
        DOM.projectDetailStatusBanner.className = `admin-result-status-banner ${practicalMeta.className}`;
        DOM.projectDetailStatusBanner.textContent = practicalMeta.text;
        DOM.projectDetailStatusBanner.hidden = false;
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
        jsPdfLoader = loadExternalScript('../vendor/jspdf.umd.min.js').catch((error) => {
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

    async function downloadCurrentShortPdf() {
      if (!state.detail) return;
      const typeName = state.projectType === 'multi-apartment' ? 'stage2_multi_apartment' : 'stage3_multi_functional';
      const code = state.detail.projectCode ? String(state.detail.projectCode).replace(/\s+/g, '_') : 'project';
      const filename = `shedegis_cnoba_${typeName}_${code}_${state.detail.id || ''}.pdf`;
      const prep = await preparePdfSaveHandle(filename, { showToast });
      if (prep?.aborted) return;
      await downloadPdf(state.detail, {
        mode: 'short',
        projectType: state.projectType,
        user: state.currentUser,
        saveHandle: prep?.handle || null,
        filename,
      });
    }

    async function downloadCurrentPdf() {
      if (!state.detail) return;
      const typeName = state.projectType === 'multi-apartment' ? 'stage2_multi_apartment' : 'stage3_multi_functional';
      const code = state.detail.projectCode ? String(state.detail.projectCode).replace(/\s+/g, '_') : 'project';
      const filename = `sruli_angarishi_${typeName}_${code}_${state.detail.id || ''}.pdf`;
      const prep = await preparePdfSaveHandle(filename, { showToast });
      if (prep?.aborted) return;
      await downloadPdf(state.detail, {
        mode: 'detailed',
        projectType: state.projectType,
        user: state.currentUser,
        saveHandle: prep?.handle || null,
        filename,
      });
    }

    async function downloadPdf(detail, options = {}) {
      const isShort = options.mode === 'short';
      const activeProjectType = options.projectType || state.projectType || 'multi-apartment';
      const activeUser = options.user || state.currentUser || {};
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
          if (normalized.length === 3) {
            const r = (bigint >> 8) & 0xf;
            const g = (bigint >> 4) & 0xf;
            const b = bigint & 0xf;
            return {
              r: (r << 4) | r,
              g: (g << 4) | g,
              b: (b << 4) | b,
            };
          }
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

        const drawRule = () => {
          ensureSpace(12);
          const { r, g, b } = hexToRgb(PDF_COLORS.cardBorder);
          doc.setDrawColor(r, g, b);
          doc.setLineWidth(0.5);
          doc.line(margin, cursorY, pageWidth - margin, cursorY);
          cursorY += 12;
        };

        const writeDocumentTitle = (title, subtitle = '') => {
          doc.setFont(fontName, 'bold');
          doc.setFontSize(20);
          resetTextColor();
          doc.text(title, margin, cursorY);
          cursorY += 24;
          if (subtitle) {
            doc.setFont(fontName, 'normal');
            doc.setFontSize(11);
            setTextColor(PDF_COLORS.muted);
            doc.text(subtitle, margin, cursorY);
            cursorY += 18;
            resetTextColor();
          }
          drawRule();
        };

        const writeTextBlock = (text, {
          x = margin,
          width = usableWidth,
          color = PDF_COLORS.text,
          font = 'normal',
          size = 12,
          leading = lineHeight,
          spacingAfter = 0,
        } = {}) => {
          doc.setFont(fontName, font);
          doc.setFontSize(size);
          setTextColor(color);
          const lines = doc.splitTextToSize(String(text ?? '—'), width);
          lines.forEach((line) => {
            ensureSpace(leading);
            doc.text(line, x, cursorY);
            cursorY += leading;
          });
          cursorY += spacingAfter;
          resetTextColor();
          doc.setFont(fontName, 'normal');
          doc.setFontSize(12);
        };

        const writeSectionTitle = (text, level = 1) => {
          const size = level === 1 ? 15 : level === 2 ? 13 : 12;
          const spacing = level === 1 ? 8 : 4;
          ensureSpace(lineHeight * 2);
          writeTextBlock(text, {
            font: 'bold',
            size,
            leading: lineHeight + (level === 1 ? 2 : 0),
            spacingAfter: spacing,
          });
        };

        const measureInfoBox = (rows, width) => {
          const padding = 12;
          const labelWidth = 145;
          const valueWidth = width - padding * 2 - labelWidth - 10;
          let height = padding + 18;
          rows.forEach(([label, value]) => {
            const labelLines = doc.splitTextToSize(String(label ?? '—'), labelWidth);
            const valueLines = doc.splitTextToSize(String(value ?? '—'), valueWidth);
            height += Math.max(labelLines.length, valueLines.length) * 14 + 6;
          });
          return height + padding;
        };

        const drawInfoBox = (title, rows, x, y, width, height) => {
          const padding = 12;
          const labelWidth = 145;
          const valueWidth = width - padding * 2 - labelWidth - 10;
          const { r: fillR, g: fillG, b: fillB } = hexToRgb(PDF_COLORS.cardBackground);
          const { r: borderR, g: borderG, b: borderB } = hexToRgb(PDF_COLORS.cardBorder);
          doc.setFillColor(fillR, fillG, fillB);
          doc.setDrawColor(borderR, borderG, borderB);
          doc.setLineWidth(0.5);
          doc.rect(x, y, width, height, 'FD');

          let rowY = y + padding + 12;
          doc.setFont(fontName, 'bold');
          doc.setFontSize(12);
          resetTextColor();
          doc.text(title, x + padding, rowY);
          rowY += 18;

          rows.forEach(([label, value]) => {
            const labelLines = doc.splitTextToSize(String(label ?? '—'), labelWidth);
            const valueLines = doc.splitTextToSize(String(value ?? '—'), valueWidth);
            const rowHeight = Math.max(labelLines.length, valueLines.length) * 14 + 6;

            doc.setFont(fontName, 'bold');
            doc.setFontSize(9.5);
            setTextColor(PDF_COLORS.muted);
            labelLines.forEach((line, index) => {
              doc.text(line, x + padding, rowY + index * 14);
            });

            doc.setFont(fontName, 'normal');
            doc.setFontSize(10.5);
            resetTextColor();
            valueLines.forEach((line, index) => {
              doc.text(line, x + padding + labelWidth + 10, rowY + index * 14);
            });
            rowY += rowHeight;
          });
          resetTextColor();
        };

        const writeInfoColumns = (leftTitle, leftRows, rightTitle, rightRows) => {
          const gap = 14;
          const leftHeight = measureInfoBox(leftRows, usableWidth);
          const rightHeight = measureInfoBox(rightRows, usableWidth);
          ensureSpace(leftHeight + rightHeight + gap + 18);
          drawInfoBox(leftTitle, leftRows, margin, cursorY, usableWidth, leftHeight);
          cursorY += leftHeight + gap;
          drawInfoBox(rightTitle, rightRows, margin, cursorY, usableWidth, rightHeight);
          cursorY += rightHeight + 18;
        };

        const drawStatusBanner = (statusMetaInfo) => {
          const text = String(statusMetaInfo?.text || '');
          if (!text) return;
          const level = statusMetaInfo?.level || 'red';
          const palette = level === 'green'
            ? { fill: '#edf7ee', border: '#2e7d32', text: '#1b5e20' }
            : level === 'yellow'
              ? { fill: '#fffbeb', border: '#d97706', text: '#92400e' }
              : { fill: '#fef2f2', border: '#c73631', text: '#991b1b' };

          const paddingX = 14;
          const paddingY = 12;
          doc.setFont(fontName, 'bold');
          doc.setFontSize(11.5);
          const lines = doc.splitTextToSize(text, usableWidth - paddingX * 2);
          const boxHeight = Math.max(38, lines.length * 16 + paddingY * 2 - 4);
          ensureSpace(boxHeight + 16);

          const { r: fillR, g: fillG, b: fillB } = hexToRgb(palette.fill);
          const { r: borderR, g: borderG, b: borderB } = hexToRgb(palette.border);
          doc.setFillColor(fillR, fillG, fillB);
          doc.setDrawColor(borderR, borderG, borderB);
          doc.setLineWidth(1);
          doc.rect(margin, cursorY, usableWidth, boxHeight, 'FD');

          setTextColor(palette.text);
          lines.forEach((line, idx) => {
            doc.text(line, margin + paddingX, cursorY + paddingY + 10 + idx * 16);
          });
          resetTextColor();
          doc.setFont(fontName, 'normal');
          doc.setFontSize(12);
          cursorY += boxHeight + 16;
        };

        const writeKeyValueTable = (title, rows) => {
          writeSectionTitle(title, 2);
          const valueColWidth = 170;
          const nameWidth = usableWidth - valueColWidth;
          const rowPadding = 7;

          const drawRow = ({ label, value, color }, isHeader = false) => {
            const nameText = isHeader ? 'მაჩვენებელი' : String(label || '—');
            const valText = isHeader ? 'შედეგი' : String(value ?? '—');
            const valColor = isHeader ? PDF_COLORS.text : (color || PDF_COLORS.text);
            const nameLines = doc.splitTextToSize(nameText, nameWidth - rowPadding * 2);
            const rowHeight = Math.max(24, nameLines.length * 13 + rowPadding * 2);
            ensureSpace(rowHeight);

            const { r: borderR, g: borderG, b: borderB } = hexToRgb(PDF_COLORS.cardBorder);
            doc.setDrawColor(borderR, borderG, borderB);
            doc.setLineWidth(0.35);
            if (isHeader) {
              const { r: fillR, g: fillG, b: fillB } = hexToRgb(PDF_COLORS.cardBackground);
              doc.setFillColor(fillR, fillG, fillB);
              doc.rect(margin, cursorY, usableWidth, rowHeight, 'FD');
            } else {
              doc.line(margin, cursorY + rowHeight, margin + usableWidth, cursorY + rowHeight);
            }

            doc.setFont(fontName, isHeader ? 'bold' : 'normal');
            doc.setFontSize(isHeader ? 10.5 : 10);
            setTextColor(PDF_COLORS.text);
            nameLines.forEach((line, index) => {
              doc.text(line, margin + rowPadding, cursorY + rowPadding + 10 + index * 13);
            });
            doc.setFont(fontName, 'bold');
            setTextColor(valColor);
            doc.text(valText, margin + nameWidth + rowPadding, cursorY + rowPadding + 10);
            resetTextColor();
            doc.setFont(fontName, 'normal');
            cursorY += rowHeight;
          };

          drawRow({}, true);
          rows.forEach((row) => drawRow(row));
          cursorY += 24;
        };

        const addPageNumbers = () => {
          const totalPages = doc.getNumberOfPages();
          for (let page = 1; page <= totalPages; page += 1) {
            doc.setPage(page);
            doc.setFont(fontName, 'normal');
            doc.setFontSize(9);
            setTextColor(PDF_COLORS.muted);
            doc.text(`გვერდი ${page} / ${totalPages}`, pageWidth - margin, pageHeight - 24, { align: 'right' });
          }
          resetTextColor();
          doc.setPage(totalPages);
        };

        doc.setFont(fontName, 'normal');
        doc.setFontSize(12);
        resetTextColor();

        const isMultiApartment = activeProjectType === 'multi-apartment';
        const stageLabel = isMultiApartment
          ? 'II ეტაპი — მრავალბინიანი საცხოვრებელი სახლის პროექტის შეფასება'
          : 'III ეტაპი — მრავალფუნქციური შენობის პროექტის შეფასება';
        const shortStageName = isMultiApartment ? 'II ეტაპი — მრავალბინიანი' : 'III ეტაპი — მრავალფუნქციური';

        const userName = `${(activeUser.first_name || activeUser.firstName || '').trim()} ${(activeUser.last_name || activeUser.lastName || '').trim()}`.trim() || 'უცნობი';
        const personalId = activeUser.personal_id || activeUser.personalId || detail.personalId || '—';
        const candidateCode = activeUser.code || detail.candidateCode || '—';

        const mins = Math.floor((detail.durationSeconds || 0) / 60);
        const secs = (detail.durationSeconds || 0) % 60;
        const durationText = `${mins} წთ ${secs} წმ`;
        const practicalStatusMeta = getPracticalStatusMeta(detail.percentage, detail.wrongCount);

        if (isShort) {
          writeDocumentTitle('გამოცდის შედეგის ცნობა', stageLabel);
          writeInfoColumns(
            'კანდიდატი',
            [
              ['სახელი და გვარი', userName],
              ['პირადი №', personalId],
              ['კოდი', candidateCode],
            ],
            'გამოცდა',
            [
              ['ეტაპი', shortStageName],
              ['პროექტი', detail.projectName || detail.projectCode || '—'],
              ['დაწყება', formatDateTime(detail.startedAt)],
              ['დასრულება', detail.finishedAt ? formatDateTime(detail.finishedAt) : 'არ დასრულებულა'],
              ['ხანგრძლივობა', durationText],
            ]
          );
          drawStatusBanner(practicalStatusMeta);
          writeKeyValueTable('შედეგები', [
            {
              label: 'სწორი პასუხები',
              value: `${formatPercent(detail.percentage)}%`,
              color: getPercentagePdfColor(detail.percentage),
            },
            {
              label: 'არასწორი პასუხები',
              value: String(detail.wrongCount ?? 0),
              color: getWrongCountPdfColor(detail.wrongCount),
            },
          ]);
          addPageNumbers();
          const filename = options.filename || `shedegis_cnoba_project_${detail.id || ''}.pdf`;
          await deliverPdf(doc, filename, { showToast, handle: options.saveHandle || null });
          return;
        }

        writeDocumentTitle('პროექტის შეფასების დეტალური ანგარიში', `${stageLabel} (სააპელაციო / შიდა დოკუმენტი)`);
        writeInfoColumns(
          'კანდიდატი',
          [
            ['სახელი და გვარი', userName],
            ['პირადი №', personalId],
            ['კოდი', candidateCode],
          ],
          'გამოცდა',
          [
            ['ეტაპი', shortStageName],
            ['პროექტი', detail.projectName || detail.projectCode || '—'],
            ['პროექტის კოდი', detail.projectCode || '—'],
            ['დაწყება', formatDateTime(detail.startedAt)],
            ['დასრულება', detail.finishedAt ? formatDateTime(detail.finishedAt) : 'არ დასრულებულა'],
            ['ხანგრძლივობა', durationText],
            ['ანგარიში', formatDateTime(new Date().toISOString())],
          ]
        );
        drawStatusBanner(practicalStatusMeta);
        writeKeyValueTable('შედეგების სრული სტატისტიკა', [
          {
            label: 'სწორი პასუხები (%)',
            value: `${formatPercent(detail.percentage)}%`,
            color: getPercentagePdfColor(detail.percentage),
          },
          {
            label: 'სწორი პასუხების რაოდენობა',
            value: `${detail.correctCount || 0} / ${detail.totalCorrectAnswers || 0}`,
            color: getPercentagePdfColor(detail.percentage),
          },
          {
            label: 'არასწორი პასუხების რაოდენობა',
            value: String(detail.wrongCount ?? 0),
            color: getWrongCountPdfColor(detail.wrongCount),
          },
        ]);

        if (detail.answers?.length) {
          writeSectionTitle('პასუხების დეტალური ჩამონათვალი', 1);
          writeTextBlock('სავარაუდო პასუხებში მწვანედ მონიშნულია პროექტის სწორი პასუხი. თუ კანდიდატმა არასწორი პასუხი მონიშნა, ის წითლად არის ნაჩვენები.', {
            color: PDF_COLORS.muted,
            leading: 15,
            spacingAfter: 10,
          });

          detail.answers.forEach((answer, index) => {
            const markers = [];
            if (answer.isCorrect) markers.push('სწორი');
            if (answer.isSelected) markers.push('მონიშნული');
            const statusSuffix = markers.length ? markers.join(', ') : 'არ მონიშნული';
            const headerLine = `პასუხი № ${index + 1} (${statusSuffix})`;
            const textLines = doc.splitTextToSize(String(answer.text || '—'), usableWidth);
            const blockHeight = 14 + lineHeight + textLines.length * lineHeight + 8;
            ensureSpace(blockHeight);

            const { r: borderR, g: borderG, b: borderB } = hexToRgb(PDF_COLORS.cardBorder);
            doc.setDrawColor(borderR, borderG, borderB);
            doc.setLineWidth(0.4);
            doc.line(margin, cursorY, pageWidth - margin, cursorY);

            let textY = cursorY + 14;
            doc.setFont(fontName, 'bold');
            doc.setFontSize(10.5);
            let headerColor = PDF_COLORS.muted;
            let bodyColor = PDF_COLORS.text;
            if (answer.isCorrect) {
              headerColor = PDF_COLORS.success;
              bodyColor = PDF_COLORS.success;
            } else if (answer.isSelected && !answer.isCorrect) {
              headerColor = PDF_COLORS.danger;
              bodyColor = PDF_COLORS.danger;
            }
            setTextColor(headerColor);
            doc.text(headerLine, margin, textY);
            textY += lineHeight;

            doc.setFont(fontName, 'normal');
            doc.setFontSize(11);
            setTextColor(bodyColor);
            textLines.forEach((line) => {
              doc.text(line, margin, textY);
              textY += lineHeight;
            });
            resetTextColor();
            cursorY = textY + 6;
          });
        }

        addPageNumbers();
        const filename = options.filename || `sruli_angarishi_project_${detail.id || ''}.pdf`;
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
      on(DOM.projectDetailDownloadShort, 'click', () => {
        void downloadCurrentShortPdf();
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
      downloadPdf,
      fetchResultDetail,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createProjectResultsModule = createProjectResultsModule;
})(window);


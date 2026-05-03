(function (global) {
  function createResultsModule(context) {
    const {
      DOM,
      API_BASE,
      on,
      showToast,
      formatDateTime,
      formatDuration,
      arrayBufferToBase64,
      loadExternalScript,
      isFounderActor,
      getAdminHeaders,
      getActorEmail,
      getActorHeaders,
      openOverlay,
      closeOverlay,
      escapeHtml,
      deliverPdf = async () => false,
      preparePdfSaveHandle = async () => ({ handle: null, aborted: false }),
    } = context;

    const state = {
      currentUser: null,
      results: [],
      detail: null,
      loading: false,
      detailLoading: false,
    };

    const STATUS_MAP = {
      completed: { label: 'დასრულებულია', tag: 'success' },
      auto_closed: { label: 'ავტომატურად დახურული', tag: 'error' },
      aborted: { label: 'შეწყვეტილია', tag: 'error' },
      in_progress: { label: 'მიმდინარე', tag: 'neutral' },
    };


    const PDF_COLORS = {
      text: '#0f172a',
      muted: '#64748b',
      success: '#1f8a4d',
      danger: '#c73631',
      cardBackground: '#f8fafc',
      cardBorder: '#d0d8ea',
    };

    function statusMeta(status) {
      return STATUS_MAP[status] || { label: 'უცნობია', tag: 'neutral' };
    }


    function answerStatusMeta(answer) {
      if (!answer || answer.selected_option_id == null) {
        return { label: 'არ არის პასუხი', tag: 'neutral' };
      }
      return answer.is_correct ? { label: 'სწორია', tag: 'success' } : { label: 'არასწორია', tag: 'error' };
    }

    function buildOptionsList(answer) {
      const list = document.createElement('ul');
      list.className = 'result-question-options';
      const options = Array.isArray(answer?.options) ? answer.options : [];
      if (!options.length) {
        const item = document.createElement('li');
        item.className = 'result-question-option';
        const text = document.createElement('span');
        text.className = 'option-text';
        text.textContent = 'პასუხები ვერ მოიძებნა';
        item.appendChild(text);
        list.appendChild(item);
        return list;
      }

      options.forEach((option) => {
        const item = document.createElement('li');
        item.className = 'result-question-option';
        if (option.is_correct) item.classList.add('correct');
        if (option.is_selected) item.classList.add('selected');

        const text = document.createElement('span');
        text.className = 'option-text';
        text.textContent = option.option_text || '';
        item.appendChild(text);

      const statusWrap = document.createElement('div');
      statusWrap.className = 'option-status';
      if (option.is_selected) {
        const selectedBadge = document.createElement('span');
        selectedBadge.className = 'option-badge selected-badge';
        selectedBadge.textContent = 'მონიშნული';
        statusWrap.appendChild(selectedBadge);
      }
      if (option.is_correct) {
        const correctBadge = document.createElement('span');
        correctBadge.className = 'option-badge correct-badge';
        correctBadge.textContent = 'სწორი';
        statusWrap.appendChild(correctBadge);
      }
      if (statusWrap.children.length) {
        item.appendChild(statusWrap);
      }

        list.appendChild(item);
      });

      return list;
    }

    function createMetaItem(label, value, className = 'meta-item') {
      const item = document.createElement('span');
      item.className = className;
      const labelSpan = document.createElement('span');
      labelSpan.className = 'label';
      labelSpan.textContent = label;
      item.appendChild(labelSpan);
      const valueSpan = document.createElement('span');
      valueSpan.textContent = value;
      item.appendChild(valueSpan);
      return item;
    }

    function getSnapshot(detail) {
      return detail?.snapshot && typeof detail.snapshot === 'object' ? detail.snapshot : null;
    }

    function statNumber(stats, key) {
      return Number(stats?.[key] || 0);
    }

    function formatPercent(value) {
      const number = Number(value) || 0;
      return Number.isInteger(number) ? String(number) : number.toFixed(2);
    }

    function correctAnswerText(stats) {
      const total = statNumber(stats, 'total');
      const correct = statNumber(stats, 'correct');
      const percent = statNumber(stats, 'percent');
      return `სწორი პასუხები ${correct}/${total}. ${formatPercent(percent)}%`;
    }

    function statText(stats) {
      const total = statNumber(stats, 'total');
      const correct = statNumber(stats, 'correct');
      const incorrect = statNumber(stats, 'incorrect');
      const percent = formatPercent(statNumber(stats, 'percent'));
      return `სულ ${total} • სწორია ${correct} • არასწორია ${incorrect} • ${percent}%`;
    }

    function createStatLine(stats) {
      const line = document.createElement('div');
      line.className = 'result-stat-line';
      line.textContent = statText(stats);
      return line;
    }

    function createResultBoard(titleText) {
      const board = document.createElement('section');
      board.className = 'admin-result-board';
      const title = document.createElement('h4');
      title.className = 'admin-result-board-title';
      title.textContent = titleText;
      const list = document.createElement('div');
      list.className = 'admin-result-board-list';
      board.append(title, list);
      return { board, list };
    }

    function appendResultRow(list, label, stats) {
      const row = document.createElement('div');
      row.className = 'admin-result-board-row';

      const name = document.createElement('span');
      name.className = 'admin-result-board-name';
      name.textContent = label;

      const value = document.createElement('span');
      value.className = 'admin-result-board-value';
      value.textContent = correctAnswerText(stats || {});

      row.append(name, value);
      list.appendChild(row);
    }

    function appendOverallResultRow(list, stats) {
      const row = document.createElement('div');
      row.className = 'admin-result-board-row admin-result-board-row--single';
      row.textContent = correctAnswerText(stats || {});
      list.appendChild(row);
    }

    function appendEmptyResultRow(list, text) {
      const row = document.createElement('div');
      row.className = 'admin-result-board-row muted';
      row.textContent = text;
      list.appendChild(row);
    }

    function normalizeSnapshotAnswer(question, block) {
      const selected = question?.selected_option || null;
      const correct = question?.correct_option || null;
      return {
        question_id: question?.question_id ?? question?.id,
        question_code: question?.question_code ?? question?.code,
        question_text: question?.question_text ?? question?.text,
        block_id: block?.id,
        block_title: block?.title,
        selected_option_id: question?.selected_option_id ?? selected?.id ?? null,
        selected_option_text: selected?.text || null,
        correct_option_id: question?.correct_option_id ?? correct?.id ?? null,
        correct_option_text: correct?.text || null,
        is_correct: question?.is_correct,
        answered_at: question?.answered_at || null,
        options: (Array.isArray(question?.options) ? question.options : []).map((option) => ({
          option_id: option.option_id ?? option.id,
          option_text: option.option_text ?? option.text,
          is_correct: !!option.is_correct,
          is_selected: !!option.is_selected,
        })),
      };
    }

    function appendBlockQuestions(parent, block, counter) {
      const blockWrap = document.createElement('div');
      blockWrap.className = 'result-block-detail';
      const title = document.createElement('div');
      title.className = 'result-block-detail-title';
      title.textContent = block?.title || `ბლოკი ${block?.id || ''}`;
      blockWrap.appendChild(title);
      blockWrap.appendChild(createStatLine(block?.stats || {}));

      const questions = Array.isArray(block?.questions) ? block.questions : [];
      questions.forEach((question) => {
        const answer = normalizeSnapshotAnswer(question, block);
        const card = buildQuestionCard(answer, counter.value);
        counter.value += 1;
        blockWrap.appendChild(card);
      });
      parent.appendChild(blockWrap);
    }

    function renderSnapshotQuestions(snapshot) {
      if (!DOM.resultQuestionList) return;
      DOM.resultQuestionList.innerHTML = '';
      const counter = { value: 0 };
      const chapters = Array.isArray(snapshot?.chapters) ? snapshot.chapters : [];

      chapters.forEach((chapter) => {
        const chapterWrap = document.createElement('section');
        chapterWrap.className = 'result-hierarchy-section';
        const chapterTitle = document.createElement('div');
        chapterTitle.className = 'result-hierarchy-title';
        chapterTitle.textContent = chapter?.name || 'თავი';
        chapterWrap.appendChild(chapterTitle);
        chapterWrap.appendChild(createStatLine(chapter?.stats || {}));

        (chapter?.subchapters || []).forEach((subchapter) => {
          const subWrap = document.createElement('div');
          subWrap.className = 'result-subchapter-section';
          const subTitle = document.createElement('div');
          subTitle.className = 'result-subchapter-title';
          subTitle.textContent = subchapter?.name || 'ქვეთავი';
          subWrap.appendChild(subTitle);
          subWrap.appendChild(createStatLine(subchapter?.stats || {}));
          (subchapter?.blocks || []).forEach((block) => appendBlockQuestions(subWrap, block, counter));
          chapterWrap.appendChild(subWrap);
        });
        DOM.resultQuestionList.appendChild(chapterWrap);
      });

      const untaggedBlocks = Array.isArray(snapshot?.untagged_blocks) ? snapshot.untagged_blocks : [];
      if (untaggedBlocks.length) {
        const untaggedWrap = document.createElement('section');
        untaggedWrap.className = 'result-hierarchy-section';
        const title = document.createElement('div');
        title.className = 'result-hierarchy-title';
        title.textContent = 'მიუბმელი ბლოკები';
        untaggedWrap.appendChild(title);
        untaggedBlocks.forEach((block) => appendBlockQuestions(untaggedWrap, block, counter));
        DOM.resultQuestionList.appendChild(untaggedWrap);
      }

      if (counter.value === 0) {
        DOM.resultQuestionList.innerHTML = '<div class="empty-state">კითხვები არ არის ხელმისაწვდომი</div>';
      }
    }

    function renderSnapshotStats(snapshot) {
      if (!DOM.resultBlockStats) return;
      DOM.resultBlockStats.innerHTML = '';
      DOM.resultBlockStats.classList.add('result-summary-boards');
      const fragment = document.createDocumentFragment();
      const overallBoard = createResultBoard('საერთო შედეგი');
      appendOverallResultRow(overallBoard.list, snapshot?.summary || {});
      fragment.appendChild(overallBoard.board);

      const chapterBoard = createResultBoard('თავების შედეგები');
      const subchapterBoard = createResultBoard('ქვეთავების შედეგები');
      const chapters = Array.isArray(snapshot?.chapters) ? snapshot.chapters : [];

      chapters.forEach((chapter) => {
        appendResultRow(chapterBoard.list, chapter?.name || 'თავი', chapter?.stats || {});

        (chapter?.subchapters || []).forEach((subchapter) => {
          appendResultRow(subchapterBoard.list, subchapter?.name || 'ქვეთავი', subchapter?.stats || {});
        });
      });

      const untaggedBlocks = Array.isArray(snapshot?.untagged_blocks) ? snapshot.untagged_blocks : [];
      if (untaggedBlocks.length) {
        untaggedBlocks.forEach((block) => {
          appendResultRow(subchapterBoard.list, block?.title || `ბლოკი ${block?.id || ''}`, block?.stats || {});
        });
      }

      if (!chapterBoard.list.childNodes.length) {
        appendEmptyResultRow(chapterBoard.list, 'თავების შედეგები არ არის');
      }
      if (!subchapterBoard.list.childNodes.length) {
        appendEmptyResultRow(subchapterBoard.list, 'ქვეთავების შედეგები არ არის');
      }

      fragment.append(chapterBoard.board, subchapterBoard.board);
      DOM.resultBlockStats.appendChild(fragment);
    }

    function buildQuestionCard(answer, index) {
      const card = document.createElement('article');
      card.className = 'result-question-card';

      const statusData = answerStatusMeta(answer);

      const head = document.createElement('div');
      head.className = 'result-question-card-head';

      const headTop = document.createElement('div');
      headTop.className = 'result-question-card-head-top';

      const metaWrap = document.createElement('div');
      metaWrap.className = 'result-question-card-head-meta';
      metaWrap.appendChild(createMetaItem('ბლოკი', answer.block_title || '—'));
      metaWrap.appendChild(createMetaItem('კოდი', answer.question_code || '—'));
      metaWrap.appendChild(createMetaItem('კითხვა №', String(index + 1)));

      const statusTag = document.createElement('span');
      statusTag.className = `result-tag ${statusData.tag}`;
      statusTag.textContent = statusData.label;

      headTop.append(metaWrap, statusTag);
      head.appendChild(headTop);
      card.appendChild(head);

      const questionText = document.createElement('div');
      questionText.className = 'result-question-text';
      questionText.textContent = answer.question_text || '';
      card.appendChild(questionText);

      const optionsList = buildOptionsList(answer);
      card.appendChild(optionsList);

      return card;
    }

    function setCandidateHeader(user) {
      const first = (user?.first_name || user?.firstName || '').trim();
      const last = (user?.last_name || user?.lastName || '').trim();
      if (DOM.candidateResultsFullName) {
        const fullName = `${first} ${last}`.trim() || 'უცნობი კანდიდატი';
        DOM.candidateResultsFullName.textContent = fullName;
      }
      if (DOM.candidateResultsCode) {
        DOM.candidateResultsCode.textContent = user?.code ? `კოდი: ${user.code}` : '';
      }
      if (DOM.candidateResultsPersonalId) {
        DOM.candidateResultsPersonalId.textContent = user?.personal_id ? `პირადი №: ${user.personal_id}` : '';
      }
    }

    function renderResultsList() {
      if (!DOM.candidateResultsList) return;
      if (state.loading) {
        DOM.candidateResultsList.innerHTML = '<div class="empty-state">იტვირთება...</div>';
        return;
      }
      if (!state.results.length) {
        DOM.candidateResultsList.innerHTML = '<div class="empty-state">შედეგები არ მოიძებნა</div>';
        return;
      }
      const fragment = document.createDocumentFragment();
      state.results.forEach((item) => {
        const card = createAttemptCard(item);
        if (card) fragment.appendChild(card);
      });
      DOM.candidateResultsList.innerHTML = '';
      DOM.candidateResultsList.appendChild(fragment);
    }


    function createAttemptCard(item) {
      if (!item) return null;
      const card = document.createElement('div');
      card.className = 'attempt-card';
      card.setAttribute('role', 'listitem');
      const status = statusMeta(item.status);
      const startedAt = formatDateTime(item.started_at);
      const finishedAt = item.finished_at ? formatDateTime(item.finished_at) : 'არ დასრულებულა';
      const score = typeof item.score_percent === 'number' ? Number(item.score_percent).toFixed(1) : '0.0';

      const safeStartedAt = escapeHtml(startedAt);
      const safeFinishedAt = escapeHtml(finishedAt);
      const safeScore = escapeHtml(score);
      card.innerHTML = `
        <div class="attempt-info">
          <div class="attempt-date">დაწყება: <strong>${safeStartedAt}</strong></div>
          <div class="attempt-status">
            <span class="result-tag ${status.tag}">${status.label}</span>
            <span>${safeScore}%</span>
          </div>
          <div class="attempt-meta">დასრულება: ${safeFinishedAt}</div>
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
        viewBtn.addEventListener('click', () => handleView(item.session_id));
      }
      const deleteBtn = card.querySelector('[data-action="delete"]');
      if (deleteBtn) {
        deleteBtn.addEventListener('click', () => handleDelete(item.session_id));
      }
      return card;
    }

    async function loadResults(user) {
      state.loading = true;
      renderResultsList();
      try {
        const params = new URLSearchParams();
        if (user?.code) params.set('candidate_code', user.code);
        if (user?.personal_id) params.set('personal_id', user.personal_id);
        const response = await fetch(`${API_BASE}/admin/results?${params.toString()}`, {
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

    async function fetchResultDetail(sessionId) {
      const response = await fetch(`${API_BASE}/admin/results/${sessionId}`, {
        headers: { ...getAdminHeaders(), ...getActorHeaders() },
      });
      if (!response.ok) throw new Error('failed');
      return await response.json();
    }


    function renderDetailLoading() {
      if (DOM.resultDetailExamTitle) DOM.resultDetailExamTitle.textContent = 'იტვირთება...';
      if (DOM.resultDetailStatus) DOM.resultDetailStatus.innerHTML = '';
      if (DOM.resultDetailCandidate) DOM.resultDetailCandidate.textContent = '';
      if (DOM.resultDetailPersonalId) DOM.resultDetailPersonalId.textContent = '';
      if (DOM.resultDetailCode) DOM.resultDetailCode.textContent = '';
      if (DOM.resultDetailStartedAt) DOM.resultDetailStartedAt.textContent = '';
      if (DOM.resultDetailFinishedAt) DOM.resultDetailFinishedAt.textContent = '';
      if (DOM.resultDetailDuration) DOM.resultDetailDuration.textContent = '';
      if (DOM.resultDetailScore) DOM.resultDetailScore.textContent = '';
      if (DOM.resultDetailSummary) DOM.resultDetailSummary.textContent = '';
      if (DOM.resultBlockStats) {
        DOM.resultBlockStats.classList.remove('result-summary-boards');
        DOM.resultBlockStats.innerHTML = '';
      }
      if (DOM.resultQuestionList) DOM.resultQuestionList.innerHTML = '';
    }

    function renderDetail(detail) {
      if (!detail) return;
      const session = detail.session || {};
      const snapshot = getSnapshot(detail);
      const summary = snapshot?.summary || null;
      const status = statusMeta(session.status);

      if (DOM.resultDetailExamTitle) {
        DOM.resultDetailExamTitle.textContent = detail.exam_title || 'გამოცდა';
      }
      if (DOM.resultDetailStatus) {
        DOM.resultDetailStatus.innerHTML = `<span class="result-tag ${status.tag}">${status.label}</span>`;
      }
      const candidateName = `${(session.candidate_first_name || '').trim()} ${(session.candidate_last_name || '').trim()}`.trim();
      if (DOM.resultDetailCandidate) DOM.resultDetailCandidate.textContent = candidateName || 'უცნობი';
      if (DOM.resultDetailPersonalId) DOM.resultDetailPersonalId.textContent = session.personal_id || '—';
      if (DOM.resultDetailCode) DOM.resultDetailCode.textContent = session.candidate_code || '—';
      if (DOM.resultDetailStartedAt) DOM.resultDetailStartedAt.textContent = formatDateTime(session.started_at);
      const finishedAtText = session.finished_at ? formatDateTime(session.finished_at) : 'არ დასრულებულა';
      if (DOM.resultDetailFinishedAt) DOM.resultDetailFinishedAt.textContent = finishedAtText;
      const durationBase = session.finished_at || session.ends_at;
      if (DOM.resultDetailDuration) DOM.resultDetailDuration.textContent = formatDuration(session.started_at, durationBase);
      if (DOM.resultDetailScore) {
        const score = typeof session.score_percent === 'number' ? Number(session.score_percent).toFixed(2) : '0.00';
        DOM.resultDetailScore.textContent = `${score}%`;
      }
      if (DOM.resultDetailSummary) {
        const total = summary ? statNumber(summary, 'total') : Number(detail.total_questions || 0);
        const answered = summary ? statNumber(summary, 'answered') : Number(detail.answered_questions || 0);
        const correct = summary ? statNumber(summary, 'correct') : Number(detail.correct_answers || 0);
        const incorrect = summary ? statNumber(summary, 'incorrect') : Math.max(0, answered - correct);
        const legacySuffix = detail.legacy_message ? ` • ${detail.legacy_message}` : '';
        DOM.resultDetailSummary.textContent = `სულ: ${total} • პასუხი: ${answered} • სწორია: ${correct} • არასწორია: ${incorrect}${legacySuffix}`;
      }

      if (DOM.resultBlockStats) {
        if (snapshot) {
          renderSnapshotStats(snapshot);
        } else {
          DOM.resultBlockStats.classList.remove('result-summary-boards');
          const fragment = document.createDocumentFragment();
          (detail.block_stats || []).forEach((stat) => {
            if (!stat) return;
            const card = document.createElement('div');
            card.className = 'block-card-stat';
            const title = stat.block_title || `ბლოკი ${stat.block_id}`;
            const safeTitle = escapeHtml(title);
            const safeCorrect = escapeHtml(stat.correct ?? 0);
            const safeTotal = escapeHtml(stat.total ?? 0);
            const safePercent = escapeHtml(Number(stat.percent || 0).toFixed(2));
            card.innerHTML = `
              <div class="block-name">${safeTitle}</div>
              <div class="block-progress">
                <span>${safeCorrect}/${safeTotal}</span>
                <span>${safePercent}%</span>
              </div>
            `;
            fragment.appendChild(card);
          });
          DOM.resultBlockStats.innerHTML = '';
          DOM.resultBlockStats.appendChild(fragment);
        }
      }

      if (DOM.resultQuestionList) {
        if (snapshot) {
          renderSnapshotQuestions(snapshot);
        } else {
          DOM.resultQuestionList.innerHTML = '';
          (detail.answers || []).forEach((answer, index) => {
            if (!answer) return;
            const card = buildQuestionCard(answer, index);
            if (card) DOM.resultQuestionList.appendChild(card);
          });
        }
      }
    }


    function closeDetail() {
      closeOverlay(DOM.resultDetailOverlay);
      state.detail = null;
    }

    async function handleView(sessionId) {
      if (!sessionId) return;
      state.detailLoading = true;
      renderDetailLoading();
      openOverlay(DOM.resultDetailOverlay);
      try {
        const detail = await fetchResultDetail(sessionId);
        state.detail = detail;
        renderDetail(detail);
      } catch {
        showToast('დეტალური შედეგი ვერ ჩაიტვირთა', 'error');
        closeDetail();
      } finally {
        state.detailLoading = false;
      }
    }

    async function deleteResult(sessionId) {
      const response = await fetch(`${API_BASE}/admin/results/${sessionId}`, {
        method: 'DELETE',
        headers: { ...getAdminHeaders(), ...getActorHeaders() },
      });
      if (!response.ok) throw new Error('failed');
    }

    async function handleDelete(sessionId) {
      if (!sessionId || !isFounderActor()) return;
      const confirmed = global.confirm('ნამდვილად გსურთ შედეგის წაშლა? ქმედება შეუქცევადია.');
      if (!confirmed) return;
      try {
        await deleteResult(sessionId);
        state.results = state.results.filter((item) => item.session_id !== sessionId);
        renderResultsList();
        if (state.detail?.session?.session_id === sessionId) {
          closeDetail();
        }
        showToast('შედეგი წაიშალა');
      } catch {
        showToast('შედეგის წაშლა ვერ მოხერხდა', 'error');
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
      doc.addFont('DejaVuSans.ttf', fontName, 'italic');
      doc.addFont('DejaVuSans.ttf', fontName, 'bolditalic');
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
      const session = state.detail.session || {};
      const code = session.candidate_code ? String(session.candidate_code).replace(/\s+/g, '_') : 'result';
      const filename = `result_${code}_${session.session_id || ''}.pdf`;
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

        doc.setFont(fontName, 'normal');
        doc.setFontSize(12);
        resetTextColor();

        const session = detail.session || {};
        const status = statusMeta(session.status);
        const durationBase = session.finished_at || session.ends_at;

        const infoLines = [
          `კანდიდატი: ${(session.candidate_first_name || '')} ${(session.candidate_last_name || '')}`.trim(),
          `პირადი №: ${session.personal_id || '—'}`,
          `კოდი: ${session.candidate_code || '—'}`,
          `გამოცდა: ${detail.exam_title || '—'}`,
          `სტატუსი: ${status.label}`,
          `დაწყება: ${formatDateTime(session.started_at)}`,
          `დასრულება: ${session.finished_at ? formatDateTime(session.finished_at) : 'არ დასრულებულა'}`,
          `ხანგრძლივობა: ${formatDuration(session.started_at, durationBase)}`,
          `საერთო ქულა: ${typeof session.score_percent === 'number' ? Number(session.score_percent).toFixed(2) : '0.00'}%`,
          `კითხვები: სულ ${detail.total_questions}, პასუხი ${detail.answered_questions}, სწორია ${detail.correct_answers}`,
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

        const writeStatLine = (stats, { x = margin, width = usableWidth } = {}) => {
          const total = statNumber(stats, 'total');
          const correct = statNumber(stats, 'correct');
          const incorrect = statNumber(stats, 'incorrect');
          const percent = formatPercent(statNumber(stats, 'percent'));
          [
            `კითხვების რაოდენობა ${total}`,
            `სწორი პასუხი ${correct}`,
            `არასწორი პასუხი ${incorrect}`,
            `შედეგი ${percent}%`,
          ].forEach((line, index, rows) => {
            writeTextBlock(line, {
              x,
              width,
              color: PDF_COLORS.muted,
              font: 'normal',
              size: 10,
              leading: 13,
              spacingAfter: index === rows.length - 1 ? 8 : 0,
            });
          });
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

        const measureInfoBox = (rows, width) => {
          const padding = 12;
          const labelWidth = 82;
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
          const labelWidth = 82;
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
          const columnWidth = (usableWidth - gap) / 2;
          const leftHeight = measureInfoBox(leftRows, columnWidth);
          const rightHeight = measureInfoBox(rightRows, columnWidth);
          const boxHeight = Math.max(leftHeight, rightHeight);
          ensureSpace(boxHeight + 8);
          drawInfoBox(leftTitle, leftRows, margin, cursorY, columnWidth, boxHeight);
          drawInfoBox(rightTitle, rightRows, margin + columnWidth + gap, cursorY, columnWidth, boxHeight);
          cursorY += boxHeight + 18;
        };

        const writeResultTable = (title, rows) => {
          writeSectionTitle(title, 2);
          if (!rows.length) {
            writeTextBlock('მონაცემი არ არის', { color: PDF_COLORS.muted, leading: 14, spacingAfter: 6 });
            return;
          }

          const nameWidth = usableWidth - 156;
          const scoreWidth = 86;
          const percentWidth = 70;
          const rowPadding = 7;
          const drawRow = ({ label, stats }, isHeader = false) => {
            const name = isHeader ? 'დასახელება' : String(label || '—');
            const score = isHeader ? 'სწორი პასუხები' : `${statNumber(stats, 'correct')}/${statNumber(stats, 'total')}`;
            const percent = isHeader ? 'პროცენტი' : `${formatPercent(statNumber(stats, 'percent'))}%`;
            const nameLines = doc.splitTextToSize(name, nameWidth - rowPadding * 2);
            const rowHeight = Math.max(22, nameLines.length * 13 + rowPadding * 2);
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
            setTextColor(isHeader ? PDF_COLORS.text : PDF_COLORS.muted);
            nameLines.forEach((line, index) => {
              doc.text(line, margin + rowPadding, cursorY + rowPadding + 10 + index * 13);
            });
            doc.text(score, margin + nameWidth + rowPadding, cursorY + rowPadding + 10);
            doc.text(percent, margin + nameWidth + scoreWidth + rowPadding, cursorY + rowPadding + 10);
            resetTextColor();
            cursorY += rowHeight;
          };

          drawRow({}, true);
          rows.forEach((row) => drawRow(row));
          cursorY += 12;
        };

        const writeChapterHeader = (text) => {
          const topGap = cursorY > margin + 24 ? 22 : 8;
          const lines = doc.splitTextToSize(String(text || 'თავი'), usableWidth - 22);
          const height = Math.max(44, lines.length * 16 + 22);
          ensureSpace(topGap + height + 14);
          cursorY += topGap;

          const { r: fillR, g: fillG, b: fillB } = hexToRgb('#eef2f7');
          const { r: borderR, g: borderG, b: borderB } = hexToRgb(PDF_COLORS.cardBorder);
          doc.setFillColor(fillR, fillG, fillB);
          doc.setDrawColor(borderR, borderG, borderB);
          doc.setLineWidth(0.4);
          doc.rect(margin, cursorY, usableWidth, height, 'FD');

          doc.setFont(fontName, 'bold');
          doc.setFontSize(13);
          resetTextColor();
          lines.forEach((line, index) => {
            doc.text(line, margin + 12, cursorY + 27 + index * 16);
          });
          cursorY += height + 14;
          doc.setFont(fontName, 'normal');
          doc.setFontSize(12);
        };

        const writeSubchapterHeader = (text) => {
          writeTextBlock(`ქვეთავი: ${String(text || '—')}`, {
            x: margin + 10,
            width: usableWidth - 10,
            color: PDF_COLORS.text,
            font: 'normal',
            size: 11.5,
            leading: 14,
            spacingAfter: 4,
          });
        };

        const writeBlockHeader = (block) => {
          writeTextBlock(`დადგენილება: ${block?.title || block?.id || '—'}`, {
            x: margin + 20,
            width: usableWidth - 20,
            color: PDF_COLORS.text,
            font: 'normal',
            size: 10.5,
            leading: 13,
            spacingAfter: 2,
          });
          writeStatLine(block?.stats || {}, { x: margin + 20, width: usableWidth - 20 });
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

        const writeQuestionCardPdf = (question, block, index) => {
          const answer = normalizeSnapshotAnswer(question, block);
          const statusData = answerStatusMeta(answer);
          const options = Array.isArray(answer.options) ? answer.options : [];
          const sectionSpacing = 5;
          const optionGap = 3;
          const contentWidth = usableWidth;
          const blockLabel = answer.block_title || `ბლოკი ${answer.block_id || ''}`;
          const headerLine = `კითხვა № ${index + 1} — კოდი ${answer.question_code || '—'} • ${blockLabel}`;
          const headerLines = doc.splitTextToSize(headerLine, contentWidth);
          const questionLines = answer.question_text
            ? doc.splitTextToSize(`კითხვა: ${answer.question_text}`, contentWidth)
            : [];
          const footerLines = doc.splitTextToSize(
            `სტატუსი: ${statusData.label} • პასუხის დრო: ${answer.answered_at ? formatDateTime(answer.answered_at) : '—'}`,
            contentWidth
          );
          const optionBlocks = options.map((option, optionIndex) => {
            const markers = [];
            if (option.is_correct) markers.push('სწორი');
            if (option.is_selected) markers.push('მონიშნული');
            const suffix = markers.length ? ` (${markers.join(', ')})` : '';
            const text = `${optionIndex + 1}. ${option.option_text || '—'}${suffix}`;
            const lines = doc.splitTextToSize(text, contentWidth);
            let color = PDF_COLORS.text;
            if (option.is_correct) color = PDF_COLORS.success;
            else if (option.is_selected) color = PDF_COLORS.danger;
            return { lines, color };
          });

          let cardHeight = 14;
          cardHeight += headerLines.length * lineHeight;
          if (questionLines.length) cardHeight += sectionSpacing + questionLines.length * lineHeight;
          if (optionBlocks.length) {
            cardHeight += sectionSpacing;
            optionBlocks.forEach(({ lines }) => {
              cardHeight += lines.length * lineHeight;
            });
            cardHeight += optionGap * Math.max(optionBlocks.length - 1, 0);
          }
          cardHeight += sectionSpacing + footerLines.length * lineHeight;

          const maxCardHeight = pageHeight - margin * 2;
          if (cardHeight > maxCardHeight) {
            writeTextBlock(headerLine, { font: 'bold', leading: 15, spacingAfter: 4 });
            questionLines.forEach((line) => writeTextBlock(line, { leading: 15 }));
            optionBlocks.forEach(({ lines, color }) => {
              lines.forEach((line) => writeTextBlock(line, { color, leading: 15 }));
            });
            footerLines.forEach((line) => writeTextBlock(line, { color: PDF_COLORS.muted, leading: 14 }));
            cursorY += 8;
            return;
          }

          ensureSpace(cardHeight);
          const { r: borderR, g: borderG, b: borderB } = hexToRgb(PDF_COLORS.cardBorder);
          doc.setDrawColor(borderR, borderG, borderB);
          doc.setLineWidth(0.45);
          doc.line(margin, cursorY, pageWidth - margin, cursorY);

          const textX = margin;
          let textY = cursorY + 14;
          doc.setFont(fontName, 'bold');
          resetTextColor();
          headerLines.forEach((line) => {
            doc.text(line, textX, textY);
            textY += lineHeight;
          });
          doc.setFont(fontName, 'normal');
          if (questionLines.length) {
            textY += sectionSpacing;
            questionLines.forEach((line) => {
              doc.text(line, textX, textY);
              textY += lineHeight;
            });
          }
          if (optionBlocks.length) {
            textY += sectionSpacing;
            optionBlocks.forEach(({ lines, color }, optionIdx) => {
              setTextColor(color);
              lines.forEach((line) => {
                doc.text(line, textX, textY);
                textY += lineHeight;
              });
              if (optionIdx < optionBlocks.length - 1) textY += optionGap;
            });
            resetTextColor();
          }
          textY += sectionSpacing;
          setTextColor(PDF_COLORS.muted);
          footerLines.forEach((line) => {
            doc.text(line, textX, textY);
            textY += lineHeight;
          });
          resetTextColor();
          cursorY += cardHeight + 6;
        };

        const writeSnapshotPdf = (snapshot) => {
          const snapshotExam = snapshot?.exam || {};
          const snapshotSession = snapshot?.session || {};
          const candidate = snapshot?.candidate || {};
          const summary = snapshot?.summary || {};
          const candidateName = `${candidate.first_name || session.candidate_first_name || ''} ${candidate.last_name || session.candidate_last_name || ''}`.trim();
          const statusLabel = snapshot?.auto_closed ? 'ავტომატურად დახურული' : status.label;

          writeDocumentTitle('გამოცდის შედეგების ანგარიში', 'საგამოცდო შედეგების ოფიციალური ჩანაწერი');
          writeInfoColumns(
            'კანდიდატი',
            [
              ['სახელი და გვარი', candidateName || 'უცნობი'],
              ['პირადი №', candidate.personal_id || session.personal_id || '—'],
              ['კოდი', candidate.code || session.candidate_code || '—'],
            ],
            'გამოცდა',
            [
              ['გამოცდა', snapshotExam.title || detail.exam_title || '—'],
              ['სტატუსი', statusLabel],
              ['დაწყება', formatDateTime(snapshotSession.started_at || session.started_at)],
              ['დასრულება', formatDateTime(snapshotSession.finished_at || session.finished_at)],
              ['ხანგრძლივობა', formatDuration(snapshotSession.started_at || session.started_at, snapshotSession.finished_at || session.finished_at || session.ends_at)],
              ['ანგარიში', snapshot.generated_at ? formatDateTime(snapshot.generated_at) : formatDateTime(new Date().toISOString())],
            ]
          );

          if (snapshot?.auto_closed_no_submission) {
            writeTextBlock('შენიშვნა: სისტემამ გამოცდა ავტომატურად დახურა, რადგან შედეგები სერვერზე არ მოვიდა.', {
              color: PDF_COLORS.danger,
              font: 'bold',
              leading: 15,
            });
          }

          const chapters = Array.isArray(snapshot?.chapters) ? snapshot.chapters : [];
          const untaggedBlocks = Array.isArray(snapshot?.untagged_blocks) ? snapshot.untagged_blocks : [];
          const hasQuestions = (block) => Array.isArray(block?.questions) && block.questions.length > 0;
          const hasStatTotal = (item) => statNumber(item?.stats || {}, 'total') > 0;
          const resultChapters = chapters.filter(hasStatTotal);
          const resultUntaggedBlocks = untaggedBlocks.filter(hasStatTotal);

          doc.addPage();
          cursorY = margin;
          writeDocumentTitle('შედეგები');
          writeResultTable('საერთო შედეგი', [{ label: 'საერთო შედეგი', stats: summary }]);
          writeResultTable(
            'თავების შედეგები',
            resultChapters.map((chapter) => ({
              label: chapter?.name || 'თავი',
              stats: chapter?.stats || {},
            }))
          );
          const subchapterRows = [];
          resultChapters.forEach((chapter) => {
            (chapter?.subchapters || []).filter(hasStatTotal).forEach((subchapter) => {
              subchapterRows.push({
                label: `${chapter?.name || 'თავი'} / ${subchapter?.name || 'ქვეთავი'}`,
                stats: subchapter?.stats || {},
              });
            });
          });
          resultUntaggedBlocks.forEach((block) => {
            subchapterRows.push({
              label: block?.title || `ბლოკი ${block?.id || ''}`,
              stats: block?.stats || {},
            });
          });
          writeResultTable('ქვეთავების შედეგები', subchapterRows);

          doc.addPage();
          cursorY = margin;
          writeDocumentTitle('კითხვების დეტალური შედეგები');
          writeTextBlock('სავარაუდო პასუხებში მწვანედ მონიშნულია სწორი პასუხი. თუ კანდიდატმა არასწორი პასუხი მონიშნა, ის წითლად არის ნაჩვენები.', {
            color: PDF_COLORS.muted,
            leading: 15,
            spacingAfter: 8,
          });
          let questionIndex = 0;
          chapters.forEach((chapter) => {
            const subchapters = (chapter?.subchapters || []).filter((subchapter) => (
              (subchapter?.blocks || []).some(hasQuestions)
            ));
            if (!subchapters.length) return;
            writeChapterHeader(chapter?.name || 'თავი');
            subchapters.forEach((subchapter) => {
              const blocks = (subchapter?.blocks || []).filter(hasQuestions);
              writeSubchapterHeader(subchapter?.name || 'ქვეთავი');
              writeStatLine(subchapter?.stats || {}, { x: margin + 10, width: usableWidth - 10 });
              blocks.forEach((block) => {
                block.questions.forEach((question) => {
                  writeQuestionCardPdf(question, block, questionIndex);
                  questionIndex += 1;
                });
              });
            });
          });
          const detailedUntaggedBlocks = untaggedBlocks.filter(hasQuestions);
          if (detailedUntaggedBlocks.length) {
            writeChapterHeader('მიუბმელი ბლოკები');
            detailedUntaggedBlocks.forEach((block) => {
              writeBlockHeader(block);
              block.questions.forEach((question) => {
                writeQuestionCardPdf(question, block, questionIndex);
                questionIndex += 1;
              });
            });
          }
        };

        const snapshot = getSnapshot(detail);
        if (snapshot) {
          writeSnapshotPdf(snapshot);
          addPageNumbers();
          const filename = options.filename || (() => {
            const code = session.candidate_code ? session.candidate_code.replace(/\s+/g, '_') : 'result';
            return `result_${code}_${session.session_id || ''}.pdf`;
          })();
          await deliverPdf(doc, filename, { showToast, handle: options.saveHandle || null });
          return;
        }

        doc.setFont(fontName, 'bold');
        doc.setFontSize(18);
        doc.text('გამოცდის შედეგების ანგარიში', margin, cursorY);
        cursorY += lineHeight * 1.5;
        doc.setFontSize(12);
        doc.setFont(fontName, 'normal');

        infoLines.forEach((line) => splitAndWrite(line));
        cursorY += lineHeight / 2;

        if (detail.block_stats?.length) {
          if (cursorY > pageHeight - margin - lineHeight) {
            doc.addPage();
            cursorY = margin;
          }
          doc.setFont(fontName, 'bold');
          doc.text('ბლოკების შედეგები', margin, cursorY);
          cursorY += lineHeight;
          doc.setFont(fontName, 'normal');
          detail.block_stats.forEach((stat) => {
            const title = stat.block_title || `ბლოკი ${stat.block_id}`;
            splitAndWrite(`${title}: ${stat.correct}/${stat.total} (${Number(stat.percent || 0).toFixed(2)}%)`);
          });
          cursorY += lineHeight / 2;
        }

        if (detail.answers?.length) {
          if (cursorY > pageHeight - margin - lineHeight) {
            doc.addPage();
            cursorY = margin;
          }
          doc.setFont(fontName, 'bold');
          doc.text('კითხვების დეტალური შედეგები', margin, cursorY);
          cursorY += lineHeight;
          doc.setFont(fontName, 'normal');
          const cardPadding = 16;
          const sectionSpacing = lineHeight / 2;
          const optionGap = 6;
          const cardWidth = usableWidth;

          detail.answers.forEach((answer, index) => {
            const statusData = answerStatusMeta(answer);
            const options = Array.isArray(answer.options) ? answer.options : [];
            const contentWidth = cardWidth - cardPadding * 2;

            const blockLabelParts = [];
            if (answer.block_id != null) {
              blockLabelParts.push(`ბლოკი № ${answer.block_id}`);
            }
            if (answer.block_title) {
              blockLabelParts.push(answer.block_title);
            }
            const blockLabel = blockLabelParts.length ? blockLabelParts.join(' — ') : 'ბლოკი: უცნობი';
            const headerLine = `კითხვა № ${index + 1} — კოდი ${answer.question_code || '—'} • ${blockLabel}`;
            const headerLines = doc.splitTextToSize(headerLine, contentWidth);

            const questionLines = answer.question_text
              ? doc.splitTextToSize(`კითხვა: ${answer.question_text}`, contentWidth)
              : [];

            const footerLine = `სტატუსი: ${statusData.label} • პასუხის დრო: ${answer.answered_at ? formatDateTime(answer.answered_at) : '—'}`;
            const footerLines = doc.splitTextToSize(footerLine, contentWidth);

            const optionBlocks = options.map((option, optionIndex) => {
              const markers = [];
              if (option.is_correct) markers.push('სწორი');
              if (option.is_selected) markers.push('მონიშნული');
              const suffix = markers.length ? ` (${markers.join(', ')})` : '';
              const text = `${optionIndex + 1}. ${option.option_text || '—'}${suffix}`;
              const lines = doc.splitTextToSize(text, contentWidth);
              let color = PDF_COLORS.text;
              if (option.is_correct) {
                color = PDF_COLORS.success;
              } else if (option.is_selected && !option.is_correct) {
                color = PDF_COLORS.danger;
              }
              return { lines, color };
            });

            let cardHeight = cardPadding * 2;
            cardHeight += headerLines.length * lineHeight;
            if (questionLines.length) {
              cardHeight += sectionSpacing + questionLines.length * lineHeight;
            }
            if (optionBlocks.length) {
              cardHeight += sectionSpacing;
              optionBlocks.forEach(({ lines }) => {
                cardHeight += lines.length * lineHeight;
              });
              cardHeight += optionGap * Math.max(optionBlocks.length - 1, 0);
            }
            cardHeight += sectionSpacing + footerLines.length * lineHeight;

            ensureSpace(cardHeight);

            doc.setFillColor(248, 250, 252);
            const { r: borderR, g: borderG, b: borderB } = hexToRgb(PDF_COLORS.cardBorder);
            doc.setDrawColor(borderR, borderG, borderB);
            doc.setLineWidth(0.6);

            doc.rect(margin, cursorY, cardWidth, cardHeight, 'FD');

            let textX = margin + cardPadding;
            let textY = cursorY + cardPadding + lineHeight;

            doc.setFont(fontName, 'bold');
            resetTextColor();
            headerLines.forEach((line) => {
              doc.text(line, textX, textY);
              textY += lineHeight;
            });

            doc.setFont(fontName, 'normal');
            resetTextColor();
            if (questionLines.length) {
              textY += sectionSpacing;
              questionLines.forEach((line) => {
                doc.text(line, textX, textY);
                textY += lineHeight;
              });
            }

            if (optionBlocks.length) {
              textY += sectionSpacing;
              optionBlocks.forEach(({ lines, color }, optionIdx) => {
                setTextColor(color);
                lines.forEach((line) => {
                  doc.text(line, textX, textY);
                  textY += lineHeight;
                });
                if (optionIdx < optionBlocks.length - 1) {
                  textY += optionGap;
                }
              });
              resetTextColor();
            }

            textY += sectionSpacing;
            setTextColor(PDF_COLORS.muted);
            footerLines.forEach((line) => {
              doc.text(line, textX, textY);
              textY += lineHeight;
            });
            resetTextColor();

            cursorY += cardHeight + lineHeight / 2;
          });
        }

        const filename = options.filename || (() => {
          const code = session.candidate_code ? session.candidate_code.replace(/\s+/g, '_') : 'result';
          return `result_${code}_${session.session_id || ''}.pdf`;
        })();
        addPageNumbers();
        await deliverPdf(doc, filename, { showToast, handle: options.saveHandle || null });
      } catch {
        showToast('PDF ფაილის შექმნა ვერ მოხერხდა', 'error');
      }
    }

    function open(user) {
      state.currentUser = user || null;
      state.results = [];
      state.detail = null;
      setCandidateHeader(user);
      renderResultsList();
      openOverlay(DOM.candidateResultsOverlay);
      void loadResults(user || {});
    }

    function closeList() {
      closeDetail();
      closeOverlay(DOM.candidateResultsOverlay);
      state.currentUser = null;
      state.results = [];
      renderResultsList();
    }

    function init() {
      on(DOM.candidateResultsClose, 'click', closeList);
      DOM.candidateResultsOverlay?.addEventListener('click', (event) => {
        if (event.target === DOM.candidateResultsOverlay) closeList();
      });
      on(DOM.resultDetailClose, 'click', () => closeDetail());
      DOM.resultDetailOverlay?.addEventListener('click', (event) => {
        if (event.target === DOM.resultDetailOverlay) closeDetail();
      });
      on(DOM.resultDetailDownload, 'click', () => {
        void downloadCurrentPdf();
      });
    }

    return {
      open,
      close: closeList,
      init,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createResultsModule = createResultsModule;
})(window);



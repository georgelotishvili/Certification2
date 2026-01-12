(function (global) {
  function createBlocksModule(context) {
    const {
      DOM,
      API_BASE,
      on,
      escapeHtml,
      showToast,
      handleAdminErrorResponse,
      getAdminHeaders,
      getActorHeaders,
    } = context;

    const state = { data: [], examId: 1, saveTimer: null, pendingNotify: false };

    const generateId = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const createDefaultAnswers = () => Array.from({ length: 4 }, () => ({ id: generateId(), text: '' }));
    const generateQuestionCode = () => String(Math.floor(10000 + Math.random() * 90000));

    async function fetchBlocksFromServer() {
      const response = await fetch(`${API_BASE}/admin/exam/blocks`, {
        headers: { ...getAdminHeaders(), ...getActorHeaders() },
      });
      if (!response.ok) {
        await handleAdminErrorResponse(response, 'ბლოკების ჩატვირთვა ვერ მოხერხდა', showToast);
        throw new Error('handled');
      }
      return await response.json();
    }

    function migrate(data) {
      return (Array.isArray(data) ? data : []).map((block, blockIndex) => {
        if (!block || typeof block !== 'object') return block;
        const blockId = block?.id != null ? String(block.id) : generateId();
        const questions = Array.isArray(block.questions) ? block.questions : [];
        const migratedQuestions = questions.map((question, questionIndex) => {
          if (!question || typeof question !== 'object') {
            return {
              id: generateId(),
              text: String(question || ''),
              answers: createDefaultAnswers(),
              correctAnswerId: null,
              code: generateQuestionCode(),
            };
          }
          let answers = Array.isArray(question.answers) ? question.answers : [];
          answers = answers.map((answer) => {
            if (!answer || typeof answer !== 'object') {
              return { id: generateId(), text: String(answer || '') };
            }
            return {
              ...answer,
              id: answer.id != null ? String(answer.id) : generateId(),
              text: String(answer.text || ''),
            };
          });
          while (answers.length < 4) answers.push({ id: generateId(), text: '' });
          if (answers.length > 4) answers = answers.slice(0, 4);
          const fallback = answers[0] ? answers[0].id : null;
          let correctId = question.correctAnswerId != null ? String(question.correctAnswerId) : fallback;
          if (!answers.some((answer) => answer.id === correctId)) {
            correctId = fallback;
          }
          return {
            ...question,
            id: question.id != null ? String(question.id) : generateId(),
            text: String(question.text || ''),
            answers,
            correctAnswerId: correctId,
            code: question.code ? String(question.code) : generateQuestionCode(),
            enabled: typeof question.enabled === 'boolean' ? question.enabled : true,
          };
        });
        return {
          ...block,
          id: blockId,
          number: Number(block.number) || blockIndex + 1,
          qty: Number(block.qty) || 0,
          name: String(block.name || block.title || `ბლოკი ${blockIndex + 1}`),
          enabled: typeof block.enabled === 'boolean' ? block.enabled : true,
          questions: migratedQuestions,
        };
      });
    }

    function save(options = {}) {
      state.pendingNotify = state.pendingNotify || !!options.notify;
      clearTimeout(state.saveTimer);
      state.saveTimer = setTimeout(() => {
        state.saveTimer = null;
        void persistBlocks();
      }, 400);
    }

    function isEditorFocused() {
      const active = document.activeElement;
      if (!active || !DOM.blocksGrid) return false;
      if (!DOM.blocksGrid.contains(active)) return false;
      return active.tagName === 'TEXTAREA' || active.tagName === 'INPUT';
    }

    async function persistBlocks() {
      const payload = {
        examId: state.examId || 1,
        blocks: state.data,
      };
      try {
        const response = await fetch(`${API_BASE}/admin/exam/blocks`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAdminHeaders(), ...getActorHeaders() },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ბლოკების შენახვა ვერ მოხერხდა', showToast);
          return;
        }
        const data = await response.json();
        state.examId = data.examId || state.examId || 1;
        state.data = migrate(data.blocks);
        // Skip render() if user is actively editing to prevent focus loss
        if (!isEditorFocused()) {
          render();
        }
        updateStats();
        if (state.pendingNotify) showToast('ბლოკები შენახულია');
      } catch {
        showToast('ბლოკების შენახვა ვერ მოხერხდა', 'error');
      } finally {
        state.pendingNotify = false;
      }
    }

    async function loadInitialBlocks() {
      if (DOM.blocksGrid) {
        DOM.blocksGrid.innerHTML = '<div class="blocks-loading">იტვირთება...</div>';
      }
      try {
        const payload = await fetchBlocksFromServer();
        state.examId = payload.examId || state.examId || 1;
        state.data = migrate(payload.blocks);
      } catch (err) {
        if ((err?.message || '') !== 'handled') {
          showToast('ბლოკების ჩატვირთვა ვერ მოხერხდა', 'error');
          state.data = migrate([]);
        }
      }
      render();
      updateStats();
    }

    function nextNumber() {
      if (!state.data.length) return 1;
      const max = Math.max(...state.data.map((block) => Number(block.number) || 0));
      return (Number.isFinite(max) ? max : 0) + 1;
    }

    function updateStats() {
      if (!DOM.blocksCount || !DOM.questionsCount) return;
      const blocksCount = state.data.length;
      const questionsCount = state.data.reduce((sum, block) => {
        const available = Array.isArray(block?.questions) ? block.questions.length : 0;
        const qty = Math.max(0, Number(block?.qty) || 0);
        return sum + Math.min(qty, available);
      }, 0);
      DOM.blocksCount.textContent = String(blocksCount);
      DOM.questionsCount.textContent = String(questionsCount);
    }

    function setCardOpen(card, open) {
      if (!card) return;
      card.classList.toggle('open', !!open);
      const questions = card.querySelector('.block-questions');
      const toggle = card.querySelector('.head-toggle');
      if (questions) {
        questions.setAttribute('aria-hidden', open ? 'false' : 'true');
      }
      if (!open) {
        const textareas = card.querySelectorAll('.q-text, .a-text');
        textareas.forEach((textarea) => {
          try { textarea.style.height = ''; } catch {}
        });
      }
      if (toggle) {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? '▴' : '▾';
      }
    }

    function setQuestionOpen(questionCard, open) {
      if (!questionCard) return;
      questionCard.classList.toggle('open', !!open);
      const details = questionCard.querySelector('.q-details');
      const toggle = questionCard.querySelector('.q-toggle');
      if (details) {
        details.setAttribute('aria-hidden', open ? 'false' : 'true');
      }
      if (!open) {
        const textareas = questionCard.querySelectorAll('.q-text, .a-text');
        textareas.forEach((textarea) => {
          try { textarea.style.height = ''; } catch {}
        });
      }
      if (toggle) {
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? '▴' : '▾';
      }
    }

    function closeAllOpenQuestions(except) {
      const opened = DOM.blocksGrid?.querySelectorAll?.('.question-card.open') || [];
      opened.forEach((card) => {
        if (!except || card !== except) setQuestionOpen(card, false);
      });
    }

    function closeAllOpenBlocks(except) {
      const opened = DOM.blocksGrid?.querySelectorAll?.('.block-card.open') || [];
      opened.forEach((card) => {
        if (!except || card !== except) setCardOpen(card, false);
      });
    }

    function render() {
      if (!DOM.blocksGrid) return;
      const previouslyOpenBlocks = Array.from(DOM.blocksGrid.querySelectorAll('.block-card.open'))
        .map((card) => card.dataset.blockId)
        .filter(Boolean);
      const previouslyOpenQuestions = Array.from(DOM.blocksGrid.querySelectorAll('.question-card.open'))
        .map((card) => card.dataset.questionId)
        .filter(Boolean);

      DOM.blocksGrid.innerHTML = '';

      state.data.forEach((block, index) => {
        const card = document.createElement('div');
        card.className = 'block-tile block-card';
        card.dataset.blockId = block.id;
        const questions = Array.isArray(block.questions) ? block.questions : [];
        const atTop = index === 0;
        const atBottom = index === state.data.length - 1;
        card.innerHTML = `
          <div class="block-head exam-block-head">
            <div class="head-left">
              <div class="block-order">
                <button class="i-btn up" ${atTop ? 'disabled' : ''} aria-label="ზემოთ">▲</button>
                <button class="i-btn down" ${atBottom ? 'disabled' : ''} aria-label="ქვემოთ">▼</button>
              </div>
              <span class="head-label">ბლოკი</span>
              <input class="head-number" type="number" inputmode="numeric" min="1" step="1" value="${escapeHtml(block.number ?? '')}" aria-label="ბლოკის ნომერი" />
              <input class="head-name" type="text" placeholder="ბლოკის სახელი" value="${escapeHtml(block.name || '')}" aria-label="ბლოკის სახელი" />
            </div>
            <div class="head-right">
              <span class="head-qty-label">რაოდენობა</span>
              <input class="head-qty" type="number" inputmode="numeric" min="0" step="1" value="${escapeHtml(typeof block.qty === 'number' ? block.qty : '')}" aria-label="რაოდენობა" />
              <span class="head-count" title="კითხვების რაოდენობა">${escapeHtml(questions.length)}</span>
              <button class="head-import" type="button" aria-label="კითხვების იმპორტი" title="იმპორტი">⬆</button>
              <button class="head-toggle" type="button" aria-expanded="false">▾</button>
              <button class="head-delete" type="button" aria-label="ბლოკის წაშლა" title="წაშლა">×</button>
            </div>
          </div>
          <div class="block-questions" aria-hidden="true">
            <div class="questions-list">
              ${questions.map((question, qIndex, arr) => `
                <div class="question-card" data-question-id="${escapeHtml(question.id)}">
                  <div class="q-head">
                    <div class="q-order">
                      <button class="i-btn q-up" ${qIndex === 0 ? 'disabled' : ''} aria-label="ზემოთ">▲</button>
                      <button class="i-btn q-down" ${qIndex === arr.length - 1 ? 'disabled' : ''} aria-label="ქვემოთ">▼</button>
                    </div>
                    <textarea class="q-text" placeholder="კითხვა" rows="3" aria-label="კითხვა">${escapeHtml(question.text || '')}</textarea>
                    <div class="q-actions">
                      <div class="q-actions-row">
                        <button class="q-toggle" type="button" aria-expanded="false">▾</button>
                        <button class="q-delete" type="button" aria-label="კითხვის წაშლა" title="წაშლა">×</button>
                      </div>
                      <span class="q-code" aria-label="კითხვა კოდი">${escapeHtml(question.code)}</span>
                    </div>
                  </div>
                  <div class="q-details" aria-hidden="true">
                    <div class="q-answers">
                      ${(Array.isArray(question.answers) ? question.answers : []).map((answer, aIndex, answersArr) => `
                        <div class="answer-row" data-answer-id="${escapeHtml(answer.id)}">
                          <div class="a-order">
                            <button class="i-btn a-up" ${aIndex === 0 ? 'disabled' : ''} aria-label="ზემოთ">▲</button>
                            <button class="i-btn a-down" ${aIndex === answersArr.length - 1 ? 'disabled' : ''} aria-label="ქვემოთ">▼</button>
                          </div>
                          <textarea class="a-text" rows="2" placeholder="პასუხი ${aIndex + 1}" aria-label="პასუხი ${aIndex + 1}">${escapeHtml(answer.text || '')}</textarea>
                          <label class="a-correct-wrap" title="სწორი პასუხი">
                            <input class="a-correct" type="radio" name="correct-${escapeHtml(question.id)}" ${question.correctAnswerId === answer.id ? 'checked' : ''} />
                            <span>სწორია</span>
                          </label>
                        </div>
                      `).join('')}
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
            <div class="block-actions-row">
              <button class="block-tile add-tile q-add-tile" type="button" aria-label="კითხვის დამატება">
                <span class="add-icon" aria-hidden="true">+</span>
                <span class="add-text">კითხვის დამატება</span>
              </button>
              <button class="block-tile add-tile q-import-tile" type="button" aria-label="კითხვების იმპორტი">
                <span class="add-icon" aria-hidden="true">⬆</span>
                <span class="add-text">ტექსტიდან იმპორტი</span>
              </button>
            </div>
          </div>
        `;
        DOM.blocksGrid.appendChild(card);
        if (previouslyOpenBlocks.includes(block.id)) setCardOpen(card, true);
        card.querySelectorAll('.question-card').forEach((questionCard) => {
          if (previouslyOpenQuestions.includes(questionCard.dataset.questionId)) {
            setQuestionOpen(questionCard, true);
          }
        });
      });

      const addTile = document.createElement('button');
      addTile.type = 'button';
      addTile.id = 'addBlockTile';
      addTile.className = 'block-tile add-tile';
      addTile.setAttribute('aria-label', 'ბლოკის დამატება');
      addTile.innerHTML = '<span class="add-icon" aria-hidden="true">+</span><span class="add-text">ბლოკის დამატება</span>';
      DOM.blocksGrid.appendChild(addTile);

      updateStats();
    }

    function addBlock() {
      const id = generateId();
      state.data.push({ id, number: nextNumber(), name: '', qty: 0, questions: [] });
      save();
      render();
      const card = DOM.blocksGrid?.querySelector?.(`.block-card[data-block-id="${id}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function handleGridClick(event) {
      const target = event.target;
      if (!target) return;

      if (target.closest?.('#addBlockTile')) {
        addBlock();
        return;
      }

      const card = target.closest?.('.block-card');
      if (!card) return;
      const blockId = card.dataset.blockId;
      const blockIndex = state.data.findIndex((block) => block.id === blockId);
      if (blockIndex === -1) return;
      const block = state.data[blockIndex];
      block.questions = Array.isArray(block.questions) ? block.questions : [];

      if (target.classList.contains('up')) {
        if (blockIndex > 0) {
          [state.data[blockIndex - 1], state.data[blockIndex]] = [state.data[blockIndex], state.data[blockIndex - 1]];
          save();
          render();
        }
        return;
      }

      if (target.classList.contains('down')) {
        if (blockIndex < state.data.length - 1) {
          [state.data[blockIndex + 1], state.data[blockIndex]] = [state.data[blockIndex], state.data[blockIndex + 1]];
          save();
          render();
        }
        return;
      }

      if (target.classList.contains('head-delete')) {
        const confirmDelete = global.confirm('ნამდვილად გსურთ ბლოკის წაშლა? ბლოკის ყველა კითხვა წაიშლება.');
        if (!confirmDelete) return;
        state.data.splice(blockIndex, 1);
        save();
        render();
        return;
      }

      if (target.classList.contains('head-import')) {
        openImportModal(blockId);
        return;
      }

      const toggleBtn = target.closest?.('.head-toggle');
      if (toggleBtn) {
        const isOpen = card.classList.contains('open');
        if (!isOpen) {
          closeAllOpenBlocks(card);
          closeAllOpenQuestions();
        }
        setCardOpen(card, !isOpen);
        return;
      }

      if (target.closest?.('.q-add-tile')) {
        const questionId = generateId();
        block.questions.push({ id: questionId, text: '', answers: createDefaultAnswers(), correctAnswerId: null, code: generateQuestionCode() });
        save();
        render();
        const updatedCard = DOM.blocksGrid?.querySelector?.(`.block-card[data-block-id="${blockId}"]`);
        if (updatedCard) setCardOpen(updatedCard, true);
        return;
      }

      if (target.closest?.('.q-import-tile')) {
        openImportModal(blockId);
        return;
      }

      if (target.classList.contains('q-delete')) {
        const questionEl = target.closest?.('.question-card');
        const questionId = questionEl?.dataset.questionId;
        if (!questionId) return;
        const confirmDelete = global.confirm('ნამდვილად გსურთ ამ კითხვის წაშლა? ქმედება შეუქცევადია.');
        if (!confirmDelete) return;
        const questionIndex = block.questions.findIndex((question) => question.id === questionId);
        if (questionIndex !== -1) {
          block.questions.splice(questionIndex, 1);
          save();
          render();
        }
        return;
      }

      const questionCard = target.closest?.('.question-card');
      if (questionCard) {
        const questionId = questionCard.dataset.questionId;
        const questionIndex = block.questions.findIndex((question) => question.id === questionId);
        if (questionIndex === -1) return;
        const answers = Array.isArray(block.questions[questionIndex].answers) ? block.questions[questionIndex].answers : [];

        const answerRow = target.closest?.('.answer-row');
        if (answerRow) {
          const answerId = answerRow.dataset.answerId;
          const answerIndex = answers.findIndex((answer) => answer.id === answerId);
          if (answerIndex !== -1) {
            if (target.closest?.('.a-up')) {
              if (answerIndex > 0) {
                [answers[answerIndex - 1], answers[answerIndex]] = [answers[answerIndex], answers[answerIndex - 1]];
                block.questions[questionIndex].answers = answers;
                save();
                render();
              }
              return;
            }
            if (target.closest?.('.a-down')) {
              if (answerIndex < answers.length - 1) {
                [answers[answerIndex + 1], answers[answerIndex]] = [answers[answerIndex], answers[answerIndex + 1]];
                block.questions[questionIndex].answers = answers;
                save();
                render();
              }
              return;
            }
            if (target.classList.contains('a-correct') || target.closest?.('.a-correct')) {
              block.questions[questionIndex].correctAnswerId = answerId;
              save();
              return;
            }
          }
        }

        if (target.closest?.('.q-up')) {
          if (questionIndex > 0) {
            [block.questions[questionIndex - 1], block.questions[questionIndex]] = [block.questions[questionIndex], block.questions[questionIndex - 1]];
            save();
            render();
          }
          return;
        }

        if (target.closest?.('.q-down')) {
          if (questionIndex < block.questions.length - 1) {
            [block.questions[questionIndex + 1], block.questions[questionIndex]] = [block.questions[questionIndex], block.questions[questionIndex + 1]];
            save();
            render();
          }
          return;
        }

        if (target.closest?.('.q-toggle')) {
          const isOpen = questionCard.classList.contains('open');
          if (!isOpen) closeAllOpenQuestions(questionCard);
          setQuestionOpen(questionCard, !isOpen);
          return;
        }
      }

    }

    function handleGridKeydown(event) {
      if (event.key !== 'Enter') return;
      const target = event.target;
      if (!target) return;
      const card = target.closest?.('.block-card');
      if (!card) return;
      const blockId = card.dataset.blockId;
      const blockIndex = state.data.findIndex((block) => block.id === blockId);
      if (blockIndex === -1) return;
      const block = state.data[blockIndex];
      block.questions = Array.isArray(block.questions) ? block.questions : [];

      if (target.classList.contains('head-number')) {
        const value = parseInt(String(target.value || '').trim(), 10);
        if (!Number.isNaN(value) && value > 0) {
          block.number = value;
          save();
        }
        return;
      }

      if (target.classList.contains('head-name')) {
        block.name = String(target.value || '').trim();
        save();
        return;
      }

      if (target.classList.contains('head-qty')) {
        const value = parseInt(String(target.value || '').trim(), 10);
        block.qty = (!Number.isNaN(value) && value >= 0) ? value : 0;
        save();
        updateStats();
      }
    }

    function handleGridFocusout(event) {
      const target = event.target;
      if (!target) return;
      const card = target.closest?.('.block-card');
      if (!card) return;
      const blockId = card.dataset.blockId;
      const blockIndex = state.data.findIndex((block) => block.id === blockId);
      if (blockIndex === -1) return;
      const block = state.data[blockIndex];
      block.questions = Array.isArray(block.questions) ? block.questions : [];

      if (target.classList.contains('head-number')) {
        const value = parseInt(String(target.value || '').trim(), 10);
        if (!Number.isNaN(value) && value > 0) {
          block.number = value;
          save();
        }
        return;
      }

      if (target.classList.contains('head-name')) {
        block.name = String(target.value || '').trim();
        save();
        return;
      }

      if (target.classList.contains('head-qty')) {
        const value = parseInt(String(target.value || '').trim(), 10);
        block.qty = (!Number.isNaN(value) && value >= 0) ? value : 0;
        save();
        updateStats();
        return;
      }

      if (target.classList.contains('q-text')) {
        const questionCard = target.closest?.('.question-card');
        const questionId = questionCard?.dataset.questionId;
        if (!questionId) return;
        const questionIndex = block.questions.findIndex((question) => question.id === questionId);
        if (questionIndex === -1) return;
        block.questions[questionIndex].text = String(target.value || '').trim();
        save();
        return;
      }

      if (target.classList.contains('a-text')) {
        const questionCard = target.closest?.('.question-card');
        const questionId = questionCard?.dataset.questionId;
        const answerRow = target.closest?.('.answer-row');
        const answerId = answerRow?.dataset.answerId;
        if (!questionId || !answerId) return;
        const questionIndex = block.questions.findIndex((question) => question.id === questionId);
        if (questionIndex === -1) return;
        const answers = Array.isArray(block.questions[questionIndex].answers) ? block.questions[questionIndex].answers : [];
        const answerIndex = answers.findIndex((answer) => answer.id === answerId);
        if (answerIndex === -1) return;
        answers[answerIndex] = { ...answers[answerIndex], text: String(target.value || '').trim() };
        block.questions[questionIndex].answers = answers;
        save();
      }
    }

    // ========== კითხვების იმპორტი ==========
    
    let importTargetBlockId = null;
    
    const importOverlay = document.getElementById('questionsImportOverlay');
    const importTextarea = document.getElementById('questionsImportText');
    const importPreview = document.getElementById('questionsImportPreview');
    const importCount = document.getElementById('questionsImportCount');
    const importBlockName = document.getElementById('questionsImportBlockName');
    const importSubmitBtn = document.getElementById('questionsImportSubmit');
    const importCancelBtn = document.getElementById('questionsImportCancel');
    const importCloseBtn = document.getElementById('questionsImportClose');
    
    function parseQuestionsFromText(text) {
      const questions = [];
      // Split by "კითხვა:" to get each question block
      const parts = text.split(/კითხვა\s*:/i).filter(p => p.trim());
      
      for (const part of parts) {
        const lines = part.trim().split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length < 2) continue;
        
        // First line is the question text
        const questionText = lines[0];
        
        // Rest are answers
        const answers = [];
        let correctIndex = null;
        
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          // Check if it's an answer line
          if (line.startsWith('---')) {
            let answerText = line.replace(/^---\*?\s*/, '');
            const isCorrect = line.startsWith('---*');
            
            answers.push({
              id: generateId(),
              text: answerText
            });
            
            if (isCorrect) {
              correctIndex = answers.length - 1;
            }
          }
        }
        
        // Only add if we have question text and at least one answer
        if (questionText && answers.length > 0) {
          // Pad to 4 answers if needed
          while (answers.length < 4) {
            answers.push({ id: generateId(), text: '' });
          }
          
          // If no correct answer marked, default to first
          if (correctIndex === null) correctIndex = 0;
          
          questions.push({
            id: generateId(),
            code: generateQuestionCode(),
            text: questionText,
            answers: answers.slice(0, 4),
            correctAnswerId: answers[correctIndex]?.id || answers[0].id,
            enabled: true
          });
        }
      }
      
      return questions;
    }
    
    function renderImportPreview(questions) {
      if (!importPreview) return;
      
      if (questions.length === 0) {
        importPreview.innerHTML = '<div class="import-preview-empty">ჩასვით ტექსტი და დაინახავთ კითხვების პრევიუს</div>';
        if (importCount) importCount.textContent = '0 კითხვა';
        if (importSubmitBtn) importSubmitBtn.disabled = true;
        return;
      }
      
      const previewHtml = questions.slice(0, 5).map((q, i) => {
        const correctAnswer = q.answers.find(a => a.id === q.correctAnswerId);
        return `
          <div class="import-preview-item">
            <div class="import-preview-question">${i + 1}. ${escapeHtml(q.text)}</div>
            <div class="import-preview-answers">
              ${q.answers.map(a => `
                <span class="import-preview-answer ${a.id === q.correctAnswerId ? 'correct' : ''}">${escapeHtml(a.text || '(ცარიელი)')}</span>
              `).join('')}
            </div>
          </div>
        `;
      }).join('');
      
      const moreText = questions.length > 5 ? `<div class="import-preview-more">... და კიდევ ${questions.length - 5} კითხვა</div>` : '';
      
      importPreview.innerHTML = previewHtml + moreText;
      if (importCount) importCount.textContent = `${questions.length} კითხვა`;
      if (importSubmitBtn) importSubmitBtn.disabled = false;
    }
    
    function openImportModal(blockId) {
      importTargetBlockId = blockId;
      const block = state.data.find(b => b.id === blockId);
      
      if (importBlockName && block) {
        importBlockName.textContent = block.name || `ბლოკი ${block.number}`;
      }
      
      if (importTextarea) importTextarea.value = '';
      renderImportPreview([]);
      
      if (importOverlay) {
        importOverlay.setAttribute('aria-hidden', 'false');
        importOverlay.classList.add('open');
      }
    }
    
    function closeImportModal() {
      importTargetBlockId = null;
      if (importOverlay) {
        importOverlay.setAttribute('aria-hidden', 'true');
        importOverlay.classList.remove('open');
      }
    }
    
    function handleImportSubmit() {
      if (!importTargetBlockId || !importTextarea) return;
      
      const questions = parseQuestionsFromText(importTextarea.value);
      if (questions.length === 0) {
        showToast('კითხვები ვერ მოიძებნა', 'error');
        return;
      }
      
      const blockIndex = state.data.findIndex(b => b.id === importTargetBlockId);
      if (blockIndex === -1) {
        showToast('ბლოკი ვერ მოიძებნა', 'error');
        return;
      }
      
      // Add questions to the block
      const block = state.data[blockIndex];
      block.questions = Array.isArray(block.questions) ? block.questions : [];
      block.questions.push(...questions);
      
      save({ notify: true });
      render();
      closeImportModal();
      
      showToast(`${questions.length} კითხვა დაემატა`);
    }
    
    // Event listeners for import modal
    if (importTextarea) {
      importTextarea.addEventListener('input', () => {
        const questions = parseQuestionsFromText(importTextarea.value);
        renderImportPreview(questions);
      });
    }
    
    if (importSubmitBtn) {
      importSubmitBtn.addEventListener('click', handleImportSubmit);
    }
    
    if (importCancelBtn) {
      importCancelBtn.addEventListener('click', closeImportModal);
    }
    
    if (importCloseBtn) {
      importCloseBtn.addEventListener('click', closeImportModal);
    }
    
    if (importOverlay) {
      importOverlay.addEventListener('click', (e) => {
        if (e.target === importOverlay) closeImportModal();
      });
    }

    function init() {
      void loadInitialBlocks();
      on(DOM.blocksGrid, 'click', handleGridClick);
      on(DOM.blocksGrid, 'keydown', handleGridKeydown);
      on(DOM.blocksGrid, 'focusout', handleGridFocusout);
    }

    return {
      init,
      render: () => render(),
      reload: () => void loadInitialBlocks(),
      openImportModal,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createBlocksModule = createBlocksModule;
})(window);



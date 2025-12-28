// გამოცდის JavaScript ფაილი - Backend Integration

// Global state
const examState = {
    examId: 1, // default exam ID
    sessionId: null,
    sessionToken: null,
    durationMinutes: 45,
    examConfig: null,
    currentBlockIndex: 0,
    currentQuestionIndex: 0,
    blocks: [],
    questions: {},  // { blockId: [questions] }
    answers: {},    // { questionId: optionId }
    lockedBlocks: new Set(), // ჩაკეტილი ბლოკების სია
    timerInterval: null,
    remainingSeconds: 0,
    user: null, // user info from localStorage
    examPhase: 'gate', // 'gate', 'success', 'active', 'results'
    // Focus loss tracking
    focusWarningTimer: null,
    focusWarningCountdown: 10,
    isFocusWarningActive: false,
};

document.addEventListener('DOMContentLoaded', () => {
    // Fullscreen-ზე გადასვლა
    if (window.electronAPI) {
        window.electronAPI.setFullscreen();
    }
    
    // User info-ის ჩატვირთვა localStorage-დან
    loadUserInfo();
    
    // ვიდეოთვალის ჩართვა
    initializeCamera();
    
    // გამოცდის კონფიგურაციის ჩატვირთვა
    loadExamConfig();
    
    // ღილაკების event listeners
    setupEventListeners();
    
    // დაწყების ღილაკი გამორთული
    document.getElementById('start-button').disabled = true;
    
    // Gate password input-ზე focus
    setTimeout(() => {
        const gatePasswordInput = document.getElementById('gate-password');
        if (gatePasswordInput) {
            gatePasswordInput.focus();
        }
    }, 300);
});

// User info ჩატვირთვა localStorage-დან
function loadUserInfo() {
    try {
        const userStr = localStorage.getItem('current_user');
        if (userStr) {
            examState.user = JSON.parse(userStr);
            console.log('User loaded:', examState.user);
        } else {
            console.error('No user found in localStorage');
            alert('მომხმარებელი ვერ მოიძებნა. გთხოვთ გაიაროთ ავტორიზაცია.');
            setTimeout(() => {
                window.location.href = 'index.html';
            }, 2000);
        }
    } catch (error) {
        console.error('Error loading user info:', error);
    }
}

function setupEventListeners() {
    // Gate password verification
    document.getElementById('gate-verify-btn').addEventListener('click', verifyGatePassword);
    document.getElementById('gate-password').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') verifyGatePassword();
    });
    
    // Start exam
    const startButton = document.getElementById('start-button');
    if (startButton) {
        startButton.addEventListener('click', startExam);
    }
    
    // Finish exam
    const finishButton = document.getElementById('finish-button');
    if (finishButton) {
        finishButton.addEventListener('click', handleFinishButtonClick);
    }
    
    // Return home button (in results overlay)
    const returnHomeBtn = document.getElementById('return-home-btn');
    if (returnHomeBtn) {
        returnHomeBtn.addEventListener('click', () => {
            // Lockdown-ის გამორთვა
            disableExamLockdown();
            
            if (window.electronAPI) {
                window.electronAPI.exitFullscreen();
            }
            window.location.href = 'index.html';
        });
    }
    
    // Return to exam button (in warning overlay)
    const returnToExamBtn = document.getElementById('return-to-exam-btn');
    if (returnToExamBtn) {
        returnToExamBtn.addEventListener('click', () => {
            console.log('✓ User clicked return to exam');
            stopFocusWarningCountdown();
            // Focus back to window
            window.focus();
        });
    }
    
    // Navigation arrows
    const prevButton = document.querySelector('.prev-question');
    const nextButton = document.querySelector('.next-question');
    
    if (prevButton) {
        prevButton.addEventListener('click', () => navigateQuestion(-1));
    }
    
    if (nextButton) {
        nextButton.addEventListener('click', () => navigateQuestion(1));
    }
    
    // Navigation buttons (exam/documentation tabs)
    const navButtons = document.querySelectorAll('.nav-button');
    const documentationViewer = document.querySelector('.documentation-viewer');
    
    navButtons.forEach(button => {
        button.addEventListener('click', () => {
            navButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');
            
            const tabType = button.getAttribute('data-tab');
            if (tabType === 'exam') {
                documentationViewer.classList.remove('active');
            } else if (tabType === 'documentation') {
                documentationViewer.classList.add('active');
            }
        });
    });
    
    // კითხვების ინიციალიზაცია (checkboxes)
    initializeAnswerSelection();
}

// 1. გამოცდის კონფიგურაციის ჩატვირთვა
async function loadExamConfig() {
    try {
        const response = await fetch(`${window.API_CONFIG.baseURL}/exam/${examState.examId}/config`);
        if (!response.ok) throw new Error('Failed to load exam config');
        
        const config = await response.json();
        examState.examConfig = config;
        examState.durationMinutes = config.duration_minutes || config.durationMinutes || 45;
        examState.blocks = config.blocks || [];
        
        console.log('Exam config loaded:', config);
    } catch (error) {
        console.error('Error loading exam config:', error);
        alert('გამოცდის კონფიგურაცია ვერ ჩაიტვირთა');
    }
}

// 2. Gate Password Verification
async function verifyGatePassword() {
    const passwordInput = document.getElementById('gate-password');
    const password = passwordInput.value.trim();
    const errorDiv = document.getElementById('gate-error');
    
    if (!password) {
        showGateError('გთხოვთ შეიყვანოთ პაროლი');
        return;
    }
    
    try {
        const response = await fetch(`${window.API_CONFIG.baseURL}/exam/gate/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                exam_id: examState.examId,
                password: password
            })
        });
        
        if (!response.ok) throw new Error('Verification failed');
        
        const result = await response.json();
        
        if (result.valid) {
            // პაროლი სწორია - დავმალოთ gate overlay და ვაჩვენოთ success message
            document.getElementById('exam-gate-overlay').style.display = 'none';
            document.getElementById('success-overlay').style.display = 'flex';
            
            // დაწყების ღილაკი activated
            document.getElementById('start-button').disabled = false;
            
            // განვაახლოთ ეტაპი
            examState.examPhase = 'success';
            
            errorDiv.style.display = 'none';
        } else {
            showGateError('არასწორი პაროლი');
        }
    } catch (error) {
        console.error('Error verifying gate password:', error);
        showGateError('ვერიფიკაცია ვერ მოხერხდა');
    }
}

function showGateError(message) {
    const errorDiv = document.getElementById('gate-error');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
}

// 3. გამოცდის დაწყება (Session Start)
async function startExam() {
    if (!examState.user) {
        alert('მომხმარებელი ვერ მოიძებნა');
        return;
    }
    
    try {
        const response = await fetch(`${window.API_CONFIG.baseURL}/exam/session/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                exam_id: examState.examId,
                candidate_first_name: examState.user.first_name,
                candidate_last_name: examState.user.last_name,
                candidate_code: examState.user.code
            })
        });
        
        if (!response.ok) throw new Error('Failed to start session');
        
        const session = await response.json();
        examState.sessionId = session.session_id || session.sessionId;
        examState.sessionToken = session.token;
        examState.durationMinutes = session.duration_minutes || session.durationMinutes;
        
        // დავმალოთ success overlay
        document.getElementById('success-overlay').style.display = 'none';
        
        // განვაახლოთ ეტაპი - გამოცდა აქტიურია
        examState.examPhase = 'active';
        
        // ჩავრთოთ Exam Lockdown Mode
        enableExamLockdown();
        
        // ვიწყებთ გამოცდას
        await loadFirstBlock();
        startTimer();
        
        console.log('Session started:', session);
    } catch (error) {
        console.error('Error starting session:', error);
        alert('სესია ვერ დაიწყო');
    }
}

// 4. ბლოკის კითხვების ჩატვირთვა
async function loadBlockQuestions(blockIndex) {
    if (!examState.blocks[blockIndex]) {
        console.error('Block not found at index:', blockIndex);
        return;
    }
    
    const block = examState.blocks[blockIndex];
    const blockId = block.id;
    
    // თუ უკვე ჩატვირთულია ეს ბლოკი
    if (examState.questions[blockId]) {
        renderQuestion();
        return;
    }
    
    try {
        const response = await fetch(
            `${window.API_CONFIG.baseURL}/exam/${examState.sessionId}/questions?block_id=${blockId}`,
            {
                headers: {
                    'Authorization': `Bearer ${examState.sessionToken}`
                }
            }
        );
        
        if (!response.ok) throw new Error('Failed to load questions');
        
        const data = await response.json();
        examState.questions[blockId] = data.questions || [];
        
        console.log(`Block ${blockId} questions loaded:`, data.questions);
        
        renderQuestion();
    } catch (error) {
        console.error('Error loading questions:', error);
        alert('კითხვები ვერ ჩაიტვირთა');
    }
}

async function loadFirstBlock() {
    examState.currentBlockIndex = 0;
    examState.currentQuestionIndex = 0;
    await loadBlockQuestions(0);
}

// 5. კითხვის რენდერი
function renderQuestion() {
    const block = examState.blocks[examState.currentBlockIndex];
    if (!block) return;
    
    const blockId = block.id;
    const questions = examState.questions[blockId];
    if (!questions || questions.length === 0) return;
    
    const question = questions[examState.currentQuestionIndex];
    if (!question) return;
    
    // განახლება UI-ში
    // ბლოკის ნომერი
    document.querySelector('.block-number-field .field-value').textContent = examState.currentBlockIndex + 1;
    
    // ბლოკების ინფო (მიმდინარე/ჯამური)
    const totalBlocks = examState.blocks.length;
    const currentBlockNum = examState.currentBlockIndex + 1;
    document.querySelector('.block-count-field .count-value').textContent = `${currentBlockNum}/${totalBlocks}`;
    
    // კითხვის კოდი
    document.querySelector('.question-code-field .field-value').textContent = question.code || `Q-${question.id}`;
    
    // კითხვის ტექსტი
    document.querySelector('.question-text-wrapper p').textContent = question.text;
    
    // პასუხების რენდერი
    const answerElements = document.querySelectorAll('.answer-element');
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    const isBlockLocked = examState.lockedBlocks.has(blockId);
    
    question.options.forEach((option, index) => {
        if (answerElements[index]) {
            answerElements[index].querySelector('.answer-letter').textContent = letters[index];
            answerElements[index].querySelector('.answer-text-wrapper p').textContent = option.text;
            
            const checkbox = answerElements[index].querySelector('.answer-checkbox');
            checkbox.value = option.id;
            checkbox.checked = examState.answers[question.id] === option.id;
            checkbox.disabled = isBlockLocked; // ჩაკეტილ ბლოკში disabled
            
            // მოვხსნათ selected class
            if (checkbox.checked) {
                answerElements[index].classList.add('selected');
            } else {
                answerElements[index].classList.remove('selected');
            }
            
            answerElements[index].style.display = 'flex';
        }
    });
    
    // დავმალოთ ზედმეტი პასუხები
    for (let i = question.options.length; i < answerElements.length; i++) {
        answerElements[i].style.display = 'none';
    }
    
    updateQuestionDots();
    updateQuestionCounts();
}

// 6. პასუხის არჩევა
function initializeAnswerSelection() {
    const checkboxes = document.querySelectorAll('.answer-checkbox');
    const answerElements = document.querySelectorAll('.answer-element');
    
    checkboxes.forEach((checkbox, index) => {
        checkbox.addEventListener('change', function() {
            if (this.disabled) return; // თუ ჩაკეტილია, არ მუშაობს
            
            if (this.checked) {
                // გავუქმოთ ყველა სხვა ჩექბოქსი
                checkboxes.forEach((otherCheckbox, otherIndex) => {
                    if (otherCheckbox !== this) {
                        otherCheckbox.checked = false;
                        answerElements[otherIndex].classList.remove('selected');
                    }
                });
                
                answerElements[index].classList.add('selected');
                
                // შევინახოთ პასუხი
                const block = examState.blocks[examState.currentBlockIndex];
                const questions = examState.questions[block.id];
                const question = questions[examState.currentQuestionIndex];
                
                examState.answers[question.id] = parseInt(this.value);
                
                // გავაგზავნოთ backend-ზე
                submitAnswer(question.id, parseInt(this.value));
                
                updateQuestionDots();
                updateQuestionCounts();
            } else {
                answerElements[index].classList.remove('selected');
            }
        });
        
        // Click on answer-left
        const answerLeft = answerElements[index].querySelector('.answer-left');
        if (answerLeft) {
            answerLeft.addEventListener('click', function(e) {
                const checkbox = answerElements[index].querySelector('.answer-checkbox');
                if (e.target !== checkbox && !checkbox.disabled) {
                    checkbox.checked = !checkbox.checked;
                    checkbox.dispatchEvent(new Event('change'));
                }
            });
        }
    });
}

// 7. პასუხის გაგზავნა backend-ზე
async function submitAnswer(questionId, optionId) {
    try {
        const response = await fetch(
            `${window.API_CONFIG.baseURL}/exam/${examState.sessionId}/answer`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${examState.sessionToken}`
                },
                body: JSON.stringify({
                    question_id: questionId,
                    option_id: optionId
                })
            }
        );
        
        if (!response.ok) {
            const error = await response.json();
            console.error('Error submitting answer:', error);
        } else {
            const result = await response.json();
            console.log('Answer submitted:', result);
        }
    } catch (error) {
        console.error('Error submitting answer:', error);
    }
}

// 8. კითხვებზე ნავიგაცია
function navigateQuestion(direction) {
    const block = examState.blocks[examState.currentBlockIndex];
    const questions = examState.questions[block.id];
    
    if (!questions) return;
    
    const newIndex = examState.currentQuestionIndex + direction;
    
    if (newIndex >= 0 && newIndex < questions.length) {
        // იგივე ბლოკში ნავიგაცია
        examState.currentQuestionIndex = newIndex;
        renderQuestion();
    } else if (direction > 0 && examState.currentBlockIndex < examState.blocks.length - 1) {
        // შემდეგ ბლოკზე გადასვლის მცდელობა
        const currentBlock = examState.blocks[examState.currentBlockIndex];
        const currentQuestions = examState.questions[currentBlock.id];
        
        // შევამოწმოთ ყველა კითხვა პასუხგაცემულია თუ არა
        const allAnswered = currentQuestions.every(q => examState.answers[q.id]);
        
        if (!allAnswered) {
            alert('გთხოვთ უპასუხოთ ყველა კითხვას ამ ბლოკში');
            return;
        }
        
        // ჩავაკეტოთ მიმდინარე ბლოკი
        examState.lockedBlocks.add(currentBlock.id);
        
        // გადავიდეთ შემდეგ ბლოკზე
        examState.currentBlockIndex++;
        examState.currentQuestionIndex = 0;
        loadBlockQuestions(examState.currentBlockIndex);
    } else if (direction > 0 && examState.currentBlockIndex === examState.blocks.length - 1) {
        // ბოლო ბლოკზე ვართ და "შემდეგი" დააჭირა
        // შევამოწმოთ ყველა კითხვა პასუხგაცემულია თუ არა
        const currentBlock = examState.blocks[examState.currentBlockIndex];
        const currentQuestions = examState.questions[currentBlock.id];
        const allAnsweredInBlock = currentQuestions.every(q => examState.answers[q.id]);
        
        if (allAnsweredInBlock) {
            // ყველა კითხვას უპასუხა - ავტომატურად დასრულება
            finishExam();
        }
    } else if (direction < 0 && examState.currentBlockIndex > 0) {
        // წინა ბლოკზე გადასვლა
        examState.currentBlockIndex--;
        const prevBlock = examState.blocks[examState.currentBlockIndex];
        const prevQuestions = examState.questions[prevBlock.id];
        examState.currentQuestionIndex = prevQuestions ? prevQuestions.length - 1 : 0;
        renderQuestion();
    }
}

// 9. წერტილების განახლება
function updateQuestionDots() {
    const block = examState.blocks[examState.currentBlockIndex];
    if (!block) return;
    
    const questions = examState.questions[block.id];
    if (!questions) return;
    
    const dotsContainer = document.querySelector('.question-dots');
    dotsContainer.innerHTML = '';
    
    questions.forEach((question, index) => {
        const dot = document.createElement('span');
        dot.className = 'dot';
        
        // ლურჯი = პასუხგაცემული, თეთრი = გაუცემელი
        if (examState.answers[question.id]) {
            dot.classList.add('answered');
            dot.style.background = '#4a90e2'; // ლურჯი
        } else {
            dot.classList.add('unanswered');
            dot.style.background = '#ffffff'; // თეთრი
        }
        
        // მიმდინარე კითხვის წერტილი ანათებს
        if (index === examState.currentQuestionIndex) {
            dot.classList.add('active');
            dot.style.boxShadow = '0 0 10px rgba(74, 144, 226, 0.8)';
        }
        
        // წერტილზე click
        dot.addEventListener('click', () => {
            examState.currentQuestionIndex = index;
            renderQuestion();
        });
        
        dotsContainer.appendChild(dot);
    });
}

// 10. დროის ათვლა
function startTimer() {
    examState.remainingSeconds = examState.durationMinutes * 60;
    
    examState.timerInterval = setInterval(() => {
        examState.remainingSeconds--;
        
        if (examState.remainingSeconds <= 0) {
            clearInterval(examState.timerInterval);
            // დრო ამოიწურა - ავტომატური დასრულება
            finishExam();
            return;
        }
        
        updateTimerDisplay();
    }, 1000);
    
    updateTimerDisplay();
}

function updateTimerDisplay() {
    const hours = Math.floor(examState.remainingSeconds / 3600);
    const minutes = Math.floor((examState.remainingSeconds % 3600) / 60);
    const seconds = examState.remainingSeconds % 60;
    
    const display = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    document.querySelector('.timer-text').textContent = display;
}

// 11. კითხვების რაოდენობის განახლება
function updateQuestionCounts() {
    // მთლიანი რაოდენობა (ყველა ბლოკიდან)
    let totalQuestions = 0;
    examState.blocks.forEach(b => {
        const qs = examState.questions[b.id];
        if (qs) {
            totalQuestions += qs.length;
        }
    });
    
    // მიმდინარე კითხვის ნომერი (1-based)
    let currentQuestionNumber = 0;
    for (let i = 0; i < examState.currentBlockIndex; i++) {
        const b = examState.blocks[i];
        const qs = examState.questions[b.id];
        if (qs) {
            currentQuestionNumber += qs.length;
        }
    }
    currentQuestionNumber += examState.currentQuestionIndex + 1;
    
    document.querySelector('.question-count-field .count-value').textContent = `${currentQuestionNumber}/${totalQuestions}`;
}

// ვიდეოთვალის ინიციალიზაცია
async function initializeCamera() {
    const video = document.getElementById('camera-video');
    
    if (!video) {
        console.error('Video element not found');
        return;
    }
    
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        
        console.log('Available cameras:', videoDevices);
        
        let selectedCamera = null;
        
        for (const device of videoDevices) {
            const label = device.label.toLowerCase();
            if (!label.includes('iriun') && 
                !label.includes('virtual') && 
                !label.includes('obs') && 
                !label.includes('snap')) {
                selectedCamera = device;
                console.log('Selected camera:', device.label);
                break;
            }
        }
        
        if (!selectedCamera && videoDevices.length > 0) {
            selectedCamera = videoDevices[0];
            console.log('Using first available camera:', selectedCamera.label);
        }
        
        const constraints = {
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 }
            },
            audio: false
        };
        
        if (selectedCamera) {
            constraints.video.deviceId = { exact: selectedCamera.deviceId };
        }
        
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        video.srcObject = stream;
        console.log('Camera initialized successfully');
    } catch (error) {
        console.error('Error accessing camera:', error);
        const cameraArea = document.querySelector('.camera-area');
        if (cameraArea) {
            cameraArea.style.display = 'flex';
            cameraArea.style.justifyContent = 'center';
            cameraArea.style.alignItems = 'center';
            cameraArea.style.color = 'white';
            cameraArea.innerHTML = '<p>ვიდეოთვალი მიუწვდომელია</p>';
        }
    }
}

// 12. "დასრულება" ღილაკზე დაკლიკება
function handleFinishButtonClick() {
    // შევამოწმოთ რომელ ეტაპზეა გამოცდა
    
    if (examState.examPhase === 'gate' || examState.examPhase === 'success') {
        // გამოცდა ჯერ არ დაწყებულა - პირდაპირ თიშავს
        if (window.electronAPI) {
            window.electronAPI.exitFullscreen();
        }
        window.location.href = 'index.html';
        return;
    }
    
    if (examState.examPhase === 'results') {
        // შედეგები უკვე ნაჩვენებია - პირდაპირ მთავარ გვერდზე
        if (window.electronAPI) {
            window.electronAPI.exitFullscreen();
        }
        window.location.href = 'index.html';
        return;
    }
    
    if (examState.examPhase === 'active') {
        // გამოცდა მიმდინარეობს - გაფრთხილება და შედეგები
        
        // შევამოწმოთ არის თუ არა პასუხგაუცემელი კითხვები
        let totalQuestions = 0;
        let answeredQuestions = 0;
        
        examState.blocks.forEach(b => {
            const qs = examState.questions[b.id];
            if (qs) {
                totalQuestions += qs.length;
                answeredQuestions += qs.filter(q => examState.answers[q.id]).length;
            }
        });
        
        const unansweredCount = totalQuestions - answeredQuestions;
        
        if (unansweredCount > 0) {
            // Custom confirmation modal
            showConfirmation(() => {
                finishExam(); // დასრულება თუ დაადასტურა
            });
        } else {
            // თუ ყველა კითხვას უპასუხა, პირდაპირ დასრულება
            finishExam();
        }
    }
}

// 13. გამოცდის დასრულება
async function finishExam() {
    // ტაიმერის გაჩერება
    if (examState.timerInterval) {
        clearInterval(examState.timerInterval);
    }
    
    try {
        const response = await fetch(
            `${window.API_CONFIG.baseURL}/exam/${examState.sessionId}/finish`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${examState.sessionToken}`
                }
            }
        );
        
        if (!response.ok) throw new Error('Failed to finish exam');
        
        const results = await response.json();
        console.log('Exam finished:', results);
        
        // შედეგების ჩვენება
        showResults(results);
        
    } catch (error) {
        console.error('Error finishing exam:', error);
        alert('გამოცდის დასრულება ვერ მოხერხდა');
    }
}

// Exam Lockdown: keyboard shortcuts blocking
function blockKeyboardShortcuts(e) {
    // გამოცდის დროს დაბლოკილი კლავიშები
    const blockedKeys = [
        'F11',      // Fullscreen toggle
        'Escape',   // Fullscreen exit
        'F12',      // DevTools
        'F5',       // Refresh
    ];
    
    // დაბლოკილი კომბინაციები
    const blockedCombos = [
        { ctrl: true, key: 'w' },           // Close tab
        { ctrl: true, key: 'W' },           // Close tab
        { ctrl: true, key: 'r' },           // Refresh
        { ctrl: true, key: 'R' },           // Refresh
        { ctrl: true, shift: true, key: 'i' },  // DevTools
        { ctrl: true, shift: true, key: 'I' },  // DevTools
        { ctrl: true, shift: true, key: 'j' },  // DevTools
        { ctrl: true, shift: true, key: 'J' },  // DevTools
        { ctrl: true, shift: true, key: 'c' },  // DevTools
        { ctrl: true, shift: true, key: 'C' },  // DevTools
        { alt: true, key: 'F4' },           // Close window (ძალიან ძნელია დაბლოკვა)
    ];
    
    // შემოწმება
    if (blockedKeys.includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        console.log('Blocked key:', e.key);
        return false;
    }
    
    // კომბინაციების შემოწმება
    for (const combo of blockedCombos) {
        const ctrlMatch = combo.ctrl ? e.ctrlKey : true;
        const shiftMatch = combo.shift ? e.shiftKey : !e.shiftKey;
        const altMatch = combo.alt ? e.altKey : !e.altKey;
        const keyMatch = combo.key === e.key;
        
        if (ctrlMatch && shiftMatch && altMatch && keyMatch) {
            e.preventDefault();
            e.stopPropagation();
            console.log('Blocked combo:', combo);
            return false;
        }
    }
}

function enableExamLockdown() {
    console.log('🔒 Exam Lockdown Enabled');
    
    // Keyboard shortcuts-ის დაბლოკვა
    document.addEventListener('keydown', blockKeyboardShortcuts, true);
    
    // Right-click context menu-ს დაბლოკვა
    document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        return false;
    });
    
    // Focus loss detection
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    // Electron-ის lockdown (თუ არსებობს API)
    if (window.electronAPI && window.electronAPI.lockExam) {
        window.electronAPI.lockExam();
    }
}

function disableExamLockdown() {
    console.log('🔓 Exam Lockdown Disabled');
    
    // Keyboard shortcuts-ის განბლოკვა
    document.removeEventListener('keydown', blockKeyboardShortcuts, true);
    
    // Focus loss detection-ის მოხსნა
    window.removeEventListener('blur', handleWindowBlur);
    window.removeEventListener('focus', handleWindowFocus);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    
    // Countdown-ის გაწმენდა
    if (examState.focusWarningTimer) {
        clearInterval(examState.focusWarningTimer);
        examState.focusWarningTimer = null;
    }
    
    // Electron-ის unlock (თუ არსებობს API)
    if (window.electronAPI && window.electronAPI.unlockExam) {
        window.electronAPI.unlockExam();
    }
}

// Focus Loss Detection
function handleWindowBlur() {
    // მხოლოდ თუ გამოცდა აქტიურია
    if (examState.examPhase !== 'active') return;
    if (examState.isFocusWarningActive) return; // უკვე გამოჩნდა warning
    
    console.log('⚠️ Window lost focus - starting countdown');
    startFocusWarningCountdown();
}

function handleWindowFocus() {
    // როდესაც focus ბრუნდება, warning იმალება
    if (examState.isFocusWarningActive) {
        console.log('✓ Window regained focus - stopping countdown');
        stopFocusWarningCountdown();
    }
}

function handleVisibilityChange() {
    if (document.hidden && examState.examPhase === 'active') {
        // გვერდი უხილავი გახდა
        if (!examState.isFocusWarningActive) {
            console.log('⚠️ Page hidden - starting countdown');
            startFocusWarningCountdown();
        }
    } else if (!document.hidden && examState.isFocusWarningActive) {
        // გვერდი ხილული გახდა
        console.log('✓ Page visible - stopping countdown');
        stopFocusWarningCountdown();
    }
}

function startFocusWarningCountdown() {
    examState.isFocusWarningActive = true;
    examState.focusWarningCountdown = 10;
    
    // ვაჩვენოთ warning overlay
    const warningOverlay = document.getElementById('warning-overlay');
    if (warningOverlay) {
        warningOverlay.style.display = 'flex';
    }
    
    // განახლება countdown display
    updateCountdownDisplay();
    
    // countdown timer (ყოველ წამს)
    examState.focusWarningTimer = setInterval(() => {
        examState.focusWarningCountdown--;
        updateCountdownDisplay();
        
        if (examState.focusWarningCountdown <= 0) {
            // დრო ამოიწურა - გამოცდის დასრულება
            console.log('❌ Countdown expired - finishing exam');
            stopFocusWarningCountdown();
            finishExam();
        }
    }, 1000);
}

function stopFocusWarningCountdown() {
    examState.isFocusWarningActive = false;
    
    // გავაჩეროთ timer
    if (examState.focusWarningTimer) {
        clearInterval(examState.focusWarningTimer);
        examState.focusWarningTimer = null;
    }
    
    // დავმალოთ warning overlay
    const warningOverlay = document.getElementById('warning-overlay');
    if (warningOverlay) {
        warningOverlay.style.display = 'none';
    }
}

function updateCountdownDisplay() {
    const countdownEl = document.getElementById('countdown-number');
    if (countdownEl) {
        countdownEl.textContent = examState.focusWarningCountdown;
        
        // ფერის შეცვლა დროის მიხედვით
        if (examState.focusWarningCountdown <= 3) {
            countdownEl.style.color = '#ff0000'; // ძალიან წითელი
        } else if (examState.focusWarningCountdown <= 5) {
            countdownEl.style.color = '#ff4444'; // წითელი
        } else {
            countdownEl.style.color = '#ff6666'; // ღია წითელი
        }
    }
}

// Helper: Custom confirmation modal
function showConfirmation(onConfirm) {
    const overlay = document.getElementById('confirm-overlay');
    const cancelBtn = document.getElementById('confirm-cancel');
    const okBtn = document.getElementById('confirm-ok');
    
    // ვაჩვენოთ modal
    overlay.style.display = 'flex';
    
    // Cancel button
    const handleCancel = () => {
        overlay.style.display = 'none';
        cancelBtn.removeEventListener('click', handleCancel);
        okBtn.removeEventListener('click', handleOk);
    };
    
    // OK button
    const handleOk = () => {
        overlay.style.display = 'none';
        cancelBtn.removeEventListener('click', handleCancel);
        okBtn.removeEventListener('click', handleOk);
        onConfirm(); // callback ფუნქცია
    };
    
    cancelBtn.addEventListener('click', handleCancel);
    okBtn.addEventListener('click', handleOk);
}

// Helper: პროცენტის ფერის განსაზღვრა
function getPercentColor(percent) {
    if (percent < 70) {
        return '#ff4444'; // წითელი
    } else if (percent >= 70 && percent < 75) {
        return '#ffd700'; // ყვითელი
    } else {
        return '#4caf50'; // მწვანე (>= 75%)
    }
}

// 14. შედეგების ჩვენება
function showResults(results) {
    // გადავთვალოთ ჯამური კითხვები ყველა ბლოკიდან (არა მხოლოდ backend-დან)
    let totalQuestionsAll = 0;
    examState.blocks.forEach(block => {
        totalQuestionsAll += block.qty || 0;
    });
    
    // სწორი პასუხები block_stats-დან
    let correctAnswers = 0;
    if (results.block_stats && results.block_stats.length > 0) {
        results.block_stats.forEach(blockStat => {
            correctAnswers += blockStat.correct || 0;
        });
    }
    
    // საერთო პროცენტი
    const overallPercent = totalQuestionsAll > 0 
        ? ((correctAnswers / totalQuestionsAll) * 100).toFixed(2) 
        : 0;
    
    // საერთო შედეგი (თეთრი ფერით)
    const totalScoreEl = document.getElementById('total-score');
    totalScoreEl.textContent = `${overallPercent}%`;
    totalScoreEl.style.color = '#ffffff';
    
    const correctAnswersEl = document.getElementById('correct-answers');
    correctAnswersEl.textContent = `${correctAnswers}/${totalQuestionsAll}`;
    correctAnswersEl.style.color = '#ffffff';
    
    // ბლოკების შედეგები
    const blockResultsContainer = document.getElementById('block-results');
    blockResultsContainer.innerHTML = '';
    
    // block_stats-ის map შექმნა block_id-ს მიხედვით
    const blockStatsMap = {};
    if (results.block_stats && results.block_stats.length > 0) {
        results.block_stats.forEach(blockStat => {
            blockStatsMap[blockStat.block_id] = blockStat;
        });
    }
    
    // ყველა ბლოკის ჩვენება (examState.blocks-დან)
    examState.blocks.forEach((block, index) => {
        const blockDiv = document.createElement('div');
        blockDiv.className = 'block-result-item';
        
        const label = document.createElement('span');
        label.className = 'block-result-label';
        label.textContent = `ბლოკი ${index + 1}:`;
        
        const value = document.createElement('span');
        value.className = 'block-result-value';
        
        // შევამოწმოთ არის თუ არა ამ ბლოკის შედეგი
        let percent = 0;
        if (blockStatsMap[block.id]) {
            const blockStat = blockStatsMap[block.id];
            percent = blockStat.percent;
            value.innerHTML = `<span style="color: ${getPercentColor(percent)}">${percent}%</span> <span style="color: #ffffff">(${blockStat.correct}/${blockStat.total})</span>`;
        } else {
            // თუ არ არის block_stats-ში, ნიშნავს რომ არ შეუსვლია
            // ეს არის არასწორი პასუხები - 0 სწორი, qty ჯამური
            const totalQuestionsInBlock = block.qty || 0;
            percent = 0;
            value.innerHTML = `<span style="color: ${getPercentColor(percent)}">0%</span> <span style="color: #ffffff">(0/${totalQuestionsInBlock})</span>`;
        }
        
        blockDiv.appendChild(label);
        blockDiv.appendChild(value);
        blockResultsContainer.appendChild(blockDiv);
    });
    
    // განვაახლოთ ეტაპი - შედეგები ნაჩვენებია
    examState.examPhase = 'results';
    
    // ვაჩვენოთ results overlay
    document.getElementById('results-overlay').style.display = 'flex';
}

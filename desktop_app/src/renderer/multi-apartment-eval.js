// მრავალბინიანი პროექტის შეფასება - JavaScript

// ==========================================
// Global State
// ==========================================
const evalState = {
    // Session
    sessionId: null,
    sessionToken: null,
    
    // Settings
    durationMinutes: 45,
    settings: null,
    
    // Project
    project: null,
    projectId: null,
    
    // Answers
    selectedAnswerIds: [], // კანდიდატის მიერ მონიშნული პასუხები
    
    // Timer
    timerInterval: null,
    remainingSeconds: 0,
    
    // User
    user: null,
    
    // Phase: 'gate', 'success', 'active', 'results'
    evalPhase: 'gate',
    
    // Focus tracking
    focusWarningTimer: null,
    focusWarningCountdown: 10,
    isFocusWarningActive: false,
    
    // Screen recording
    mediaRecorder: null,
    recordedChunks: [],
    isRecording: false,
    screenStream: null,
    audioStream: null,
    
    // Regulations
    regulations: [],
    selectedRegulationId: null,
};

// ==========================================
// DOM Ready
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    console.log('Multi-apartment evaluation page loaded');
    
    // Fullscreen
    if (window.electronAPI) {
        window.electronAPI.setFullscreen();
    }
    
    // Load user info
    loadUserInfo();
    
    // Initialize camera
    initializeCamera();
    
    // Load settings
    loadEvalSettings();
    
    // Load regulations (for რეგულაციები tab)
    loadRegulations();
    
    // Setup event listeners
    setupEventListeners();
    
    // Start button disabled initially
    const startBtn = document.getElementById('start-button');
    if (startBtn) startBtn.disabled = true;
    
    // Focus on gate password
    setTimeout(() => {
        const gatePasswordInput = document.getElementById('gate-password');
        if (gatePasswordInput) gatePasswordInput.focus();
    }, 300);
});

// ==========================================
// User Info
// ==========================================
function loadUserInfo() {
    try {
        const userStr = localStorage.getItem('current_user');
        if (userStr) {
            evalState.user = JSON.parse(userStr);
            updateUserDisplay();
        }
    } catch (e) {
        console.error('Error loading user info:', e);
    }
}

function updateUserDisplay() {
    const user = evalState.user;
    if (!user) return;
    
    const nameEl = document.getElementById('candidate-name');
    const codeEl = document.getElementById('candidate-code');
    const dateEl = document.getElementById('eval-date');
    const timeEl = document.getElementById('eval-time');
    
    if (nameEl) nameEl.textContent = user.full_name || '---';
    if (codeEl) codeEl.textContent = user.personal_number || '---';
    
    const now = new Date();
    if (dateEl) {
        dateEl.textContent = now.toLocaleDateString('ka-GE');
    }
    if (timeEl) {
        timeEl.textContent = now.toLocaleTimeString('ka-GE', { hour: '2-digit', minute: '2-digit' });
    }
}

// ==========================================
// Settings
// ==========================================
async function loadEvalSettings() {
    try {
        // Public endpoint - არ აბრუნებს პაროლს
        const response = await fetch(`${window.API_CONFIG.baseURL}/public/multi-apartment/settings`);
        if (response.ok) {
            const settings = await response.json();
            evalState.settings = settings;
            evalState.durationMinutes = settings.duration_minutes || settings.durationMinutes || 45;
            
            const durationEl = document.getElementById('eval-duration');
            if (durationEl) {
                const minutes = evalState.durationMinutes;
                const hours = Math.floor(minutes / 60);
                const mins = minutes % 60;
                durationEl.textContent = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
            }
            
            console.log('Eval settings loaded:', settings);
        }
    } catch (e) {
        console.error('Error loading eval settings:', e);
    }
}

// ==========================================
// Camera
// ==========================================
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
        
        // ვირტუალური კამერების გამორიცხვა
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

// ==========================================
// Event Listeners
// ==========================================
function setupEventListeners() {
    // Gate verification
    const gateVerifyBtn = document.getElementById('gate-verify-btn');
    const gatePasswordInput = document.getElementById('gate-password');
    
    if (gateVerifyBtn) {
        gateVerifyBtn.addEventListener('click', verifyGatePassword);
    }
    
    if (gatePasswordInput) {
        gatePasswordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') verifyGatePassword();
        });
    }
    
    // Start/Finish buttons
    const startBtn = document.getElementById('start-button');
    const finishBtn = document.getElementById('finish-button');
    
    if (startBtn) {
        startBtn.addEventListener('click', startEvaluation);
    }
    
    if (finishBtn) {
        finishBtn.addEventListener('click', showFinishConfirmation);
    }
    
    // Tab navigation
    const navButtons = document.querySelectorAll('.nav-button');
    navButtons.forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    
    // Return to eval button (in warning modal)
    const returnBtn = document.getElementById('return-to-eval-btn');
    if (returnBtn) {
        returnBtn.addEventListener('click', () => {
            stopFocusWarningCountdown();
            window.focus();
        });
    }
    
    // Confirmation modal buttons
    const confirmCancel = document.getElementById('confirm-cancel');
    const confirmOk = document.getElementById('confirm-ok');
    
    if (confirmCancel) {
        confirmCancel.addEventListener('click', hideConfirmation);
    }
    
    if (confirmOk) {
        confirmOk.addEventListener('click', finishEvaluation);
    }
    
    // Return home button
    const returnHomeBtn = document.getElementById('return-home-btn');
    if (returnHomeBtn) {
        returnHomeBtn.addEventListener('click', async () => {
            // ჩაწერის შეჩერება
            await stopScreenRecording();
            
            // გამოვიდეთ fullscreen-დან
            if (window.electronAPI) {
                window.electronAPI.exitFullscreen();
            }
            window.location.href = 'index.html';
        });
    }
}

// ==========================================
// Gate Password
// ==========================================
async function verifyGatePassword() {
    const input = document.getElementById('gate-password');
    const errorEl = document.getElementById('gate-error');
    const password = input?.value?.trim();
    
    if (!password) {
        showGateError('შეიყვანეთ პაროლი');
        return;
    }
    
    try {
        // API-ით პაროლის შემოწმება
        const response = await fetch(`${window.API_CONFIG.baseURL}/public/multi-apartment/gate/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: password })
        });
        
        if (!response.ok) throw new Error('Verification failed');
        
        const result = await response.json();
        
        if (result.valid) {
            // პაროლი სწორია
            hideGateOverlay();
            showSuccessOverlay();
            document.getElementById('start-button').disabled = false;
            evalState.evalPhase = 'success';
            
            if (errorEl) errorEl.style.display = 'none';
        } else {
            showGateError('არასწორი პაროლი');
        }
    } catch (e) {
        console.error('Error verifying gate password:', e);
        showGateError('ვერიფიკაცია ვერ მოხერხდა');
    }
}

function showGateError(message) {
    const errorEl = document.getElementById('gate-error');
    if (errorEl) {
        errorEl.textContent = message;
        errorEl.style.display = 'block';
    }
}

function hideGateOverlay() {
    const overlay = document.getElementById('exam-gate-overlay');
    if (overlay) overlay.style.display = 'none';
}

function showSuccessOverlay() {
    const overlay = document.getElementById('success-overlay');
    if (overlay) overlay.style.display = 'flex';
}

// ==========================================
// Tab Navigation
// ==========================================
function switchTab(tabName) {
    // Update nav buttons
    const navButtons = document.querySelectorAll('.nav-button');
    navButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    
    // Hide all tabs
    document.getElementById('evaluation-tab').style.display = 'none';
    document.getElementById('answers-tab').style.display = 'none';
    document.getElementById('regulations-tab').style.display = 'none';
    
    // Show selected tab
    const tabEl = document.getElementById(`${tabName}-tab`);
    if (tabEl) tabEl.style.display = 'block';
}

// ==========================================
// Start Evaluation
// ==========================================
async function startEvaluation() {
    console.log('Starting evaluation...');
    
    // Hide success overlay
    const successOverlay = document.getElementById('success-overlay');
    if (successOverlay) successOverlay.style.display = 'none';
    
    // Start screen recording
    await startScreenRecording();
    
    // Load random project
    await loadRandomProject();
    
    // Start timer
    startTimer();
    
    // Enable focus tracking
    enableFocusTracking();
    
    // Update phase
    evalState.evalPhase = 'active';
    
    console.log('Evaluation started');
}

// ==========================================
// Project Loading
// ==========================================
async function loadRandomProject() {
    try {
        // Get auth headers for personalized project selection
        const headers = {};
        if (window.apiClient && window.apiClient.getAuthHeaders) {
            Object.assign(headers, window.apiClient.getAuthHeaders());
        }
        
        const response = await fetch(`${window.API_CONFIG.baseURL}/public/multi-apartment/projects/random`, {
            headers: headers
        });
        if (response.ok) {
            const project = await response.json();
            evalState.project = project;
            evalState.projectId = project.id;
            
            console.log('Loaded project:', project);
            
            displayProject(project);
            displayAnswers(project.answers || []);
        } else {
            console.error('Failed to load project:', response.status);
            showInfoMessage('პროექტი ვერ ჩაიტვირთა');
        }
    } catch (e) {
        console.error('Error loading project:', e);
        showInfoMessage('პროექტის ჩატვირთვა ვერ მოხერხდა');
    }
}

function displayProject(project) {
    // Update control panel - პროექტის სახელი და კოდი
    const nameEl = document.getElementById('project-name');
    const codeEl = document.getElementById('project-code');
    
    // პროექტის სახელი - ნომრიდან ან კოდიდან
    if (nameEl) {
        const projectName = project.number ? `პროექტი #${project.number}` : `პროექტი`;
        nameEl.textContent = projectName;
    }
    if (codeEl) codeEl.textContent = project.code || '---';
    
    // Display PDF
    const pdfViewer = document.querySelector('.project-pdf-viewer');
    if (pdfViewer) {
        if (project.pdfUrl) {
            // API-დან მოწოდებული URL (relative) + base URL
            // #navpanes=1 - ბუკმარკების პანელის ჩვენება
            // #view=FitH - გვერდის სიგანეზე მორგება
            const fullPdfUrl = `${window.API_CONFIG.baseURL}${project.pdfUrl}`;
            const pdfUrlWithParams = `${fullPdfUrl}#navpanes=1&view=FitH`;
            
            console.log('PDF URL:', pdfUrlWithParams);
            
            pdfViewer.innerHTML = `
                <iframe 
                    src="${pdfUrlWithParams}" 
                    class="pdf-iframe project-pdf-frame"
                    title="პროექტი - ${project.code || ''}"
                ></iframe>
            `;
        } else {
            pdfViewer.innerHTML = '<div class="pdf-empty">პროექტის PDF არ არის ატვირთული</div>';
        }
    }
}

// Info message (alert-ის ნაცვლად fullscreen-ში)
function showInfoMessage(message) {
    // TODO: გააკეთოს modal-ით, ჯერჯერობით console
    console.warn('INFO:', message);
}

function displayAnswers(answers) {
    const container = document.querySelector('.answers-container');
    if (!container) return;
    
    if (answers.length === 0) {
        container.innerHTML = '<div class="no-answers">პასუხები არ არის</div>';
        return;
    }
    
    container.innerHTML = answers.map((answer, index) => `
        <div class="answer-element" data-answer-id="${answer.id}">
            <div class="answer-left">
                <span class="answer-letter">${index + 1}</span>
                <input type="checkbox" class="answer-checkbox" data-answer-id="${answer.id}">
            </div>
            <div class="answer-right">
                <div class="answer-text-wrapper">
                    <p>${escapeHtml(answer.text || '')}</p>
                </div>
            </div>
        </div>
    `).join('');
    
    // Add click handlers for each answer element
    container.querySelectorAll('.answer-element').forEach(element => {
        const checkbox = element.querySelector('.answer-checkbox');
        const answerId = element.dataset.answerId;
        
        // Checkbox change handler
        checkbox.addEventListener('change', (e) => {
            toggleAnswer(answerId, e.target.checked, element);
        });
        
        // Click on element (not checkbox) toggles the checkbox
        element.addEventListener('click', (e) => {
            // თუ თვითონ checkbox-ზე დააკლიკა, არ გავაკეთოთ toggle
            if (e.target === checkbox) return;
            
            checkbox.checked = !checkbox.checked;
            toggleAnswer(answerId, checkbox.checked, element);
        });
    });
}

// პასუხის მონიშვნის toggle
function toggleAnswer(answerId, isChecked, element) {
    if (isChecked) {
        if (!evalState.selectedAnswerIds.includes(answerId)) {
            evalState.selectedAnswerIds.push(answerId);
        }
        element.classList.add('selected');
    } else {
        evalState.selectedAnswerIds = evalState.selectedAnswerIds.filter(id => id !== answerId);
        element.classList.remove('selected');
    }
    
    console.log('Selected answers:', evalState.selectedAnswerIds);
}

// ==========================================
// Timer
// ==========================================
function startTimer() {
    evalState.remainingSeconds = evalState.durationMinutes * 60;
    updateTimerDisplay();
    
    evalState.timerInterval = setInterval(() => {
        evalState.remainingSeconds--;
        updateTimerDisplay();
        
        if (evalState.remainingSeconds <= 0) {
            clearInterval(evalState.timerInterval);
            finishEvaluation();
        }
    }, 1000);
}

function updateTimerDisplay() {
    const timerEl = document.querySelector('.timer-text');
    if (!timerEl) return;
    
    const hours = Math.floor(evalState.remainingSeconds / 3600);
    const minutes = Math.floor((evalState.remainingSeconds % 3600) / 60);
    const seconds = evalState.remainingSeconds % 60;
    
    timerEl.textContent = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    
    // ფერი იგივეა რაც გამოცდაზე - თეთრი (CSS-დან)
}

// ==========================================
// Screen Recording
// ==========================================
async function startScreenRecording() {
    try {
        console.log('🎬 Starting screen recording...');
        
        // მივიღოთ ეკრანის წყაროები Electron-იდან
        const sources = await window.electronAPI.getScreenSources();
        
        if (!sources || sources.length === 0) {
            console.error('No screen sources available');
            showRecordingError();
            return false;
        }
        
        // პირველი ეკრანის არჩევა
        const screenSource = sources[0];
        console.log('Selected screen source:', screenSource.name);
        
        // ეკრანის stream მიღება
        const screenStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: screenSource.id,
                    minWidth: 1280,
                    maxWidth: 1920,
                    minHeight: 720,
                    maxHeight: 1080
                }
            }
        });
        
        evalState.screenStream = screenStream;
        
        // აუდიო stream მიღება (მიკროფონი)
        let audioStream = null;
        try {
            audioStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true
                },
                video: false
            });
            evalState.audioStream = audioStream;
            console.log('🎤 Microphone audio enabled');
        } catch (audioError) {
            console.warn('Could not get audio stream:', audioError);
        }
        
        // შევაერთოთ ვიდეო და აუდიო tracks
        const combinedTracks = [...screenStream.getTracks()];
        if (audioStream) {
            combinedTracks.push(...audioStream.getTracks());
        }
        
        const combinedStream = new MediaStream(combinedTracks);
        
        // MediaRecorder-ის შექმნა
        const mimeType = 'video/webm;codecs=vp9,opus';
        const fallbackMimeType = 'video/webm';
        
        const options = {
            mimeType: MediaRecorder.isTypeSupported(mimeType) ? mimeType : fallbackMimeType,
            videoBitsPerSecond: 2500000 // 2.5 Mbps
        };
        
        evalState.mediaRecorder = new MediaRecorder(combinedStream, options);
        evalState.recordedChunks = [];
        
        // მონაცემების მიღება
        evalState.mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                evalState.recordedChunks.push(event.data);
            }
        };
        
        // ჩაწერის დასრულება
        evalState.mediaRecorder.onstop = async () => {
            console.log('🎬 Recording stopped, saving file...');
            await saveRecordingToFile();
        };
        
        // ჩაწერის შეცდომა
        evalState.mediaRecorder.onerror = (error) => {
            console.error('MediaRecorder error:', error);
            evalState.isRecording = false;
            updateRecordingIndicator();
        };
        
        // ჩაწერის დაწყება (ყოველ 1 წამში მონაცემების მიღება)
        evalState.mediaRecorder.start(1000);
        evalState.isRecording = true;
        
        console.log('📹 Screen recording started successfully');
        updateRecordingIndicator();
        
        return true;
        
    } catch (error) {
        console.error('Error starting screen recording:', error);
        showRecordingError();
        return false;
    }
}

// ეკრანის ჩაწერის შეჩერება
function stopScreenRecording() {
    return new Promise((resolve) => {
        if (!evalState.mediaRecorder || evalState.mediaRecorder.state === 'inactive') {
            console.log('No active recording to stop');
            resolve();
            return;
        }
        
        console.log('🛑 Stopping screen recording...');
        
        evalState.mediaRecorder.onstop = async () => {
            await saveRecordingToFile();
            resolve();
        };
        
        evalState.mediaRecorder.stop();
        evalState.isRecording = false;
        updateRecordingIndicator();
        
        // გავაჩეროთ streams
        if (evalState.screenStream) {
            evalState.screenStream.getTracks().forEach(track => track.stop());
        }
        if (evalState.audioStream) {
            evalState.audioStream.getTracks().forEach(track => track.stop());
        }
    });
}

// ჩანაწერის შენახვა ფაილად
async function saveRecordingToFile() {
    if (evalState.recordedChunks.length === 0) {
        console.log('No recorded data to save');
        return;
    }
    
    try {
        // Blob-ის შექმნა
        const blob = new Blob(evalState.recordedChunks, { type: 'video/webm' });
        
        // ArrayBuffer-ად გარდაქმნა
        const arrayBuffer = await blob.arrayBuffer();
        
        // ფაილის სახელის გენერაცია
        const filename = generateRecordingFilename();
        
        // Electron-ით შენახვა
        const result = await window.electronAPI.saveRecording(arrayBuffer, filename);
        
        if (result.success) {
            console.log('✅ Recording saved successfully:', result.path);
        } else {
            console.error('❌ Failed to save recording:', result.error);
        }
        
        // გავწმინდოთ chunks
        evalState.recordedChunks = [];
        
    } catch (error) {
        console.error('Error saving recording:', error);
    }
}

// ფაილის სახელის გენერაცია
function generateRecordingFilename() {
    const user = evalState.user;
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    
    const userPart = user?.personal_number || user?.id || 'unknown';
    const projectPart = evalState.project?.code || 'project';
    
    return `eval_${userPart}_${projectPart}_${dateStr}_${timeStr}.webm`;
}

// ჩაწერის ინდიკატორის განახლება
function updateRecordingIndicator() {
    const indicator = document.getElementById('recording-indicator');
    if (indicator) {
        indicator.style.display = evalState.isRecording ? 'block' : 'none';
    }
}

// ჩაწერის შეცდომის ჩვენება
function showRecordingError() {
    const errorEl = document.getElementById('recording-error-message');
    if (errorEl) {
        errorEl.style.display = 'block';
    }
    updateRecordingIndicator();
}

// ==========================================
// Focus Tracking
// ==========================================
function enableFocusTracking() {
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('focus', handleWindowFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
}

function disableFocusTracking() {
    window.removeEventListener('blur', handleWindowBlur);
    window.removeEventListener('focus', handleWindowFocus);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
}

function handleWindowBlur() {
    if (evalState.evalPhase !== 'active') return;
    if (evalState.isFocusWarningActive) return;
    
    // თუ რეგულაციების ტაბზეა, არ გააქტიუროთ warning (PDF-ში სქროლვა)
    const regulationsTab = document.getElementById('regulations-tab');
    if (regulationsTab && regulationsTab.style.display !== 'none') {
        console.log('📄 Regulations tab active - ignoring blur');
        return;
    }
    
    // თუ შეფასების ტაბზეა (პროექტის PDF), არ გააქტიუროთ warning
    const evaluationTab = document.getElementById('evaluation-tab');
    if (evaluationTab && evaluationTab.style.display !== 'none') {
        console.log('📄 Evaluation tab (project PDF) active - ignoring blur');
        return;
    }
    
    setTimeout(() => {
        if (document.hasFocus()) return;
        if (evalState.evalPhase !== 'active' || evalState.isFocusWarningActive) return;
        
        console.log('⚠️ Window lost focus - starting countdown');
        startFocusWarningCountdown();
    }, 150);
}

function handleWindowFocus() {
    if (evalState.isFocusWarningActive) {
        console.log('✓ Window regained focus - stopping countdown');
        stopFocusWarningCountdown();
    }
}

function handleVisibilityChange() {
    if (document.hidden && evalState.evalPhase === 'active') {
        if (!evalState.isFocusWarningActive) {
            startFocusWarningCountdown();
        }
    } else if (!document.hidden && evalState.isFocusWarningActive) {
        stopFocusWarningCountdown();
    }
}

function startFocusWarningCountdown() {
    evalState.isFocusWarningActive = true;
    evalState.focusWarningCountdown = 10;
    
    const warningOverlay = document.getElementById('warning-overlay');
    if (warningOverlay) warningOverlay.style.display = 'flex';
    
    updateCountdownDisplay();
    
    evalState.focusWarningTimer = setInterval(() => {
        evalState.focusWarningCountdown--;
        updateCountdownDisplay();
        
        if (evalState.focusWarningCountdown <= 0) {
            stopFocusWarningCountdown();
            finishEvaluation();
        }
    }, 1000);
}

function stopFocusWarningCountdown() {
    evalState.isFocusWarningActive = false;
    
    if (evalState.focusWarningTimer) {
        clearInterval(evalState.focusWarningTimer);
        evalState.focusWarningTimer = null;
    }
    
    const warningOverlay = document.getElementById('warning-overlay');
    if (warningOverlay) warningOverlay.style.display = 'none';
}

function updateCountdownDisplay() {
    const countdownEl = document.getElementById('countdown-number');
    if (countdownEl) {
        countdownEl.textContent = evalState.focusWarningCountdown;
        
        // ფერის შეცვლა დროის მიხედვით
        if (evalState.focusWarningCountdown <= 3) {
            countdownEl.style.color = '#ff0000'; // ძალიან წითელი
        } else if (evalState.focusWarningCountdown <= 5) {
            countdownEl.style.color = '#ff4444'; // წითელი
        } else {
            countdownEl.style.color = '#ff6666'; // ღია წითელი
        }
    }
}

// ==========================================
// Finish Evaluation
// ==========================================
function showFinishConfirmation() {
    const overlay = document.getElementById('confirm-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function hideConfirmation() {
    const overlay = document.getElementById('confirm-overlay');
    if (overlay) overlay.style.display = 'none';
}

async function finishEvaluation() {
    console.log('Finishing evaluation...');
    
    hideConfirmation();
    
    // Stop timer
    if (evalState.timerInterval) {
        clearInterval(evalState.timerInterval);
    }
    
    // Stop screen recording and save file
    await stopScreenRecording();
    
    // Disable focus tracking
    disableFocusTracking();
    
    // Calculate results
    const results = calculateResults();
    
    // Display results
    displayResults(results);
    
    // Save results to server
    await saveResults(results);
    
    evalState.evalPhase = 'results';
}

function calculateResults() {
    if (!evalState.project) {
        return { percentage: 0, wrongCount: 0, correctCount: 0, totalCorrect: 0 };
    }
    
    const correctAnswerIds = evalState.project.correctAnswerIds || [];
    const selectedIds = evalState.selectedAnswerIds;
    
    // სწორად ნაპოვნი
    const correctCount = selectedIds.filter(id => correctAnswerIds.includes(id)).length;
    
    // არასწორად მონიშნული
    const wrongCount = selectedIds.filter(id => !correctAnswerIds.includes(id)).length;
    
    // პროცენტი
    const totalCorrect = correctAnswerIds.length;
    const percentage = totalCorrect > 0 ? Math.round((correctCount / totalCorrect) * 100) : 0;
    
    return { percentage, wrongCount, correctCount, totalCorrect };
}

function displayResults(results) {
    const percentageEl = document.getElementById('correct-percentage');
    const wrongCountEl = document.getElementById('wrong-answers-count');
    
    if (percentageEl) {
        percentageEl.textContent = `${results.percentage}%`;
        percentageEl.style.color = getPercentageColor(results.percentage);
    }
    
    if (wrongCountEl) {
        wrongCountEl.textContent = results.wrongCount;
        wrongCountEl.style.color = getWrongCountColor(results.wrongCount);
    }
    
    const overlay = document.getElementById('results-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function getPercentageColor(percentage) {
    if (percentage >= 75) return '#22c55e'; // მწვანე
    if (percentage >= 70) return '#eab308'; // ყვითელი
    return '#ef4444'; // წითელი
}

function getWrongCountColor(count) {
    if (count <= 1) return '#22c55e'; // მწვანე
    if (count === 2) return '#eab308'; // ყვითელი
    return '#ef4444'; // წითელი
}

async function saveResults(results) {
    try {
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        const token = localStorage.getItem('token');
        
        if (!token || !evalState.project) {
            console.error('No token or project for saving results');
            return;
        }
        
        const payload = {
            projectCode: evalState.project.code,
            projectName: evalState.project.name || `პროექტი ${evalState.project.number}`,
            selectedAnswerIds: evalState.selectedAnswerIds,
            percentage: results.percentage,
            correctCount: results.correctCount,
            wrongCount: results.wrongCount,
            totalCorrectAnswers: results.totalCorrect,
            durationSeconds: evalState.settings.durationMinutes * 60 - evalState.remainingSeconds,
        };
        
        const response = await fetch(`${window.API_CONFIG.baseURL}/public/multi-apartment/evaluations`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`,
            },
            body: JSON.stringify(payload),
        });
        
        if (response.ok) {
            console.log('✅ Evaluation results saved successfully');
        } else {
            const error = await response.json().catch(() => ({}));
            console.error('Failed to save results:', error.detail || response.statusText);
        }
    } catch (e) {
        console.error('Error saving results:', e);
    }
}

// ==========================================
// Regulations (რეგულაციები tab)
// ==========================================
async function loadRegulations() {
    try {
        const response = await fetch(`${window.API_CONFIG.baseURL}/regulations`);
        if (response.ok) {
            const data = await response.json();
            evalState.regulations = Array.isArray(data) ? data : [];
            renderDocList();
        }
    } catch (e) {
        console.error('Error loading regulations:', e);
    }
}

function renderDocList() {
    const docList = document.querySelector('.doc-list');
    if (!docList) return;
    
    docList.innerHTML = '';
    
    if (evalState.regulations.length === 0) {
        docList.innerHTML = '<div class="doc-list-empty">დადგენილებები არ არის ატვირთული</div>';
        return;
    }
    
    evalState.regulations.forEach((reg, index) => {
        const item = document.createElement('div');
        item.className = 'doc-list-item';
        item.dataset.regulationId = String(reg.id);
        
        if (evalState.selectedRegulationId === reg.id) {
            item.classList.add('active');
        }
        
        item.innerHTML = `
            <span class="doc-list-number">${index + 1}.</span>
            <span class="doc-list-title">${escapeHtml(reg.title || 'დადგენილება')}</span>
        `;
        
        item.addEventListener('click', () => selectRegulation(reg.id));
        
        docList.appendChild(item);
    });
    
    // Select first by default
    if (evalState.regulations.length > 0 && !evalState.selectedRegulationId) {
        selectRegulation(evalState.regulations[0].id);
    }
}

function selectRegulation(regulationId) {
    const regId = Number(regulationId);
    evalState.selectedRegulationId = regId;
    
    // Update active class
    const items = document.querySelectorAll('.doc-list-item');
    items.forEach(item => {
        if (Number(item.dataset.regulationId) === regId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });
    
    displayRegulationPdf(regId);
}

function displayRegulationPdf(regulationId) {
    const pdfViewer = document.querySelector('#regulations-tab .pdf-viewer');
    if (!pdfViewer) return;
    
    const regId = Number(regulationId);
    const regulation = evalState.regulations.find(r => Number(r.id) === regId);
    
    if (!regulation) {
        pdfViewer.innerHTML = '<div class="pdf-empty">დადგენილება ვერ მოიძებნა</div>';
        return;
    }
    
    if (!regulation.filename) {
        pdfViewer.innerHTML = '<div class="pdf-empty">ფაილი არ არის ატვირთული</div>';
        return;
    }
    
    const pdfUrl = `${window.API_CONFIG.baseURL}/regulations/${regulationId}/view`;
    
    pdfViewer.innerHTML = `
        <iframe 
            src="${pdfUrl}" 
            class="pdf-iframe"
            title="${escapeHtml(regulation.title || 'დადგენილება')}"
        ></iframe>
    `;
}

// ==========================================
// Utilities
// ==========================================
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}


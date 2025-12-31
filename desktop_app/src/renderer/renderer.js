// API client will be loaded via script tag
// Using window.apiClient after script loads

// ====================================
// CONSTANTS
// ====================================
const RETRY_INTERVAL = 100; // ms
const MAX_API_WAIT_ATTEMPTS = 50; // 5 seconds
const FOCUS_DELAY = 100; // ms
const API_RETRY_COUNT = 5;

// ====================================
// UTILITIES
// ====================================

// Wait for all scripts to load before initializing
function waitForAPIClient(callback, maxAttempts = MAX_API_WAIT_ATTEMPTS) {
    if (window.apiClient) {
        callback();
    } else if (maxAttempts > 0) {
        setTimeout(() => waitForAPIClient(callback, maxAttempts - 1), RETRY_INTERVAL);
    } else {
        console.error('API client failed to load after maximum attempts');
        console.error('window.apiClient:', window.apiClient);
        console.error('window.API_CONFIG:', window.API_CONFIG);
    }
}

// Helper: create element with text content (XSS-safe)
function createElementWithText(tag, text, className = '') {
    const el = document.createElement(tag);
    el.textContent = text;
    if (className) el.className = className;
    return el;
}

// ====================================
// MAIN INITIALIZATION
// ====================================

function initializeApp() {
    // ====================================
    // TITLE BAR CONTROLS
    // ====================================
    
    // Setup title bar buttons with loop (DRY principle)
    const titleBarButtons = [
        { id: 'minimize-btn', action: 'minimizeWindow' },
        { id: 'maximize-btn', action: 'maximizeWindow' },
        { id: 'close-btn', action: 'closeWindow' }
    ];
    
    titleBarButtons.forEach(({ id, action }) => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.addEventListener('click', () => window.electronAPI[action]());
        }
    });

    // Update maximize button icon based on window state
    function updateMaximizeButton(isMaximized) {
        const maximizeBtn = document.getElementById('maximize-btn');
        if (!maximizeBtn) return;
        
        const svg = maximizeBtn.querySelector('svg');
        if (!svg) return;
        
        svg.innerHTML = isMaximized
            ? `<rect x="2" y="2" width="8" height="8" stroke="currentColor" stroke-width="1.5" fill="none"/>
               <rect x="4" y="4" width="8" height="8" stroke="currentColor" stroke-width="1.5" fill="none"/>`
            : `<rect x="1" y="1" width="10" height="10" stroke="currentColor" stroke-width="1.5" fill="none"/>`;
    }

    // Check initial state and listen for maximize/unmaximize events
    if (window.electronAPI) {
        const isMaximized = window.electronAPI.isMaximized();
        updateMaximizeButton(isMaximized);
        
        window.electronAPI.onMaximize(() => updateMaximizeButton(true));
        window.electronAPI.onUnmaximize(() => updateMaximizeButton(false));
    }

    // ====================================
    // AUTH & MODAL FUNCTIONALITY
    // ====================================
    
    // Get DOM elements
    const signInBtn = document.getElementById('sign-in-btn');
    const signInModal = document.getElementById('sign-in-modal');
    const modalCloseBtn = document.getElementById('modal-close-btn');
    const signInForm = document.getElementById('sign-in-form');
    const emailInput = document.getElementById('email');
    const passwordInput = document.getElementById('password');
    const userInfoBar = document.getElementById('user-info-bar');
    
    // Logout confirmation modal elements
    const logoutConfirmModal = document.getElementById('logout-confirm-modal');
    const logoutCancelBtn = document.getElementById('logout-cancel-btn');
    const logoutConfirmBtn = document.getElementById('logout-confirm-btn');
    
    // Exam cards
    const examCards = document.querySelectorAll('.exam-card');

    // Helper: Update sign-in button state
    function updateSignInButton(text) {
        if (!signInBtn) return;
        signInBtn.textContent = text;
        signInBtn.disabled = false;
        signInBtn.style.cursor = 'pointer';
    }

    // Initialize: Check if user is already logged in
    function initializeAuth() {
        if (window.apiClient) {
            const user = window.apiClient.getCurrentUser();
            if (user) {
                updateUIForLoggedInUser(user);
                // დავიწყოთ პერიოდული შემოწმება
                startPermissionPolling();
            } else {
                updateUIForLoggedOutUser();
            }
        } else {
            setTimeout(initializeAuth, RETRY_INTERVAL);
        }
    }
    
    // პერიოდული შემოწმება - ადმინის ცვლილებები დაუყოვნებლივ აისახება
    let permissionPollingInterval = null;
    const POLLING_INTERVAL = 5000; // 5 წამი
    
    function startPermissionPolling() {
        // გავაჩეროთ თუ უკვე მუშაობს
        if (permissionPollingInterval) {
            clearInterval(permissionPollingInterval);
        }
        
        permissionPollingInterval = setInterval(async () => {
            await refreshUserPermission();
        }, POLLING_INTERVAL);
    }
    
    function stopPermissionPolling() {
        if (permissionPollingInterval) {
            clearInterval(permissionPollingInterval);
            permissionPollingInterval = null;
        }
    }
    
    async function refreshUserPermission() {
        try {
            const token = localStorage.getItem('auth_token');
            if (!token) return;
            
            // მომხმარებლის ინფოს მიღება API-დან
            const response = await fetch(`${window.API_CONFIG.baseURL}/users/me`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                },
            });
            
            if (!response.ok) return;
            
            const freshUser = await response.json();
            
            // შევადაროთ localStorage-ში შენახულ მომხმარებელს
            const localUserStr = localStorage.getItem('current_user');
            if (localUserStr) {
                const localUser = JSON.parse(localUserStr);
                
                // თუ exam_permission შეიცვალა, განვაახლოთ
                if (localUser.exam_permission !== freshUser.exam_permission) {
                    console.log('🔄 exam_permission changed:', localUser.exam_permission, '→', freshUser.exam_permission);
                    
                    // განვაახლოთ localStorage
                    localUser.exam_permission = freshUser.exam_permission;
                    localStorage.setItem('current_user', JSON.stringify(localUser));
                    
                    // განვაახლოთ UI
                    updateUIForLoggedInUser(localUser);
                }
            }
        } catch (e) {
            // ჩუმად გავაგრძელოთ - შეიძლება ქსელი არ მუშაობს
            console.warn('Permission refresh failed:', e.message);
        }
    }

    // Update UI when user is logged in
    function updateUIForLoggedInUser(user) {
        updateSignInButton('გასვლა');
        
        // Clear and rebuild user info bar (XSS-safe)
        if (userInfoBar) {
            userInfoBar.innerHTML = ''; // Clear first
            const userInfoDiv = document.createElement('div');
            userInfoDiv.className = 'user-info';
            
            const nameSpan = createElementWithText('span', `${user.first_name} ${user.last_name}`);
            const codeSpan = createElementWithText('span', user.code, 'user-code');
            
            userInfoDiv.appendChild(nameSpan);
            userInfoDiv.appendChild(codeSpan);
            userInfoBar.appendChild(userInfoDiv);
        }
        
        // Enable exam cards (clickable after login)
        examCards.forEach(card => {
            card.classList.add('active');
        });
        
        // თეორიული გამოცდა (exam-card-1) - შემოწმება exam_permission-ის
        const examCard1 = document.getElementById('exam-card-1');
        if (examCard1) {
            if (user.exam_permission) {
                examCard1.classList.add('active');
                examCard1.style.opacity = '1';
                examCard1.style.cursor = 'pointer';
            } else {
                examCard1.classList.remove('active');
                examCard1.style.opacity = '0.5';
                examCard1.style.cursor = 'not-allowed';
            }
        }
        
        // მრავალბინიანი (exam-card-2) - შემოწმება exam_permission-ის
        const examCard2 = document.getElementById('exam-card-2');
        if (examCard2) {
            if (user.exam_permission) {
                examCard2.classList.add('active');
                examCard2.style.opacity = '1';
                examCard2.style.cursor = 'pointer';
            } else {
                examCard2.classList.remove('active');
                examCard2.style.opacity = '0.5';
                examCard2.style.cursor = 'not-allowed';
            }
        }
        
        // მრავალფუნქციური (exam-card-3) - შემოწმება exam_permission-ის
        const examCard3 = document.getElementById('exam-card-3');
        if (examCard3) {
            if (user.exam_permission) {
                examCard3.classList.add('active');
                examCard3.style.opacity = '1';
                examCard3.style.cursor = 'pointer';
            } else {
                examCard3.classList.remove('active');
                examCard3.style.opacity = '0.5';
                examCard3.style.cursor = 'not-allowed';
            }
        }
        
        window.currentUser = user;
    }

    // Update UI when user is logged out
    function updateUIForLoggedOutUser() {
        updateSignInButton('შესვლა');
        
        // Clear and rebuild user info bar (XSS-safe)
        if (userInfoBar) {
            userInfoBar.innerHTML = '';
            const userInfoDiv = document.createElement('div');
            userInfoDiv.className = 'user-info';
            const messageSpan = createElementWithText('span', 'გთხოვთ შეხვიდეთ სისტემაში');
            userInfoDiv.appendChild(messageSpan);
            userInfoBar.appendChild(userInfoDiv);
        }
        
        // Disable exam cards (not clickable when logged out)
        examCards.forEach(card => {
            card.classList.remove('active');
        });
        
        window.currentUser = null;
    }

    // Function to close modal
    function closeModal() {
        if (signInModal) signInModal.style.display = 'none';
        document.body.style.overflow = '';
        if (signInForm) signInForm.reset();
    }

    // Function to open modal
    function openModal() {
        if (!signInModal || !emailInput) return;
        
        signInModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        window.focus();
        setTimeout(() => emailInput.focus(), FOCUS_DELAY);
    }

    // Function to open logout confirmation modal
    function openLogoutConfirmModal() {
        if (!logoutConfirmModal) return;
        
        logoutConfirmModal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    // Function to close logout confirmation modal
    function closeLogoutConfirmModal() {
        if (!logoutConfirmModal) return;
        
        logoutConfirmModal.style.display = 'none';
        document.body.style.overflow = '';
    }

    // Logout function
    function handleLogout() {
        // გავაჩეროთ პერიოდული შემოწმება
        stopPermissionPolling();
        
        if (window.apiClient) {
            window.apiClient.logout();
        }
        updateUIForLoggedOutUser();
        closeLogoutConfirmModal();
    }

    // Open modal or logout (toggle behavior)
    if (signInBtn) {
        signInBtn.addEventListener('click', () => {
            if (!window.apiClient) {
                openModal();
                return;
            }
            
            const user = window.apiClient.getCurrentUser();
            user ? openLogoutConfirmModal() : openModal();
        });
    }

    // Logout confirmation modal buttons
    if (logoutCancelBtn) {
        logoutCancelBtn.addEventListener('click', closeLogoutConfirmModal);
    }

    if (logoutConfirmBtn) {
        logoutConfirmBtn.addEventListener('click', handleLogout);
    }

    // Close logout modal when clicking outside
    if (logoutConfirmModal) {
        logoutConfirmModal.addEventListener('click', (e) => {
            if (e.target === logoutConfirmModal) closeLogoutConfirmModal();
        });
    }

    // ====================================
    // EXAM CARDS FUNCTIONALITY
    // ====================================
    
    // Add click handlers to exam cards
    examCards.forEach((card, index) => {
        card.addEventListener('click', async () => {
            // Only work if user is logged in (card has 'active' class)
            if (!card.classList.contains('active')) return;
            
            // ჯერ API-დან შევამოწმოთ permission (არა localStorage-დან!)
            const hasPermission = await checkExamPermissionFromAPI();
            
            if (!hasPermission) {
                alert('თქვენ არ გაქვთ გამოცდის გავლის უფლება');
                return;
            }
            
            // პირველი ბარათი - თეორიული გამოცდა
            if (index === 0) {
                window.location.href = 'exam.html';
            } 
            // მეორე ბარათი - მრავალბინიანი პროექტის შეფასება
            else if (index === 1) {
                window.location.href = 'multi-apartment-eval.html';
            }
            // მესამე ბარათი - მრავალფუნქციური პროექტის შეფასება
            else if (index === 2) {
                window.location.href = 'multi-functional-eval.html';
            }
        });
    });
    
    // API-დან exam_permission-ის შემოწმება (real-time)
    async function checkExamPermissionFromAPI() {
        try {
            const token = localStorage.getItem('auth_token');
            if (!token) return false;
            
            const response = await fetch(`${window.API_CONFIG.baseURL}/users/me`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                },
            });
            
            if (!response.ok) return false;
            
            const user = await response.json();
            
            // განვაახლოთ localStorage-იც
            const localUserStr = localStorage.getItem('current_user');
            if (localUserStr) {
                const localUser = JSON.parse(localUserStr);
                localUser.exam_permission = user.exam_permission;
                localStorage.setItem('current_user', JSON.stringify(localUser));
                
                // განვაახლოთ UI თუ შეიცვალა
                if (!user.exam_permission) {
                    updateUIForLoggedInUser(localUser);
                }
            }
            
            return user.exam_permission === true;
        } catch (e) {
            console.error('Error checking permission from API:', e);
            // თუ API არ მუშაობს, localStorage-ს ვენდობით
            const user = window.apiClient ? window.apiClient.getCurrentUser() : null;
            return user && user.exam_permission;
        }
    }

    // Close modal with close button
    if (modalCloseBtn) {
        modalCloseBtn.addEventListener('click', closeModal);
    }

    // Close modal when clicking outside
    if (signInModal) {
        signInModal.addEventListener('click', (e) => {
            if (e.target === signInModal) closeModal();
        });
    }

    // Close modals with ESC key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (signInModal && signInModal.style.display === 'flex') {
                closeModal();
            }
            if (logoutConfirmModal && logoutConfirmModal.style.display === 'flex') {
                closeLogoutConfirmModal();
            }
        }
    });

    // ====================================
    // FORM SUBMISSION
    // ====================================
    
    if (signInForm) {
        signInForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            if (!emailInput || !passwordInput) return;
            
            const email = emailInput.value.trim();
            const password = passwordInput.value;
            
            // Basic validation
            if (!email || !password) {
                alert('გთხოვთ შეავსოთ ყველა ველი');
                return;
            }
            
            // Wait for API client (reuse existing utility)
            if (!window.apiClient) {
                let attempts = 0;
                while (!window.apiClient && attempts < API_RETRY_COUNT) {
                    await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL));
                    attempts++;
                }
                
                if (!window.apiClient) {
                    console.error('API client not available. window.apiClient:', window.apiClient);
                    console.error('window.API_CONFIG:', window.API_CONFIG);
                    alert('API client არ არის ხელმისაწვდომი. გთხოვთ გადატვირთოთ გვერდი.');
                    return;
                }
            }
            
            // Get submit button with null check
            const submitBtn = signInForm.querySelector('.modal-submit-btn');
            if (!submitBtn) return;
            
            const originalText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = 'მიმდინარეობს...';
            
            try {
                const response = await window.apiClient.login(email, password);
                
                console.log('Login successful:', response.user);
                closeModal();
                updateUIForLoggedInUser(response.user);
                
            } catch (error) {
                console.error('Login error:', error);
                
                let errorMessage = 'შესვლა ვერ მოხერხდა';
                if (error instanceof Error) {
                    if (error.status === 401) {
                        errorMessage = 'არასწორი ელ.ფოსტა ან პაროლი';
                    } else if (error.status === 0) {
                        errorMessage = 'ბმული ვერ დამყარდა. შეამოწმეთ რომ backend გაშვებულია';
                    } else {
                        errorMessage = error.message || 'დაფიქსირდა შეცდომა';
                    }
                }
                
                alert(errorMessage);
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }

    // Initialize auth after API client is ready
    waitForAPIClient(initializeAuth, MAX_API_WAIT_ATTEMPTS);
}

// ====================================
// DOM READY HANDLER
// ====================================

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

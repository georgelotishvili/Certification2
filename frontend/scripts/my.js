document.addEventListener('DOMContentLoaded', () => {
  const API_BASE = (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === 'string')
    ? window.APP_CONFIG.API_BASE
    : 'http://127.0.0.1:8000';
  const VIEW_USER_ID = (() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get('userId');
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
  })();

  const DOM = {
    body: document.body,
    header: document.querySelector('header'),
    navLogo: document.querySelector('.nav-bar .logo'),
    authBanner: document.querySelector('.auth-banner'),
    drawerAuthBanner: document.querySelector('.drawer-auth-banner'),
    pageTitle: document.getElementById('pageTitle'),
    burger: document.querySelector('.burger'),
    overlay: document.querySelector('.overlay'),
    drawer: document.querySelector('.drawer'),
    drawerClose: document.querySelector('.drawer-close'),
    drawerSubmenu: document.querySelector('.drawer-submenu'),
    homeBtn: document.querySelector('.home-btn') || document.querySelector('.login-btn'),
    drawerHomeBtn: document.querySelector('.drawer-home') || document.querySelector('.drawer-login'),
    navRegistry: document.querySelector('.nav-registry'),
    drawerRegistry: document.querySelector('.drawer-registry'),
    navAbout: document.querySelector('.nav-about'),
    drawerAbout: document.querySelector('.drawer-about'),
    registryOverlay: document.getElementById('registryOverlay'),
    registryClose: document.getElementById('registryClose'),
    registryList: document.getElementById('registryList'),
    registrySearch: document.getElementById('registrySearch'),
    registryFilterArchitect: document.getElementById('registryFilterArchitect'),
    registryFilterExpert: document.getElementById('registryFilterExpert'),
    registrySort: document.getElementById('registrySort'),
    dropdown: document.querySelector('.nav .dropdown'),
    adminLink: document.querySelector('.admin-link'),
    pfFirstName: document.getElementById('myFirstName'),
    pfLastName: document.getElementById('myLastName'),
    pfPersonalId: document.getElementById('myPersonalId'),
    pfPhone: document.getElementById('myPhone'),
    pfEmail: document.getElementById('myEmail'),
    pfCode: document.getElementById('myCode'),
    pfCreatedAt: document.getElementById('myCreatedAt'),
    certCard: document.getElementById('certCard'),
    certCode: document.getElementById('myCertCode'),
    certLevel: document.getElementById('myCertLevel'),
    certStatus: document.getElementById('myCertStatus'),
    certIssueDate: document.getElementById('myCertIssueDate'),
    certValidityTerm: document.getElementById('myCertValidityTerm'),
    certValidUntil: document.getElementById('myCertValidUntil'),
    certExamScore: document.getElementById('myCertExamScore'),
    certDownloadBtn: document.getElementById('certDownloadBtn'),
    reviewsCard: document.getElementById('reviewsCard'),
    reviewsAverage: document.getElementById('reviewsAverage'),
    reviewStars: document.getElementById('reviewStars'),
    reviewCommentForm: document.getElementById('reviewCommentForm'),
    reviewCommentMessage: document.getElementById('reviewCommentMessage'),
    reviewsComments: document.getElementById('reviewsComments'),
    expertCard: document.getElementById('expertCard'),
    expertFunction: document.getElementById('expertFunction'),
    expertCadastral: document.getElementById('expertCadastral'),
    expertAddress: document.getElementById('expertAddress'),
    expertFileExpertise: document.getElementById('expertFileExpertise'),
    expertFileProject: document.getElementById('expertFileProject'),
    expertExpertiseDownload: document.getElementById('expertExpertiseDownload'),
    expertExpertiseDelete: document.getElementById('expertExpertiseDelete'),
    expertProjectDownload: document.getElementById('expertProjectDownload'),
    expertProjectDelete: document.getElementById('expertProjectDelete'),
    expertExpertiseClear: document.getElementById('expertExpertiseClear'),
    expertProjectClear: document.getElementById('expertProjectClear'),
    expertExpertiseChoose: document.getElementById('expertExpertiseChoose'),
    expertProjectChoose: document.getElementById('expertProjectChoose'),
    expertExpertiseChosen: document.getElementById('expertExpertiseChosen'),
    expertProjectChosen: document.getElementById('expertProjectChosen'),
    expertSubmitBtn: document.getElementById('expertSubmitBtn'),
    expertList: document.getElementById('expertList'),
  };

  const utils = {
    on: (element, event, handler) => element && element.addEventListener(event, handler),
    isValidEmail: (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    getTrimmed: (formData, name) => (formData.get(name) || '').toString().trim(),
  };

  function isLoggedIn() { try { return window.Auth?.isLoggedIn?.() === true; } catch { return false; } }
  function getCurrentUser() { try { return window.Auth?.getCurrentUser?.() || null; } catch { return null; } }
  const authModule = { isLoggedIn, getCurrentUser };

  function guard() {
    const user = getCurrentUser();
    if (!isLoggedIn() || !user) {
      alert('გთხოვთ გაიაროთ ავტორიზაცია');
      window.location.href = 'index.html';
      return false;
    }
    return true;
  }
  if (!VIEW_USER_ID && !guard()) return;

  // Body offset not needed (handled via CSS)

  // setAboutLabel removed: label is static in header partial

  // Banner/UI now updated by global auth module in script.js

  function updatePageTitleFrom(source) {
    if (!DOM.pageTitle) return;
    try {
      const first = (source?.firstName || source?.first_name || '').trim();
      const last = (source?.lastName || source?.last_name || '').trim();
      const full = `${first} ${last}`.trim();
      DOM.pageTitle.textContent = full || 'ჩემი გვერდი';
    } catch {
      /* no-op */
    }
  }
  // Initial title from local user, fallback to default
  updatePageTitleFrom(getCurrentUser());

  // Snapshot of self profile loaded from API (used for profile edit modal)
  let selfProfileData = null;

  // Load read-only profile info (self or viewing other)
  function getActorHeaders() {
    const email = (window.Auth?.getSavedEmail?.() || '').trim();
    return email ? { 'x-actor-email': email } : {};
  }

  // Page header photo element
  const pageHeaderPhoto = document.getElementById('pageHeaderPhoto');
  
  function updateHeaderPhoto(photoUrl) {
    if (!pageHeaderPhoto) return;
    if (photoUrl) {
      pageHeaderPhoto.innerHTML = `<img src="${photoUrl}" alt="ფოტო" />`;
      pageHeaderPhoto.classList.add('has-photo');
      pageHeaderPhoto.onclick = () => showPhotoModal(photoUrl);
    } else {
      pageHeaderPhoto.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="default-photo-icon">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
      </svg>`;
      pageHeaderPhoto.classList.remove('has-photo');
      pageHeaderPhoto.onclick = null;
    }
  }

  // Load header photo
  async function loadHeaderPhoto(userId) {
    if (!userId) return;
    try {
      const photoUrl = `${API_BASE}/users/${userId}/photo/file`;
      // Use image preload to check if photo exists
      const img = new Image();
      img.onload = () => updateHeaderPhoto(photoUrl);
      img.onerror = () => {}; // Photo doesn't exist, keep default icon
      img.src = photoUrl;
    } catch {}
  }

  // Photo modal
  let photoModalEl = null;
  function showPhotoModal(photoUrl) {
    if (!photoModalEl) {
      photoModalEl = document.createElement('div');
      photoModalEl.className = 'photo-modal-overlay';
      photoModalEl.innerHTML = `
        <div class="photo-modal-content">
          <button type="button" class="photo-modal-close" aria-label="დახურვა">×</button>
          <img class="photo-modal-img" src="" alt="ფოტო" />
        </div>
      `;
      document.body.appendChild(photoModalEl);
      
      photoModalEl.addEventListener('click', (e) => {
        if (e.target === photoModalEl || e.target.classList.contains('photo-modal-close')) {
          photoModalEl.classList.remove('open');
        }
      });
      
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && photoModalEl.classList.contains('open')) {
          photoModalEl.classList.remove('open');
        }
      });
    }
    
    const img = photoModalEl.querySelector('.photo-modal-img');
    if (img) img.src = photoUrl;
    photoModalEl.classList.add('open');
  }

  async function loadProfile() {
    const user = getCurrentUser();
    const savedEmail = (window.Auth?.getSavedEmail?.() || '').trim();

    if (VIEW_USER_ID) {
      // Populate full public info by user id (requires authenticated actor)
      try {
        const res = await fetch(`${API_BASE}/users/${encodeURIComponent(VIEW_USER_ID)}/public`, {
          headers: { 'Cache-Control': 'no-cache', ...getActorHeaders() },
        });
        if (res.ok) {
          const data = await res.json();
          if (DOM.pfFirstName) DOM.pfFirstName.textContent = data.first_name || '—';
          if (DOM.pfLastName) DOM.pfLastName.textContent = data.last_name || '—';
          if (DOM.pfPersonalId) DOM.pfPersonalId.textContent = data.personal_id || '—';
          if (DOM.pfPhone) DOM.pfPhone.textContent = data.phone || '—';
          if (DOM.pfEmail) DOM.pfEmail.textContent = data.email || '—';
          if (DOM.pfCode) DOM.pfCode.textContent = data.code || '—';
          if (DOM.pfCreatedAt) DOM.pfCreatedAt.textContent = window.Utils?.formatDateTime?.(data.created_at);
          updatePageTitleFrom({ firstName: data.first_name || '', lastName: data.last_name || '' });
          return;
        }
      } catch {}
      // Fallback to registry (limited info)
      try {
        const res = await fetch(`${API_BASE}/certified-persons/registry?limit=500`, { headers: { 'Cache-Control': 'no-cache' } });
        if (res.ok) {
          const list = await res.json();
          const item = Array.isArray(list) ? list.find((x) => Number(x?.id) === Number(VIEW_USER_ID)) : null;
          if (item) {
            const parts = String(item.full_name || '').trim().split(/\s+/);
            if (DOM.pfFirstName) DOM.pfFirstName.textContent = parts[0] || '—';
            if (DOM.pfLastName) DOM.pfLastName.textContent = parts.slice(1).join(' ') || '—';
            if (DOM.pfEmail) DOM.pfEmail.textContent = '—';
            if (DOM.pfCode) DOM.pfCode.textContent = item.unique_code || '—';
            if (DOM.pfCreatedAt) DOM.pfCreatedAt.textContent = window.Utils?.formatDateTime?.(item.registration_date);
            updatePageTitleFrom({ firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' });
          }
        }
      } catch {}
      return;
    }

    // Self: prefill from local user object
    if (user) {
      if (DOM.pfFirstName) DOM.pfFirstName.textContent = user.firstName || '—';
      if (DOM.pfLastName) DOM.pfLastName.textContent = user.lastName || '—';
      if (DOM.pfEmail) DOM.pfEmail.textContent = user.email || savedEmail || '—';
      if (DOM.pfCode) DOM.pfCode.textContent = user.code || '—';
      updatePageTitleFrom(user);
    }
    if (!savedEmail) return;
    try {
      const res = await fetch(`${API_BASE}/users/profile?email=${encodeURIComponent(savedEmail)}`, { headers: { 'Cache-Control': 'no-cache', ...getActorHeaders() } });
      if (!res.ok) return;
      const data = await res.json();
      selfProfileData = data;
      if (DOM.pfFirstName) DOM.pfFirstName.textContent = data.first_name || '—';
      if (DOM.pfLastName) DOM.pfLastName.textContent = data.last_name || '—';
      if (DOM.pfPersonalId) DOM.pfPersonalId.textContent = data.personal_id || '—';
      if (DOM.pfPhone) DOM.pfPhone.textContent = data.phone || '—';
      if (DOM.pfEmail) DOM.pfEmail.textContent = data.email || '—';
      if (DOM.pfCode) DOM.pfCode.textContent = data.code || '—';
      if (DOM.pfCreatedAt) DOM.pfCreatedAt.textContent = window.Utils?.formatDateTime?.(data.created_at);
      updatePageTitleFrom(data);
      // Load header photo for self
      if (data.id) {
        loadHeaderPhoto(data.id);
      }
    } catch {}
  }
  loadProfile();

  // Profile edit modal (self only)
  const profileEditDOM = {
    btn: document.getElementById('profileEditBtn'),
    overlay: document.getElementById('profileEditOverlay'),
    close: document.getElementById('profileEditClose'),
    form: document.getElementById('profileEditForm'),
    submit: document.getElementById('profileEditSubmit'),
    firstName: document.getElementById('editFirstName'),
    lastName: document.getElementById('editLastName'),
    personalId: document.getElementById('editPersonalId'),
    phone: document.getElementById('editPhone'),
    email: document.getElementById('editEmail'),
    code: document.getElementById('editCode'),
    createdAt: document.getElementById('editCreatedAt'),
    currentPassword: document.getElementById('editCurrentPassword'),
    newPassword: document.getElementById('editNewPassword'),
    confirmPassword: document.getElementById('editConfirmPassword'),
    // Email verification
    verificationSection: document.getElementById('profileEditVerification'),
    verificationCode: document.getElementById('editEmailVerificationCode'),
    sendCodeBtn: document.getElementById('profileEditSendCodeBtn'),
    verificationInfoText: document.getElementById('verificationInfoText'),
  };

  const profileEditState = {
    snapshot: null,
    submitting: false,
    emailVerificationSent: false,
    originalEmail: null,
  };

  function getProfileSnapshot() {
    const pickText = (el) => (el && typeof el.textContent === 'string' ? el.textContent.trim() : '');
    const raw = selfProfileData || {};
    return {
      id: raw.id ?? getCurrentUser()?.id ?? null,
      first_name: raw.first_name ?? pickText(DOM.pfFirstName),
      last_name: raw.last_name ?? pickText(DOM.pfLastName),
      personal_id: raw.personal_id ?? pickText(DOM.pfPersonalId),
      phone: raw.phone ?? pickText(DOM.pfPhone),
      email: raw.email ?? pickText(DOM.pfEmail),
      code: raw.code ?? pickText(DOM.pfCode),
      created_at: raw.created_at ?? null,
      created_at_display: pickText(DOM.pfCreatedAt),
      is_admin: raw.is_admin ?? getCurrentUser()?.isAdmin ?? false,
    };
  }

  function openProfileEdit() {
    if (!profileEditDOM.overlay || profileEditState.submitting) return;
    const snap = getProfileSnapshot();
    profileEditState.snapshot = snap;
    profileEditState.originalEmail = String(snap.email || '').toLowerCase();
    profileEditState.emailVerificationSent = false;

    if (profileEditDOM.firstName) profileEditDOM.firstName.value = String(snap.first_name || '');
    if (profileEditDOM.lastName) profileEditDOM.lastName.value = String(snap.last_name || '');
    if (profileEditDOM.personalId) profileEditDOM.personalId.value = String(snap.personal_id || '');
    if (profileEditDOM.phone) profileEditDOM.phone.value = String(snap.phone || '');
    if (profileEditDOM.email) profileEditDOM.email.value = String(snap.email || '');
    if (profileEditDOM.code) profileEditDOM.code.value = String(snap.code || '');

    const createdDisplay = (() => {
      try {
        const formatted = window.Utils?.formatDateTime?.(snap.created_at);
        if (formatted) return formatted;
      } catch {}
      return String(snap.created_at_display || '');
    })();
    if (profileEditDOM.createdAt) profileEditDOM.createdAt.value = createdDisplay;

    if (profileEditDOM.currentPassword) profileEditDOM.currentPassword.value = '';
    if (profileEditDOM.newPassword) profileEditDOM.newPassword.value = '';
    if (profileEditDOM.confirmPassword) profileEditDOM.confirmPassword.value = '';
    if (profileEditDOM.verificationCode) profileEditDOM.verificationCode.value = '';
    
    // Hide verification section initially
    if (profileEditDOM.verificationSection) profileEditDOM.verificationSection.style.display = 'none';

    profileEditDOM.overlay.classList.add('open');
    profileEditDOM.overlay.setAttribute('aria-hidden', 'false');
    try { profileEditDOM.firstName?.focus?.(); } catch {}
  }

  function checkEmailChanged() {
    const currentEmail = String(profileEditDOM.email?.value || '').trim().toLowerCase();
    return currentEmail !== profileEditState.originalEmail;
  }

  function updateVerificationVisibility() {
    const emailChanged = checkEmailChanged();
    if (profileEditDOM.verificationSection) {
      profileEditDOM.verificationSection.style.display = emailChanged ? 'block' : 'none';
    }
  }

  async function sendEmailVerificationCode() {
    const newEmail = String(profileEditDOM.email?.value || '').trim().toLowerCase();
    if (!newEmail || !utils.isValidEmail(newEmail)) {
      alert('გთხოვთ შეიყვანოთ სწორი ელფოსტა');
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/users/send-verification-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, purpose: 'update' }),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const json = await res.json();
          detail = json?.detail || '';
        } catch {}
        alert(detail || 'კოდის გაგზავნა ვერ მოხერხდა');
        return;
      }
      profileEditState.emailVerificationSent = true;
      if (profileEditDOM.verificationInfoText) {
        profileEditDOM.verificationInfoText.textContent = `კოდი გაგზავნილია: ${newEmail}`;
      }
      alert('ვერიფიკაციის კოდი გაგზავნილია ახალ ელფოსტაზე');
    } catch {
      alert('ქსელური პრობლემა - სცადეთ მოგვიანებით');
    }
  }

  function closeProfileEdit() {
    if (!profileEditDOM.overlay || profileEditState.submitting) return;
    profileEditDOM.overlay.classList.remove('open');
    profileEditDOM.overlay.setAttribute('aria-hidden', 'true');
  }

  function setAuthBannerText(firstName, lastName, code) {
    const text = `${String(firstName || '').trim()} ${String(lastName || '').trim()}`.trim();
    const banner = (text && code) ? `${text} — ${code}` : (text || code || 'გთხოვთ შეხვიდეთ სისტემაში');
    if (DOM.authBanner) DOM.authBanner.textContent = banner;
    if (DOM.drawerAuthBanner) DOM.drawerAuthBanner.textContent = banner;
  }

  function setLocalAuthUser(updatedUser) {
    if (!updatedUser) return;
    const existing = getCurrentUser() || {};
    const normalized = {
      id: updatedUser.id ?? existing.id,
      firstName: updatedUser.first_name ?? updatedUser.firstName ?? existing.firstName,
      lastName: updatedUser.last_name ?? updatedUser.lastName ?? existing.lastName,
      code: updatedUser.code ?? existing.code,
      isAdmin: !!(updatedUser.is_admin ?? updatedUser.isAdmin ?? existing.isAdmin),
      email: updatedUser.email ?? existing.email,
    };
    try { localStorage.setItem('currentUser', JSON.stringify(normalized)); } catch {}
    if (normalized.email) {
      try { localStorage.setItem('savedEmail', String(normalized.email)); } catch {}
    }
    // Keep UI banner in sync
    setAuthBannerText(normalized.firstName, normalized.lastName, normalized.code);
  }

  async function submitProfileEdit(event) {
    event.preventDefault();
    if (profileEditState.submitting) return;
    const snap = profileEditState.snapshot || getProfileSnapshot();

    const first_name = String(profileEditDOM.firstName?.value || '').trim();
    const last_name = String(profileEditDOM.lastName?.value || '').trim();
    const personal_id = String(profileEditDOM.personalId?.value || '').trim();
    const phone = String(profileEditDOM.phone?.value || '').trim();
    const emailRaw = String(profileEditDOM.email?.value || '').trim();
    const email = emailRaw.toLowerCase();

    const current_password = String(profileEditDOM.currentPassword?.value || '');
    const new_password = String(profileEditDOM.newPassword?.value || '');
    const confirm_new_password = String(profileEditDOM.confirmPassword?.value || '');

    if (!first_name || !last_name) {
      alert('გთხოვთ შეიყვანოთ სახელი და გვარი');
      return;
    }
    if (!phone) {
      alert('გთხოვთ შეიყვანოთ ტელეფონი');
      return;
    }
    if (!email || !utils.isValidEmail(email)) {
      alert('ელფოსტა არასწორია');
      return;
    }
    if (personal_id.length !== 11 || !/^[0-9]{11}$/.test(personal_id)) {
      alert('პირადი ნომერი უნდა იყოს 11 ციფრი');
      return;
    }

    const prevEmail = String(snap.email || '').trim().toLowerCase();
    const prevPid = String(snap.personal_id || '').trim();
    const emailChanged = email !== prevEmail;
    const personalIdChanged = personal_id !== prevPid;
    const wantsPasswordChange = !!(new_password.trim() || confirm_new_password.trim());

    // If email changed, require verification code
    const email_verification_code = String(profileEditDOM.verificationCode?.value || '').trim();
    if (emailChanged) {
      if (!email_verification_code || email_verification_code.length !== 4) {
        alert('გთხოვთ შეიყვანოთ 4-ნიშნა ვერიფიკაციის კოდი');
        return;
      }
    }

    if (wantsPasswordChange) {
      if (!new_password.trim()) {
        alert('გთხოვთ შეიყვანოთ ახალი პაროლი');
        return;
      }
      if (new_password.length < 6) {
        alert('პაროლი უნდა იყოს მინიმუმ 6 სიმბოლო');
        return;
      }
      if (!confirm_new_password.trim()) {
        alert('გთხოვთ გაიმეოროთ ახალი პაროლი');
        return;
      }
      if (new_password !== confirm_new_password) {
        alert('პაროლები არ ემთხვევა');
        return;
      }
    }

    // მიმდინარე პაროლი ყოველთვის საჭიროა ნებისმიერი ცვლილებისთვის
    if (!current_password.trim()) {
      alert('გთხოვთ შეიყვანოთ მიმდინარე პაროლი');
      return;
    }

    const payload = {
      first_name,
      last_name,
      personal_id,
      phone,
      email,
      current_password,
    };
    if (emailChanged) {
      payload.email_verification_code = email_verification_code;
    }
    if (wantsPasswordChange) {
      payload.new_password = new_password;
      payload.confirm_new_password = confirm_new_password;
    }

    profileEditState.submitting = true;
    profileEditDOM.submit?.setAttribute?.('disabled', 'true');
    try {
      const res = await fetch(`${API_BASE}/users/profile`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...getActorHeaders() },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        let detail = '';
        try {
          const json = await res.clone().json();
          detail = json?.detail || '';
        } catch {
          try { detail = (await res.clone().text()).trim(); } catch {}
        }
        alert(detail || 'შენახვა ვერ მოხერხდა');
        return;
      }

      const updated = await res.json();
      selfProfileData = updated;

      if (DOM.pfFirstName) DOM.pfFirstName.textContent = updated.first_name || '—';
      if (DOM.pfLastName) DOM.pfLastName.textContent = updated.last_name || '—';
      if (DOM.pfPersonalId) DOM.pfPersonalId.textContent = updated.personal_id || '—';
      if (DOM.pfPhone) DOM.pfPhone.textContent = updated.phone || '—';
      if (DOM.pfEmail) DOM.pfEmail.textContent = updated.email || '—';
      if (DOM.pfCode) DOM.pfCode.textContent = updated.code || '—';
      if (DOM.pfCreatedAt) DOM.pfCreatedAt.textContent = window.Utils?.formatDateTime?.(updated.created_at);
      updatePageTitleFrom(updated);

      // Keep auth state in sync (email/name changes)
      setLocalAuthUser(updated);
      if (wantsPasswordChange) {
        try { localStorage.setItem('savedPassword', new_password); } catch {}
      }

      closeProfileEdit();
      alert('მონაცემები განახლდა');
      // Some parts of the page cache actor email in memory and in download links.
      // Reload only when email changed to keep everything consistent.
      if (emailChanged) {
        try { window.location.reload(); } catch {}
      }
    } catch {
      alert('ქსელური პრობლემა - სცადეთ მოგვიანებით');
    } finally {
      profileEditState.submitting = false;
      profileEditDOM.submit?.removeAttribute?.('disabled');
    }
  }

  function bindProfileEdit() {
    // Self only
    if (VIEW_USER_ID) return;
    if (profileEditDOM.btn) profileEditDOM.btn.style.display = '';
    utils.on(profileEditDOM.btn, 'click', openProfileEdit);
    utils.on(profileEditDOM.close, 'click', closeProfileEdit);
    utils.on(profileEditDOM.form, 'submit', submitProfileEdit);
    
    // Email change detection - show/hide verification section
    utils.on(profileEditDOM.email, 'input', updateVerificationVisibility);
    utils.on(profileEditDOM.sendCodeBtn, 'click', sendEmailVerificationCode);
  }
  bindProfileEdit();

  // Certificate
  let certData = null;
  async function loadCertificate() {
    const user = getCurrentUser();
    const card = DOM.certCard;
    const targetId = VIEW_USER_ID || (user && user.id);
    if (!targetId || !card) return;
    try {
      const res = await fetch(`${API_BASE}/users/${encodeURIComponent(targetId)}/certificate`, { headers: { 'Cache-Control': 'no-cache', ...getActorHeaders() } });
      if (!res.ok) {
        if (res.status === 404) {
          card.classList.add('is-empty');
          if (DOM.certDownloadBtn) DOM.certDownloadBtn.setAttribute('disabled', 'true');
          // Still try to load photo even without certificate
          loadHeaderPhoto(targetId);
          document.dispatchEvent(new CustomEvent('certificate:loaded', { detail: { certData: null } }));
          return;
        }
        return;
      }
      const data = await res.json();
      certData = data;
      card.classList.remove('is-empty');
      try {
        card.dataset.status = String(data.status || '').toLowerCase();
        card.dataset.level = String(data.level || '').toLowerCase();
      } catch {}
      // Disable download if inactive (suspended/expired) or expired by date
      const isExpired = (() => {
        try {
          const dt = window.Utils?.parseUtcDate?.(data.valid_until);
          if (!dt) return false;
          const end = new Date(dt);
          end.setHours(23, 59, 59, 999);
          return end.getTime() < Date.now();
        } catch { return false; }
      })();
      const statusKey = String(data.status || '').trim().toLowerCase();
      const inactive = statusKey === 'suspended' || statusKey === 'expired' || isExpired;
      if (DOM.certDownloadBtn) {
        if (inactive) {
          DOM.certDownloadBtn.setAttribute('disabled', 'true');
        } else {
          DOM.certDownloadBtn.removeAttribute('disabled');
        }
      }
      if (DOM.certCode) DOM.certCode.textContent = data.unique_code || '—';
      if (DOM.certLevel) DOM.certLevel.textContent = formatCertificateLevel(data.level);
      if (DOM.certStatus) DOM.certStatus.textContent = formatCertificateStatus(statusKey, isExpired);
      if (DOM.certIssueDate) DOM.certIssueDate.textContent = window.Utils?.formatDateTime?.(data.issue_date);
      if (DOM.certValidityTerm) DOM.certValidityTerm.textContent = (data.validity_term != null ? String(data.validity_term) : '—');
      if (DOM.certValidUntil) DOM.certValidUntil.textContent = window.Utils?.formatDateTime?.(data.valid_until);
      if (DOM.certExamScore) DOM.certExamScore.textContent = (data.exam_score != null ? `${Math.round(Number(data.exam_score))}%` : '—');
      
      // Load header photo for certified person
      loadHeaderPhoto(targetId);
      document.dispatchEvent(new CustomEvent('certificate:loaded', { detail: { certData: data } }));
    } catch {}
  }
  loadCertificate();

  function getJsPdf() {
    try { return window.jspdf && window.jspdf.jsPDF ? window.jspdf.jsPDF : null; } catch { return null; }
  }

  // Convert certificate level to full Georgian label as printed on the certificate
  function formatCertificateLevel(rawLevel) {
    if (!rawLevel) return '—';
    const value = typeof rawLevel === 'object' ? (rawLevel.key || rawLevel.label || rawLevel) : rawLevel;
    const s = String(value).trim().toLowerCase();
    if (s === 'expert' || s === 'architect_expert' || s === 'არქიტექტორი ექსპერტი' || s === 'არქიტექტურული პროექტის ექსპერტი') {
      return 'არქიტექტურული პროექტის ექსპერტი';
    }
    if (s === 'architect' || s === 'არქიტექტორი' || s === 'შენობა-ნაგებობის არქიტექტორი') {
      return 'შენობა-ნაგებობის არქიტექტორი';
    }
    return String(rawLevel);
  }

  // Convert certificate status to Georgian label
  function formatCertificateStatus(rawStatus, isExpiredFlag) {
    if (isExpiredFlag) return 'ვადაგასული';
    const s = String(rawStatus || '').trim().toLowerCase();
    if (s === 'expired') return 'ვადაგასული';
    if (s === 'suspended' || s === 'paused' || s === 'inactive') return 'შეჩერებული';
    return 'მოქმედი';
  }

  async function handleCertDownload() {
    const user = getCurrentUser();
    const targetId = VIEW_USER_ID || (user && user.id);
    if (!targetId) return;
    if (!certData) {
      alert('სერტიფიკატი არ არის შექმნილი');
      return;
    }
    const url = new URL(`${API_BASE}/users/${encodeURIComponent(targetId)}/certificate/file`);
    url.searchParams.set('t', String(Date.now()));
    window.location.href = url.toString();
  }
  if (DOM.certDownloadBtn) DOM.certDownloadBtn.addEventListener('click', handleCertDownload);

  // Reviews module
  function createReviewsModule() {
    const state = {
      targetUserId: VIEW_USER_ID || (isLoggedIn() ? (getCurrentUser()?.id || null) : null),
      actor: isLoggedIn() ? getCurrentUser() : null,
      actorEmail: (isLoggedIn() && getCurrentUser()?.email) ? String(getCurrentUser().email).trim() : '',
      average: 0,
      ratingsCount: 0,
      actorCriteria: null,
      canRate: false,
      isCertified: false,
      isSelf: false,
    };

    // overlay refs
    const board = {
      overlay: document.getElementById('ratingsOverlay'),
      close: document.getElementById('ratingsClose'),
      form: document.getElementById('criteriaForm'),
      inputs: {
        integrity: document.getElementById('critIntegrity'),
        responsibility: document.getElementById('critResponsibility'),
        knowledge_experience: document.getElementById('critKnowledge'),
        professional_skills: document.getElementById('critSkills'),
        price_quality: document.getElementById('critPrice'),
      },
      values: {
        integrity: document.getElementById('valIntegrity'),
        responsibility: document.getElementById('valResponsibility'),
        knowledge_experience: document.getElementById('valKnowledge'),
        professional_skills: document.getElementById('valSkills'),
        price_quality: document.getElementById('valPrice'),
      },
    };

    function setCertified(value) {
      state.isCertified = !!value;
      if (DOM.reviewsCard) DOM.reviewsCard.classList.toggle('disabled', !state.isCertified);
    }

    function setCanRate(value) {
      state.canRate = !!value;
      if (DOM.reviewStars) {
        DOM.reviewStars.querySelectorAll('.star').forEach((btn) => {
          // Never use the native disabled flag, so we can show login prompt on click
          btn.removeAttribute('disabled');
          btn.setAttribute('aria-disabled', state.canRate ? 'false' : 'true');
        });
      }
    }

    function renderStars(avgValue) {
      if (!DOM.reviewStars) return;
      const n = Math.round(Number(avgValue) || 0);
      DOM.reviewStars.querySelectorAll('.star').forEach((btn) => {
        const val = Number(btn.dataset.value || '0');
        btn.classList.toggle('active', val <= n);
      });
      try {
        const out = document.getElementById('reviewStarsScore');
        if (out && Number.isFinite(Number(state.average))) {
          out.textContent = `${Number(state.average).toFixed(2)}`;
        }
      } catch {}
    }

    function scrollCommentsToBottom() {
      if (!DOM.reviewsComments) return;
      DOM.reviewsComments.scrollTop = DOM.reviewsComments.scrollHeight;
    }

    function renderComments(items) {
      if (!DOM.reviewsComments) return;
      const list = Array.isArray(items) ? items : [];
      const frag = document.createDocumentFragment();
      list.forEach((c) => {
        const el = document.createElement('div');
        el.className = 'comment-item';
        const meta = document.createElement('div');
        meta.className = 'comment-meta';
        const date = window.Utils?.formatDateTime?.(c.created_at);
        const author = `${c.author_first_name || ''} ${c.author_last_name || ''}`.trim() || '—';
        meta.textContent = `${date} · ${author}`;
        const text = document.createElement('div');
        text.className = 'comment-text';
        text.textContent = c.message || '';
        el.appendChild(meta); el.appendChild(text);

        const canDelete = !!(state.actor && (state.actor.isAdmin || Number(state.actor.id) === Number(c.author_user_id)));
        if (canDelete) {
          const del = document.createElement('button');
          del.className = 'comment-delete';
          del.type = 'button';
          del.title = 'კომენტარის წაშლა';
          del.setAttribute('aria-label', 'კომენტარის წაშლა');
          del.textContent = '×';
          del.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!confirm('წავშალო კომენტარი?')) return;
            try {
              const res = await fetch(`${API_BASE}/reviews/${encodeURIComponent(state.targetUserId)}/comments/${encodeURIComponent(c.id)}`, {
                method: 'DELETE',
                headers: { ...(state.actorEmail ? { 'x-actor-email': state.actorEmail } : {}) },
              });
              if (!res.ok) {
                alert('წაშლა ვერ შესრულდა');
                return;
              }
              await loadSummary();
              scrollCommentsToBottom();
            } catch {
              alert('წაშლა ვერ შესრულდა');
            }
          });
          el.appendChild(del);
        }

        frag.appendChild(el);
      });
      DOM.reviewsComments.innerHTML = '';
      DOM.reviewsComments.appendChild(frag);
      scrollCommentsToBottom();
    }

    async function loadSummary() {
      if (!state.targetUserId || !DOM.reviewsCard) return;
      try {
        const res = await fetch(`${API_BASE}/reviews/${encodeURIComponent(state.targetUserId)}/summary`, {
          headers: { 'Cache-Control': 'no-cache', ...getActorHeaders() },
        });
        if (!res.ok) return;
        const data = await res.json();
        state.average = Number(data.average || 0);
        state.ratingsCount = Number(data.ratings_count || 0);
        state.actorCriteria = data.actor_criteria || null;
        if (DOM.reviewsAverage) DOM.reviewsAverage.textContent = state.average.toFixed(2);
        const myAvg = state.actorCriteria ? (Object.values(state.actorCriteria).reduce((a,b)=>a+Number(b||0),0)/5) : state.average;
        renderStars(myAvg);
        renderComments(Array.isArray(data.comments) ? data.comments : []);
      } catch {}
    }

    function openBoard() {
      if (!board.overlay || !state.canRate) return;
      board.overlay.classList.add('open');
      board.overlay.setAttribute('aria-hidden', 'false');
      const init = state.actorCriteria || { integrity: 0, responsibility: 0, knowledge_experience: 0, professional_skills: 0, price_quality: 0 };
      Object.keys(board.inputs).forEach((k) => {
        const input = board.inputs[k];
        const val = Number(init[k] ?? 0);
        input.value = String(val.toFixed(2));
        const out = board.values[k]; if (out) out.textContent = val.toFixed(2);
      });
    }
    function closeBoard() {
      if (!board.overlay) return;
      board.overlay.classList.remove('open');
      board.overlay.setAttribute('aria-hidden', 'true');
    }

    async function submitRating(criteria) {
      if (!state.canRate || !state.targetUserId) return;
      try {
        const res = await fetch(`${API_BASE}/reviews/${encodeURIComponent(state.targetUserId)}/rating`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getActorHeaders() },
          body: JSON.stringify({ criteria }),
        });
        if (!res.ok) {
          let detail = ''; try { const j = await res.clone().json(); detail = j?.detail || ''; } catch {}
          alert(detail || 'შეფასების შენახვა ვერ მოხერხდა'); return;
        }
        const data = await res.json();
        state.average = Number(data.average || 0);
        state.actorCriteria = data.actor_criteria || null;
        if (DOM.reviewsAverage) DOM.reviewsAverage.textContent = state.average.toFixed(2);
        const myAvg = state.actorCriteria ? (Object.values(state.actorCriteria).reduce((a,b)=>a+Number(b||0),0)/5) : state.average;
        renderStars(myAvg);
      } catch { alert('ქულა ვერ შეინახა'); }
    }

    function bindEvents() {
      // open board on click
      if (DOM.reviewsAverage) DOM.reviewsAverage.addEventListener('click', () => { if (!state.canRate) { alert(state.isSelf ? 'საკუთარ თავს შეფასებას ვერ დაუწერთ' : 'გთხოვთ შეხვიდეთ სისტემაში'); return; } openBoard(); });
      if (DOM.reviewStars) DOM.reviewStars.addEventListener('click', () => { if (!state.canRate) { alert(state.isSelf ? 'საკუთარ თავს შეფასებას ვერ დაუწერთ' : 'გთხოვთ შეხვიდეთ სისტემაში'); return; } openBoard(); });
      if (board.close) board.close.addEventListener('click', closeBoard);
      if (board.overlay) board.overlay.addEventListener('click', (e) => { if (e.target === board.overlay) closeBoard(); });

      if (board.form) {
        Object.entries(board.inputs).forEach(([k, input]) => {
          input.addEventListener('input', () => {
            const out = board.values[k]; if (out) out.textContent = Number(input.value || 0).toFixed(2);
          });
        });
        board.form.addEventListener('submit', (e) => {
          e.preventDefault();
          const c = {}; Object.keys(board.inputs).forEach((k) => { c[k] = Number(board.inputs[k].value || 0).toFixed(2); });
          submitRating(c).then(closeBoard);
        });
      }

      if (DOM.reviewCommentForm) {
        DOM.reviewCommentForm.addEventListener('submit', (e) => {
          e.preventDefault();
          if (!state.actorEmail) { alert('გთხოვთ შეხვიდეთ სისტემაში'); return; }
          if (!state.isCertified) return;
          const msg = (DOM.reviewCommentMessage?.value || '').trim();
          if (!msg) return;
          submitComment(msg).then(() => {
            if (DOM.reviewCommentMessage) DOM.reviewCommentMessage.value = '';
          });
        });
      }
    }

    async function submitComment(message) {
      if (!state.isCertified || !state.targetUserId) return;
      try {
        const res = await fetch(`${API_BASE}/reviews/${encodeURIComponent(state.targetUserId)}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getActorHeaders() },
          body: JSON.stringify({ message }),
        });
        if (!res.ok) {
          let detail = ''; try { const j = await res.clone().json(); detail = j?.detail || ''; } catch {}
          alert(detail || 'კომენტარი ვერ დაემატა'); return;
        }
        await loadSummary(); scrollCommentsToBottom();
      } catch { alert('კომენტარი ვერ დაემატა'); }
    }

    function init() {
      // Determine certification (based on previously loaded certData)
      setCertified(!!certData);
      // Self rating disabled
      const isSelf = !!(state.actor && state.targetUserId && state.actor.id === state.targetUserId);
      state.isSelf = isSelf;
      setCanRate(state.isCertified && !isSelf && !!state.actorEmail);
      // React to certificate loading later
      document.addEventListener('certificate:loaded', (ev) => {
        const cd = ev?.detail?.certData || null;
        setCertified(!!cd);
        setCanRate(!!cd && !isSelf && !!state.actorEmail);
      });
      bindEvents();
      loadSummary();
    }

    return { init, loadSummary };
  }

  // Hide statements triggers when viewing other user's page
  if (VIEW_USER_ID) {
    try { document.querySelector('.drawer-statements')?.setAttribute('hidden', ''); } catch {}
  }

  const reviewsModule = createReviewsModule();
  reviewsModule.init();

  // Expert upload module
  function createExpertModule() {
    const state = {
      enabled: false,
      actorEmail: (window.Auth?.getSavedEmail?.() || '').trim(),
      user: getCurrentUser(),
      draftId: null,
      currentDraft: null,
      list: [],
    };

    function canActorAdminDelete() {
      const actor = state.user || getCurrentUser();
      const isFounder = window.Auth?.isFounder?.() === true;
      return !!(actor && (actor.isAdmin || isFounder));
    }

    function setEnabled(value) {
      state.enabled = !!value;
      if (DOM.expertCard) DOM.expertCard.classList.toggle('disabled', !state.enabled);
      if (!state.enabled) return;
      loadList();
    }

    function setCurrent() {
      /* current code badge removed from UI */
    }

    function buildHeaders() {
      const email = (window.Auth?.getSavedEmail?.() || state.actorEmail || (state.user && state.user.email) || '').trim();
      return email ? { 'x-actor-email': email } : {};
    }

    async function adminDeleteUpload(uploadId) {
      try {
        // Prefer POST fallback first to avoid DELETE blockers
        let res = await fetch(`${API_BASE}/expert-uploads/${encodeURIComponent(uploadId)}/delete`, {
          method: 'POST',
          headers: { ...buildHeaders() },
        });
        if (res.status === 405) {
          res = await fetch(`${API_BASE}/expert-uploads/${encodeURIComponent(uploadId)}`, {
            method: 'DELETE',
            headers: { ...buildHeaders() },
          });
        }
        return res;
      } catch {
        return { ok: false, status: 0 };
      }
    }

    async function loadList() {
      if (!state.enabled || !DOM.expertList) return;
      try {
        const res = await fetch(`${API_BASE}/expert-uploads/mine`, { headers: { 'Cache-Control': 'no-cache', ...buildHeaders() } });
        if (!res.ok) return;
        const items = await res.json();
        state.list = Array.isArray(items) ? items : [];
        renderList();
        const draft = state.list.find((x) => x.status === 'draft');
        state.draftId = draft ? draft.id : null;
        state.currentDraft = draft || null;
        setCurrent();
        updateDraftUI(draft || null);
        // Ensure latest submitted project file is visible in the bottom field after submission
        showLatestSubmittedProjectLink();
      } catch {}
    }

    function renderList() {
      const wrap = DOM.expertList;
      if (!wrap) return;
      if (!state.list.length) { wrap.innerHTML = ''; return; }
      const frag = document.createDocumentFragment();

      state.list.forEach((item) => {
        const el = document.createElement('details');
        el.className = 'expert-item';

        // Narrow summary row: unique code (left) + created at (right)
        const summary = document.createElement('summary');
        summary.className = 'item-summary';
        const sumCode = document.createElement('span');
        sumCode.className = 'sum-code';
        sumCode.textContent = item.unique_code;
        const sumDate = document.createElement('span');
        sumDate.className = 'sum-date';
        sumDate.textContent = window.Utils?.formatDateTime?.(item.created_at);
        summary.appendChild(sumCode);
        summary.appendChild(sumDate);
        el.appendChild(summary);

        // Expanded content: two columns (meta + files)
        const content = document.createElement('div');
        content.className = 'content';

        const columns = document.createElement('div');
        columns.className = 'detail-columns';

        const metaCol = document.createElement('div');
        metaCol.className = 'detail-col meta';
        const metaItems = [
          { label: 'საკადასტრო კოდი', value: item.cadastral_code || '—' },
          { label: 'პროექტის სახელწოდება', value: item.building_function || '—' },
          { label: 'პროექტის მისამართი', value: item.project_address || '—' },
        ];
        metaItems.forEach(({ label, value }) => {
          const block = document.createElement('div');
          block.className = 'detail-item';
          const lbl = document.createElement('div');
          lbl.className = 'detail-label';
          lbl.textContent = label;
          const val = document.createElement('div');
          val.className = 'detail-value';
          val.textContent = value || '—';
          block.appendChild(lbl);
          block.appendChild(val);
          metaCol.appendChild(block);
        });

        const filesCol = document.createElement('div');
        filesCol.className = 'detail-col files';
        const addFileRow = (labelText, filename, href) => {
          const block = document.createElement('div');
          block.className = 'detail-item';
          const lbl = document.createElement('div');
          lbl.className = 'detail-label';
          lbl.textContent = labelText;
          block.appendChild(lbl);
          const val = document.createElement('div');
          val.className = 'detail-value';
          if (filename && href) {
            const a = document.createElement('a');
            a.className = 'file-link';
            a.textContent = filename;
            a.href = href;
            a.target = '_blank';
            val.appendChild(a);
          } else {
            val.textContent = '—';
          }
          block.appendChild(val);
          filesCol.appendChild(block);
        };
        addFileRow(
          'ექსპერტიზა',
          item.expertise_filename,
          item.expertise_filename
            ? `${API_BASE}/expert-uploads/${encodeURIComponent(item.id)}/download?file_type=expertise${state.actorEmail ? `&actor=${encodeURIComponent(state.actorEmail)}` : ''}`
            : null
        );
        addFileRow(
          'პროექტი',
          item.project_filename,
          item.project_filename
            ? `${API_BASE}/expert-uploads/${encodeURIComponent(item.id)}/download?file_type=project${state.actorEmail ? `&actor=${encodeURIComponent(state.actorEmail)}` : ''}`
            : null
        );

        columns.appendChild(metaCol);
        columns.appendChild(filesCol);
        content.appendChild(columns);
        el.appendChild(content);

        // Admin/founder-only delete button inside summary
        if (canActorAdminDelete()) {
          const del = document.createElement('button');
          del.className = 'item-delete';
          del.type = 'button';
          del.title = 'წაშლა';
          del.setAttribute('aria-label', 'წაშლა');
          del.textContent = '×';
          del.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation(); // don't toggle details
            if (!confirm('წავშალო ელემენტი?')) return;
            const res = await adminDeleteUpload(item.id);
            if (!res.ok) {
              let detail = '';
              try { const j = await res.clone().json(); detail = j?.detail || ''; } catch { try { detail = (await res.clone().text()).trim(); } catch {} }
              alert(detail || 'წაშლა ვერ შესრულდა');
              return;
            }
            await loadList();
          });
          summary.appendChild(del);
        }

        frag.appendChild(el);
      });
      wrap.innerHTML = '';
      wrap.appendChild(frag);
    }

    function setFileControls(draft) {
      const expDl = DOM.expertExpertiseDownload;
      const expDel = DOM.expertExpertiseDelete;
      const prjDl = DOM.expertProjectDownload;
      const prjDel = DOM.expertProjectDelete;
      const submitted = draft && draft.status === 'submitted';
      if (draft && draft.expertise_filename) {
        if (expDl) { expDl.style.display = ''; expDl.href = `${API_BASE}/expert-uploads/${draft.id}/download?file_type=expertise`; }
        if (expDel) { expDel.style.display = submitted ? 'none' : ''; expDel.disabled = submitted; }
      } else {
        if (expDl) expDl.style.display = 'none';
        if (expDel) expDel.style.display = 'none';
      }
      if (draft && draft.project_filename) {
        if (prjDl) { prjDl.style.display = ''; prjDl.href = `${API_BASE}/expert-uploads/${draft.id}/download?file_type=project`; }
        if (prjDel) { prjDel.style.display = submitted ? 'none' : ''; prjDel.disabled = submitted; }
      } else {
        if (prjDl) prjDl.style.display = 'none';
        if (prjDel) prjDel.style.display = 'none';
      }
      updateClearStates();
    }

    // After submit, always show the latest submitted project file link in the bottom field
    function showLatestSubmittedProjectLink() {
      const prjDl = DOM.expertProjectDownload;
      const prjDel = DOM.expertProjectDelete;
      if (!prjDl) return;
      try {
        const latestSubmitted = state.list.find((x) => x.status === 'submitted' && x.project_filename);
        if (latestSubmitted) {
          prjDl.style.display = '';
          prjDl.href = `${API_BASE}/expert-uploads/${latestSubmitted.id}/download?file_type=project`;
          if (state.actorEmail) prjDl.href += `&actor=${encodeURIComponent(state.actorEmail)}`;
          if (prjDel) prjDel.style.display = 'none';
        }
      } catch {}
    }

    // Clear button state: enabled only when local selection or uploaded file exists
    function updateClearStates() {
      try {
        const d = state.currentDraft;
        const hasLocalExp = !!(DOM.expertFileExpertise && DOM.expertFileExpertise.files && DOM.expertFileExpertise.files.length);
        const hasLocalPrj = !!(DOM.expertFileProject && DOM.expertFileProject.files && DOM.expertFileProject.files.length);
        const hasUploadedExp = !!(d && d.expertise_filename);
        const hasUploadedPrj = !!(d && d.project_filename);
        const expBtn = DOM.expertExpertiseClear || document.getElementById('expertExpertiseClear');
        const prjBtn = DOM.expertProjectClear || document.getElementById('expertProjectClear');
        if (expBtn) expBtn.disabled = !(hasLocalExp || hasUploadedExp);
        if (prjBtn) prjBtn.disabled = !(hasLocalPrj || hasUploadedPrj);
        if (DOM.expertExpertiseChosen) DOM.expertExpertiseChosen.textContent = hasLocalExp ? (DOM.expertFileExpertise.files[0]?.name || '—') : 'No file chosen';
        if (DOM.expertProjectChosen) DOM.expertProjectChosen.textContent = hasLocalPrj ? (DOM.expertFileProject.files[0]?.name || '—') : 'No file chosen';
      } catch {}
    }

    // Clear file field or delete uploaded file if already saved to draft
    async function clearFile(kind) {
      const d = state.currentDraft;
      if (kind === 'expertise') {
        if (DOM.expertFileExpertise && DOM.expertFileExpertise.files && DOM.expertFileExpertise.files.length) {
          DOM.expertFileExpertise.value = '';
          updateClearStates();
          return;
        }
        if (state.draftId && d && d.expertise_filename) {
          try {
            const res = await fetch(`${API_BASE}/expert-uploads/${state.draftId}/file?file_type=expertise`, { method: 'DELETE', headers: { ...buildHeaders() } });
            if (res.ok) await loadList();
          } catch {}
        }
      } else if (kind === 'project') {
        if (DOM.expertFileProject && DOM.expertFileProject.files && DOM.expertFileProject.files.length) {
          DOM.expertFileProject.value = '';
          if (DOM.expertProjectChosen) DOM.expertProjectChosen.textContent = 'No file chosen';
          updateClearStates();
          return;
        }
        if (state.draftId && d && d.project_filename) {
          try {
            const res = await fetch(`${API_BASE}/expert-uploads/${state.draftId}/file?file_type=project`, { method: 'DELETE', headers: { ...buildHeaders() } });
            if (res.ok) await loadList();
          } catch {}
        }
      }
    }

    function updateSubmitEnabled() {
      const draft = state.currentDraft;
      const submitted = !!(draft && draft.status === 'submitted');
      const hasServer = !!(draft && draft.expertise_filename && draft.project_filename);
      const hasLocal = !!(DOM.expertFileExpertise?.files?.length && DOM.expertFileProject?.files?.length);
      if (DOM.expertSubmitBtn) DOM.expertSubmitBtn.disabled = submitted || !(hasServer || hasLocal);
    }

    function updateDraftUI(draft) {
      const submitted = !!(draft && draft.status === 'submitted');
      if (DOM.expertFunction) DOM.expertFunction.value = draft?.building_function || '';
      if (DOM.expertCadastral) DOM.expertCadastral.value = draft?.cadastral_code || '';
      setFileControls(draft);
      updateSubmitEnabled();
    }

    function bindEvents() {
      if (DOM.expertFileExpertise) DOM.expertFileExpertise.addEventListener('change', () => { updateClearStates(); updateSubmitEnabled(); });
      if (DOM.expertFileProject) DOM.expertFileProject.addEventListener('change', () => { updateClearStates(); updateSubmitEnabled(); });
      if (DOM.expertExpertiseClear) DOM.expertExpertiseClear.addEventListener('click', () => clearFile('expertise'));
      if (DOM.expertProjectClear) DOM.expertProjectClear.addEventListener('click', () => clearFile('project'));
      if (DOM.expertExpertiseChoose) DOM.expertExpertiseChoose.addEventListener('click', () => DOM.expertFileExpertise?.click());
      if (DOM.expertProjectChoose) DOM.expertProjectChoose.addEventListener('click', () => DOM.expertFileProject?.click());


      if (DOM.expertExpertiseDelete) DOM.expertExpertiseDelete.addEventListener('click', async () => {
        if (!state.draftId) return;
        try {
          const res = await fetch(`${API_BASE}/expert-uploads/${state.draftId}/file?file_type=expertise`, { method: 'DELETE', headers: { ...buildHeaders() } });
          if (!res.ok) return alert('წაშლა ვერ მოხერხდა');
          await loadList();
        } catch { alert('წაშლა ვერ მოხერხდა'); }
      });
      if (DOM.expertProjectDelete) DOM.expertProjectDelete.addEventListener('click', async () => {
        if (!state.draftId) return;
        try {
          const res = await fetch(`${API_BASE}/expert-uploads/${state.draftId}/file?file_type=project`, { method: 'DELETE', headers: { ...buildHeaders() } });
          if (!res.ok) return alert('წაშლა ვერ მოხერხდა');
          await loadList();
        } catch { alert('წაშლა ვერ მოხერხდა'); }
      });

      if (DOM.expertSubmitBtn) DOM.expertSubmitBtn.addEventListener('click', async () => {
        if (!state.enabled) return;
        // Always persist latest inputs/files before submit
        const fn = (DOM.expertFunction?.value || '').trim();
        const cad = (DOM.expertCadastral?.value || '').trim();
        const addr = (DOM.expertAddress?.value || '').trim();
        const form = new FormData();
        form.set('building_function', fn);
        form.set('cadastral_code', cad);
        if (addr) form.set('project_address', addr);
        const expFile = DOM.expertFileExpertise?.files?.[0] || null;
        const prjFile = DOM.expertFileProject?.files?.[0] || null;
        if (expFile) form.set('expertise', expFile);
        if (prjFile) form.set('project', prjFile);
        try {
          // Create or update draft
          const url = state.draftId ? `${API_BASE}/expert-uploads/${state.draftId}` : `${API_BASE}/expert-uploads`;
          const method = state.draftId ? 'PUT' : 'POST';
          const resSave = await fetch(url, { method, headers: { ...buildHeaders() }, body: form });
          if (!resSave.ok) {
            let detail = '';
            try { const j = await resSave.clone().json(); detail = j?.detail || ''; } catch {}
            alert(detail || 'შენახვა ვერ მოხერხდა');
            return;
          }
          const saved = await resSave.json();
          state.draftId = saved.id;
          state.currentDraft = saved;
          setCurrent(saved.unique_code);
          // Submit
          const res = await fetch(`${API_BASE}/expert-uploads/${state.draftId}/submit`, { method: 'POST', headers: { ...buildHeaders() } });
          if (!res.ok) {
            let detail = '';
            try { const j = await res.clone().json(); detail = j?.detail || ''; } catch {}
            alert(detail || 'გაგზავნა ვერ მოხერხდა');
            return;
          }
          await loadList();
          showLatestSubmittedProjectLink();
          // Clear form inputs and files
          if (DOM.expertFunction) DOM.expertFunction.value = '';
          if (DOM.expertAddress) DOM.expertAddress.value = '';
          if (DOM.expertCadastral) DOM.expertCadastral.value = '';
          if (DOM.expertFileExpertise) DOM.expertFileExpertise.value = '';
          if (DOM.expertFileProject) DOM.expertFileProject.value = '';
          if (DOM.expertExpertiseChosen) DOM.expertExpertiseChosen.textContent = 'No file chosen';
          if (DOM.expertProjectChosen) DOM.expertProjectChosen.textContent = 'No file chosen';
          state.draftId = null;
          state.currentDraft = null;
          setCurrent();
          updateClearStates();
          updateSubmitEnabled();
        } catch { alert('გაგზავნა ვერ მოხერხდა'); }
      });
    }

    function init() {
      // Public view: show submitted uploads list for that user, hide editing UI
      if (VIEW_USER_ID) {
        const form = document.getElementById('expertForm');
        const actions = document.querySelector('.expert-actions');
        if (form) form.style.display = 'none';
        if (actions) actions.style.display = 'none';
        if (DOM.expertCard) DOM.expertCard.classList.remove('disabled');
        (async () => {
          try {
            const res = await fetch(`${API_BASE}/expert-uploads/of/${encodeURIComponent(VIEW_USER_ID)}`, {
              headers: { 'Cache-Control': 'no-cache' },
            });
            if (!res.ok) return;
            const items = await res.json();
            const wrap = DOM.expertList;
            if (!wrap) return;
            if (!Array.isArray(items) || !items.length) { wrap.innerHTML = ''; return; }
            const frag = document.createDocumentFragment();
            items.forEach((item) => {
              const el = document.createElement('details');
              el.className = 'expert-item';

              // Summary row: code + created_at
              const summary = document.createElement('summary');
              summary.className = 'item-summary';
              const sumCode = document.createElement('span');
              sumCode.className = 'sum-code';
              sumCode.textContent = item.unique_code;
              const sumDate = document.createElement('span');
              sumDate.className = 'sum-date';
              sumDate.textContent = window.Utils?.formatDateTime?.(item.created_at);
              summary.appendChild(sumCode);
              summary.appendChild(sumDate);
              el.appendChild(summary);

              // Expanded content: two columns (meta + files)
              const content = document.createElement('div');
              content.className = 'content';

              const columns = document.createElement('div');
              columns.className = 'detail-columns';

              const metaCol = document.createElement('div');
              metaCol.className = 'detail-col meta';
              const metaItems = [
                { label: 'საკადასტრო კოდი', value: item.cadastral_code || '—' },
                { label: 'პროექტის სახელწოდება', value: item.building_function || '—' },
                { label: 'პროექტის მისამართი', value: item.project_address || '—' },
              ];
              metaItems.forEach(({ label, value }) => {
                const block = document.createElement('div');
                block.className = 'detail-item';
                const lbl = document.createElement('div');
                lbl.className = 'detail-label';
                lbl.textContent = label;
                const val = document.createElement('div');
                val.className = 'detail-value';
                val.textContent = value || '—';
                block.appendChild(lbl);
                block.appendChild(val);
                metaCol.appendChild(block);
              });

              const filesCol = document.createElement('div');
              filesCol.className = 'detail-col files';
              const addFileRow = (labelText, filename, href) => {
                const block = document.createElement('div');
                block.className = 'detail-item';
                const lbl = document.createElement('div');
                lbl.className = 'detail-label';
                lbl.textContent = labelText;
                const val = document.createElement('div');
                val.className = 'detail-value';
                if (filename && href) {
                  const a = document.createElement('a');
                  a.className = 'file-link';
                  a.textContent = filename;
                  a.href = href;
                  a.target = '_blank';
                  val.appendChild(a);
                } else {
                  val.textContent = '—';
                }
                block.appendChild(lbl);
                block.appendChild(val);
                filesCol.appendChild(block);
              };
              addFileRow(
                'ექსპერტიზა',
                item.expertise_filename,
                item.expertise_filename
                  ? `${API_BASE}/expert-uploads/public/${encodeURIComponent(item.id)}/download?file_type=expertise`
                  : null
              );
              addFileRow(
                'პროექტი',
                item.project_filename,
                item.project_filename
                  ? `${API_BASE}/expert-uploads/public/${encodeURIComponent(item.id)}/download?file_type=project`
                  : null
              );

              columns.appendChild(metaCol);
              columns.appendChild(filesCol);
              content.appendChild(columns);

              el.appendChild(content);

              // Admin/founder-only delete button inside summary (public view)
              if (canActorAdminDelete()) {
                const del = document.createElement('button');
                del.className = 'item-delete';
                del.type = 'button';
                del.title = 'წაშლა';
                del.setAttribute('aria-label', 'წაშლა');
                del.textContent = '×';
                del.addEventListener('click', async (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!confirm('წავშალო ელემენტი?')) return;
                  const res2 = await adminDeleteUpload(item.id);
                  if (!res2.ok) {
                    let detail = '';
                    try { const j = await res2.clone().json(); detail = j?.detail || ''; } catch { try { detail = (await res2.clone().text()).trim(); } catch {} }
                    alert(detail || 'წაშლა ვერ შესრულდა'); return;
                  }
                  el.remove();
                });
                summary.appendChild(del);
              }

              frag.appendChild(el);
            });
            wrap.innerHTML = '';
            wrap.appendChild(frag);
          } catch {}
        })();
        return;
      }

      // Owner view
      bindEvents();
      // Enabled only if certificate level == expert
      setEnabled(!VIEW_USER_ID && !!(certData && (String(certData.level || '').toLowerCase() === 'expert')));
      document.addEventListener('certificate:loaded', (ev) => {
        const cd = ev?.detail?.certData || null;
        setEnabled(!VIEW_USER_ID && !!(cd && (String(cd.level || '').toLowerCase() === 'expert')));
      });
      updateClearStates();
    }

    return { init, setEnabled };
  }

  const expertModule = createExpertModule();
  expertModule.init();

  // Logo scroll handled by script.js

  const goHome = (e) => {
    if (e) e.preventDefault();
    window.location.href = 'index.html';
  };
  if (DOM.homeBtn) DOM.homeBtn.addEventListener('click', goHome);
  if (DOM.drawerHomeBtn) DOM.drawerHomeBtn.addEventListener('click', goHome);

  // goIndex not needed; anchors use native navigation
  // Personal page behavior:
  // - Registry: open local modal (no navigation)
  // statements click handled by header.js (opens modal directly)

  // Registry modal is initialized globally in script.js; use DOM to close if needed

  // Exam dropdown handled by script.js

  // Drawer submenu toggle handled by script.js
  // Drawer submenu handled by script.js

  const openMenu = () => {
    DOM.body.classList.add('menu-open');
    if (DOM.burger) DOM.burger.setAttribute('aria-expanded', 'true');
  };
  const closeMenu = () => {
    DOM.body.classList.remove('menu-open');
    if (DOM.burger) DOM.burger.setAttribute('aria-expanded', 'false');
    if (DOM.drawerSubmenu) {
      DOM.drawerSubmenu.setAttribute('hidden', '');
    }
  };
  // Burger/menu events handled by script.js; keep closeMenu for local use

  const menuModule = { close: closeMenu };
});



'use strict';

// Executes the real auth module with synthetic DOM/storage/fetch only. No real
// accounts, email codes, backend, browser profiles or network are contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/script.js'), 'utf8');
const header = fs.readFileSync(path.join(__dirname, '../scripts/header.js'), 'utf8');
const NOTICE_VERSION = '20261105-registration-privacy1';
const authSource = source.slice(source.indexOf('  function createAuthModule()'), source.indexOf('  /* Registry module moved'));
const escapeSource = source.slice(source.indexOf('  // Global escape handling'), source.indexOf('  // Expose fullscreen helpers'));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function harness({ fetchReply, documents } = {}) {
  const ids = new Map(), saved = new Map(), requests = [], notices = [], openedDocuments = [];
  const document = { activeElement: null, listeners: new Map(),
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); },
    getElementById(id) { return ids.get(id) || null; }, querySelector() { return null; },
    dispatchEvent(event) { return this.fire(event.type, event); },
    async fire(type, fields = {}) { const event = { type, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...fields };
      for (const fn of this.listeners.get(type) || []) await fn(event); return event; },
  };
  class Element {
    constructor(id = '') {
      this.id = id; this.style = {}; this.dataset = {}; this.attributes = {}; this.listeners = new Map();
      this.hidden = false; this.disabled = false; this.checked = false; this.value = ''; this.isConnected = true;
      this.children = []; this.fields = {}; this.textContent = ''; this.innerHTML = '';
      const classes = new Set(); this.classList = { add: (...names) => names.forEach(n => classes.add(n)),
        remove: (...names) => names.forEach(n => classes.delete(n)), contains: n => classes.has(n),
        toggle(name, force) { if (force === undefined) force = !classes.has(name); force ? classes.add(name) : classes.delete(name); return force; } };
      if (id) ids.set(id, this);
    }
    addEventListener(type, fn) { const list = this.listeners.get(type) || []; list.push(fn); this.listeners.set(type, list); }
    async fire(type, fields = {}) { const event = { type, target: this, currentTarget: this,
      preventDefault() { this.defaultPrevented = true; }, ...fields };
      for (const fn of this.listeners.get(type) || []) await fn(event); return event; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    removeAttribute(name) { delete this.attributes[name]; }
    focus() { document.activeElement = this; }
    getClientRects() { return this.hidden || this.style.display === 'none' ? [] : [{}]; }
    reset() { Object.values(this.fields).forEach(element => { element.value = ''; }); }
    querySelector(selector) {
      const name = selector.match(/input\[name="([^"]+)"\]/)?.[1];
      if (name) return this.fields[name] || null;
      if (selector === '#registerStep2 .submit') return ids.get('registerSubmit');
      return null;
    }
    querySelectorAll() { return this.children.filter(element => !element.disabled); }
  }
  document.body = new Element('body');
  const DOM = { body: document.body };
  for (const key of ['loginModal', 'modalClose', 'modalButtons', 'loginForm', 'registerForm', 'forgotPasswordForm',
    'loginOption', 'registerOption', 'forgotPasswordLink', 'loginBtn', 'drawerLoginBtn']) DOM[key] = new Element(key);
  for (const id of ['registrationConsentView', 'registrationConsentTitle', 'registrationConsentCheckbox',
    'registrationConsentContinue', 'registrationConsentCancel', 'registrationPrivacyLink', 'registerStep1', 'registerStep2',
    'registerSendCodeBtn', 'registerBackBtn', 'registerSubmit', 'forgotBackBtn', 'siteInfoModal', 'siteInfoClose']) new Element(id);
  ids.get('registrationConsentView').hidden = true;
  ids.get('registrationConsentContinue').disabled = true;
  DOM.loginModal.children = [DOM.modalClose, ids.get('registrationPrivacyLink'), ids.get('registrationConsentCheckbox'),
    ids.get('registrationConsentContinue'), ids.get('registrationConsentCancel')];
  ids.get('siteInfoModal').children = [ids.get('siteInfoClose')];
  for (const name of ['personalId', 'firstName', 'lastName', 'phone', 'email', 'password', 'confirmPassword', 'verificationCode']) {
    DOM.registerForm.fields[name] = new Element('register-' + name);
  }
  DOM.loginForm.fields.email = new Element('login-email');
  DOM.forgotPasswordForm.fields.email = new Element('forgot-email');
  const window = { location: { pathname: '/pages/index.html', search: '' },
    SiteDocuments: {
      fetchSiteDocuments: documents || (async () => [{ id: 903, title: 'კონფიდენციალურობის პოლიტიკა', content: '<h1>GIPC-POL-002</h1>' }]),
      async openDocumentById(id, options) { openedDocuments.push({ id, options }); ids.get('siteInfoModal').classList.add('show'); },
    },
  };
  const localStorage = { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key) };
  const context = { document, window, DOM, localStorage, URLSearchParams, console,
    API_BASE: 'https://synthetic.invalid', KEYS: { AUTH: 'authLoggedIn', CURRENT_USER: 'currentUser', SAVED_EMAIL: 'savedEmail', USED_CODES: 'usedCodes' },
    utils: { on: (element, event, fn) => element?.addEventListener(event, fn),
      getTrimmed: (form, name) => String(form.get(name) || '').trim(), isValidEmail: value => /^[^@]+@[^@]+\.[^@]+$/.test(value),
      isValidGeorgianName: value => /^[ა-ჰ]+$/.test(value), validatePassword: () => ({ valid: true }) },
    FormData: class { constructor(form) { this.form = form; } get(name) { return this.form.fields[name]?.value || ''; } },
    notify: (...args) => notices.push(args), setButtonLoading: (button, busy) => { if (button) button.disabled = busy; },
    resetPasswordToggles() {}, resetPasswordStrength() {}, setTimeout: callback => { callback(); return 1; },
    setInterval() { throw new Error('Synthetic tests must not schedule real OTP timers'); }, clearInterval() {},
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    fetch: async (url, options) => { assert.ok(url.startsWith('https://synthetic.invalid/')); requests.push({ url, options, body: JSON.parse(options.body) });
      return fetchReply ? fetchReply(url, options) : { ok: true, status: 200, json: async () => ({ id: 901, token: 'synthetic-token', email: 'synthetic@example.invalid', code: 'synthetic-code' }) }; },
    registryModule: { isOpen: () => false, close() {} },
  };
  vm.createContext(context);
  vm.runInContext(authSource + '\nconst authModule = createAuthModule(); globalThis.auth = authModule;\n' + escapeSource, context);
  const auth = context.auth; auth.init();
  const fill = () => {
    const values = { personalId: '00000000000', firstName: 'საცდელი', lastName: 'პირი', phone: '500000000',
      email: 'synthetic@example.invalid', password: 'Synthetic1!', confirmPassword: 'Synthetic1!', verificationCode: '1234' };
    for (const [name, value] of Object.entries(values)) DOM.registerForm.fields[name].value = value;
  };
  const begin = async () => { auth.openModal(); await DOM.registerOption.fire('click'); };
  const accept = async () => { ids.get('registrationConsentCheckbox').checked = true;
    await ids.get('registrationConsentCheckbox').fire('change'); await ids.get('registrationConsentContinue').fire('click'); };
  return { auth, document, DOM, ids, saved, requests, notices, openedDocuments, window, context, fill, begin, accept };
}

test('registration begins with one unchecked consent step and cannot continue without checking it', async () => {
  const h = harness(); await h.begin();
  assert.equal(h.ids.get('registrationConsentView').hidden, false);
  assert.equal(h.DOM.registerForm.style.display, 'none');
  assert.equal(h.ids.get('registrationConsentCheckbox').checked, false);
  assert.equal(h.ids.get('registrationConsentContinue').disabled, true);
  assert.equal(h.document.activeElement.id, 'registrationConsentTitle');
  assert.equal(h.DOM.loginModal.attributes['aria-labelledby'], 'registrationConsentTitle');
  await h.ids.get('registrationConsentContinue').fire('click');
  assert.equal(h.DOM.registerForm.style.display, 'none');
  h.ids.get('registrationConsentCheckbox').checked = true; await h.ids.get('registrationConsentCheckbox').fire('change');
  assert.equal(h.ids.get('registrationConsentContinue').disabled, false);
  h.ids.get('registrationConsentCheckbox').checked = false; await h.ids.get('registrationConsentCheckbox').fire('change');
  assert.equal(h.ids.get('registrationConsentContinue').disabled, true);
  assert.deepEqual(h.requests, []);
});

test('acceptance opens the unchanged first registration step and accompanies OTP and final submission', async () => {
  const h = harness(); await h.begin(); await h.accept(); h.fill();
  assert.equal(h.ids.get('registrationConsentView').hidden, true);
  assert.equal(h.DOM.registerForm.style.display, 'block');
  assert.equal(h.ids.get('registerStep1').style.display, 'block');
  assert.equal(h.document.activeElement.id, 'register-personalId');
  await h.ids.get('registerSendCodeBtn').fire('click');
  assert.equal(h.ids.get('registerStep2').style.display, 'block');
  await h.DOM.registerForm.fire('submit', { submitter: h.ids.get('registerSubmit') });
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[0].body.purpose, 'register');
  assert.equal(h.requests[1].body.verification_code, '1234');
  for (const request of h.requests) {
    assert.equal(request.body.registration_consent_accepted, true);
    assert.equal(request.body.registration_notice_version, NOTICE_VERSION);
  }
  assert.equal(h.saved.get('auth_token'), 'synthetic-token');
  assert.equal(h.auth.isModalOpen(), false);
  await h.begin(); assert.equal(h.ids.get('registrationConsentCheckbox').checked, false);
});

for (const dismissal of ['cancel', 'close', 'escape', 'backdrop']) {
  test(`${dismissal} closes consent, resets the choice, and reopening starts fresh`, async () => {
    const h = harness(); await h.begin();
    h.ids.get('registrationConsentCheckbox').checked = true; await h.ids.get('registrationConsentCheckbox').fire('change');
    if (dismissal === 'cancel') await h.ids.get('registrationConsentCancel').fire('click');
    if (dismissal === 'close') await h.DOM.modalClose.fire('click');
    if (dismissal === 'escape') await h.document.fire('keydown', { key: 'Escape' });
    if (dismissal === 'backdrop') await h.DOM.loginModal.fire('click');
    assert.equal(h.auth.isModalOpen(), false);
    assert.equal(h.ids.get('registrationConsentCheckbox').checked, false);
    await h.begin();
    assert.equal(h.ids.get('registrationConsentContinue').disabled, true);
    assert.deepEqual(h.requests, []);
  });
}

test('unaccepted direct OTP and submit events cannot issue registration requests', async () => {
  const h = harness(); await h.begin(); h.fill();
  await h.ids.get('registerSendCodeBtn').fire('click'); await h.DOM.registerForm.fire('submit');
  assert.deepEqual(h.requests, []); assert.equal(h.ids.get('registrationConsentView').hidden, false);
});

test('closing an accepted flow invalidates its outstanding OTP response without restoring step two', async () => {
  const pending = deferred(); const h = harness({ fetchReply: () => pending.promise });
  await h.begin(); await h.accept(); h.fill();
  const request = h.ids.get('registerSendCodeBtn').fire('click');
  h.auth.closeModal(); await h.begin();
  pending.resolve({ ok: true }); await request;
  assert.equal(h.ids.get('registrationConsentView').hidden, false);
  assert.equal(h.ids.get('registerStep2').style.display, 'none');
  assert.equal(h.notices.length, 0);
});

test('a late registration response after cancellation cannot sign in or resurrect acceptance', async () => {
  const pending = deferred(); const h = harness({ fetchReply: url => url.endsWith('/users/register') ? pending.promise : { ok: true } });
  await h.begin(); await h.accept(); h.fill(); await h.ids.get('registerSendCodeBtn').fire('click');
  const request = h.DOM.registerForm.fire('submit', { submitter: h.ids.get('registerSubmit') });
  h.auth.closeModal();
  pending.resolve({ ok: true, json: async () => ({ id: 901, token: 'late-synthetic-token' }) }); await request;
  assert.equal(h.saved.has('auth_token'), false);
  await h.begin(); assert.equal(h.ids.get('registrationConsentCheckbox').checked, false);
});

test('privacy opens the existing exact policy reader without losing the selected checkbox or closing consent', async () => {
  const h = harness(); await h.begin();
  h.ids.get('registrationConsentCheckbox').checked = true;
  await h.ids.get('registrationPrivacyLink').fire('click');
  assert.equal(h.openedDocuments.length, 1); assert.equal(h.openedDocuments[0].id, 903);
  assert.equal(h.openedDocuments[0].options.returnFocus, h.ids.get('registrationPrivacyLink'));
  await h.document.fire('keydown', { key: 'Escape' });
  assert.equal(h.auth.isModalOpen(), true); assert.equal(h.ids.get('registrationConsentCheckbox').checked, true);
  h.ids.get('siteInfoModal').classList.remove('show');
  await h.document.fire('keydown', { key: 'Escape', defaultPrevented: true });
  assert.equal(h.auth.isModalOpen(), true, 'Reader-first Escape handler must not close underlying consent');
});

test('closing consent while the policy list loads prevents a late reader from appearing', async () => {
  const pending = deferred(); const h = harness({ documents: () => pending.promise }); await h.begin();
  const request = h.ids.get('registrationPrivacyLink').fire('click'); h.auth.closeModal();
  pending.resolve([{ id: 903, title: 'კონფიდენციალურობის პოლიტიკა' }]); await request;
  assert.deepEqual(h.openedDocuments, []);
});

test('a missing or ambiguous privacy document reports failure without choosing a different document', async () => {
  for (const documents of [[], [{ id: 2, title: 'სხვა დოკუმენტი' }], [{ id: 3, title: 'კონფიდენციალურობის პოლიტიკა' }, { id: 4, title: 'კონფიდენციალურობის პოლიტიკა' }]]) {
    const h = harness({ documents: async () => documents }); await h.begin(); await h.ids.get('registrationPrivacyLink').fire('click');
    assert.deepEqual(h.openedDocuments, []); assert.equal(h.notices.at(-1)[1], 'error');
    assert.equal(h.auth.isModalOpen(), true);
  }
});

test('a policy reference inside another official document is not mistaken for the policy itself', async () => {
  const h = harness({ documents: async () => [
    { id: 1, title: 'სერტიფიკაციის სქემა', content: '<h1>GIPC-SCH-001</h1><p>See GIPC-POL-002.</p>' },
    { id: 903, title: 'კონფიდენციალურობის პოლიტიკა', content: '<h1>GIPC-POL-002</h1>' },
  ] });
  await h.begin(); await h.ids.get('registrationPrivacyLink').fire('click');
  assert.deepEqual(h.openedDocuments.map(document => document.id), [903]);
});

test('login and password recovery do not require registration consent or gain backdrop dismissal', async () => {
  const h = harness(); h.auth.openModal(); await h.DOM.loginOption.fire('click');
  assert.equal(h.DOM.loginForm.style.display, 'block'); assert.equal(h.ids.get('registrationConsentView').hidden, true);
  await h.DOM.loginModal.fire('click'); assert.equal(h.auth.isModalOpen(), true);
  await h.DOM.forgotPasswordLink.fire('click');
  assert.equal(h.DOM.forgotPasswordForm.style.display, 'block'); assert.equal(h.ids.get('registrationConsentView').hidden, true);
  assert.deepEqual(h.requests, []);
});

test('keyboard Tab stays inside consent or its overlaid privacy reader', async () => {
  const h = harness(); await h.begin();
  h.ids.get('registrationConsentCancel').focus();
  const next = await h.document.fire('keydown', { key: 'Tab' });
  assert.equal(next.defaultPrevented, true); assert.equal(h.document.activeElement, h.DOM.modalClose);
  await h.document.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(h.document.activeElement.id, 'registrationConsentCancel');
  await h.ids.get('registrationPrivacyLink').fire('click'); h.ids.get('siteInfoClose').focus();
  await h.document.fire('keydown', { key: 'Tab' });
  assert.equal(h.document.activeElement.id, 'siteInfoClose');
  h.ids.get('registrationPrivacyLink').focus();
  const outsideReader = await h.document.fire('keydown', { key: 'Tab' });
  assert.equal(outsideReader.defaultPrevented, true);
  assert.equal(h.document.activeElement.id, 'siteInfoClose');
});

test('the shared reader returns focus to the registration policy link on close', () => {
  const h = harness();
  const closeSource = header.slice(header.indexOf('  function closeSiteInfo()'), header.indexOf('  function bindHeader()'));
  h.context.getSiteInfoElements = () => ({ modal: h.ids.get('siteInfoModal'), body: { innerHTML: 'synthetic policy' } });
  h.context.returnLink = h.ids.get('registrationPrivacyLink');
  vm.runInContext('let currentModalDoc = {}; let siteInfoReturnFocus = returnLink;\n' + closeSource + '\ncloseSiteInfo();', h.context);
  assert.equal(h.document.activeElement, h.ids.get('registrationPrivacyLink'));
});

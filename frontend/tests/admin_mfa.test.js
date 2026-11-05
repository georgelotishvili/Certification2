'use strict';
// Real MFA UI code, synthetic DOM/transport only. No real accounts or services.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../scripts/admin-mfa.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() { await tick(); await tick(); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function harness(handler = () => ({ enrolled: true, verified: false })) {
  const events = new Map(), calls = [], notices = [], timers = new Map();
  const storage = new Map([['auth_token', 'synthetic-login-token']]);
  let nextTimer = 0, storageWrites = 0;
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.handlers = new Map(); this.attributes = {};
      this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this.textContent = ''; this.className = ''; this.id = ''; }
    get isConnected() { return this === document.body || this === document.head || !!this.parentNode?.isConnected; }
    appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
    append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
    replaceChildren(...nodes) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(type, fn) { const list = this.handlers.get(type) || []; list.push(fn); this.handlers.set(type, list); }
    async fire(type, fields = {}) { const event = { type, target: this, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...fields };
      for (const fn of this.handlers.get(type) || []) await fn(event); return event; }
    focus() { document.activeElement = this; }
    getClientRects() { return this.hidden || !this.isConnected ? [] : [{}]; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    checkValidity() { return this.querySelectorAll('input').every(input => !!input.value && (!input.pattern || new RegExp('^' + input.pattern + '$').test(input.value))); }
    matches(selector) {
      if (selector === '[tabindex="0"]') return this.attributes.tabindex === '0';
      if (selector.includes(':not([disabled])')) { if (this.disabled) return false; selector = selector.replace(':not([disabled])', ''); }
      if (selector === 'a.admin-link') return this.tagName === 'A' && this.className === 'admin-link';
      if (selector === '[data-admin-mfa-settings]') return 'data-admin-mfa-settings' in this.attributes;
      return this.tagName.toLowerCase() === selector;
    }
    querySelectorAll(selector) { const selectors = selector.split(',').map(part => part.trim()); const matches = [];
      const walk = parent => parent.children.forEach(node => { if (selectors.some(item => node.matches(item))) matches.push(node); walk(node); }); walk(this); return matches; }
    closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  }
  const document = { activeElement: null, handlers: new Map(),
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    addEventListener(type, fn) { const list = this.handlers.get(type) || []; list.push(fn); this.handlers.set(type, list); },
    async fire(type, fields = {}) { const event = { type, button: 0, preventDefault() { this.defaultPrevented = true; }, ...fields };
      for (const fn of this.handlers.get(type) || []) await fn(event); return event; },
  };
  document.body = new Element('body'); document.head = new Element('head');
  const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data, clone() { return response(status, data); } });
  const window = { document, APP_CONFIG: { API_BASE: 'https://synthetic.invalid' },
    location: { origin: 'https://synthetic.invalid', href: 'https://synthetic.invalid/pages/index.html', pathname: '/pages/index.html' },
    localStorage: { getItem: key => storage.get(key) || null, setItem() { storageWrites++; throw new Error('MFA must not persist credentials'); } },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(type, fn) { const list = events.get(type) || []; list.push(fn); events.set(type, list); },
    showToast: (...args) => notices.push(args),
    qrcode: () => ({ addData(uri) { assert.ok(uri.startsWith('otpauth://')); }, make() {}, getModuleCount: () => 1, isDark: () => true }),
    async fetch(url, options = {}) { const call = { url, options, payload: options.body ? JSON.parse(options.body) : undefined }; calls.push(call);
      const result = await handler(call, calls.length); return result?.status ? response(result.status, result.data) : response(200, result); },
  };
  const context = { window, document, AbortController, URL, console };
  vm.createContext(context); vm.runInContext(source, context);
  const all = () => { const list = []; const walk = node => { list.push(node); node.children.forEach(walk); }; walk(document.body); return list; };
  const find = id => all().find(node => node.id === id);
  const byText = text => all().find(node => node.textContent === text);
  const submit = async value => { const input = find('adminMfaInput'); assert.ok(input); input.value = value; await input.parentNode.fire('submit'); await settle(); };
  const fireWindow = async (type, event = {}) => { for (const fn of events.get(type) || []) await fn(event); await settle(); };
  return { window, document, calls, notices, timers, storage, find, byText, submit, all, fireWindow, get storageWrites() { return storageWrites; } };
}

test('verified server session enters without an unnecessary code form', async () => {
  const h = harness(() => ({ enrolled: true, verified: true }));
  assert.equal(await h.window.AdminMfa.ensureVerified(), true);
  assert.equal(h.calls.length, 1); assert.equal(h.find('adminMfaDialog'), undefined);
});

test('unverified administrator needs one valid code; no data is stored', async () => {
  const h = harness(call => call.url.endsWith('/status') ? { enrolled: true, verified: false } : { verified: true });
  const result = h.window.AdminMfa.ensureVerified(); await settle();
  assert.equal(h.find('adminMfaInput').maxLength, 6);
  await h.submit('123'); assert.equal(h.calls.length, 1);
  await h.submit('123456'); assert.equal(await result, true);
  assert.deepEqual(h.calls[1].payload, { code: '123456' });
  assert.equal(h.storageWrites, 0);
});

test('first enrollment shows local QR and backup codes before continuation', async () => {
  const h = harness(call => {
    if (call.url.endsWith('/status')) return { enrolled: false, verified: false };
    if (call.url.endsWith('/setup')) return { secret: 'SYNTHETICKEY', otpauth_uri: 'otpauth://totp/GIPC:test?secret=SYNTHETICKEY' };
    return { verified: true, recovery_codes: ['SYNTHETIC-ONE', 'SYNTHETIC-TWO'] };
  });
  const result = h.window.AdminMfa.ensureVerified(); await settle();
  await h.submit('Synthetic1!');
  assert.equal(h.find('adminMfaSecret').value, 'SYNTHETICKEY');
  assert.equal(h.all().filter(node => node.tagName === 'SVG').length, 1);
  await h.submit('123456');
  assert.equal(h.find('adminMfaSecret'), undefined);
  assert.equal(h.byText('გაგრძელება').disabled, true);
  const saved = h.find('adminMfaCodesSaved'); saved.checked = true; await saved.fire('change');
  await h.byText('გაგრძელება').fire('click'); assert.equal(await result, true);
  assert.equal(h.find('adminMfaDialog'), undefined); assert.equal(h.storageWrites, 0);
  assert.ok(h.calls.every(call => call.options.cache === 'no-store'));
});

test('password, QR and codes are removed on cancel or logout', async () => {
  for (const dismissal of ['cancel', 'logout']) {
    const h = harness(() => ({ enrolled: false, verified: false }));
    const result = h.window.AdminMfa.ensureVerified(); await settle();
    const input = h.find('adminMfaInput'); input.value = 'SyntheticSecret';
    if (dismissal === 'cancel') await h.find('adminMfaDialog').fire('cancel');
    else await h.fireWindow('auth:logout');
    assert.equal(await result, false); assert.equal(input.value, ''); assert.equal(h.find('adminMfaDialog'), undefined);
  }
});

test('delayed replies after cancel cannot reopen the modal or grant access', async () => {
  const late = deferred(); const h = harness(() => late.promise);
  const result = h.window.AdminMfa.ensureVerified();
  await h.find('adminMfaDialog').fire('cancel'); assert.equal(await result, false);
  late.resolve({ enrolled: true, verified: true }); await settle();
  assert.equal(h.find('adminMfaDialog'), undefined); assert.equal(h.calls.length, 1);
});

test('duplicate clicks share a single request and wrong code leaves a usable form', async () => {
  const h = harness(call => call.url.endsWith('/status') ? { enrolled: true, verified: false }
    : { status: 400, data: { detail: { message: 'კოდი არასწორია' } } });
  const first = h.window.AdminMfa.ensureVerified(), second = h.window.AdminMfa.ensureVerified();
  assert.equal(first, second); await settle();
  await h.submit('123456');
  assert.equal(h.calls.length, 2); assert.equal(h.find('adminMfaInput').disabled, false);
  assert.ok(h.byText('კოდი არასწორია')); await h.find('adminMfaDialog').fire('cancel'); await first;
});

test('backup login allows an alphanumeric code without changing TOTP validation', async () => {
  const h = harness(call => call.url.endsWith('/status') ? { enrolled: true, verified: false } : { verified: true, recovery_code_used: true });
  const result = h.window.AdminMfa.ensureVerified(); await settle();
  await h.byText('სარეზერვო კოდის გამოყენება').fire('click');
  assert.equal(h.find('adminMfaInput').pattern, undefined);
  await h.submit('ABCD-EFGH-IJKL'); assert.equal(await result, true);
  assert.equal(h.calls[1].payload.code, 'ABCD-EFGH-IJKL');
});

test('session token changes invalidate pending MFA response', async () => {
  const late = deferred(); const h = harness(() => late.promise);
  const result = h.window.AdminMfa.ensureVerified();
  h.storage.set('auth_token', 'another-synthetic-login'); await h.fireWindow('storage', { key: 'auth_token' });
  late.resolve({ verified: true }); await settle();
  assert.equal(await result, false); assert.equal(h.find('adminMfaDialog'), undefined);
});

test('a slow status request has a bounded timeout and a retry affordance', async () => {
  const h = harness(call => new Promise((resolve, reject) => {
    call.options.signal.addEventListener('abort', () => { const error = new Error('timeout'); error.name = 'AbortError'; reject(error); });
  }));
  const result = h.window.AdminMfa.ensureVerified();
  const timeout = [...h.timers.values()].find(timer => timer.ms === 20000); assert.ok(timeout);
  timeout.fn(); await settle();
  assert.ok(h.byText('კავშირი შეფერხდა. გადაამოწმეთ სტატუსი ან სცადეთ ხელახლა.'));
  assert.equal(h.byText('სტატუსის გადამოწმება').hidden, false);
  await h.find('adminMfaDialog').fire('cancel'); assert.equal(await result, false);
});

test('keyboard Escape dismisses only the MFA dialog and restores focus', async () => {
  const h = harness(); const previous = h.document.createElement('button'); h.document.body.appendChild(previous); previous.focus();
  const result = h.window.AdminMfa.ensureVerified(); await settle();
  const event = await h.find('adminMfaDialog').fire('keydown', { key: 'Escape' });
  assert.equal(event.defaultPrevented, true); assert.equal(await result, false); assert.equal(h.document.activeElement, previous);
});

test('the dialog traps forward and backward keyboard focus', async () => {
  const h = harness(); const result = h.window.AdminMfa.ensureVerified(); await settle();
  const dialog = h.find('adminMfaDialog');
  const cancel = h.byText('გაუქმება'); cancel.focus();
  const forward = await dialog.fire('keydown', { key: 'Tab' });
  assert.equal(forward.defaultPrevented, true); assert.equal(h.document.activeElement.textContent, '×');
  const backward = await dialog.fire('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(backward.defaultPrevented, true); assert.equal(h.document.activeElement, cancel);
  await dialog.fire('cancel'); await result;
});

test('duplicate submit while verification is pending does not send a second code', async () => {
  const late = deferred(); const h = harness(call => call.url.endsWith('/status') ? { enrolled: true, verified: false } : late.promise);
  const result = h.window.AdminMfa.ensureVerified(); await settle();
  const input = h.find('adminMfaInput'); input.value = '123456';
  await input.parentNode.fire('submit'); await input.parentNode.fire('submit');
  assert.equal(h.calls.length, 2); assert.equal(input.disabled, true);
  late.resolve({ verified: true }); await settle(); assert.equal(await result, true);
});

test('administrative writes are never replayed after an MFA-required response', async () => {
  const h = harness(call => call.url.endsWith('/status') ? { enrolled: true, verified: false }
    : call.url.endsWith('/verify') ? { verified: true }
    : { status: 403, data: { detail: { code: 'ADMIN_MFA_REQUIRED' } } });
  const response = await h.window.fetch('https://synthetic.invalid/admin/synthetic-write', { method: 'POST', body: '{}' });
  assert.equal(response.status, 403); await settle(); await h.submit('123456');
  assert.equal(h.calls.filter(call => call.url.endsWith('synthetic-write')).length, 1);
  assert.equal(h.notices.length, 1); assert.match(h.notices[0][0], /ავტომატურად არ გამეორებულა/);
});

test('normal candidate requests and foreign responses never trigger MFA', async () => {
  const h = harness(call => call.url.includes('foreign.invalid')
    ? { status: 403, data: { detail: { code: 'ADMIN_MFA_REQUIRED' } } }
    : { status: 403, data: { detail: 'Permission denied' } });
  await h.window.fetch('https://synthetic.invalid/users/me');
  await h.window.fetch('https://foreign.invalid/test'); await settle();
  assert.equal(h.calls.length, 2); assert.equal(h.find('adminMfaDialog'), undefined);
});

test('footer navigation waits for verification; cancel leaves the page unchanged', async () => {
  const h = harness();
  const link = h.document.createElement('a'); link.className = 'admin-link'; link.href = 'https://synthetic.invalid/pages/admin.html'; h.document.body.appendChild(link);
  const event = await h.document.fire('click', { target: link }); await settle();
  assert.equal(event.defaultPrevented, true); assert.equal(h.window.location.pathname, '/pages/index.html');
  await h.find('adminMfaDialog').fire('cancel'); await settle();
  assert.equal(h.window.location.href, 'https://synthetic.invalid/pages/index.html');
});

test('account settings support controlled phone rotation and backup regeneration', async () => {
  const h = harness(call => call.url.endsWith('/status') ? { enrolled: true, verified: true }
    : { recovery_codes: ['NEW-SYNTHETIC-CODE'] });
  const result = h.window.AdminMfa.openSettings(); await settle();
  assert.ok(h.byText('Authenticator-ის სხვა ტელეფონზე მიბმა'));
  await h.byText('ახალი სარეზერვო კოდების შექმნა').fire('click'); await h.submit('Synthetic1!');
  assert.deepEqual(h.calls[1].payload, { password: 'Synthetic1!' }); assert.ok(h.calls[1].url.endsWith('/recovery-codes'));
  await h.find('adminMfaDialog').fire('cancel'); await result;
});

test('direct admin bootstrap is gated before any module factory or initialization', () => {
  const admin = fs.readFileSync(path.join(__dirname, '../scripts/admin.js'), 'utf8');
  const bootstrap = admin.slice(admin.indexOf('  async function bootstrapAdmin()'));
  assert.ok(bootstrap.indexOf('await ensureAdminAccess()') < bootstrap.indexOf('const moduleContextBase'));
  assert.match(admin, /await window\.AdminMfa\.ensureVerified\(\)/);
});

test('all footer-bearing pages and direct admin page load the same gated bundle', () => {
  for (const name of ['index', 'documents', 'my', 'registry', 'admin']) {
    const html = fs.readFileSync(path.join(__dirname, `../pages/${name}.html`), 'utf8');
    assert.match(html, /admin-mfa\.js\?v=20261105-admin-mfa1/);
    assert.match(html, /admin-mfa\.css\?v=20261105-admin-mfa1/);
  }
  assert.doesNotMatch(source, /localStorage\.setItem|sessionStorage|console\.(?:log|debug)|https:\/\/[^'"\s]+qr/i);
});

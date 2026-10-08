const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workspace = path.resolve(__dirname, '..', '..');
const scriptSource = fs.readFileSync(
  path.join(workspace, 'frontend', 'scripts', 'script.js'),
  'utf8',
);

function logoutHelperSource() {
  const start = scriptSource.indexOf('async function revokeServerSession(token)');
  const end = scriptSource.indexOf('function generateUniqueCode()', start);
  assert.notEqual(start, -1, 'server revoke helper is present');
  assert.notEqual(end, -1, 'logout helper boundary is present');
  return scriptSource.slice(start, end);
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    removals: [],
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      this.removals.push(key);
      values.delete(key);
    },
  };
}

function loadLogoutHelpers(overrides = {}) {
  const localStorage = overrides.localStorage || createStorage();
  const calls = {
    authUi: 0,
    banner: 0,
    admin: 0,
    events: [],
    notifications: [],
    close: 0,
  };
  const context = {
    API_BASE: 'https://gipc.org.ge',
    KEYS: { AUTH: 'authLoggedIn', CURRENT_USER: 'currentUser' },
    localStorage,
    console: { warn: () => {} },
    fetch: overrides.fetch || (async () => ({ ok: true, status: 204 })),
    isLoggedIn: overrides.isLoggedIn || (() => localStorage.getItem('authLoggedIn') === 'true'),
    setLoggedIn: (value) => localStorage.setItem('authLoggedIn', value ? 'true' : 'false'),
    confirm: overrides.confirm || (() => true),
    updateAuthUI: () => { calls.authUi += 1; },
    updateBanner: () => { calls.banner += 1; },
    updateAdminLinkVisibility: () => { calls.admin += 1; },
    document: { dispatchEvent: (event) => calls.events.push(event.type) },
    CustomEvent: class CustomEvent {
      constructor(type) { this.type = type; }
    },
    notify: (...args) => calls.notifications.push(args),
    closeModal: () => { calls.close += 1; },
  };
  vm.createContext(context);
  vm.runInContext(
    `${logoutHelperSource()}\n` +
      'globalThis.__logoutHelpers = { revokeServerSession, clearLocalSession, performLogout };',
    context,
  );
  return { helpers: context.__logoutHelpers, localStorage, calls };
}

test('server revoke posts the captured bearer token to the same API origin', async () => {
  const requests = [];
  const { helpers } = loadLogoutHelpers({
    fetch: async (...args) => {
      requests.push(args);
      throw new Error('offline');
    },
  });

  await assert.doesNotReject(() => helpers.revokeServerSession('web-token'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], 'https://gipc.org.ge/auth/logout');
  const options = JSON.parse(JSON.stringify(requests[0][1]));
  assert.equal(options.method, 'POST');
  assert.deepEqual(options.headers, { Authorization: 'Bearer web-token' });
  assert.equal(options.credentials, 'same-origin');
});

test('local logout clears token and current user before any network result', () => {
  const localStorage = createStorage({
    authLoggedIn: 'true',
    auth_token: 'web-token',
    currentUser: '{"id":7}',
    savedEmail: 'person@example.com',
  });
  const requests = [];
  const { helpers, calls } = loadLogoutHelpers({
    localStorage,
    fetch: (...args) => {
      requests.push(args);
      return Promise.reject(new Error('offline'));
    },
  });

  helpers.performLogout();

  assert.equal(localStorage.getItem('authLoggedIn'), 'false');
  assert.equal(localStorage.getItem('auth_token'), null);
  assert.equal(localStorage.getItem('currentUser'), null);
  assert.equal(localStorage.getItem('savedEmail'), 'person@example.com');
  assert.deepEqual(localStorage.removals, ['auth_token', 'currentUser']);
  assert.equal(requests.length, 1);
  assert.equal(calls.authUi, 1);
  assert.equal(calls.banner, 1);
  assert.equal(calls.admin, 1);
  assert.deepEqual(calls.events, ['auth:logout']);
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.close, 1);
});

test('one localStorage removal failure does not skip current-user cleanup', () => {
  const localStorage = createStorage({
    authLoggedIn: 'true',
    auth_token: 'web-token',
    currentUser: '{"id":7}',
  });
  const originalRemove = localStorage.removeItem.bind(localStorage);
  localStorage.removeItem = (key) => {
    if (key === 'auth_token') {
      localStorage.removals.push(key);
      throw new Error('token storage failure');
    }
    originalRemove(key);
  };
  const { helpers } = loadLogoutHelpers({ localStorage });

  assert.doesNotThrow(() => helpers.clearLocalSession());
  assert.equal(localStorage.getItem('currentUser'), null);
  assert.deepEqual(localStorage.removals, ['auth_token', 'currentUser']);
});

test('cancelled logout leaves local and server sessions untouched', () => {
  const localStorage = createStorage({
    authLoggedIn: 'true',
    auth_token: 'web-token',
    currentUser: '{"id":7}',
  });
  let requestCount = 0;
  const { helpers } = loadLogoutHelpers({
    localStorage,
    confirm: () => false,
    fetch: async () => { requestCount += 1; },
  });

  helpers.performLogout();

  assert.equal(localStorage.getItem('authLoggedIn'), 'true');
  assert.equal(localStorage.getItem('auth_token'), 'web-token');
  assert.notEqual(localStorage.getItem('currentUser'), null);
  assert.equal(requestCount, 0);
});

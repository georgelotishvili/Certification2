const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/admin/statements.js'), 'utf8');

// An isolated DOM model: these tests never contact a browser, database or server.
class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.events = {};
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.checked = false;
    this.disabled = false;
    this.open = false;
    this._text = '';
    this._classes = new Set();
    this.classList = {
      contains: (name) => this._classes.has(name),
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      toggle: (name, enabled = !this._classes.has(name)) => {
        if (enabled) this._classes.add(name);
        else this._classes.delete(name);
        return enabled;
      },
    };
  }
  set className(value) { this._classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) {
    assert.equal(value, '', 'statement content must be rendered as text, never parsed as HTML');
    this._text = '';
    this.children = [];
  }
  appendChild(child) {
    if (child.tagName === '#FRAGMENT') this.children.push(...child.children);
    else this.children.push(child);
    return child;
  }
  append(...children) {
    children.forEach((child) => {
      if (typeof child === 'string') {
        const text = new Element('#text');
        text.textContent = child;
        this.appendChild(text);
      } else this.appendChild(child);
    });
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  async dispatch(name) {
    const event = { target: this, preventDefault() {}, stopPropagation() {} };
    await Promise.all((this.events[name] || []).map((handler) => handler(event)));
  }
  matches(selector) {
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    if (classes.some((name) => !this.classList.contains(name))) return false;
    const tag = selector.match(/^[\w-]+/);
    if (tag && this.tagName !== tag[0].toUpperCase()) return false;
    for (const [, key, value] of selector.matchAll(/\[([\w-]+)="([^\"]*)"\]/g)) {
      const actual = key === 'data-statement-id' ? this.dataset.statementId : (this[key] ?? this.attributes[key]);
      if (String(actual) !== value) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function statement(id, values = {}) {
  return { id, user_id: 1, message: `Statement ${id}`, created_at: '2026-10-08T08:00:00',
    seen_at: null, answered_at: null, ...values };
}

function summary(items, userId) {
  const unseen = items.filter((item) => item.seen_at == null).length;
  const pending = items.filter((item) => item.seen_at != null && item.answered_at == null).length;
  return { user_id: userId, has_unseen_statements: unseen > 0, unseen_statement_count: unseen,
    has_pending_statements: pending > 0, pending_statement_count: pending };
}

function harness(items = [statement(11)], options = {}) {
  const DOM = Object.fromEntries(['userStatementsOverlay', 'userStatementsList',
    'userStatementsMeta', 'userStatementsClose'].map((name) => [name, new Element()]));
  const state = { users: new Map([[1, structuredClone(items)], [2, [statement(21, { user_id: 2 })]]]),
    requests: [], events: [], toasts: [], deferred: [], hold: null, fail: null };
  const window = new Element();
  window.confirm = () => true;
  window.Auth = { getSavedEmail: () => 'admin@example.test' };
  window.dispatchEvent = (event) => { state.events.push(event); return true; };
  const document = new Element('document');
  document.createElement = (name) => new Element(name);
  document.createDocumentFragment = () => new Element('#fragment');
  document.createTextNode = (text) => { const node = new Element('#text'); node.textContent = text; return node; };
  const fetch = async (address, options = {}) => {
    const url = new URL(address);
    const request = { method: options.method || 'GET', path: url.pathname,
      body: options.body ? JSON.parse(options.body) : null };
    state.requests.push(request);
    if (state.fail?.(request)) {
      state.fail = null;
      return { ok: false, status: 500, json: async () => ({ detail: 'Save failed' }) };
    }
    let response;
    if (request.method === 'GET') {
      const match = request.path.match(/^\/admin\/users\/(\d+)\/statements$/);
      assert.ok(match, `unexpected request: ${request.path}`);
      const userId = Number(match[1]);
      const result = { items: structuredClone(state.users.get(userId)), ...summary(state.users.get(userId), userId) };
      response = { ok: true, status: 200, json: async () => result };
    } else if (request.method === 'POST') {
      assert.equal(request.path, '/admin/statements/mark-seen');
      for (const items of state.users.values()) {
        items.forEach((item) => {
          if (request.body.statement_ids.includes(item.id) && item.seen_at == null) item.seen_at = '2026-10-08T09:00:00';
        });
      }
      response = { ok: true, status: 204 };
    } else if (request.method === 'DELETE') {
      const match = request.path.match(/^\/admin\/statements\/(\d+)$/);
      assert.ok(match, `unexpected request: ${request.path}`);
      const statementId = Number(match[1]);
      for (const [userId, items] of state.users) {
        state.users.set(userId, items.filter((item) => item.id !== statementId));
      }
      response = { ok: true, status: 204 };
    } else {
      assert.equal(request.method, 'PATCH');
      const match = request.path.match(/^\/admin\/statements\/(\d+)\/answered$/);
      assert.ok(match, `unexpected request: ${request.path}`);
      let changed;
      let owner;
      for (const [userId, items] of state.users) {
        const item = items.find((candidate) => candidate.id === Number(match[1]));
        if (!item) continue;
        assert.equal(typeof request.body.answered, 'boolean');
        item.answered_at = request.body.answered ? '2026-10-08T09:05:00' : null;
        if (request.body.answered && item.seen_at == null) item.seen_at = item.answered_at;
        changed = structuredClone(item);
        owner = userId;
      }
      assert.ok(changed, 'reply must target an existing statement');
      const result = { statement: changed, ...summary(state.users.get(owner), owner) };
      response = { ok: true, status: 200, json: async () => result };
    }
    if (state.hold?.(request)) {
      state.hold = null;
      return new Promise((resolve) => state.deferred.push(() => resolve(response)));
    }
    return response;
  };
  vm.runInNewContext(source, { window, document, fetch, URL,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
  const module = window.AdminModules.createStatementsModule({ DOM, API_BASE: 'http://test.local',
    isFounderActor: () => options.founder === true,
    on: (node, name, handler) => node?.addEventListener(name, handler),
    formatDateTime: (value) => value, escapeHtml: (value) => String(value ?? ''),
    showToast: (...args) => state.toasts.push(args),
    handleAdminErrorResponse: async () => state.toasts.push(['Save failed', 'error']),
    openOverlay: (node) => node.classList.add('open'), closeOverlay: (node) => node.classList.remove('open'),
  });
  module.init();
  return { DOM, state, module,
    open: (id = 1) => module.open({ id, first_name: `Person ${id}`, email: `person${id}@example.test` }),
    item: (id) => DOM.userStatementsList.querySelector(`.statement-item[data-statement-id="${id}"]`),
    checkbox: (id) => DOM.userStatementsList.querySelector(`.statement-item[data-statement-id="${id}"]`).querySelector('.statement-answered-checkbox'),
    lastEvent: () => state.events.filter((event) => event.type === 'admin:statementsSeen').at(-1)?.detail,
  };
}

async function toggleAnswer(h, id, checked = true) {
  const checkbox = h.checkbox(id);
  checkbox.checked = checked;
  await checkbox.dispatch('change');
}

test('statements render unread, read-unanswered and answered states independently', async () => {
  const h = harness([statement(11), statement(12, { seen_at: '2026-10-08T09:00:00' }),
    statement(13, { seen_at: '2026-10-08T09:00:00', answered_at: '2026-10-08T10:00:00' })]);
  await h.open();
  assert.equal(h.item(11).classList.contains('is-unseen'), true);
  assert.equal(h.item(11).classList.contains('is-pending'), false);
  assert.equal(h.item(12).classList.contains('is-pending'), true);
  assert.equal(h.item(12).classList.contains('is-unseen'), false);
  assert.equal(h.item(13).classList.contains('is-pending'), false);
  assert.equal(h.item(13).classList.contains('is-unseen'), false);
  for (const id of [11, 12, 13]) {
    assert.ok(h.item(id).textContent.includes('პასუხი გაცემულია'));
    assert.equal(h.checkbox(id).checked, id === 13);
  }
});

test('opening an unread statement changes red to pending blue and publishes both counters', async () => {
  const h = harness();
  await h.open();
  h.item(11).open = true;
  await h.item(11).dispatch('toggle');
  assert.equal(h.item(11).classList.contains('is-unseen'), false);
  assert.equal(h.item(11).classList.contains('is-pending'), true);
  assert.equal(h.checkbox(11).checked, false);
  assert.deepEqual(h.state.requests.at(-1).body, { statement_ids: [11] });
  const event = h.lastEvent();
  assert.equal(event.userId, 1);
  assert.equal(event.remainingCount, 0);
  assert.equal(event.hasUnseen, false);
  assert.equal(event.pendingCount, 1);
  assert.equal(event.hasPending, true);
  assert.equal(event.refreshSummary, true);
});

test('answer checkbox persists exactly one statement and removes blue after success', async () => {
  const h = harness([statement(11, { seen_at: '2026-10-08T09:00:00' })]);
  await h.open();
  await toggleAnswer(h, 11);
  assert.deepEqual(h.state.requests.at(-1), { method: 'PATCH', path: '/admin/statements/11/answered', body: { answered: true } });
  assert.equal(h.checkbox(11).checked, true);
  assert.equal(h.checkbox(11).disabled, false);
  assert.equal(h.item(11).classList.contains('is-pending'), false);
  assert.equal(h.item(11).classList.contains('is-unseen'), false);
  assert.equal(h.lastEvent().pendingCount, 0);
  assert.equal(h.lastEvent().hasPending, false);
  assert.equal(h.lastEvent().refreshSummary, true);
});

test('unchecking answered returns a read statement to pending without making it unread', async () => {
  const h = harness([statement(11, { seen_at: '2026-10-08T09:00:00', answered_at: '2026-10-08T10:00:00' })]);
  await h.open();
  await toggleAnswer(h, 11, false);
  assert.equal(h.checkbox(11).checked, false);
  assert.equal(h.item(11).classList.contains('is-pending'), true);
  assert.equal(h.item(11).classList.contains('is-unseen'), false);
  assert.equal(h.lastEvent().pendingCount, 1);
});

test('a new submission starts red with an unchecked answer box while history remains answered', async () => {
  const h = harness([statement(11, { seen_at: '2026-10-08T09:00:00' })]);
  await h.open();
  await toggleAnswer(h, 11);
  h.module.close();
  h.state.users.get(1).unshift(statement(12));
  await h.open();
  assert.equal(h.checkbox(11).checked, true);
  assert.equal(h.item(11).classList.contains('is-unseen'), false);
  assert.equal(h.checkbox(12).checked, false);
  assert.equal(h.item(12).classList.contains('is-unseen'), true);
  h.item(12).open = true;
  await h.item(12).dispatch('toggle');
  assert.equal(h.item(12).classList.contains('is-pending'), true);
  await toggleAnswer(h, 12);
  assert.equal(h.item(12).classList.contains('is-pending'), false);
  assert.equal(h.checkbox(11).checked, true);
});

test('saving disables the checkbox until the answer request has completed', async () => {
  const h = harness([statement(11, { seen_at: '2026-10-08T09:00:00' })]);
  await h.open();
  h.state.hold = (request) => request.method === 'PATCH';
  const save = toggleAnswer(h, 11);
  assert.equal(h.checkbox(11).disabled, true);
  assert.equal(h.state.deferred.length, 1);
  h.state.deferred.shift()();
  await save;
  assert.equal(h.checkbox(11).disabled, false);
  assert.equal(h.checkbox(11).checked, true);
});

test('a failed answer save restores the previous checkbox and pending outline', async () => {
  const h = harness([statement(11, { seen_at: '2026-10-08T09:00:00' })]);
  await h.open();
  h.state.fail = (request) => request.method === 'PATCH';
  await toggleAnswer(h, 11);
  assert.equal(h.checkbox(11).checked, false);
  assert.equal(h.checkbox(11).disabled, false);
  assert.equal(h.item(11).classList.contains('is-pending'), true);
  assert.ok(h.state.toasts.length > 0);
  assert.equal(h.state.users.get(1)[0].answered_at, null);
});

test('failed mark-seen keeps an unread statement red', async () => {
  const h = harness();
  await h.open();
  h.state.fail = (request) => request.method === 'POST';
  await h.module.markStatementsSeen([11]);
  assert.equal(h.item(11).classList.contains('is-unseen'), true);
  assert.equal(h.item(11).classList.contains('is-pending'), false);
});

test('a delayed old user load cannot replace another user in the open dialog', async () => {
  const h = harness();
  h.state.hold = (request) => request.method === 'GET';
  const previousOpen = h.open(1);
  await h.open(2);
  assert.ok(h.item(21));
  h.state.deferred.shift()();
  await previousOpen;
  assert.ok(h.item(21));
  assert.equal(h.item(11), null);
  assert.ok(h.DOM.userStatementsMeta.textContent.includes('Person 2'));
});

for (const operation of ['mark-seen', 'answer']) {
  test(`a delayed ${operation} response cannot change a different user's dialog`, async () => {
    const h = harness();
    await h.open();
    h.state.hold = (request) => request.method === (operation === 'answer' ? 'PATCH' : 'POST');
    const previousRequest = operation === 'answer' ? toggleAnswer(h, 11) : h.module.markStatementsSeen([11]);
    h.module.close();
    await h.open(2);
    const eventCount = h.state.events.length;
    h.state.deferred.shift()();
    await previousRequest;
    assert.ok(h.item(21));
    assert.equal(h.item(21).classList.contains('is-unseen'), true);
    assert.equal(h.checkbox(21).checked, false);
    assert.equal(h.item(11), null);
    assert.equal(h.state.events.length, eventCount, 'stale view must not publish another user summary');
  });
}

test('a delayed mark-seen cannot undo a successfully answered statement', async () => {
  const h = harness();
  await h.open();
  h.state.hold = (request) => request.method === 'POST';
  const reading = h.module.markStatementsSeen([11]);
  await toggleAnswer(h, 11);
  h.state.deferred.shift()();
  await reading;
  assert.equal(h.checkbox(11).checked, true);
  assert.equal(h.item(11).classList.contains('is-unseen'), false);
  assert.equal(h.item(11).classList.contains('is-pending'), false);
  assert.equal(h.lastEvent().pendingCount, 0);
  assert.equal(h.lastEvent().remainingCount, 0);
});

test('reply completion synchronizes a row rebuilt by deleting another statement', async () => {
  const h = harness([statement(11, { seen_at: '2026-10-08T09:00:00' }),
    statement(12, { seen_at: '2026-10-08T09:00:00' })], { founder: true });
  await h.open();
  h.state.hold = (request) => request.method === 'PATCH';
  const replying = toggleAnswer(h, 11);
  const previousRow = h.item(11);
  await h.item(12).querySelector('.statement-delete').dispatch('click');
  assert.equal(h.item(12), null);
  assert.notEqual(h.item(11), previousRow);
  assert.equal(h.checkbox(11).disabled, true, 'replacement checkbox must remain disabled until save completes');
  h.state.deferred.shift()();
  await replying;
  assert.equal(h.checkbox(11).checked, true, 'replacement checkbox must reflect the saved reply');
  assert.equal(h.checkbox(11).disabled, false);
  assert.equal(h.item(11).classList.contains('is-pending'), false);
  assert.equal(h.item(11).classList.contains('is-unseen'), false);
});

test('statement messages remain text and cannot create executable HTML', async () => {
  const message = '<img src=x onerror="alert(1)"><script>globalThis.pwned=true</script>';
  const h = harness([statement(11, { message })]);
  await h.open();
  assert.equal(h.item(11).querySelector('.statement-message-text').textContent, message);
  assert.equal(h.item(11).querySelector('img'), null);
  assert.equal(h.item(11).querySelector('script'), null);
});

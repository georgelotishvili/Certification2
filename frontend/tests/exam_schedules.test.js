const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/admin/exam-schedules.js'), 'utf8');

// These isolated tests never contact a real server or change an account's exam permission.
class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = []; this.events = {}; this.dataset = {}; this.attributes = {}; this.style = {};
    this.value = ''; this.checked = false; this.disabled = false; this._text = ''; this.isConnected = true;
    this._classes = new Set();
    this.classList = {
      contains: (name) => this._classes.has(name),
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      toggle: (name, enabled = !this._classes.has(name)) => {
        if (enabled) this._classes.add(name); else this._classes.delete(name);
        return enabled;
      },
    };
  }
  set className(value) { this._classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) {
    this.children = []; this._text = '';
    if (!value) return;
    // The mount shell is a fixed local template; server data may never use this path.
    assert.ok(value.includes('<h3 class="exam-schedule-title">გამოცდა</h3>'));
    assert.equal(/<script|<img|onerror\s*=/i.test(value), false);
    for (const name of ['date', 'morning', 'evening', 'history', 'status']) {
      const element = new Element(['date', 'morning', 'evening'].includes(name) ? 'input' : 'div');
      element.className = `exam-schedule-${name}`;
      this.appendChild(element);
    }
  }
  appendChild(child) {
    child.parentElement = this;
    if (child.tagName === '#FRAGMENT') this.children.push(...child.children);
    else this.children.push(child);
    return child;
  }
  append(...children) {
    for (let child of children) {
      if (typeof child === 'string') { const node = new Element('#text'); node.textContent = child; child = node; }
      this.appendChild(child);
    }
  }
  replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
  remove() {
    this.isConnected = false;
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.focused = true; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  async dispatch(name) {
    const event = { target: this, preventDefault() {}, stopPropagation() {} };
    await Promise.all((this.events[name] || []).map((handler) => handler(event)));
  }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()));
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    if (classes.some((name) => !this.classList.contains(name))) return false;
    const tag = selector.match(/^[\w-]+/);
    if (tag && this.tagName !== tag[0].toUpperCase()) return false;
    for (const [, key, value] of selector.matchAll(/\[([\w-]+)="([^\"]*)"\]/g)) {
      const dataKey = key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const actual = key.startsWith('data-') ? this.dataset[dataKey] : (this[key] ?? this.attributes[key]);
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

function schedule(id = 11, values = {}) {
  return { id, user_id: 1, exam_date: '2026-10-08', period: 'morning',
    created_at: '2026-10-08T08:00:00', created_by: 7, ...values };
}

function harness(items = [schedule()]) {
  const state = {
    users: new Map([[1, structuredClone(items)], [2, [schedule(21, { user_id: 2, period: 'evening' })]]]),
    requests: [], changed: [], toasts: [], errors: [], deferred: [], hold: null, fail: null,
    failStatus: 500, confirmation: true, confirms: 0,
  };
  const window = new Element('window');
  window.confirm = () => { state.confirms += 1; return state.confirmation; };
  const document = new Element('document');
  document.createElement = (tagName) => new Element(tagName);
  document.createDocumentFragment = () => new Element('#fragment');
  document.createTextNode = (value) => { const node = new Element('#text'); node.textContent = value; return node; };
  const fetch = async (address, options = {}) => {
    const url = new URL(address);
    const request = { method: options.method || 'GET', path: url.pathname,
      body: options.body ? JSON.parse(options.body) : null, headers: options.headers || {} };
    state.requests.push(request);
    const match = request.path.match(/^\/admin\/users\/(\d+)\/exam-schedules(?:\/(\d+))?$/);
    assert.ok(match, `scheduling must not invoke permission or other APIs: ${request.path}`);
    const userId = Number(match[1]);
    let response;
    if (state.fail?.(request)) {
      state.fail = null;
      response = { ok: false, status: state.failStatus, json: async () => ({ detail: 'Save failed' }) };
    } else if (request.method === 'GET') {
      assert.equal(match[2], undefined);
      const result = { items: structuredClone(state.users.get(userId)) };
      response = { ok: true, status: 200, json: async () => result };
    } else if (request.method === 'POST') {
      assert.equal(match[2], undefined);
      assert.deepEqual(Object.keys(request.body).sort(), ['exam_date', 'period']);
      assert.ok(['morning', 'evening'].includes(request.body.period));
      const existing = state.users.get(userId).find((item) => item.exam_date === request.body.exam_date && item.period === request.body.period);
      if (existing) response = { ok: false, status: 409, json: async () => ({ detail: 'Already scheduled' }) };
      else {
        const created = schedule(100 + state.requests.length, { user_id: userId, ...request.body });
        state.users.get(userId).push(created);
        response = { ok: true, status: 201, json: async () => structuredClone(created) };
      }
    } else {
      assert.equal(request.method, 'DELETE');
      assert.ok(match[2]);
      state.users.set(userId, state.users.get(userId).filter((item) => item.id !== Number(match[2])));
      response = { ok: true, status: 204 };
    }
    if (state.hold?.(request)) {
      state.hold = null;
      return new Promise((resolve) => state.deferred.push(() => resolve(response)));
    }
    return response;
  };
  vm.runInNewContext(source, { window, document, fetch, URL, console,
    confirm: window.confirm,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  const module = window.AdminModules.createExamSchedulesModule({ API_BASE: 'http://test.local',
    getAdminHeaders: () => ({ Authorization: 'Bearer test-admin' }),
    getActorHeaders: () => ({ 'X-Actor-Email': 'admin@example.test' }),
    isFounderActor: () => false,
    showToast: (...args) => state.toasts.push(args),
    handleAdminErrorResponse: async (response) => { state.errors.push(response.status); return false; },
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });
  const panel = new Element();
  const h = { state, module, panel,
    mount(id = 1, target = panel) {
      return module.mount(target, { id, first_name: `Person ${id}`, is_admin: false, exam_permission: false },
        { onChanged: (detail) => state.changed.push(detail) });
    },
    field: (name) => panel.querySelector(`.exam-schedule-${name}`),
    deletes: () => panel.querySelectorAll('.exam-schedule-delete'),
    remove: (id) => panel.querySelector(`.exam-schedule-delete[data-id="${id}"]`).dispatch('click'),
    chooseDate: async (value) => { h.field('date').value = value; await h.field('date').dispatch('change'); },
    chooseGroup: async (period, checked = true) => { h.field(period).checked = checked; await h.field(period).dispatch('change'); },
    writes: () => state.requests.filter((request) => request.method !== 'GET'),
  };
  h.control = h.mount();
  return h;
}

test('mounting a collapsed card does not load history or change exam permission', () => {
  const h = harness();
  assert.equal(h.state.requests.length, 0);
  assert.ok(h.field('date'));
  assert.ok(h.field('morning'));
  assert.ok(h.field('evening'));
});

test('loading displays history and provides scheduling controls to a non-founder administrator', async () => {
  const h = harness([schedule(11), schedule(12, { exam_date: '2026-09-01', period: 'evening' })]);
  await h.control.load();
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.requests[0].path, '/admin/users/1/exam-schedules');
  assert.equal(h.state.requests[0].headers.Authorization, 'Bearer test-admin');
  assert.equal(h.deletes().length, 2);
  assert.equal(h.field('date').disabled, false);
  assert.equal(h.field('morning').disabled, false);
  assert.equal(h.field('evening').disabled, false);
  assert.ok(h.field('history').textContent.includes('2026'));
  assert.ok(h.field('history').textContent.includes('დილით'));
  assert.ok(h.field('history').textContent.includes('საღამოს'));
  assert.equal(h.writes().length, 0);
});

test('choosing a date alone does not save a schedule and clears draft group checks', async () => {
  const h = harness();
  await h.control.load();
  h.field('morning').checked = true;
  h.field('evening').checked = true;
  await h.chooseDate('2026-11-20');
  assert.equal(h.field('morning').checked, false);
  assert.equal(h.field('evening').checked, false);
  assert.equal(h.writes().length, 0);
  assert.equal(h.deletes().length, 1);
});

for (const period of ['morning', 'evening']) {
  test(`checking ${period} saves precisely the selected date and group without removing history`, async () => {
    const h = harness();
    await h.control.load();
    await h.chooseDate('2026-11-20');
    await h.chooseGroup(period);
    assert.equal(h.writes().length, 1);
    assert.equal(h.writes()[0].method, 'POST');
    assert.equal(h.writes()[0].path, '/admin/users/1/exam-schedules');
    assert.deepEqual(h.writes()[0].body, { exam_date: '2026-11-20', period });
    assert.equal(h.state.users.get(1).length, 2);
    assert.equal(h.deletes().length, 2);
    assert.equal(h.state.changed.length, 1);
    assert.equal(h.state.changed[0].userId, 1);
  });
}

test('a past date can be saved and input has no future-only minimum', async () => {
  const h = harness();
  await h.control.load();
  assert.ok(!h.field('date').min);
  await h.chooseDate('2020-01-02');
  await h.chooseGroup('morning');
  assert.deepEqual(h.writes()[0].body, { exam_date: '2020-01-02', period: 'morning' });
  assert.equal(h.deletes().length, 2);
});

test('checking a group without a date never creates a schedule', async () => {
  const h = harness();
  await h.control.load();
  await h.chooseDate('');
  await h.chooseGroup('morning');
  assert.equal(h.writes().length, 0);
  assert.equal(h.state.changed.length, 0);
  assert.equal(h.field('morning').checked, false);
});

for (const invalidDate of ['2026-02-30', 'not-a-date', '2026-1-02']) {
  test(`invalid date ${invalidDate} cannot be submitted`, async () => {
    const h = harness();
    await h.control.load();
    await h.chooseDate(invalidDate);
    await h.chooseGroup('morning');
    assert.equal(h.writes().length, 0);
    assert.equal(h.field('morning').checked, false);
    assert.equal(h.deletes().length, 1);
  });
}

test('unchecking a group does not delete saved history', async () => {
  const h = harness();
  await h.control.load();
  await h.chooseDate('2026-11-20');
  await h.chooseGroup('morning');
  const count = h.writes().length;
  await h.chooseGroup('morning', false);
  assert.equal(h.writes().length, count);
  assert.equal(h.deletes().length, 2);
});

test('an administrator can delete one confirmed history entry without altering others', async () => {
  const h = harness([schedule(11), schedule(12, { exam_date: '2026-11-20' })]);
  await h.control.load();
  await h.remove(11);
  assert.equal(h.state.confirms, 1);
  assert.equal(h.writes().length, 1);
  assert.equal(h.writes()[0].method, 'DELETE');
  assert.equal(h.writes()[0].path, '/admin/users/1/exam-schedules/11');
  assert.deepEqual(h.state.users.get(1).map((item) => item.id), [12]);
  assert.equal(h.deletes().length, 1);
  assert.equal(h.state.changed[0].userId, 1);
});

test('cancelling deletion leaves history and the backend unchanged', async () => {
  const h = harness();
  await h.control.load();
  h.state.confirmation = false;
  await h.remove(11);
  assert.equal(h.state.confirms, 1);
  assert.equal(h.writes().length, 0);
  assert.equal(h.deletes().length, 1);
  assert.equal(h.state.changed.length, 0);
});

test('a failed schedule save retains history and unlocks controls', async () => {
  const h = harness();
  await h.control.load();
  await h.chooseDate('2026-11-20');
  h.state.fail = (request) => request.method === 'POST';
  await h.chooseGroup('morning');
  assert.equal(h.deletes().length, 1);
  assert.equal(h.field('date').disabled, false);
  assert.equal(h.field('morning').disabled, false);
  assert.equal(h.field('morning').checked, false);
  assert.equal(h.state.changed.length, 0);
  assert.ok(h.state.toasts.length > 0 || h.field('status').textContent);
});

test('a duplicate schedule never produces a second history entry', async () => {
  const h = harness();
  await h.control.load();
  await h.chooseDate('2026-10-08');
  await h.chooseGroup('morning');
  assert.equal(h.deletes().length, 1);
  assert.equal(h.state.users.get(1).length, 1);
  assert.equal(h.state.changed.length, 0);
  assert.equal(h.field('morning').disabled, false);
});

test('a failed deletion preserves the entry and permits retry', async () => {
  const h = harness();
  await h.control.load();
  h.state.fail = (request) => request.method === 'DELETE';
  await h.remove(11);
  assert.equal(h.deletes().length, 1);
  assert.equal(h.deletes()[0].disabled, false);
  assert.equal(h.state.changed.length, 0);
  await h.remove(11);
  assert.equal(h.deletes().length, 0);
});

for (const status of [401, 403]) {
  test(`authentication failure ${status} reaches the shared administrator error handler`, async () => {
    const h = harness();
    await h.control.load();
    await h.chooseDate('2026-11-20');
    h.state.failStatus = status;
    h.state.fail = (request) => request.method === 'POST';
    await h.chooseGroup('morning');
    assert.deepEqual(h.state.errors, [status]);
    assert.equal(h.deletes().length, 1);
    assert.equal(h.state.changed.length, 0);
  });
}

test('a failed history refresh does not erase previously loaded history', async () => {
  const h = harness();
  await h.control.load();
  h.state.fail = (request) => request.method === 'GET';
  await h.control.load();
  assert.equal(h.deletes().length, 1);
  assert.equal(h.field('date').disabled, false);
});

test('a pending save disables controls and rejects a repeated change event', async () => {
  const h = harness();
  await h.control.load();
  await h.chooseDate('2026-11-20');
  h.state.hold = (request) => request.method === 'POST';
  const saving = h.chooseGroup('morning');
  assert.equal(h.field('date').disabled, true);
  assert.equal(h.field('morning').disabled, true);
  assert.equal(h.field('evening').disabled, true);
  await h.chooseGroup('morning');
  assert.equal(h.writes().length, 1);
  h.state.deferred.shift()();
  await saving;
  assert.equal(h.field('date').disabled, false);
  assert.equal(h.deletes().length, 2);
});

test('a pending delete cannot be submitted twice', async () => {
  const h = harness();
  await h.control.load();
  h.state.hold = (request) => request.method === 'DELETE';
  const button = h.deletes()[0];
  const deleting = button.dispatch('click');
  assert.equal(button.disabled, true);
  await button.dispatch('click');
  assert.equal(h.writes().length, 1);
  h.state.deferred.shift()();
  await deleting;
  assert.equal(h.deletes().length, 0);
});

test('loading history disables writes until the response is ready', async () => {
  const h = harness();
  h.state.hold = (request) => request.method === 'GET';
  const loading = h.control.load();
  assert.equal(h.field('date').disabled, true);
  assert.equal(h.field('morning').disabled, true);
  await h.chooseDate('2026-11-20');
  await h.chooseGroup('morning');
  assert.equal(h.writes().length, 0);
  h.state.deferred.shift()();
  await loading;
  assert.equal(h.field('date').disabled, false);
});

test('repeated load calls share a busy guard instead of racing two history snapshots', async () => {
  const h = harness();
  h.state.hold = (request) => request.method === 'GET';
  const loading = h.control.load();
  await h.control.load();
  assert.equal(h.state.requests.length, 1);
  h.state.deferred.shift()();
  await loading;
  assert.equal(h.deletes().length, 1);
});

test('two users have isolated history and save controls', async () => {
  const h = harness();
  const other = new Element();
  const otherControl = h.mount(2, other);
  await h.control.load();
  await otherControl.load();
  await h.chooseDate('2026-11-20');
  await h.chooseGroup('morning');
  assert.equal(h.deletes().length, 2);
  assert.equal(other.querySelectorAll('.exam-schedule-delete').length, 1);
  assert.equal(h.state.users.get(2).length, 1);
  assert.equal(other.querySelector('.exam-schedule-date').disabled, false);
});

test('late history load cannot replace a panel remounted for another user', async () => {
  const h = harness();
  h.state.hold = (request) => request.method === 'GET';
  const oldLoad = h.control.load();
  const other = h.mount(2);
  await other.load();
  assert.equal(h.deletes().length, 1);
  assert.equal(String(h.deletes()[0].dataset.id), '21');
  h.state.deferred.shift()();
  await oldLoad;
  assert.equal(h.deletes().length, 1);
  assert.equal(String(h.deletes()[0].dataset.id), '21');
});

test('late save response cannot change a panel remounted for another user', async () => {
  const h = harness();
  await h.control.load();
  await h.chooseDate('2026-11-20');
  h.state.hold = (request) => request.method === 'POST';
  const oldSave = h.chooseGroup('morning');
  const other = h.mount(2);
  await other.load();
  h.state.deferred.shift()();
  await oldSave;
  assert.equal(h.deletes().length, 1);
  assert.equal(String(h.deletes()[0].dataset.id), '21');
  assert.equal(h.field('morning').checked, false);
  assert.equal(h.field('date').disabled, false);
});

test('late deletion cannot erase a panel remounted for another user', async () => {
  const h = harness();
  await h.control.load();
  h.state.hold = (request) => request.method === 'DELETE';
  const oldDelete = h.remove(11);
  const other = h.mount(2);
  await other.load();
  h.state.deferred.shift()();
  await oldDelete;
  assert.equal(h.deletes().length, 1);
  assert.equal(String(h.deletes()[0].dataset.id), '21');
  assert.equal(h.field('date').disabled, false);
});

test('untrusted history fields cannot inject executable markup', async () => {
  const malicious = '<img src=x onerror="alert(1)"><script>globalThis.pwned=true</script>';
  const h = harness([schedule(11, { exam_date: malicious, period: malicious })]);
  await h.control.load();
  assert.equal(h.panel.querySelector('img'), null);
  assert.equal(h.panel.querySelector('script'), null);
  assert.equal(h.writes().length, 0);
});

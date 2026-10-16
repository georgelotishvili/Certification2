const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../scripts/admin/exam-schedules.js'), 'utf8');

// Isolated: no email, live requests, permission changes, or certificate issuance.
class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = []; this.events = {}; this.dataset = {}; this.attributes = {}; this.style = {};
    this.value = ''; this.checked = false; this.disabled = false; this._text = ''; this.isConnected = true;
    this.files = []; this.open = false; this.hidden = false; this._classes = new Set();
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
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) {
    this.children = []; this._text = '';
    assert.equal(String(value), '', 'server text must never be rendered as HTML');
  }
  appendChild(child) {
    if (child.tagName === '#FRAGMENT') child.children.forEach((node) => this.appendChild(node));
    else { child.parentElement = this; this.children.push(child); }
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
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
    else if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    else if (['disabled', 'checked', 'hidden', 'multiple', 'required', 'open'].includes(name)) this[name] = true;
    else if (['type', 'value', 'name', 'id', 'min', 'max', 'accept', 'placeholder', 'href', 'title'].includes(name)) this[name] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; if (name in this) this[name] = false; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; (this.events.close || []).forEach((handler) => handler({ target: this })); }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  removeEventListener(name, handler) { this.events[name] = (this.events[name] || []).filter((fn) => fn !== handler); }
  async dispatch(name) {
    const event = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
    await Promise.all((this.events[name] || []).map((handler) => handler(event)));
  }
  dispatchEvent(event) { (this.events[event.type] || []).forEach((handler) => handler(event)); return true; }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()));
    const parts = selector.trim().split(/\s+(?![^\[]*\])/);
    if (parts.length > 1) {
      if (!this.matches(parts.pop())) return false;
      return !!this.parentElement?.closest(parts.join(' '));
    }
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    if (classes.some((name) => !this.classList.contains(name))) return false;
    const tag = selector.match(/^[\w-]+/);
    if (tag && this.tagName !== tag[0].toUpperCase()) return false;
    if (selector.startsWith('#') && this.id !== selector.slice(1)) return false;
    for (const [, key, double, single, unquoted] of selector.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)) {
      const dataKey = key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      const actual = key.startsWith('data-') ? this.dataset[dataKey] : (this[key] ?? this.attributes[key]);
      const value = double ?? single ?? unquoted;
      if (value === undefined ? actual === undefined : String(actual) !== value) return false;
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

function template(kind = 'exam', values = {}) {
  return { kind, subject: `${kind} [სახელი და გვარი]`,
    body: '[სახელი და გვარი], [გამოცდის თარიღი], [თარიღი], [საათი], [უნიკალური კოდი]',
    updated_at: '2026-10-13T08:00:00', attachment_name: null, ...values };
}

function letter(id = 51, values = {}) {
  return { id, user_id: 1, kind: 'exam', event_date: '2026-10-15', event_time: '10:30',
    period: 'morning', subject: 'Exam appointment', body: 'Please attend',
    to_email: 'person1@example.test', status: 'sent', created_at: '2026-10-13T09:00:00',
    sent_at: '2026-10-13T09:01:00', attachment_name: null, ...values };
}

function harness({ schedules = [schedule()], letters = [], templates = [template(), template('certificate')] } = {}) {
  const state = {
    users: new Map([[1, structuredClone(schedules)], [2, [schedule(21, { user_id: 2, period: 'evening' })]]]),
    letters: new Map([[1, structuredClone(letters)], [2, []]]), templates: structuredClone(templates),
    requests: [], changed: [], toasts: [], errors: [], deferred: [], hold: null, fail: null,
    failStatus: 500, confirmation: true, confirms: 0, postStatus: 'sent', throwAfterSave: false,
  };
  const window = new Element('window');
  window.confirm = () => { state.confirms += 1; return state.confirmation; };
  window.crypto = { randomUUID };
  const document = new Element('document');
  document.body = new Element('body'); document.appendChild(document.body);
  document.createElement = (tagName) => new Element(tagName);
  document.createDocumentFragment = () => new Element('#fragment');
  document.createTextNode = (value) => { const node = new Element('#text'); node.textContent = value; return node; };
  const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  const fetch = async (address, options = {}) => {
    const url = new URL(address);
    const request = { method: options.method || 'GET', path: url.pathname,
      body: options.body instanceof FormData ? Object.fromEntries(options.body.entries()) : options.body ? JSON.parse(options.body) : null,
      headers: options.headers || {} };
    state.requests.push(request);
    const match = request.path.match(/^\/admin\/users\/(\d+)\/(exam-schedules|planning-letters)(?:\/(\d+)(\/retry)?)?$/);
    const templateMatch = request.path.match(/^\/admin\/planning-templates(?:\/(exam|certificate))?$/);
    assert.ok(match || templateMatch, `planning must not invoke permission or other APIs: ${request.path}`);
    let result;
    if (state.fail?.(request)) {
      state.fail = null; result = response({ detail: 'Save failed' }, state.failStatus);
    } else if (templateMatch) {
      if (request.method === 'GET') result = response({ items: structuredClone(state.templates) });
      else {
        assert.equal(request.method, 'PUT'); assert.ok(templateMatch[1]);
        const old = state.templates.find((item) => item.kind === templateMatch[1]);
        Object.assign(old, request.body, { updated_at: '2026-10-13T09:30:00' });
        result = response(structuredClone(old));
      }
    } else {
      const userId = Number(match[1]);
      const collection = match[2] === 'exam-schedules' ? state.users : state.letters;
      if (request.method === 'GET') result = response({ items: structuredClone(collection.get(userId)) });
      else if (request.method === 'DELETE') {
        assert.ok(match[3]); collection.set(userId, collection.get(userId).filter((item) => item.id !== Number(match[3])));
        result = response(null, 204);
      } else if (match[4]) {
        assert.equal(request.method, 'POST');
        const item = collection.get(userId).find((entry) => entry.id === Number(match[3]));
        item.status = state.postStatus; result = response(structuredClone(item));
      } else {
        assert.equal(match[2], 'planning-letters'); assert.equal(request.method, 'POST');
        const existing = collection.get(userId).find((entry) => entry.request_id === request.body.request_id);
        const created = existing || letter(100 + state.requests.length, { user_id: userId, ...request.body, status: state.postStatus });
        if (!existing) collection.get(userId).push(created);
        result = response(structuredClone(created), existing ? 200 : 201);
        if (state.throwAfterSave) { state.throwAfterSave = false; throw new TypeError('Connection lost after accepted request'); }
      }
    }
    if (state.hold?.(request)) {
      state.hold = null;
      return new Promise((resolve) => state.deferred.push(() => resolve(result)));
    }
    return result;
  };
  vm.runInNewContext(source, { window, document, fetch, URL, console, FormData, Blob, File,
    crypto: window.crypto, setTimeout, clearTimeout,
    confirm: window.confirm,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
  });
  const module = window.AdminModules.createExamSchedulesModule({ API_BASE: 'http://test.local',
    getAdminHeaders: () => ({ Authorization: 'Bearer test-admin' }),
    getActorHeaders: () => ({ 'X-Actor-Email': 'admin@example.test' }),
    isFounderActor: () => false,
    showToast: (...args) => state.toasts.push(args),
    handleAdminErrorResponse: async (res) => { state.errors.push(res.status); return false; },
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
  });
  const panel = new Element(); document.body.appendChild(panel);
  const h = { state, module, panel, document,
    mount(id = 1, target = panel) {
      return module.mount(target, { id, first_name: `Person ${id}`, last_name: 'Test', unique_code: `CODE${id}`,
        email: `person${id}@example.test`, is_admin: false, exam_permission: false },
      { onChanged: (detail) => state.changed.push(detail) });
    },
    section: (kind = 'exam') => panel.querySelector(`[data-kind="${kind}"]`),
    field: (name, kind = 'exam') => h.section(kind)?.querySelector(`.planning-${name}`),
    dialog: () => document.querySelector('dialog'),
    dialogField: (name) => h.dialog()?.querySelector(`.planning-${name}`),
    deletes: () => panel.querySelectorAll('.exam-schedule-delete'),
    remove: (id) => panel.querySelector(`.exam-schedule-delete[data-id="${id}"]`).dispatch('click'),
    chooseDate: async (value, kind = 'exam') => { h.field('date', kind).value = value; await h.field('date', kind).dispatch('change'); },
    chooseTime: async (value, kind = 'exam') => { h.field('time', kind).value = value; await h.field('time', kind).dispatch('change'); },
    prepare: async (kind = 'exam') => h.field('prepare', kind).dispatch('click'),
    writes: () => state.requests.filter((request) => request.method !== 'GET'),
  };
  h.control = h.mount();
  return h;
}

test('mounting a collapsed card creates both planning forms but performs no request', () => {
  const h = harness();
  assert.equal(h.state.requests.length, 0);
  for (const kind of ['exam', 'certificate']) {
    assert.ok(h.field('date', kind)); assert.ok(h.field('time', kind));
    assert.ok(h.field('prepare', kind)); assert.ok(h.field('template', kind));
  }
});

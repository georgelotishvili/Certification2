const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../scripts/admin/exam-schedules.js'), 'utf8');

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.events = {};
    this.dataset = {};
    this.attributes = {};
    this.style = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this._text = '';
    this.isConnected = true;
    this.files = [];
    this.open = false;
    this.hidden = false;
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
  set className(value) {
    this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get className() {
    return [...this._classes].join(' ');
  }
  set textContent(value) {
    this._text = String(value);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join('');
  }
  set innerHTML(value) {
    this.children = [];
    this._text = '';
    const html = String(value || '');
    const buttonClasses = [
      ['btn-schedule-exam', 'გამოცდის დაგეგმვა'],
      ['btn-rejection-letter', 'უარყოფითი პასუხი'],
      ['btn-certificate-handover', 'სერტიფიკატის გადაცემა'],
      ['btn-exam-fail-letter', 'ჩაჭრის შეტყობინება'],
      ['btn-custom-letter', 'სხვა შეტყობინება'],
    ];
    if (html.includes('exam-schedule-card-bar')) {
      const bar = new Element('div');
      bar.className = 'exam-schedule-card-bar';
      for (const [cls, label] of buttonClasses) {
        if (html.includes(cls)) {
          const btn = new Element('button');
          btn.className = cls;
          btn.textContent = label;
          bar.appendChild(btn);
        }
      }
      this.appendChild(bar);
    }
  }
  appendChild(child) {
    if (child.tagName === '#FRAGMENT') {
      child.children.forEach((node) => this.appendChild(node));
    } else {
      child.parentElement = this;
      this.children.push(child);
    }
    return child;
  }
  append(...children) {
    for (let child of children) {
      if (typeof child === 'string') {
        const node = new Element('#text');
        node.textContent = child;
        child = node;
      }
      this.appendChild(child);
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this._text = '';
    this.append(...children);
  }
  remove() {
    this.isConnected = false;
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(name, handler) {
    (this.events[name] ||= []).push(handler);
  }
  removeEventListener(name, handler) {
    this.events[name] = (this.events[name] || []).filter((fn) => fn !== handler);
  }
  async dispatch(name) {
    const event = { target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} };
    await Promise.all((this.events[name] || []).map((handler) => handler(event)));
  }
  dispatchEvent(event) {
    (this.events[event.type] || []).forEach((handler) => handler(event));
    return true;
  }
  closest(selector) {
    return this.matches(selector) ? this : this.parentElement?.closest(selector) || null;
  }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()));
    const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
    if (classes.some((name) => !this.classList.contains(name))) return false;
    const tag = selector.match(/^[\w-]+/);
    if (tag && this.tagName !== tag[0].toUpperCase()) return false;
    return true;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function schedule(id = 11, values = {}) {
  return {
    id,
    user_id: 1,
    exam_date: '2026-10-08',
    period: 'morning',
    created_at: '2026-10-08T08:00:00',
    created_by: 7,
    ...values,
  };
}

function letter(id = 51, values = {}) {
  return {
    id,
    user_id: 1,
    kind: 'exam',
    event_date: '2026-10-15',
    event_time: '10:00',
    period: 'morning',
    subject: 'გამოცდაზე დაშვება',
    body: 'მოგესალმებით',
    to_email: 'person1@example.test',
    status: 'sent',
    created_at: '2026-10-13T09:00:00',
    sent_at: '2026-10-13T09:01:00',
    attachment_filename: null,
    ...values,
  };
}

function harness({
  schedules = [schedule()],
  letters = [],
  statements = [],
  examOutcome = { unacknowledged: false, outcome: null },
} = {}) {
  const state = {
    schedules: new Map([[1, structuredClone(schedules)]]),
    letters: new Map([[1, structuredClone(letters)]]),
    statements: new Map([[1, structuredClone(statements)]]),
    outcomes: new Map([[1, structuredClone(examOutcome)]]),
    requests: [],
    changed: [],
    toasts: [],
  };

  const window = new Element('window');
  window.crypto = { randomUUID };
  const document = new Element('document');
  document.body = new Element('body');
  document.appendChild(document.body);
  document.createElement = (tagName) => new Element(tagName);

  const response = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });

  const fetch = async (address, options = {}) => {
    const url = new URL(address);
    const request = {
      method: options.method || 'GET',
      path: url.pathname,
      headers: options.headers || {},
    };
    state.requests.push(request);

    if (request.path === '/admin/planning-templates') {
      return response({
        items: [],
        schedule_times: { morning: '10:00', evening: '14:00' },
      });
    }
    const userMatch = request.path.match(/^\/admin\/users\/(\d+)\/(exam-schedules|planning-letters|statements|exam-outcome)$/);
    assert.ok(userMatch, `unexpected path: ${request.path}`);
    const userId = Number(userMatch[1]);
    const resource = userMatch[2];
    if (resource === 'exam-schedules') return response({ items: state.schedules.get(userId) || [] });
    if (resource === 'planning-letters') return response({ items: state.letters.get(userId) || [] });
    if (resource === 'statements') return response({ items: state.statements.get(userId) || [] });
    if (resource === 'exam-outcome') return response(state.outcomes.get(userId) || {});
    return response({});
  };

  vm.runInNewContext(source, {
    window,
    document,
    fetch,
    URL,
    console,
    FormData,
    Blob,
    File,
    crypto: window.crypto,
    setTimeout,
    clearTimeout,
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options?.detail;
      }
    },
  });

  const module = window.AdminModules.createExamSchedulesModule({
    API_BASE: 'http://test.local',
    getAdminHeaders: () => ({ Authorization: 'Bearer test-admin' }),
    getActorHeaders: () => ({ 'X-Actor-Email': 'admin@example.test' }),
    showToast: (...args) => state.toasts.push(args),
  });

  const card = new Element('div');
  card.className = 'block-card';
  const announcementsBtn = new Element('button');
  announcementsBtn.className = 'btn-user-announcements';
  const badge = new Element('span');
  badge.className = 'btn-scheduled-exams-badge';
  badge.hidden = true;
  announcementsBtn.appendChild(badge);
  const outcomeBadge = new Element('span');
  outcomeBadge.className = 'user-exam-outcome-badge';
  outcomeBadge.hidden = true;
  const panel = new Element('section');
  panel.className = 'user-exam-schedules';
  card.appendChild(announcementsBtn);
  card.appendChild(outcomeBadge);
  card.appendChild(panel);
  document.body.appendChild(card);

  const user = {
    id: 1,
    first_name: 'Person 1',
    last_name: 'Test',
    code: 'CODE1',
    email: 'person1@example.test',
  };

  const control = module.mount(panel, user, {
    onChanged: (detail) => state.changed.push(detail),
  });

  return { state, module, card, panel, badge, outcomeBadge, control, user };
}

test('mounting a collapsed card creates all 5 planning action buttons without network requests', () => {
  const h = harness();
  assert.equal(h.state.requests.length, 0);
  assert.ok(h.panel.querySelector('.btn-schedule-exam'));
  assert.ok(h.panel.querySelector('.btn-rejection-letter'));
  assert.ok(h.panel.querySelector('.btn-certificate-handover'));
  assert.ok(h.panel.querySelector('.btn-exam-fail-letter'));
  assert.ok(h.panel.querySelector('.btn-custom-letter'));
});

test('load() fetches schedules, letters, statements, exam-outcome and templates and updates count badge', async () => {
  const h = harness({
    schedules: [schedule(11)],
    letters: [letter(51, { period: 'rejection' }), letter(52, { kind: 'certificate', period: 'morning' })],
    statements: [{ id: 91, message: 'განცხადება', created_at: '2026-10-10T10:00:00', seen_at: null, answered_at: null }],
  });
  await h.control.load();
  assert.equal(h.badge.textContent, '4');
  assert.equal(h.badge.hidden, false);
  assert.equal(h.panel.querySelector('.btn-rejection-letter').classList.contains('has-rejection-record'), true);
  assert.equal(h.panel.querySelector('.btn-certificate-handover').classList.contains('has-certificate-record'), true);
});

test('load() highlights pass and fail buttons when unacknowledged exam outcome exists', async () => {
  const passHarness = harness({
    examOutcome: { unacknowledged: true, outcome: 'pass_a', category_label: 'A კატეგორიის' },
  });
  await passHarness.control.load();
  assert.equal(passHarness.panel.querySelector('.btn-certificate-handover').classList.contains('has-pending-exam-pass'), true);
  assert.equal(passHarness.outcomeBadge.hidden, false);
  assert.equal(passHarness.outcomeBadge.textContent, '✓ ჩააბარა (A)');

  const failHarness = harness({
    examOutcome: { unacknowledged: true, outcome: 'fail' },
  });
  await failHarness.control.load();
  assert.equal(failHarness.panel.querySelector('.btn-exam-fail-letter').classList.contains('has-pending-exam-fail'), true);
  assert.equal(failHarness.outcomeBadge.hidden, false);
  assert.equal(failHarness.outcomeBadge.textContent, '✕ ჩაიჭრა');
});

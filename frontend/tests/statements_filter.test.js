const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/admin/users.js'), 'utf8');

// Only the DOM operations used by the users list are needed; no browser or server.
class Element {
  constructor() {
    this.children = []; this.events = {}; this.dataset = {}; this.style = {};
    this.selectors = {}; this.attributes = {};
    this.value = ''; this.checked = false; this.disabled = false;
    const classes = new Set();
    this.classList = {
      contains: (name) => classes.has(name),
      toggle: (name, enabled = !classes.has(name)) => enabled ? classes.add(name) : classes.delete(name),
    };
  }
  addEventListener(name, handler) { this.events[name] = handler; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  dispatch(name) { return this.events[name]?.({ target: this, preventDefault() {} }); }
  appendChild(child) {
    if (child.parentElement) child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
  }
  set innerHTML(html) {
    this.children = [];
    const id = html.match(/data-id="([^"]+)"/);
    if (id) {
      const card = new Element();
      card.dataset.id = id[1];
      card.selectors['.btn-user-announcements'] = new Element();
      card.selectors['.head-toggle'] = new Element();
      card.selectors['.block-questions'] = new Element();
      card.selectors['.user-exam-schedules'] = new Element();
      card.selectors['.chk-exam'] = new Element();
      card.selectors['.chk-exam'].checked = /class="chk-exam"[^>]*\bchecked\b/.test(html);
      for (const name of html.match(/class="([^"]+)"/)[1].split(' ')) card.classList.toggle(name, true);
      this.children.push(card);
    }
  }
  get firstElementChild() { return this.children[0] || null; }
  querySelectorAll(selector) {
    return selector === '.block-card' ? this.children.filter((node) => node.classList.contains('block-card')) : [];
  }
  querySelector(selector) {
    if (this.selectors[selector]) return this.selectors[selector];
    const id = selector.match(/^\.block-card\[data-id="([^"]+)"\]$/);
    return id ? this.children.find((node) => node.dataset.id === id[1]) || null : null;
  }
}

function fixture(id, unread, day, level, admin = false, pending = false) {
  return { id, has_unseen_statements: unread, unseen_statement_count: unread ? 1 : 0,
    has_pending_statements: pending, pending_statement_count: pending ? 1 : 0,
    days: [day], first_name: `Person ${id}`, certificate: { level }, is_admin: admin };
}

function harness(options = {}) {
  const DOM = Object.fromEntries(['usersGrid', 'usersSearch', 'usersSort', 'onlyAdmins',
    'filterStatements', 'filterPendingStatements', 'statementsDate', 'clearStatementsDate', 'filterArchitects',
    'filterExperts', 'filterMunicipal', 'filterCertified', 'filterExamMorning', 'filterExamEvening',
    'examScheduleDate', 'clearExamScheduleDate'].map((key) => [key, new Element()]));
  DOM.navLinks = [Object.assign(new Element(), { textContent: 'რეგისტრირებული პირები' })];
  const state = { requests: [], hold: false, pending: [], today: '2026-10-08', items: [
    fixture(1, true, '2026-10-08', 'architect', true),
    fixture(2, false, '2026-10-08', 'expert', true),
    fixture(3, true, '2026-10-07', 'architect'),
    fixture(4, false, '2026-10-07', ''),
    fixture(5, true, '2026-10-08', 'expert'),
  ] };
  const window = new Element();
  const document = Object.assign(new Element(), { hidden: false, createElement: () => new Element() });
  const context = { window, document, URLSearchParams, setInterval: () => 1,
    fetch: async (address) => {
      const url = new URL(address);
      assert.equal(url.pathname, '/admin/users');
      state.requests.push(url.searchParams);
      const day = url.searchParams.get('statement_date');
      const search = url.searchParams.get('search') || '';
      const morning = url.searchParams.get('exam_morning') === 'true';
      const evening = url.searchParams.get('exam_evening') === 'true';
      const examDay = url.searchParams.get('exam_date') || ((morning || evening) ? state.today : '');
      const items = state.items.filter((user) => (!day || user.days.includes(day)) &&
        (!examDay || (user.schedules || []).some((schedule) => schedule.exam_date === examDay &&
          ((!morning && !evening) || (morning && schedule.period === 'morning') || (evening && schedule.period === 'evening')))) &&
        (!url.searchParams.has('only_admins') || user.is_admin) && user.first_name.includes(search));
      const result = { ok: true, json: async () => ({ items: structuredClone(items) }) };
      if (!state.hold) return result;
      state.hold = false;
      return new Promise((resolve) => state.pending.push(() => resolve(result)));
    },
  };
  vm.runInNewContext(source, context);
  const users = window.AdminModules.createUsersModule({ DOM, API_BASE: 'http://test.local',
    on: (node, name, handler) => node?.addEventListener(name, handler),
    formatDateTime: () => '', escapeHtml: (value) => String(value ?? ''),
    isFounderActor: () => false, getAdminHeaders: () => ({}), getActorHeaders: () => ({}),
    examSchedules: options.examSchedules,
  });
  users.init();
  return { DOM, users, state,
    visible: () => DOM.usersGrid.children.filter((card) => card.style.display !== 'none').map((card) => Number(card.dataset.id)),
    card: (id) => DOM.usersGrid.querySelector(`.block-card[data-id="${id}"]`),
    date: async (value = '2026-10-08') => { DOM.statementsDate.value = value; await DOM.statementsDate.dispatch('change'); },
  };
}

function pendingHarness(options = {}) {
  const h = harness(options);
  // 1: unread only; 2: read and unanswered; 3: both unread and pending;
  // 4: no statements; 5: read and answered.
  Object.assign(h.state.items[1], { has_pending_statements: true, pending_statement_count: 1 });
  Object.assign(h.state.items[2], { has_pending_statements: true, pending_statement_count: 2 });
  h.state.items[3].days = [];
  Object.assign(h.state.items[4], { has_unseen_statements: false, unseen_statement_count: 0 });
  h.pending = async (checked = true) => {
    h.DOM.filterPendingStatements.checked = checked;
    await h.DOM.filterPendingStatements.dispatch('change');
  };
  h.newStatements = async (checked = true) => {
    h.DOM.filterStatements.checked = checked;
    await h.DOM.filterStatements.dispatch('change');
  };
  return h;
}

function municipalHarness() {
  const h = pendingHarness();
  h.state.items.push(
    fixture(6, true, '2026-10-08', 'municipal', true),
    fixture(7, false, '2026-10-08', 'municipal', true, true),
    fixture(8, false, '2026-10-07', 'municipal', false, true),
  );
  h.selectCertificate = async (key, checked = true) => {
    h.DOM[key].checked = checked;
    await h.DOM[key].dispatch('change');
  };
  return h;
}

function examFilterHarness(options = {}) {
  const h = pendingHarness(options);
  const schedule = (exam_date, period) => ({ exam_date, period });
  h.state.items[0].schedules = [schedule('2026-10-08', 'morning'), schedule('2026-09-01', 'evening')];
  h.state.items[1].schedules = [schedule('2026-10-08', 'evening'), schedule('2026-11-20', 'morning')];
  h.state.items[2].schedules = [schedule('2026-10-08', 'morning'), schedule('2026-10-08', 'evening')];
  h.state.items[3].schedules = [schedule('2026-09-01', 'morning')];
  h.state.items[4].schedules = [schedule('2026-11-20', 'evening')];
  h.examDate = async (value) => {
    h.DOM.examScheduleDate.value = value;
    await h.DOM.examScheduleDate.dispatch('change');
  };
  h.examGroup = async (period, checked = true) => {
    const checkbox = h.DOM[period === 'morning' ? 'filterExamMorning' : 'filterExamEvening'];
    checkbox.checked = checked;
    await checkbox.dispatch('change');
  };
  return h;
}

test('inactive exam filters do not constrain the existing user list', async () => {
  const h = examFilterHarness();
  await h.users.render();
  assert.deepEqual(h.visible(), [1, 2, 3, 4, 5]);
  for (const key of ['exam_date', 'exam_morning', 'exam_evening']) {
    assert.equal(h.state.requests.at(-1).has(key), false);
  }
});

for (const [period, ids] of [['morning', [1, 3]], ['evening', [2, 3]]]) {
  test(`undated ${period} exam filter asks the backend for the current Tbilisi day`, async () => {
    const h = examFilterHarness();
    await h.examGroup(period);
    assert.deepEqual(h.visible(), ids);
    const query = h.state.requests.at(-1);
    assert.equal(query.get(`exam_${period}`), 'true');
    assert.equal(query.has('exam_date'), false, 'client must not guess today using the computer timezone');
    assert.equal(h.DOM.examScheduleDate.value, '');
  });
}

test('both exam group filters form a union without duplicating a candidate', async () => {
  const h = examFilterHarness();
  await h.examGroup('morning');
  await h.examGroup('evening');
  assert.equal(h.DOM.filterExamMorning.checked, true);
  assert.equal(h.DOM.filterExamEvening.checked, true);
  assert.deepEqual(h.visible(), [1, 2, 3]);
});

test('date-only exam filter includes both groups and supports past and future dates', async () => {
  const h = examFilterHarness();
  await h.examDate('2026-09-01');
  assert.deepEqual(h.visible(), [1, 4]);
  assert.equal(h.state.requests.at(-1).get('exam_date'), '2026-09-01');
  assert.equal(h.DOM.filterExamMorning.checked, false);
  assert.equal(h.DOM.filterExamEvening.checked, false);
  await h.examDate('2026-11-20');
  assert.deepEqual(h.visible(), [2, 5]);
});

test('an explicit date and selected group select only that group on that day', async () => {
  const h = examFilterHarness();
  await h.examGroup('morning');
  await h.examDate('2026-09-01');
  assert.deepEqual(h.visible(), [4]);
  await h.examDate('2026-11-20');
  assert.deepEqual(h.visible(), [2]);
  await h.examGroup('evening');
  assert.deepEqual(h.visible(), [2, 5]);
  await h.examGroup('morning', false);
  assert.deepEqual(h.visible(), [5]);
});

test('clearing the exam date retains group selection and returns to the current day', async () => {
  const h = examFilterHarness();
  assert.equal(h.DOM.clearExamScheduleDate.disabled, true);
  await h.examGroup('morning');
  await h.examDate('2026-09-01');
  assert.equal(h.DOM.clearExamScheduleDate.disabled, false);
  await h.DOM.clearExamScheduleDate.dispatch('click');
  assert.equal(h.DOM.examScheduleDate.value, '');
  assert.equal(h.DOM.clearExamScheduleDate.disabled, true);
  assert.equal(h.DOM.filterExamMorning.checked, true);
  assert.equal(h.state.requests.at(-1).has('exam_date'), false);
  assert.deepEqual(h.visible(), [1, 3]);
});

test('turning both exam groups off preserves a selected date and includes both groups', async () => {
  const h = examFilterHarness();
  await h.examDate('2026-11-20');
  await h.examGroup('morning');
  await h.examGroup('morning', false);
  assert.equal(h.DOM.examScheduleDate.value, '2026-11-20');
  assert.deepEqual(h.visible(), [2, 5]);
});

test('statement and exam dates remain independent and intersect candidate lists', async () => {
  const h = examFilterHarness();
  await h.date('2026-10-07');
  await h.examDate('2026-10-08');
  assert.equal(h.DOM.statementsDate.value, '2026-10-07');
  assert.equal(h.DOM.examScheduleDate.value, '2026-10-08');
  assert.equal(h.state.requests.at(-1).get('statement_date'), '2026-10-07');
  assert.equal(h.state.requests.at(-1).get('exam_date'), '2026-10-08');
  assert.deepEqual(h.visible(), [3]);
  await h.DOM.clearStatementsDate.dispatch('click');
  assert.equal(h.DOM.examScheduleDate.value, '2026-10-08');
  assert.deepEqual(h.visible(), [1, 2, 3]);
  await h.date('2026-10-07');
  await h.DOM.clearExamScheduleDate.dispatch('click');
  assert.equal(h.DOM.statementsDate.value, '2026-10-07');
  assert.deepEqual(h.visible(), [3]);
});

test('exam selection composes with red and blue status filters without changing them', async () => {
  const h = examFilterHarness();
  await h.examDate('2026-10-08');
  await h.newStatements();
  assert.deepEqual(h.visible(), [1, 3]);
  await h.pending();
  assert.deepEqual(h.visible(), [1, 2, 3]);
  await h.newStatements(false);
  assert.deepEqual(h.visible(), [2]);
  await h.examDate('2026-11-20');
  assert.equal(h.DOM.filterPendingStatements.checked, true);
  assert.equal(h.DOM.filterStatements.checked, false);
  assert.deepEqual(h.visible(), [2]);
});

test('exam selection composes with certificate, administrator and search filters', async () => {
  const h = examFilterHarness();
  h.DOM.filterExperts.checked = true;
  h.DOM.onlyAdmins.checked = true;
  h.DOM.usersSearch.value = ' Person 2 ';
  await h.examDate('2026-11-20');
  assert.deepEqual(h.visible(), [2]);
  assert.equal(h.state.requests.at(-1).get('only_admins'), 'true');
  assert.equal(h.state.requests.at(-1).get('search'), 'Person 2');
  assert.equal(h.DOM.filterExperts.checked, true);
});

test('polling updates exam filter membership after another administrator schedules or deletes an exam', async () => {
  const h = examFilterHarness();
  await h.examGroup('morning');
  const firstCard = h.card(1);
  firstCard.classList.toggle('open', true);
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.card(1), firstCard);
  assert.equal(h.card(1).classList.contains('open'), true);
  h.state.items[0].schedules = [];
  h.state.items[4].schedules.push({ exam_date: '2026-10-08', period: 'morning' });
  await h.users.refreshLiveUserStates({ force: true });
  assert.deepEqual(h.visible(), [3, 5]);
});

test('undated exam group polling rolls over using the backend Tbilisi day', async () => {
  const h = examFilterHarness();
  await h.examGroup('morning');
  assert.deepEqual(h.visible(), [1, 3]);
  h.state.today = '2026-11-20';
  await h.users.refreshLiveUserStates({ force: true });
  assert.deepEqual(h.visible(), [2]);
  assert.equal(h.state.requests.at(-1).has('exam_date'), false);
});

for (const requestType of ['render', 'poll']) {
  test(`late ${requestType} response cannot overwrite a newer exam date`, async () => {
    const h = examFilterHarness();
    await h.examDate('2026-09-01');
    h.state.hold = true;
    const stale = requestType === 'render' ? h.users.render() : h.users.refreshLiveUserStates({ force: true });
    await h.examDate('2026-11-20');
    assert.deepEqual(h.visible(), [2, 5]);
    h.state.pending.shift()();
    await stale;
    assert.deepEqual(h.visible(), [2, 5]);
  });

  test(`late ${requestType} response cannot overwrite a newer exam group`, async () => {
    const h = examFilterHarness();
    await h.examGroup('morning');
    h.state.hold = true;
    const stale = requestType === 'render' ? h.users.render() : h.users.refreshLiveUserStates({ force: true });
    await h.examGroup('morning', false);
    await h.examGroup('evening');
    assert.deepEqual(h.visible(), [2, 3]);
    h.state.pending.shift()();
    await stale;
    assert.deepEqual(h.visible(), [2, 3]);
  });
}

function mountedExamHarness() {
  const controllers = new Map();
  const examSchedules = { mount(panel, user, options) {
    assert.ok(panel, 'each user card must expose a scheduling panel');
    const controller = { panel, options, loads: 0, load() { this.loads += 1; } };
    controllers.set(user.id, controller);
    return controller;
  } };
  const h = examFilterHarness({ examSchedules });
  h.controllers = controllers;
  return h;
}

test('exam history mounts per card but only loads when that card opens', async () => {
  const h = mountedExamHarness();
  await h.users.render();
  assert.equal(h.controllers.size, 5);
  assert.equal([...h.controllers.values()].reduce((total, controller) => total + controller.loads, 0), 0);
  await h.card(1).querySelector('.head-toggle').dispatch('click');
  assert.equal(h.controllers.get(1).loads, 1);
  assert.equal(h.card(1).classList.contains('open'), true);
  await h.card(1).querySelector('.head-toggle').dispatch('click');
  assert.equal(h.controllers.get(1).loads, 1, 'closing does not fetch history');
  await h.card(1).querySelector('.head-toggle').dispatch('click');
  assert.equal(h.controllers.get(1).loads, 2, 'reopening checks for other administrator changes');
  assert.equal(h.controllers.get(2).loads, 0);
});

test('a successful scheduling callback immediately removes candidates no longer matching the exam filter', async () => {
  const h = mountedExamHarness();
  await h.examGroup('morning');
  assert.deepEqual(h.visible(), [1, 3]);
  h.state.items[0].schedules = [];
  await h.controllers.get(1).options.onChanged({ userId: 1 });
  assert.deepEqual(h.visible(), [3]);
  assert.equal(h.state.requests.at(-1).get('exam_morning'), 'true');
});

test('scheduling refresh preserves open matching cards, their controllers and manual exam access', async () => {
  const h = mountedExamHarness();
  await h.examGroup('morning');
  const card = h.card(1);
  const controller = h.controllers.get(1);
  await card.querySelector('.head-toggle').dispatch('click');
  assert.equal(card.querySelector('.chk-exam').checked, false);
  h.state.items[1].schedules.push({ exam_date: '2026-10-08', period: 'morning' });
  await controller.options.onChanged({ userId: 2 });
  assert.deepEqual(h.visible(), [1, 2, 3]);
  assert.equal(h.card(1), card);
  assert.equal(h.controllers.get(1), controller);
  assert.equal(card.classList.contains('open'), true);
  assert.equal(card.querySelector('.chk-exam').checked, false);
  assert.equal(controller.loads, 1);
});

for (const requestType of ['render', 'poll']) {
  test(`late ${requestType} cannot undo a successful scheduling callback refresh`, async () => {
    const h = mountedExamHarness();
    await h.examGroup('morning');
    h.state.hold = true;
    const oldRequest = requestType === 'render' ? h.users.render() : h.users.refreshLiveUserStates({ force: true });
    h.state.items[0].schedules = [];
    await h.controllers.get(1).options.onChanged({ userId: 1 });
    assert.deepEqual(h.visible(), [3]);
    h.state.pending.shift()();
    await oldRequest;
    assert.deepEqual(h.visible(), [3]);
  });
}

test('late scheduling callback refresh cannot restore an older selected exam date', async () => {
  const h = mountedExamHarness();
  await h.examGroup('morning');
  h.state.hold = true;
  const oldRefresh = h.controllers.get(1).options.onChanged({ userId: 1 });
  await h.examDate('2026-11-20');
  assert.deepEqual(h.visible(), [2]);
  h.state.pending.shift()();
  await oldRefresh;
  assert.deepEqual(h.visible(), [2]);
});

test('municipal certificate filter includes only municipal specialists', async () => {
  const h = municipalHarness();
  await h.selectCertificate('filterMunicipal');
  assert.deepEqual(h.visible(), [6, 7, 8]);
  assert.equal(h.state.requests.at(-1).has('statement_date'), false);
});

test('all-certified filter includes all three certificate types and excludes uncertified users', async () => {
  const h = municipalHarness();
  await h.selectCertificate('filterCertified');
  assert.deepEqual(h.visible(), [1, 2, 3, 5, 6, 7, 8]);
  assert.equal(h.card(4), null);
});

const certificateFilterResults = {
  filterArchitects: [1, 3],
  filterExperts: [2, 5],
  filterMunicipal: [6, 7, 8],
  filterCertified: [1, 2, 3, 5, 6, 7, 8],
};

for (const from of Object.keys(certificateFilterResults)) {
  for (const to of Object.keys(certificateFilterResults)) {
    if (from === to) continue;
    test(`certificate filter ${to} clears ${from} and leaves only the selected filter active`, async () => {
      const h = municipalHarness();
      await h.selectCertificate(from);
      assert.deepEqual(h.visible(), certificateFilterResults[from]);
      await h.selectCertificate(to);
      for (const key of Object.keys(certificateFilterResults)) {
        assert.equal(h.DOM[key].checked, key === to);
      }
      assert.deepEqual(h.visible(), certificateFilterResults[to]);
    });
  }

  test(`unchecking ${from} restores all users without activating another certificate filter`, async () => {
    const h = municipalHarness();
    await h.selectCertificate(from);
    await h.selectCertificate(from, false);
    for (const key of Object.keys(certificateFilterResults)) assert.equal(h.DOM[key].checked, false);
    assert.deepEqual(h.visible(), [1, 2, 3, 4, 5, 6, 7, 8]);
  });
}

test('municipal filter composes with search, admin, date, unread and pending filters', async () => {
  const h = municipalHarness();
  h.DOM.usersSearch.value = ' Person ';
  h.DOM.onlyAdmins.checked = true;
  await h.selectCertificate('filterMunicipal');
  await h.newStatements();
  await h.date();
  const query = h.state.requests.at(-1);
  assert.equal(query.get('search'), 'Person');
  assert.equal(query.get('only_admins'), 'true');
  assert.equal(query.get('statement_date'), '2026-10-08');
  assert.deepEqual(h.visible(), [6, 7]);

  await h.DOM.clearStatementsDate.dispatch('click');
  assert.deepEqual(h.visible(), [6]);
  await h.newStatements(false);
  await h.pending();
  assert.equal(h.DOM.filterMunicipal.checked, true);
  assert.equal(h.state.requests.at(-1).has('statement_date'), false);
  assert.deepEqual(h.visible(), [7]);

  h.DOM.onlyAdmins.checked = false;
  await h.users.render();
  assert.deepEqual(h.visible(), [7, 8]);
  h.DOM.usersSearch.value = 'Person 8';
  await h.users.render();
  assert.deepEqual(h.visible(), [8]);
  h.DOM.onlyAdmins.checked = true;
  await h.users.render();
  assert.deepEqual(h.visible(), []);
});

test('municipal and all-certified filters support the certificate_info fallback', async () => {
  const h = municipalHarness();
  const municipalUser = h.state.items.find((user) => user.id === 6);
  municipalUser.certificate_info = municipalUser.certificate;
  delete municipalUser.certificate;
  await h.selectCertificate('filterMunicipal');
  assert.deepEqual(h.visible(), [6, 7, 8]);
  await h.selectCertificate('filterCertified');
  assert.deepEqual(h.visible(), [1, 2, 3, 5, 6, 7, 8]);
});

test('pending filter shows only blue cards and excludes mixed red cards', async () => {
  const h = pendingHarness();
  await h.pending();
  assert.deepEqual(h.visible(), [2]);
  assertStatementState(h.card(2), 'blue');
  assertStatementState(h.card(3), 'red');
  assert.equal(h.state.requests.at(-1).has('statement_date'), false);
  await h.pending(false);
  assert.deepEqual(h.visible(), [1, 2, 3, 4, 5]);
});

test('pending filter reacts immediately to reading, replying and undoing reply', async () => {
  const h = pendingHarness();
  await h.pending();
  const card = h.card(1);
  h.users.updateUserUnseenStatus(1, false, 0, true, 1);
  assert.deepEqual(h.visible(), [1, 2]);
  assertStatementState(card, 'blue');
  h.users.updateUserUnseenStatus(1, false, 0, false, 0);
  assert.deepEqual(h.visible(), [2]);
  assertStatementState(card, 'normal');
  h.users.updateUserUnseenStatus(1, false, 0, true, 1);
  assert.deepEqual(h.visible(), [1, 2]);
  assert.equal(h.card(1), card);
  // Replying to the older pending statement leaves only unread work: not pending.
  h.users.updateUserUnseenStatus(3, true, 1, false, 0);
  assert.deepEqual(h.visible(), [1, 2]);
  assertStatementState(h.card(3), 'red');
});

const statementFilterCases = [
  { name: 'neither status', unread: false, pending: false, visible: [1, 2, 3, 4, 5] },
  { name: 'red only', unread: true, pending: false, visible: [1, 3] },
  { name: 'blue only', unread: false, pending: true, visible: [2] },
  { name: 'red or blue', unread: true, pending: true, visible: [1, 2, 3] },
];

for (const status of statementFilterCases) {
  for (const clearMethod of ['button', 'date input']) {
    test(`${status.name}: date overrides colors independently and ${clearMethod} clearing restores status selections`, async () => {
      const h = pendingHarness();
      await h.newStatements(status.unread);
      await h.pending(status.pending);
      assert.equal(h.DOM.filterStatements.checked, status.unread);
      assert.equal(h.DOM.filterPendingStatements.checked, status.pending);
      assert.deepEqual(h.visible(), status.visible);
      assert.equal(h.state.requests.at(-1).has('statement_date'), false);
      assert.equal(h.DOM.statementsDate.disabled, false);
      assert.equal(h.DOM.clearStatementsDate.disabled, true);

      await h.date();
      assert.equal(h.DOM.filterStatements.checked, status.unread);
      assert.equal(h.DOM.filterPendingStatements.checked, status.pending);
      assert.equal(h.DOM.statementsDate.disabled, false);
      assert.equal(h.DOM.clearStatementsDate.disabled, false);
      assert.equal(h.state.requests.at(-1).get('statement_date'), '2026-10-08');
      assert.deepEqual(h.visible(), [1, 2, 5]);
      assertStatementState(h.card(1), 'red');
      assertStatementState(h.card(2), 'blue');
      assertStatementState(h.card(5), 'normal');

      await h.date('2026-10-07');
      assert.equal(h.state.requests.at(-1).get('statement_date'), '2026-10-07');
      assert.deepEqual(h.visible(), [3]);
      assert.equal(h.DOM.filterStatements.checked, status.unread);
      assert.equal(h.DOM.filterPendingStatements.checked, status.pending);

      if (clearMethod === 'button') await h.DOM.clearStatementsDate.dispatch('click');
      else await h.date('');
      assert.equal(h.DOM.statementsDate.value, '');
      assert.equal(h.DOM.statementsDate.disabled, false);
      assert.equal(h.DOM.clearStatementsDate.disabled, true);
      assert.equal(h.DOM.filterStatements.checked, status.unread);
      assert.equal(h.DOM.filterPendingStatements.checked, status.pending);
      assert.equal(h.state.requests.at(-1).has('statement_date'), false);
      assert.deepEqual(h.visible(), status.visible);
    });
  }
}

test('status checkboxes can be toggled in either order without clearing each other', async () => {
  const h = pendingHarness();
  await h.pending();
  await h.newStatements();
  assert.equal(h.DOM.filterStatements.checked, true);
  assert.equal(h.DOM.filterPendingStatements.checked, true);
  assert.deepEqual(h.visible(), [1, 2, 3]);
  await h.pending(false);
  assert.equal(h.DOM.filterStatements.checked, true);
  assert.deepEqual(h.visible(), [1, 3]);
  await h.pending();
  await h.newStatements(false);
  assert.equal(h.DOM.filterPendingStatements.checked, true);
  assert.deepEqual(h.visible(), [2]);
  await h.pending(false);
  assert.deepEqual(h.visible(), [1, 2, 3, 4, 5]);
});

test('toggling either status while a date is selected keeps date filtering and date controls active', async () => {
  const h = pendingHarness();
  await h.date();
  for (const [change, checked] of [[h.pending, true], [h.newStatements, true],
    [h.pending, false], [h.newStatements, false]]) {
    await change(checked);
    assert.equal(h.DOM.statementsDate.value, '2026-10-08');
    assert.equal(h.DOM.statementsDate.disabled, false);
    assert.equal(h.DOM.clearStatementsDate.disabled, false);
    assert.equal(h.state.requests.at(-1).get('statement_date'), '2026-10-08');
    assert.deepEqual(h.visible(), [1, 2, 5]);
  }
});

test('pending filter composes with search, administrator and certificate filters', async () => {
  const h = pendingHarness();
  h.DOM.usersSearch.value = ' Person ';
  h.DOM.onlyAdmins.checked = true;
  h.DOM.filterExperts.checked = true;
  await h.pending();
  const query = h.state.requests.at(-1);
  assert.equal(query.get('search'), 'Person');
  assert.equal(query.get('only_admins'), 'true');
  assert.equal(query.has('statement_date'), false);
  assert.deepEqual(h.visible(), [2]);
  h.DOM.filterExperts.checked = false;
  h.DOM.filterArchitects.checked = true;
  await h.users.render();
  assert.deepEqual(h.visible(), []);
  h.DOM.onlyAdmins.checked = false;
  await h.users.render();
  assert.deepEqual(h.visible(), []);
  h.DOM.filterArchitects.checked = false;
  h.DOM.filterCertified.checked = true;
  await h.users.render();
  assert.deepEqual(h.visible(), [2]);
  h.DOM.usersSearch.value = 'Person 2';
  await h.users.render();
  assert.deepEqual(h.visible(), [2]);
});

test('pending polling reveals newly read cards and hides replied cards without recreating cards', async () => {
  const h = pendingHarness();
  await h.pending();
  const card = h.card(2);
  card.classList.toggle('open', true);
  Object.assign(h.state.items[0], { has_unseen_statements: false, unseen_statement_count: 0,
    has_pending_statements: true, pending_statement_count: 1 });
  Object.assign(h.state.items[1], { has_pending_statements: false, pending_statement_count: 0 });
  await h.users.refreshLiveUserStates({ force: true });
  assert.deepEqual(h.visible(), [1]);
  assert.equal(h.card(2), card);
  assert.equal(card.classList.contains('open'), true);
  assertStatementState(card, 'normal');
  Object.assign(h.state.items[1], { has_unseen_statements: true, unseen_statement_count: 1,
    has_pending_statements: true, pending_statement_count: 2 });
  await h.users.refreshLiveUserStates({ force: true });
  assert.deepEqual(h.visible(), [1]);
  assert.equal(h.card(2), card);
  assertStatementState(card, 'red');
});

test('combined red and blue filters retain read cards until answered and restore them for a new statement', async () => {
  const h = pendingHarness();
  await h.newStatements();
  await h.pending();
  const card = h.card(1);
  card.classList.toggle('open', true);
  h.users.updateUserUnseenStatus(1, false, 0, true, 1);
  assert.deepEqual(h.visible(), [1, 2, 3]);
  assertStatementState(card, 'blue');
  h.users.updateUserUnseenStatus(1, false, 0, false, 0);
  assert.deepEqual(h.visible(), [2, 3]);
  assertStatementState(card, 'normal');
  h.users.updateUserUnseenStatus(1, true, 1, false, 0);
  assert.deepEqual(h.visible(), [1, 2, 3]);
  assertStatementState(card, 'red');
  assert.equal(h.card(1), card);
  assert.equal(card.classList.contains('open'), true);
});

test('combined status polling applies red-to-blue-to-answered changes without recreating cards', async () => {
  const h = pendingHarness();
  await h.pending();
  await h.newStatements();
  const card = h.card(3);
  card.classList.toggle('open', true);
  Object.assign(h.state.items[2], { has_unseen_statements: false, unseen_statement_count: 0 });
  await h.users.refreshLiveUserStates({ force: true });
  assert.deepEqual(h.visible(), [1, 2, 3]);
  assertStatementState(card, 'blue');
  Object.assign(h.state.items[2], { has_pending_statements: false, pending_statement_count: 0 });
  await h.users.refreshLiveUserStates({ force: true });
  assert.deepEqual(h.visible(), [1, 2]);
  assertStatementState(card, 'normal');
  assert.equal(h.card(3), card);
  assert.equal(card.classList.contains('open'), true);
});

test('date filtering retains members when statement colors change while both statuses are checked', async () => {
  const h = pendingHarness();
  await h.newStatements();
  await h.pending();
  await h.date();
  const card = h.card(1);
  h.users.updateUserUnseenStatus(1, false, 0, true, 1);
  assert.deepEqual(h.visible(), [1, 2, 5]);
  assertStatementState(card, 'blue');
  h.users.updateUserUnseenStatus(1, false, 0, false, 0);
  assert.deepEqual(h.visible(), [1, 2, 5]);
  assertStatementState(card, 'normal');
  Object.assign(h.state.items[1], { has_pending_statements: false, pending_statement_count: 0 });
  await h.users.refreshLiveUserStates({ force: true });
  assert.deepEqual(h.visible(), [1, 2, 5]);
  assertStatementState(h.card(2), 'normal');
  assert.equal(h.state.requests.at(-1).get('statement_date'), '2026-10-08');
});

test('legacy unread-only status updates hide mixed red cards until they become blue', async () => {
  const h = pendingHarness();
  await h.pending();
  h.users.updateUserUnseenStatus(3, true, 2);
  assert.deepEqual(h.visible(), [2]);
  h.users.updateUserUnseenStatus(3, false, 0);
  assert.deepEqual(h.visible(), [2, 3]);
  assertStatementState(h.card(3), 'blue');
});

for (const requestType of ['render', 'poll']) {
  test(`late ${requestType} date response cannot overwrite the newer pending filter`, async () => {
    const h = pendingHarness();
    await h.date();
    h.state.hold = true;
    const staleRequest = requestType === 'render' ? h.users.render() : h.users.refreshLiveUserStates({ force: true });
    await h.DOM.clearStatementsDate.dispatch('click');
    await h.pending();
    assert.deepEqual(h.visible(), [2]);
    assert.equal(h.state.pending.length, 1);
    h.state.pending.shift()();
    await staleRequest;
    assert.deepEqual(h.visible(), [2]);
  });

  test(`late ${requestType} response cannot return replied users to the pending filter`, async () => {
    const h = pendingHarness();
    await h.pending();
    h.state.hold = true;
    const staleRequest = requestType === 'render' ? h.users.render() : h.users.refreshLiveUserStates({ force: true });
    Object.assign(h.state.items[1], { has_pending_statements: false, pending_statement_count: 0 });
    h.users.updateUserUnseenStatus(2, false, 0, false, 0);
    if (requestType === 'poll') assert.deepEqual(h.visible(), []);
    h.state.pending.shift()();
    await staleRequest;
    assert.deepEqual(h.visible(), []);
  });
}

test('without a date, statements filter shows only red cards and reacts to reading', async () => {
  const h = harness();
  h.DOM.filterStatements.checked = true;
  await h.users.render();
  assert.deepEqual(h.visible(), [1, 3, 5]);
  assert.equal(h.state.requests.at(-1).has('statement_date'), false);
  h.users.updateUserUnseenStatus(1, false, 0);
  assert.deepEqual(h.visible(), [3, 5]);
  h.users.updateUserUnseenStatus(2, true, 1);
  assert.deepEqual(h.visible(), [2, 3, 5]);
});

test('date selection leaves both status filters off and keeps read and unread senders visible', async () => {
  const h = harness();
  await h.date();
  assert.equal(h.DOM.filterStatements.checked, false);
  assert.equal(h.DOM.filterPendingStatements.checked, false);
  assert.equal(h.state.requests.at(-1).get('statement_date'), '2026-10-08');
  assert.deepEqual(h.visible(), [1, 2, 5]);
  assert.equal(h.card(2).classList.contains('has-new-statements'), false);
  h.users.updateUserUnseenStatus(1, false, 0);
  assert.equal(h.card(1).classList.contains('has-new-statements'), false);
  assert.deepEqual(h.visible(), [1, 2, 5]);
});

test('clear date returns to red-only filtering and removes the server date parameter', async () => {
  const h = harness();
  assert.equal(h.DOM.clearStatementsDate.disabled, true);
  h.DOM.filterStatements.checked = true;
  await h.DOM.filterStatements.dispatch('change');
  await h.date();
  assert.equal(h.DOM.clearStatementsDate.disabled, false);
  await h.DOM.clearStatementsDate.dispatch('click');
  assert.equal(h.DOM.statementsDate.value, '');
  assert.equal(h.DOM.clearStatementsDate.disabled, true);
  assert.equal(h.DOM.filterStatements.checked, true);
  assert.equal(h.state.requests.at(-1).has('statement_date'), false);
  assert.deepEqual(h.visible(), [1, 3, 5]);
});

test('turning statements checkbox off keeps independently selected date filtering', async () => {
  const h = harness();
  h.DOM.filterStatements.checked = true;
  await h.DOM.filterStatements.dispatch('change');
  await h.date();
  h.DOM.filterStatements.checked = false;
  await h.DOM.filterStatements.dispatch('change');
  assert.equal(h.DOM.statementsDate.value, '2026-10-08');
  assert.equal(h.state.requests.at(-1).get('statement_date'), '2026-10-08');
  assert.deepEqual(h.visible(), [1, 2, 5]);
});

test('date filtering composes with certificate, search and administrator filters', async () => {
  const h = harness();
  h.DOM.filterExperts.checked = true;
  h.DOM.onlyAdmins.checked = true;
  h.DOM.usersSearch.value = ' Person ';
  await h.date();
  const query = h.state.requests.at(-1);
  assert.equal(query.get('search'), 'Person');
  assert.equal(query.get('only_admins'), 'true');
  assert.deepEqual(h.visible(), [2]);
});

test('live refresh preserves card references for stable membership and updates changed date membership', async () => {
  const h = harness();
  await h.date();
  const card = h.card(1);
  card.classList.toggle('open', true);
  h.state.items[0].has_unseen_statements = false;
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.card(1), card);
  assert.equal(card.classList.contains('open'), true);
  assert.equal(card.classList.contains('has-new-statements'), false);
  assert.deepEqual(h.visible(), [1, 2, 5]);
  h.state.items[1].days = ['2026-10-07'];
  h.state.items[2].days = ['2026-10-08'];
  await h.users.refreshLiveUserStates({ force: true });
  assert.deepEqual(h.visible(), [1, 3, 5]);
});

for (const requestType of ['render', 'poll']) {
  test(`late ${requestType} response cannot overwrite a newer date filter`, async () => {
    const h = harness();
    await h.date();
    h.state.hold = true;
    const staleRequest = requestType === 'render' ? h.users.render() : h.users.refreshLiveUserStates({ force: true });
    await h.date('2026-10-07');
    assert.deepEqual(h.visible(), [3, 4]);
    assert.equal(h.state.pending.length, 1);
    h.state.pending.shift()();
    await staleRequest;
    assert.deepEqual(h.visible(), [3, 4]);
  });
}

function assertStatementState(card, expected) {
  for (const element of [card, card.querySelector('.btn-user-announcements')]) {
    assert.equal(element.classList.contains('has-new-statements'), expected === 'red');
    assert.equal(element.classList.contains('has-pending-statements'), expected === 'blue');
  }
}

test('statement lifecycle is red, blue after reading, normal after reply, then red for a new statement', async () => {
  const h = harness();
  await h.users.render();
  const card = h.card(1);
  assertStatementState(card, 'red');
  h.users.updateUserUnseenStatus(1, false, 0, true, 1);
  assertStatementState(card, 'blue');
  assert.equal(card.dataset.pendingCount, '1');
  h.users.updateUserUnseenStatus(1, false, 0, false, 0);
  assertStatementState(card, 'normal');
  h.users.updateUserUnseenStatus(1, true, 1, false, 0);
  assertStatementState(card, 'red');
  assert.equal(h.card(1), card);
});

test('new unread statements take priority over older read but unanswered statements', async () => {
  const h = harness();
  h.state.items[0].has_pending_statements = true;
  h.state.items[0].pending_statement_count = 2;
  await h.users.render();
  assertStatementState(h.card(1), 'red');
  h.users.updateUserUnseenStatus(1, false, 0, true, 3);
  assertStatementState(h.card(1), 'blue');
  assert.equal(h.card(1).dataset.pendingCount, '3');
  h.users.updateUserUnseenStatus(1, true, 1, true, 3);
  assertStatementState(h.card(1), 'red');
});

test('red-only filter excludes blue cards but selected-date filter retains blue and replied cards', async () => {
  const h = harness();
  h.DOM.filterStatements.checked = true;
  await h.users.render();
  h.users.updateUserUnseenStatus(1, false, 0, true, 1);
  assertStatementState(h.card(1), 'blue');
  assert.deepEqual(h.visible(), [3, 5]);
  Object.assign(h.state.items[0], { has_unseen_statements: false, unseen_statement_count: 0,
    has_pending_statements: true, pending_statement_count: 1 });
  await h.date();
  assertStatementState(h.card(1), 'blue');
  assert.deepEqual(h.visible(), [1, 2, 5]);
  h.users.updateUserUnseenStatus(1, false, 0, false, 0);
  assertStatementState(h.card(1), 'normal');
  assert.deepEqual(h.visible(), [1, 2, 5]);
});

test('live polling updates blue and normal states without closing an expanded card', async () => {
  const h = harness();
  await h.users.render();
  const card = h.card(1);
  card.classList.toggle('open', true);
  Object.assign(h.state.items[0], { has_unseen_statements: false, unseen_statement_count: 0,
    has_pending_statements: true, pending_statement_count: 2 });
  await h.users.refreshLiveUserStates({ force: true });
  assertStatementState(card, 'blue');
  assert.equal(card.dataset.pendingCount, '2');
  Object.assign(h.state.items[0], { has_pending_statements: false, pending_statement_count: 0 });
  await h.users.refreshLiveUserStates({ force: true });
  assertStatementState(card, 'normal');
  assert.equal(card.dataset.pendingCount, '0');
  assert.equal(h.card(1), card);
  assert.equal(card.classList.contains('open'), true);
});

test('older three-argument status calls preserve known pending state', async () => {
  const h = harness();
  await h.users.render();
  h.users.updateUserUnseenStatus(1, false, 0, true, 2);
  h.users.updateUserUnseenStatus(1, false, 0);
  assertStatementState(h.card(1), 'blue');
  assert.equal(h.card(1).dataset.pendingCount, '2');
  h.users.updateUserUnseenStatus(1, false, 0, false);
  assertStatementState(h.card(1), 'normal');
  assert.equal(h.card(1).dataset.pendingCount, '0');
});

test('statement status changes update cached users even when a certificate filter hides their cards', async () => {
  const h = harness();
  h.DOM.filterExperts.checked = true;
  await h.users.render();
  assert.equal(h.card(1), null);
  assert.equal(h.card(3), null);
  const navigation = h.DOM.navLinks[0];
  assert.equal(navigation.classList.contains('has-new-statements'), true);
  h.users.updateUserUnseenStatus(1, false, 0, true, 1);
  h.users.updateUserUnseenStatus(3, false, 0, true, 1);
  h.users.updateUserUnseenStatus(5, false, 0, true, 1);
  assert.equal(navigation.classList.contains('has-new-statements'), false);
});

for (const requestType of ['render', 'poll']) {
  test(`late ${requestType} response cannot restore red after a successful statement action`, async () => {
    const h = harness();
    await h.users.render();
    h.state.hold = true;
    const staleRequest = requestType === 'render' ? h.users.render() : h.users.refreshLiveUserStates({ force: true });
    Object.assign(h.state.items[0], { has_unseen_statements: false, unseen_statement_count: 0,
      has_pending_statements: true, pending_statement_count: 1 });
    h.users.updateUserUnseenStatus(1, false, 0, true, 1);
    if (requestType === 'poll') assertStatementState(h.card(1), 'blue');
    h.state.pending.shift()();
    await staleRequest;
    assertStatementState(h.card(1), 'blue');
  });
}

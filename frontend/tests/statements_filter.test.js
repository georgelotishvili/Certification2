const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/admin/users.js'), 'utf8');
const stageKeys = ['theory', 'project_stage_1', 'project_stage_2'];
function stages(granted = false) {
  return Object.fromEntries(stageKeys.map((key) => [key, { granted, status: granted ? 'available' : 'none',
    grant_id: null, granted_at: null, expires_at: null, started_at: null, remaining_seconds: 0 }]));
}

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
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  dispatch(name) { return this.events[name]?.({ target: this, preventDefault() {} }); }
  prepend(child) {
    if (child.parentElement) child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
    child.parentElement = this;
    this.children.unshift(child);
    return child;
  }
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
      for (const key of ['date', 'morning', 'evening']) card.selectors[`.exam-schedule-${key}`] = new Element();
      for (const key of stageKeys) {
        const input = new Element();
        input.dataset.examStage = key;
        const markup = html.match(new RegExp(`<input[^>]*data-exam-stage="${key}"[^>]*>`))?.[0] || '';
        input.checked = /\bchecked\b/.test(markup);
        input.disabled = /\bdisabled\b/.test(markup);
        card.selectors[`.chk-exam[data-exam-stage="${key}"]`] = input;
        const statusMarkup = html.match(new RegExp(`<span[^>]*class="user-exam-stage-status"[^>]*data-exam-stage-status="${key}"[^>]*>[^<]*<\\/span>`))?.[0] || '';
        const status = new Element();
        status.textContent = statusMarkup.match(/>([^<]*)<\/span>$/)?.[1] || '';
        const statusValue = statusMarkup.match(/data-status="([^"]+)"/)?.[1] || '';
        status.setAttribute('data-status', statusValue);
        card.selectors[`.user-exam-stage-status[data-exam-stage-status="${key}"]`] = status;
        if (key === 'theory') card.selectors['.chk-exam'] = input;
      }
      card.selectors['.chk-admin'] = new Element();
      card.selectors['.head-delete'] = new Element();
      card.selectors['.user-name'] = new Element();
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
    days: [day], first_name: `Person ${id}`, certificate: { level }, is_admin: admin,
    exam_stage_permissions: stages() };
}

function harness(options = {}) {
  const DOM = Object.fromEntries(['usersGrid', 'usersSearch', 'usersSort', 'onlyAdmins',
    'filterStatements', 'filterPendingStatements', 'statementsDate', 'clearStatementsDate', 'filterArchitects',
    'filterExperts', 'filterMunicipal', 'filterCertified', 'filterExamMorning', 'filterExamEvening',
    'examScheduleDate', 'clearExamScheduleDate', 'usersPagination', 'usersPagePrevious',
    'usersPageNext', 'usersPageStatus', 'usersListNotice', 'usersListNoticeText',
    'usersListRetry'].map((key) => [key, new Element()]));
  DOM.navLinks = [Object.assign(new Element(), { textContent: 'რეგისტრირებული პირები' })];
  const state = { requests: [], signals: [], responses: [], mutations: [], alerts: [], confirmations: [], timers: new Map(), nextTimer: 1,
    hold: false, pending: [], heldMutations: [], holdMutation: false, today: '2026-10-08', items: [
    fixture(1, true, '2026-10-08', 'architect', true),
    fixture(2, false, '2026-10-08', 'expert', true),
    fixture(3, true, '2026-10-07', 'architect'),
    fixture(4, false, '2026-10-07', ''),
    fixture(5, true, '2026-10-08', 'expert'),
  ] };
  const window = new Element();
  window.confirm = (message) => {
    state.confirmations.push(message);
    return state.confirmResult !== false;
  };
  const document = Object.assign(new Element(), { hidden: false, createElement: () => new Element() });
  const context = { window, document, URLSearchParams, AbortController, setInterval: () => 1,
    alert: (message) => state.alerts.push(message),
    setTimeout: (fn, delay) => { const id = state.nextTimer++; state.timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => state.timers.delete(id),
    fetch: async (address, requestOptions = {}) => {
      const url = new URL(address);
      if (url.pathname === '/admin/statements/summary') {
        return { ok: true, json: async () => ({}) };
      }
      if (url.pathname === '/admin/documents') {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      const mutation = url.pathname.match(/^\/admin\/users\/(\d+)\/(admin|exam-stage-permissions\/(theory|project_stage_1|project_stage_2))$/);
      if (mutation) {
        assert.equal(requestOptions.method, 'PATCH');
        const payload = JSON.parse(requestOptions.body);
        state.mutations.push({ id: Number(mutation[1]), type: mutation[2], payload });
        const user = state.items.find((item) => item.id === Number(mutation[1]));
        const success = !state.failMutation;
        state.failMutation = false;
        if (success) {
          if (mutation[2] === 'admin') Object.assign(user, { is_admin: payload.is_admin,
            exam_permission: payload.is_admin || false, exam_stage_permissions: stages(payload.is_admin) });
          else user.exam_stage_permissions[mutation[3]] = { ...stages(payload.granted)[mutation[3]],
            grant_id: payload.granted ? state.mutations.length : null };
        }
        const responsePayload = structuredClone(user);
        const result = { ok: success, json: async () => responsePayload };
        if (!state.holdMutation) return result;
        state.holdMutation = false;
        return new Promise((resolve) => state.heldMutations.push(() => resolve(result)));
      }
      assert.equal(url.pathname, '/admin/users');
      state.requests.push(url.searchParams);
      state.signals.push(requestOptions.signal);
      const day = url.searchParams.get('statement_date');
      const search = url.searchParams.get('search') || '';
      const morning = url.searchParams.get('exam_morning') === 'true';
      const evening = url.searchParams.get('exam_evening') === 'true';
      const examDay = url.searchParams.get('exam_date') || ((morning || evening) ? state.today : '');
      let items = state.items.filter((user) => (!day || user.days.includes(day)) &&
        (!examDay || (user.schedules || []).some((schedule) => schedule.exam_date === examDay &&
          ((!morning && !evening) || (morning && schedule.period === 'morning') || (evening && schedule.period === 'evening')))) &&
        (!url.searchParams.has('only_admins') || user.is_admin) && user.first_name.includes(search));
      let payload = { items: structuredClone(items) };
      if (options.paginated) {
        const qualification = url.searchParams.get('qualification');
        const levels = { architect: ['architect', 'architect_expert'], expert: ['expert'],
          municipal: ['municipal'], certified: ['architect', 'expert', 'municipal'] };
        const red = url.searchParams.get('new_statements') === 'true';
        const blue = url.searchParams.get('pending_statements') === 'true';
        items = items.filter((user) => (!qualification || levels[qualification].includes((user.certificate || user.certificate_info)?.level))
          && (day || (!red && !blue) || (red && user.has_unseen_statements)
            || (blue && !user.has_unseen_statements && user.has_pending_statements)));
        const size = Number(url.searchParams.get('size'));
        const page = Math.min(Number(url.searchParams.get('page')), Math.max(1, Math.ceil(items.length / size)));
        const live = url.searchParams.get('live') === 'true';
        const pageItems = items.slice((page - 1) * size, page * size).map((user) => {
          const revision = JSON.stringify([user.first_name, user.last_name, user.certificate, user.certificate_info, user.is_admin]);
          const record = live ? Object.fromEntries(['id', 'exam_permission', 'exam_stage_permissions', 'has_unseen_statements',
            'unseen_statement_count', 'has_pending_statements', 'pending_statement_count'].map((key) => [key, user[key]])) : user;
          return { ...record, display_revision: revision };
        });
        payload = { items: structuredClone(pageItems), paginated: true, live, page, size, total: items.length,
          global_unseen_users: state.items.filter((user) => user.has_unseen_statements).length };
      }
      state.responses.push(payload);
      const result = { ok: !state.failNext, json: async () => payload };
      state.failNext = false;
      if (!state.hold) return result;
      state.hold = false;
      return new Promise((resolve) => state.pending.push(() => resolve(result)));
    },
  };
  vm.runInNewContext(source, context);
  const users = window.AdminModules.createUsersModule({ DOM, API_BASE: 'http://test.local',
    on: (node, name, handler) => node?.addEventListener(name, handler),
    formatDateTime: () => '', escapeHtml: (value) => String(value ?? ''),
    isFounderActor: () => !!options.founderActor, getAdminHeaders: () => ({}), getActorHeaders: () => ({}),
    examSchedules: options.examSchedules,
  });
  users.init();
  document.activeElement = DOM.usersSearch;
  DOM.usersSearch.dispatch('focus');
  return { DOM, users, state, document,
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

function paginatedHarness() {
  const h = pendingHarness({ paginated: true });
  h.state.items = Array.from({ length: 123 }, (_, index) =>
    fixture(index + 1, index === 122, '2026-10-08', index >= 100 ? 'municipal' : 'architect'));
  h.flush = async () => { for (let index = 0; index < 15; index += 1) await Promise.resolve(); };
  return h;
}

function stageInput(h, id, stage) {
  return h.card(id).querySelector(`.chk-exam[data-exam-stage="${stage}"]`);
}

function stageStatus(h, id, stage) {
  return h.card(id).querySelector(`.user-exam-stage-status[data-exam-stage-status="${stage}"]`);
}

test('three stage controls have exact Georgian labels, full titles and independent accessible names', () => {
  for (const [index, key] of stageKeys.entries()) {
    assert.match(source, new RegExp(`key: '${key}', label: 'ეტაპი ${index + 1}', title: 'ეტაპი ${index + 1} — [^']+'`));
  }
  assert.match(source, /data-exam-stage="\$\{key\}" aria-label="\$\{title\}"/);
  assert.match(source, /class="user-exam-stage-status"[^>]*role="status" aria-live="polite"/);
  assert.match(source, /role="group" aria-label="გამოცდის ეტაპებზე დაშვება"/);
  assert.doesNotMatch(source, /\/exam-permission[`'"]/);
  const css = fs.readFileSync(path.join(__dirname, '../styles/admin.css'), 'utf8');
  assert.match(css, /\.user-exam-stage-controls\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(css, /\.user-exam-stage-controls\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/s);
  assert.match(css, /@media \(max-width:\s*420px\)[\s\S]*?\.user-exam-stage-controls\s*\{[^}]*grid-template-columns:\s*1fr/s);
});

test('live stage status moves from available to started to completed without an API write or card collapse', async () => {
  const h = paginatedHarness();
  h.state.items[0].exam_stage_permissions.theory = {
    ...stages(true).theory,
    grant_id: 41,
  };
  await h.users.render();
  const card = h.card(1);
  card.classList.toggle('open', true);

  assert.equal(stageInput(h, 1, 'theory').checked, true);
  assert.equal(stageStatus(h, 1, 'theory').textContent, 'ჩართულია');
  assert.equal(stageStatus(h, 1, 'theory').getAttribute('data-status'), 'available');

  h.state.items[0].exam_stage_permissions.theory = {
    ...stages().theory,
    status: 'started',
    grant_id: 41,
    started_at: '2026-10-09T10:00:00Z',
  };
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.card(1), card);
  assert.equal(card.classList.contains('open'), true);
  assert.equal(stageInput(h, 1, 'theory').checked, false);
  assert.equal(stageStatus(h, 1, 'theory').textContent, 'მიმდინარეობს');
  assert.equal(stageStatus(h, 1, 'theory').getAttribute('data-status'), 'started');
  assert.equal(h.state.mutations.length, 0);

  h.state.items[0].exam_stage_permissions.theory = {
    ...stages().theory,
    status: 'completed',
    grant_id: 41,
    started_at: '2026-10-09T10:00:00Z',
    completed_at: '2026-10-09T10:30:00Z',
  };
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.card(1), card);
  assert.equal(card.classList.contains('open'), true);
  assert.equal(stageInput(h, 1, 'theory').checked, false);
  assert.equal(stageStatus(h, 1, 'theory').textContent, 'დასრულებულია');
  assert.equal(stageStatus(h, 1, 'theory').getAttribute('data-status'), 'completed');
  assert.equal(h.state.mutations.length, 0);
});

test('a stage entry is editable only when it has the full granted and status contract', async () => {
  const h = paginatedHarness();
  h.state.items[0].exam_stage_permissions.theory = { granted: false };
  await h.users.render();
  assert.equal(stageInput(h, 1, 'theory').checked, false);
  assert.equal(stageInput(h, 1, 'theory').disabled, true);
  assert.equal(stageStatus(h, 1, 'theory').textContent, 'გამორთულია');

  h.state.items[0].exam_stage_permissions.theory = {
    ...stages().theory,
    status: 'started',
    grant_id: 9,
  };
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(stageInput(h, 1, 'theory').disabled, false);
  assert.equal(stageStatus(h, 1, 'theory').textContent, 'მიმდინარეობს');
  assert.equal(h.state.mutations.length, 0);
});

test('re-authorizing a started stage requires confirmation and binds the replacement to its current grant', async () => {
  const h = paginatedHarness();
  h.state.items[0].exam_stage_permissions.theory = {
    ...stages().theory,
    status: 'started',
    grant_id: 73,
    started_at: '2026-10-09T10:00:00Z',
  };
  await h.users.render();
  const input = stageInput(h, 1, 'theory');
  assert.equal(input.checked, false);

  input.checked = true;
  await input.dispatch('change');

  assert.deepEqual(h.state.confirmations, [
    'ეს ეტაპი უკვე მიმდინარეობს. ხელახლა დაშვება გამოიყენეთ მხოლოდ ახალი ცდის საჭიროებისას. არსებული შედეგები არ წაიშლება. გსურთ ხელახლა დაშვება?',
  ]);
  assert.deepEqual(h.state.mutations[0], {
    id: 1,
    type: 'exam-stage-permissions/theory',
    payload: { granted: true, replace_started: true, expected_grant_id: 73 },
  });
  assert.equal(input.checked, true);
  assert.equal(stageStatus(h, 1, 'theory').textContent, 'ჩართულია');
});

test('declining started-stage re-authorization restores its status without an API write', async () => {
  const h = paginatedHarness();
  h.state.items[0].exam_stage_permissions.project_stage_1 = {
    ...stages().project_stage_1,
    status: 'started',
    grant_id: 91,
    started_at: '2026-10-09T10:00:00Z',
  };
  h.state.confirmResult = false;
  await h.users.render();
  const input = stageInput(h, 1, 'project_stage_1');

  input.checked = true;
  await input.dispatch('change');

  assert.equal(h.state.confirmations.length, 1);
  assert.equal(h.state.mutations.length, 0);
  assert.equal(input.checked, false);
  assert.equal(stageStatus(h, 1, 'project_stage_1').textContent, 'მიმდინარეობს');
});

for (const stage of stageKeys) {
  test(`${stage}: grant and revoke mutate only that stage and never the legacy all-stage endpoint`, async () => {
    const h = paginatedHarness();
    await h.users.render();
    const input = stageInput(h, 1, stage);
    input.checked = true;
    await input.dispatch('change');
    assert.deepEqual(h.state.mutations[0], { id: 1, type: `exam-stage-permissions/${stage}`, payload: { granted: true } });
    for (const key of stageKeys) assert.equal(stageInput(h, 1, key).checked, key === stage);
    input.checked = false;
    await input.dispatch('change');
    assert.equal(h.state.mutations[1].payload.granted, false);
    for (const key of stageKeys) assert.equal(stageInput(h, 1, key).checked, false);
  });

  test(`${stage}: server expiration/completion switches off only the affected stage and preserves the open card`, async () => {
    const h = paginatedHarness();
    h.state.items[0].exam_stage_permissions = stages(true);
    await h.users.render();
    const card = h.card(1);
    card.classList.toggle('open', true);
    h.state.items[0].exam_stage_permissions[stage] = { ...stages()[stage], status: 'expired' };
    await h.users.refreshLiveUserStates({ force: true });
    assert.equal(h.card(1), card);
    assert.equal(card.classList.contains('open'), true);
    assert.equal(stageStatus(h, 1, stage).textContent, 'ვადა ამოიწურა');
    for (const key of stageKeys) assert.equal(stageInput(h, 1, key).checked, key !== stage);
  });
}

test('all three permissions can save independently, including reverse-order responses', async () => {
  const h = paginatedHarness();
  await h.users.render();
  const requests = [];
  for (const stage of stageKeys) {
    h.state.holdMutation = true;
    const input = stageInput(h, 1, stage);
    assert.equal(input.disabled, false);
    input.checked = true;
    requests.push(input.dispatch('change'));
    assert.equal(input.disabled, true);
  }
  for (let index = 2; index >= 0; index -= 1) {
    h.state.heldMutations[index]();
    await requests[index];
    for (const key of stageKeys) assert.equal(stageInput(h, 1, key).checked, true);
  }
  for (const key of stageKeys) assert.equal(stageInput(h, 1, key).disabled, false);
  assert.equal(h.state.mutations.length, 3);
});

test('polling during a pending grant does not clear its desired value or disable another stage', async () => {
  const h = paginatedHarness();
  await h.users.render();
  h.state.holdMutation = true;
  const input = stageInput(h, 1, 'theory');
  input.checked = true;
  const request = input.dispatch('change');
  h.state.items[0].exam_stage_permissions.theory = stages().theory;
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(input.checked, true);
  assert.equal(input.disabled, true);
  assert.equal(stageInput(h, 1, 'project_stage_1').disabled, false);
  h.state.items[0].exam_stage_permissions.theory = stages(true).theory;
  h.state.heldMutations.shift()();
  await request;
  assert.equal(input.checked, true);
});

test('duplicate change events cannot resubmit a pending stage or alter its displayed intent', async () => {
  const h = paginatedHarness();
  await h.users.render();
  h.state.holdMutation = true;
  const input = stageInput(h, 1, 'theory');
  input.checked = true;
  const request = input.dispatch('change');
  input.checked = false;
  await input.dispatch('change');
  assert.equal(input.checked, true);
  assert.equal(h.state.mutations.length, 1);
  h.state.heldMutations.shift()();
  await request;
});

test('a failed stage change restores only that stage without undoing a concurrent successful grant', async () => {
  const h = paginatedHarness();
  await h.users.render();
  h.state.failMutation = true;
  h.state.holdMutation = true;
  const first = stageInput(h, 1, 'theory');
  first.checked = true;
  const failed = first.dispatch('change');
  const second = stageInput(h, 1, 'project_stage_1');
  second.checked = true;
  await second.dispatch('change');
  h.state.heldMutations.shift()();
  await failed;
  assert.equal(first.checked, false);
  assert.equal(second.checked, true);
  assert.equal(h.state.alerts.length, 1);
});

for (const role of ['is_admin', 'is_founder']) {
  test(`${role}: all stages stay checked/read-only even with false legacy and stage data`, async () => {
    const h = harness({ paginated: true, founderActor: true });
    Object.assign(h.state.items[0], { is_admin: false, [role]: true, exam_permission: false });
    await h.users.render();
    for (const key of stageKeys) {
      const input = stageInput(h, 1, key);
      assert.equal(input.checked, true);
      assert.equal(input.disabled, true);
      input.checked = false;
      await input.dispatch('change');
      assert.equal(input.checked, true);
    }
    assert.equal(h.state.mutations.length, 0);
  });
}

test('founder-only role controls still grant permanent stages and demotion refreshes all stages', async () => {
  const h = harness({ paginated: true, founderActor: true });
  h.state.items[0].is_admin = false;
  await h.users.render();
  let admin = h.card(1).querySelector('.chk-admin');
  admin.checked = true;
  await admin.dispatch('change');
  for (const key of stageKeys) {
    assert.equal(stageInput(h, 1, key).checked, true);
    assert.equal(stageInput(h, 1, key).disabled, true);
  }
  admin = h.card(1).querySelector('.chk-admin');
  admin.checked = false;
  await admin.dispatch('change');
  for (const key of stageKeys) {
    assert.equal(stageInput(h, 1, key).checked, false);
    assert.equal(stageInput(h, 1, key).disabled, false);
  }
  assert.deepEqual(h.state.mutations.map((item) => item.type), ['admin', 'admin']);
});

test('regular admins cannot alter roles and founder role remains permanently read-only', async () => {
  const h = harness({ paginated: true });
  h.state.items[0].is_founder = true;
  await h.users.render();
  for (const id of [1, 3]) {
    const admin = h.card(id).querySelector('.chk-admin');
    assert.equal(admin.disabled, true);
    admin.checked = !admin.checked;
    await admin.dispatch('change');
  }
  assert.equal(h.state.mutations.length, 0);
  assert.equal(h.card(1).querySelector('.chk-admin').checked, true);
});

for (const legacyStage of [undefined, ...stageKeys, 'unknown']) {
  test(`missing stage contract shows only legacy ${legacyStage || 'default theory'} access read-only`, async () => {
    const h = paginatedHarness();
    delete h.state.items[0].exam_stage_permissions;
    Object.assign(h.state.items[0], { exam_permission: true, exam_stage: legacyStage });
    await h.users.render();
    for (const key of stageKeys) {
      const input = stageInput(h, 1, key);
      const expected = key === (legacyStage || 'theory');
      assert.equal(input.checked, expected);
      assert.equal(input.disabled, true);
      input.checked = !expected;
      await input.dispatch('change');
      assert.equal(input.checked, expected);
    }
    assert.equal(h.state.mutations.length, 0);
  });
}

test('partial new-format map never fills missing stages from the legacy scalar flag', async () => {
  const h = paginatedHarness();
  Object.assign(h.state.items[0], { exam_permission: true, exam_stage: 'theory',
    exam_stage_permissions: { project_stage_1: stages(true).project_stage_1 } });
  await h.users.render();
  for (const key of stageKeys) {
    assert.equal(stageInput(h, 1, key).checked, key === 'project_stage_1');
    assert.equal(stageInput(h, 1, key).disabled, key !== 'project_stage_1');
  }
});

test('empty new-format map leaves all stages unchecked/read-only despite a legacy grant', async () => {
  const h = paginatedHarness();
  Object.assign(h.state.items[0], { exam_permission: true, exam_stage: 'theory', exam_stage_permissions: {} });
  await h.users.render();
  for (const key of stageKeys) {
    assert.equal(stageInput(h, 1, key).checked, false);
    assert.equal(stageInput(h, 1, key).disabled, true);
  }
});

test('pending stage permission keeps a closed card mounted if live membership changes', async () => {
  const h = paginatedHarness();
  await h.users.render();
  const card = h.card(50);
  h.state.holdMutation = true;
  const input = stageInput(h, 50, 'project_stage_2');
  input.checked = true;
  const saving = input.dispatch('change');
  h.state.items.unshift(fixture(999, false, '2026-10-08', 'architect'));
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.card(50), card);
  assert.equal(h.DOM.usersListNotice.hidden, false);
  h.state.heldMutations.shift()();
  await saving;
  assert.equal(h.card(50), null);
  assert.equal(h.visible()[0], 999);
});

for (const stage of stageKeys) {
  test(`failed filters disable ${stage} until the selected result list is verified again`, async () => {
    const h = paginatedHarness();
    await h.users.render();
    h.state.failNext = true;
    h.DOM.filterMunicipal.checked = true;
    await h.DOM.filterMunicipal.dispatch('change');
    const input = stageInput(h, 1, stage);
    assert.equal(input.disabled, true);
    input.checked = true;
    await input.dispatch('change');
    assert.equal(h.state.mutations.length, 0);
    assert.equal(input.checked, false);
    await h.DOM.usersListRetry.dispatch('click');
    assert.equal(stageInput(h, 101, stage).disabled, false);
  });
}

test('paged lists request 50 records and navigate all people with accurate totals', async () => {
  const h = paginatedHarness();
  await h.users.render();
  assert.equal(h.state.requests.at(-1).get('paginated'), 'true');
  assert.equal(h.state.requests.at(-1).get('size'), '50');
  assert.equal(h.visible().length, 50);
  assert.equal(h.DOM.usersPagePrevious.disabled, true);
  assert.equal(h.DOM.usersPageStatus.textContent, '1–50 / 123 პირი');
  await h.DOM.usersPageNext.dispatch('click');
  assert.deepEqual(h.visible(), Array.from({ length: 50 }, (_, index) => index + 51));
  await h.DOM.usersPageNext.dispatch('click');
  assert.deepEqual(h.visible(), Array.from({ length: 23 }, (_, index) => index + 101));
  assert.equal(h.DOM.usersPageNext.disabled, true);
  assert.equal(h.DOM.usersPageStatus.textContent, '101–123 / 123 პირი');
  await h.DOM.usersPagePrevious.dispatch('click');
  assert.equal(h.visible()[0], 51);
});

test('qualifications and statement colors filter server-wide before paging and reset the current page', async () => {
  const h = paginatedHarness();
  await h.users.render();
  await h.DOM.usersPageNext.dispatch('click');
  h.DOM.filterMunicipal.checked = true;
  await h.DOM.filterMunicipal.dispatch('change');
  assert.equal(h.state.requests.at(-1).get('qualification'), 'municipal');
  assert.equal(h.state.requests.at(-1).get('page'), '1');
  assert.deepEqual(h.visible(), Array.from({ length: 23 }, (_, index) => index + 101));
  await h.newStatements();
  assert.deepEqual(h.visible(), [123]);
  assert.equal(h.state.requests.at(-1).get('new_statements'), 'true');
  assert.equal(h.DOM.usersPageStatus.textContent, '1–1 / 1 პირი');
  await h.date();
  assert.equal(h.visible().length, 23, 'date includes answered/blue/red senders, preserving the selected status checkbox');
  assert.equal(h.DOM.filterStatements.checked, true);
});

test('global new-statement badge stays on for a sender outside the displayed page and filters', async () => {
  const h = paginatedHarness();
  await h.users.render();
  assert.equal(h.visible().includes(123), false);
  assert.equal(h.DOM.navLinks[0].classList.contains('has-new-statements'), true);
  h.DOM.usersSearch.value = 'Person 1';
  await h.users.render();
  assert.equal(h.DOM.navLinks[0].classList.contains('has-new-statements'), true);
  h.users.updateUserUnseenStatus(1, false, 0, false, 0);
  assert.equal(h.DOM.navLinks[0].classList.contains('has-new-statements'), true);
  await h.flush();
  h.state.items[122].has_unseen_statements = false;
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.DOM.navLinks[0].classList.contains('has-new-statements'), false);
});

test('unchanged polling uses compact page data, one request and the same open card', async () => {
  const h = paginatedHarness();
  await h.users.render();
  const card = h.card(1);
  card.classList.toggle('open', true);
  const before = h.state.requests.length;
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.state.requests.length, before + 1);
  assert.equal(h.state.requests.at(-1).get('live'), 'true');
  assert.equal(h.state.responses.at(-1).items.length, 50);
  assert.equal('first_name' in h.state.responses.at(-1).items[0], false);
  assert.equal(h.card(1), card);
  assert.equal(card.classList.contains('open'), true);
});

test('live polling sees new and deleted people and preserves unchanged open cards', async () => {
  const h = paginatedHarness();
  await h.users.render();
  const card = h.card(1);
  card.classList.toggle('open', true);
  h.state.items.unshift(fixture(999, false, '2026-10-08', 'architect'));
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.visible()[0], 999);
  assert.equal(h.visible().length, 50);
  assert.equal(h.card(1), card);
  assert.equal(card.classList.contains('open'), true);
  h.state.items = h.state.items.filter((user) => user.id !== 2);
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.card(2), null);
  assert.equal(h.visible().length, 50, 'the next matching person fills the vacated slot');
});

test('profile and qualification changes refresh display and server-wide membership without closing other cards', async () => {
  const h = paginatedHarness();
  h.DOM.filterMunicipal.checked = true;
  await h.users.render();
  const card = h.card(101);
  card.classList.toggle('open', true);
  h.state.items[100].first_name = 'Updated name';
  h.state.items[0].certificate.level = 'municipal';
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.visible()[0], 1);
  assert.equal(h.card(101), card);
  assert.equal(card.querySelector('.user-name').textContent, 'Updated name');
  assert.equal(card.classList.contains('open'), true);
});

test('red and blue membership changes are refilled immediately after statement actions', async () => {
  const h = paginatedHarness();
  Object.assign(h.state.items[0], { has_unseen_statements: true, unseen_statement_count: 1 });
  await h.newStatements();
  assert.deepEqual(h.visible(), [1, 123]);
  Object.assign(h.state.items[0], { has_unseen_statements: false, unseen_statement_count: 0,
    has_pending_statements: true, pending_statement_count: 1 });
  h.users.updateUserUnseenStatus(1, false, 0, true, 1);
  await h.flush();
  assert.deepEqual(h.visible(), [123]);
  await h.newStatements(false);
  await h.pending();
  assert.deepEqual(h.visible(), [1]);
  Object.assign(h.state.items[0], { has_pending_statements: false, pending_statement_count: 0 });
  h.users.updateUserUnseenStatus(1, false, 0, false, 0);
  await h.flush();
  assert.deepEqual(h.visible(), []);
  assert.equal(h.DOM.usersPageStatus.textContent, 'პირები ვერ მოიძებნა');
});

test('last-page deletion automatically clamps to the last remaining page', async () => {
  const h = paginatedHarness();
  await h.users.render();
  await h.DOM.usersPageNext.dispatch('click');
  await h.DOM.usersPageNext.dispatch('click');
  h.state.items = h.state.items.slice(0, 100);
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.visible()[0], 51);
  assert.equal(h.DOM.usersPageStatus.textContent, '51–100 / 100 პირი');
  assert.equal(h.DOM.usersPageNext.disabled, true);
});

test('search debounces keystrokes for 250ms, invalidates stale responses and keeps current rows visible', async () => {
  const h = paginatedHarness();
  await h.users.render();
  h.state.hold = true;
  const old = h.users.render();
  const oldSignal = h.state.signals.at(-1);
  for (const value of ['P', 'Pe', 'Person 123']) {
    h.DOM.usersSearch.value = value;
    h.DOM.usersSearch.dispatch('input');
  }
  assert.equal(oldSignal.aborted, true);
  assert.equal(h.state.timers.size, 1);
  assert.equal([...h.state.timers.values()][0].delay, 250);
  assert.equal(h.visible().length, 50, 'typing and loading do not blank the list');
  const count = h.state.requests.length;
  h.state.pending.shift()();
  await old;
  assert.equal(h.state.requests.length, count);
  const timer = [...h.state.timers.values()][0];
  h.state.timers.clear();
  timer.fn();
  await h.flush();
  assert.equal(h.state.requests.length, count + 1);
  assert.deepEqual(h.visible(), [123]);
});

test('failed refresh retains visible people and releases the busy indicator', async () => {
  const h = paginatedHarness();
  await h.users.render();
  const card = h.card(1);
  h.state.failNext = true;
  await h.users.render();
  assert.equal(h.card(1), card);
  assert.equal(h.visible().length, 50);
  assert.equal(h.DOM.usersGrid.attributes['aria-busy'], 'false');
});

test('ordinary polling is paused while hidden and during an in-flight page request', async () => {
  const h = paginatedHarness();
  await h.users.render();
  h.document.hidden = true;
  const before = h.state.requests.length;
  await h.users.refreshLiveUserStates();
  assert.equal(h.state.requests.length, before);
  h.document.hidden = false;
  h.state.hold = true;
  const pending = h.users.render();
  await h.users.refreshLiveUserStates();
  assert.equal(h.state.requests.length, before + 1);
  h.state.pending.shift()();
  await pending;
});

test('a late page response cannot replace a newer filter and its result count', async () => {
  const h = paginatedHarness();
  await h.users.render();
  h.state.hold = true;
  const old = h.DOM.usersPageNext.dispatch('click');
  const oldSignal = h.state.signals.at(-1);
  h.DOM.filterMunicipal.checked = true;
  await h.DOM.filterMunicipal.dispatch('change');
  assert.equal(oldSignal.aborted, true);
  assert.equal(h.DOM.usersPageStatus.textContent, '1–23 / 23 პირი');
  h.state.pending.shift()();
  await old;
  assert.equal(h.visible()[0], 101);
  assert.equal(h.DOM.usersPageStatus.textContent, '1–23 / 23 პირი');
});

test('a late compact poll cannot undo a successful statement reply or resurrect the removed member', async () => {
  const h = paginatedHarness();
  Object.assign(h.state.items[0], { has_pending_statements: true, pending_statement_count: 1 });
  await h.pending();
  h.state.hold = true;
  const old = h.users.refreshLiveUserStates({ force: true });
  Object.assign(h.state.items[0], { has_pending_statements: false, pending_statement_count: 0 });
  h.users.updateUserUnseenStatus(1, false, 0, false, 0);
  await h.flush();
  assert.deepEqual(h.visible(), []);
  h.state.pending.shift()();
  await old;
  assert.deepEqual(h.visible(), []);
  assert.equal(h.DOM.usersPageStatus.textContent, 'პირები ვერ მოიძებნა');
});

test('an old compact response never switches off newly granted manual exam permission', async () => {
  const h = paginatedHarness();
  await h.users.render();
  h.state.hold = true;
  const old = h.users.refreshLiveUserStates({ force: true });
  const checkbox = h.card(1).querySelector('.chk-exam');
  checkbox.checked = true;
  await checkbox.dispatch('change');
  assert.equal(h.state.mutations.length, 1);
  assert.equal(h.state.mutations[0].payload.granted, true);
  assert.equal(h.state.mutations[0].type, 'exam-stage-permissions/theory');
  h.state.pending.shift()();
  await old;
  await h.flush();
  assert.equal(checkbox.checked, true);
  assert.equal(checkbox.disabled, false);
  assert.equal(h.state.alerts.length, 0);
});

test('failed next-page request retains both existing people and the current navigation position', async () => {
  const h = paginatedHarness();
  await h.users.render();
  h.state.failNext = true;
  await h.DOM.usersPageNext.dispatch('click');
  assert.equal(h.visible()[0], 1);
  assert.equal(h.DOM.usersPagePrevious.disabled, true);
  assert.equal(h.DOM.usersPageStatus.textContent, '1–50 / 123 პირი');
  await h.DOM.usersPageNext.dispatch('click');
  assert.equal(h.visible()[0], 51);
});

test('background page membership changes never discard an unfinished expanded scheduling editor', async () => {
  const h = paginatedHarness();
  await h.users.render();
  const lastCard = h.card(50);
  lastCard.classList.toggle('open', true);
  lastCard.querySelector('.exam-schedule-date').value = '2027-01-01';
  h.state.items.unshift(fixture(999, false, '2026-10-08', 'architect'));
  await h.users.refreshLiveUserStates({ force: true });
  assert.equal(h.card(50), lastCard);
  assert.equal(lastCard.querySelector('.exam-schedule-date').value, '2027-01-01');
  assert.equal(h.visible()[0], 1);
  assert.equal(h.DOM.usersListNotice.hidden, false);
  assert.match(h.DOM.usersListNoticeText.textContent, /შეყვანილი მონაცემების/);
  assert.equal(lastCard.querySelector('.chk-exam').disabled, true);
  await h.DOM.usersListRetry.dispatch('click');
  assert.equal(h.card(50), lastCard, 'retry must not throw away the unfinished editor either');
  await lastCard.querySelector('.head-toggle').dispatch('click');
  await h.flush();
  assert.equal(h.card(50), null);
  assert.equal(h.visible()[0], 999);
  assert.equal(h.DOM.usersListNotice.hidden, true);
  assert.equal(h.card(1).querySelector('.chk-exam').disabled, false);
});

test('failed filter results stay visibly stale and cannot be used to grant exam permission until retry succeeds', async () => {
  const h = paginatedHarness();
  await h.users.render();
  h.state.failNext = true;
  h.DOM.filterMunicipal.checked = true;
  await h.DOM.filterMunicipal.dispatch('change');
  assert.equal(h.visible()[0], 1, 'previous rows remain for context');
  assert.equal(h.DOM.usersListNotice.hidden, false);
  assert.equal(h.DOM.usersListRetry.hidden, false);
  assert.match(h.DOM.usersListNoticeText.textContent, /წინა შედეგები/);
  const checkbox = h.card(1).querySelector('.chk-exam');
  assert.equal(checkbox.disabled, true);
  checkbox.checked = true;
  await checkbox.dispatch('change');
  assert.equal(h.state.mutations.length, 0);
  await h.DOM.usersListRetry.dispatch('click');
  assert.equal(h.visible()[0], 101);
  assert.equal(h.DOM.usersListNotice.hidden, true);
  assert.equal(h.card(101).querySelector('.chk-exam').disabled, false);
});

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
  h.state.items[0].is_admin = false;
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

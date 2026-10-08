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
    this.selectors = {};
    this.value = ''; this.checked = false; this.disabled = false;
    const classes = new Set();
    this.classList = {
      contains: (name) => classes.has(name),
      toggle: (name, enabled = !classes.has(name)) => enabled ? classes.add(name) : classes.delete(name),
    };
  }
  addEventListener(name, handler) { this.events[name] = handler; }
  dispatch(name) { return this.events[name]?.({ target: this, preventDefault() {} }); }
  appendChild(child) { this.children.push(child); return child; }
  set innerHTML(html) {
    this.children = [];
    const id = html.match(/data-id="([^"]+)"/);
    if (id) {
      const card = new Element();
      card.dataset.id = id[1];
      card.selectors['.btn-user-announcements'] = new Element();
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

function harness() {
  const DOM = Object.fromEntries(['usersGrid', 'usersSearch', 'usersSort', 'onlyAdmins',
    'filterStatements', 'filterPendingStatements', 'statementsDate', 'clearStatementsDate', 'filterArchitects',
    'filterExperts', 'filterCertified'].map((key) => [key, new Element()]));
  DOM.navLinks = [Object.assign(new Element(), { textContent: 'რეგისტრირებული პირები' })];
  const state = { requests: [], hold: false, pending: [], items: [
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
      const items = state.items.filter((user) => (!day || user.days.includes(day)) &&
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
  });
  users.init();
  return { DOM, users, state,
    visible: () => DOM.usersGrid.children.filter((card) => card.style.display !== 'none').map((card) => Number(card.dataset.id)),
    card: (id) => DOM.usersGrid.querySelector(`.block-card[data-id="${id}"]`),
    date: async (value = '2026-10-08') => { DOM.statementsDate.value = value; await DOM.statementsDate.dispatch('change'); },
  };
}

function pendingHarness() {
  const h = harness();
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
  return h;
}

test('pending filter includes read unanswered users even with newer unread statements', async () => {
  const h = pendingHarness();
  await h.pending();
  assert.deepEqual(h.visible(), [2, 3]);
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
  assert.deepEqual(h.visible(), [1, 2, 3]);
  assertStatementState(card, 'blue');
  h.users.updateUserUnseenStatus(1, false, 0, false, 0);
  assert.deepEqual(h.visible(), [2, 3]);
  assertStatementState(card, 'normal');
  h.users.updateUserUnseenStatus(1, false, 0, true, 1);
  assert.deepEqual(h.visible(), [1, 2, 3]);
  assert.equal(h.card(1), card);
  // Replying to the older pending statement leaves only unread work: not pending.
  h.users.updateUserUnseenStatus(3, true, 1, false, 0);
  assert.deepEqual(h.visible(), [1, 2]);
  assertStatementState(h.card(3), 'red');
});

test('pending and statements filters are exclusive and pending ignores but retains a selected date', async () => {
  const h = pendingHarness();
  await h.date();
  await h.pending();
  assert.equal(h.DOM.filterStatements.checked, false);
  assert.equal(h.DOM.statementsDate.value, '2026-10-08');
  assert.equal(h.DOM.statementsDate.disabled, true);
  assert.equal(h.DOM.clearStatementsDate.disabled, true);
  assert.equal(h.state.requests.at(-1).has('statement_date'), false);
  assert.deepEqual(h.visible(), [2, 3]);
  h.DOM.filterStatements.checked = true;
  await h.DOM.filterStatements.dispatch('change');
  assert.equal(h.DOM.filterPendingStatements.checked, false);
  assert.equal(h.DOM.statementsDate.disabled, false);
  assert.equal(h.DOM.clearStatementsDate.disabled, false);
  assert.equal(h.state.requests.at(-1).get('statement_date'), '2026-10-08');
  assert.deepEqual(h.visible(), [1, 2, 5]);
  await h.DOM.clearStatementsDate.dispatch('click');
  assert.deepEqual(h.visible(), [1, 3]);
  await h.pending();
  assert.equal(h.DOM.filterStatements.checked, false);
  assert.deepEqual(h.visible(), [2, 3]);
});

test('turning pending filter off restores date controls and does not silently enable date filtering', async () => {
  const h = pendingHarness();
  await h.date();
  await h.pending();
  await h.pending(false);
  assert.equal(h.DOM.filterStatements.checked, false);
  assert.equal(h.DOM.statementsDate.value, '2026-10-08');
  assert.equal(h.DOM.statementsDate.disabled, false);
  assert.equal(h.DOM.clearStatementsDate.disabled, false);
  assert.equal(h.state.requests.at(-1).has('statement_date'), false);
  assert.deepEqual(h.visible(), [1, 2, 3, 4, 5]);
  await h.DOM.clearStatementsDate.dispatch('click');
  assert.equal(h.DOM.clearStatementsDate.disabled, true);
  await h.pending();
  await h.pending(false);
  assert.equal(h.DOM.statementsDate.disabled, false);
  assert.equal(h.DOM.clearStatementsDate.disabled, true);
});

test('choosing a date activates statements mode and clears pending mode', async () => {
  const h = pendingHarness();
  await h.pending();
  // Programmatic change also follows the same invariant as a user-selected date.
  await h.date('2026-10-07');
  assert.equal(h.DOM.filterStatements.checked, true);
  assert.equal(h.DOM.filterPendingStatements.checked, false);
  assert.equal(h.DOM.statementsDate.disabled, false);
  assert.equal(h.DOM.clearStatementsDate.disabled, false);
  assert.equal(h.state.requests.at(-1).get('statement_date'), '2026-10-07');
  assert.deepEqual(h.visible(), [3]);
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
  assert.deepEqual(h.visible(), [3]);
  h.DOM.filterArchitects.checked = false;
  h.DOM.filterCertified.checked = true;
  await h.users.render();
  assert.deepEqual(h.visible(), [2, 3]);
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
  assert.deepEqual(h.visible(), [1, 3]);
  assert.equal(h.card(2), card);
  assert.equal(card.classList.contains('open'), true);
  assertStatementState(card, 'normal');
  Object.assign(h.state.items[1], { has_unseen_statements: true, unseen_statement_count: 1,
    has_pending_statements: true, pending_statement_count: 2 });
  await h.users.refreshLiveUserStates({ force: true });
  assert.deepEqual(h.visible(), [1, 2, 3]);
  assert.equal(h.card(2), card);
  assertStatementState(card, 'red');
});

test('legacy unread-only status updates preserve pending membership on mixed red cards', async () => {
  const h = pendingHarness();
  await h.pending();
  h.users.updateUserUnseenStatus(3, true, 2);
  assert.deepEqual(h.visible(), [2, 3]);
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
    await h.pending();
    assert.deepEqual(h.visible(), [2, 3]);
    assert.equal(h.state.pending.length, 1);
    h.state.pending.shift()();
    await staleRequest;
    assert.deepEqual(h.visible(), [2, 3]);
  });

  test(`late ${requestType} response cannot return replied users to the pending filter`, async () => {
    const h = pendingHarness();
    await h.pending();
    h.state.hold = true;
    const staleRequest = requestType === 'render' ? h.users.render() : h.users.refreshLiveUserStates({ force: true });
    Object.assign(h.state.items[1], { has_pending_statements: false, pending_statement_count: 0 });
    h.users.updateUserUnseenStatus(2, false, 0, false, 0);
    if (requestType === 'poll') assert.deepEqual(h.visible(), [3]);
    h.state.pending.shift()();
    await staleRequest;
    assert.deepEqual(h.visible(), [3]);
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

test('date selection enables statements filter and keeps both read and unread senders visible', async () => {
  const h = harness();
  await h.date();
  assert.equal(h.DOM.filterStatements.checked, true);
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
  await h.date();
  assert.equal(h.DOM.clearStatementsDate.disabled, false);
  await h.DOM.clearStatementsDate.dispatch('click');
  assert.equal(h.DOM.statementsDate.value, '');
  assert.equal(h.DOM.clearStatementsDate.disabled, true);
  assert.equal(h.DOM.filterStatements.checked, true);
  assert.equal(h.state.requests.at(-1).has('statement_date'), false);
  assert.deepEqual(h.visible(), [1, 3, 5]);
});

test('turning statements checkbox off ignores a retained selected date', async () => {
  const h = harness();
  await h.date();
  h.DOM.filterStatements.checked = false;
  await h.DOM.filterStatements.dispatch('change');
  assert.equal(h.DOM.statementsDate.value, '2026-10-08');
  assert.equal(h.state.requests.at(-1).has('statement_date'), false);
  assert.deepEqual(h.visible(), [1, 2, 3, 4, 5]);
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

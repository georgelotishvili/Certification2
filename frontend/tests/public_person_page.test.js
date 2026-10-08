const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/my.js'), 'utf8');
const markup = fs.readFileSync(path.join(__dirname, '../pages/my.html'), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.events = {}; this.attributes = {};
    this.style = {}; this.dataset = {}; this.value = ''; this.hidden = false;
    this._text = ''; this._html = ''; this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, value = !this.classes.has(name)) => {
        if (value) this.classes.add(name); else this.classes.delete(name);
        return value;
      },
    };
  }
  set className(value) { this.classes = new Set(String(value).split(/\s+/)); }
  get className() { return [...this.classes].join(' '); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) { this._html = value; this._text = ''; this.children = []; }
  get innerHTML() { return this._html; }
  appendChild(node) {
    if (node.tagName === 'fragment') { [...node.children].forEach((child) => this.appendChild(child)); return node; }
    node.parentElement = this; this.children.push(node); return node;
  }
  remove() {
    this.removed = true;
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  dispatchEvent(event) { for (const callback of this.events[event.type] || []) callback(event); }
  async dispatch(type, values = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...values };
    await Promise.all((this.events[type] || []).map((callback) => callback(event)));
  }
  matches(selector) {
    if (selector.startsWith('.')) return this.classes.has(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName === selector;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() {}
}

function profile(overrides = {}) {
  return {
    id: 42, code: '0123456789', first_name: 'Test', last_name: 'Person', email: 'person@example.test',
    created_at: '2026-01-01T12:00:00',
    certificate: { unique_code: '0123456789', level: 'expert', status: 'active',
      issue_date: '2026-02-01T12:00:00', validity_term: 5, valid_until: '2031-02-01T12:00:00' },
    ...overrides,
  };
}

const actor = { id: 99, firstName: 'Signed In', lastName: 'Viewer', email: 'viewer@example.test', code: '9999999999' };

function harness(options = {}) {
  const ids = {};
  const document = new Element('document'); document.body = new Element('body'); document.appendChild(document.body);
  const grid = new Element(); grid.className = 'my-grid'; document.body.appendChild(grid);
  const certSection = new Element('section'); certSection.className = 'cert-section is-hidden'; grid.appendChild(certSection);
  const expertSection = new Element('section'); expertSection.className = 'expert-section is-hidden'; grid.appendChild(expertSection);
  for (const [, id] of markup.matchAll(/\bid="([^"]+)"/g)) {
    const element = ids[id] = new Element(); element.id = id; grid.appendChild(element);
  }
  certSection.appendChild(ids.certCard); expertSection.appendChild(ids.expertCard);
  for (const id of ['myPersonalId', 'myPhone', 'myCode']) {
    const row = new Element(); row.className = 'profile-row'; row.appendChild(ids[id]); grid.appendChild(row);
  }
  const actions = new Element(); actions.className = 'expert-actions'; grid.appendChild(actions);
  ids.profileEditBtn.style.display = 'none'; ids.certDownloadBtn.setAttribute('disabled', 'true');
  ids.reviewsCard.classList.add('disabled');
  for (let value = 1; value <= 5; value += 1) {
    const star = new Element('button'); star.className = 'star'; star.dataset.value = value; ids.reviewStars.appendChild(star);
  }
  document.getElementById = (id) => ids[id] || null;
  document.createElement = (tag) => new Element(tag);
  document.createDocumentFragment = () => new Element('fragment');
  const state = { requests: [], photos: [], alerts: [], pending: [], unexpected: [] };
  const currentActor = options.actor || null;
  const publicData = profile(options.profile);
  const summary = { average: 4.25, ratings_count: 2, comments: [
    { id: 5, author_user_id: 17, author_first_name: 'Reviewer', author_last_name: 'Test', message: 'Public comment', created_at: '2026-02-03T10:00:00' },
  ] };
  const window = {
    location: { search: options.search ?? '?code=0123456789', href: 'my.html', reload() { state.reloaded = true; } },
    APP_CONFIG: { API_BASE: 'https://api.test' },
    Auth: {
      isLoggedIn: () => !!currentActor, getCurrentUser: () => currentActor,
      getSavedEmail: () => currentActor?.email || '',
      getAuthHeaders: () => currentActor ? { Authorization: 'Bearer test-session' } : {},
    },
    Utils: { formatDateTime: (value) => value || '—', parseUtcDate: (value) => new Date(value), attachCopyButton() {} },
  };
  const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status,
    json: async () => structuredClone(data), clone() { return this; } });
  const fetch = async (address, init = {}) => {
    const url = new URL(address); state.requests.push({ url, init });
    if (/\/public-details$/.test(url.pathname) || url.pathname.startsWith('/users/public/by-code/')) {
      if (options.networkError) throw new Error('offline');
      if (options.hold) return new Promise((resolve) => state.pending.push(() => resolve(response(publicData, options.status || 200))));
      return response(publicData, options.status || 200);
    }
    if (/\/reviews\/\d+\/summary$/.test(url.pathname)) return response(summary);
    if (/\/reviews\/\d+\/rating$/.test(url.pathname)) return response(summary);
    if (/\/reviews\/\d+\/comments$/.test(url.pathname)) return response({ id: 6 });
    if (url.pathname.startsWith('/expert-uploads/of/')) return response(options.uploads || [
      { id: 8, status: 'submitted', unique_code: 'project-code', building_function: 'Public project', cadastral_code: '1.2.3',
        project_address: 'Project address', expertise_filename: 'report.pdf', project_filename: 'project.pdf' },
    ]);
    if (url.pathname === '/expert-uploads/mine') return response([]);
    if (url.pathname === '/users/profile') return response({ id: currentActor?.id, first_name: 'Owner', last_name: 'Name',
      email: currentActor?.email, personal_id: 'private-id', phone: 'private-phone', code: currentActor?.code });
    if (/\/users\/\d+\/certificate$/.test(url.pathname)) return response(publicData.certificate);
    state.unexpected.push(address); return response({}, 404);
  };
  class Image {
    set src(value) { state.photos.push(value); if (this.onload) this.onload(); }
  }
  vm.runInNewContext(source, { window, document, fetch, Image, URL, URLSearchParams,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    alert: (message) => state.alerts.push(message), confirm: () => true, console, setTimeout, clearTimeout, FormData,
  });
  const ready = Promise.all(document.events.DOMContentLoaded.map((callback) => callback()));
  return { ids, grid, certSection, expertSection, window, document, state, ready };
}

async function settle(h) { await h.ready; for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
function requests(h, pattern) { return h.state.requests.filter(({ url }) => pattern.test(url.pathname)); }
function fields(h) {
  return ['pageTitle', 'myFirstName', 'myLastName', 'myEmail', 'myCreatedAt', 'myCertCode', 'myCertLevel',
    'myCertStatus', 'myCertIssueDate', 'myCertValidityTerm', 'myCertValidUntil', 'reviewsComments', 'expertList']
    .map((id) => h.ids[id].textContent);
}

test('QR code resolves once before all user-ID-dependent reads and never requests the actor profile', async () => {
  const h = harness({ actor, hold: true });
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.requests[0].url.pathname, '/users/public/by-code/0123456789');
  assert.equal(h.state.requests[0].init.headers.Authorization, undefined);
  assert.equal(h.state.photos.length, 0);
  assert.equal(h.ids.pageTitle.textContent.includes(actor.firstName), false);
  h.state.pending[0](); await settle(h);
  assert.equal(h.ids.pageTitle.textContent, 'Test Person');
  assert.equal(requests(h, /\/users\/profile|\/users\/\d+\/certificate$/).length, 0);
  assert.ok(requests(h, /^\/reviews\/42\/summary$/).length);
  assert.ok(requests(h, /^\/expert-uploads\/of\/42$/).length);
  assert.deepEqual(h.state.photos, ['https://api.test/users/42/photo/file']);
  assert.deepEqual(h.state.unexpected, []);
});

test('anonymous and signed-in visitors see identical public profile, certificate, comments and submitted expert projects', async () => {
  const guest = harness(); const signedIn = harness({ actor }); await Promise.all([settle(guest), settle(signedIn)]);
  assert.deepEqual(fields(guest), fields(signedIn));
  assert.equal(guest.ids.myCertStatus.textContent, 'მოქმედი');
  assert.equal(guest.certSection.classList.contains('is-hidden'), false);
  assert.equal(guest.expertSection.classList.contains('is-hidden'), false);
  assert.equal(guest.ids.reviewsCard.classList.contains('disabled'), false);
  assert.match(guest.ids.reviewsComments.textContent, /Public comment/);
  assert.match(guest.ids.expertList.textContent, /Public project/);
  const links = guest.ids.expertList.querySelectorAll('a');
  assert.equal(links.length, 2);
  assert.ok(links.every((link) => link.href.startsWith('https://api.test/expert-uploads/public/8/download?')));
  assert.equal(guest.ids.expertForm.style.display, 'none');
});

test('existing userId links use the same public bundle without requiring sign-in', async () => {
  const h = harness({ search: '?userId=42' }); await settle(h);
  assert.equal(h.state.requests[0].url.pathname, '/users/42/public-details');
  assert.equal(h.ids.myCertCode.textContent, '0123456789');
  assert.equal(h.window.location.href, 'my.html');
});

for (const search of ['?code=', '?code=invalid', '?code=123', '?code=12345678901', '?code=invalid&userId=42',
  '?code=0123456789%0A', '?code=0123456789%0D%0A', '?code=%200123456789',
  '?userId=', '?userId=-1', '?userId=1.2', '?userId=NaN', '?userId=9007199254740992', '?userId=42%0A']) {
  test(`malformed public link ${search} fails closed even for signed-in visitors`, async () => {
    const h = harness({ search, actor }); await settle(h);
    assert.equal(h.state.requests.length, 0);
    assert.equal(h.state.photos.length, 0);
    assert.equal(h.grid.hidden, true);
    assert.equal(h.ids.profileEditBtn.style.display, 'none');
    assert.match(h.ids.pageTitle.textContent, /ვერ მოიძებნა/);
    assert.equal(h.ids.myFirstName.textContent, '');
  });
}

test('valid persistent code takes precedence over a conflicting old user ID', async () => {
  const h = harness({ search: '?code=0123456789&userId=99', actor }); await settle(h);
  assert.equal(h.state.requests[0].url.pathname, '/users/public/by-code/0123456789');
  assert.equal(requests(h, /\/99(?:\/|$)/).length, 0);
  assert.equal(h.ids.pageTitle.textContent, 'Test Person');
});

for (const status of [404, 500]) {
  test(`public lookup ${status} never falls back to another account or registry`, async () => {
    const h = harness({ status, actor }); await settle(h);
    assert.equal(h.state.requests.length, 1);
    assert.equal(h.grid.hidden, true);
    assert.equal(h.grid.style.display, 'none');
    assert.equal(h.grid.getAttribute('aria-busy'), 'false');
    assert.equal(h.ids.pageTitle.getAttribute('role'), 'alert');
    assert.match(h.ids.pageTitle.textContent, status === 404 ? /ვერ მოიძებნა/ : /განაახლოთ გვერდი/);
  });
}

test('network failure is shown as a retryable loading error, not a missing certificate', async () => {
  const h = harness({ networkError: true }); await settle(h);
  assert.match(h.ids.pageTitle.textContent, /განაახლოთ გვერდი/);
  assert.equal(h.grid.hidden, true);
});

for (const invalid of [{ id: 0 }, { id: 42.5 }, { code: '9876543210' }, { certificate: null }]) {
  test(`unexpected lookup payload fails closed: ${JSON.stringify(invalid)}`, async () => {
    const h = harness({ profile: invalid, actor }); await settle(h);
    assert.equal(h.state.requests.length, 1);
    assert.equal(h.grid.hidden, true);
    assert.equal(h.ids.myFirstName.textContent, '');
  });
}

test('re-registered person uses the new resolved account ID while printed code stays unchanged', async () => {
  const h = harness({ profile: { id: 314 } }); await settle(h);
  assert.equal(h.ids.myCertCode.textContent, '0123456789');
  assert.ok(requests(h, /^\/reviews\/314\/summary$/).length);
  assert.ok(requests(h, /^\/expert-uploads\/of\/314$/).length);
  await h.ids.certDownloadBtn.dispatch('click');
  assert.equal(new URL(h.window.location.href).pathname, '/users/314/certificate/file');
});

for (const [status, expected] of [['active', 'მოქმედი'], ['suspended', 'შეჩერებული'], ['expired', 'ვადაგასული']]) {
  test(`public certificate exposes accurate ${status} status without granting inactive download`, async () => {
    const h = harness({ profile: { certificate: { ...profile().certificate, status } } }); await settle(h);
    assert.equal(h.ids.myCertStatus.textContent, expected);
    assert.equal(h.certSection.classList.contains('is-hidden'), false);
    assert.equal(h.ids.certDownloadBtn.getAttribute('disabled') !== null, status !== 'active');
  });
}

test('expiry date also disables download and displays expired even before a stored status refresh', async () => {
  const h = harness({ profile: { certificate: { ...profile().certificate, valid_until: '2020-01-01T12:00:00' } } }); await settle(h);
  assert.equal(h.ids.myCertStatus.textContent, 'ვადაგასული');
  assert.equal(h.ids.certDownloadBtn.getAttribute('disabled'), 'true');
});

test('public view removes private identity, phone and duplicate personal code rows; no edit controls are bound', async () => {
  const h = harness({ actor, profile: { personal_id: 'PRIVATE-ID', phone: 'PRIVATE-PHONE', is_admin: true } }); await settle(h);
  for (const id of ['myPersonalId', 'myPhone', 'myCode']) assert.equal(h.ids[id].parentElement.removed, true);
  assert.equal(h.ids.profileEditBtn.style.display, 'none');
  assert.equal(h.ids.profileEditBtn.events.click, undefined);
  assert.equal(h.ids.profileEditForm.events.submit, undefined);
  assert.equal(h.ids.expertSubmitBtn.events.click, undefined);
  assert.equal(fields(h).join(' ').includes('PRIVATE'), false);
});

test('anonymous visitor cannot post comments or ratings, including direct form submit', async () => {
  const h = harness(); await settle(h);
  assert.ok(h.ids.reviewStars.children.every((star) => star.getAttribute('aria-disabled') === 'true'));
  h.ids.reviewCommentMessage.value = 'Attempt';
  await h.ids.reviewCommentForm.dispatch('submit');
  await h.ids.reviewStars.dispatch('click');
  await h.ids.criteriaForm.dispatch('submit');
  await settle(h);
  assert.equal(h.state.requests.some(({ init }) => init.method === 'POST'), false);
  assert.equal(h.state.alerts.length, 2);
  assert.equal(h.ids.ratingsOverlay.classList.contains('open'), false);
});

test('signed-in other visitor retains authenticated comment and rating functionality', async () => {
  const h = harness({ actor }); await settle(h);
  assert.ok(h.ids.reviewStars.children.every((star) => star.getAttribute('aria-disabled') === 'false'));
  h.ids.reviewCommentMessage.value = 'Allowed';
  await h.ids.reviewCommentForm.dispatch('submit'); await settle(h);
  await h.ids.reviewStars.dispatch('click');
  assert.equal(h.ids.ratingsOverlay.classList.contains('open'), true);
  await h.ids.criteriaForm.dispatch('submit'); await settle(h);
  for (const suffix of ['comments', 'rating']) {
    const write = requests(h, new RegExp(`^/reviews/42/${suffix}$`)).find(({ init }) => init.method === 'POST');
    assert.ok(write); assert.equal(write.init.headers.Authorization, 'Bearer test-session');
  }
});

test('viewing own QR page stays public/read-only and still prevents self-rating', async () => {
  const h = harness({ actor: { ...actor, id: '42' } }); await settle(h);
  assert.ok(h.ids.reviewStars.children.every((star) => star.getAttribute('aria-disabled') === 'true'));
  assert.equal(h.ids.profileEditBtn.style.display, 'none');
});

test('architect and municipal public pages do not fetch or expose expert upload controls', async () => {
  for (const level of ['architect', 'municipal']) {
    const h = harness({ profile: { certificate: { ...profile().certificate, level } } }); await settle(h);
    assert.equal(h.expertSection.classList.contains('is-hidden'), true);
    assert.equal(requests(h, /expert-uploads/).length, 0);
  }
});

test('own profile without a target retains auth guard, private data, editing and existing certificate endpoint', async () => {
  const owner = harness({ search: '', actor }); await settle(owner);
  assert.equal(owner.ids.myPersonalId.textContent, 'private-id');
  assert.equal(owner.ids.myPhone.textContent, 'private-phone');
  assert.equal(owner.ids.profileEditBtn.style.display, '');
  assert.ok(owner.ids.profileEditForm.events.submit.length);
  assert.equal(requests(owner, /^\/users\/99\/certificate$/).length, 1);
  assert.equal(requests(owner, /public-details|by-code/).length, 0);
  const guest = harness({ search: '' }); await settle(guest);
  assert.equal(guest.window.location.href, 'index.html');
  assert.equal(guest.state.requests.length, 0);
});

test('public text is rendered as text rather than injected HTML', async () => {
  const h = harness({ profile: { first_name: '<img src=x onerror=alert(1)>', email: '<script>bad()</script>' } }); await settle(h);
  assert.equal(h.ids.myFirstName.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(h.ids.myFirstName.innerHTML, '');
  assert.equal(h.ids.myEmail.innerHTML, '');
});

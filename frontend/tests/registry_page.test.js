const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../scripts/registry.mini.js'), 'utf8');

function decode(value) {
  return String(value).replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// A small isolated DOM sufficient for the registry. No network, real users, or server writes.
class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = []; this.events = {}; this.dataset = {}; this.attributes = {}; this.style = {};
    this.value = ''; this.checked = false; this.hidden = false; this.disabled = false;
    this._text = ''; this._html = ''; this._classes = new Set();
    this.classList = {
      contains: (name) => this._classes.has(name),
      add: (...names) => names.forEach((name) => this._classes.add(name)),
      remove: (...names) => names.forEach((name) => this._classes.delete(name)),
      toggle: (name, force = !this._classes.has(name)) => {
        if (force) this._classes.add(name); else this._classes.delete(name);
        return force;
      },
    };
  }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) { this._text = String(value); this._html = ''; this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) {
    this.children = []; this._text = ''; this._html = String(value);
    const stack = [this];
    for (const token of String(value).match(/<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g) || []) {
      if (token.startsWith('<!--')) continue;
      if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
      if (token.startsWith('<')) {
        const tag = token.match(/^<([\w-]+)/)[1];
        const node = new Element(tag);
        for (const [, name, double, single, bare] of token.matchAll(/\s([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
          node.setAttribute(name, decode(double ?? single ?? bare ?? ''));
        }
        stack.at(-1).appendChild(node);
        if (!['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'wbr'].includes(tag.toLowerCase()) && !token.endsWith('/>')) stack.push(node);
      } else {
        const text = new Element('#text'); text.textContent = decode(token); stack.at(-1).appendChild(text);
      }
    }
  }
  get innerHTML() { return this._html; }
  get firstElementChild() { return this.children.find((child) => child.tagName !== '#TEXT') || null; }
  get parentNode() { return this.parentElement || null; }
  appendChild(child) {
    if (child.tagName === '#FRAGMENT') {
      for (const element of [...child.children]) this.appendChild(element);
      return child;
    }
    if (child.parentElement) child.parentElement.children = child.parentElement.children.filter((item) => item !== child);
    child.parentElement = this; this.children.push(child); return child;
  }
  insertBefore(child, before) {
    const index = this.children.indexOf(before);
    assert.ok(index >= 0);
    child.parentElement = this; this.children.splice(index, 0, child); return child;
  }
  append(...children) {
    for (let child of children) {
      if (typeof child === 'string') { const text = new Element('#text'); text.textContent = child; child = text; }
      this.appendChild(child);
    }
  }
  replaceChildren(...children) { this.innerHTML = ''; this.append(...children); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
    else if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    else if (name === 'hidden') this.hidden = true;
    else this[name] = String(value);
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  async dispatch(name, values = {}) {
    const event = { target: this, defaultPrevented: false, propagationStopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.propagationStopped = true; }, ...values };
    await Promise.all((this.events[name] || []).map((handler) => handler(event)));
    return event;
  }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some((part) => this.matches(part.trim()));
    const tag = selector.match(/^[\w-]+/);
    if (tag && this.tagName !== tag[0].toUpperCase()) return false;
    const id = selector.match(/#([\w-]+)/);
    if (id && this.id !== id[1]) return false;
    if ([...selector.matchAll(/\.([\w-]+)/g)].some(([, name]) => !this.classList.contains(name))) return false;
    for (const [, name, value] of selector.matchAll(/\[([\w-]+)="([^"]*)"\]/g)) {
      if (this.getAttribute(name) !== value) return false;
    }
    return true;
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  focus() { this.focused = true; }
}

function people() {
  return [
    { id: 1, full_name: 'Ana Abashidze', unique_code: '100001', qualification: 'architect',
      certificate_status: 'active', rating: 4, registration_date: '2026-10-01T12:00:00Z' },
    { id: 2, full_name: 'Beka Beridze', unique_code: '100002', qualification: 'expert',
      certificate_status: 'suspended', rating: 2, registration_date: '2026-10-03T12:00:00Z' },
    { id: 3, full_name: 'Dato Chikovani', unique_code: '200003', qualification: 'municipal',
      certificate_status: 'expired', rating: 5, registration_date: '2026-10-02T12:00:00Z' },
  ];
}

function harness(options = {}) {
  const DOM = {};
  const document = new Element('document');
  document.body = new Element('body'); document.appendChild(document.body);
  document.createElement = (tag) => new Element(tag);
  document.createDocumentFragment = () => new Element('#fragment');
  document.getElementById = (id) => DOM[id] || null;
  if (options.mode !== 'absent') {
    for (const key of ['registryPage', 'registryList', 'registrySearch', 'registryFilterArchitect', 'registryFilterExpert',
      'registryFilterMunicipal', 'registrySort', 'registryResultsCount', 'registryTotalCount', 'registryResetFilters']) {
      const element = DOM[key] = new Element(key.includes('Filter') || key === 'registrySearch' ? 'input' : key === 'registrySort' ? 'select' : 'div');
      element.id = key;
    }
    document.body.appendChild(DOM.registryPage);
    for (const [key, node] of Object.entries(DOM)) if (key !== 'registryPage') DOM.registryPage.appendChild(node);
    const checkboxes = new Element(); checkboxes.className = 'registry-checkboxes';
    DOM.registryPage.appendChild(checkboxes);
    for (const key of ['registryFilterArchitect', 'registryFilterExpert', 'registryFilterMunicipal']) checkboxes.appendChild(DOM[key]);
    DOM.registrySort.value = 'date_desc';
  }
  const state = { items: options.items ?? people(), requests: [], fail: !!options.fail, hold: !!options.hold, pending: [], average: 4.75 };
  const window = { location: { href: 'http://test.local/pages/registry.html' }, APP_CONFIG: { API_BASE: 'http://api.test' } };
  const fetch = async (address, requestOptions = {}) => {
    const url = new URL(address);
    state.requests.push({ url, options: requestOptions });
    if (/^\/reviews\/[^/]+\/summary$/.test(url.pathname)) return { ok: true, json: async () => ({ average: state.average }) };
    assert.equal(url.pathname, '/certified-persons/registry');
    assert.equal(requestOptions.method || 'GET', 'GET', 'public registry must be read-only');
    const snapshot = structuredClone(state.items);
    const response = { ok: !state.fail, json: async () => snapshot };
    if (state.hold) {
      state.hold = false;
      return new Promise((resolve) => state.pending.push(() => resolve(response)));
    }
    return response;
  };
  vm.runInNewContext(source, { window, document, fetch, URL, URLSearchParams, console, setTimeout, clearTimeout });
  const registry = window.Registry.init({ refreshRating: options.refreshRating ?? false });
  const h = { DOM, document, window, state, registry,
    cards: () => DOM.registryList?.querySelectorAll('.registry-card').filter((card) => !card.classList.contains('registry-skeleton-card')) || [],
    names: () => h.cards().map((card) => card.querySelector('.registry-name')?.textContent.trim()),
    async input(value) { DOM.registrySearch.value = value; await DOM.registrySearch.dispatch('input'); },
    async filter(kind, checked = true) { const checkbox = DOM[`registryFilter${kind}`]; checkbox.checked = checked; await checkbox.dispatch('change'); },
    async sort(key) { DOM.registrySort.value = key; await DOM.registrySort.dispatch('change'); },
  };
  return h;
}

async function settle() { for (let index = 0; index < 12; index += 1) await Promise.resolve(); }

test('a dedicated registry page loads automatically without opening an overlay or locking scrolling', async () => {
  const h = harness(); await settle();
  assert.equal(h.state.requests.length, 1);
  assert.equal(h.state.requests[0].url.searchParams.get('limit'), '500');
  assert.equal(h.state.requests[0].options.headers['Cache-Control'], 'no-cache');
  assert.deepEqual(h.names(), ['Beka Beridze', 'Dato Chikovani', 'Ana Abashidze']);
  assert.equal(h.document.body.classList.contains('registry-open'), false);
  h.registry.close(); h.registry.open(); await settle();
  assert.equal(h.document.body.classList.contains('registry-open'), false);
  assert.equal(h.state.requests.length, 1);
});

test('shared initialization without registry markup neither fetches nor intercepts native navigation', async () => {
  const h = harness({ mode: 'absent' }); await settle();
  const link = new Element('a'); link.className = 'nav-registry'; link.href = '../pages/registry.html';
  const event = await h.document.dispatch('click', { target: link });
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.state.requests.length, 0);
  h.registry.open(); h.registry.close(); await h.registry.refresh();
  assert.equal(h.state.requests.length, 0);
  assert.equal(h.document.body.classList.contains('registry-open'), false);
});

test('dedicated page does not turn header registry links back into modal triggers', async () => {
  const h = harness(); await settle();
  for (const className of ['nav-registry', 'drawer-registry']) {
    const link = new Element('a'); link.className = className; link.href = '../pages/registry.html';
    const event = await h.document.dispatch('click', { target: link });
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(h.document.body.classList.contains('registry-open'), false);
});

for (const [query, names] of [
  ['ana', ['Ana Abashidze']], ['ABASHIDZE', ['Ana Abashidze']], ['  Beka   Beridze  ', ['Beka Beridze']],
  ['200003', ['Dato Chikovani']], ['nobody', []],
]) {
  test(`registry searches names and certification codes: ${query.trim()}`, async () => {
    const h = harness(); await settle(); await h.input(query);
    assert.deepEqual(h.names(), names);
    assert.equal(h.state.requests.length, 1, 'typing must not start extra registry requests');
  });
}

for (const [kind, expected] of [['Architect', ['Ana Abashidze']], ['Expert', ['Beka Beridze']], ['Municipal', ['Dato Chikovani']]]) {
  test(`${kind} qualification filtering preserves every existing certificate status`, async () => {
    const h = harness(); await settle(); await h.filter(kind);
    assert.deepEqual(h.names(), expected);
  });
}

test('qualification filters form a union; all three include the complete registry', async () => {
  const h = harness(); await settle();
  await h.filter('Architect'); await h.filter('Municipal');
  assert.deepEqual(h.names(), ['Dato Chikovani', 'Ana Abashidze']);
  await h.filter('Expert');
  assert.deepEqual(h.names(), ['Beka Beridze', 'Dato Chikovani', 'Ana Abashidze']);
  assert.equal(h.DOM.registryFilterArchitect.checked, true);
  assert.equal(h.DOM.registryFilterMunicipal.checked, true);
});

test('name search and qualification filters work together', async () => {
  const h = harness(); await settle(); await h.filter('Architect'); await h.input('Beridze');
  assert.deepEqual(h.names(), []);
  await h.filter('Expert');
  assert.deepEqual(h.names(), ['Beka Beridze']);
});

for (const [sort, expected] of [
  ['name_asc', ['Ana Abashidze', 'Beka Beridze', 'Dato Chikovani']],
  ['name_desc', ['Dato Chikovani', 'Beka Beridze', 'Ana Abashidze']],
  ['date_asc', ['Ana Abashidze', 'Dato Chikovani', 'Beka Beridze']],
  ['date_desc', ['Beka Beridze', 'Dato Chikovani', 'Ana Abashidze']],
  ['rating_asc', ['Beka Beridze', 'Ana Abashidze', 'Dato Chikovani']],
  ['rating_desc', ['Dato Chikovani', 'Ana Abashidze', 'Beka Beridze']],
]) {
  test(`existing ${sort} sorting remains available`, async () => {
    const h = harness(); await settle(); await h.sort(sort); assert.deepEqual(h.names(), expected);
  });
}

test('summary counts reflect filtered and total records, including no matches', async () => {
  const h = harness(); await settle();
  assert.match(h.DOM.registryResultsCount.textContent, /\b3\b.*\b3\b/);
  assert.equal(h.DOM.registryTotalCount.textContent, '3');
  await h.filter('Expert');
  assert.match(h.DOM.registryResultsCount.textContent, /\b1\b.*\b3\b/);
  assert.equal(h.DOM.registryTotalCount.textContent, '3');
  await h.input('missing');
  assert.match(h.DOM.registryResultsCount.textContent, /\b0\b.*\b3\b/);
  assert.match(h.DOM.registryList.textContent, /ჩანაწერები ვერ მოიძებნა/);
});

test('reset clears search, all qualification choices, and restores the original default sort', async () => {
  const h = harness(); await settle();
  await h.input('a'); await h.filter('Architect'); await h.filter('Expert'); await h.filter('Municipal'); await h.sort('rating_desc');
  await h.DOM.registryResetFilters.dispatch('click');
  assert.equal(h.DOM.registrySearch.value, '');
  for (const kind of ['Architect', 'Expert', 'Municipal']) assert.equal(h.DOM[`registryFilter${kind}`].checked, false);
  assert.equal(h.DOM.registrySort.value, 'date_desc');
  assert.deepEqual(h.names(), ['Beka Beridze', 'Dato Chikovani', 'Ana Abashidze']);
  assert.equal(h.state.requests.length, 1);
});

test('clear-search control preserves the independently selected qualification filters', async () => {
  const h = harness(); await settle(); await h.filter('Expert'); await h.input('missing');
  const clear = h.DOM.registryPage.querySelector('.registry-search-clear');
  assert.ok(clear); assert.equal(clear.hidden, false); await clear.dispatch('click');
  assert.equal(h.DOM.registryFilterExpert.checked, true);
  assert.deepEqual(h.names(), ['Beka Beridze']);
  assert.equal(clear.hidden, true);
});

test('empty registry data produces a stable zero count and empty message', async () => {
  const h = harness({ items: [] }); await settle();
  assert.deepEqual(h.names(), []);
  assert.match(h.DOM.registryResultsCount.textContent, /\b0\b.*\b0\b/);
  assert.equal(h.DOM.registryTotalCount.textContent, '0');
  assert.match(h.DOM.registryList.textContent, /ჩანაწერები ვერ მოიძებნა/);
});

test('a failed registry request offers retry and retains controls chosen before retry', async () => {
  const h = harness({ fail: true }); await settle();
  assert.match(h.DOM.registryList.textContent, /რეესტრი ვერ ჩაიტვირთა/);
  await h.filter('Municipal'); await h.input('Dato');
  const retry = h.DOM.registryList.querySelector('.registry-retry');
  assert.ok(retry, 'changing controls after a failed load must keep the retry action available');
  h.state.fail = false; await retry.dispatch('click'); await settle();
  assert.deepEqual(h.names(), ['Dato Chikovani']);
  assert.equal(h.DOM.registryFilterMunicipal.checked, true);
  assert.equal(h.DOM.registrySearch.value, 'Dato');
  assert.equal(h.state.requests.length, 2);
});

test('controls changed while initial data is in flight are respected when data arrives', async () => {
  const h = harness({ hold: true });
  await h.filter('Municipal'); await h.input('Dato'); await h.sort('name_asc');
  await h.registry.refresh(true);
  assert.equal(h.state.requests.length, 1, 'simultaneous calls must not duplicate the in-flight request');
  h.state.pending.shift()(); await settle();
  assert.deepEqual(h.names(), ['Dato Chikovani']);
  assert.equal(h.DOM.registryFilterMunicipal.checked, true);
  assert.equal(h.DOM.registrySearch.value, 'Dato');
});

test('forced refresh uses new records while preserving current search, sort, and qualification selections', async () => {
  const h = harness(); await settle(); await h.filter('Architect'); await h.input('Ana'); await h.sort('name_asc');
  h.state.items.push({ ...people()[0], id: 4, full_name: 'Ana Zetadze', unique_code: '300004' });
  await h.registry.refresh(true);
  assert.deepEqual(h.names(), ['Ana Abashidze', 'Ana Zetadze']);
  assert.equal(h.DOM.registryFilterArchitect.checked, true);
  assert.equal(h.DOM.registrySearch.value, 'Ana');
  assert.equal(h.DOM.registrySort.value, 'name_asc');
  assert.equal(h.state.requests.length, 2);
});

test('profiles are real navigable links with safely encoded user IDs', async () => {
  const h = harness({ items: [{ ...people()[0], id: 'a/b?x=1' }] }); await settle();
  const link = h.cards()[0].querySelector('.registry-profile-link'); assert.ok(link);
  assert.equal(link.tagName, 'A');
  assert.equal(link.getAttribute('href') || link.href, 'my.html?userId=a%2Fb%3Fx%3D1');
});

test('new presentation does not expose private user data returned unexpectedly by an API', async () => {
  const h = harness({ items: [{ ...people()[0], personal_id: 'PRIVATE-IDENTITY', phone: 'PRIVATE-PHONE',
    password_hash: 'PRIVATE-PASSWORD-HASH', is_admin: true, exam_permission: true, email: 'PRIVATE-EMAIL@test.invalid' }] });
  await settle();
  const text = h.DOM.registryList.textContent;
  assert.equal(/PRIVATE-|exam_permission|password_hash|personal_id|is_admin/.test(text), false);
  await h.input('PRIVATE-IDENTITY'); assert.deepEqual(h.names(), []);
});

test('HTML-like names and certification codes are escaped as text', async () => {
  const full_name = '<img src=x onerror="bad()">';
  const unique_code = '<script>bad()</script>';
  const h = harness({ items: [{ ...people()[0], full_name, unique_code }] }); await settle();
  const card = h.cards()[0];
  assert.equal(card.querySelector('.registry-name').textContent, full_name);
  assert.equal(card.querySelector('script'), null);
  assert.equal(card.querySelector('img'), null);
  assert.equal(card.innerHTML.includes('<script>bad()'), false);
});

test('photo enlargement is an accessible separate button and does not navigate to the profile', async () => {
  const h = harness({ items: [{ ...people()[0], photo_url: 'https://images.test/avatar.jpg' }] }); await settle();
  const avatar = h.cards()[0].querySelector('.registry-avatar'); assert.ok(avatar);
  assert.equal(avatar.tagName, 'BUTTON');
  assert.equal(avatar.getAttribute('type') || avatar.type, 'button');
  await avatar.dispatch('click');
  assert.equal((h.cards()[0].events.click || []).length, 0, 'the photo button is independent from the native profile link');
  assert.equal(h.window.location.href, 'http://test.local/pages/registry.html');
  const modal = h.document.body.querySelector('.photo-modal-overlay'); assert.ok(modal);
  assert.equal(modal.classList.contains('open'), true);
  assert.equal(modal.querySelector('.photo-modal-img').src, 'https://images.test/avatar.jpg');
  await h.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(modal.classList.contains('open'), false);
});

test('existing public review summaries continue refreshing card ratings', async () => {
  const h = harness({ refreshRating: true }); await settle();
  const requests = h.state.requests.filter(({ url }) => url.pathname.startsWith('/reviews/'));
  assert.equal(requests.length, 3);
  for (const card of h.cards()) assert.match(card.querySelector('.registry-rating').textContent, /4\.75/);
});

test('standalone page has crawlable Georgian title, canonical URL, description, and visible heading', () => {
  const html = fs.readFileSync(path.join(__dirname, '../pages/registry.html'), 'utf8');
  assert.match(html, /<html\b[^>]*lang="ka"/i);
  assert.match(html, /<title>[^<]*რეესტრ[^<]*<\/title>/i);
  assert.match(html, /<h1\b[^>]*>[\s\S]*?რეესტრ[\s\S]*?<\/h1>/i);
  assert.match(html, /<link\b[^>]*rel="canonical"[^>]*href="https:\/\/gipc\.org\.ge\/pages\/registry\.html"/i);
  assert.match(html, /<meta\b[^>]*name="description"[^>]*content="[^"]+"/i);
  assert.equal(/<meta\b[^>]*name="robots"[^>]*content="[^"]*noindex/i.test(html), false);
  assert.match(html, /id="registryPage"/);
  assert.equal(html.includes('id="registryOverlay"'), false);
  for (const id of ['registryFilterArchitect', 'registryFilterExpert', 'registryFilterMunicipal', 'registrySearch', 'registrySort']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('homepage and shared desktop/mobile navigation link directly to the public registry page', () => {
  const header = fs.readFileSync(path.join(__dirname, '../partials/header.html'), 'utf8');
  const index = fs.readFileSync(path.join(__dirname, '../pages/index.html'), 'utf8');
  const profile = fs.readFileSync(path.join(__dirname, '../pages/my.html'), 'utf8');
  const root = new Element(); root.innerHTML = header;
  for (const selector of ['.nav-registry', '.drawer-registry']) {
    const link = root.querySelector(selector); assert.ok(link);
    assert.equal(link.tagName, 'A');
    assert.equal(link.getAttribute('href'), '../pages/registry.html');
  }
  const homepage = new Element(); homepage.innerHTML = index;
  assert.equal(homepage.querySelector('.main-registry-link')?.getAttribute('href'), '../pages/registry.html');
  assert.equal(index.includes('id="registryOverlay"'), false);
  assert.equal(profile.includes('id="registryOverlay"'), false);
});

// Production also serves the homepage at / without redirecting into /pages/.
// Resolve actual HTML links as a browser does, not merely their literal hrefs.
for (const [filename, selector] of [
  ['../partials/header.html', '.nav-registry'],
  ['../partials/header.html', '.drawer-registry'],
  ['../pages/index.html', '.main-registry-link'],
]) {
  for (const [base, expected] of [
    ['https://gipc.org.ge/', 'https://gipc.org.ge/pages/registry.html'],
    ['https://gipc.org.ge/index.html', 'https://gipc.org.ge/pages/registry.html'],
    ['https://gipc.org.ge/pages/index.html', 'https://gipc.org.ge/pages/registry.html'],
    ['https://gipc.org.ge/pages/my.html?code=0123456789', 'https://gipc.org.ge/pages/registry.html'],
    ['https://www.gipc.org.ge/', 'https://www.gipc.org.ge/pages/registry.html'],
    ['http://127.0.0.1:3000/pages/index.html', 'http://127.0.0.1:3000/pages/registry.html'],
    ['http://127.0.0.1:3000/frontend/pages/index.html', 'http://127.0.0.1:3000/frontend/pages/registry.html'],
    ['http://127.0.0.1:3000/frontend/pages/my.html?code=0123456789', 'http://127.0.0.1:3000/frontend/pages/registry.html'],
  ]) {
    test(`${selector} resolves to the registry from ${base}`, () => {
      const root = new Element();
      root.innerHTML = fs.readFileSync(path.join(__dirname, filename), 'utf8');
      const link = root.querySelector(selector);
      assert.ok(link, `${selector} must exist in ${filename}`);
      assert.equal(link.tagName, 'A');
      assert.equal(new URL(link.getAttribute('href'), base).href, expected);
    });
  }
}

test('public sitemap includes the standalone registry and robots.txt advertises that sitemap', () => {
  const sitemap = fs.readFileSync(path.join(__dirname, '../sitemap.xml'), 'utf8');
  const robots = fs.readFileSync(path.join(__dirname, '../robots.txt'), 'utf8');
  assert.match(sitemap, /<loc>https:\/\/gipc\.org\.ge\/pages\/registry\.html<\/loc>/);
  assert.match(sitemap, /http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9/);
  assert.match(robots, /^Sitemap:\s*https:\/\/gipc\.org\.ge\/sitemap\.xml\s*$/m);
  assert.equal(/^Disallow:\s*\/(?:pages(?:\/registry\.html)?\/?|)\s*$/m.test(robots), false);
});

test('public registry retains one full-width row per person instead of a multi-column card layout', () => {
  const css = fs.readFileSync(path.join(__dirname, '../styles/registry.css'), 'utf8');
  const listRules = [...css.matchAll(/\.registry-page\s+\.registry-list\s*\{([^}]*)\}/g)];
  assert.ok(listRules.length > 0);
  for (const [, rule] of listRules) {
    const columns = rule.match(/grid-template-columns:\s*([^;]+);/);
    if (columns) assert.equal(columns[1].trim(), 'minmax(0, 1fr)');
  }
  const rowRules = [...css.matchAll(/\.registry-page\s+\.registry-card\s*\{([^}]*)\}/g)];
  for (const [, rule] of rowRules) {
    const minimum = rule.match(/min-height:\s*(\d+)px;/);
    if (minimum) assert.ok(Number(minimum[1]) <= 100, 'compact rows must not regain tall card minimums');
    assert.equal(/\bheight:\s*\d+px/.test(rule.replace(/min-height:[^;]+;/g, '')), false, 'long names must be able to wrap');
  }
  assert.match(css, /grid-template-areas:\s*'name code status'\s*'qualification code rating'/);
  assert.match(css, /grid-template-areas:\s*'name name'\s*'qualification qualification'\s*'code status'\s*'code rating'/);
});

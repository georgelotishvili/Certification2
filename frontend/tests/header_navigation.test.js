const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const markup = read('partials/header.html');
const source = read('scripts/header.js');
const helpers = source.slice(source.indexOf('  function on('), source.indexOf('  // Page cover'));
const binding = source.slice(source.indexOf('  function bindHeader()'), source.indexOf('  window.SiteDocuments ='));

function linksFor(prefix) {
  return [...markup.matchAll(/<a href="([^"]+)" class="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    .filter(([, , name]) => name.startsWith(prefix))
    .map(([, href, name, text]) => ({ href, name, text }));
}

for (const prefix of ['nav-', 'drawer-']) {
  test(`${prefix} navigation has distinct, permanent home and personal links`, () => {
    const links = linksFor(prefix);
    assert.deepEqual(links[0], { href: '../pages/index.html', name: `${prefix}home`, text: 'მთავარი' });
    assert.deepEqual(links.find((link) => link.name === `${prefix}profile`),
      { href: '../pages/my.html', name: `${prefix}profile`, text: 'ჩემი გვერდი' });
    assert.equal(links.filter((link) => link.name === `${prefix}home`).length, 1);
    assert.doesNotMatch(source, /textContent\s*=\s*'მთავარი გვერდი'/);
  });
}

function harness(page, loggedIn = false) {
  const links = [...linksFor('nav-'), ...linksFor('drawer-')]
    .filter((link) => /-(home|registry|profile)$/.test(link.name))
    .map((link) => ({ ...link, attributes: {},
      getAttribute(name) { return name === 'href' ? this.href : this.attributes[name]; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      closest(selector) {
        if (selector === '.drawer') return this.name.startsWith('drawer-') ? this : null;
        return selector.split(',').some((part) => part.trim().split('[')[0] === `.${this.name}`) ? this : null;
      },
    }));
  const handlers = {};
  let authOpened = 0;
  const context = {
    URL,
    window: {
      location: new URL(`http://127.0.0.1:3000/pages/${page}`),
      Auth: { isLoggedIn: () => loggedIn, openModal: () => { authOpened++; } },
    },
    document: {
      body: { classList: { contains: () => false, toggle() {} } },
      querySelector: () => null,
      querySelectorAll: (selector) => selector === '.drawer-nav a' ? [] : links,
      addEventListener(type, handler) { (handlers[type] ||= []).push(handler); },
    },
    getSiteInfoElements: () => null,
  };
  vm.runInNewContext(`${helpers}\n${binding}\nmarkCurrentPageLinks(); bindHeader();`, context);
  return { links, context, get authOpened() { return authOpened; },
    click(name, extra = {}) {
      const event = { target: links.find((link) => link.name === name), defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...extra };
      handlers.click.forEach((handler) => handler(event));
      return event;
    },
  };
}

for (const [page, active] of [
  ['index.html', 'home'], ['registry.html', 'registry'], ['my.html', 'profile'],
  ['my.html?userId=123', null], ['my.html?code=1234567890', null],
]) {
  test(`${page} highlights only the correct destination without rewriting links`, () => {
    const app = harness(page);
    assert.deepEqual(app.links.filter((link) => link.attributes['aria-current'] === 'page').map((link) => link.name),
      active ? [`nav-${active}`, `drawer-${active}`] : []);
    assert.ok(app.links.filter((link) => link.name.endsWith('-profile')).every((link) => link.href === '../pages/my.html'));
  });
}

for (const prefix of ['nav-', 'drawer-']) {
  test(`${prefix} home and registry work without login`, () => {
    const app = harness('my.html?userId=123');
    for (const name of ['home', 'registry']) assert.equal(app.click(prefix + name).defaultPrevented, false);
    assert.equal(app.authOpened, 0);
  });

  test(`${prefix} personal link requests login once for a guest`, () => {
    const app = harness('index.html');
    assert.equal(app.click(prefix + 'profile').defaultPrevented, true);
    assert.equal(app.authOpened, 1);
  });

  test(`${prefix} signed-in personal link uses native navigation, including Ctrl-click`, () => {
    const app = harness('my.html?userId=123', true);
    assert.equal(app.click(prefix + 'profile').defaultPrevented, false);
    assert.equal(app.click(prefix + 'profile', { ctrlKey: true }).defaultPrevented, false);
    assert.equal(app.authOpened, 0);
  });
}

function sharedHeaderAssets(html, page) {
  const base = new URL(`https://synthetic.invalid/frontend/pages/${page}`);
  const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'))?.[2];
  const assets = {};
  for (const [kind, tagName, attr, expectedPath] of [
    ['script', 'script', 'src', '/frontend/scripts/header.js'],
    ['style', 'link', 'href', '/frontend/styles/header.css'],
  ]) {
    const references = [...html.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, 'gi'))]
      .map(([tag]) => ({ tag, url: new URL(attribute(tag, attr) || '', base) }))
      .filter(({ url }) => path.posix.basename(url.pathname) === path.posix.basename(expectedPath));
    assert.equal(references.length, 1, `${page} must load exactly one shared header ${kind}`);
    const { tag, url } = references[0];
    assert.equal(url.origin, base.origin, `${page} must use the local header ${kind}`);
    assert.equal(url.pathname, expectedPath, `${page} must reference the actual shared header ${kind}`);
    assert.equal(url.searchParams.getAll('v').length, 1, `${page} needs one cache version for the header ${kind}`);
    assert.match(url.searchParams.get('v'), /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `${page} needs a nonempty cache version`);
    const localPath = path.join(__dirname, '..', url.pathname.slice('/frontend/'.length));
    assert.ok(fs.statSync(localPath).isFile(), `${page} header ${kind} must resolve to a real asset`);
    if (kind === 'script') assert.match(tag, /\bdefer(?:\s|=|>)/i, `${page} header must remain deferred`);
    else assert.equal(attribute(tag, 'rel'), 'stylesheet', `${page} must apply the header stylesheet`);
    assets[kind] = url.href;
  }
  return assets;
}

test('all shared-header pages use existing, versioned and consistent navigation assets', () => {
  const pages = fs.readdirSync(path.join(__dirname, '../pages'))
    .filter(name => name.endsWith('.html') && /header\.(?:js|css)[?"']/.test(read(`pages/${name}`)));
  for (const required of ['index.html', 'registry.html', 'my.html', 'documents.html']) {
    assert.ok(pages.includes(required), `${required} must retain the shared header`);
  }
  const reference = sharedHeaderAssets(read('pages/index.html'), 'index.html');
  for (const page of pages) {
    assert.deepEqual(sharedHeaderAssets(read(`pages/${page}`), page), reference,
      `${page} must request the same header versions as the home page`);
  }
});

test('navigation asset validation rejects unversioned, duplicated, remote and wrong-path references', () => {
  const html = read('pages/index.html');
  const scriptUrl = html.match(/src="([^\"]*\/header\.js\?[^\"]+)"/)[1];
  const mutations = [
    html.replace(scriptUrl, '../scripts/header.js'),
    html.replace(scriptUrl, '../scripts/header.js?v='),
    html.replace(scriptUrl, '../scripts/header.js?v=one&v=two'),
    html.replace(scriptUrl, 'https://external.invalid/scripts/header.js?v=one'),
    html.replace(scriptUrl, '../missing/header.js?v=one'),
    html + `<script src="${scriptUrl}" defer></script>`,
    html.replace(/(<script\b[^>]*header\.js[^>]*)\sdefer/, '$1'),
    html.replace(/(<link\b[^>]*header\.css[^>]*>)/, ''),
  ];
  for (const mutated of mutations) {
    assert.throws(() => sharedHeaderAssets(mutated, 'index.html'), assert.AssertionError);
  }
});

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

test('all shared-header pages request the updated navigation assets', () => {
  for (const page of ['index', 'registry', 'my']) {
    const html = read(`pages/${page}.html`);
    assert.match(html, /header\.js\?v=20261020-guide3/);
    assert.match(html, /header\.css\?v=20261019-publicai4/);
  }
});

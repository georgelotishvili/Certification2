const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('legacy registrations page redirects to the admin panel with or without JavaScript', () => {
  const html = read('pages/registrations.html');
  assert.match(html, /<html lang="ka">/);
  assert.match(html, /<meta http-equiv="refresh" content="0; url=\/admin"\s*\/>/);
  assert.match(html, /<noscript>[\s\S]*<a href="\/admin">[\s\S]*<\/noscript>/);
  assert.match(html, /scripts\/registrations\.js\?v=20261030-retired1/);
  assert.doesNotMatch(html, /btnDeleteAllUsers|usersGrid|usersSearch|onlyAdmins|config\.js|<button\b/);
});

test('cached registrations HTML receives an immediate history-replacing redirect, not API actions', () => {
  const destinations = [];
  const forbidden = () => { throw new Error('Legacy page must not access data or DOM controls'); };
  const context = {
    window: { location: { replace: destination => destinations.push(destination) } },
    fetch: forbidden,
    document: new Proxy({}, { get: forbidden }),
    localStorage: new Proxy({}, { get: forbidden }),
    setInterval: forbidden,
    setTimeout: forbidden,
  };
  vm.runInNewContext(read('scripts/registrations.js'), context);
  assert.deepEqual(destinations, ['/admin']);
  assert.doesNotMatch(read('scripts/registrations.js'), /DELETE|fetch\s*\(|admin\/users|btnDeleteAllUsers/);
});

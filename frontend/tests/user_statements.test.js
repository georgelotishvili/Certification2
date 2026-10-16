const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const markup = read('partials/header.html');
const header = read('scripts/header.js');
const start = header.indexOf('  function initStatementsModule()');
const end = header.indexOf("  if (document.readyState === 'loading')", start);
assert.ok(start >= 0 && end > start, 'test executes the real statements module');
const source = header.slice(start, end);
const flush = () => new Promise((resolve) => setImmediate(resolve));

// No browser, files, database or actual network requests are mutated by this harness.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.events = {};
    this.attributes = {};
    this.value = '';
    this.files = [];
    this.disabled = false;
    this.clicks = 0;
    this._text = '';
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(value) {
    assert.equal(value, '', 'untrusted statement content must not be parsed as HTML');
    this._text = '';
    this.children = [];
  }
  appendChild(child) {
    if (child.tagName === '#FRAGMENT') this.children.push(...child.children);
    else this.children.push(child);
    return child;
  }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(name, value) { this.attributes[name] = value; if (name === 'disabled') this.disabled = true; }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'disabled') this.disabled = false; }
  addEventListener(type, listener) { (this.events[type] ||= []).push(listener); }
  emit(type, extra = {}) {
    const event = { target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    return Promise.all((this.events[type] || []).map((listener) => listener(event)));
  }
  click() { this.clicks++; return this.emit('click'); }
}

const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => data, text: async () => JSON.stringify(data),
  clone() { return this; },
});

async function harness(options = {}) {
  const ids = Object.fromEntries([
    'userStatementsOverlay', 'userStatementsClose', 'userStatementsList', 'userStatementsMeta',
    'userStatementForm', 'userStatementMessage', 'statementFileChoose', 'statementFileInput',
    'statementFileDisplay', 'appFormDownloadBtn',
  ].map((id) => [id, new Element()]));
  const form = ids.userStatementForm;
  const textarea = ids.userStatementMessage;
  const fileInput = ids.statementFileInput;
  const submit = new Element('button');
  form.querySelector = (selector) => selector === 'button[type="submit"]' ? submit : fileInput;
  form.reset = () => { textarea.value = ''; fileInput.files = []; };
  ids.appFormDownloadBtn.disabled = true;
  const body = new Element('body');
  const document = new Element();
  const created = [];
  Object.assign(document, {
    body,
    getElementById: (id) => ids[id] || null,
    querySelector: () => textarea,
    createElement: (tag) => { const element = new Element(tag); created.push(element); return element; },
    createDocumentFragment: () => new Element('#fragment'),
  });
  const window = new Element();
  const api = 'https://example.invalid/api';
  Object.assign(window, {
    APP_CONFIG: { API_BASE: api }, location: { href: '' },
    Auth: {
      isLoggedIn: () => options.loggedIn !== false,
      getSavedEmail: () => 'candidate@example.invalid',
      getCurrentUser: () => ({ firstName: 'საცდელი', lastName: 'პირი', code: '1234567890' }),
      getAuthHeaders: () => ({ Authorization: 'Bearer test-only' }),
    },
    Utils: { formatDateTime: (date) => date },
  });
  const requests = [];
  const alerts = [];
  class FormDataMock {
    constructor(initialForm) { this.values = new Map(initialForm ? [['message', textarea.value]] : []); }
    get(name) { return this.values.get(name) ?? null; }
    set(name, value) { this.values.set(name, value); }
  }
  const fetch = async (url, request = {}) => {
    requests.push({ url, ...request });
    if (url.endsWith('/application-form/info')) return response(options.applicationForm || { available: false });
    if (url.endsWith('/statements/me')) return response(options.history || [], options.historyStatus || 200);
    if (url.endsWith('/statements') && request.method === 'POST') {
      assert.equal(submit.disabled, true, 'submit is disabled while sending');
      if (options.submitError) throw new Error(options.submitError);
      return response(options.submitData || { id: 17, message: request.body.get('message'), created_at: '2026-10-13' }, options.submitStatus || 200);
    }
    assert.fail(`Unexpected request: ${url}`);
  };
  vm.runInNewContext(`${source}\ninitStatementsModule();`, {
    window, document, fetch, FormData: FormDataMock, alert: (message) => alerts.push(message),
    getApiBase: () => api, on: (element, event, listener) => element?.addEventListener(event, listener),
  });
  await flush();
  return { ids, form, textarea, fileInput, submit, body, window, document, requests, alerts, created, api,
    posts: () => requests.filter((request) => request.method === 'POST'),
    async open() { await window.emit('openStatements'); await flush(); },
    send: () => form.emit('submit'),
  };
}

test('composer keeps labelled message, file controls, optional attachment and download contracts', () => {
  assert.match(markup, /<label\b[^>]*for="userStatementMessage"/);
  const message = markup.match(/<textarea\b[^>]*id="userStatementMessage"[^>]*>/)?.[0];
  assert.ok(message);
  assert.match(message, /name="message"/);
  assert.match(message, /\brequired\b/);
  assert.match(message, /aria-describedby="statementMessageHint"/);
  const file = markup.match(/<input\b[^>]*id="statementFileInput"[^>]*>/)?.[0];
  assert.ok(file);
  assert.match(file, /type="file"/);
  assert.match(file, /name="attachment"/);
  assert.doesNotMatch(file, /\brequired\b|\bmultiple\b/);
  assert.match(file, /accept="\.zip,\.rar,\.pdf,\.jpg,\.jpeg,\.doc,\.docx"/);
  assert.match(markup, /<input\b[^>]*id="statementFileDisplay"[^>]*\breadonly\b/);
  assert.match(markup, /<button\b[^>]*id="appFormDownloadBtn"[^>]*\bdisabled\b/);
  assert.match(markup, /role="dialog" aria-modal="true" aria-labelledby="userStatementsTitle"/);
  assert.match(markup, /<section\b[^>]*aria-labelledby="statementHistoryTitle"/);
});

test('text-only submission sends trimmed text with auth and resets form into history', async () => {
  const app = await harness();
  await app.open();
  app.textarea.value = '  საცდელი განცხადება  ';
  await app.send();
  const [request] = app.posts();
  assert.equal(request.body.get('message'), 'საცდელი განცხადება');
  assert.equal(request.body.get('attachment'), null);
  assert.equal(request.credentials, 'include');
  assert.equal(request.headers.Authorization, 'Bearer test-only');
  assert.equal(app.textarea.value, '');
  assert.equal(app.submit.disabled, false);
  assert.match(app.ids.userStatementsList.textContent, /საცდელი განცხადება/);
  assert.match(app.alerts[0], /მიღებულია/);
});

test('file chooser selects one attachment, displays its name and clears it after send', async () => {
  const app = await harness();
  await app.ids.statementFileChoose.click();
  assert.equal(app.fileInput.clicks, 1);
  const file = { name: 'განცხადება.PDF', size: 1234 };
  app.fileInput.files = [file];
  await app.fileInput.emit('change');
  assert.equal(app.ids.statementFileDisplay.value, file.name);
  app.textarea.value = 'თანდართული ფაილი';
  await app.send();
  assert.equal(app.posts()[0].body.get('attachment'), file);
  assert.equal(app.ids.statementFileDisplay.value, '');
  assert.equal(app.fileInput.files.length, 0);
});

for (const [name, message, file, expected] of [
  ['empty message', '  ', null, /შეიყვანოთ/],
  ['unsupported file', 'შესანარჩუნებელი ტექსტი', { name: 'file.exe', size: 12 }, /დასაშვებია/],
  ['oversize file', 'შესანარჩუნებელი ტექსტი', { name: 'file.pdf', size: 100 * 1024 * 1024 + 1 }, /100MB/],
]) {
  test(`${name} does not send or discard the draft`, async () => {
    const app = await harness();
    app.textarea.value = message;
    app.fileInput.files = file ? [file] : [];
    await app.send();
    assert.equal(app.posts().length, 0);
    assert.equal(app.textarea.value, message);
    assert.equal(app.fileInput.files[0] || null, file);
    assert.match(app.alerts[0], expected);
    assert.equal(app.submit.disabled, false);
  });
}

for (const options of [{ submitError: 'Offline' }, { submitStatus: 400, submitData: { detail: 'Rejected' } }]) {
  test(`failed send (${options.submitError || options.submitStatus}) preserves text/file and enables retry`, async () => {
    const app = await harness(options);
    app.textarea.value = 'ხელახლა გასაგზავნი';
    app.fileInput.files = [{ name: 'retry.pdf', size: 20 }];
    await app.fileInput.emit('change');
    await app.send();
    assert.equal(app.textarea.value, 'ხელახლა გასაგზავნი');
    assert.equal(app.ids.statementFileDisplay.value, 'retry.pdf');
    assert.equal(app.submit.disabled, false);
    assert.equal(app.alerts[0], options.submitError || options.submitData.detail);
  });
}

test('application-form download stays disabled when no form is available', async () => {
  const app = await harness();
  assert.equal(app.ids.appFormDownloadBtn.disabled, true);
  assert.equal(app.ids.appFormDownloadBtn.events.click, undefined);
});

test('available application form enables download with the advertised filename', async () => {
  const app = await harness({ applicationForm: { available: true, filename: 'application.docx' } });
  assert.equal(app.ids.appFormDownloadBtn.disabled, false);
  await app.ids.appFormDownloadBtn.click();
  const link = app.created.find((element) => element.tagName === 'A');
  assert.equal(link.href, `${app.api}/application-form/download`);
  assert.equal(link.download, 'application.docx');
  assert.equal(link.clicks, 1);
  assert.equal(app.body.children.includes(link), false);
});

test('history renders untrusted message/filename as text and preserves attachment action', async () => {
  const unsafe = '<img src=x onerror=alert(1)>';
  const app = await harness({ history: [{ id: 'id/17', created_at: '2026-10-13', message: unsafe, attachment_filename: `${unsafe}.pdf` }] });
  await app.open();
  const [item] = app.ids.userStatementsList.children;
  assert.equal(item.tagName, 'DETAILS');
  assert.equal(item.children[0].tagName, 'SUMMARY');
  assert.equal(item.children[1].textContent, unsafe);
  assert.equal(item.children[1].children.length, 0);
  assert.equal(item.children[2].children[1].textContent, `${unsafe}.pdf`);
  await item.children[2].children[0].click();
  assert.equal(app.window.location.href, `${app.api}/statements/id%2F17/attachment?actor=candidate%40example.invalid`);
});

test('opening and closing keep overlay/scroll state consistent', async () => {
  const app = await harness();
  await app.open();
  assert.equal(app.ids.userStatementsOverlay.attributes['aria-hidden'], 'false');
  assert.equal(app.body.classList.contains('modal-open'), true);
  assert.match(app.ids.userStatementsList.textContent, /ჯერ არ გაქვთ/);
  await app.ids.userStatementsClose.click();
  assert.equal(app.ids.userStatementsOverlay.attributes['aria-hidden'], 'true');
  assert.equal(app.body.classList.contains('modal-open'), false);
});

test('unauthenticated users cannot open the composer or submit', async () => {
  const app = await harness({ loggedIn: false });
  await app.open();
  app.textarea.value = 'საცდელი';
  await app.send();
  assert.equal(app.ids.userStatementsOverlay.classList.contains('open'), false);
  assert.equal(app.posts().length, 0);
  assert.equal(app.requests.some((request) => request.url.endsWith('/statements/me')), false);
  assert.ok(app.alerts.every((message) => message.includes('ავტორიზაცია')));
});

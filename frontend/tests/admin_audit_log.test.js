const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const adminHtml = fs.readFileSync(path.join(__dirname, '../pages/admin.html'), 'utf8');

function attributes(markup) {
  return Object.fromEntries([...markup.matchAll(/([\w-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1], match[3]]));
}

function headerAuditButton() {
  const header = adminHtml.match(/<header\b[^>]*>([\s\S]*?)<\/header>/)?.[1];
  assert.ok(header, 'The admin header must exist');
  const group = header.match(/<div\b[^>]*class="[^"]*\badmin-header-actions\b[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  assert.ok(group, 'Header actions must contain the relocated logging button');
  const buttons = [...group.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attrs: attributes(match[1]), text: match[2].replace(/<[^>]*>/g, '').trim() }));
  return { header, group, buttons, audit: buttons.find(button => button.attrs.id === 'openAuditLogBtn') };
}

class Element {
  constructor() {
    this.value = ''; this.innerHTML = ''; this.textContent = ''; this.disabled = false;
    this.handlers = {}; this.classes = new Set(); this.attributes = {};
    this.classList = { add: x => this.classes.add(x), remove: x => this.classes.delete(x), contains: x => this.classes.has(x) };
  }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  appendChild() {} remove() {} click() {}
  fire(type) { return this.handlers[type]?.({ target: this, preventDefault() {} }); }
}

function harness({ headerOpener = false } = {}) {
  const ids = ['auditLogModalOverlay', 'auditLogModalClose', 'auditLogRefreshBtn', 'auditLogExportCsvBtn', 'auditLogSearchInput', 'auditLogCategorySelect', 'auditLogDateInput', 'auditLogClearFiltersBtn', 'auditLogTableBody', 'auditLogTotalCount', 'auditLogLastUpdated', 'auditLogCoverage', 'auditLogPreviousBtn', 'auditLogNextBtn', 'auditLogPageLabel'];
  const els = Object.fromEntries(ids.map(id => [id, new Element()]));
  els.auditLogCategorySelect.value = 'all';
  if (headerOpener) {
    const button = headerAuditButton().audit;
    assert.ok(button, 'Expected the real relocated header button markup');
    els.openAuditLogBtn = new Element();
    for (const [name, value] of Object.entries(button.attrs)) els.openAuditLogBtn.setAttribute(name, value);
    els.openAuditLogBtn.textContent = button.text;
  }
  const requests = [], blobs = [], notices = [];
  const document = { readyState: 'complete', getElementById: id => els[id] || null, querySelector: () => null,
    querySelectorAll: selector => selector === '[data-open-audit-log="true"]'
      ? Object.values(els).filter(element => element.getAttribute('data-open-audit-log') === 'true') : [],
    addEventListener() {}, body: new Element(), createElement: () => new Element() };
  const window = { APP_CONFIG: { API_BASE: 'https://synthetic.invalid' }, Auth: { getAuthHeaders: () => ({ Authorization: 'Bearer synthetic-only' }), clearSession() {} }, localStorage: { setItem() {}, removeItem() {} } };
  const context = { window, document, console, Intl, Date, Blob, URLSearchParams, AbortController,
    URL: { createObjectURL: blob => { blobs.push(blob); return 'blob:synthetic'; }, revokeObjectURL() {} },
    localStorage: window.localStorage, setTimeout: () => 1, clearTimeout() {},
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })) };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../scripts/admin/shared.js'), 'utf8'), context);
  window.AdminShared.showToast = (...args) => notices.push(args);
  const resolve = (index, items, extra = {}) => requests[index].resolve({ ok: true, json: async () => ({ total: items.length, items, snapshot_id: 999, next_cursor: null, ...extra }) });
  return { els, requests, blobs, notices, resolve, window, document };
}

const item = (action, details = 'safe') => ({ timestamp: '2026-11-03T21:00:00Z', category: 'auth', action, actor: 'Synthetic', target: 'test', details });

test('logging button is unique and sits beside the home action in the header, not in the user filters', () => {
  const { buttons, audit } = headerAuditButton();
  assert.equal([...adminHtml.matchAll(/\bid=["']openAuditLogBtn["']/g)].length, 1);
  assert.equal(buttons.length, 2, 'The header action group contains exactly the two adjacent actions');
  assert.ok(audit);
  assert.equal(audit.text, 'ლოგირება');
  assert.equal(audit.attrs.type, 'button');
  assert.equal(audit.attrs['data-open-audit-log'], 'true');
  assert.equal(audit.attrs['aria-haspopup'], 'dialog');
  assert.equal(audit.attrs['aria-controls'], 'auditLogModalOverlay');
  assert.ok(audit.attrs.class.split(/\s+/).includes('admin-audit-log-btn'));
  const home = buttons.find(button => button.attrs.class?.split(/\s+/).includes('login-btn'));
  assert.ok(home, 'Keep the existing home-navigation selector');
  assert.equal(home.text, 'მთავარი გვერდი');
  for (const button of buttons) assert.ok(button.attrs.class.split(/\s+/).includes('admin-header-action'));
  const registrations = adminHtml.match(/<section\b[^>]*id="registrations-section"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(registrations);
  assert.doesNotMatch(registrations, /\bopenAuditLogBtn\b|\bdata-open-audit-log\b/);
  // The pre-existing desktop and mobile menu shortcuts must remain available.
  assert.equal([...adminHtml.matchAll(/<a\b[^>]*data-open-audit-log="true"[^>]*>\s*ლოგირება\s*<\/a>/g)].length, 2);
});

test('the relocated header button opens the existing audit modal with an authenticated read', async () => {
  const h = harness({ headerOpener: true });
  assert.equal(h.requests.length, 0, 'Moving the button must not preload the private journal');
  assert.equal(h.els.auditLogModalOverlay.classList.contains('open'), false);
  h.els.openAuditLogBtn.fire('click');
  assert.equal(h.els.auditLogModalOverlay.classList.contains('open'), true);
  assert.equal(h.els.auditLogModalOverlay.getAttribute('aria-hidden'), 'false');
  assert.equal(h.document.body.classList.contains('modal-open'), true);
  assert.equal(h.requests.length, 1);
  const request = h.requests[0], url = new URL(request.url);
  assert.equal(url.origin, 'https://synthetic.invalid');
  assert.equal(url.pathname, '/admin/audit-logs');
  assert.equal(url.searchParams.get('category'), 'all');
  assert.equal(request.options.method || 'GET', 'GET');
  assert.equal(request.options.body, undefined);
  assert.equal(request.options.headers.Authorization, 'Bearer synthetic-only');
  assert.equal(request.options.headers['Cache-Control'], 'no-cache');
  assert.equal(request.options.credentials, 'include');
  h.resolve(0, [item('HEADER_OPENED')]); await new Promise(setImmediate);
  assert.match(h.els.auditLogTableBody.innerHTML, /HEADER_OPENED/);
  assert.equal(h.els.auditLogExportCsvBtn.disabled, false);
  h.els.auditLogModalClose.fire('click');
  assert.equal(h.els.auditLogModalOverlay.classList.contains('open'), false);
  assert.equal(h.els.auditLogModalOverlay.getAttribute('aria-hidden'), 'true');
  assert.equal(h.document.body.classList.contains('modal-open'), false);
  assert.equal(h.requests.length, 1, 'Opening and closing must not send a write request');
});

test('late response cannot overwrite a more recent audit filter', async () => {
  const h = harness();
  h.els.auditLogCategorySelect.value = 'auth'; const older = h.els.auditLogCategorySelect.fire('change');
  h.els.auditLogCategorySelect.value = 'statement'; const newer = h.els.auditLogCategorySelect.fire('change');
  assert.equal(h.requests[0].options.signal.aborted, true);
  h.resolve(1, [item('NEW_FILTER')]); await newer;
  // Mock intentionally ignores abort, exercising the independent version guard.
  h.resolve(0, [item('OLD_FILTER')]); await older;
  assert.match(h.els.auditLogTableBody.innerHTML, /NEW_FILTER/);
  assert.doesNotMatch(h.els.auditLogTableBody.innerHTML, /OLD_FILTER/);
});

test('loading and failed request cannot export stale data', async () => {
  const h = harness();
  const first = h.els.auditLogRefreshBtn.fire('click'); h.resolve(0, [item('PRIVATE_OLD')]); await first;
  assert.equal(h.els.auditLogExportCsvBtn.disabled, false);
  const failing = h.els.auditLogRefreshBtn.fire('click');
  assert.equal(h.els.auditLogExportCsvBtn.disabled, true);
  h.requests[1].reject(new Error('synthetic connection failure')); await failing;
  await h.els.auditLogExportCsvBtn.fire('click');
  assert.equal(h.blobs.length, 0);
  assert.equal(h.els.auditLogLastUpdated.textContent, '');
});

test('cursor pages retain a snapshot and refresh resets it', async () => {
  const h = harness();
  const first = h.els.auditLogRefreshBtn.fire('click');
  h.resolve(0, [item('FIRST')], { total: 3, next_cursor: 700, coverage_note: 'Synthetic journal only' }); await first;
  assert.equal(h.els.auditLogPreviousBtn.disabled, true);
  assert.equal(h.els.auditLogNextBtn.disabled, false);
  assert.equal(h.els.auditLogCoverage.textContent, 'Synthetic journal only');
  const next = h.els.auditLogNextBtn.fire('click');
  const url = new URL(h.requests[1].url);
  assert.equal(url.searchParams.get('before_id'), '700');
  assert.equal(url.searchParams.get('snapshot_id'), '999');
  h.resolve(1, [item('SECOND')], { total: 3 }); await next;
  assert.equal(h.els.auditLogPreviousBtn.disabled, false);
  assert.equal(h.els.auditLogNextBtn.disabled, true);
  assert.equal(h.els.auditLogPageLabel.textContent, 'გვერდი 2');
  const back = h.els.auditLogPreviousBtn.fire('click');
  assert.equal(new URL(h.requests[2].url).searchParams.has('before_id'), false);
  h.resolve(2, [item('FIRST')], { total: 3, next_cursor: 700 }); await back;
  const refresh = h.els.auditLogRefreshBtn.fire('click');
  assert.equal(new URL(h.requests[3].url).searchParams.has('snapshot_id'), false);
  h.resolve(3, [item('NEWEST')], { snapshot_id: 1000 }); await refresh;
});

test('CSV exports every filtered page, not just the displayed page', async () => {
  const h = harness();
  h.els.auditLogSearchInput.value = 'Synthetic search';
  h.els.auditLogCategorySelect.value = 'exam';
  h.els.auditLogDateInput.value = '2026-11-04';
  const first = h.els.auditLogRefreshBtn.fire('click');
  h.resolve(0, [item('DISPLAYED')], { total: 3, next_cursor: 700 }); await first;
  const exporting = h.els.auditLogExportCsvBtn.fire('click');
  assert.equal(h.els.auditLogExportCsvBtn.disabled, true);
  const url = new URL(h.requests[1].url);
  assert.equal(url.searchParams.get('limit'), '1000');
  assert.equal(url.searchParams.get('search'), 'Synthetic search');
  assert.equal(url.searchParams.get('category'), 'exam');
  assert.equal(url.searchParams.get('date'), '2026-11-04');
  assert.equal(url.searchParams.get('snapshot_id'), '999');
  h.resolve(1, [item('EXPORTED_A'), item('EXPORTED_B')], { total: 3, next_cursor: 500 });
  await new Promise(setImmediate);
  assert.equal(new URL(h.requests[2].url).searchParams.get('before_id'), '500');
  h.resolve(2, [item('EXPORTED_C')], { total: 3 }); await exporting;
  const csv = await h.blobs[0].text();
  assert.match(csv, /EXPORTED_A/); assert.match(csv, /EXPORTED_B/); assert.match(csv, /EXPORTED_C/);
  assert.doesNotMatch(csv, /DISPLAYED/);
  assert.equal(csv.split('\r\n').length, 4);
  assert.equal(h.els.auditLogExportCsvBtn.disabled, false);
});

test('failed or incomplete full export never downloads a partial file', async () => {
  for (const mode of ['network', 'incomplete', 'snapshot', 'cursor']) {
    const h = harness();
    const first = h.els.auditLogRefreshBtn.fire('click'); h.resolve(0, [item('DISPLAYED')]); await first;
    const exporting = h.els.auditLogExportCsvBtn.fire('click');
    h.resolve(1, [item('A')], { total: 3, next_cursor: 500 }); await new Promise(setImmediate);
    if (mode === 'network') h.requests[2].reject(new Error('Synthetic network loss'));
    else h.resolve(2, [item('B')], { total: 3, ...(mode === 'snapshot' ? { snapshot_id: 1000 } : {}), ...(mode === 'cursor' ? { next_cursor: 500 } : {}) });
    await exporting;
    assert.equal(h.blobs.length, 0, mode);
    assert.ok(h.notices.some(([message]) => message.includes('ნაწილობრივი')), mode);
    assert.equal(h.els.auditLogExportCsvBtn.disabled, false, mode);
  }
});

test('filter changes abort export and discard a late response', async () => {
  const h = harness();
  const first = h.els.auditLogRefreshBtn.fire('click'); h.resolve(0, [item('DISPLAYED')]); await first;
  const exporting = h.els.auditLogExportCsvBtn.fire('click');
  h.els.auditLogSearchInput.value = 'changed'; h.els.auditLogSearchInput.fire('input');
  assert.equal(h.requests[1].options.signal.aborted, true);
  h.resolve(1, [item('LATE_EXPORT')]); await exporting;
  assert.equal(h.blobs.length, 0);
  assert.equal(h.els.auditLogExportCsvBtn.disabled, true);
});

test('CSV preserves quoting and neutralizes spreadsheet formula prefixes', async () => {
  const h = harness();
  const values = ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '  =1+1', '\t=1+1', 'normal "quoted", text'];
  const loading = h.els.auditLogRefreshBtn.fire('click');
  h.resolve(0, values.map(value => item('SAFE', value))); await loading;
  const exporting = h.els.auditLogExportCsvBtn.fire('click');
  h.resolve(1, values.map(value => item('SAFE', value))); await exporting;
  const csv = await h.blobs[0].text();
  for (const value of values.slice(0, -1)) assert.ok(csv.includes('"\'' + value + '"'), value);
  assert.ok(csv.includes('"normal ""quoted"", text"'));
});

test('HTML output is escaped, time uses Tbilisi and modal close cancels results', async () => {
  const h = harness();
  const loading = h.els.auditLogRefreshBtn.fire('click');
  h.resolve(0, [item('SAFE', '<img src=x onerror=alert(1)>')]); await loading;
  assert.match(h.els.auditLogTableBody.innerHTML, /&lt;img/);
  assert.doesNotMatch(h.els.auditLogTableBody.innerHTML, /<img/);
  assert.equal(h.window.AdminShared.formatDateTime('2026-11-03T21:00:00Z'), '04-11-2026 01:00');
  const late = h.els.auditLogRefreshBtn.fire('click'); h.els.auditLogModalClose.fire('click');
  h.resolve(1, [item('AFTER_CLOSE')]); await late;
  assert.doesNotMatch(h.els.auditLogTableBody.innerHTML, /AFTER_CLOSE/);
  assert.equal(h.els.auditLogExportCsvBtn.disabled, true);
});

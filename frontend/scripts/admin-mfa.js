/* Personal administrator step-up authentication. No credentials are persisted here. */
(function (global) {
  'use strict';
  if (global.AdminMfa) return;
  const doc = global.document;
  const nativeFetch = global.fetch.bind(global);
  const REQUEST_TIMEOUT = 20000;
  const API_BASE = String(global.APP_CONFIG?.API_BASE || global.location.origin).replace(/\/$/, '');
  const MFA_PATH = '/auth/admin-mfa';
  let activeFlow = null;
  let qrLoading = null;

  function currentToken() {
    try { return global.localStorage.getItem('auth_token') || ''; } catch { return ''; }
  }

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function alive(flow) { return activeFlow === flow && currentToken() === flow.token; }

  function close(flow, verified = false) {
    if (activeFlow !== flow) return;
    verified = verified && currentToken() === flow.token;
    activeFlow = null;
    flow.controller?.abort();
    // Remove QR, secret, password and recovery codes from the DOM immediately.
    flow.dialog.querySelectorAll('input, textarea').forEach(input => { input.value = ''; });
    flow.content.replaceChildren();
    try { flow.dialog.close(); } catch {}
    flow.dialog.remove();
    if (flow.previousFocus?.isConnected) flow.previousFocus.focus();
    flow.resolve(verified);
  }

  function notify(message, type = 'info') {
    if (typeof global.showToast === 'function') global.showToast(message, type);
  }

  async function request(flow, suffix, payload) {
    if (!alive(flow)) throw new Error('სესია შეიცვალა. ხელახლა შედით სისტემაში.');
    const controller = new AbortController();
    flow.controller = controller;
    const timer = global.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const response = await nativeFetch(API_BASE + MFA_PATH + suffix, {
        method: payload === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + flow.token, 'Content-Type': 'application/json' },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!alive(flow)) throw new Error('სესია შეიცვალა. ხელახლა შედით სისტემაში.');
      if (!response.ok) {
        const detail = data?.detail;
        const message = typeof detail === 'string' ? detail : detail?.message;
        const error = new Error(message || (response.status === 401
          ? 'სესიას ვადა გაუვიდა. ხელახლა შედით სისტემაში.'
          : 'დადასტურება ვერ შესრულდა. გთხოვთ, სცადოთ ხელახლა.'));
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('კავშირი შეფერხდა. გადაამოწმეთ სტატუსი ან სცადეთ ხელახლა.');
      throw error;
    } finally {
      global.clearTimeout(timer);
      if (flow.controller === controller) flow.controller = null;
    }
  }

  function setBusy(flow, busy) {
    flow.busy = busy;
    flow.dialog.setAttribute('aria-busy', String(busy));
    flow.status.textContent = busy ? 'გთხოვთ, დაელოდოთ…' : '';
    if (busy) {
      flow.disabled = Array.from(flow.content.querySelectorAll('button, input, textarea')).map(node => [node, node.disabled]);
      flow.disabled.forEach(([node]) => { node.disabled = true; });
    } else {
      (flow.disabled || []).forEach(([node, disabled]) => { if (node.isConnected) node.disabled = disabled; });
      flow.disabled = [];
    }
  }

  async function perform(flow, operation) {
    if (activeFlow !== flow || flow.busy) return;
    flow.error.textContent = '';
    setBusy(flow, true);
    try { await operation(); }
    catch (error) {
      if (activeFlow === flow) {
        flow.error.textContent = error.message || 'მოქმედება ვერ შესრულდა.';
        flow.retry.hidden = false;
        if (error.status === 401) {
          flow.error.textContent = 'სესიას ვადა გაუვიდა. დახურეთ ფანჯარა და ხელახლა შედით სისტემაში.';
        }
      }
    } finally { if (activeFlow === flow) setBusy(flow, false); }
  }

  function render(flow, title, description) {
    flow.title.textContent = title;
    flow.description.textContent = description || '';
    flow.error.textContent = '';
    flow.retry.hidden = true;
    flow.content.querySelectorAll('input, textarea').forEach(node => { node.value = ''; });
    flow.content.replaceChildren();
  }

  function action(flow, label, handler, primary = false) {
    const button = element('button', primary ? 'mfa-button mfa-primary' : 'mfa-button', label);
    button.type = 'button';
    button.addEventListener('click', handler);
    flow.content.appendChild(button);
    return button;
  }

  function inputForm(flow, { label, type = 'text', autocomplete = 'one-time-code', code = false, submit = 'დადასტურება', onSubmit }) {
    const form = element('form', 'mfa-form');
    const labelNode = element('label', 'mfa-label', label);
    const input = element('input', 'mfa-input');
    input.id = 'adminMfaInput'; input.type = type; input.required = true;
    input.autocomplete = autocomplete;
    input.maxLength = type === 'password' ? 256 : 64;
    input.spellcheck = false; input.setAttribute('autocapitalize', 'off');
    if (code) { input.inputMode = 'numeric'; input.pattern = '[0-9]{6}'; input.maxLength = 6; }
    labelNode.htmlFor = input.id;
    const submitButton = element('button', 'mfa-button mfa-primary', submit);
    submitButton.type = 'submit';
    form.append(labelNode, input, submitButton);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (flow.busy || !input.value || !form.checkValidity()) return;
      const value = type === 'password' ? input.value : input.value.trim();
      void perform(flow, async () => {
        try { await onSubmit(value); }
        finally { input.value = ''; }
      });
    });
    flow.content.appendChild(form);
    input.focus();
    return input;
  }

  function showRecovery(flow, codes) {
    if (!Array.isArray(codes) || !codes.length || codes.some(code => typeof code !== 'string')) {
      throw new Error('სარეზერვო კოდები ვერ ჩაიტვირთა. გადაამოწმეთ სტატუსი და უსაფრთხოების მენიუდან შექმენით ახალი კოდები.');
    }
    render(flow, 'შეინახეთ სარეზერვო კოდები', 'თითო კოდი ერთჯერადია. შეინახეთ უსაფრთხო ადგილას, ტელეფონისგან განცალკევებით — ისინი დაგჭირდებათ ტელეფონის დაკარგვის შემთხვევაში.');
    const area = element('textarea', 'mfa-recovery-codes');
    area.readOnly = true; area.rows = Math.min(codes.length, 10);
    area.value = codes.join('\n');
    area.setAttribute('aria-label', 'ერთჯერადი სარეზერვო კოდები');
    flow.content.appendChild(area);
    const label = element('label', 'mfa-check');
    const checked = element('input'); checked.type = 'checkbox'; checked.id = 'adminMfaCodesSaved';
    label.append(checked, element('span', '', 'კოდები უსაფრთხოდ შევინახე'));
    flow.content.appendChild(label);
    const done = action(flow, 'გაგრძელება', () => { if (checked.checked) close(flow, true); }, true);
    done.disabled = true;
    checked.addEventListener('change', () => { done.disabled = !checked.checked; });
    area.focus();
  }

  function loadQrEncoder() {
    if (typeof global.qrcode === 'function') return Promise.resolve();
    if (qrLoading) return qrLoading;
    qrLoading = new Promise((resolve, reject) => {
      const script = element('script');
      const timer = global.setTimeout(() => { script.remove(); qrLoading = null; reject(new Error('QR ვერ ჩაიტვირთა')); }, 10000);
      script.src = new URL('../scripts/vendor/qrcode-generator.js?v=1', global.location.href).href;
      script.onload = () => { global.clearTimeout(timer); if (typeof global.qrcode === 'function') resolve(); else { qrLoading = null; reject(new Error('QR ვერ ჩაიტვირთა')); } };
      script.onerror = () => { global.clearTimeout(timer); script.remove(); qrLoading = null; reject(new Error('QR ვერ ჩაიტვირთა')); };
      doc.head.appendChild(script);
    });
    return qrLoading;
  }

  async function showSetupCode(flow, data) {
    if (typeof data.secret !== 'string' || typeof data.otpauth_uri !== 'string' || !data.otpauth_uri.startsWith('otpauth://totp/')) {
      throw new Error('Authenticator-ის მიბმის მონაცემები ვერ ჩაიტვირთა. სცადეთ ხელახლა.');
    }
    render(flow, 'მიაბით Google Authenticator', 'ტელეფონში გახსენით Google Authenticator → „+“ → QR-კოდის სკანირება. შემდეგ შეიყვანეთ აპში ნაჩვენები 6-ნიშნა კოდი.');
    const qrBox = element('div', 'mfa-qr');
    flow.content.appendChild(qrBox);
    const keyLabel = element('label', 'mfa-label', 'თუ QR ვერ სკანირდება, Authenticator-ში ხელით შეიყვანეთ ეს გასაღები:');
    const key = element('input', 'mfa-input mfa-secret');
    key.id = 'adminMfaSecret'; keyLabel.htmlFor = key.id;
    key.readOnly = true; key.value = data.secret; key.autocomplete = 'off';
    flow.content.append(keyLabel, key);
    inputForm(flow, { label: 'Authenticator-ის კოდი', code: true, onSubmit: async code => {
      const result = await request(flow, '/confirm', { code });
      if (alive(flow)) showRecovery(flow, result.recovery_codes);
    } });
    // The encoder is local; the secret is never sent to a QR image service.
    try {
      await loadQrEncoder();
      if (!alive(flow) || !qrBox.isConnected) return;
      const qr = global.qrcode(0, 'M'); qr.addData(data.otpauth_uri, 'Byte'); qr.make();
      const count = qr.getModuleCount(), side = count + 8;
      const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${side} ${side}`);
      svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Google Authenticator-ის მიბმის QR-კოდი');
      svg.setAttribute('shape-rendering', 'crispEdges');
      const background = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
      background.setAttribute('width', String(side)); background.setAttribute('height', String(side)); background.setAttribute('fill', '#fff');
      const foreground = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      const points = [];
      for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) if (qr.isDark(y, x)) points.push(`M${x + 4},${y + 4}h1v1h-1z`);
      foreground.setAttribute('d', points.join('')); foreground.setAttribute('fill', '#000');
      svg.append(background, foreground); qrBox.appendChild(svg);
    } catch { if (alive(flow)) qrBox.textContent = 'QR ვერ ჩაიტვირთა. გამოიყენეთ ქვემოთ მოცემული გასაღები.'; }
  }

  function showPassword(flow, purpose = 'setup') {
    render(flow, purpose === 'recovery' ? 'ახალი სარეზერვო კოდები' : 'Google Authenticator-ის მიბმა',
      purpose === 'recovery'
        ? 'შეიყვანეთ თქვენი ანგარიშის პაროლი. ახალი კოდების შექმნისას ყველა ძველი სარეზერვო კოდი გაუქმდება.'
        : 'დასაწყებად შეიყვანეთ თქვენი ანგარიშის პაროლი. თითოეულ ადმინისტრატორს საკუთარი Authenticator ექნება.');
    inputForm(flow, { label: 'თქვენი პაროლი', type: 'password', autocomplete: 'current-password', submit: 'გაგრძელება',
      onSubmit: async password => {
        const result = await request(flow, purpose === 'recovery' ? '/recovery-codes' : '/setup', { password });
        if (!alive(flow)) return;
        if (purpose === 'recovery') showRecovery(flow, result.recovery_codes);
        else await showSetupCode(flow, result);
      } });
  }

  function showVerify(flow, recovery = false) {
    render(flow, recovery ? 'სარეზერვო კოდით შესვლა' : 'ადმინისტრატორის დადასტურება',
      recovery ? 'შეიყვანეთ ერთ-ერთი შენახული სარეზერვო კოდი. გამოყენებული კოდი განმეორებით აღარ იმუშავებს.'
        : 'Google Authenticator-ში გახსენით GIPC-ის ჩანაწერი და შეიყვანეთ 6-ნიშნა კოდი.');
    inputForm(flow, { label: recovery ? 'სარეზერვო კოდი' : 'Authenticator-ის კოდი', code: !recovery,
      onSubmit: async code => {
        const result = await request(flow, '/verify', { code });
        if (!alive(flow) || !result.verified) return;
        if (flow.manage) showManage(flow);
        else close(flow, true);
      } });
    action(flow, recovery ? 'Authenticator-ის კოდით შესვლა' : 'სარეზერვო კოდის გამოყენება', () => showVerify(flow, !recovery));
  }

  function showManage(flow) {
    render(flow, 'ადმინისტრატორის უსაფრთხოება', 'თქვენს ანგარიშზე Google Authenticator ჩართულია. ტელეფონის შეცვლამდე მოამზადეთ ახალი მოწყობილობა.');
    action(flow, 'Authenticator-ის სხვა ტელეფონზე მიბმა', () => showPassword(flow, 'setup'));
    action(flow, 'ახალი სარეზერვო კოდების შექმნა', () => showPassword(flow, 'recovery'));
    action(flow, 'დახურვა', () => close(flow, true), true);
  }

  async function checkStatus(flow) {
    const data = await request(flow, '/status');
    if (!alive(flow)) return;
    if (data.verified) {
      if (flow.manage) showManage(flow);
      else close(flow, true);
    } else if (data.enrolled) showVerify(flow);
    else showPassword(flow);
  }

  function begin(manage = false) {
    if (activeFlow) return activeFlow.promise;
    const token = currentToken();
    if (!token) { notify('ჯერ შედით თქვენს ანგარიშში.', 'error'); return Promise.resolve(false); }
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const dialog = element('dialog', 'admin-mfa-dialog');
    dialog.id = 'adminMfaDialog'; dialog.setAttribute('aria-labelledby', 'adminMfaTitle');
    dialog.setAttribute('aria-describedby', 'adminMfaDescription');
    const title = element('h2', 'mfa-title', 'ადმინისტრატორის დადასტურება'); title.id = 'adminMfaTitle'; title.tabIndex = -1;
    const dismiss = element('button', 'mfa-close', '×'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', 'გაუქმება');
    const heading = element('div', 'mfa-heading'); heading.append(title, dismiss);
    const description = element('p', 'mfa-description', 'მოწმდება უსაფრთხოების სტატუსი…'); description.id = 'adminMfaDescription';
    const content = element('div', 'mfa-content');
    const status = element('p', 'mfa-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const error = element('p', 'mfa-error'); error.setAttribute('role', 'alert');
    const retry = element('button', 'mfa-button', 'სტატუსის გადამოწმება'); retry.type = 'button'; retry.hidden = true;
    const cancel = element('button', 'mfa-button mfa-cancel', 'გაუქმება'); cancel.type = 'button';
    dialog.append(heading, description, content, status, error, retry, cancel);
    const flow = { token, promise, resolve, dialog, title, description, content, status, error, retry, manage,
      controller: null, busy: false, previousFocus: doc.activeElement };
    activeFlow = flow;
    dismiss.addEventListener('click', () => close(flow));
    cancel.addEventListener('click', () => close(flow));
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(flow); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(flow); }
      if (event.key === 'Tab') {
        const nodes = Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex="0"]'))
          .filter(node => !node.hidden && node.getClientRects().length > 0);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (doc.activeElement === first || doc.activeElement === title)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    });
    retry.addEventListener('click', () => void perform(flow, () => checkStatus(flow)));
    doc.body.appendChild(dialog);
    dialog.showModal(); title.focus();
    void perform(flow, () => checkStatus(flow));
    return promise;
  }

  // Observe only our API's explicit MFA response. Preserve the original response
  // and never replay a failed write (mail, certificate, delete, grant, etc.).
  global.fetch = async function mfaAwareFetch(resource, options) {
    const tokenAtStart = currentToken();
    const response = await nativeFetch(resource, options);
    if (response.status !== 403 || !tokenAtStart || tokenAtStart !== currentToken()) return response;
    try {
      const url = new URL(typeof resource === 'string' ? resource : resource.url, global.location.href);
      const base = new URL(API_BASE, global.location.href);
      if (url.origin !== base.origin || url.pathname.includes(MFA_PATH + '/')) return response;
      const data = await response.clone().json();
      if (data?.detail?.code !== 'ADMIN_MFA_REQUIRED') return response;
      if (!activeFlow) {
        void begin().then(verified => {
          if (verified) notify('დადასტურებულია. შეჩერებული მოქმედება ავტომატურად არ გამეორებულა — საჭიროების შემთხვევაში სცადეთ ხელახლა.');
          else if (/\/admin(?:\.html)?\/?$/.test(global.location.pathname)) global.location.href = 'index.html';
        });
      }
    } catch {}
    return response;
  };

  doc.addEventListener('click', event => {
    const link = event.target.closest?.('a.admin-link');
    if (link && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      const destination = link.href;
      void begin().then(verified => { if (verified) global.location.href = destination; });
      return;
    }
    const settings = event.target.closest?.('[data-admin-mfa-settings]');
    if (settings) { event.preventDefault(); void begin(true); }
  });
  function sessionChanged() { if (activeFlow) close(activeFlow); }
  global.addEventListener('auth:logout', sessionChanged);
  global.addEventListener('storage', event => { if (event.key === 'auth_token' || event.key === 'currentUser' || event.key === null) sessionChanged(); });
  global.addEventListener('pagehide', sessionChanged);
  global.AdminMfa = Object.freeze({ ensureVerified: () => begin(), openSettings: () => begin(true) });
})(window);

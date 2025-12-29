(function (global) {
  function createCertificateModule(context = {}) {
    const {
      DOM = {},
      API_BASE = 'http://127.0.0.1:8000',
      openOverlay = () => {},
      closeOverlay = () => {},
      showToast = () => {},
      deliverPdf = async () => false,
      preparePdfSaveHandle = async () => ({ handle: null, aborted: false }),
      getAdminHeaders = () => ({}),
      getActorHeaders = () => ({}),
      handleAdminErrorResponse = async () => {},
      onUserCertificateUpdated = () => {},
      loadExternalScript = () => Promise.resolve(),
      escapeHtml = (value) => {
        if (value == null) return '';
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      },
    } = context;

    const overlay = DOM.userCertificateOverlay;
    const closeBtn = DOM.userCertificateClose;
    const downloadBtn = DOM.userCertificateDownload;
    const deleteBtn = DOM.userCertificateDelete;
    const editBtn = DOM.certificateEditBtn;
    const emptyState = DOM.certificateEmptyState;
    const emptyCreateBtn = DOM.certificateEmptyCreate;
    const card = DOM.certificateCard || overlay?.querySelector('#certificateCard');
    const statusBadge = DOM.certificateStatusBadge || overlay?.querySelector('#certificateStatusBadge');
    const form = DOM.certificateForm;
    const formSubmitBtn = DOM.certificateFormSubmit;
    const validUntilDisplayNode = DOM.certificateFormValidUntilDisplay;

    const formFields = {
      uniqueCode: DOM.certificateFormCode,
      level: DOM.certificateFormLevel,
      status: DOM.certificateFormStatus,
      issueDate: DOM.certificateFormIssueDate,
      validityTerm: DOM.certificateFormValidityTerm,
      validUntil: DOM.certificateFormValidUntil,
      examScore: DOM.certificateFormScore,
    };

    const formSummaryNodes = {
      name: DOM.certificateFormName,
      phone: DOM.certificateFormPhone,
      email: DOM.certificateFormEmail,
      code: DOM.certificateFormCodeDisplay,
    };

    const templateContainer = overlay?.querySelector('#certificateTemplateContainer');
    const BASE_CERTIFICATE_WIDTH = 1123;
    const BASE_CERTIFICATE_HEIGHT = 793;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const CERTIFICATE_BACKGROUND_FILES = {
      architect: 'architect bac.svg',
      expert: 'expert bac.svg',
    };
    const backgroundSvgCache = new Map();
    const domParser = typeof DOMParser !== 'undefined' ? new DOMParser() : null;
    const downloadBtnDefaultLabel = downloadBtn?.textContent?.trim() || 'PDF';
    
    const fieldNodes = {};
    function updateFieldNodes() {
      // Clear existing
      Object.keys(fieldNodes).forEach(key => delete fieldNodes[key]);
      // Bind new template fields
      if (!overlay) return;
      overlay.querySelectorAll('[data-field]').forEach((node) => {
        fieldNodes[node.dataset.field] = node;
      });
    }

    function getBackgroundFileName(levelKey) {
      if (levelKey === 'expert') return CERTIFICATE_BACKGROUND_FILES.expert;
      return CERTIFICATE_BACKGROUND_FILES.architect;
    }

    async function loadBackgroundSvgString(levelKey) {
      const normalized = levelKey === 'expert' ? 'expert' : 'architect';
      if (backgroundSvgCache.has(normalized)) {
        return backgroundSvgCache.get(normalized);
      }
      const fileName = getBackgroundFileName(normalized);
      try {
        const response = await fetch(`../certificate/${fileName}`);
        if (!response.ok) return null;
        const text = await response.text();
        backgroundSvgCache.set(normalized, text);
        return text;
      } catch {
        return null;
      }
    }

    async function buildBackgroundNode(levelKey) {
      if (!domParser) return null;
      const svgString = await loadBackgroundSvgString(levelKey);
      if (!svgString) return null;
      const parsed = domParser.parseFromString(svgString, 'image/svg+xml');
      const sourceSvg = parsed?.documentElement;
      if (!sourceSvg) return null;
      const group = document.createElementNS(SVG_NS, 'g');
      Array.from(sourceSvg.childNodes || []).forEach((child) => {
        const clone = document.importNode(child, true);
        group.appendChild(clone);
      });
      return group;
    }

    function toPx(value, fallback = '16px') {
      if (!value || typeof value !== 'string') return fallback;
      if (value.endsWith('px')) return value;
      if (value.endsWith('pt')) {
        const numeric = parseFloat(value);
        if (!Number.isNaN(numeric)) {
          const px = (numeric * 96) / 72;
          return `${px}px`;
        }
      }
      return value;
    }

    function computeTextAnchor(textAlign) {
      const normalized = (textAlign || '').toLowerCase();
      if (normalized === 'left' || normalized === 'start') return 'start';
      if (normalized === 'right' || normalized === 'end') return 'end';
      return 'middle';
    }

    // CSS class name to percentage position mapping
    // Based on architect.css and expert.css
    const FIELD_POSITIONS = {
      'owner-1': { left: 10.33, top: 34.3, width: 58.24, height: 3.53 },
      'owner-2': { left: 10.33, top: 34.3, width: 58.24, height: 3.40 },
      'personal-number-1': { left: 12.33, top: 37.7, width: 10.42, height: 2.36 },
      'personal-number-2': { left: 12.33, top: 37.7, width: 10.42, height: 2.36 },
      'identification-code-1': { left: 74.0, top: 88, width: 11.27, height: 2.52 },
      'identification-code-2': { left: 74.0, top: 88, width: 11.27, height: 2.52 },
      'issue-date-1': { left: 11, top: 69, width: 7.57, height: 2.14 },
      'issue-date-2': { left: 11, top: 69, width: 7.57, height: 2.14 },
      'validity-period-1': { left: 34.10, top: 73.16, width: 3.65, height: 2.02 },
      'validity-period-2': { left: 34.10, top: 73.16, width: 3.65, height: 2.02 },
      'expiry-date-1': { left: 11, top: 77.20, width: 7.57, height: 2.14 },
      'expiry-date-2': { left: 11, top: 77.20, width: 7.57, height: 2.14 },
    };

    function getFieldPositionFromCss(fieldNode, levelKey) {
      // Try to find CSS class name from fieldNode
      const classList = Array.from(fieldNode.classList || []);
      for (const className of classList) {
        if (FIELD_POSITIONS[className]) {
          return FIELD_POSITIONS[className];
        }
      }
      // Fallback: try to match by field name and level
      const fieldName = fieldNode.dataset?.field || '';
      const suffix = levelKey === 'expert' ? '2' : '1';
      const className = `${fieldName.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '')}-${suffix}`;
      // Try common mappings
      const fieldMap = {
        'fullname': 'owner',
        'full-name': 'owner',
        'personalid': 'personal-number',
        'personal-id': 'personal-number',
        'uniquecode': 'identification-code',
        'unique-code': 'identification-code',
        'issuedate': 'issue-date',
        'issue-date': 'issue-date',
        'validityterm': 'validity-period',
        'validity-term': 'validity-period',
        'validuntil': 'expiry-date',
        'valid-until': 'expiry-date',
      };
      const baseName = fieldMap[fieldName.toLowerCase()] || fieldName.toLowerCase();
      const mappedClassName = `${baseName}-${suffix}`;
      if (FIELD_POSITIONS[mappedClassName]) {
        return FIELD_POSITIONS[mappedClassName];
      }
      return null;
    }

    function createSvgTextNodeFromField(fieldNode, baseRect, levelKey) {
      if (!fieldNode) return null;

      // Prefer exact CSS percentage mapping to ensure parity with on-screen layout
      const position = getFieldPositionFromCss(fieldNode, levelKey);

      let x, y, width, height;
      if (position) {
        x = (position.left / 100) * BASE_CERTIFICATE_WIDTH;
        y = (position.top / 100) * BASE_CERTIFICATE_HEIGHT;
        width = (position.width / 100) * BASE_CERTIFICATE_WIDTH;
        height = (position.height / 100) * BASE_CERTIFICATE_HEIGHT;
      } else {
        // Fallback to DOM rects (should rarely be needed)
        const rect = fieldNode.getBoundingClientRect();
        if (!rect || !baseRect) return null;
        x = rect.left - baseRect.left;
        y = rect.top - baseRect.top;
        width = rect.width;
        height = rect.height;
      }

      if (width <= 0 || height <= 0) return null;

      const computed = global.getComputedStyle(fieldNode);
      const textAnchor = computeTextAnchor(computed?.textAlign);
      
      // Get padding values to adjust text position
      const paddingLeft = parseFloat(computed.paddingLeft || '0') || 0;
      const paddingRight = parseFloat(computed.paddingRight || '0') || 0;
      const paddingTop = parseFloat(computed.paddingTop || '0') || 0;
      const paddingBottom = parseFloat(computed.paddingBottom || '0') || 0;
      
      // Calculate anchorX based on text alignment and padding
      let anchorX;
      if (textAnchor === 'start') {
        // Left-aligned text starts at x + paddingLeft
        anchorX = x + paddingLeft;
      } else if (textAnchor === 'end') {
        // Right-aligned text ends at x + width - paddingRight
        anchorX = x + width - paddingRight;
      } else {
        // Center-aligned text is at the center of the content area (excluding padding)
        const contentWidth = width - paddingLeft - paddingRight;
        anchorX = x + paddingLeft + contentWidth / 2;
      }

      // Get text content - prefer textContent over innerText for SVG
      const textContent = fieldNode.textContent || fieldNode.innerText || '';
      
      // Decide font per field
      const fieldName = fieldNode.dataset?.field || '';
      
      // Compute vertical anchor: center of the content box (height minus vertical padding)
      const contentHeight = Math.max(0, height - paddingTop - paddingBottom);
      const anchorY = y + paddingTop + contentHeight / 2;

      const textNode = document.createElementNS(SVG_NS, 'text');
      textNode.setAttribute('x', anchorX.toString());
      textNode.setAttribute('y', anchorY.toString());
      textNode.setAttribute('dominant-baseline', 'middle');
      textNode.setAttribute('text-anchor', textAnchor);
      // Use dedicated font for full name; progressive fallback chain
      if (fieldName === 'fullName') {
        // Both certificate types: strictly BPGNino for full name
        textNode.setAttribute('font-family', 'BPGNino');
        textNode.setAttribute('font-weight', 'bold');
        textNode.setAttribute('font-style', 'normal');
      } else {
        // Force jsPDF-registered font to guarantee Georgian glyph support
        textNode.setAttribute('font-family', 'DejaVuSans');
        // Keep style normal to match the registered variant
        textNode.setAttribute('font-weight', 'normal');
        textNode.setAttribute('font-style', 'normal');
      }
      if (computed?.fontSize) {
        textNode.setAttribute('font-size', toPx(computed.fontSize));
      }
      if (computed?.color) {
        textNode.setAttribute('fill', computed.color);
      }
      if (computed?.letterSpacing && computed.letterSpacing !== 'normal') {
        textNode.setAttribute('letter-spacing', computed.letterSpacing);
      }
      textNode.setAttribute('xml:space', 'preserve');
      textNode.textContent = textContent;
      
      return textNode;
    }

    async function buildCertificateSvgElement(levelKey) {
      const certificateEl = getCertificateElement();
      if (!certificateEl) return null;
      const clone = certificateEl.cloneNode(true);
      clone.style.transform = 'none';
      clone.style.width = `${BASE_CERTIFICATE_WIDTH}px`;
      clone.style.height = `${BASE_CERTIFICATE_HEIGHT}px`;
      const sandbox = document.createElement('div');
      sandbox.style.position = 'fixed';
      sandbox.style.left = '-10000px';
      sandbox.style.top = '-10000px';
      sandbox.style.width = `${BASE_CERTIFICATE_WIDTH}px`;
      sandbox.style.height = `${BASE_CERTIFICATE_HEIGHT}px`;
      sandbox.style.opacity = '0';
      sandbox.style.pointerEvents = 'none';
      sandbox.setAttribute('aria-hidden', 'true');
      sandbox.className = 'certificate-vector-sandbox';
      sandbox.appendChild(clone);
      document.body.appendChild(sandbox);

      try {
        // Force a reflow to ensure CSS is applied
        void sandbox.offsetHeight;
        // Wait for next frame to ensure layout is complete
        await new Promise(resolve => requestAnimationFrame(resolve));
        
        const baseRect = clone.getBoundingClientRect();
        const svgEl = document.createElementNS(SVG_NS, 'svg');
        svgEl.setAttribute('xmlns', SVG_NS);
        svgEl.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
        svgEl.setAttribute('xml:space', 'preserve');
        svgEl.setAttribute('width', `${BASE_CERTIFICATE_WIDTH}`);
        svgEl.setAttribute('height', `${BASE_CERTIFICATE_HEIGHT}`);
        svgEl.setAttribute('viewBox', `0 0 ${BASE_CERTIFICATE_WIDTH} ${BASE_CERTIFICATE_HEIGHT}`);

        // No SVG @font-face needed; fonts are embedded into PDF by jsPDF

        try {
          const backgroundNode = await buildBackgroundNode(levelKey);
          if (backgroundNode) {
            svgEl.appendChild(backgroundNode);
          }
        } catch (_error) {}

        const fieldNodesList = clone.querySelectorAll('[data-field]');
        fieldNodesList.forEach((fieldNode) => {
          const textNode = createSvgTextNodeFromField(fieldNode, baseRect, levelKey);
          if (textNode) svgEl.appendChild(textNode);
        });

        return svgEl;
      } finally {
        if (sandbox?.parentNode) {
          sandbox.parentNode.removeChild(sandbox);
        }
      }
    }

    const STATUS_MAP = new Map([
      ['active', { key: 'active', label: 'მოქმედი' }],
      ['მოქმედი', { key: 'active', label: 'მოქმედი' }],
      ['suspended', { key: 'suspended', label: 'შეჩერებული' }],
      ['შეჩერებული', { key: 'suspended', label: 'შეჩერებული' }],
      ['paused', { key: 'suspended', label: 'შეჩერებული' }],
      ['inactive', { key: 'suspended', label: 'შეჩერებული' }],
      ['expired', { key: 'expired', label: 'ვადაგასული' }],
      ['ვადაგასული', { key: 'expired', label: 'ვადაგასული' }],
    ]);

    const LEVEL_MAP = new Map([
      ['architect', { key: 'architect', label: 'შენობა-ნაგებობის არქიტექტორი' }],
      ['architect_expert', { key: 'expert', label: 'არქიტექტურული პროექტის ექსპერტი' }],
      ['expert', { key: 'expert', label: 'არქიტექტურული პროექტის ექსპერტი' }],
      ['არქიტექტორი', { key: 'architect', label: 'შენობა-ნაგებობის არქიტექტორი' }],
      ['არქიტექტორი ექსპერტი', { key: 'expert', label: 'არქიტექტურული პროექტის ექსპერტი' }],
      ['შენობა-ნაგებობის არქიტექტორი', { key: 'architect', label: 'შენობა-ნაგებობის არქიტექტორი' }],
      ['არქიტექტურული პროექტის ექსპერტი', { key: 'expert', label: 'არქიტექტურული პროექტის ექსპერტი' }],
    ]);

    function resolveLevelKey(raw) {
      if (!raw) return 'architect';
      if (typeof raw === 'object') {
        return raw.key === 'expert' ? 'expert' : 'architect';
      }
      const s = String(raw).trim().toLowerCase();
      if (s === 'expert' || s === 'architect_expert' || s === 'არქიტექტორი ექსპერტი' || s === 'არქიტექტურული პროექტის ექსპერტი') {
        return 'expert';
      }
      return 'architect';
    }

    const TIER_CLASSES = {
      architect: 'certificate-card--architect',
      expert: 'certificate-card--expert',
    };

    let activeUserRef = null;
    let activeUser = null;
    let activeData = null;
    let formOpen = false;
    let formMode = 'create';

    function ensureOverlay() {
      return !!(overlay && card);
    }

    function parseDate(value) {
      if (!value) return null;
      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value;
      }
      if (typeof value === 'number') {
        const fromNum = new Date(value);
        return Number.isNaN(fromNum.getTime()) ? null : fromNum;
      }
      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        const normalized = trimmed.replace(/\s+/g, ' ');
        const fromString = new Date(normalized);
        if (!Number.isNaN(fromString.getTime())) return fromString;
        const parts = normalized.split(/[./-]/).map((part) => part.trim());
        if (parts.length === 3) {
          const [a, b, c] = parts;
          if (c.length === 4) {
            const iso = `${c.padStart(4, '0')}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
            const fromReversed = new Date(iso);
            if (!Number.isNaN(fromReversed.getTime())) return fromReversed;
          }
        }
      }
      return null;
    }

    function formatDate(date) {
      const parsed = parseDate(date);
      if (!parsed) return '';
      // Force DD/MM/YYYY regardless of browser locale
      const day = String(parsed.getDate()).padStart(2, '0');
      const month = String(parsed.getMonth() + 1).padStart(2, '0');
      const year = String(parsed.getFullYear());
      return `${day}/${month}/${year}`;
    }

    function formatInputDate(value) {
      const parsed = parseDate(value);
      if (!parsed) return '';
      const year = parsed.getFullYear();
      const month = String(parsed.getMonth() + 1).padStart(2, '0');
      const day = String(parsed.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }

    // --- Lightweight inline date picker for issueDate (DD/MM/YYYY) ---
    const _DP_MONTHS = ['იან', 'თებ', 'მარ', 'აპრ', 'მაი', 'ივნ', 'ივლ', 'აგვ', 'სექ', 'ოქტ', 'ნოე', 'დეკ'];
    const _DP_WEEK = ['ორშ', 'სამ', 'ოთხ', 'ხუთ', 'პარ', 'შაბ', 'კვ'];
    function _pad2(n) { return String(n).padStart(2, '0'); }
    function _formatDDMMYYYY(d) { return `${_pad2(d.getDate())}/${_pad2(d.getMonth() + 1)}/${d.getFullYear()}`; }

    const datePicker = (() => {
      let panel = null;
      let monthSel = null;
      let yearSel = null;
      let daysGrid = null;
      let anchor = null;

      function ensurePanel() {
        if (panel) return;
        panel = document.createElement('div');
        panel.className = 'mini-date-picker';
        Object.assign(panel.style, {
          position: 'fixed',
          zIndex: '99999',
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: '8px',
          boxShadow: '0 10px 25px rgba(0,0,0,.08)',
          padding: '8px',
          width: '240px',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
          fontSize: '13px',
        });

        const controls = document.createElement('div');
        Object.assign(controls.style, { display: 'flex', gap: '6px', marginBottom: '6px' });

        monthSel = document.createElement('select');
        _DP_MONTHS.forEach((m, i) => {
          const opt = document.createElement('option');
          opt.value = String(i);
          opt.textContent = m;
          monthSel.appendChild(opt);
        });

        yearSel = document.createElement('select');
        const nowY = new Date().getFullYear();
        for (let y = nowY + 5; y >= nowY - 60; y--) {
          const opt = document.createElement('option');
          opt.value = String(y);
          opt.textContent = String(y);
          yearSel.appendChild(opt);
        }

        monthSel.addEventListener('change', renderDays);
        yearSel.addEventListener('change', renderDays);

        controls.appendChild(monthSel);
        controls.appendChild(yearSel);

        const weekHead = document.createElement('div');
        Object.assign(weekHead.style, {
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: '4px',
          margin: '4px 0',
          color: '#6b7280',
          textAlign: 'center',
          userSelect: 'none',
        });
        _DP_WEEK.forEach((w) => {
          const span = document.createElement('div');
          span.textContent = w;
          span.style.fontWeight = '600';
          weekHead.appendChild(span);
        });

        daysGrid = document.createElement('div');
        Object.assign(daysGrid.style, {
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: '4px',
        });

        panel.appendChild(controls);
        panel.appendChild(weekHead);
        panel.appendChild(daysGrid);

        document.body.appendChild(panel);

        function onDocClick(e) {
          if (!panel || panel.hidden) return;
          if (panel.contains(e.target) || e.target === anchor) return;
          close();
        }
        document.addEventListener('click', onDocClick, true);
      }

      function position(input) {
        const r = input.getBoundingClientRect();
        panel.style.left = `${Math.max(8, Math.min(window.innerWidth - 8 - panel.offsetWidth, r.left))}px`;
        panel.style.top = `${Math.min(window.innerHeight - 8 - panel.offsetHeight, r.bottom + 4)}px`;
      }

      function renderDays() {
        const y = parseInt(yearSel.value, 10);
        const m = parseInt(monthSel.value, 10);
        daysGrid.innerHTML = '';

        const first = new Date(y, m, 1);
        const total = new Date(y, m + 1, 0).getDate();
        const offset = (first.getDay() + 6) % 7; // Monday-first

        for (let i = 0; i < offset; i++) {
          const spacer = document.createElement('div');
          spacer.style.opacity = '.0';
          spacer.textContent = '·';
          daysGrid.appendChild(spacer);
        }

        for (let d = 1; d <= total; d++) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = String(d);
          Object.assign(btn.style, {
            padding: '6px 0',
            border: '1px solid #e5e7eb',
            borderRadius: '6px',
            background: '#fff',
            cursor: 'pointer',
          });
          btn.addEventListener('mouseenter', () => (btn.style.background = '#f3f4f6'));
          btn.addEventListener('mouseleave', () => (btn.style.background = '#fff'));
          btn.addEventListener('click', () => {
            if (!anchor) return;
            const picked = new Date(y, m, d);
            anchor.value = _formatDDMMYYYY(picked);
            anchor.dispatchEvent(new Event('input', { bubbles: true }));
            anchor.dispatchEvent(new Event('change', { bubbles: true }));
            close();
            anchor.focus();
          });
          daysGrid.appendChild(btn);
        }
      }

      function open(input, initialValue) {
        ensurePanel();
        anchor = input;
        const base = parseDate(initialValue) || new Date();
        monthSel.value = String(base.getMonth());
        yearSel.value = String(base.getFullYear());
        renderDays();
        panel.hidden = false;
        position(input);
      }

      function close() {
        if (!panel) return;
        panel.hidden = true;
      }

      return { open, close, isOpen: () => !!panel && !panel.hidden };
    })();

    function attachIssueDatePicker() {
      const input = formFields.issueDate;
      if (!input) return;
      input.addEventListener('focus', () => datePicker.open(input, input.value));
      input.addEventListener('click', () => datePicker.open(input, input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); datePicker.open(input, input.value); }
        if (e.key === 'Escape') { datePicker.close(); }
      });
    }

    function parseNumber(value) {
      if (value == null || value === '') return null;
      if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
      }
      let source = String(value).trim();
      if (!source) return null;
      source = source.replace(/[^\d.,-]/g, '');
      source = source.replace(',', '.');
      const normalized = Number(source);
      if (!Number.isFinite(normalized)) return null;
      return normalized;
    }

    function computeValidity({ issueDate, validityTerm, validUntil }) {
      const issued = parseDate(issueDate);
      const expiry = parseDate(validUntil);
      const termNumber = parseNumber(validityTerm);
      let derivedValidUntil = expiry;
      if (!derivedValidUntil && issued && termNumber) {
        const computed = new Date(issued);
        computed.setFullYear(computed.getFullYear() + termNumber);
        derivedValidUntil = computed;
      }
      return derivedValidUntil;
    }

    function normalizeStatus(rawStatus, validUntilDate) {
      const fallback = STATUS_MAP.get('active');
      const rawKey = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : '';
      let normalized = STATUS_MAP.get(rawStatus) || STATUS_MAP.get(rawKey) || fallback;

      const expiration = parseDate(validUntilDate);
      if (expiration) {
        const now = new Date();
        const expirationMoment = new Date(expiration);
        expirationMoment.setHours(23, 59, 59, 999);
        if (expirationMoment.getTime() < now.getTime()) {
          normalized = STATUS_MAP.get('expired');
        }
      }

      return normalized;
    }

    function normalizeLevel(rawLevel) {
      if (!rawLevel) return LEVEL_MAP.get('architect');
      return (
        LEVEL_MAP.get(rawLevel) ||
        LEVEL_MAP.get(String(rawLevel).trim().toLowerCase()) ||
        LEVEL_MAP.get('architect')
      );
    }

    function hasCertificatePayload(certificate = {}) {
      if (!certificate || typeof certificate !== 'object') return false;
      const keys = [
        'unique_code',
        'code',
        'status',
        'state',
        'level',
        'rank',
        'issue_date',
        'issueDate',
        'exam_date',
        'examDate',
        'passed_at',
        'valid_until',
        'validUntil',
        'expires_at',
        'validity_term',
        'validity_years',
        'notes',
        'comment',
        'description',
      ];
      return keys.some((key) => {
        const value = certificate[key];
        if (value == null) return false;
        if (typeof value === 'string') return value.trim().length > 0;
        return true;
      });
    }

    function buildFullName(user) {
      const source = user || {};
      const first = (source.first_name || source.firstName || '').trim();
      const last = (source.last_name || source.lastName || '').trim();
      return `${first} ${last}`.trim();
    }

    function buildCertificateData(user) {
      const certificate = user?.certificate || user?.certificate_info || {};
      const hasCertificate = hasCertificatePayload(certificate);

      const firstName = user?.first_name || user?.firstName || certificate.first_name || '';
      const lastName = user?.last_name || user?.lastName || certificate.last_name || '';
      const phone = user?.phone || certificate.phone || '';
      const email = user?.email || certificate.email || '';
      const rawUniqueCode = certificate.unique_code || certificate.code || '';
      const uniqueCode = rawUniqueCode || user?.code || '';

      const rawLevel =
        certificate.level || certificate.rank || user?.certificate_level || user?.level;
      const level = normalizeLevel(rawLevel);

      const issueDateRaw =
        certificate.issue_date ||
        certificate.issueDate ||
        certificate.exam_date ||
        certificate.examDate ||
        certificate.passed_at ||
        user?.certificate_issue_date ||
        user?.issue_date ||
        user?.exam_passed_at ||
        user?.examDate ||
        '';

      const validityTermRaw =
        certificate.validity_term ??
        certificate.validity_years ??
        certificate.validity ??
        user?.certificate_validity ??
        null;

      const validUntilSource =
        certificate.valid_until ||
        certificate.validUntil ||
        certificate.expires_at ||
        user?.certificate_valid_until ||
        '';

      const computedValidUntil = computeValidity({
        issueDate: issueDateRaw,
        validityTerm: validityTermRaw,
        validUntil: validUntilSource,
      });
      const validUntilDate = computedValidUntil || parseDate(validUntilSource);

      const status = normalizeStatus(
        certificate.status || certificate.state || user?.certificate_status,
        validUntilDate
      );
      const termNumber = parseNumber(validityTermRaw);
      const examScoreRaw = parseNumber(
        certificate.exam_score ?? certificate.examScore ?? user?.exam_score ?? user?.examScore
      );
      return {
        firstName,
        lastName,
        fullName: buildFullName({ first_name: firstName, last_name: lastName }),
        phone,
        email,
        uniqueCode,
        level,
        status,
        issueDate: formatDate(issueDateRaw),
        issueDateInputValue: formatInputDate(issueDateRaw),
        rawIssueDate: issueDateRaw,
        rawValidityTerm: termNumber,
        validityTerm:
          termNumber == null
            ? ''
            : String(termNumber),
        validUntil: formatDate(validUntilDate),
        validUntilInputValue: formatInputDate(validUntilDate),
        rawValidUntil: validUntilSource,
        rawExamScore: examScoreRaw,
        examScore: examScoreRaw,
        isInactive: status.key === 'suspended' || status.key === 'expired',
        hasCertificate,
      };
    }

    function setField(name, value) {
      const node = fieldNodes[name];
      if (!node) return;
      const textValue = value == null || value === '' ? '—' : String(value);
      node.textContent = textValue;
      if (textValue === '—') {
        node.dataset.empty = 'true';
      } else {
        node.removeAttribute('data-empty');
      }
    }

    let themeLinkEl = null;
    function ensureThemeStyles() {
      if (themeLinkEl && document.head.contains(themeLinkEl)) return themeLinkEl;
      themeLinkEl = document.getElementById('certificateThemeStyles');
      if (!themeLinkEl) {
        themeLinkEl = document.createElement('link');
        themeLinkEl.id = 'certificateThemeStyles';
        themeLinkEl.rel = 'stylesheet';
        document.head.appendChild(themeLinkEl);
      } else {
        document.head.appendChild(themeLinkEl);
      }
      return themeLinkEl;
    }

    async function loadCertificateTemplate(level) {
      if (!templateContainer) return;
      
      const levelKey = level === 'expert' ? 'expert' : 'architect';
      const templatePath = `../certificate/${levelKey}.html`;
      const cssPath = `../certificate/${levelKey}.css`;
      const themeVersion = '20251113';
      
      try {
        const response = await fetch(templatePath);
        if (!response.ok) return;
        const html = await response.text();
        // Wrap template with a scale wrapper so transform scaling preserves layout centering
        templateContainer.innerHTML = `<div class="certificate-scale-wrapper">${html}</div>`;
        
        // Update field nodes after loading template
        updateFieldNodes();

        // Apply corresponding theme stylesheet (last in head to win CSS cascade)
        const link = ensureThemeStyles();
        const versionedCssPath = `${cssPath}?v=${themeVersion}`;
        if (link.getAttribute('href') !== versionedCssPath) {
          link.setAttribute('href', versionedCssPath);
        }

        // Field nodes updated; scaling will be handled by caller
      } catch {}
    }

    function fitCertificateToContainer() {
      if (!templateContainer) return;
      let wrapperEl = templateContainer.querySelector('.certificate-scale-wrapper');
      const certificateEl = templateContainer.querySelector('.certificate-background');
      if (!certificateEl) return;
      if (!wrapperEl) {
        // Create wrapper if missing
        wrapperEl = document.createElement('div');
        wrapperEl.className = 'certificate-scale-wrapper';
        certificateEl.parentElement?.insertBefore(wrapperEl, certificateEl);
        wrapperEl.appendChild(certificateEl);
      }

      // Base certificate size (px) – used for precise scaling
      const BASE_WIDTH = BASE_CERTIFICATE_WIDTH;
      const BASE_HEIGHT = BASE_CERTIFICATE_HEIGHT;

      // Ensure base size so absolute/percent positions map predictably
      certificateEl.style.width = `${BASE_WIDTH}px`;
      certificateEl.style.height = `${BASE_HEIGHT}px`;
      certificateEl.style.transformOrigin = 'top left';

      // Available space: fit to viewport (with a small margin so header/actions don't overlap)
      const viewportMargin = 24;
      const availableWidth = Math.max(0, window.innerWidth - viewportMargin * 2);
      const availableHeight = Math.max(0, window.innerHeight - viewportMargin * 2);

      // Scale to fit while preserving aspect ratio
      const SCALE_ADJUST = 0.9; // 10% smaller preview on screen
      const scale = Math.max(
        0.1,
        Math.min(availableWidth / BASE_WIDTH, availableHeight / BASE_HEIGHT) * SCALE_ADJUST
      );

      certificateEl.style.transform = `scale(${scale})`;

      // Size the wrapper to the scaled dimensions so Flexbox can center correctly
      const scaledWidth = BASE_WIDTH * scale;
      const scaledHeight = BASE_HEIGHT * scale;
      wrapperEl.style.width = `${scaledWidth}px`;
      wrapperEl.style.height = `${scaledHeight}px`;
      wrapperEl.style.position = 'relative';
      wrapperEl.style.display = 'block';

      // Ensure container does not show anything outside the certificate
      templateContainer.style.display = 'block';
      templateContainer.style.overflow = 'hidden';
    }

    function applyCardStyling(data) {
      if (!card || !data) return;
      Object.values(TIER_CLASSES).forEach((className) => card.classList.remove(className));
      card.classList.remove('certificate-card--inactive');

      const tierKey = resolveLevelKey(data.level || data.level?.key);
      const tierClass = TIER_CLASSES[tierKey] || TIER_CLASSES.architect;
      card.classList.add(tierClass);
      card.dataset.certTier = tierKey;

      if (data.isInactive) {
        card.classList.add('certificate-card--inactive');
      }
    }

    function renderStatus(data) {
      if (!statusBadge) return;
      statusBadge.classList.remove('is-suspended', 'is-expired');

      if (!data || !data.hasCertificate) {
        statusBadge.innerHTML =
          '<span class="status-indicator" aria-hidden="true"></span>—';
        return;
      }

      const indicator = '<span class="status-indicator" aria-hidden="true"></span>';
      statusBadge.innerHTML = `${indicator}${escapeHtml(data.status.label)}`;
      if (data.status.key === 'suspended') {
        statusBadge.classList.add('is-suspended');
      } else if (data.status.key === 'expired') {
        statusBadge.classList.add('is-expired');
      }
    }

    function nextAnimationFrame() {
      return new Promise((resolve) => requestAnimationFrame(resolve));
    }

    async function populateView(data) {
      if (!data) return;
      applyCardStyling(data);
      
      // Load certificate template based on level
      const levelKey = resolveLevelKey(data.level || data.level?.key);
      await loadCertificateTemplate(levelKey);
      
      // Wait next frame for DOM render
      await nextAnimationFrame();
      
      // Fit after DOM update
      fitCertificateToContainer();
      
      setField('uniqueCode', data.uniqueCode || '—');
      setField('fullName', data.fullName || buildFullName(activeUser) || '—');
      setField('personalId', activeUser?.personal_id || '—');
      setField('issueDate', data.hasCertificate ? data.issueDate || '—' : '—');
      setField('validityTerm', data.hasCertificate ? data.validityTerm || '—' : '—');
      setField('validUntil', data.hasCertificate ? data.validUntil || '—' : '—');
      renderStatus(data);
    }

    function setFormSummary(data) {
      const fallbackName = buildFullName(activeUser);
      const name = data?.fullName || fallbackName || '—';
      const phone = data?.phone || activeUser?.phone || '—';
      const email = data?.email || activeUser?.email || '—';
      const code = data?.uniqueCode || activeUser?.code || '—';

      if (formSummaryNodes.name) formSummaryNodes.name.textContent = name || '—';
      if (formSummaryNodes.phone) formSummaryNodes.phone.textContent = phone || '—';
      if (formSummaryNodes.email) formSummaryNodes.email.textContent = email || '—';
      if (formSummaryNodes.code) formSummaryNodes.code.textContent = code || '—';
    }

    function resetForm() {
      form?.reset();
      setFormSummary(null);
      if (formFields.validUntil) {
        formFields.validUntil.value = '';
      }
      if (formFields.examScore) {
        formFields.examScore.value = '';
      }
      if (validUntilDisplayNode) {
        validUntilDisplayNode.textContent = '—';
      }
    }

    function populateFormFields() {
      if (!form || !activeData) return;

      const defaults = {
        uniqueCode: activeData.uniqueCode || activeUser?.code || '',
        level: activeData.level?.key || 'architect',
        status: activeData.status?.key || 'active',
        // Display DD/MM/YYYY in the input
        issueDate: activeData.issueDate || '',
        validityTerm:
          activeData.rawValidityTerm != null
            ? String(activeData.rawValidityTerm)
            : formFields.validityTerm?.defaultValue || '5',
        validUntil: activeData.validUntilInputValue || '',
        validUntilDisplay: activeData.validUntil || '—',
        examScore:
          activeData.rawExamScore != null && !Number.isNaN(activeData.rawExamScore)
            ? String(activeData.rawExamScore)
            : '',
      };

      if (formFields.uniqueCode) formFields.uniqueCode.value = defaults.uniqueCode;
      if (formSummaryNodes.code) formSummaryNodes.code.textContent = defaults.uniqueCode || '—';
      if (formFields.level) formFields.level.value = defaults.level;
      if (formFields.status) formFields.status.value = defaults.status;
      if (formFields.issueDate) formFields.issueDate.value = defaults.issueDate;
      if (formFields.validityTerm) formFields.validityTerm.value = defaults.validityTerm;
      if (formFields.validUntil) formFields.validUntil.value = defaults.validUntil;
      if (formFields.examScore) formFields.examScore.value = defaults.examScore;
      if (validUntilDisplayNode) validUntilDisplayNode.textContent = defaults.validUntilDisplay || '—';
      setFormSummary(activeData);

      updateAutoValidity();
    }

    function updateAutoValidity() {
      if (!formOpen) return;
      if (!formFields.issueDate || !formFields.validityTerm || !formFields.validUntil) return;

      const issueDateValue = formFields.issueDate.value;
      const termNumber = parseNumber(formFields.validityTerm.value);
      if (!issueDateValue || termNumber == null) {
        formFields.validUntil.value = '';
        if (validUntilDisplayNode) validUntilDisplayNode.textContent = '—';
        return;
      }

      const issueDate = parseDate(issueDateValue);
      if (!issueDate) {
        formFields.validUntil.value = '';
        if (validUntilDisplayNode) validUntilDisplayNode.textContent = '—';
        return;
      }

      const suggestion = new Date(issueDate);
      suggestion.setFullYear(suggestion.getFullYear() + termNumber);
      const formatted = formatInputDate(suggestion);
      formFields.validUntil.value = formatted || '';
      if (validUntilDisplayNode) {
        validUntilDisplayNode.textContent = formatted ? formatDate(suggestion) : '—';
      }
    }

    function updateView() {
      const hasCertificate = !!(activeData && activeData.hasCertificate);
      const showCard = hasCertificate && !formOpen;

      if (card) card.classList.toggle('hidden', !showCard);
      if (deleteBtn) {
        deleteBtn.disabled = !hasCertificate || formOpen;
      }
      if (editBtn) {
        editBtn.classList.toggle('hidden', !hasCertificate);
        editBtn.disabled = formOpen;
        editBtn.textContent = formOpen ? 'ფორმის დახურვა' : 'რედაქტირება';
      }
      if (emptyState) emptyState.classList.toggle('hidden', hasCertificate || formOpen);
      if (form) form.classList.toggle('hidden', !formOpen);

      if (downloadBtn) {
        downloadBtn.disabled = !hasCertificate || formOpen || !!(activeData && activeData.isInactive);
      }
      if (emptyCreateBtn && !hasCertificate && !formOpen) {
        emptyCreateBtn.textContent = 'სერტიფიკატის შექმნა';
      }
    }

    function openForm(mode) {
      if (!form) return;
      formMode = mode || (activeData?.hasCertificate ? 'update' : 'create');
      formOpen = true;
      populateFormFields();
      updateView();
      requestAnimationFrame(() => {
        if (formFields.level?.focus) {
          formFields.level.focus();
        }
      });
    }

    function closeForm(options = {}) {
      if (!formOpen && !options.force) return;
      formOpen = false;
      resetForm();
      updateView();
    }

    function handleEmptyCreateClick() {
      if (!ensureOverlay()) return;
      if (!formOpen) {
        openForm('create');
      }
    }

    function handleEditClick() {
      if (!ensureOverlay()) return;
      if (formOpen) {
        closeForm();
      } else {
        openForm('update');
      }
    }

    async function handleFormSubmit(event) {
      event?.preventDefault?.();
      if (!form || !activeUser?.id) return;

      const uniqueCode = formFields.uniqueCode?.value?.trim() || '';
      const levelValue = formFields.level?.value || 'architect';
      const statusValue = formFields.status?.value || 'active';
      const issueDateValue = formFields.issueDate?.value || null;
      const validityTermValue = parseNumber(formFields.validityTerm?.value);
      const validUntilValue = formFields.validUntil?.value || null;
      const examScoreValue = parseNumber(formFields.examScore?.value);

      if (!issueDateValue) {
        showToast('გთხოვ მიუთითო გაცემის თარიღი', 'error');
        return;
      }

      if (validityTermValue == null || validityTermValue <= 0) {
        showToast('მოქმედების ვადა უნდა იყოს დადებითი წელი', 'error');
        return;
      }

      if (examScoreValue == null || examScoreValue < 1 || examScoreValue > 100) {
        showToast('შეფასება უნდა იყოს 1-დან 100-მდე', 'error');
        return;
      }

      const payload = {
        unique_code: uniqueCode || null,
        level: levelValue,
        status: statusValue,
        // Convert DD/MM/YYYY (UI) -> YYYY-MM-DD for backend
        issue_date: formatInputDate(issueDateValue),
        validity_term: validityTermValue,
        valid_until: validUntilValue,
        exam_score: examScoreValue,
      };

      try {
        const url = `${API_BASE}/users/${activeUser.id}/certificate`;
        const method = formMode === 'create' ? 'POST' : 'PUT';
        const response = await fetch(url, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          await handleAdminErrorResponse(response);
          return;
        }

        const certificateData = await response.json();

        // Trust the selected level in the form for UI consistency
        const normalizedLevel = normalizeLevel(levelValue);
        const normalizedStatus = normalizeStatus(certificateData.status, certificateData.valid_until);

        const formattedIssueDate = formatDate(certificateData.issue_date);
        const formattedValidUntil = formatDate(certificateData.valid_until);
        const validityLabel =
          certificateData.validity_term != null
            ? String(certificateData.validity_term)
            : '';

        activeData = {
          ...(activeData || {}),
          firstName: activeData?.firstName || activeUser?.first_name || '',
          lastName: activeData?.lastName || activeUser?.last_name || '',
          fullName: buildFullName(activeUser),
          phone: activeData?.phone || activeUser?.phone || '',
          email: activeData?.email || activeUser?.email || '',
          uniqueCode: certificateData.unique_code || activeUser?.code || '',
          level: normalizedLevel,
          status: normalizedStatus,
          issueDate: formattedIssueDate,
          issueDateInputValue: formatInputDate(certificateData.issue_date),
          rawIssueDate: certificateData.issue_date,
          rawValidityTerm: certificateData.validity_term,
          validityTerm: validityLabel,
          validUntil: formattedValidUntil,
          validUntilInputValue: certificateData.valid_until,
          rawValidUntil: certificateData.valid_until,
          rawExamScore: certificateData.exam_score,
          examScore: certificateData.exam_score,
          isInactive: normalizedStatus.key === 'suspended' || normalizedStatus.key === 'expired',
          hasCertificate: true,
        };

        if (activeUserRef) {
          activeUserRef.certificate = { ...certificateData, level: levelValue };
          activeUserRef.certificate_info = {
            unique_code: certificateData.unique_code,
            level: levelValue,
            status: certificateData.status,
            issue_date: certificateData.issue_date,
            validity_term: certificateData.validity_term,
            valid_until: certificateData.valid_until,
            exam_score: certificateData.exam_score,
          };
          activeUserRef.certificate_status = certificateData.status;
          activeUserRef.certificate_valid_until = certificateData.valid_until;
        }

        closeForm({ force: true });
        await populateView(activeData);
        updateView();
        
        // Update user card color in users list immediately
        if (activeUser?.id && onUserCertificateUpdated) {
          onUserCertificateUpdated(activeUser.id, certificateData);
        }
        
        showToast('სერტიფიკატის მონაცემები შეინახა', 'success');
      } catch {
        showToast('სერტიფიკატის შენახვა ვერ მოხერხდა', 'error');
      }
    }

    async function handleDelete() {
      if (!activeData?.hasCertificate || !activeUser?.id) {
        showToast('სერტიფიკატი ჯერ არ არის შექმნილი', 'info');
        return;
      }
      if (!global.confirm('დარწმუნებული ხართ, რომ გსურთ სერტიფიკატის წაშლა?')) {
        return;
      }
      if (!global.confirm('დარწმუნებული ხართ, რომ გსურთ სერტიფიკატის წაშლა? მისი დაბრუნება ვეღარ მოხდება.')) {
        return;
      }

      try {
        const response = await fetch(`${API_BASE}/users/${activeUser.id}/certificate`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });

        if (!response.ok) {
          await handleAdminErrorResponse(response);
          return;
        }

        const userAfterDelete = {
          ...(activeUser || {}),
          certificate: null,
          certificate_info: null,
          certificate_status: null,
          certificate_valid_until: null,
        };

        if (activeUserRef) {
          activeUserRef.certificate = null;
          activeUserRef.certificate_info = null;
          activeUserRef.certificate_status = null;
          activeUserRef.certificate_valid_until = null;
        }

        activeUser = userAfterDelete;
        activeData = buildCertificateData(userAfterDelete);
        closeForm({ force: true });
        await populateView(activeData);
        updateView();
        if (activeUser?.id && onUserCertificateUpdated) {
          onUserCertificateUpdated(activeUser.id, null);
        }
        showToast('სერტიფიკატი წაიშალა', 'success');
      } catch {
        showToast('სერტიფიკატის წაშლა ვერ მოხერხდა', 'error');
      }
    }

    function getAdminStylesHref() {
      const link = document.querySelector('link[href*="admin.css"]');
      return link ? link.href : null;
    }

    function getCertificateElement() {
      if (!templateContainer) return null;
      return templateContainer.querySelector('.certificate-background');
    }

    function getFontsBaseUrl() {
      const parts = window.location.pathname.split('/').filter(Boolean);
      if (parts.length && parts[parts.length - 1].includes('.')) parts.pop();
      if (parts.length && parts[parts.length - 1] === 'pages') parts.pop();
      const basePath = parts.length ? '/' + parts.join('/') : '';
      return `${window.location.origin}${basePath}/assets/fonts`;
    }

    // Register a Unicode-capable font (DejaVuSans) with jsPDF so Georgian text renders correctly
    async function ensureDejaVuSansRegistered(pdf) {
      if (!pdf) return;
      try {
        // Per-PDF check: if already registered in this document, skip
        const list = typeof pdf.getFontList === 'function' ? pdf.getFontList() : {};
        const has = !!(list && (list.DejaVuSans || list['DejaVuSans']));
        if (has) return;

        const fontUrl = '../assets/fonts/dejavu-sans.ttf';
        const res = await fetch(fontUrl);
        if (!res.ok) return;
        const buffer = await res.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        // Convert to base64 in chunks to avoid call stack limits
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        pdf.addFileToVFS('DejaVuSans.ttf', base64);
        pdf.addFont('DejaVuSans.ttf', 'DejaVuSans', 'normal');
      } catch {}
    }

    // Try to register BPG Nino Mtavruli Bold (TTF). If the TTF is missing, we fall back silently.
    async function ensureBpgNinoRegistered(pdf) {
      if (!pdf) return;
      // Per-PDF check first
      try {
        const list = typeof pdf.getFontList === 'function' ? pdf.getFontList() : {};
        const has = !!(list && (list.BPGNino || list['BPGNino']));
        if (has) return;
      } catch (_) {}

      // Try local first, then CDN fallback
      const fontsBase = getFontsBaseUrl();
      const candidates = [
        `${fontsBase}/bpg_nino_mtavruli_bold.ttf`,
        `${fontsBase}/bpg-nino-mtavruli-bold.ttf`,
        `${fontsBase}/BPGNinoMtavruli-Bold.ttf`,
        `${fontsBase}/BPG Nino Mtavruli Bold.ttf`,
        `${fontsBase}/bpg-nino-mtavruli.ttf`,
        // Public CDN fallback (CORS-enabled)
        'https://cdn.web-fonts.ge/fonts/bpg-nino-mtavruli-bold/bpg-nino-mtavruli-bold.ttf',
      ];
      try {
        let res = null;
        let ok = false;
        let usedUrl = '';
        for (const url of candidates) {
          try {
            res = await fetch(url, { mode: 'cors' });
            if (res.ok) {
              ok = true;
              usedUrl = url;
              break;
            }
          } catch (e) {
            // ignore and try next
          }
        }
        if (!ok || !res) return;
        const buffer = await res.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        let binary = '';
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
        }
        const base64 = btoa(binary);
        pdf.addFileToVFS('BPGNino.ttf', base64);
        // Register as bold to match intended style
        pdf.addFont('BPGNino.ttf', 'BPGNino', 'bold');
      } catch {}
    }


    function findSvg2PdfFunction() {
      if (typeof global.svg2pdf === 'function') return global.svg2pdf;
      if (global.svg2pdf && typeof global.svg2pdf.svg2pdf === 'function') return global.svg2pdf.svg2pdf;
      if (global.jspdf?.jsPDF?.API && typeof global.jspdf.jsPDF.API.svg === 'function') return global.jspdf.jsPDF.API.svg;
      if (typeof window !== 'undefined' && typeof window.svg2pdf === 'function') return window.svg2pdf;
      if (typeof window !== 'undefined' && window.svg2pdf?.svg2pdf) return window.svg2pdf.svg2pdf;
      return null;
    }

    async function waitForScriptToLoad(_src, checkFn, maxWait = 1500) {
      const startTime = Date.now();
      while (Date.now() - startTime < maxWait) {
        if (checkFn()) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return false;
    }

    async function ensureVectorPdfLibrariesLoaded() {
      if (global.jspdf?.jsPDF && findSvg2PdfFunction()) return true;
      // If scripts are present in DOM but not yet initialized, wait briefly
      await waitForScriptToLoad('', () => !!(global.jspdf?.jsPDF && findSvg2PdfFunction()), 1500);
      return !!(global.jspdf?.jsPDF && findSvg2PdfFunction());
    }

    // Upload generated PDF to backend for persistent storage
    async function uploadCertificatePdf(pdf, filename) {
      try {
        if (!activeUser?.id) return false;
        const blob = await pdf.output('blob');
        const form = new FormData();
        form.append('file', blob, filename || 'certificate.pdf');
        const res = await fetch(`${API_BASE}/users/${activeUser.id}/certificate/file`, {
          method: 'POST',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
          body: form,
        });
        if (!res.ok) {
          await handleAdminErrorResponse(res, 'სერვერზე ატვირთვა ვერ მოხერხდა');
          return false;
        }
        return true;
      } catch {
        showToast('სერვერზე ატვირთვა ვერ მოხერხდა', 'error');
        return false;
      }
    }

    async function handleDownload() {
      if (!activeData?.hasCertificate) {
        showToast('სერტიფიკატი ჯერ არ არის შექმნილი', 'error');
        return;
      }
      if (formOpen) {
        showToast('PDF ექსპორტისთვის დახურეთ სერტიფიკატის ფორმა', 'info');
        return;
      }
      if (activeData?.isInactive) {
        showToast('სერტიფიკატი არ არის მოქმედი', 'error');
        return;
      }

      const safeFullNameEarly = (activeData?.fullName || '')
        .trim()
        .replace(/[<>:"/\\|?*]+/g, '')
        .replace(/\s+/g, '_');
      const safeCodeEarly = (activeData?.uniqueCode || '').trim().replace(/[<>:"/\\|?*]+/g, '');
      const filenamePartsEarly = ['certificate'];
      if (safeFullNameEarly) filenamePartsEarly.push(safeFullNameEarly);
      if (safeCodeEarly) filenamePartsEarly.push(safeCodeEarly);
      const earlyFilename = `${filenamePartsEarly.join('_')}.pdf`;
      const prep = await preparePdfSaveHandle(earlyFilename, { showToast });
      if (prep?.aborted) {
        return;
      }
      const saveHandle = prep?.handle || null;

      const libsOk = await ensureVectorPdfLibrariesLoaded();
      if (!libsOk) {
        showToast('PDF ბიბლიოთეკები ვერ ჩაიტვირთა', 'error');
        return;
      }

      const levelKey = resolveLevelKey(activeData.level || activeData.level?.key);
      let svgElement = null;
      try {
        svgElement = await buildCertificateSvgElement(levelKey);
      } catch {
        showToast('სერტიფიკატის SVG ვერ შეიქმნა', 'error');
        return;
      }

      if (!svgElement) {
        showToast('სერტიფიკატის SVG ვერ შეიქმნა', 'error');
        return;
      }

      const jsPdfFactory = global.jspdf?.jsPDF;
      const svg2pdfLib = findSvg2PdfFunction();
      if (!jsPdfFactory || !svg2pdfLib) {
        showToast('PDF ბიბლიოთეკები ვერ ჩაიტვირთა', 'error');
        return;
      }

      const previousDisabled = downloadBtn?.disabled ?? false;
      const previousLabel = downloadBtn?.textContent ?? downloadBtnDefaultLabel;
      if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.textContent = 'მუშავდება...';
      }

      const svgSandbox = document.createElement('div');
      svgSandbox.style.position = 'fixed';
      svgSandbox.style.left = '-10000px';
      svgSandbox.style.top = '-10000px';
      svgSandbox.style.width = `${BASE_CERTIFICATE_WIDTH}px`;
      svgSandbox.style.height = `${BASE_CERTIFICATE_HEIGHT}px`;
      svgSandbox.style.opacity = '0';
      svgSandbox.style.pointerEvents = 'none';
      svgSandbox.setAttribute('aria-hidden', 'true');
      svgSandbox.className = 'certificate-svg-export';
      svgSandbox.appendChild(svgElement);
      document.body.appendChild(svgSandbox);

      try {
        const pdf = new jsPdfFactory('l', 'pt', [BASE_CERTIFICATE_WIDTH, BASE_CERTIFICATE_HEIGHT]);
        // Ensure DejaVu Sans is available in jsPDF before rendering
        await ensureDejaVuSansRegistered(pdf);
        // Register BPG Nino (required for fullName). If missing, DejaVuSans will be used (but requirement is BPGNino).
        await ensureBpgNinoRegistered(pdf);
        
        // svg2pdf can be called directly or via jsPDF.API.svg
        if (typeof svg2pdfLib === 'function') {
          await Promise.resolve(svg2pdfLib(svgElement, pdf, {
            x: 0,
            y: 0,
            width: BASE_CERTIFICATE_WIDTH,
            height: BASE_CERTIFICATE_HEIGHT,
          }));
        } else if (global.jspdf && global.jspdf.jsPDF && global.jspdf.jsPDF.API && typeof global.jspdf.jsPDF.API.svg === 'function') {
          await Promise.resolve(global.jspdf.jsPDF.API.svg(svgElement, pdf, {
            x: 0,
            y: 0,
            width: BASE_CERTIFICATE_WIDTH,
            height: BASE_CERTIFICATE_HEIGHT,
          }));
        } else {
          throw new Error('svg2pdf function not available');
        }

        const safeFullName = (activeData.fullName || '')
          .trim()
          .replace(/[<>:"/\\|?*]+/g, '')
          .replace(/\s+/g, '_');
        const safeCode = (activeData.uniqueCode || '').trim().replace(/[<>:"/\\|?*]+/g, '');
        const filenameParts = ['certificate'];
        if (safeFullName) filenameParts.push(safeFullName);
        if (safeCode) filenameParts.push(safeCode);
        const filename = `${filenameParts.join('_')}.pdf`;

        // Upload to server (replace existing), then offer local save
        await uploadCertificatePdf(pdf, filename);
        await deliverPdf(pdf, filename, { showToast, handle: saveHandle });
      } catch {
        showToast('PDF ფაილის შექმნა ვერ მოხერხდა', 'error');
      } finally {
        if (svgSandbox?.parentNode) {
          svgSandbox.parentNode.removeChild(svgSandbox);
        }
        if (downloadBtn) {
          downloadBtn.disabled = previousDisabled;
          downloadBtn.textContent = previousLabel || downloadBtnDefaultLabel;
        }
      }
    }

    function resetState() {
      activeUserRef = null;
      activeUser = null;
      activeData = null;
      formMode = 'create';
      formOpen = false;
      resetForm();
    }

    function handleClose() {
      if (!overlay) return;
      if (formOpen) {
        const confirmed = global.confirm('დახურვის შემთხვევაში ცვლილებები არ შეინახება. გსურთ გაგრძელება?');
        if (!confirmed) return;
        closeForm({ force: true });
      }
      if (typeof datePicker?.close === 'function') {
        datePicker.close();
      }
      resetState();
      closeOverlay(overlay);
    }

    function handleBackdrop() {
      // ფონზე დაკლიკვა არაფერს აკეთებს — დახურვა მხოლოდ X-ით ან Escape-ით.
    }

    function handleKeydown(event) {
      if (event.key === 'Escape' && overlay?.classList.contains('open')) {
        if (!formOpen) {
          handleClose();
          return;
        }
        if (global.confirm('დახურვის შემთხვევაში ცვლილებები არ შეინახება. გსურთ გაგრძელება?')) {
          handleClose();
        }
      }
    }

    async function open(user) {
      if (!ensureOverlay()) return;
      activeUserRef = user || null;
      activeUser = user ? { ...user } : null;
      
      // Try to load certificate from backend
      let certificateData = null;
      if (user?.id) {
        try {
          const response = await fetch(`${API_BASE}/users/${user.id}/certificate`, {
            headers: { ...getAdminHeaders(), ...getActorHeaders() },
          });
          if (response.ok) {
            certificateData = await response.json();
          } else if (response.status !== 404) {
            await handleAdminErrorResponse(response);
          }
        } catch {
          showToast('სერტიფიკატის ჩატვირთვა ვერ მოხერხდა', 'error');
        }
      }
      
      const userWithCert = certificateData
        ? {
            ...user,
            certificate: certificateData,
            certificate_info: {
              unique_code: certificateData.unique_code,
              level: certificateData.level,
              status: certificateData.status,
              issue_date: certificateData.issue_date,
              validity_term: certificateData.validity_term,
              valid_until: certificateData.valid_until,
            },
            certificate_status: certificateData.status,
            certificate_valid_until: certificateData.valid_until,
          }
        : user;
      
      activeData = buildCertificateData(userWithCert || {});
      formOpen = false;
      formMode = activeData?.hasCertificate ? 'update' : 'create';
      resetForm();
      await populateView(activeData);
      updateView();
      openOverlay(overlay);
      // Fit after content is populated by populateView
    }

    function init() {
      if (!ensureOverlay()) return;
      closeBtn?.addEventListener('click', handleClose);
      overlay?.addEventListener('click', handleBackdrop);
      document.addEventListener('keydown', handleKeydown);
      emptyCreateBtn?.addEventListener('click', handleEmptyCreateClick);
      deleteBtn?.addEventListener('click', handleDelete);
      editBtn?.addEventListener('click', handleEditClick);
      formSubmitBtn?.addEventListener('click', handleFormSubmit);
      formFields.issueDate?.addEventListener('change', () => updateAutoValidity());
      formFields.validityTerm?.addEventListener('input', () => updateAutoValidity());
      downloadBtn?.addEventListener('click', handleDownload);
      attachIssueDatePicker();
      
      // Load template when level changes in form
      formFields.level?.addEventListener('change', async (event) => {
        const level = event.target.value;
      // Update activeData level and re-render; populateView will load correct template
      if (activeData) {
        const normalized = normalizeLevel(level);
        activeData.level = normalized;
      }
        await populateView(activeData);
      });
      
      // Initial field nodes update
      updateFieldNodes();

      // Refit certificate on resize
      window.addEventListener('resize', () => {
        fitCertificateToContainer();
      });
    }

    function close() {
      handleClose();
    }

    return {
      init,
      open,
      close,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createCertificateModule = createCertificateModule;
})(window);


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
      isFounderActor = () => true,
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
    const transitionalBox = DOM.certificateTransitionalBox || overlay?.querySelector('#certificateTransitionalBox');
    const transitionalDeadlineInput = DOM.certificateTransitionalDeadlineInput || overlay?.querySelector('#certificateTransitionalDeadlineInput');
    const transitionalDeadlineSaveBtn = DOM.certificateTransitionalDeadlineSave || overlay?.querySelector('#certificateTransitionalDeadlineSave');
    const notifyEditor = DOM.certificateFormNotifyEditor || overlay?.querySelector('#certificateFormNotifyEditor');
    const notifyEditBtn = DOM.certificateFormNotifyEditBtn || overlay?.querySelector('#certificateFormNotifyEditBtn');
    const notifyResetBtn = DOM.certificateFormNotifyReset || overlay?.querySelector('#certificateFormNotifyReset');
    const notifySaveTemplateBtn = DOM.certificateFormNotifySaveTemplate || overlay?.querySelector('#certificateFormNotifySaveTemplate');
    const notifySubjectInput = DOM.certificateFormNotifySubject || overlay?.querySelector('#certificateFormNotifySubject');
    const notifyBodyInput = DOM.certificateFormNotifyBody || overlay?.querySelector('#certificateFormNotifyBody');

    const DEFAULT_CERT_ISSUED_SUBJECT = 'სერტიფიკატის გაცემა და საჯარო რეესტრში ასახვა';
    const DEFAULT_CERT_ISSUED_BODY = [
      'ადრესატი: {name}',
      '',
      'მოგესალმებით,',
      '',
      'გილოცავთ! თქვენზე გაიცა სერტიფიკატი.',
      '',
      'თქვენი სერტიფიკატი უკვე აისახა საიტზე gipc.org.ge-ზე არსებულ სერტიფიცირებულ პირთა საჯარო რეესტრში, ხოლო ელექტრონული სერტიფიკატი (PDF) ხელმისაწვდომია და შეგიძლიათ ჩამოტვირთოთ საიტზე თქვენს პირად გვერდზე („ჩემი გვერდი“).',
      '',
      'პატივისცემით,',
      'საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი',
    ].join('\n');

    let certIssuedTemplate = {
      subject: DEFAULT_CERT_ISSUED_SUBJECT,
      body: DEFAULT_CERT_ISSUED_BODY,
      updated_at: null,
    };
    let certIssuedTemplateLoaded = false;
    let notifyEditorOpen = false;
    let notifyManuallyEdited = false;

    const DEFAULT_TRANSITIONAL_DEADLINE_ISO = '2029-01-01';
    let globalTransitionalDeadlineIso = DEFAULT_TRANSITIONAL_DEADLINE_ISO;
    let globalTransitionalDeadlineLoaded = false;
    let savingTransitionalDeadline = false;

    function isTransitionalEligibleLevel(rawLevel) {
      const key = resolveLevelKey(rawLevel);
      return key === 'architect' || key === 'municipal';
    }

    const formFields = {
      uniqueCode: DOM.certificateFormCode,
      level: DOM.certificateFormLevel,
      status: DOM.certificateFormStatus,
      issueDate: DOM.certificateFormIssueDate,
      validityTerm: DOM.certificateFormValidityTerm,
      validUntil: DOM.certificateFormValidUntil,
      sendNotification: DOM.certificateFormSendNotification || overlay?.querySelector('#certificateFormSendNotification'),
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
    // Shared preview/export placement, measured from the approved landscape-A4 design.
    // The white quiet zone is included in this physical 30 mm square.
    const QR_SIZE = BASE_CERTIFICATE_WIDTH * 30 / 297;
    // Colored panel's straight SVG edges are identical in all three templates.
    const QR_CENTER_X = (783.628 + 1019.13) / 2;
    const QR_X = QR_CENTER_X - QR_SIZE / 2;
    const QR_Y = BASE_CERTIFICATE_HEIGHT * 0.345 - QR_SIZE / 2;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const CERTIFICATE_BACKGROUND_FILES = {
      architect: 'architect bac.svg',
      expert: 'expert bac.svg',
      municipal: 'municip bac.svg',
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
      if (levelKey === 'municipal') return CERTIFICATE_BACKGROUND_FILES.municipal;
      return CERTIFICATE_BACKGROUND_FILES.architect;
    }

    async function loadBackgroundSvgString(levelKey) {
      const normalized = levelKey === 'expert' ? 'expert' : (levelKey === 'municipal' ? 'municipal' : 'architect');
      const svgVersion = '20260410b';
      const cacheKey = `${normalized}_${svgVersion}`;
      if (backgroundSvgCache.has(cacheKey)) {
        return backgroundSvgCache.get(cacheKey);
      }
      const fileName = getBackgroundFileName(normalized);
      try {
        const cacheBuster = `${svgVersion}_${Date.now()}`;
        const response = await fetch(`../certificate/${fileName}?v=${cacheBuster}`);
        if (!response.ok) return null;
        const text = await response.text();
        backgroundSvgCache.set(cacheKey, text);
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
      'owner-3': { left: 10.33, top: 34.3, width: 58.24, height: 3.40 },
      'personal-number-1': { left: 12.33, top: 37.7, width: 10.42, height: 2.36 },
      'personal-number-2': { left: 12.33, top: 37.7, width: 10.42, height: 2.36 },
      'personal-number-3': { left: 12.33, top: 37.7, width: 10.42, height: 2.36 },
      'identification-code-1': { left: 74.0, top: 88, width: 11.27, height: 2.52 },
      'identification-code-2': { left: 74.0, top: 88, width: 11.27, height: 2.52 },
      'identification-code-3': { left: 74.0, top: 88, width: 11.27, height: 2.52 },
      'issue-date-1': { left: 11, top: 69, width: 7.57, height: 2.14 },
      'issue-date-2': { left: 11, top: 69, width: 7.57, height: 2.14 },
      'issue-date-3': { left: 11, top: 69, width: 7.57, height: 2.14 },
      'validity-period-1': { left: 34.10, top: 73.16, width: 3.65, height: 2.02 },
      'validity-period-2': { left: 34.10, top: 73.16, width: 3.65, height: 2.02 },
      'validity-period-3': { left: 34.10, top: 73.16, width: 3.65, height: 2.02 },
      'expiry-date-1': { left: 11, top: 77.20, width: 7.57, height: 2.14 },
      'expiry-date-2': { left: 11, top: 77.20, width: 7.57, height: 2.14 },
      'expiry-date-3': { left: 11, top: 77.20, width: 7.57, height: 2.14 },
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
      const suffix = levelKey === 'expert' ? '2' : (levelKey === 'municipal' ? '3' : '1');
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

        const backgroundNode = await buildBackgroundNode(levelKey);
        if (!backgroundNode) throw new Error('Certificate background unavailable');
        svgEl.appendChild(backgroundNode);

        const fieldNodesList = clone.querySelectorAll('[data-field]');
        fieldNodesList.forEach((fieldNode) => {
          const textNode = createSvgTextNodeFromField(fieldNode, baseRect, levelKey);
          if (textNode) svgEl.appendChild(textNode);
        });

        const qr = clone.querySelector('.certificate-qr');
        if (!qr) throw new Error('Certificate QR unavailable');
        const exportedQr = qr.cloneNode(true);
        exportedQr.removeAttribute('style');
        exportedQr.setAttribute('x', String(QR_X));
        exportedQr.setAttribute('y', String(QR_Y));
        exportedQr.setAttribute('width', String(QR_SIZE));
        exportedQr.setAttribute('height', String(QR_SIZE));
        svgEl.appendChild(exportedQr);

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
      ['municipal', { key: 'municipal', label: 'პროექტის შემსწავლელი სპეციალისტი' }],
      ['არქიტექტორი', { key: 'architect', label: 'შენობა-ნაგებობის არქიტექტორი' }],
      ['არქიტექტორი ექსპერტი', { key: 'expert', label: 'არქიტექტურული პროექტის ექსპერტი' }],
      ['შენობა-ნაგებობის არქიტექტორი', { key: 'architect', label: 'შენობა-ნაგებობის არქიტექტორი' }],
      ['არქიტექტურული პროექტის ექსპერტი', { key: 'expert', label: 'არქიტექტურული პროექტის ექსპერტი' }],
      ['პროექტის შემსწავლელი სპეციალისტი', { key: 'municipal', label: 'პროექტის შემსწავლელი სპეციალისტი' }],
    ]);

    function resolveLevelKey(raw) {
      if (!raw) return 'architect';
      if (typeof raw === 'object') {
        if (raw.key === 'expert') return 'expert';
        if (raw.key === 'municipal') return 'municipal';
        return 'architect';
      }
      const s = String(raw).trim().toLowerCase();
      if (s === 'expert' || s === 'architect_expert' || s === 'არქიტექტორი ექსპერტი' || s === 'არქიტექტურული პროექტის ექსპერტი') {
        return 'expert';
      }
      if (s === 'municipal' || s === 'პროექტის შემსწავლელი სპეციალისტი') {
        return 'municipal';
      }
      return 'architect';
    }

    const TIER_CLASSES = {
      architect: 'certificate-card--architect',
      expert: 'certificate-card--expert',
      municipal: 'certificate-card--municipal',
    };

    let activeUserRef = null;
    let activeUser = null;
    let activeData = null;
    let exportBusy = false;
    let previewReady = false;
    let renderRevision = 0;
    let openRevision = 0;
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
        // 1) Explicit DD/MM/YYYY or DD.MM.YYYY or DD-MM-YYYY (must check BEFORE new Date(str) which assumes US MM/DD/YYYY)
        const dmyMatch = normalized.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
        if (dmyMatch) {
          const day = parseInt(dmyMatch[1], 10);
          const month = parseInt(dmyMatch[2], 10);
          const year = parseInt(dmyMatch[3], 10);
          if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2200) {
            const candidate = new Date(year, month - 1, day);
            if (
              candidate.getFullYear() === year &&
              candidate.getMonth() === month - 1 &&
              candidate.getDate() === day
            ) {
              return candidate;
            }
          }
          return null;
        }
        // 2) Explicit YYYY-MM-DD (with optional time suffix) parsed as local calendar date
        const ymdMatch = normalized.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[T\s].*)?$/);
        if (ymdMatch) {
          const year = parseInt(ymdMatch[1], 10);
          const month = parseInt(ymdMatch[2], 10);
          const day = parseInt(ymdMatch[3], 10);
          if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 1900 && year <= 2200) {
            const candidate = new Date(year, month - 1, day);
            if (
              candidate.getFullYear() === year &&
              candidate.getMonth() === month - 1 &&
              candidate.getDate() === day
            ) {
              return candidate;
            }
          }
          return null;
        }
        const fromString = new Date(normalized);
        if (!Number.isNaN(fromString.getTime())) return fromString;
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
        for (let y = nowY + 15; y >= nowY - 60; y--) {
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
      [formFields.issueDate, transitionalDeadlineInput].filter(Boolean).forEach((input) => {
        input.addEventListener('focus', () => datePicker.open(input, input.value));
        input.addEventListener('click', () => datePicker.open(input, input.value));
        input.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); datePicker.open(input, input.value); }
          if (e.key === 'Escape') { datePicker.close(); }
        });
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

    function isFiveYearTermStillActive(validUntilValue) {
      const expiration = parseDate(validUntilValue);
      if (!expiration) return true;
      const now = new Date();
      const expirationMoment = new Date(expiration);
      expirationMoment.setHours(23, 59, 59, 999);
      return expirationMoment.getTime() >= now.getTime();
    }

    function isTransitionalDeadlineReached(deadlineValue) {
      const deadline = parseDate(deadlineValue || globalTransitionalDeadlineIso);
      if (!deadline) return false;
      const now = new Date();
      const deadlineStart = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate(), 0, 0, 0, 0);
      return now.getTime() >= deadlineStart.getTime();
    }

    function normalizeStatus(rawStatus, validUntilDate, options = {}) {
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

      if (options.isTransitional && normalized.key !== 'suspended') {
        if (isTransitionalDeadlineReached(options.transitionalDeadline || globalTransitionalDeadlineIso)) {
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

    function candidateCategoryToLevelKey(cat) {
      const normalized = String(cat || '').trim().toUpperCase();
      if (normalized === 'B' || normalized === 'B_A') return 'municipal';
      if (normalized === 'C' || normalized === 'C_A') return 'expert';
      if (normalized === 'A') return 'architect';
      return '';
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

      const candidateSuggestedLevel = !hasCertificate
        ? candidateCategoryToLevelKey(user?.candidate_category || user?.requested_category)
        : '';
      const rawLevel =
        certificate.level || certificate.rank || user?.certificate_level || user?.level || candidateSuggestedLevel;
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

      const isTransitional =
        !!(certificate.is_transitional ?? certificate.isTransitional) &&
        isTransitionalEligibleLevel(level.key);
      if (certificate.transitional_deadline) {
        globalTransitionalDeadlineIso = String(certificate.transitional_deadline).trim() || DEFAULT_TRANSITIONAL_DEADLINE_ISO;
        globalTransitionalDeadlineLoaded = true;
      }

      const status = normalizeStatus(
        certificate.status || certificate.state || user?.certificate_status,
        validUntilDate,
        { isTransitional, transitionalDeadline: globalTransitionalDeadlineIso }
      );
      const termNumber = parseNumber(validityTermRaw);
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
        isTransitional,
        transitionalDeadline: formatDate(globalTransitionalDeadlineIso) || '01/01/2029',
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

    async function loadCertificateTemplate(level, revision) {
      if (!templateContainer) return false;
      
      const levelKey = level === 'expert' ? 'expert' : (level === 'municipal' ? 'municipal' : 'architect');
      const templatePath = `../certificate/${levelKey}.html`;
      const cssPath = `../certificate/${levelKey}.css`;
      const themeVersion = '20260410b';
      
      try {
        const response = await fetch(templatePath);
        if (!response.ok) return false;
        const html = await response.text();
        if (revision !== renderRevision) return false;
        // Wrap template with a scale wrapper so transform scaling preserves layout centering
        templateContainer.innerHTML = `<div class="certificate-scale-wrapper">${html}</div>`;
        
        // Update field nodes after loading template
        updateFieldNodes();

        // Apply corresponding theme stylesheet (last in head to win CSS cascade)
        const link = ensureThemeStyles();
        const cacheBuster = `${themeVersion}_${Date.now()}`;
        const versionedCssPath = `${cssPath}?v=${cacheBuster}`;
        const loaded = await new Promise((resolve) => {
          const timeout = setTimeout(() => finish(false), 8000);
          function finish(ok) {
            clearTimeout(timeout);
            link.removeEventListener('load', onLoad);
            link.removeEventListener('error', onError);
            resolve(ok);
          }
          const onLoad = () => finish(true);
          const onError = () => finish(false);
          link.addEventListener('load', onLoad);
          link.addEventListener('error', onError);
          link.setAttribute('href', versionedCssPath);
        });
        return loaded && revision === renderRevision;
      } catch { return false; }
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
      const revision = ++renderRevision;
      const person = activeUser ? { ...activeUser } : null;
      previewReady = false;
      if (downloadBtn) downloadBtn.disabled = true;
      applyCardStyling(data);
      
      // Load certificate template based on level
      const levelKey = resolveLevelKey(data.level || data.level?.key);
      const loaded = await loadCertificateTemplate(levelKey, revision);
      if (revision !== renderRevision) return;
      if (!loaded) {
        if (templateContainer) templateContainer.innerHTML = '';
        showToast('სერტიფიკატის შაბლონი ვერ ჩაიტვირთა. გახსენით ხელახლა.', 'error');
        return;
      }
      
      // Wait next frame for DOM render
      await nextAnimationFrame();
      if (revision !== renderRevision) return;
      
      // Fit after DOM update
      fitCertificateToContainer();
      
      setField('uniqueCode', data.uniqueCode || '—');
      setField('fullName', data.fullName || buildFullName(person) || '—');
      setField('personalId', person?.personal_id || '—');
      setField('issueDate', data.hasCertificate ? data.issueDate || '—' : '—');
      setField('validityTerm', data.hasCertificate ? data.validityTerm || '—' : '—');
      setField('validUntil', data.hasCertificate ? data.validUntil || '—' : '—');
      renderStatus(data);
      if (data.hasCertificate) {
        try {
          const qr = global.CertificateQR.createSvg(person.code);
          qr.setAttribute('class', 'certificate-qr');
          qr.style.position = 'absolute';
          qr.style.left = `${QR_X}px`;
          qr.style.top = `${QR_Y}px`;
          qr.style.width = `${QR_SIZE}px`;
          qr.style.height = `${QR_SIZE}px`;
          qr.style.display = 'block';
          getCertificateElement().appendChild(qr);
          previewReady = true;
        } catch {
          showToast('QR კოდი ვერ შეიქმნა. განაახლეთ გვერდი და სცადეთ ხელახლა.', 'error');
        }
      }
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

    function formatDashDate(raw) {
      if (!raw) return '—';
      const parsed = parseDate(raw);
      if (!parsed) return String(raw).replace(/\//g, '-');
      const d = String(parsed.getDate()).padStart(2, '0');
      const m = String(parsed.getMonth() + 1).padStart(2, '0');
      const y = parsed.getFullYear();
      return `${d}-${m}-${y}`;
    }

    function buildCurrentNotifyTokens() {
      const fullName = buildFullName(activeUser) || activeData?.fullName || '—';
      const personalId = String(activeUser?.personal_id || '—').trim();
      const code = (formFields.uniqueCode?.value || activeData?.uniqueCode || activeUser?.code || '—').trim();
      const levelVal = formFields.level?.value || activeData?.level?.key || 'architect';
      const qualLabel = normalizeLevel(levelVal).label || 'შენობა-ნაგებობის არქიტექტორი';
      const statusVal = formFields.status?.value || activeData?.status?.key || 'active';
      const statusMap = { active: 'მოქმედი', suspended: 'შეჩერებული', expired: 'ვადაგასული' };
      const statusLabel = statusMap[statusVal] || 'მოქმედი';
      const issueDateStr = formatDashDate(formFields.issueDate?.value || activeData?.issueDate);
      const validUntilStr = formatDashDate(formFields.validUntil?.value || validUntilDisplayNode?.textContent || activeData?.validUntil);
      return {
        name: fullName,
        personal_id: personalId,
        code,
        qualification: qualLabel,
        status: statusLabel,
        issue_date: issueDateStr,
        valid_until: validUntilStr,
        date: issueDateStr,
      };
    }

    function applyNotifyTokens(templateStr, tokens) {
      let out = String(templateStr || '');
      Object.entries(tokens).forEach(([k, v]) => {
        out = out.split(`{${k}}`).join(v ?? '—');
      });
      return out;
    }

    function updateNotifyEditorVisibility() {
      if (notifyEditor) {
        notifyEditor.classList.toggle('hidden', !notifyEditorOpen);
      }
      if (notifyEditBtn) {
        notifyEditBtn.textContent = notifyEditorOpen
          ? 'შეტყობინების ტექსტის დამალვა'
          : 'შეტყობინების ტექსტის რედაქტირება';
      }
    }

    function renderNotifyFields({ force = false } = {}) {
      if (!force && notifyManuallyEdited) return;
      const tokens = buildCurrentNotifyTokens();
      if (notifySubjectInput) {
        notifySubjectInput.value = applyNotifyTokens(certIssuedTemplate.subject || DEFAULT_CERT_ISSUED_SUBJECT, tokens);
      }
      if (notifyBodyInput) {
        notifyBodyInput.value = applyNotifyTokens(certIssuedTemplate.body || DEFAULT_CERT_ISSUED_BODY, tokens);
      }
      if (force) {
        notifyManuallyEdited = false;
      }
    }

    async function loadCertIssuedTemplate() {
      if (certIssuedTemplateLoaded) return;
      try {
        const res = await fetch(`${API_BASE}/admin/planning-templates`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data?.cert_issued_template) {
            const rawSubject = String(data.cert_issued_template.subject || '').trim();
            const rawBody = String(data.cert_issued_template.body || '').trim();
            const normBody = rawBody.replace(/\s+/g, ' ');
            const legacyCertIssuedBody = (
              'ბატონო/ქალბატონო {name},\n' +
              'გაცნობებთ, რომ თქვენზე გაიცა შესაბამისობის სერტიფიკატი და მონაცემები აისახა ინსტიტუტის სერტიფიცირებულ პირთა საჯარო რეესტრში.\n\n' +
              '• სერტიფიკატის ნომერი: {code}\n' +
              '• სერტიფიცირების კატეგორია: {qualification}\n' +
              '• გაცემის თარიღი: {issue_date}\n' +
              '• მოქმედების ბოლო თარიღი: {valid_until}\n' +
              '• საჯარო რეესტრის ბმული: https://gipc.org.ge\n\n' +
              'შეტყობინებას თან ერთვის ელექტრონული სერტიფიკატი (PDF). სერტიფიკატისა და სერტიფიცირების სტატუსის გამოყენება დასაშვებია მხოლოდ მინიჭებული კატეგორიის, მოქმედების ვადისა და სასერტიფიკაციო ხელშეკრულებით განსაზღვრული პირობების ფარგლებში (GIPC-PRO-006).\n\n' +
              'პატივისცემით,\n' +
              'შპს „საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი“'
            ).replace(/\s+/g, ' ');
            const isLegacyBody = !normBody || normBody === legacyCertIssuedBody;
            certIssuedTemplate = {
              subject: rawSubject || DEFAULT_CERT_ISSUED_SUBJECT,
              body: isLegacyBody ? DEFAULT_CERT_ISSUED_BODY : rawBody,
              updated_at: data.cert_issued_template.updated_at || null,
            };
            certIssuedTemplateLoaded = true;
            if (formOpen && !notifyManuallyEdited) {
              renderNotifyFields({ force: true });
            }
          }
        }
      } catch {}
    }

    function toggleNotifyEditor() {
      notifyEditorOpen = !notifyEditorOpen;
      if (notifyEditorOpen && !notifyManuallyEdited) {
        renderNotifyFields({ force: false });
      }
      updateNotifyEditorVisibility();
      if (notifyEditorOpen) {
        requestAnimationFrame(() => {
          notifyBodyInput?.focus?.();
        });
      }
    }

    function handleNotifyReset() {
      certIssuedTemplate = {
        ...certIssuedTemplate,
        subject: DEFAULT_CERT_ISSUED_SUBJECT,
        body: DEFAULT_CERT_ISSUED_BODY,
      };
      renderNotifyFields({ force: true });
      showToast('დაბრუნდა სტანდარტული ტექსტი', 'info');
    }

    function convertCandidateValuesToPlaceholders(text, tokens) {
      let result = String(text || '');
      const pairs = [
        [tokens.name, '{name}'],
        [tokens.personal_id, '{personal_id}'],
        [tokens.code, '{code}'],
        [tokens.qualification, '{qualification}'],
        [tokens.issue_date, '{issue_date}'],
        [tokens.valid_until, '{valid_until}'],
      ];
      pairs.forEach(([val, token]) => {
        const v = String(val || '').trim();
        if (v && v !== '—' && v.length >= 2) {
          result = result.split(v).join(token);
        }
      });
      return result;
    }

    async function handleNotifySaveTemplate() {
      const subj = (notifySubjectInput?.value || '').trim();
      const body = (notifyBodyInput?.value || '').trim();
      if (!subj || !body) {
        showToast('გთხოვთ შეავსოთ წერილის სათაური და ტექსტი', 'error');
        return;
      }
      const tokens = buildCurrentNotifyTokens();
      const tokenizedSubject = convertCandidateValuesToPlaceholders(subj, tokens);
      const tokenizedBody = convertCandidateValuesToPlaceholders(body, tokens);

      if (notifySaveTemplateBtn) notifySaveTemplateBtn.disabled = true;
      try {
        const formData = new FormData();
        formData.append('subject', tokenizedSubject);
        formData.append('body', tokenizedBody);
        const res = await fetch(`${API_BASE}/admin/planning-templates/cert_issued`, {
          method: 'PUT',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
          body: formData,
        });
        if (!res.ok) {
          await handleAdminErrorResponse(res);
          return;
        }
        const saved = await res.json();
        certIssuedTemplate = {
          subject: saved.subject || tokenizedSubject,
          body: saved.body || tokenizedBody,
          updated_at: saved.updated_at || null,
        };
        certIssuedTemplateLoaded = true;
        showToast('შეტყობინების შაბლონი შეინახა', 'success');
      } catch {
        showToast('შაბლონის შენახვა ვერ მოხერხდა', 'error');
      } finally {
        if (notifySaveTemplateBtn) notifySaveTemplateBtn.disabled = false;
      }
    }

    async function loadTransitionalDeadline({ force = false } = {}) {
      if (globalTransitionalDeadlineLoaded && !force) {
        if (transitionalDeadlineInput && document.activeElement !== transitionalDeadlineInput) {
          transitionalDeadlineInput.value = formatDate(globalTransitionalDeadlineIso) || '01/01/2029';
        }
        return globalTransitionalDeadlineIso;
      }
      try {
        const res = await fetch(`${API_BASE}/admin/certificate-transitional-deadline`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data?.transitional_deadline) {
            globalTransitionalDeadlineIso = String(data.transitional_deadline).trim() || DEFAULT_TRANSITIONAL_DEADLINE_ISO;
            globalTransitionalDeadlineLoaded = true;
            if (transitionalDeadlineInput && document.activeElement !== transitionalDeadlineInput) {
              transitionalDeadlineInput.value = formatDate(globalTransitionalDeadlineIso) || '01/01/2029';
            }
          }
        }
      } catch {}
      return globalTransitionalDeadlineIso;
    }

    function syncTransitionalBoxVisibility() {
      const levelVal = formFields.level?.value || activeData?.level?.key || 'architect';
      const isTrans =
        formOpen &&
        formFields.validityTerm?.value === 'transitional' &&
        isTransitionalEligibleLevel(levelVal);
      if (transitionalBox) {
        transitionalBox.classList.toggle('hidden', !isTrans);
      }
    }

    function syncValidityTermOptionsForLevel(levelValue) {
      const eligible = isTransitionalEligibleLevel(levelValue);
      const transOption = formFields.validityTerm?.querySelector('option[value="transitional"]');
      if (transOption) {
        transOption.disabled = !eligible;
        transOption.hidden = !eligible;
      }
      if (!eligible && formFields.validityTerm && formFields.validityTerm.value === 'transitional') {
        formFields.validityTerm.value = '5';
        if (formFields.status && formFields.status.value === 'expired') {
          const validUntilCandidate = formFields.validUntil?.value || activeData?.rawValidUntil;
          if (isFiveYearTermStillActive(validUntilCandidate)) {
            formFields.status.value = 'active';
          }
        }
      }
      syncTransitionalBoxVisibility();
    }

    async function saveTransitionalDeadlineInternal(newIsoDate, { silentToast = false } = {}) {
      if (!newIsoDate || savingTransitionalDeadline) return null;
      savingTransitionalDeadline = true;
      if (transitionalDeadlineSaveBtn) transitionalDeadlineSaveBtn.disabled = true;
      try {
        const res = await fetch(`${API_BASE}/admin/certificate-transitional-deadline`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({ transitional_deadline: newIsoDate }),
        });
        if (!res.ok) {
          await handleAdminErrorResponse(res, 'გამონაკლისის ვადის განახლება ვერ მოხერხდა');
          return null;
        }
        const saved = await res.json();
        globalTransitionalDeadlineIso = String(saved.transitional_deadline || newIsoDate).trim() || DEFAULT_TRANSITIONAL_DEADLINE_ISO;
        globalTransitionalDeadlineLoaded = true;
        const formattedDeadline = formatDate(globalTransitionalDeadlineIso) || '01/01/2029';
        if (transitionalDeadlineInput) {
          transitionalDeadlineInput.value = formattedDeadline;
        }

        // Update current certificate status in form & card if applicable
        const validUntilRef = formFields.validUntil?.value || activeData?.rawValidUntil || activeData?.validUntil;
        const deadlineReached = isTransitionalDeadlineReached(globalTransitionalDeadlineIso);
        const fiveYearActive = isFiveYearTermStillActive(validUntilRef);

        if (formOpen && formFields.validityTerm?.value === 'transitional' && formFields.status) {
          if ((!fiveYearActive || deadlineReached) && formFields.status.value === 'active') {
            formFields.status.value = 'expired';
          } else if (!deadlineReached && fiveYearActive && formFields.status.value === 'expired') {
            formFields.status.value = 'active';
          }
          renderNotifyFields({ force: false });
        }

        if (activeData && activeData.hasCertificate && activeData.isTransitional && activeData.status?.key !== 'suspended') {
          const nextStatusKey = (!deadlineReached && fiveYearActive) ? 'active' : 'expired';
          const nextStatusObj = STATUS_MAP.get(nextStatusKey) || activeData.status;
          activeData.status = nextStatusObj;
          activeData.isInactive = nextStatusObj.key === 'suspended' || nextStatusObj.key === 'expired';
          activeData.transitionalDeadline = formattedDeadline;
          if (activeUserRef?.certificate) {
            activeUserRef.certificate.status = nextStatusObj.key;
            activeUserRef.certificate.transitional_deadline = globalTransitionalDeadlineIso;
          }
          if (activeUserRef?.certificate_info) {
            activeUserRef.certificate_info.status = nextStatusObj.key;
            activeUserRef.certificate_info.transitional_deadline = globalTransitionalDeadlineIso;
          }
          if (activeUser?.certificate) {
            activeUser.certificate.status = nextStatusObj.key;
            activeUser.certificate.transitional_deadline = globalTransitionalDeadlineIso;
          }
          if (activeUser?.certificate_info) {
            activeUser.certificate_info.status = nextStatusObj.key;
            activeUser.certificate_info.transitional_deadline = globalTransitionalDeadlineIso;
          }
          if (activeUser) {
            activeUser.certificate_status = nextStatusObj.key;
          }
          applyCardStyling(activeData);
          renderStatus(activeData);
          updateView();
        }

        if (onUserCertificateUpdated) {
          onUserCertificateUpdated(
            activeUser?.id || null,
            activeUserRef?.certificate || null
          );
        }

        if (!silentToast) {
          const reactivated = Number(saved.reactivated_count || 0);
          const expired = Number(saved.expired_count || 0);
          if (reactivated > 0) {
            showToast(`გამონაკლისის ვადა განახლდა (${formattedDeadline}). მოქმედ სტატუსზე დაბრუნდა ${reactivated} სერტიფიკატი.`, 'success');
          } else if (expired > 0) {
            showToast(`გამონაკლისის ვადა განახლდა (${formattedDeadline}). ვადაგასულ სტატუსზე გადავიდა ${expired} სერტიფიკატი.`, 'info');
          } else {
            showToast(`გამონაკლისის ვადა განახლდა: ${formattedDeadline}`, 'success');
          }
        }
        return saved;
      } catch {
        if (!silentToast) {
          showToast('გამონაკლისის ვადის განახლება ვერ მოხერხდა', 'error');
        }
        return null;
      } finally {
        savingTransitionalDeadline = false;
        if (transitionalDeadlineSaveBtn) transitionalDeadlineSaveBtn.disabled = false;
      }
    }

    async function handleSaveTransitionalDeadline() {
      const raw = (transitionalDeadlineInput?.value || '').trim();
      const iso = formatInputDate(raw);
      if (!iso) {
        showToast('გთხოვთ მიუთითოთ სწორი თარიღი ფორმატით DD/MM/YYYY', 'error');
        return;
      }
      await saveTransitionalDeadlineInternal(iso, { silentToast: false });
    }

    function resetForm() {
      form?.reset();
      setFormSummary(null);
      if (formFields.validUntil) {
        formFields.validUntil.value = '';
      }
      if (validUntilDisplayNode) {
        validUntilDisplayNode.textContent = '—';
      }
      if (formFields.sendNotification) {
        formFields.sendNotification.checked = true;
      }
      if (transitionalDeadlineInput) {
        transitionalDeadlineInput.value = formatDate(globalTransitionalDeadlineIso) || '01/01/2029';
      }
      syncTransitionalBoxVisibility();
      notifyEditorOpen = false;
      notifyManuallyEdited = false;
      updateNotifyEditorVisibility();
    }

    function populateFormFields() {
      if (!form || !activeData) return;

      const levelKey = activeData.level?.key || 'architect';
      const isTrans = !!(activeData.isTransitional && isTransitionalEligibleLevel(levelKey));

      const defaults = {
        uniqueCode: activeData.uniqueCode || activeUser?.code || '',
        level: levelKey,
        status: activeData.status?.key || 'active',
        // Display DD/MM/YYYY in the input
        issueDate: activeData.issueDate || '',
        validityTerm: isTrans ? 'transitional' : '5',
        validUntil: activeData.validUntilInputValue || '',
        validUntilDisplay: activeData.validUntil || '—',
      };

      if (formFields.uniqueCode) formFields.uniqueCode.value = defaults.uniqueCode;
      if (formSummaryNodes.code) formSummaryNodes.code.textContent = defaults.uniqueCode || '—';
      if (formFields.level) formFields.level.value = defaults.level;
      syncValidityTermOptionsForLevel(defaults.level);
      if (formFields.status) formFields.status.value = defaults.status;
      if (formFields.issueDate) formFields.issueDate.value = defaults.issueDate;
      if (formFields.validityTerm) formFields.validityTerm.value = defaults.validityTerm;
      if (formFields.validUntil) formFields.validUntil.value = defaults.validUntil;
      if (validUntilDisplayNode) validUntilDisplayNode.textContent = defaults.validUntilDisplay || '—';
      if (transitionalDeadlineInput) {
        transitionalDeadlineInput.value = formatDate(globalTransitionalDeadlineIso) || '01/01/2029';
      }
      if (formFields.sendNotification) formFields.sendNotification.checked = true;
      setFormSummary(activeData);
      syncTransitionalBoxVisibility();

      notifyManuallyEdited = false;
      updateAutoValidity();
      renderNotifyFields({ force: true });
      void loadCertIssuedTemplate();
      void loadTransitionalDeadline();
    }

    function updateAutoValidity() {
      if (!formOpen) return;
      if (!formFields.issueDate || !formFields.validityTerm || !formFields.validUntil) return;

      syncTransitionalBoxVisibility();

      const issueDateValue = formFields.issueDate.value;
      const rawTermValue = formFields.validityTerm.value;
      const termNumber = rawTermValue === 'transitional' ? 5 : (parseNumber(rawTermValue) || 5);
      if (!issueDateValue || termNumber == null) {
        formFields.validUntil.value = '';
        if (validUntilDisplayNode) validUntilDisplayNode.textContent = '—';
        renderNotifyFields({ force: false });
        return;
      }

      const issueDate = parseDate(issueDateValue);
      if (!issueDate) {
        formFields.validUntil.value = '';
        if (validUntilDisplayNode) validUntilDisplayNode.textContent = '—';
        renderNotifyFields({ force: false });
        return;
      }

      const suggestion = new Date(issueDate);
      suggestion.setFullYear(suggestion.getFullYear() + termNumber);
      const formatted = formatInputDate(suggestion);
      formFields.validUntil.value = formatted || '';
      if (validUntilDisplayNode) {
        validUntilDisplayNode.textContent = formatted ? formatDate(suggestion) : '—';
      }
      renderNotifyFields({ force: false });
    }

    function syncStatusWithDualDeadlines() {
      if (!formOpen || !formFields.status) return;
      const isTrans =
        formFields.validityTerm?.value === 'transitional' &&
        isTransitionalEligibleLevel(formFields.level?.value);
      const validUntilRef = formFields.validUntil?.value || activeData?.rawValidUntil;
      const fiveYearActive = isFiveYearTermStillActive(validUntilRef);

      if (!fiveYearActive) {
        // 5-year cycle has expired: must be expired even if exception deadline was extended beyond 5 years
        if (formFields.status.value === 'active') {
          formFields.status.value = 'expired';
        }
      } else if (!isTrans) {
        // Standard 5-year term and 5-year cycle is still active
        if (formFields.status.value === 'expired') {
          formFields.status.value = 'active';
        }
      } else {
        // Transitional term: obey whichever comes first (5-year cycle is active here, so check exception deadline)
        const deadlineInputIso = formatInputDate(transitionalDeadlineInput?.value || '') || globalTransitionalDeadlineIso;
        if (isTransitionalDeadlineReached(deadlineInputIso)) {
          if (formFields.status.value === 'active') {
            formFields.status.value = 'expired';
          }
        } else if (formFields.status.value === 'expired') {
          formFields.status.value = 'active';
        }
      }
      renderNotifyFields({ force: false });
    }

    function handleValidityTermChange() {
      updateAutoValidity();
      syncStatusWithDualDeadlines();
    }

    function updateView() {
      const hasCertificate = !!(activeData && activeData.hasCertificate);
      const showCard = hasCertificate && !formOpen;

      if (card) card.classList.toggle('hidden', !showCard);
      if (deleteBtn) {
        const canDelete = typeof isFounderActor === 'function' ? !!isFounderActor() : true;
        deleteBtn.classList.toggle('hidden', !canDelete);
        deleteBtn.disabled = !canDelete || exportBusy || !hasCertificate || formOpen;
      }
      if (editBtn) {
        editBtn.classList.toggle('hidden', !hasCertificate);
        editBtn.disabled = exportBusy || formOpen;
        editBtn.textContent = formOpen ? 'ფორმის დახურვა' : 'რედაქტირება';
      }
      if (emptyState) emptyState.classList.toggle('hidden', hasCertificate || formOpen);
      if (form) form.classList.toggle('hidden', !formOpen);

      if (downloadBtn) {
        downloadBtn.textContent = exportBusy ? 'მუშავდება...' : downloadBtnDefaultLabel;
        downloadBtn.disabled = exportBusy || !previewReady || !hasCertificate || formOpen || !!(activeData && activeData.isInactive);
      }
      if (closeBtn) closeBtn.disabled = exportBusy;
      if (emptyCreateBtn && !hasCertificate && !formOpen) {
        emptyCreateBtn.textContent = 'სერტიფიკატის შექმნა';
      }
    }

    function openForm(mode) {
      if (!form || exportBusy) return;
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
      if (!options.preserveActiveData && activeUser) {
        const previousLevelKey = activeData?.level?.key || null;
        activeData = buildCertificateData(activeUser);
        if (activeData && activeData.level?.key !== previousLevelKey) {
          void populateView(activeData);
        }
      }
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

    async function autoUploadCertificatePdf(exportUserId, exportData) {
      if (!exportUserId || !exportData || !previewReady || !getCertificateElement()?.querySelector('.certificate-qr')) {
        return false;
      }
      let svgSandbox = null;
      try {
        const libsOk = await ensureVectorPdfLibrariesLoaded();
        if (!libsOk) return false;
        if (document.fonts?.ready) await document.fonts.ready;
        const levelKey = resolveLevelKey(exportData.level || exportData.level?.key);
        const svgElement = await buildCertificateSvgElement(levelKey);
        if (!svgElement) return false;
        const jsPdfFactory = global.jspdf?.jsPDF;
        const svg2pdfLib = findSvg2PdfFunction();
        if (!jsPdfFactory || !svg2pdfLib) return false;

        svgSandbox = document.createElement('div');
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

        const pdf = new jsPdfFactory('l', 'pt', 'a4');
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        svgElement.setAttribute('width', String(pageWidth));
        svgElement.setAttribute('height', String(pageHeight));
        await ensureDejaVuSansRegistered(pdf);
        await ensureBpgNinoRegistered(pdf);

        if (typeof svg2pdfLib === 'function') {
          await Promise.resolve(svg2pdfLib(svgElement, pdf, {
            x: 0,
            y: 0,
            width: pageWidth,
            height: pageHeight,
          }));
        } else if (global.jspdf?.jsPDF?.API && typeof global.jspdf.jsPDF.API.svg === 'function') {
          await Promise.resolve(global.jspdf.jsPDF.API.svg(svgElement, pdf, {
            x: 0,
            y: 0,
            width: pageWidth,
            height: pageHeight,
          }));
        } else {
          return false;
        }

        const safeFullName = (exportData.fullName || '')
          .trim()
          .replace(/[<>:"/\\|?*]+/g, '')
          .replace(/\s+/g, '_');
        const safeCode = (exportData.uniqueCode || '').trim().replace(/[<>:"/\\|?*]+/g, '');
        const filenameParts = ['certificate'];
        if (safeFullName) filenameParts.push(safeFullName);
        if (safeCode) filenameParts.push(safeCode);
        const filename = `${filenameParts.join('_')}.pdf`;

        return await uploadCertificatePdf(pdf, filename, exportUserId);
      } catch {
        return false;
      } finally {
        if (svgSandbox?.parentNode) {
          svgSandbox.parentNode.removeChild(svgSandbox);
        }
      }
    }

    async function handleFormSubmit(event) {
      if (exportBusy) { event?.preventDefault?.(); return; }
      event?.preventDefault?.();
      if (!form || !activeUser?.id) return;

      const uniqueCode = formFields.uniqueCode?.value?.trim() || '';
      const levelValue = formFields.level?.value || 'architect';
      let statusValue = formFields.status?.value || 'active';
      const issueDateValue = formFields.issueDate?.value || null;
      const rawTermSelection = formFields.validityTerm?.value || '5';
      const isTransitional =
        rawTermSelection === 'transitional' && isTransitionalEligibleLevel(levelValue);
      const validityTermValue = 5;
      const validUntilValue = formFields.validUntil?.value || null;
      const shouldSendNotification = formFields.sendNotification ? !!formFields.sendNotification.checked : false;
      if (!notifyManuallyEdited) {
        renderNotifyFields({ force: false });
      }
      const customNotifySubject = (notifySubjectInput?.value || '').trim() || null;
      const customNotifyBody = (notifyBodyInput?.value || '').trim() || null;

      if (!issueDateValue) {
        showToast('გთხოვ მიუთითო გაცემის თარიღი', 'error');
        return;
      }

      if (isTransitional && transitionalDeadlineInput?.value) {
        const candidateDeadlineIso = formatInputDate(transitionalDeadlineInput.value.trim());
        if (!candidateDeadlineIso) {
          showToast('გთხოვთ მიუთითოთ გამონაკლისის სწორი თარიღი (DD/MM/YYYY)', 'error');
          return;
        }
        if (candidateDeadlineIso !== globalTransitionalDeadlineIso) {
          const updatedDeadlineRes = await saveTransitionalDeadlineInternal(candidateDeadlineIso, { silentToast: true });
          if (!updatedDeadlineRes) return;
          statusValue = formFields.status?.value || statusValue;
        }
      }

      const payload = {
        unique_code: uniqueCode || null,
        level: levelValue,
        status: statusValue,
        // Convert DD/MM/YYYY (UI) -> YYYY-MM-DD for backend
        issue_date: formatInputDate(issueDateValue),
        validity_term: validityTermValue,
        valid_until: validUntilValue,
        is_transitional: isTransitional,
        send_notification: false,
      };

      const requestRevision = openRevision;
      const requestUserId = activeUser.id;
      if (formSubmitBtn) formSubmitBtn.disabled = true;
      try {
        const url = `${API_BASE}/users/${requestUserId}/certificate`;
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
        if (requestRevision !== openRevision || activeUser?.id !== requestUserId) return;

        // Trust the selected level in the form for UI consistency
        const normalizedLevel = normalizeLevel(levelValue);
        if (certificateData.transitional_deadline) {
          globalTransitionalDeadlineIso = String(certificateData.transitional_deadline).trim() || DEFAULT_TRANSITIONAL_DEADLINE_ISO;
          globalTransitionalDeadlineLoaded = true;
        }
        const savedIsTransitional =
          !!(certificateData.is_transitional ?? isTransitional) &&
          isTransitionalEligibleLevel(levelValue);
        const normalizedStatus = normalizeStatus(
          certificateData.status,
          certificateData.valid_until,
          { isTransitional: savedIsTransitional, transitionalDeadline: globalTransitionalDeadlineIso }
        );

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
          isTransitional: savedIsTransitional,
          transitionalDeadline: formatDate(globalTransitionalDeadlineIso) || '01/01/2029',
          isInactive: normalizedStatus.key === 'suspended' || normalizedStatus.key === 'expired',
          hasCertificate: true,
        };

        if (activeUserRef) {
          activeUserRef.certificate = {
            ...certificateData,
            level: levelValue,
            is_transitional: savedIsTransitional,
            transitional_deadline: globalTransitionalDeadlineIso,
          };
          activeUserRef.certificate_info = {
            unique_code: certificateData.unique_code,
            level: levelValue,
            status: certificateData.status,
            issue_date: certificateData.issue_date,
            validity_term: certificateData.validity_term,
            valid_until: certificateData.valid_until,
            is_transitional: savedIsTransitional,
            transitional_deadline: globalTransitionalDeadlineIso,
          };
          activeUserRef.certificate_status = certificateData.status;
          activeUserRef.certificate_valid_until = certificateData.valid_until;
          activeUserRef.candidate_status = null;
          activeUserRef.candidate_category = null;
        }
        if (activeUser) {
          activeUser.certificate = {
            ...certificateData,
            level: levelValue,
            is_transitional: savedIsTransitional,
            transitional_deadline: globalTransitionalDeadlineIso,
          };
          activeUser.certificate_info = {
            unique_code: certificateData.unique_code,
            level: levelValue,
            status: certificateData.status,
            issue_date: certificateData.issue_date,
            validity_term: certificateData.validity_term,
            valid_until: certificateData.valid_until,
            is_transitional: savedIsTransitional,
            transitional_deadline: globalTransitionalDeadlineIso,
          };
          activeUser.certificate_status = certificateData.status;
          activeUser.certificate_valid_until = certificateData.valid_until;
          activeUser.candidate_status = null;
          activeUser.candidate_category = null;
        }

        closeForm({ force: true, preserveActiveData: true });
        await populateView(activeData);
        if (requestRevision !== openRevision || activeUser?.id !== requestUserId) return;
        updateView();
        
        // Update user card color in users list immediately
        if (activeUser?.id && onUserCertificateUpdated) {
          onUserCertificateUpdated(activeUser.id, certificateData);
        }

        const snapshotData = { ...activeData };
        const pdfUploaded = await autoUploadCertificatePdf(requestUserId, snapshotData);

        if (shouldSendNotification) {
          if (!pdfUploaded) {
            showToast('სერტიფიკატის მონაცემები შეინახა, მაგრამ PDF ფაილი ვერ აიტვირთა — შეტყობინება არ გაიგზავნა', 'error');
            return;
          }
          try {
            const notifyRes = await fetch(`${API_BASE}/users/${requestUserId}/certificate/notify`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...getAdminHeaders(),
                ...getActorHeaders(),
              },
              body: JSON.stringify({
                subject: customNotifySubject,
                body: customNotifyBody,
              }),
            });
            if (notifyRes.ok) {
              const notifyData = await notifyRes.json();
              try {
                global.dispatchEvent(new CustomEvent('admin:certificateNotified', { detail: { userId: requestUserId } }));
              } catch {}
              if (notifyData?.notification_status === 'sent' || notifyData?.notification_status === 'simulated') {
                showToast('სერტიფიკატი შეინახა და შეტყობინება გაიგზავნა', 'success');
              } else {
                showToast('სერტიფიკატი შეინახა, მაგრამ შეტყობინების გაგზავნა ვერ მოხერხდა', 'error');
              }
            } else {
              showToast('სერტიფიკატი შეინახა, მაგრამ შეტყობინების გაგზავნა ვერ მოხერხდა', 'error');
            }
          } catch {
            showToast('სერტიფიკატი შეინახა, მაგრამ შეტყობინების გაგზავნა ვერ მოხერხდა', 'error');
          }
        } else {
          showToast('სერტიფიკატის მონაცემები შეინახა', 'success');
        }
      } catch {
        showToast('სერტიფიკატის შენახვა ვერ მოხერხდა', 'error');
      } finally {
        if (formSubmitBtn) formSubmitBtn.disabled = false;
      }
    }

    async function handleDelete() {
      if (exportBusy) return;
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

      const requestRevision = openRevision;
      const requestUserId = activeUser.id;
      try {
        const response = await fetch(`${API_BASE}/users/${requestUserId}/certificate`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });

        if (!response.ok) {
          await handleAdminErrorResponse(response);
          return;
        }

        if (requestRevision !== openRevision || activeUser?.id !== requestUserId) return;
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
        if (requestRevision !== openRevision || activeUser?.id !== requestUserId) return;
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

    async function ensureVectorPdfLibrariesLoaded() {
      if (global.jspdf?.jsPDF && findSvg2PdfFunction()) return true;
      try {
        // svg2pdf extends jsPDF, so the dependency must finish first.
        if (!global.jspdf?.jsPDF) await loadExternalScript('../vendor/jspdf.umd.min.js');
        if (!findSvg2PdfFunction()) await loadExternalScript('../vendor/svg2pdf.min.js');
      } catch {
        return false; // Existing export error handling re-enables the button.
      }
      return !!(global.jspdf?.jsPDF && findSvg2PdfFunction());
    }

    // Upload generated PDF to backend for persistent storage
    async function uploadCertificatePdf(pdf, filename, userId) {
      try {
        if (!userId) return false;
        const blob = await pdf.output('blob');
        const form = new FormData();
        form.append('file', blob, filename || 'certificate.pdf');
        const res = await fetch(`${API_BASE}/users/${userId}/certificate/file`, {
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
      if (exportBusy) return;
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

      if (!previewReady || !getCertificateElement()?.querySelector('.certificate-qr')) {
        showToast('სერტიფიკატი და QR კოდი ჯერ მზად არ არის. გახსენით ხელახლა.', 'error');
        return;
      }

      // Freeze the person throughout the save dialog, vector render and upload.
      const exportUserId = activeUser.id;
      const exportData = { ...activeData };
      exportBusy = true;
      updateView();
      let svgSandbox = null;
      try {

        const safeFullNameEarly = (exportData.fullName || '')
          .trim()
          .replace(/[<>:"/\\|?*]+/g, '')
          .replace(/\s+/g, '_');
        const safeCodeEarly = (exportData.uniqueCode || '').trim().replace(/[<>:"/\\|?*]+/g, '');
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

        if (document.fonts?.ready) await document.fonts.ready;
        const levelKey = resolveLevelKey(exportData.level || exportData.level?.key);
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

        svgSandbox = document.createElement('div');
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

        const pdf = new jsPdfFactory('l', 'pt', 'a4');
        const pageWidth = pdf.internal.pageSize.getWidth();
        const pageHeight = pdf.internal.pageSize.getHeight();
        // Preserve all template coordinates while fitting the vector to physical A4.
        svgElement.setAttribute('width', String(pageWidth));
        svgElement.setAttribute('height', String(pageHeight));
        // Ensure DejaVu Sans is available in jsPDF before rendering
        await ensureDejaVuSansRegistered(pdf);
        // Register BPG Nino (required for fullName). If missing, DejaVuSans will be used (but requirement is BPGNino).
        await ensureBpgNinoRegistered(pdf);
        
        // svg2pdf can be called directly or via jsPDF.API.svg
        if (typeof svg2pdfLib === 'function') {
          await Promise.resolve(svg2pdfLib(svgElement, pdf, {
            x: 0,
            y: 0,
            width: pageWidth,
            height: pageHeight,
          }));
        } else if (global.jspdf && global.jspdf.jsPDF && global.jspdf.jsPDF.API && typeof global.jspdf.jsPDF.API.svg === 'function') {
          await Promise.resolve(global.jspdf.jsPDF.API.svg(svgElement, pdf, {
            x: 0,
            y: 0,
            width: pageWidth,
            height: pageHeight,
          }));
        } else {
          throw new Error('svg2pdf function not available');
        }

        const safeFullName = (exportData.fullName || '')
          .trim()
          .replace(/[<>:"/\\|?*]+/g, '')
          .replace(/\s+/g, '_');
        const safeCode = (exportData.uniqueCode || '').trim().replace(/[<>:"/\\|?*]+/g, '');
        const filenameParts = ['certificate'];
        if (safeFullName) filenameParts.push(safeFullName);
        if (safeCode) filenameParts.push(safeCode);
        const filename = `${filenameParts.join('_')}.pdf`;

        // Upload to server (replace existing), then offer local save
        await uploadCertificatePdf(pdf, filename, exportUserId);
        await deliverPdf(pdf, filename, { showToast, handle: saveHandle });
      } catch {
        showToast('PDF ფაილის შექმნა ვერ მოხერხდა', 'error');
      } finally {
        if (svgSandbox?.parentNode) {
          svgSandbox.parentNode.removeChild(svgSandbox);
        }
        exportBusy = false;
        updateView();
      }
    }

    function resetState() {
      ++renderRevision;
      ++openRevision;
      previewReady = false;
      activeUserRef = null;
      activeUser = null;
      activeData = null;
      formMode = 'create';
      formOpen = false;
      resetForm();
    }

    function handleClose() {
      if (exportBusy) return;
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
      if (exportBusy) {
        showToast('დაელოდეთ სერტიფიკატის PDF-ის დასრულებას.', 'info');
        return;
      }
      if (!ensureOverlay()) return;
      const requestRevision = ++openRevision;
      ++renderRevision;
      previewReady = false;
      activeUserRef = user || null;
      activeUser = user ? { ...user } : null;
      if (downloadBtn) downloadBtn.disabled = true;
      
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
      
      if (requestRevision !== openRevision) return;
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
              is_transitional: certificateData.is_transitional,
              transitional_deadline: certificateData.transitional_deadline,
            },
            certificate_status: certificateData.status,
            certificate_valid_until: certificateData.valid_until,
          }
        : user;
      if (!certificateData) {
        void loadTransitionalDeadline();
      }
      activeUser = userWithCert ? { ...userWithCert } : null;
      
      activeData = buildCertificateData(userWithCert || {});
      formOpen = false;
      formMode = activeData?.hasCertificate ? 'update' : 'create';
      resetForm();
      await populateView(activeData);
      if (requestRevision !== openRevision) return;
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
      notifyEditBtn?.addEventListener('click', toggleNotifyEditor);
      notifyResetBtn?.addEventListener('click', handleNotifyReset);
      notifySaveTemplateBtn?.addEventListener('click', () => { void handleNotifySaveTemplate(); });
      notifySubjectInput?.addEventListener('input', () => { notifyManuallyEdited = true; });
      notifyBodyInput?.addEventListener('input', () => { notifyManuallyEdited = true; });
      formFields.issueDate?.addEventListener('change', () => {
        updateAutoValidity();
        syncStatusWithDualDeadlines();
      });
      formFields.issueDate?.addEventListener('input', () => {
        updateAutoValidity();
        syncStatusWithDualDeadlines();
      });
      formFields.validityTerm?.addEventListener('change', () => handleValidityTermChange());
      formFields.validityTerm?.addEventListener('input', () => handleValidityTermChange());
      formFields.status?.addEventListener('change', () => renderNotifyFields({ force: false }));
      transitionalDeadlineInput?.addEventListener('change', () => syncStatusWithDualDeadlines());
      transitionalDeadlineInput?.addEventListener('input', () => syncStatusWithDualDeadlines());
      transitionalDeadlineSaveBtn?.addEventListener('click', () => { void handleSaveTransitionalDeadline(); });
      downloadBtn?.addEventListener('click', handleDownload);
      attachIssueDatePicker();
      
      // Load template when level changes in form
      formFields.level?.addEventListener('change', async (event) => {
        if (exportBusy) return;
        const level = event.target.value;
        syncValidityTermOptionsForLevel(level);
        updateAutoValidity();
        syncStatusWithDualDeadlines();
        // Update activeData level and re-render; populateView will load correct template
        if (activeData) {
          const normalized = normalizeLevel(level);
          activeData.level = normalized;
        }
        renderNotifyFields({ force: false });
        await populateView(activeData);
        updateView();
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


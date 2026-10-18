(function () {
  'use strict';

  // Signal that header-specific bindings are handled here
  window.HEADER_JS_ACTIVE = true;

  function on(el, type, handler) {
    if (!el || !type || !handler) return;
    try { el.addEventListener(type, handler, false); } catch {}
  }
  function closest(target, selector) {
    try { return target && typeof target.closest === 'function' ? target.closest(selector) : null; } catch { return null; }
  }
  function isMyPage() {
    try { return window.location.pathname.includes('my.html'); } catch { return false; }
  }
  function markCurrentPageLinks() {
    const current = new URL(window.location.href);
    const viewingPerson = current.searchParams.has('code') || current.searchParams.has('userId');
    document.querySelectorAll('.nav-home, .drawer-home, .nav-registry, .drawer-registry, .nav-documents, .drawer-documents, .nav-profile, .drawer-profile').forEach((link) => {
      const target = new URL(link.getAttribute('href'), current);
      const active = target.pathname === current.pathname && !(isMyPage() && viewingPerson);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }
  function isLoggedIn() {
    try {
      if (typeof window.Auth?.isLoggedIn === 'function') {
        return window.Auth.isLoggedIn() === true;
      }
      return localStorage.getItem('authLoggedIn') === 'true' && !!localStorage.getItem('currentUser');
    } catch { return false; }
  }
  function openAuthModal() {
    try { return window.Auth?.openModal?.(); } catch {}
  }

  // Page cover crossfade (0.3s)
  function mountPageCover(opaque) {
    try {
      let el = document.getElementById('pageCover');
      if (!el) {
        el = document.createElement('div');
        el.id = 'pageCover';
        el.className = 'page-cover';
        document.documentElement.appendChild(el);
      } else {
        el.classList.add('page-cover');
      }
      el.style.opacity = opaque ? '1' : '0';
      return el;
    } catch { return null; }
  }

  function setupPageCoverOnLoad() {
    try {
      const existing = document.getElementById('pageCover');
      if (existing) existing.remove();
      sessionStorage.removeItem('pageCover');
    } catch {}
  }

  function transitionTo(url) {
    try {
      const cleanUrl = url.split('#')[0];
      window.location.href = cleanUrl;
    } catch {
      window.location.href = url;
    }
  }

  // Clean up any legacy page cover on load
  setupPageCoverOnLoad();

  // Site Info Modal helpers (About / Terms)
  function getSiteInfoElements() {
    try {
      const modal = document.getElementById('siteInfoModal');
      if (!modal) return null;
      return {
        modal,
        title: modal.querySelector('#siteInfoTitle'),
        body: modal.querySelector('#siteInfoBody'),
        downloadPdfBtn: modal.querySelector('#siteInfoDownloadPdfBtn'),
        closeBtn: modal.querySelector('.modal-close'),
      };
    } catch {
      return null;
    }
  }

  function getSiteInfoPath(type) {
    switch (type) {
      case 'about':
      case 'terms':
      case 'process':
      case 'guide':
      case 'legal-base':
        return `../partials/site-info/${type}.html`;
      case 'contract':
        return `../partials/site-info/exam-service-contract.html`;
      case 'certification-contract':
        return `../partials/site-info/certification-service-contract.html`;
      default:
        return `../partials/site-info/about.html`;
    }
  }

  function getApiBase() {
    try {
      if (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === 'string') {
        return window.APP_CONFIG.API_BASE;
      }
    } catch {}
    return 'http://127.0.0.1:8000';
  }

  function getOptionalAuthHeaders() {
    try {
      const token = window.Auth?.getToken?.() || localStorage.getItem('access_token');
      if (token) return { Authorization: `Bearer ${token}` };
    } catch {}
    return {};
  }

  function getCurrentUserForContract() {
    try {
      if (!isLoggedIn()) return null;
      const raw = localStorage.getItem('currentUser');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function formatTodayDateKa() {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  }

  function populateContractHtmlForCurrentUser(html) {
    if (!html) return '';
    const user = getCurrentUserForContract();
    if (!user) return String(html);

    const first = String(user.firstName || user.first_name || '').trim();
    const last = String(user.lastName || user.last_name || '').trim();
    const fullName = `${first} ${last}`.trim();
    const personalId = String(user.personalId || user.personal_id || '').trim();
    const phone = String(user.phone || '').trim();
    const email = String(user.email || '').trim();
    const dateStr = formatTodayDateKa();

    let out = String(html);
    out = out.replace(/\[თარიღი\]/g, escapeHtml(dateStr));
    if (fullName) {
      out = out.replace(/\[სახელი,\s*გვარი\]/g, escapeHtml(fullName));
      out = out.replace(/\[სახელი\s+გვარი\]/g, escapeHtml(fullName));
    }
    if (personalId) {
      out = out.replace(/\[პირადი\s*ნომერი\]/g, escapeHtml(personalId));
    }
    if (phone) {
      out = out.replace(/\[ტელეფონი\]/g, escapeHtml(phone));
    }
    if (email) {
      out = out.replace(/\[ელ\.?\s*ფოსტა\]/g, escapeHtml(email));
    }

    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(out, 'text/html');
      doc.querySelectorAll('tr').forEach((tr) => {
        const cells = tr.querySelectorAll('td, th');
        if (cells.length < 2) return;
        const label = (cells[0].textContent || '').replace(/\s+/g, ' ').trim();
        const valText = (cells[1].textContent || '').replace(/\s+/g, ' ').trim();
        const isPlaceholder = !valText || /^\[.*\]$/.test(valText) || /^_{2,}$/.test(valText) || valText === '—' || valText === '-';
        if (!isPlaceholder) return;
        if (label.includes('სახელი') && label.includes('გვარი') && fullName) {
          cells[1].textContent = fullName;
        } else if (label.includes('პირადი ნომერი') && personalId) {
          cells[1].textContent = personalId;
        } else if (label.includes('ტელეფონ') && phone) {
          cells[1].textContent = phone;
        } else if ((label.includes('ელ. ფოსტა') || label.includes('ელ-ფოსტა') || label.includes('ელფოსტა')) && email) {
          cells[1].textContent = email;
        }
      });
      out = doc.body.innerHTML;
    } catch {}

    return out;
  }

  // Site Documents - dynamic loading from API with sessionStorage cache
  let cachedDocuments = null;
  let cachedDocumentsKey = null;
  let currentModalDoc = null;
  const SITE_DOCS_CACHE_PREFIX = 'gipc_site_docs_v2_';

  function getSiteDocsCacheKey() {
    const user = getCurrentUserForContract();
    const uid = user?.id || user?.email || 'guest';
    return `${SITE_DOCS_CACHE_PREFIX}${uid}`;
  }

  function invalidateSiteDocumentsCache() {
    cachedDocuments = null;
    cachedDocumentsKey = null;
    try {
      Object.keys(sessionStorage).forEach((k) => {
        if (k.startsWith('gipc_site_docs_')) sessionStorage.removeItem(k);
      });
    } catch {}
  }

  document.addEventListener('auth:login', invalidateSiteDocumentsCache);
  document.addEventListener('auth:logout', invalidateSiteDocumentsCache);
  document.addEventListener('user:refreshed', invalidateSiteDocumentsCache);

  async function fetchSiteDocuments(forceRefresh = false) {
    const cacheKey = getSiteDocsCacheKey();
    if (!forceRefresh && cachedDocuments && cachedDocumentsKey === cacheKey) {
      return cachedDocuments.map((d) => ({
        ...d,
        content: populateContractHtmlForCurrentUser(d.content || ''),
      }));
    }
    if (!forceRefresh) {
      try {
        const stored = sessionStorage.getItem(cacheKey);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed)) {
            cachedDocuments = parsed.map((d) => ({
              ...d,
              content: populateContractHtmlForCurrentUser(d.content || ''),
            }));
            cachedDocumentsKey = cacheKey;
            return cachedDocuments;
          }
        }
      } catch {}
    }
    try {
      const API_BASE = getApiBase();
      const response = await fetch(`${API_BASE}/documents`, {
        cache: forceRefresh ? 'no-cache' : 'default',
        headers: { ...getOptionalAuthHeaders() },
      });
      if (!response.ok) return [];
      const data = await response.json();
      const items = Array.isArray(data.items) ? data.items : [];
      cachedDocuments = items.map((d) => ({
        ...d,
        content: populateContractHtmlForCurrentUser(d.content || ''),
      }));
      cachedDocumentsKey = cacheKey;
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify(cachedDocuments));
      } catch {}
      return cachedDocuments;
    } catch (err) {
      console.error('Failed to fetch site documents:', err);
      return [];
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  const DOCUMENT_ALLOWED_TAGS = new Set([
    'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'DIV', 'EM', 'H1', 'H2', 'H3',
    'H4', 'H5', 'H6', 'HR', 'I', 'LI', 'OL', 'P', 'PRE', 'S', 'SPAN', 'STRONG',
    'SUB', 'SUP', 'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'U', 'UL',
  ]);
  const DOCUMENT_DROP_CONTENT_TAGS = new Set([
    'AUDIO', 'BASE', 'BUTTON', 'CANVAS', 'EMBED', 'FORM', 'IFRAME', 'INPUT', 'LINK',
    'MATH', 'META', 'OBJECT', 'OPTION', 'SCRIPT', 'SELECT', 'SOURCE', 'STYLE', 'SVG',
    'TEMPLATE', 'TEXTAREA', 'TRACK', 'VIDEO',
  ]);
  const DOCUMENT_ALLOWED_STYLE_PROPERTIES = [
    'background-color',
    'color',
    'font-style',
    'font-weight',
    'text-align',
    'text-decoration',
    'text-decoration-line',
    'vertical-align',
    'white-space',
  ];

  function safeDocumentHref(value) {
    const href = String(value || '').trim();
    if (!href) return null;
    if (href.startsWith('#')) return href;
    try {
      const parsed = new URL(href, window.location.href);
      return ['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol) ? href : null;
    } catch {
      return null;
    }
  }

  function copySafeDocumentAttributes(source, target, tagName) {
    const direction = String(source.getAttribute('dir') || '').toLowerCase();
    if (['auto', 'ltr', 'rtl'].includes(direction)) target.setAttribute('dir', direction);

    const title = source.getAttribute('title');
    if (title) target.setAttribute('title', title);

    const rawStyle = source.getAttribute('style');
    if (rawStyle) {
      const styleParser = document.createElement('span');
      styleParser.setAttribute('style', rawStyle);
      DOCUMENT_ALLOWED_STYLE_PROPERTIES.forEach((property) => {
        const value = styleParser.style.getPropertyValue(property);
        if (value) target.style.setProperty(property, value);
      });
    }

    if (tagName === 'A') {
      const href = safeDocumentHref(source.getAttribute('href'));
      if (href) target.setAttribute('href', href);
      const requestedTarget = source.getAttribute('target');
      if (requestedTarget === '_blank') {
        target.setAttribute('target', '_blank');
        target.setAttribute('rel', 'noopener noreferrer');
      }
    }

    if (tagName === 'TD' || tagName === 'TH') {
      ['colspan', 'rowspan'].forEach((attribute) => {
        const value = Number.parseInt(source.getAttribute(attribute), 10);
        if (Number.isInteger(value) && value >= 1 && value <= 100) {
          target.setAttribute(attribute, String(value));
        }
      });
    }

    if (tagName === 'OL') {
      const start = Number.parseInt(source.getAttribute('start'), 10);
      if (Number.isInteger(start)) target.setAttribute('start', String(start));
    }
  }

  function cloneSafeDocumentNode(node) {
    if (node.nodeType === 3) return document.createTextNode(node.nodeValue || '');

    const fragment = document.createDocumentFragment();
    if (node.nodeType !== 1) return fragment;

    const tagName = String(node.tagName || '').toUpperCase();
    if (DOCUMENT_DROP_CONTENT_TAGS.has(tagName)) return fragment;

    const destination = DOCUMENT_ALLOWED_TAGS.has(tagName)
      ? document.createElement(tagName.toLowerCase())
      : fragment;

    if (destination !== fragment) copySafeDocumentAttributes(node, destination, tagName);
    Array.from(node.childNodes || []).forEach((child) => {
      destination.appendChild(cloneSafeDocumentNode(child));
    });
    return destination;
  }

  function renderSafeDocumentHtml(container, html) {
    if (!container) return;
    const output = document.createDocumentFragment();
    try {
      const parsed = new DOMParser().parseFromString(String(html || ''), 'text/html');
      Array.from(parsed.body.childNodes).forEach((node) => {
        output.appendChild(cloneSafeDocumentNode(node));
      });
    } catch {
      output.appendChild(document.createTextNode(String(html || '')));
    }

    container.replaceChildren(output);
    if (!container.hasChildNodes()) {
      const empty = document.createElement('p');
      empty.textContent = 'შიგთავსი არ არის.';
      container.appendChild(empty);
    }
  }

  async function populateInfoDropdowns() {
    // Documents are now displayed on the dedicated ../pages/documents.html page;
    // the "ინფორმაცია" menu contains only "გზამკვლევი".
  }

  // Word inline სტილების გასუფთავება და ბულეტების კონვერტაცია
  function sanitizeWordStyles(container) {
    if (!container) return;
    try {
      // ყველა ელემენტის სტილების გასუფთავება
      const allElements = container.querySelectorAll('*');
      allElements.forEach(el => {
        if (el.style) {
          el.style.fontSize = '';
          el.style.fontFamily = '';
          el.style.marginLeft = '';
          el.style.textIndent = '';
          if (el.style.cssText) {
            el.style.cssText = el.style.cssText.replace(/mso-[^;]+;?/gi, '');
          }
        }
        el.removeAttribute('class');
      });

      // ბულეტიანი აბზაცების კონვერტაცია <ul>/<li>-ში
      const bulletChars = '·•\\-–—§■□►▪▸●○⁃◦◘◙';
      const bulletRegex = new RegExp('^[\\s\\u00A0]*[' + bulletChars + '][\\s\\u00A0]*');
      const paragraphs = Array.from(container.querySelectorAll('p'));
      
      let currentUl = null;
      let lastWasBullet = false;
      
      paragraphs.forEach(p => {
        const text = p.textContent || '';
        const isBullet = bulletRegex.test(text);
        
        if (isBullet) {
          const li = document.createElement('li');
          // წავშალოთ ბულეტის სიმბოლო ტექსტიდან
          const cleanBulletRegex = new RegExp('[' + bulletChars + '][\\s\\u00A0]*', 'g');
          li.innerHTML = p.innerHTML.replace(cleanBulletRegex, '').trim();
          
          if (!currentUl) {
            currentUl = document.createElement('ul');
            p.parentNode.insertBefore(currentUl, p);
          }
          
          currentUl.appendChild(li);
          p.remove();
          lastWasBullet = true;
        } else {
          if (lastWasBullet) {
            currentUl = null;
          }
          lastWasBullet = false;
        }
      });

      // უკვე არსებული <li> ელემენტებიდანაც წავშალოთ ბულეტის სიმბოლოები
      container.querySelectorAll('li').forEach(li => {
        const cleanBulletRegex = new RegExp('[' + bulletChars + '][\\s\\u00A0]*', 'g');
        li.innerHTML = li.innerHTML.replace(cleanBulletRegex, '').trim();
      });

      // ცალკე მდგომი bold აბზაცების (მთავარი სათაურებისა და მუხლების) მონიშვნა
      const topParagraphs = Array.from(container.children).filter(el => el.tagName === 'P');
      topParagraphs.forEach((p, idx) => {
        const fullText = (p.textContent || '').replace(/\s+/g, ' ').trim();
        if (!fullText) return;
        const boldChild = p.querySelector(':scope > strong, :scope > b');
        if (boldChild && p.children.length === 1) {
          const boldText = (boldChild.textContent || '').replace(/\s+/g, ' ').trim();
          if (boldText === fullText && !/^\d+\.\d+/.test(fullText)) {
            p.classList.add(idx === 0 ? 'site-doc-lead-title' : 'site-doc-section-title');
          }
        }
      });
    } catch (e) { console.error('sanitizeWordStyles error:', e); }
  }

  let jsPdfScriptPromise = null;
  let pdfFontBase64Promise = null;

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return window.btoa(binary);
  }

  function loadExternalScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-dynamic-src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === 'true') return resolve();
        existing.addEventListener('load', () => resolve(), { once: true });
        existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.dynamicSrc = src;
      script.onload = () => {
        script.dataset.loaded = 'true';
        resolve();
      };
      script.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(script);
    });
  }

  async function ensureJsPdfLibrary() {
    if (window.jspdf?.jsPDF) return window.jspdf.jsPDF;
    if (!jsPdfScriptPromise) {
      const url = new URL('../vendor/jspdf.umd.min.js', window.location.href).toString();
      jsPdfScriptPromise = loadExternalScriptOnce(url).catch((err) => {
        jsPdfScriptPromise = null;
        throw err;
      });
    }
    await jsPdfScriptPromise;
    if (!window.jspdf?.jsPDF) throw new Error('jsPDF unavailable');
    return window.jspdf.jsPDF;
  }

  async function ensureGeorgianPdfFont(pdfDoc) {
    const fontName = 'DejaVuSansUnicode';
    if (pdfDoc.getFontList?.()?.[fontName]) {
      pdfDoc.setFont(fontName, 'normal');
      return fontName;
    }
    if (!pdfFontBase64Promise) {
      const fontUrl = new URL('../assets/fonts/dejavu-sans.ttf', window.location.href).toString();
      pdfFontBase64Promise = fetch(fontUrl)
        .then((res) => {
          if (!res.ok) throw new Error('Font download failed');
          return res.arrayBuffer();
        })
        .then((buf) => arrayBufferToBase64(buf))
        .catch((err) => {
          pdfFontBase64Promise = null;
          throw err;
        });
    }
    const base64 = await pdfFontBase64Promise;
    pdfDoc.addFileToVFS('DejaVuSans.ttf', base64);
    pdfDoc.addFont('DejaVuSans.ttf', fontName, 'normal');
    pdfDoc.addFont('DejaVuSans.ttf', fontName, 'bold');
    pdfDoc.addFont('DejaVuSans.ttf', fontName, 'italic');
    pdfDoc.addFont('DejaVuSans.ttf', fontName, 'bolditalic');
    pdfDoc.setFont(fontName, 'normal');
    return fontName;
  }

  function sanitizePdfFilename(title) {
    const cleaned = String(title || 'დოკუმენტი')
      .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return `${cleaned || 'დოკუმენტი'}.pdf`;
  }

  async function generateDocumentPdfFromHtml(doc) {
    const jsPDF = await ensureJsPdfLibrary();
    const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
    const fontName = await ensureGeorgianPdfFont(pdf);

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();
    const marginX = 48;
    const marginTop = 52;
    const marginBottom = 54;
    const usableWidth = pageWidth - marginX * 2;
    let cursorY = marginTop;

    const ensureSpace = (neededHeight) => {
      if (cursorY + neededHeight > pageHeight - marginBottom) {
        pdf.addPage();
        cursorY = marginTop;
      }
    };

    const tempContainer = document.createElement('div');
    const populatedHtml = populateContractHtmlForCurrentUser(doc.content || '');
    renderSafeDocumentHtml(tempContainer, populatedHtml);
    sanitizeWordStyles(tempContainer);

    const docTitle = String(doc.title || 'დოკუმენტი').replace(/\s+/g, ' ').trim();

    // Kicker header
    pdf.setFont(fontName, 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(100, 116, 139);
    pdf.text('საქართველოს პროფესიული სერტიფიცირების ინსტიტუტი (GIPC)', marginX, cursorY);
    cursorY += 18;

    // Document main title
    pdf.setFont(fontName, 'bold');
    pdf.setFontSize(15);
    pdf.setTextColor(28, 70, 140);
    const titleLines = pdf.splitTextToSize(docTitle, usableWidth);
    titleLines.forEach((line) => {
      ensureSpace(20);
      pdf.text(line, marginX, cursorY);
      cursorY += 20;
    });

    cursorY += 4;
    pdf.setDrawColor(203, 213, 225);
    pdf.setLineWidth(0.75);
    pdf.line(marginX, cursorY, pageWidth - marginX, cursorY);
    cursorY += 18;

    const writeWrappedBlock = (text, opts = {}) => {
      const normalized = String(text || '').replace(/\s+/g, ' ').trim();
      if (!normalized) return;
      const {
        x = marginX,
        width = usableWidth,
        fontStyle = 'normal',
        fontSize = 10.5,
        lineHeight = 16,
        color = [30, 41, 59],
        spaceBefore = 0,
        spaceAfter = 8,
        prefix = '',
        prefixX = marginX,
      } = opts;

      if (spaceBefore > 0 && cursorY > marginTop + 10) {
        cursorY += spaceBefore;
      }

      pdf.setFont(fontName, fontStyle);
      pdf.setFontSize(fontSize);
      pdf.setTextColor(color[0], color[1], color[2]);

      const lines = pdf.splitTextToSize(normalized, width);
      if (!lines.length) return;

      // Prevent orphaned single heading line at page bottom
      if (fontStyle === 'bold' && spaceBefore >= 8) {
        ensureSpace(Math.min(lines.length * lineHeight + 24, 90));
      }

      lines.forEach((line, idx) => {
        ensureSpace(lineHeight);
        if (idx === 0 && prefix) {
          pdf.text(prefix, prefixX, cursorY);
        }
        pdf.text(line, x, cursorY);
        cursorY += lineHeight;
      });

      cursorY += spaceAfter;
    };

    const renderTableNode = (tableEl) => {
      const rows = Array.from(tableEl.querySelectorAll('tr'));
      if (!rows.length) return;
      let maxCols = 0;
      const parsedRows = rows.map((tr) => {
        const cells = Array.from(tr.querySelectorAll('th, td'));
        if (cells.length > maxCols) maxCols = cells.length;
        const isHeader = cells.some((c) => c.tagName === 'TH');
        return {
          isHeader,
          texts: cells.map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim()),
        };
      });
      if (!maxCols) return;

      const colWidth = usableWidth / maxCols;
      const cellPadX = 6;
      const cellPadY = 6;
      const lineH = 13.5;

      if (cursorY > marginTop + 10) cursorY += 6;

      parsedRows.forEach((row) => {
        pdf.setFont(fontName, row.isHeader ? 'bold' : 'normal');
        pdf.setFontSize(9.5);
        const cellLines = [];
        let maxLines = 1;
        for (let c = 0; c < maxCols; c++) {
          const txt = row.texts[c] || '';
          const wrapped = pdf.splitTextToSize(txt, Math.max(24, colWidth - cellPadX * 2));
          cellLines.push(wrapped);
          if (wrapped.length > maxLines) maxLines = wrapped.length;
        }
        const rowHeight = maxLines * lineH + cellPadY * 2;
        ensureSpace(rowHeight + 4);

        for (let c = 0; c < maxCols; c++) {
          const cellX = marginX + c * colWidth;
          if (row.isHeader) {
            pdf.setFillColor(248, 250, 252);
            pdf.setDrawColor(203, 213, 225);
            pdf.setLineWidth(0.5);
            pdf.rect(cellX, cursorY, colWidth, rowHeight, 'FD');
            pdf.setTextColor(28, 70, 140);
          } else {
            pdf.setDrawColor(203, 213, 225);
            pdf.setLineWidth(0.5);
            pdf.rect(cellX, cursorY, colWidth, rowHeight, 'S');
            pdf.setTextColor(30, 41, 59);
          }
          const lines = cellLines[c] || [];
          lines.forEach((ln, idx) => {
            pdf.text(ln, cellX + cellPadX, cursorY + cellPadY + 9.5 + idx * lineH);
          });
        }
        cursorY += rowHeight;
      });
      cursorY += 10;
    };

    let skippedDuplicateLeadTitle = false;

    const renderDomNodes = (parent) => {
      Array.from(parent.childNodes).forEach((node) => {
        if (node.nodeType === 3) {
          const txt = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
          if (txt) writeWrappedBlock(txt);
          return;
        }
        if (node.nodeType !== 1) return;

        const tag = (node.tagName || '').toUpperCase();
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text && tag !== 'TABLE') return;

        if (!skippedDuplicateLeadTitle && text === docTitle) {
          skippedDuplicateLeadTitle = true;
          return;
        }

        if (tag === 'H1' || tag === 'H2' || node.classList.contains('site-doc-lead-title')) {
          writeWrappedBlock(text, {
            fontStyle: 'bold',
            fontSize: 12.5,
            lineHeight: 17.5,
            color: [28, 70, 140],
            spaceBefore: 10,
            spaceAfter: 7,
          });
          return;
        }

        if (tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6' || node.classList.contains('site-doc-section-title')) {
          writeWrappedBlock(text, {
            fontStyle: 'bold',
            fontSize: 11.5,
            lineHeight: 16.5,
            color: [15, 23, 42],
            spaceBefore: 9,
            spaceAfter: 6,
          });
          return;
        }

        if (tag === 'UL' || tag === 'OL') {
          const items = Array.from(node.children).filter((el) => el.tagName === 'LI');
          items.forEach((li, idx) => {
            const liText = (li.textContent || '').replace(/\s+/g, ' ').trim();
            if (!liText) return;
            const prefix = tag === 'OL' ? `${idx + 1}.` : '•';
            writeWrappedBlock(liText, {
              x: marginX + 20,
              width: usableWidth - 20,
              prefix,
              prefixX: marginX + 4,
              fontSize: 10.5,
              lineHeight: 15.5,
              spaceAfter: 5,
            });
          });
          cursorY += 4;
          return;
        }

        if (tag === 'TABLE') {
          renderTableNode(node);
          return;
        }

        if (tag === 'P' || tag === 'BLOCKQUOTE') {
          const onlyBold = node.children.length === 1 && (node.children[0].tagName === 'STRONG' || node.children[0].tagName === 'B') &&
            (node.children[0].textContent || '').replace(/\s+/g, ' ').trim() === text;
          writeWrappedBlock(text, {
            fontStyle: onlyBold ? 'bold' : 'normal',
            fontSize: 10.5,
            lineHeight: 16,
            color: onlyBold ? [15, 23, 42] : [30, 41, 59],
            spaceBefore: onlyBold ? 6 : 0,
            spaceAfter: 8,
          });
          return;
        }

        if (node.children && node.children.length > 0) {
          renderDomNodes(node);
        } else {
          writeWrappedBlock(text);
        }
      });
    };

    renderDomNodes(tempContainer);

    // Footer with page numbers on every page
    const totalPages = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= totalPages; i++) {
      pdf.setPage(i);
      const footerY = pageHeight - 26;
      pdf.setDrawColor(226, 232, 240);
      pdf.setLineWidth(0.5);
      pdf.line(marginX, footerY - 12, pageWidth - marginX, footerY - 12);

      pdf.setFont(fontName, 'normal');
      pdf.setFontSize(8.5);
      pdf.setTextColor(100, 116, 139);
      pdf.text('gipc.org.ge', marginX, footerY);
      const pageLabel = `გვერდი ${i} / ${totalPages}`;
      const pageLabelWidth = pdf.getTextWidth(pageLabel);
      pdf.text(pageLabel, pageWidth - marginX - pageLabelWidth, footerY);
    }

    pdf.save(sanitizePdfFilename(docTitle));
  }

  async function downloadDocumentPdf(docOrId, triggerBtn = null) {
    if (triggerBtn) triggerBtn.disabled = true;
    try {
      const API_BASE = getApiBase();
      let doc = null;

      if (typeof docOrId === 'object' && docOrId !== null && docOrId.id) {
        doc = { ...docOrId };
        // Always fetch fresh document with auth headers if it's a contract or if content is missing
        if (doc.contract_type || (!doc.content && !(doc.download_url && String(doc.filename || '').toLowerCase().endsWith('.pdf')))) {
          const resp = await fetch(`${API_BASE}/documents/${doc.id}`, {
            cache: 'no-cache',
            headers: { ...getOptionalAuthHeaders() },
          });
          if (resp.ok) doc = await resp.json();
        }
      } else if (docOrId) {
        const resp = await fetch(`${API_BASE}/documents/${docOrId}`, {
          cache: 'no-cache',
          headers: { ...getOptionalAuthHeaders() },
        });
        if (!resp.ok) throw new Error('Document not found');
        doc = await resp.json();
      }

      if (!doc) throw new Error('Document not found');

      doc = {
        ...doc,
        content: populateContractHtmlForCurrentUser(doc.content || ''),
      };

      // Option B: If a ready-made .pdf file is attached (and not a dynamically populated contract with HTML), download it directly
      const hasHtmlContent = Boolean((doc.content || '').replace(/<[^>]*>/g, '').trim());
      const hasDirectPdf = Boolean(
        doc.download_url && String(doc.filename || '').toLowerCase().endsWith('.pdf')
      );
      if (hasDirectPdf && (!doc.contract_type || !hasHtmlContent)) {
        const link = document.createElement('a');
        link.href = `${API_BASE}${doc.download_url}`;
        link.download = doc.filename || sanitizePdfFilename(doc.title);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return;
      }

      // Option A: Auto-generate clean vector A4 PDF from the document HTML content
      await generateDocumentPdfFromHtml(doc);
    } catch (err) {
      console.error('Failed to download document PDF:', err);
      alert('PDF ფაილის ჩამოტვირთვა ვერ მოხერხდა.');
    } finally {
      if (triggerBtn) triggerBtn.disabled = false;
    }
  }

  async function openDocumentById(docId) {
    try {
      const els = getSiteInfoElements();
      if (!els) return;

      currentModalDoc = null;
      if (els.downloadPdfBtn) {
        els.downloadPdfBtn.hidden = true;
        els.downloadPdfBtn.disabled = false;
      }

      if (els.body) {
        els.body.dataset.infoMode = 'document';
        els.body.innerHTML = '<p class="site-info-state">იტვირთება...</p>';
      }
      els.modal.classList.add('show');
      els.modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      if (els.closeBtn && typeof els.closeBtn.focus === 'function') {
        setTimeout(() => { try { els.closeBtn.focus(); } catch {} }, 0);
      }

      const API_BASE = getApiBase();
      const response = await fetch(`${API_BASE}/documents/${docId}`, {
        cache: 'no-cache',
        headers: { ...getOptionalAuthHeaders() },
      });
      if (!response.ok) throw new Error('Document not found');
      const rawDoc = await response.json();
      const doc = {
        ...rawDoc,
        content: populateContractHtmlForCurrentUser(rawDoc.content || ''),
      };
      currentModalDoc = doc;

      if (els.title) els.title.textContent = doc.title || 'დოკუმენტი';
      if (els.downloadPdfBtn) {
        els.downloadPdfBtn.hidden = false;
      }

      if (els.body) {
        const hasHtmlContent = Boolean((doc.content || '').replace(/<[^>]*>/g, '').trim());
        const hasDirectPdf = Boolean(
          doc.download_url && String(doc.filename || '').toLowerCase().endsWith('.pdf')
        );
        if (!hasHtmlContent && hasDirectPdf) {
          const iframe = document.createElement('iframe');
          iframe.className = 'site-doc-pdf-frame';
          iframe.src = `${API_BASE}${doc.download_url}`;
          iframe.title = doc.title || 'დოკუმენტი';
          els.body.replaceChildren(iframe);
        } else {
          renderSafeDocumentHtml(els.body, doc.content);
          sanitizeWordStyles(els.body);
          const sheet = document.createElement('article');
          sheet.className = 'site-doc-sheet';
          sheet.replaceChildren(...els.body.childNodes);
          els.body.replaceChildren(sheet);
        }
      }
    } catch (err) {
      console.error('Failed to load document:', err);
      const els = getSiteInfoElements();
      if (els?.body) els.body.innerHTML = '<p class="site-info-state site-info-state--error">დოკუმენტი ვერ ჩაიტვირთა.</p>';
    }
  }

  /**
   * Extract embed URL from various video platforms
   */
  function getVideoEmbedUrl(url) {
    if (!url || typeof url !== 'string') return null;

    // YouTube - various formats
    // https://www.youtube.com/watch?v=VIDEO_ID
    // https://youtu.be/VIDEO_ID
    // https://www.youtube.com/embed/VIDEO_ID
    const youtubeMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (youtubeMatch) {
      return `https://www.youtube.com/embed/${youtubeMatch[1]}`;
    }

    // Vimeo - various formats
    // https://vimeo.com/VIDEO_ID
    // https://player.vimeo.com/video/VIDEO_ID
    const vimeoMatch = url.match(/(?:vimeo\.com\/|player\.vimeo\.com\/video\/)(\d+)/);
    if (vimeoMatch) {
      return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
    }

    // Dailymotion
    // https://www.dailymotion.com/video/VIDEO_ID
    const dailymotionMatch = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/);
    if (dailymotionMatch) {
      return `https://www.dailymotion.com/embed/video/${dailymotionMatch[1]}`;
    }

    // Facebook video
    const facebookMatch = url.match(/facebook\.com.*\/videos\/(\d+)/);
    if (facebookMatch) {
      return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`;
    }

    // Already an embed URL or other platform - return as is for iframe
    if (url.includes('embed') || url.includes('player')) {
      return url;
    }

    // Unknown format - return null
    return null;
  }

  async function loadGuideVideosInto(container) {
    try {
      if (!container) return;
      const listEl = container.querySelector('#guideVideosPublic') || container;
      const API_BASE = getApiBase();
      listEl.innerHTML = '<p class="site-info-state">ვიდეოები იტვირთება...</p>';
      const response = await fetch(`${API_BASE}/guide/videos`, { cache: 'no-cache' });
      if (!response.ok) {
        listEl.innerHTML = '<p class="site-info-state site-info-state--error">ვიდეოების სია ვერ ჩაიტვირთა. სცადეთ მოგვიანებით.</p>';
        return;
      }
      const items = await response.json();
      if (!Array.isArray(items) || !items.length) {
        listEl.innerHTML = '<p class="site-info-state">ამ ეტაპზე გზამკვლევის ვიდეო არ არის დამატებული.</p>';
        return;
      }
      listEl.innerHTML = '';
      items.forEach((video, idx) => {
        const card = document.createElement('div');
        card.className = 'guide-video-public-card';
        const title = video.title || 'ვიდეო';
        const url = video.url || '';
        const embedUrl = getVideoEmbedUrl(url);

        const head = document.createElement('div');
        head.className = 'guide-video-public-head';
        const badgeEl = document.createElement('span');
        badgeEl.className = 'guide-video-index';
        badgeEl.textContent = String(idx + 1).padStart(2, '0');
        const titleEl = document.createElement('div');
        titleEl.className = 'guide-video-public-title';
        titleEl.textContent = title;
        head.appendChild(badgeEl);
        head.appendChild(titleEl);

        card.appendChild(head);

        if (embedUrl) {
          // Create iframe for embed
          const iframe = document.createElement('iframe');
          iframe.className = 'guide-video-embed';
          iframe.src = embedUrl;
          iframe.setAttribute('frameborder', '0');
          iframe.setAttribute('allowfullscreen', 'true');
          iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
          iframe.loading = 'lazy';
          card.appendChild(iframe);
        } else if (url) {
          // Fallback: show link if embed not supported
          const linkWrapper = document.createElement('div');
          linkWrapper.className = 'guide-video-link-wrapper';
          const link = document.createElement('a');
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.className = 'guide-video-link';
          link.textContent = 'ვიდეოს ნახვა →';
          linkWrapper.appendChild(link);
          card.appendChild(linkWrapper);
        } else {
          const noVideo = document.createElement('div');
          noVideo.className = 'guide-video-no-url';
          noVideo.textContent = 'ვიდეოს ლინკი არ არის მითითებული';
          card.appendChild(noVideo);
        }

        listEl.appendChild(card);
      });
    } catch (error) {
      console.error('Failed to load guide videos', error);
      try {
        if (container) {
          const listEl = container.querySelector('#guideVideosPublic') || container;
          listEl.innerHTML = '<p class="site-info-state site-info-state--error">ვიდეოების ჩატვირთვა ვერ მოხერხდა.</p>';
        }
      } catch {}
    }
  }

  async function openSiteInfo(type) {
    try {
      const els = getSiteInfoElements();
      if (!els) return;
      currentModalDoc = null;
      if (els.downloadPdfBtn) {
        els.downloadPdfBtn.hidden = true;
      }
      const titles = {
        about: 'ჩვენს შესახებ',
        terms: 'წესები და პირობები',
        process: 'საგამოცდო პროცესი',
        contract: 'საგამოცდო ხელშეკრულება',
        'certification-contract': 'სასერტიფიკაციო ხელშეკრულება',
        'legal-base': 'საკანონმდებლო ბაზა',
        guide: 'გზამკვლევი',
      };
      if (els.title) els.title.textContent = titles[type] || 'ინფორმაცია';

      if (els.body) {
        els.body.dataset.infoMode = type === 'guide' ? 'guide' : 'document';
        els.body.innerHTML = '<p class="site-info-state">იტვირთება...</p>';
      }
      els.modal.classList.add('show');
      els.modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      if (els.closeBtn && typeof els.closeBtn.focus === 'function') {
        setTimeout(() => { try { els.closeBtn.focus(); } catch {} }, 0);
      }

      const res = await fetch(getSiteInfoPath(type), { cache: 'no-cache' });
      if (!res.ok) throw new Error('load failed');
      const html = await res.text();
      if (els.body) {
        els.body.innerHTML = html;
        if (type === 'guide') {
          void loadGuideVideosInto(els.body);
        }
      }
    } catch {
      const els = getSiteInfoElements();
      if (els?.body) els.body.innerHTML = '<p class="site-info-state site-info-state--error">ვერ ჩაიტვირთა შიგთავსი. სცადეთ მოგვიანებით.</p>';
    }
  }

  function closeSiteInfo() {
    try {
      const els = getSiteInfoElements();
      if (!els) return;
      currentModalDoc = null;
      if (els.downloadPdfBtn) {
        els.downloadPdfBtn.hidden = true;
      }
      els.modal.classList.remove('show');
      els.modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
      if (els.body) els.body.innerHTML = '';
    } catch {}
  }

  function bindHeader() {
    const DOM = {
      body: document.body,
      burger: document.querySelector('.burger'),
      overlay: document.querySelector('.overlay'),
      drawer: document.querySelector('.drawer'),
      drawerClose: document.querySelector('.drawer-close'),
      drawerLinks: Array.from(document.querySelectorAll('.drawer-nav a')),
      drawerAboutTrigger: document.querySelector('.drawer-about-trigger'),
      drawerAboutSubmenu: document.querySelector('.drawer-about-submenu'),
      loginBtn: document.querySelector('.login-btn'),
      drawerLoginBtn: document.querySelector('.drawer-login'),
      navLogo: document.querySelector('.nav-bar .logo'),
      aboutTrigger: document.querySelector('.nav .about-trigger'),
      aboutDropdown: document.querySelector('.nav .about-dropdown'),
    };

    function setMenu(open) {
      DOM.body?.classList.toggle('menu-open', !!open);
      if (DOM.burger) DOM.burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) {
        closeDrawerAboutSubmenu();
      }
    }
    function openMenu() { setMenu(true); }
    function closeMenu() { setMenu(false); }
    function toggleMenu() { setMenu(!DOM.body?.classList.contains('menu-open')); }

    function closeDrawerAboutSubmenu() {
      if (!DOM.drawerAboutSubmenu) return;
      DOM.drawerAboutSubmenu.setAttribute('hidden', '');
      DOM.drawerAboutTrigger?.setAttribute('aria-expanded', 'false');
    }

    function toggleDrawerAboutSubmenu(event) {
      event.preventDefault();
      event.stopPropagation();
      if (!DOM.drawerAboutSubmenu) return;
      const hidden = DOM.drawerAboutSubmenu.hasAttribute('hidden');
      if (hidden) {
        DOM.drawerAboutSubmenu.removeAttribute('hidden');
        DOM.drawerAboutTrigger?.setAttribute('aria-expanded', 'true');
      } else {
        closeDrawerAboutSubmenu();
      }
    }

    // Basic bindings for header UI
    on(DOM.burger, 'click', toggleMenu);
    on(DOM.overlay, 'click', closeMenu);
    on(DOM.drawerClose, 'click', closeMenu);
    DOM.drawerLinks.forEach((link) => on(link, 'click', closeMenu));
    on(DOM.drawerAboutTrigger, 'click', toggleDrawerAboutSubmenu);

    on(DOM.loginBtn, 'click', () => openAuthModal());
    on(DOM.drawerLoginBtn, 'click', () => { closeMenu(); openAuthModal(); });
    on(DOM.navLogo, 'click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const isIndexPage = window.location.pathname.includes('index.html') || 
                         (window.location.pathname.endsWith('/') || window.location.pathname.endsWith('index.html'));
      if (isIndexPage) {
        // Already on index page, just scroll to top
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        // Navigate to index page
        transitionTo('index.html');
      }
    });

    // About dropdown (desktop)
    function closeAboutDropdown() {
      if (!DOM.aboutDropdown) return;
      DOM.aboutDropdown.classList.remove('show');
      DOM.aboutDropdown.setAttribute('aria-hidden', 'true');
      DOM.aboutTrigger?.setAttribute('aria-expanded', 'false');
    }
    function openAboutDropdown() {
      if (!DOM.aboutDropdown) return;
      DOM.aboutDropdown.classList.add('show');
      DOM.aboutDropdown.setAttribute('aria-hidden', 'false');
      DOM.aboutTrigger?.setAttribute('aria-expanded', 'true');
      setTimeout(() => document.addEventListener('click', handleDocClickCloseAbout), 0);
    }
    function handleDocClickCloseAbout(event) {
      if (event.target && closest(event.target, '.nav-about')) return;
      closeAboutDropdown();
      document.removeEventListener('click', handleDocClickCloseAbout);
    }
    function handleAboutTrigger(event) {
      event.preventDefault();
      if (!DOM.aboutDropdown) return;
      if (DOM.aboutDropdown.classList.contains('show')) {
        closeAboutDropdown();
      } else {
        openAboutDropdown();
      }
    }
    on(DOM.aboutTrigger, 'click', handleAboutTrigger);

    // Delegated for dropdown items (desktop) and drawer submenu (mobile)
    document.addEventListener('click', (event) => {
      const el = event.target;
      if (!el) return;
      
      // Dynamic document items (with data-doc-id)
      const dynamicItem = closest(el, '[data-doc-id]');
      if (dynamicItem && closest(dynamicItem, '.about-dropdown, .drawer-about-submenu')) {
        event.preventDefault();
        closeAboutDropdown();
        closeDrawerAboutSubmenu();
        if (DOM.body.classList.contains('menu-open')) closeMenu();
        const docId = dynamicItem.getAttribute('data-doc-id');
        if (docId) openDocumentById(docId);
        return;
      }

      // Page links inside about dropdown / mobile submenu (e.g. დოკუმენტები)
      const dropdownPageLink = closest(el, '.about-dropdown a[data-page-link], .drawer-about-submenu a[data-page-link]');
      if (dropdownPageLink) {
        closeAboutDropdown();
        closeDrawerAboutSubmenu();
        if (DOM.body.classList.contains('menu-open')) closeMenu();
        return;
      }
      
      // Fixed items: guide
      if (closest(el, '.dropdown-item.guide, .drawer-submenu-item.guide')) {
        event.preventDefault();
        closeAboutDropdown();
        closeDrawerAboutSubmenu();
        if (DOM.body.classList.contains('menu-open')) closeMenu();
        openSiteInfo('guide');
        return;
      }
      // About panel items (desktop + mobile) - catch-all for any other items
      if (closest(el, '.about-dropdown .dropdown-item, .drawer-about-submenu .drawer-submenu-item')) {
        event.preventDefault();
        closeAboutDropdown();
        closeDrawerAboutSubmenu();
        return;
      }
    }, { capture: true });

    // Close menu with Escape
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (DOM.body?.classList.contains('menu-open')) closeMenu();
      closeAboutDropdown();
      closeDrawerAboutSubmenu();
      closeSiteInfo();
    });

    // Delegated gating for statements and profile
    document.addEventListener('click', (event) => {
      const el = event.target;
      if (!el) return;

      // Statements (both pages) - open modal directly
      const statements = closest(el, '.nav-statements, .drawer-statements');
      if (statements) {
        event.preventDefault();
        const fromDrawer = !!closest(el, '.drawer');
        if (!isLoggedIn()) {
          if (fromDrawer) closeMenu();
          alert('გთხოვთ გაიაროთ ავტორიზაცია');
          openAuthModal();
          return;
        }
        if (fromDrawer) closeMenu();
        // Open statements modal directly without page navigation
        try {
          window.dispatchEvent(new CustomEvent('openStatements'));
        } catch {}
        return;
      }

      // Keep normal link navigation (including opening in a new tab).
      // Only intercept the private page when authentication is required.
      const profile = closest(el, '.nav-profile[data-page-link], .drawer-profile[data-page-link]');
      if (profile) {
        const fromDrawer = !!closest(el, '.drawer');
        if (!isLoggedIn()) {
          event.preventDefault();
          if (fromDrawer) closeMenu();
          openAuthModal();
          return;
        }
        if (fromDrawer) closeMenu();
      }

      // Prevent redundant full-page reload when clicking the nav link for the current page
      const pageLink = closest(el, '.nav-home[data-page-link], .drawer-home[data-page-link], .nav-registry[data-page-link], .drawer-registry[data-page-link], .nav-documents[data-page-link], .drawer-documents[data-page-link], .nav-profile[data-page-link], .drawer-profile[data-page-link]');
      if (pageLink && !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        try {
          const current = new URL(window.location.href);
          const target = new URL(pageLink.getAttribute('href'), current);
          if (target.pathname === current.pathname && target.search === current.search) {
            event.preventDefault();
            if (closest(el, '.drawer')) closeMenu();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
          }
        } catch {}
      }
    }, { capture: true });

    // Site Info Modal close & PDF download bindings
    try {
      const els = getSiteInfoElements();
      if (els?.closeBtn) on(els.closeBtn, 'click', closeSiteInfo);
      if (els?.downloadPdfBtn) {
        on(els.downloadPdfBtn, 'click', () => {
          if (currentModalDoc) {
            void downloadDocumentPdf(currentModalDoc, els.downloadPdfBtn);
          }
        });
      }
      if (els?.modal) {
        on(els.modal, 'click', (e) => {
          if (e && e.target === els.modal) closeSiteInfo();
        });
      }
    } catch {}
  }

  window.SiteDocuments = {
    fetchSiteDocuments,
    openDocumentById,
    downloadDocumentPdf,
    renderSafeDocumentHtml,
    sanitizeWordStyles,
    populateContractHtmlForCurrentUser,
  };

  const HEADER_PARTIAL_URL = '../partials/header.html?v=20261018-stmt-tabs2';
  const HEADER_CACHE_KEY = 'gipc_header_partial_v20261018_stmt_tabs2';

  function syncHeaderInitialAuthUI() {
    try {
      const logged = localStorage.getItem('authLoggedIn') === 'true';
      const rawUser = localStorage.getItem('currentUser');
      const user = rawUser ? JSON.parse(rawUser) : null;
      const loginBtn = document.querySelector('.login-btn');
      const drawerLoginBtn = document.querySelector('.drawer-login');
      if (loginBtn) loginBtn.textContent = logged ? 'გასვლა' : 'შესვლა';
      if (drawerLoginBtn) drawerLoginBtn.textContent = logged ? 'გასვლა' : 'შესვლა';

      const authBanner = document.querySelector('.auth-banner');
      const drawerAuthBanner = document.querySelector('.drawer-auth-banner');
      if (logged && user && (user.firstName || user.lastName || user.code)) {
        const text = `${user.firstName || ''} ${user.lastName || ''} — ${user.code || ''}`.trim();
        if (authBanner) authBanner.textContent = text;
        if (drawerAuthBanner) drawerAuthBanner.textContent = text;
      } else {
        if (authBanner) authBanner.textContent = 'გთხოვთ შეხვიდეთ სისტემაში';
        if (drawerAuthBanner) drawerAuthBanner.textContent = 'გთხოვთ შეხვიდეთ სისტემაში';
      }
    } catch {}
  }

  function mountHeaderHtml(html) {
    if (!document.body || !html) return;
    if (!document.querySelector('header')) {
      document.body.insertAdjacentHTML('afterbegin', html);
    }

    // Home and personal page links keep the same label and destination everywhere.
    const profilePage = isMyPage();
    markCurrentPageLinks();
    syncHeaderInitialAuthUI();

    const dispatchReady = () => {
      document.dispatchEvent(new CustomEvent('headerReady', { detail: { isProfilePage: profilePage } }));
    };

    // Notify listeners both immediately and after DOMContentLoaded so deferred page scripts always catch it
    dispatchReady();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => setTimeout(dispatchReady, 0), { once: true });
    } else {
      setTimeout(dispatchReady, 0);
    }

    // Bind behaviors
    bindHeader();

    // Populate dynamic documents in info dropdown
    populateInfoDropdowns();

    // Initialize statements module after header is loaded
    initStatementsModule();
  }

  async function loadHeader() {
    try {
      let cached = null;
      try {
        cached = sessionStorage.getItem(HEADER_CACHE_KEY);
      } catch {}
      if (cached) {
        mountHeaderHtml(cached);
        return;
      }

      const response = await fetch(HEADER_PARTIAL_URL);
      if (!response.ok) return;
      const html = await response.text();
      try {
        sessionStorage.setItem(HEADER_CACHE_KEY, html);
      } catch {}
      mountHeaderHtml(html);
    } catch {}
  }

  function initStatementsModule() {
    const API_BASE = (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === 'string')
      ? window.APP_CONFIG.API_BASE
      : 'http://127.0.0.1:8000';
    
    const statementsDOM = {
      body: document.body,
      statementsOverlay: document.getElementById('userStatementsOverlay'),
      statementsClose: document.getElementById('userStatementsClose'),
      statementsList: document.getElementById('userStatementsList'),
      statementsCount: document.getElementById('userStatementsCount'),
      statementsMeta: document.getElementById('userStatementsMeta'),
      statementsForm: document.getElementById('userStatementForm'),
      statementsTextarea: document.querySelector('#userStatementForm textarea[name="message"]'),
      statementFileControls: document.getElementById('statementFileControls'),
      statementFileChoose: document.getElementById('statementFileChoose'),
      statementFileInput: document.getElementById('statementFileInput'),
      statementFileDisplay: document.getElementById('statementFileDisplay'),
      tabExam: document.getElementById('statementTabExam'),
      tabOther: document.getElementById('statementTabOther'),
      examForm: document.getElementById('examApplicationForm'),
      examFileControls: document.getElementById('examFileControls'),
      examFilesChoose: document.getElementById('examFilesChoose'),
      examFilesInput: document.getElementById('examFilesInput'),
      examFilesDisplay: document.getElementById('examFilesDisplay'),
      examFilesListWrap: document.getElementById('examFilesListWrap'),
      examFilesList: document.getElementById('examFilesList'),
      examAdditionalInfo: document.getElementById('examAdditionalInfo'),
      examConfirmCheckbox: document.getElementById('examConfirmCheckbox'),
      examApplicantSignature: document.getElementById('examApplicantSignature'),
      examSubmitBtn: document.getElementById('examApplicationSubmit'),
    };

    let overlayOpen = false;
    let isLoading = false;
    let cache = [];
    let examSelectedFiles = [];
    let activeTab = 'exam';

    function switchStatementTab(tabKey) {
      activeTab = tabKey === 'other' ? 'other' : 'exam';
      const isExam = activeTab === 'exam';
      if (statementsDOM.tabExam) {
        statementsDOM.tabExam.classList.toggle('is-active', isExam);
        statementsDOM.tabExam.setAttribute('aria-selected', isExam ? 'true' : 'false');
      }
      if (statementsDOM.tabOther) {
        statementsDOM.tabOther.classList.toggle('is-active', !isExam);
        statementsDOM.tabOther.setAttribute('aria-selected', !isExam ? 'true' : 'false');
      }
      if (statementsDOM.examForm) {
        if (isExam) statementsDOM.examForm.removeAttribute('hidden');
        else statementsDOM.examForm.setAttribute('hidden', '');
      }
      if (statementsDOM.statementsForm) {
        if (!isExam) statementsDOM.statementsForm.removeAttribute('hidden');
        else statementsDOM.statementsForm.setAttribute('hidden', '');
      }
    }

    function isLoggedIn() {
      try {
        if (typeof window.Auth?.isLoggedIn === 'function') {
          return window.Auth.isLoggedIn() === true;
        }
        return localStorage.getItem('authLoggedIn') === 'true' && !!localStorage.getItem('currentUser');
      } catch { return false; }
    }
    function getCurrentUser() {
      try {
        if (typeof window.Auth?.getCurrentUser === 'function') {
          return window.Auth.getCurrentUser() || null;
        }
        const raw = localStorage.getItem('currentUser');
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }
    function getActorEmail() {
      try {
        return (window.Auth?.getSavedEmail?.() || localStorage.getItem('savedEmail') || '').trim();
      } catch { return ''; }
    }
    function getActorHeaders() {
      try {
        if (typeof window.Auth?.getAuthHeaders === 'function') {
          return window.Auth.getAuthHeaders() || {};
        }
        const token = localStorage.getItem('auth_token');
        return token ? { 'Authorization': 'Bearer ' + token } : {};
      } catch { return {}; }
    }

    function ensureAuthForCompose(event) {
      if (isLoggedIn()) return true;
      if (event?.cancelable) event.preventDefault();
      alert('გთხოვთ გაიაროთ ავტორიზაცია');
      return false;
    }

    function setMetaFromUser() {
      const user = getCurrentUser();
      const name = user
        ? `${user.firstName || user.first_name || ''} ${user.lastName || user.last_name || ''}`.trim()
        : '';
      if (statementsDOM.statementsMeta) {
        const parts = [];
        if (name) parts.push(name);
        if (user?.code) parts.push(user.code);
        statementsDOM.statementsMeta.textContent = parts.join(' - ');
      }
      if (statementsDOM.examApplicantSignature) {
        statementsDOM.examApplicantSignature.textContent = `განმცხადებელი: ${name || '—'} (დადასტურებულია ელექტრონულად).`;
      }
    }

    function openOverlay() {
      if (!statementsDOM.statementsOverlay) return;
      overlayOpen = true;
      statementsDOM.statementsOverlay.classList.add('open');
      statementsDOM.statementsOverlay.setAttribute('aria-hidden', 'false');
      statementsDOM.body.classList.add('modal-open');
    }

    function closeOverlay() {
      if (!statementsDOM.statementsOverlay) return;
      overlayOpen = false;
      statementsDOM.statementsOverlay.classList.remove('open');
      statementsDOM.statementsOverlay.setAttribute('aria-hidden', 'true');
      statementsDOM.body.classList.remove('modal-open');
    }

    function updateCount(count) {
      if (statementsDOM.statementsCount) {
        statementsDOM.statementsCount.textContent = String(count);
      }
    }

    function renderPlaceholder(text, modifier) {
      if (!statementsDOM.statementsList) return;
      if (modifier === 'statements-empty') updateCount(0);
      const placeholder = document.createElement('div');
      placeholder.className = `statements-placeholder${modifier ? ` ${modifier}` : ''}`;
      placeholder.textContent = text;
      statementsDOM.statementsList.innerHTML = '';
      statementsDOM.statementsList.appendChild(placeholder);
    }

    function renderList(items) {
      if (!statementsDOM.statementsList) return;
      updateCount(items.length);
      if (!items.length) {
        renderPlaceholder('განცხადებები ჯერ არ გაქვთ.', 'statements-empty');
        return;
      }
      const fragment = document.createDocumentFragment();
      items.forEach((item) => {
        const details = document.createElement('details');
        details.className = 'statement-item';
        details.setAttribute('role', 'listitem');
        const summary = document.createElement('summary');
        summary.className = 'statement-summary';

        const docNumber = (item.doc_number || '').toString().trim();
        if (docNumber) {
          const docNumSpan = document.createElement('span');
          docNumSpan.className = 'statement-doc-number';
          docNumSpan.textContent = docNumber;
          summary.appendChild(docNumSpan);
        }

        const dateSpan = document.createElement('span');
        dateSpan.className = 'statement-date';
        dateSpan.textContent = window.Utils?.formatDateTime?.(item.created_at);
        summary.appendChild(dateSpan);

        const rawPreview = (item.message || '').replace(/\s+/g, ' ').trim();
        if (rawPreview) {
          const previewSpan = document.createElement('span');
          previewSpan.className = 'statement-preview';
          previewSpan.textContent = rawPreview.length > 68 ? `${rawPreview.slice(0, 65)}…` : rawPreview;
          summary.appendChild(previewSpan);
        }

        const badgeSpan = document.createElement('span');
        badgeSpan.className = 'statement-sent-badge';
        badgeSpan.textContent = 'მიღებულია';
        summary.appendChild(badgeSpan);

        details.appendChild(summary);
        const message = document.createElement('div');
        message.className = 'statement-message';
        const rawMsg = item.message || '';
        message.textContent = docNumber && !rawMsg.includes(docNumber)
          ? `დოკუმენტის №: ${docNumber}\n\n${rawMsg}`
          : rawMsg;
        details.appendChild(message);
        
        if (item.attachment_filename) {
          const attachmentWrapper = document.createElement('div');
          attachmentWrapper.className = 'statement-attachment';
          const downloadBtn = document.createElement('button');
          downloadBtn.type = 'button';
          downloadBtn.className = 'statement-attachment-download';
          downloadBtn.textContent = 'ჩამოტვირთვა';
          const actorEmail = getActorEmail();
          const downloadUrl = `${API_BASE}/statements/${encodeURIComponent(item.id)}/attachment${actorEmail ? `?actor=${encodeURIComponent(actorEmail)}` : ''}`;
          downloadBtn.addEventListener('click', () => {
            window.location.href = downloadUrl;
          });
          const filenameSpan = document.createElement('span');
          filenameSpan.className = 'statement-attachment-filename';
          filenameSpan.textContent = item.attachment_filename;
          attachmentWrapper.appendChild(downloadBtn);
          attachmentWrapper.appendChild(filenameSpan);
          details.appendChild(attachmentWrapper);
        }
        
        fragment.appendChild(details);
      });
      statementsDOM.statementsList.innerHTML = '';
      statementsDOM.statementsList.appendChild(fragment);
    }

    async function fetchStatements() {
      if (!statementsDOM.statementsList || isLoading) return;
      const actorEmail = getActorEmail();
      if (!actorEmail) {
        renderPlaceholder('ავტორიზაცია ვერ დადასტურდა', 'statements-error');
        return;
      }
      isLoading = true;
      try {
        const response = await fetch(`${API_BASE}/statements/me`, {
          headers: {
            ...getActorHeaders(),
            'Cache-Control': 'no-cache',
          },
          credentials: 'include',
        });
        if (!response.ok) {
          if (response.status === 401) {
            renderPlaceholder('გთხოვთ გაიაროთ ავტორიზაცია', 'statements-error');
            alert('გთხოვთ გაიაროთ ავტორიზაცია');
            closeOverlay();
            return;
          }
          let detail = '';
          try {
            const json = await response.clone().json();
            detail = json?.detail || '';
          } catch {
            try { detail = (await response.clone().text()).trim(); } catch {}
          }
          throw new Error(detail || 'ჩატვირთვის შეცდომა');
        }
        const data = await response.json();
        cache = Array.isArray(data) ? data : [];
        renderList(cache);
      } catch {
        renderPlaceholder('ჩატვირთვის შეცდომა', 'statements-error');
      } finally {
        isLoading = false;
      }
    }

    function handleOpenRequest(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      try {
        const overlay = document.getElementById('registryOverlay');
        if (overlay) {
          overlay.classList.remove('is-open');
          overlay.setAttribute('aria-hidden', 'true');
          document.body.classList.remove('registry-open');
        }
      } catch {}
      if (!isLoggedIn()) {
        alert('გთხოვთ გაიაროთ ავტორიზაცია');
        return;
      }
      const actorEmail = getActorEmail();
      if (!actorEmail) {
        alert('ავტორიზაცია ვერ დადასტურდა');
        return;
      }
      setMetaFromUser();
      switchStatementTab('exam');
      openOverlay();
      renderPlaceholder('იტვირთება...', 'statements-loading');
      fetchStatements();
    }

    function handleBackdropClick(event) {
      if (event.target === statementsDOM.statementsOverlay) {
        closeOverlay();
      }
    }

    function renderExamFilesList() {
      if (!statementsDOM.examFilesDisplay) return;
      if (!examSelectedFiles.length) {
        statementsDOM.examFilesDisplay.value = '';
        statementsDOM.examFileControls?.classList?.remove?.('has-file');
        if (statementsDOM.examFilesListWrap) statementsDOM.examFilesListWrap.setAttribute('hidden', '');
        if (statementsDOM.examFilesList) statementsDOM.examFilesList.innerHTML = '';
        return;
      }
      statementsDOM.examFilesDisplay.value = examSelectedFiles.length === 1
        ? examSelectedFiles[0].name
        : `არჩეულია ${examSelectedFiles.length} ფაილი`;
      statementsDOM.examFileControls?.classList?.add?.('has-file');
      if (statementsDOM.examFilesListWrap) statementsDOM.examFilesListWrap.removeAttribute('hidden');
      if (statementsDOM.examFilesList) {
        const frag = document.createDocumentFragment();
        examSelectedFiles.forEach((file, idx) => {
          const li = document.createElement('li');
          li.className = 'exam-uploaded-file-item';
          const nameSpan = document.createElement('span');
          nameSpan.className = 'exam-uploaded-file-name';
          nameSpan.textContent = file.name;
          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'exam-uploaded-file-remove';
          removeBtn.textContent = '×';
          removeBtn.setAttribute('aria-label', `ფაილის წაშლა: ${file.name}`);
          removeBtn.addEventListener('click', () => {
            examSelectedFiles.splice(idx, 1);
            renderExamFilesList();
          });
          li.appendChild(nameSpan);
          li.appendChild(removeBtn);
          frag.appendChild(li);
        });
        statementsDOM.examFilesList.innerHTML = '';
        statementsDOM.examFilesList.appendChild(frag);
      }
    }

    function handleExamFilesChange() {
      if (!statementsDOM.examFilesInput) return;
      const incoming = Array.from(statementsDOM.examFilesInput.files || []);
      if (!incoming.length) return;
      let currentTotal = examSelectedFiles.reduce((acc, f) => acc + (f.size || 0), 0);
      for (const file of incoming) {
        if (!/\.(zip|rar|pdf|jpg|jpeg|png|doc|docx)$/i.test(file.name || '')) {
          alert(`ფაილის ტიპი არ არის დაშვებული (${file.name}). დასაშვებია: PDF, JPG, JPEG, PNG, DOC, DOCX, ZIP, RAR`);
          statementsDOM.examFilesInput.value = '';
          return;
        }
        if ((file.size || 0) + currentTotal > 100 * 1024 * 1024) {
          alert('ფაილების ჯამური ზომა აღემატება 100MB-ს');
          statementsDOM.examFilesInput.value = '';
          return;
        }
        const exists = examSelectedFiles.some((f) => f.name === file.name && f.size === file.size);
        if (!exists) {
          examSelectedFiles.push(file);
          currentTotal += (file.size || 0);
        }
      }
      statementsDOM.examFilesInput.value = '';
      renderExamFilesList();
    }

    function syncExamSelectionState(changedInput) {
      if (!statementsDOM.examForm) return;
      const categoryInputs = Array.from(
        statementsDOM.examForm.querySelectorAll?.('input[name="exam_category"]') || []
      );
      if (changedInput && changedInput.name === 'exam_category' && changedInput.checked) {
        categoryInputs.forEach((inp) => {
          if (inp !== changedInput) inp.checked = false;
        });
      }
      categoryInputs.forEach((inp) => {
        const optionLabel = inp.closest?.('.exam-category-option');
        optionLabel?.classList?.toggle?.('is-selected', !!inp.checked);
      });
      if (statementsDOM.examConfirmCheckbox) {
        const confirmLabel = statementsDOM.examConfirmCheckbox.closest?.('.exam-confirm-option')
          || document.getElementById('examConfirmLabel');
        confirmLabel?.classList?.toggle?.('is-selected', !!statementsDOM.examConfirmCheckbox.checked);
      }
    }

    async function handleExamApplicationSubmit(event) {
      event.preventDefault();
      if (!statementsDOM.examForm) return;
      if (!isLoggedIn()) {
        alert('გთხოვთ გაიაროთ ავტორიზაცია');
        return;
      }
      const actorEmail = getActorEmail();
      if (!actorEmail) {
        alert('ავტორიზაცია ვერ დადასტურდა');
        return;
      }

      const checkedCategoryInput = statementsDOM.examForm.querySelector?.('input[name="exam_category"]:checked');
      const selectedCategory = (checkedCategoryInput?.value || '').toString().trim();
      if (!selectedCategory) {
        alert('გთხოვთ მონიშნოთ მოთხოვნილი სერტიფიკატის კატეგორია (პუნქტი 1)');
        return;
      }

      if (!statementsDOM.examConfirmCheckbox?.checked) {
        alert('გთხოვთ მონიშნოთ განმცხადებლის დადასტურება (პუნქტი 4)');
        return;
      }

      const user = getCurrentUser();
      const fullName = user
        ? `${user.firstName || user.first_name || ''} ${user.lastName || user.last_name || ''}`.trim()
        : '';
      const filesLine = examSelectedFiles.length
        ? examSelectedFiles.map((f) => f.name).join(', ')
        : 'არ არის წარმოდგენილი';
      const extraInfo = (statementsDOM.examAdditionalInfo?.value || '').toString().trim() || '—';

      const message = [
        'სერტიფიცირების განაცხადი',
        '',
        '1. მოთხოვნილი სერტიფიკატის კატეგორია',
        'ვითხოვ სასერტიფიკაციო გამოცდაზე დაშვებას და ქვემოთ მონიშნული კატეგორიის სერტიფიკატის გაცემას:',
        `☑ ${selectedCategory}`,
        '',
        '2. თანდართული დოკუმენტები',
        `ატვირთული ფაილ(ებ)ი: ${filesLine}`,
        '',
        '3. დამატებითი ინფორმაცია / სპეციალური საჭიროება გამოცდაზე (არსებობისას)',
        extraInfo,
        '',
        '4. განმცხადებლის დადასტურება',
        '☑ ვადასტურებ, რომ გავეცანი საიტზე gipc.org.ge გამოქვეყნებულ სერტიფიცირების პირობებს, წარმოდგენილი დოკუმენტები უტყუარია, ვიღებ ვალდებულებას შევასრულო სერტიფიცირების მოთხოვნები, წარვადგინო შეფასებისთვის საჭირო ნებისმიერი ინფორმაცია და თანახმა ვარ ჩემი პერსონალური მონაცემების დამუშავებაზე სერტიფიცირების მიზნებისთვის.',
        '',
        `განმცხადებელი: ${fullName || '—'} (დადასტურებულია ელექტრონულად).`,
      ].join('\n');

      const body = new FormData();
      body.set('message', message);
      if (examSelectedFiles.length === 1) {
        body.set('attachment', examSelectedFiles[0]);
      } else if (examSelectedFiles.length > 1) {
        examSelectedFiles.forEach((f) => {
          if (typeof body.append === 'function') body.append('attachments', f);
        });
      }

      const submitBtn = statementsDOM.examSubmitBtn || statementsDOM.examForm.querySelector?.('button[type="submit"]');
      submitBtn?.setAttribute('disabled', 'true');
      try {
        const response = await fetch(`${API_BASE}/statements`, {
          method: 'POST',
          headers: { ...getActorHeaders() },
          body,
          credentials: 'include',
        });
        if (!response.ok) {
          let detail = '';
          try {
            const json = await response.clone().json();
            detail = json?.detail || '';
          } catch {
            try { detail = (await response.clone().text()).trim(); } catch {}
          }
          throw new Error(detail || 'გაგზავნა ვერ შესრულდა');
        }
        const data = await response.json();
        const docNumNotice = data?.doc_number ? ` (დოკუმენტის №: ${data.doc_number})` : '';
        alert(`თქვენი განაცხადი მიღებულია!${docNumNotice}`);
        statementsDOM.examForm.reset?.();
        syncExamSelectionState();
        examSelectedFiles = [];
        renderExamFilesList();
        setMetaFromUser();
        handleNewStatement(data);
      } catch (error) {
        alert(error.message || 'გაგზავნა ვერ შესრულდა');
      } finally {
        submitBtn?.removeAttribute('disabled');
      }
    }

    async function handleComposeSubmit(event) {
      event.preventDefault();
      if (!statementsDOM.statementsForm) return;
      if (!isLoggedIn()) {
        alert('გთხოვთ გაიაროთ ავტორიზაცია');
        return;
      }
      const actorEmail = getActorEmail();
      if (!actorEmail) {
        alert('ავტორიზაცია ვერ დადასტურდა');
        return;
      }

      const fd = new FormData(statementsDOM.statementsForm);
      const message = (fd.get('message') || '').toString().trim();
      if (!message) return alert('გთხოვთ შეიყვანოთ შეტყობინება');

      const fileInput = statementsDOM.statementFileInput || statementsDOM.statementsForm.querySelector('input[name="attachment"]');
      const file = fileInput && fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      if (file) {
        if (file.size > 100 * 1024 * 1024) {
          alert('ფაილი აღემატება 100MB-ს');
          return;
        }
        if (!/\.(zip|rar|pdf|jpg|jpeg|png|doc|docx)$/i.test(file.name || '')) {
          alert('დასაშვებია: ZIP, RAR, PDF, JPEG, PNG, WORD');
          return;
        }
      }

      const body = new FormData();
      body.set('message', message);
      if (file) body.set('attachment', file);

      const submitBtn = statementsDOM.statementsForm.querySelector('button[type="submit"]');
      submitBtn?.setAttribute('disabled', 'true');
      try {
        const response = await fetch(`${API_BASE}/statements`, {
          method: 'POST',
          headers: { ...getActorHeaders() },
          body,
          credentials: 'include',
        });
        if (!response.ok) {
          let detail = '';
          try {
            const json = await response.clone().json();
            detail = json?.detail || '';
          } catch {
            try { detail = (await response.clone().text()).trim(); } catch {}
          }
          throw new Error(detail || 'გაგზავნა ვერ შესრულდა');
        }
        const data = await response.json();
        const docNumNotice = data?.doc_number ? ` (დოკუმენტის №: ${data.doc_number})` : '';
        alert(`თქვენი განცხადება მიღებულია!${docNumNotice}`);
        statementsDOM.statementsForm.reset();
        updateFileDisplay();
        handleNewStatement(data);
      } catch (error) {
        alert(error.message || 'გაგზავნა ვერ შესრულდა');
      } finally {
        submitBtn?.removeAttribute('disabled');
      }
    }

    function handleNewStatement(statement) {
      if (!statement || typeof statement !== 'object') return;
      cache = [statement, ...cache.filter((item) => item.id !== statement.id)];
      if (overlayOpen) {
        renderList(cache);
      }
    }

    function reset() {
      cache = [];
      examSelectedFiles = [];
      renderExamFilesList();
      syncExamSelectionState();
      if (overlayOpen) {
        closeOverlay();
      }
      if (statementsDOM.statementsList) statementsDOM.statementsList.innerHTML = '';
      if (statementsDOM.statementsMeta) statementsDOM.statementsMeta.textContent = '';
      updateCount(0);
    }

    function updateFileDisplay() {
      if (!statementsDOM.statementFileInput || !statementsDOM.statementFileDisplay) return;
      const file = statementsDOM.statementFileInput.files && statementsDOM.statementFileInput.files[0];
      if (file) {
        statementsDOM.statementFileDisplay.value = file.name;
        statementsDOM.statementFileControls?.classList?.add?.('has-file');
      } else {
        statementsDOM.statementFileDisplay.value = '';
        statementsDOM.statementFileControls?.classList?.remove?.('has-file');
      }
    }

    function init() {
      on(statementsDOM.statementsClose, 'click', closeOverlay);
      on(statementsDOM.statementsOverlay, 'click', handleBackdropClick);
      on(statementsDOM.statementsForm, 'submit', handleComposeSubmit);
      on(statementsDOM.statementsTextarea, 'mousedown', ensureAuthForCompose);
      on(statementsDOM.statementsTextarea, 'focus', ensureAuthForCompose);
      if (statementsDOM.tabExam) {
        on(statementsDOM.tabExam, 'click', () => switchStatementTab('exam'));
      }
      if (statementsDOM.tabOther) {
        on(statementsDOM.tabOther, 'click', () => switchStatementTab('other'));
      }
      if (statementsDOM.examForm) {
        on(statementsDOM.examForm, 'submit', handleExamApplicationSubmit);
        on(statementsDOM.examForm, 'change', (event) => {
          syncExamSelectionState(event?.target || null);
        });
      }
      if (statementsDOM.examFilesChoose) {
        on(statementsDOM.examFilesChoose, 'click', () => {
          if (statementsDOM.examFilesInput) statementsDOM.examFilesInput.click();
        });
      }
      if (statementsDOM.examFilesInput) {
        on(statementsDOM.examFilesInput, 'change', handleExamFilesChange);
      }
      if (statementsDOM.statementFileChoose) {
        on(statementsDOM.statementFileChoose, 'click', () => {
          if (statementsDOM.statementFileInput) statementsDOM.statementFileInput.click();
        });
      }
      if (statementsDOM.statementFileInput) {
        on(statementsDOM.statementFileInput, 'change', updateFileDisplay);
      }

      const appFormBtn = document.getElementById('appFormDownloadBtn');
      if (appFormBtn) {
        (async () => {
          try {
            const resp = await fetch(`${getApiBase()}/application-form/info`);
            if (resp.ok) {
              const info = await resp.json();
              if (info.available) {
                appFormBtn.disabled = false;
                appFormBtn.addEventListener('click', () => {
                  const a = document.createElement('a');
                  a.href = `${getApiBase()}/application-form/download`;
                  a.download = info.filename || 'form';
                  document.body.appendChild(a);
                  a.click();
                  document.body.removeChild(a);
                });
              }
            }
          } catch {}
        })();
      }

      document.addEventListener('auth:logout', reset);
      document.addEventListener('auth:login', setMetaFromUser);
      setMetaFromUser();
    }

    init();
    window.addEventListener('openStatements', () => {
      try { handleOpenRequest(); } catch {}
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadHeader, { once: true });
  } else {
    loadHeader();
  }
})();



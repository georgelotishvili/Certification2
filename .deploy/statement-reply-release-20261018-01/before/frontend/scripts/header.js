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
    // Public documents must always remain blank templates; personalized contracts are assembled only in Admin User Cards.
    return html ? String(html) : '';
  }

  // Site Documents - dynamic loading from API with sessionStorage cache
  let cachedDocuments = null;
  let cachedDocumentsKey = null;
  let currentModalDoc = null;
  const SITE_DOCS_CACHE_PREFIX = 'gipc_site_docs_v8_';

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
        content: populateContractHtmlForCurrentUser(d.content || '', d.contract_type),
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
              content: populateContractHtmlForCurrentUser(d.content || '', d.contract_type),
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
        content: populateContractHtmlForCurrentUser(d.content || '', d.contract_type),
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
    try {
      const API_BASE = getApiBase();
      const response = await fetch(`${API_BASE}/guide/documents`, { cache: 'no-cache' });
      if (!response.ok) return;
      const data = await response.json();
      const items = Array.isArray(data?.items)
        ? data.items.filter((item) => item && item.id && item.available !== false)
        : [];

      const desktopDropdown = document.querySelector('.about-dropdown');
      const mobileSubmenu = document.querySelector('.drawer-about-submenu');

      if (desktopDropdown) {
        desktopDropdown
          .querySelectorAll('.dropdown-item.guide, [data-guide-doc-id]')
          .forEach((el) => el.remove());
        items.forEach((doc) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'dropdown-item';
          btn.setAttribute('data-guide-doc-id', String(doc.id));
          btn.textContent = (doc.title || 'გზამკვლევი').trim() || 'გზამკვლევი';
          desktopDropdown.appendChild(btn);
        });
      }

      if (mobileSubmenu) {
        mobileSubmenu
          .querySelectorAll('.drawer-submenu-item.guide, [data-guide-doc-id]')
          .forEach((el) => el.remove());
        items.forEach((doc) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'drawer-submenu-item';
          btn.setAttribute('data-guide-doc-id', String(doc.id));
          btn.textContent = (doc.title || 'გზამკვლევი').trim() || 'გზამკვლევი';
          mobileSubmenu.appendChild(btn);
        });
      }
    } catch (err) {
      console.error('Failed to populate info dropdowns:', err);
    }
  }

  function stripLeadingBulletFromElement(el, leadingBulletRegex) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const firstTextNode = walker.nextNode();
    if (firstTextNode && firstTextNode.nodeValue) {
      firstTextNode.nodeValue = firstTextNode.nodeValue.replace(leadingBulletRegex, '');
    }
  }

  // Word inline სტილების გასუფთავება და ბულეტების კონვერტაცია
  function sanitizeWordStyles(container) {
    if (!container) return;
    try {
      // ყველა ელემენტის სტილების გასუფთავება (მკაცრად შავ-თეთრი)
      const allElements = container.querySelectorAll('*');
      allElements.forEach(el => {
        if (el.style) {
          el.style.fontSize = '';
          el.style.fontFamily = '';
          el.style.marginLeft = '';
          el.style.marginRight = '';
          el.style.paddingLeft = '';
          el.style.paddingRight = '';
          el.style.textIndent = '';
          el.style.color = '';
          el.style.backgroundColor = '';
          const tag = (el.tagName || '').toUpperCase();
          if ((tag === 'P' || tag === 'LI') && !(el.textContent || '').includes('___')) {
            el.style.textAlign = '';
          }
          if (el.style.cssText) {
            el.style.cssText = el.style.cssText.replace(/mso-[^;]+;?/gi, '');
          }
        }
        el.removeAttribute('class');
        el.removeAttribute('align');
        el.removeAttribute('color');
        el.removeAttribute('bgcolor');
      });

      // ბულეტიანი აბზაცების კონვერტაცია <ul>/<li>-ში (მხოლოდ სტრიქონის დასაწყისში)
      const bulletChars = '·•\\-–—■□►▪▸●○⁃◦◘◙';
      const bulletRegex = new RegExp('^[\\s\\u00A0]*[' + bulletChars + '][\\s\\u00A0]+');
      const paragraphs = Array.from(container.querySelectorAll('p'));
      
      let currentUl = null;
      let lastWasBullet = false;
      
      paragraphs.forEach(p => {
        const text = p.textContent || '';
        const isBullet = bulletRegex.test(text);
        
        if (isBullet) {
          const li = document.createElement('li');
          li.innerHTML = p.innerHTML;
          stripLeadingBulletFromElement(li, bulletRegex);
          
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

      // უკვე არსებული <li> ელემენტებიდანაც წავშალოთ მხოლოდ წინა ბულეტის სიმბოლო
      container.querySelectorAll('li').forEach(li => {
        stripLeadingBulletFromElement(li, bulletRegex);
      });

      // თუ დოკუმენტს უკვე აქვს სემანტიკური H1/H2 სათაურები, დამატებითი კლასები საჭირო არ არის
      if (!container.querySelector('h1, h2')) {
        const topParagraphs = Array.from(container.children).filter(el => el.tagName === 'P');
        const sectionHeadingRegex = /^(?:(?:ნაწილი|თავი|ეტაპი|ნაბიჯი|მუხლი|კატეგორია|დანართი)\s*[№#]?\s*[0-9IVX]+|[IVX]+\.|[0-9]{1,2}\.)\s+.+$/i;
        topParagraphs.forEach((p, idx) => {
          const fullText = (p.textContent || '').replace(/\s+/g, ' ').trim();
          if (!fullText) return;
          const boldChild = p.querySelector(':scope > strong, :scope > b');
          const isAllBold = Boolean(
            boldChild &&
            p.children.length === 1 &&
            (boldChild.textContent || '').replace(/\s+/g, ' ').trim() === fullText
          );
          if (idx === 0 && fullText.length <= 115 && (isAllBold || !/[.;,]$/.test(fullText))) {
            p.classList.add('site-doc-lead-title');
            return;
          }
          if (isAllBold && !/^\d+\.\d+/.test(fullText) && fullText.length <= 115) {
            p.classList.add('site-doc-section-title');
          } else if (sectionHeadingRegex.test(fullText) && fullText.length <= 105 && !/[;,]$/.test(fullText)) {
            p.classList.add('site-doc-section-title');
          }
        });
      }
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
    const marginX = 52;
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

    const drawFormattedLine = (lineText, x, y, targetWidth, isLastLine, align = 'justify') => {
      const clean = String(lineText || '').trim();
      if (!clean) return;
      if (align === 'center') {
        const w = pdf.getTextWidth(clean);
        pdf.text(clean, x + Math.max(0, (targetWidth - w) / 2), y);
        return;
      }
      if (align === 'justify' && !isLastLine && !clean.includes('___')) {
        const words = clean.split(/\s+/).filter(Boolean);
        if (words.length > 1) {
          const wordsWidth = words.reduce((sum, w) => sum + pdf.getTextWidth(w), 0);
          const extra = targetWidth - wordsWidth;
          if (extra > 0) {
            const gap = extra / (words.length - 1);
            let curX = x;
            words.forEach((word) => {
              pdf.text(word, curX, y);
              curX += pdf.getTextWidth(word) + gap;
            });
            return;
          }
        }
      }
      pdf.text(clean, x, y);
    };

    const tempContainer = document.createElement('div');
    const populatedHtml = populateContractHtmlForCurrentUser(doc.content || '', doc.contract_type);
    renderSafeDocumentHtml(tempContainer, populatedHtml);
    sanitizeWordStyles(tempContainer);

    const docTitle = String(doc.title || 'დოკუმენტი').replace(/\s+/g, ' ').trim();
    const hasOwnH1 = Boolean(tempContainer.querySelector('h1'));

    if (!hasOwnH1) {
      pdf.setFont(fontName, 'bold');
      pdf.setFontSize(13.5);
      pdf.setTextColor(0, 0, 0);
      const titleLines = pdf.splitTextToSize(docTitle, usableWidth);
      titleLines.forEach((line, idx) => {
        ensureSpace(19);
        drawFormattedLine(line, marginX, cursorY, usableWidth, idx === titleLines.length - 1, 'center');
        cursorY += 19;
      });
      cursorY += 10;
    }

    const writeWrappedBlock = (text, opts = {}) => {
      const normalized = String(text || '')
        .replace(/([ა-ჰa-zA-Z0-9])\/([ა-ჰa-zA-Z0-9])/g, '$1 / $2')
        .replace(/\s+/g, ' ')
        .trim();
      if (!normalized) return;
      const {
        x = marginX,
        width = usableWidth,
        fontStyle = 'normal',
        fontSize = 10.5,
        lineHeight = 16,
        spaceBefore = 0,
        spaceAfter = 7,
        align = 'justify',
        bottomBorder = false,
      } = opts;

      if (spaceBefore > 0 && cursorY > marginTop + 10) {
        cursorY += spaceBefore;
      }

      pdf.setFont(fontName, fontStyle);
      pdf.setFontSize(fontSize);
      pdf.setTextColor(0, 0, 0);

      const lines = pdf.splitTextToSize(normalized, width);
      if (!lines.length) return;

      // Prevent orphaned single heading line at page bottom
      if (fontStyle === 'bold' && spaceBefore >= 8) {
        ensureSpace(Math.min(lines.length * lineHeight + 24, 90));
      }

      lines.forEach((line, idx) => {
        ensureSpace(lineHeight);
        const isLast = idx === lines.length - 1;
        drawFormattedLine(line, x, cursorY, width, isLast, align);
        cursorY += lineHeight;
      });

      if (bottomBorder) {
        pdf.setDrawColor(0, 0, 0);
        pdf.setLineWidth(0.6);
        pdf.line(x, cursorY - lineHeight + 4, x + width, cursorY - lineHeight + 4);
        cursorY += 2;
      }

      cursorY += spaceAfter;
    };

    const renderTableNode = (tableEl) => {
      const rows = Array.from(tableEl.querySelectorAll('tr'));
      if (!rows.length) return;
      let maxCols = 0;
      const parsedRows = rows.map((tr) => {
        const cells = Array.from(tr.querySelectorAll('th, td'));
        if (cells.length > maxCols) maxCols = cells.length;
        const isHeader = cells.every((c) => c.tagName === 'TH');
        return {
          isHeader,
          tags: cells.map((c) => c.tagName),
          texts: cells.map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim()),
        };
      });
      if (!maxCols) return;

      let colWidths = Array(maxCols).fill(usableWidth / maxCols);
      if (maxCols === 2) {
        colWidths = [usableWidth * 0.30, usableWidth * 0.70];
      } else if (maxCols === 3) {
        colWidths = [usableWidth * 0.24, usableWidth * 0.50, usableWidth * 0.26];
      } else if (maxCols === 4) {
        const firstHeader = (parsedRows[0]?.texts?.[0] || '').trim();
        if (firstHeader === '№' || firstHeader === '#') {
          colWidths = [usableWidth * 0.07, usableWidth * 0.25, usableWidth * 0.34, usableWidth * 0.34];
        }
      }

      const cellPadX = 6;
      const cellPadY = 5;
      const lineH = 13.5;

      if (cursorY > marginTop + 10) cursorY += 6;

      parsedRows.forEach((row) => {
        pdf.setFontSize(9.5);
        const cellLines = [];
        let maxLines = 1;
        for (let c = 0; c < maxCols; c++) {
          const isBoldCell = row.isHeader || row.tags[c] === 'TH';
          pdf.setFont(fontName, isBoldCell ? 'bold' : 'normal');
          const txt = row.texts[c] || '';
          const wrapped = pdf.splitTextToSize(txt, Math.max(24, colWidths[c] - cellPadX * 2));
          cellLines.push(wrapped);
          if (wrapped.length > maxLines) maxLines = wrapped.length;
        }
        const rowHeight = maxLines * lineH + cellPadY * 2;
        ensureSpace(rowHeight + 4);

        let cellX = marginX;
        for (let c = 0; c < maxCols; c++) {
          const cw = colWidths[c];
          const isBoldCell = row.isHeader || row.tags[c] === 'TH';
          pdf.setDrawColor(0, 0, 0);
          pdf.setLineWidth(0.5);
          pdf.rect(cellX, cursorY, cw, rowHeight, 'S');
          pdf.setFont(fontName, isBoldCell ? 'bold' : 'normal');
          pdf.setTextColor(0, 0, 0);
          const lines = cellLines[c] || [];
          lines.forEach((ln, idx) => {
            pdf.text(ln, cellX + cellPadX, cursorY + cellPadY + 9.5 + idx * lineH);
          });
          cellX += cw;
        }
        cursorY += rowHeight;
      });
      cursorY += 10;
    };

    let seenH1 = false;

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

        if (tag === 'H1' || node.classList.contains('site-doc-lead-title')) {
          seenH1 = true;
          writeWrappedBlock(text, {
            fontStyle: 'bold',
            fontSize: 13.5,
            lineHeight: 18,
            spaceBefore: 0,
            spaceAfter: 4,
            align: 'center',
          });
          return;
        }

        if (tag === 'H2') {
          const isCenteredSubtitle =
            (node.getAttribute('style') || '').includes('center') ||
            (seenH1 && node.previousElementSibling?.tagName === 'H1');
          writeWrappedBlock(text, {
            fontStyle: 'bold',
            fontSize: 11.5,
            lineHeight: 16.5,
            spaceBefore: isCenteredSubtitle ? 2 : 12,
            spaceAfter: isCenteredSubtitle ? 10 : 6,
            align: isCenteredSubtitle ? 'center' : 'left',
            bottomBorder: !isCenteredSubtitle,
          });
          return;
        }

        if (tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6' || node.classList.contains('site-doc-section-title')) {
          writeWrappedBlock(text, {
            fontStyle: 'bold',
            fontSize: 10.5,
            lineHeight: 15.5,
            spaceBefore: 8,
            spaceAfter: 4,
            align: 'left',
          });
          return;
        }

        if (tag === 'UL' || tag === 'OL') {
          const items = Array.from(node.children).filter((el) => el.tagName === 'LI');
          items.forEach((li, idx) => {
            const liText = (li.textContent || '').replace(/\s+/g, ' ').trim();
            if (!liText) return;
            const prefix = tag === 'OL' ? `${idx + 1}. ` : '– ';
            writeWrappedBlock(`${prefix}${liText}`, {
              x: marginX,
              width: usableWidth,
              fontSize: 10.5,
              lineHeight: 16,
              spaceAfter: 5,
              align: 'justify',
            });
          });
          cursorY += 2;
          return;
        }

        if (tag === 'TABLE') {
          renderTableNode(node);
          return;
        }

        if (tag === 'P' || tag === 'BLOCKQUOTE') {
          const onlyBold = node.children.length === 1 && (node.children[0].tagName === 'STRONG' || node.children[0].tagName === 'B') &&
            (node.children[0].textContent || '').replace(/\s+/g, ' ').trim() === text;
          const isLeftField = text.includes('___') || onlyBold || /^(სახელი|პირადი|ტელეფონი|ელ\.?\s*ფოსტა|თარიღი|ხელმოწერა|საიდენტიფიკაციო|იურიდიული|წარმომადგენელი)/.test(text);
          writeWrappedBlock(text, {
            fontStyle: onlyBold ? 'bold' : 'normal',
            fontSize: 10.5,
            lineHeight: 16,
            spaceBefore: onlyBold ? 6 : 0,
            spaceAfter: 6,
            align: isLeftField ? 'left' : 'justify',
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
      pdf.setDrawColor(0, 0, 0);
      pdf.setLineWidth(0.5);
      pdf.line(marginX, footerY - 12, pageWidth - marginX, footerY - 12);

      pdf.setFont(fontName, 'normal');
      pdf.setFontSize(8.5);
      pdf.setTextColor(0, 0, 0);
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

      if (typeof docOrId === 'object' && docOrId !== null && docOrId.is_guide) {
        doc = { ...docOrId };
        const guideUrl = doc.id
          ? `${API_BASE}/guide/documents/${encodeURIComponent(doc.id)}`
          : `${API_BASE}/guide/document`;
        const resp = await fetch(guideUrl, { cache: 'no-cache' });
        if (resp.ok) {
          const freshGuide = await resp.json();
          doc = { ...freshGuide, is_guide: true };
        }
      } else if (typeof docOrId === 'object' && docOrId !== null && docOrId.id) {
        doc = { ...docOrId };
        // Always fetch fresh document from API so all documents (not just contracts) have latest content
        const resp = await fetch(`${API_BASE}/documents/${doc.id}`, {
          cache: 'no-cache',
          headers: { ...getOptionalAuthHeaders() },
        });
        if (resp.ok) doc = await resp.json();
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
        content: populateContractHtmlForCurrentUser(doc.content || '', doc.contract_type),
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
        content: populateContractHtmlForCurrentUser(rawDoc.content || '', rawDoc.contract_type),
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

  async function openGuideDocumentModal(docId = null, initialTitle = '') {
    const els = getSiteInfoElements();
    if (!els) return;

    currentModalDoc = null;
    if (els.downloadPdfBtn) {
      els.downloadPdfBtn.hidden = true;
      els.downloadPdfBtn.disabled = false;
    }
    if (els.title) els.title.textContent = (initialTitle || 'გზამკვლევი').trim() || 'გზამკვლევი';
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

    try {
      const API_BASE = getApiBase();
      const targetUrl = docId
        ? `${API_BASE}/guide/documents/${encodeURIComponent(docId)}`
        : `${API_BASE}/guide/document`;
      const response = await fetch(targetUrl, { cache: 'no-cache' });
      if (!response.ok) throw new Error('Guide document load failed');
      const guideDoc = await response.json();

      const docTitle = (guideDoc.title || initialTitle || 'გზამკვლევი').trim() || 'გზამკვლევი';
      if (els.title) els.title.textContent = docTitle;

      const hasHtmlContent = Boolean((guideDoc.content || '').replace(/<[^>]*>/g, '').trim());
      const hasDirectPdf = Boolean(
        guideDoc.download_url && String(guideDoc.filename || '').toLowerCase().endsWith('.pdf')
      );

      if (!guideDoc.available && !hasHtmlContent && !hasDirectPdf) {
        if (els.body) {
          const sheet = document.createElement('article');
          sheet.className = 'site-doc-sheet';
          const empty = document.createElement('p');
          empty.className = 'site-doc-empty';
          empty.textContent = 'ამ ეტაპზე დოკუმენტი არ არის განთავსებული.';
          sheet.appendChild(empty);
          els.body.replaceChildren(sheet);
        }
        return;
      }

      currentModalDoc = { ...guideDoc, title: docTitle, is_guide: true };
      if (els.downloadPdfBtn) {
        els.downloadPdfBtn.hidden = false;
      }

      if (els.body) {
        if (!hasHtmlContent && hasDirectPdf) {
          const iframe = document.createElement('iframe');
          iframe.className = 'site-doc-pdf-frame';
          iframe.src = `${API_BASE}${guideDoc.download_url}`;
          iframe.title = docTitle;
          els.body.replaceChildren(iframe);
        } else {
          renderSafeDocumentHtml(els.body, guideDoc.content || '');
          sanitizeWordStyles(els.body);
          const sheet = document.createElement('article');
          sheet.className = 'site-doc-sheet';
          sheet.replaceChildren(...els.body.childNodes);
          els.body.replaceChildren(sheet);
        }
      }
    } catch (err) {
      console.error('Failed to load guide document:', err);
      if (els?.body) {
        els.body.innerHTML = '<p class="site-info-state site-info-state--error">დოკუმენტი ვერ ჩაიტვირთა. სცადეთ მოგვიანებით.</p>';
      }
    }
  }

  async function openSiteInfo(type) {
    try {
      if (type === 'guide') {
        await openGuideDocumentModal();
        return;
      }

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
        els.body.dataset.infoMode = 'document';
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
      
      // Dynamic informational guide items (with data-guide-doc-id)
      const guideItem = closest(el, '[data-guide-doc-id]');
      if (guideItem && closest(guideItem, '.about-dropdown, .drawer-about-submenu')) {
        event.preventDefault();
        closeAboutDropdown();
        closeDrawerAboutSubmenu();
        if (DOM.body.classList.contains('menu-open')) closeMenu();
        const guideDocId = guideItem.getAttribute('data-guide-doc-id');
        if (guideDocId) openGuideDocumentModal(guideDocId, guideItem.textContent || '');
        return;
      }

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

  const HEADER_PARTIAL_URL = '../partials/header.html?v=20261101-doc4b';
  const HEADER_CACHE_KEY = 'gipc_header_partial_v20261101_doc4b';

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
    document.addEventListener('auth:logout', syncHeaderInitialAuthUI);

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
      examSlots: {
        id: {
          controls: document.getElementById('examIdFileControls'),
          choose: document.getElementById('examIdFilesChoose'),
          input: document.getElementById('examIdFilesInput'),
          display: document.getElementById('examIdFilesDisplay'),
          listWrap: document.getElementById('examIdFilesListWrap'),
          list: document.getElementById('examIdFilesList'),
        },
        diploma: {
          controls: document.getElementById('examDiplomaFileControls'),
          choose: document.getElementById('examDiplomaFilesChoose'),
          input: document.getElementById('examDiplomaFilesInput'),
          display: document.getElementById('examDiplomaFilesDisplay'),
          listWrap: document.getElementById('examDiplomaFilesListWrap'),
          list: document.getElementById('examDiplomaFilesList'),
        },
        experience: {
          controls: document.getElementById('examExperienceFileControls'),
          choose: document.getElementById('examExperienceFilesChoose'),
          input: document.getElementById('examExperienceFilesInput'),
          display: document.getElementById('examExperienceFilesDisplay'),
          listWrap: document.getElementById('examExperienceFilesListWrap'),
          list: document.getElementById('examExperienceFilesList'),
        },
      },
      examAdditionalInfo: document.getElementById('examAdditionalInfo'),
      examConfirmCheckbox: document.getElementById('examConfirmCheckbox'),
      examApplicantSignature: document.getElementById('examApplicantSignature'),
      examSubmitBtn: document.getElementById('examApplicationSubmit'),
    };

    let overlayOpen = false;
    let isLoading = false;
    let cache = [];
    const examSlotFiles = {
      id: [],
      diploma: [],
      experience: [],
    };
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
        
        const itemAttachments = Array.isArray(item.attachments) && item.attachments.length
          ? item.attachments
          : (item.attachment_filename ? [{ slot: 1, filename: item.attachment_filename }] : []);
        if (itemAttachments.length) {
          itemAttachments.forEach((att) => {
            if (!att?.filename) return;
            const slotNum = Number(att.slot) || 1;
            const attachmentWrapper = document.createElement('div');
            attachmentWrapper.className = 'statement-attachment';
            const downloadBtn = document.createElement('button');
            downloadBtn.type = 'button';
            downloadBtn.className = 'statement-attachment-download';
            downloadBtn.textContent = 'ჩამოტვირთვა';
            downloadBtn.addEventListener('click', async () => {
              try {
                const slotParam = slotNum > 1 ? `?slot=${encodeURIComponent(slotNum)}` : '';
                const resp = await fetch(`${API_BASE}/statements/${encodeURIComponent(item.id)}/attachment${slotParam}`, {
                  headers: { ...getActorHeaders() },
                  credentials: 'include',
                });
                if (!resp.ok) {
                  if (resp.status === 401) {
                    try {
                      if (typeof window.Auth?.clearSession === 'function') {
                        window.Auth.clearSession();
                      } else {
                        localStorage.setItem('authLoggedIn', 'false');
                        localStorage.removeItem('auth_token');
                        localStorage.removeItem('currentUser');
                        document.dispatchEvent(new CustomEvent('auth:logout'));
                      }
                    } catch {}
                    alert('გთხოვთ გაიაროთ ავტორიზაცია');
                    closeOverlay();
                    return;
                  }
                  alert('ფაილის ჩამოტვირთვა ვერ მოხერხდა');
                  return;
                }
                const blob = await resp.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = att.filename || 'attachment';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch {
                alert('ფაილის ჩამოტვირთვა ვერ მოხერხდა');
              }
            });
            const filenameSpan = document.createElement('span');
            filenameSpan.className = 'statement-attachment-filename';
            filenameSpan.textContent = att.filename;
            attachmentWrapper.appendChild(downloadBtn);
            attachmentWrapper.appendChild(filenameSpan);
            details.appendChild(attachmentWrapper);
          });
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
            try {
              if (typeof window.Auth?.clearSession === 'function') {
                window.Auth.clearSession();
              } else {
                localStorage.setItem('authLoggedIn', 'false');
                localStorage.removeItem('auth_token');
                localStorage.removeItem('currentUser');
                document.dispatchEvent(new CustomEvent('auth:logout'));
              }
            } catch {}
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

    function getAllExamSelectedFilesTotalSize() {
      return [...examSlotFiles.id, ...examSlotFiles.diploma, ...examSlotFiles.experience]
        .reduce((acc, f) => acc + (f.size || 0), 0);
    }

    function renderExamSlotFilesList(slotKey) {
      const slotDOM = statementsDOM.examSlots?.[slotKey];
      const files = examSlotFiles[slotKey] || [];
      if (!slotDOM?.display) return;
      if (!files.length) {
        slotDOM.display.value = '';
        slotDOM.controls?.classList?.remove?.('has-file');
        if (slotDOM.listWrap) slotDOM.listWrap.setAttribute('hidden', '');
        if (slotDOM.list) slotDOM.list.innerHTML = '';
        return;
      }
      slotDOM.display.value = files.length === 1
        ? files[0].name
        : `არჩეულია ${files.length} ფაილი`;
      slotDOM.controls?.classList?.add?.('has-file');
      if (slotDOM.listWrap) slotDOM.listWrap.removeAttribute('hidden');
      if (slotDOM.list) {
        const frag = document.createDocumentFragment();
        files.forEach((file, idx) => {
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
            files.splice(idx, 1);
            renderExamSlotFilesList(slotKey);
          });
          li.appendChild(nameSpan);
          li.appendChild(removeBtn);
          frag.appendChild(li);
        });
        slotDOM.list.innerHTML = '';
        slotDOM.list.appendChild(frag);
      }
    }

    function renderAllExamSlotFiles() {
      renderExamSlotFilesList('id');
      renderExamSlotFilesList('diploma');
      renderExamSlotFilesList('experience');
    }

    function resetAllExamSlotFiles() {
      examSlotFiles.id = [];
      examSlotFiles.diploma = [];
      examSlotFiles.experience = [];
      renderAllExamSlotFiles();
    }

    function handleExamSlotFilesChange(slotKey) {
      const slotDOM = statementsDOM.examSlots?.[slotKey];
      if (!slotDOM?.input) return;
      const incoming = Array.from(slotDOM.input.files || []);
      if (!incoming.length) return;
      const slotList = examSlotFiles[slotKey];
      let currentTotal = getAllExamSelectedFilesTotalSize();
      const validAdditions = [];
      for (const file of incoming) {
        if (!/\.(zip|rar|pdf|jpg|jpeg|png|doc|docx)$/i.test(file.name || '')) {
          alert(`ფაილის ტიპი არ არის დაშვებული (${file.name}). დასაშვებია: PDF, JPG, JPEG, PNG, DOC, DOCX, ZIP, RAR`);
          slotDOM.input.value = '';
          return;
        }
        const exists = slotList.some((f) => f.name === file.name && f.size === file.size)
          || validAdditions.some((f) => f.name === file.name && f.size === file.size);
        if (!exists) {
          if ((file.size || 0) + currentTotal > 100 * 1024 * 1024) {
            alert('ფაილების ჯამური ზომა აღემატება 100MB-ს');
            slotDOM.input.value = '';
            return;
          }
          validAdditions.push(file);
          currentTotal += (file.size || 0);
        }
      }
      slotList.push(...validAdditions);
      slotDOM.input.value = '';
      renderExamSlotFilesList(slotKey);
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

      const regimeInputs = Array.from(
        statementsDOM.examForm.querySelectorAll?.('input[name="exam_regime"]') || []
      );
      if (regimeInputs.length) {
        if (changedInput && changedInput.name === 'exam_regime') {
          if (changedInput.checked) {
            regimeInputs.forEach((inp) => {
              if (inp !== changedInput) inp.checked = false;
            });
          } else if (!regimeInputs.some((inp) => inp.checked)) {
            changedInput.checked = true;
          }
        }
        const checkedCategory = categoryInputs.find((inp) => inp.checked);
        const isOnlyCategoryC = Boolean(
          checkedCategory && String(checkedCategory.value || '').trim().startsWith('5)')
        );
        const standardInput = regimeInputs[0] || null;
        const transitionalInput = regimeInputs[1] || null;
        if (transitionalInput) {
          if (isOnlyCategoryC) {
            transitionalInput.checked = false;
            transitionalInput.disabled = true;
            if (standardInput) standardInput.checked = true;
          } else {
            transitionalInput.disabled = false;
          }
        }
        if (!regimeInputs.some((inp) => inp.checked) && standardInput) {
          standardInput.checked = true;
        }
        regimeInputs.forEach((inp) => {
          const optionLabel = inp.closest?.('.exam-category-option');
          optionLabel?.classList?.toggle?.('is-selected', !!inp.checked);
          optionLabel?.classList?.toggle?.('is-disabled', !!inp.disabled);
        });
      }

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

      const checkedRegimeInput = statementsDOM.examForm.querySelector?.('input[name="exam_regime"]:checked');
      const selectedRegime = (checkedRegimeInput?.value || '').toString().trim();
      if (!selectedRegime) {
        alert('გთხოვთ მონიშნოთ დაშვების რეჟიმი (პუნქტი 1)');
        return;
      }

      if (!examSlotFiles.id.length) {
        alert('გთხოვთ ატვირთოთ პირადობის დამადასტურებელი დოკუმენტის ასლი (პუნქტი 2.1)');
        return;
      }
      if (!examSlotFiles.diploma.length) {
        alert('გთხოვთ ატვირთოთ უმაღლესი განათლების დამადასტურებელი დოკუმენტის (დიპლომის) ასლი ან განმარტებითი ბარათი (პუნქტი 2.2)');
        return;
      }
      if (!examSlotFiles.experience.length) {
        alert('გთხოვთ ატვირთოთ პროფესიული გამოცდილების დამადასტურებელი დოკუმენტაცია (პუნქტი 2.3)');
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
      const idFilesLine = examSlotFiles.id.map((f) => f.name).join(', ');
      const diplomaFilesLine = examSlotFiles.diploma.map((f) => f.name).join(', ');
      const experienceFilesLine = examSlotFiles.experience.map((f) => f.name).join(', ');
      const extraInfo = (statementsDOM.examAdditionalInfo?.value || '').toString().trim() || '—';

      const message = [
        'სერტიფიცირების განაცხადი',
        '',
        '1. მოთხოვნილი სერტიფიკატის კატეგორია და დაშვების რეჟიმი',
        'ვითხოვ სასერტიფიკაციო გამოცდაზე დაშვებას და ქვემოთ მონიშნული კატეგორიის სერტიფიკატის გაცემას:',
        `☑ ${selectedCategory}`,
        '',
        'დაშვების რეჟიმი:',
        `☑ ${selectedRegime}`,
        '',
        '2. თანდართული დოკუმენტები',
        `• 2.1. პირადობის დამადასტურებელი დოკუმენტის ასლი: ${idFilesLine}`,
        `• 2.2. უმაღლესი განათლების დამადასტურებელი დოკუმენტის (დიპლომის) ასლი / განმარტებითი ბარათი: ${diplomaFilesLine}`,
        `• 2.3. პროფესიული გამოცდილების დამადასტურებელი დოკუმენტაცია: ${experienceFilesLine}`,
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
      body.set('is_exam_application', 'true');
      examSlotFiles.id.forEach((f) => {
        if (typeof body.append === 'function') body.append('id_attachments', f);
      });
      examSlotFiles.diploma.forEach((f) => {
        if (typeof body.append === 'function') body.append('diploma_attachments', f);
      });
      examSlotFiles.experience.forEach((f) => {
        if (typeof body.append === 'function') body.append('experience_attachments', f);
      });

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
          if (response.status === 401) {
            try {
              if (typeof window.Auth?.clearSession === 'function') {
                window.Auth.clearSession();
              } else {
                localStorage.setItem('authLoggedIn', 'false');
                localStorage.removeItem('auth_token');
                localStorage.removeItem('currentUser');
                document.dispatchEvent(new CustomEvent('auth:logout'));
              }
            } catch {}
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
          throw new Error(detail || 'გაგზავნა ვერ შესრულდა');
        }
        const data = await response.json();
        const docNumNotice = data?.doc_number ? ` (დოკუმენტის №: ${data.doc_number})` : '';
        alert(`თქვენი განაცხადი მიღებულია!${docNumNotice}`);
        statementsDOM.examForm.reset?.();
        syncExamSelectionState();
        resetAllExamSlotFiles();
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
          if (response.status === 401) {
            try {
              if (typeof window.Auth?.clearSession === 'function') {
                window.Auth.clearSession();
              } else {
                localStorage.setItem('authLoggedIn', 'false');
                localStorage.removeItem('auth_token');
                localStorage.removeItem('currentUser');
                document.dispatchEvent(new CustomEvent('auth:logout'));
              }
            } catch {}
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
      resetAllExamSlotFiles();
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
      (['id', 'diploma', 'experience']).forEach((slotKey) => {
        const slotDOM = statementsDOM.examSlots?.[slotKey];
        if (slotDOM?.choose) {
          on(slotDOM.choose, 'click', () => {
            if (slotDOM.input) slotDOM.input.click();
          });
        }
        if (slotDOM?.input) {
          on(slotDOM.input, 'change', () => handleExamSlotFilesChange(slotKey));
        }
      });
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
      syncExamSelectionState();
    }

    init();
    window.addEventListener('openStatements', () => {
      try { handleOpenRequest(); } catch {}
    });
  }

  function initPublicAiAssistant() {
    if (document.getElementById('publicAiFab') || window.location.pathname.includes('admin.html')) {
      return;
    }

    const STORAGE_KEY = 'gipc_public_ai_chat_history_v2';
    const API_BASE = getApiBase();

    const ICONS = {
      sparkle: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/><path d="M5 3v4"/><path d="M3 5h4"/></svg>`,
      book: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/></svg>`,
      expand: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/></svg>`,
      trash: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>`,
      close: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
      send: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
    };

    let isOpen = false;
    let isExpanded = false;
    let isSending = false;
    let pubStatus = {
      enabled: true,
      configured: false,
      model_label: 'Gemini 4 Argon',
      reasoning_level_short: 'High',
      knowledge_base_files_count: 45,
    };
    let messages = [];

    function escapeHtmlSafe(val) {
      return String(val ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatInlineMd(str) {
      return str
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    }

    function formatMarkdownSimple(text) {
      const safe = escapeHtmlSafe(text);
      const lines = safe.split(/\r?\n/);
      const htmlLines = [];
      let inList = false;

      for (const rawLine of lines) {
        const line = rawLine.trimEnd();
        const bulletMatch = line.match(/^\s*[-*•]\s+(.*)$/);
        const numMatch = line.match(/^\s*(\d+[.)])\s+(.*)$/);

        if (bulletMatch || numMatch) {
          if (!inList) {
            htmlLines.push('<ul class="ai-msg-list">');
            inList = true;
          }
          const itemContent = bulletMatch ? bulletMatch[1] : `${numMatch[1]} ${numMatch[2]}`;
          htmlLines.push(`<li>${formatInlineMd(itemContent)}</li>`);
          continue;
        }

        if (inList) {
          htmlLines.push('</ul>');
          inList = false;
        }

        if (/^#{1,3}\s+/.test(line)) {
          const headingText = line.replace(/^#{1,3}\s+/, '');
          htmlLines.push(`<div class="ai-msg-heading">${formatInlineMd(headingText)}</div>`);
        } else if (!line.trim()) {
          htmlLines.push('<div class="ai-msg-spacer"></div>');
        } else {
          htmlLines.push(`<p class="ai-msg-p">${formatInlineMd(line)}</p>`);
        }
      }

      if (inList) {
        htmlLines.push('</ul>');
      }
      return htmlLines.join('');
    }

    function loadHistory() {
      try {
        const raw = window.sessionStorage?.getItem?.(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            messages = parsed.slice(-24);
          }
        }
      } catch {
        messages = [];
      }
    }

    function saveHistory() {
      try {
        window.sessionStorage?.setItem?.(STORAGE_KEY, JSON.stringify(messages.slice(-24)));
      } catch {}
    }

    const fabEl = document.createElement('button');
    fabEl.type = 'button';
    fabEl.id = 'publicAiFab';
    fabEl.className = 'ai-assistant-fab';
    fabEl.innerHTML = `
      <span class="ai-fab-icon">${ICONS.sparkle}</span>
      <span class="ai-fab-label">AI ასისტენტი</span>
      <span class="ai-fab-status-dot is-ready"></span>
    `;
    document.body.appendChild(fabEl);

    const panelEl = document.createElement('aside');
    panelEl.id = 'publicAiPanel';
    panelEl.className = 'ai-assistant-panel';
    panelEl.hidden = true;
    panelEl.innerHTML = `
      <div class="ai-panel-header">
        <div class="ai-panel-header-left">
          <div class="ai-panel-title-row">
            <span class="ai-panel-brand-badge">${ICONS.sparkle}</span>
            <h3 class="ai-panel-title">AI კონსულტანტი</h3>
          </div>
        </div>
        <div class="ai-panel-header-actions">
          <button type="button" class="ai-panel-icon-btn ai-btn-expand" title="ფანჯრის გაფართოება / დაპატარავება">${ICONS.expand}</button>
          <button type="button" class="ai-panel-icon-btn ai-btn-clear" title="ჩატის გასუფთავება">${ICONS.trash}</button>
          <button type="button" class="ai-panel-icon-btn ai-btn-close" title="დახურვა">${ICONS.close}</button>
        </div>
      </div>

      <div class="ai-quick-toolbar" role="toolbar" aria-label="ხშირად დასმული საკითხები">
        <button type="button" class="ai-quick-chip" data-question="რა კატეგორიებით ხდება არქიტექტორთა და ექსპერტთა სერტიფიცირება (A, B, C) და რა წინაპირობებია საჭირო?">
          <span>კატეგორიები და პირობები</span>
        </button>
        <button type="button" class="ai-quick-chip" data-question="როგორ ტარდება სასერტიფიკაციო გამოცდა, რა არის გამსვლელი ქულა და რა ღირს გამოცდა და სერტიფიცირება?">
          <span>გამოცდა და საფასური</span>
        </button>
        <button type="button" class="ai-quick-chip" data-question="როგორ და რა დოკუმენტებით უნდა წარვადგინო სერტიფიცირების განაცხადი საიტზე gipc.org.ge?">
          <span>განაცხადის წარდგენა</span>
        </button>
      </div>

      <div class="ai-messages-container" id="publicAiMessages"></div>

      <form class="ai-input-bar" id="publicAiForm">
        <textarea class="ai-chat-input" id="publicAiInput" rows="1" placeholder="დასვით კითხვა..."></textarea>
        <button type="submit" class="ai-chat-send-btn" id="publicAiSendBtn"><span>გაგზავნა</span>${ICONS.send}</button>
      </form>
    `;
    document.body.appendChild(panelEl);

    const fabDotEl = fabEl.querySelector('.ai-fab-status-dot');
    const messagesEl = document.getElementById('publicAiMessages');
    const formEl = document.getElementById('publicAiForm');
    const inputEl = document.getElementById('publicAiInput');
    const sendBtnEl = document.getElementById('publicAiSendBtn');

    function isExamActiveOnPage() {
      if (document.body.classList.contains('exam-active')) return true;
      const examModal = document.getElementById('examModal') || document.getElementById('examOverlay');
      if (examModal && (examModal.classList.contains('open') || examModal.classList.contains('show') || examModal.getAttribute('aria-hidden') === 'false')) {
        return true;
      }
      return false;
    }

    function syncVisibilityAndStatus() {
      if (!pubStatus.enabled || isExamActiveOnPage()) {
        fabEl.hidden = true;
        panelEl.hidden = true;
        isOpen = false;
        fabEl.classList.remove('is-open');
        return;
      }
      fabEl.hidden = false;
      const ready = Boolean(pubStatus.configured);
      if (fabDotEl) {
        fabDotEl.className = `ai-fab-status-dot ${ready ? 'is-ready' : 'is-unconfigured'}`;
      }
    }

    async function fetchPublicStatus() {
      try {
        const resp = await fetch(`${API_BASE}/guide/ai/status`, { cache: 'no-cache' });
        if (!resp.ok) return;
        const data = await resp.json();
        pubStatus = { ...pubStatus, ...data };
        syncVisibilityAndStatus();
      } catch {}
    }

    function renderMessages() {
      if (!messagesEl) return;
      messagesEl.innerHTML = '';

      if (!messages.length && !isSending) {
        const empty = document.createElement('div');
        empty.className = 'ai-empty-chat-hint';
        empty.innerHTML = `
          <div class="ai-empty-chat-hint-icon">${ICONS.sparkle}</div>
          <span>გამარჯობა! მე ვარ <strong>საქართველოს პროფესიული სერტიფიცირების ინსტიტუტის (GIPC)</strong> ოფიციალური AI კონსულტანტი. დამისვით ნებისმიერი შეკითხვა სერტიფიცირების სქემის, კატეგორიების (A, B, C), საგამოცდო პროცედურის, საფასურების, ვადების ან ხელშეკრულებების შესახებ.</span>
        `;
        messagesEl.appendChild(empty);
        return;
      }

      messages.forEach((msg) => {
        const itemEl = document.createElement('div');
        itemEl.className = `ai-msg-item ${msg.role === 'user' ? 'is-user' : 'is-assistant'}`;

        const bubble = document.createElement('div');
        bubble.className = 'ai-msg-bubble';

        const contentDiv = document.createElement('div');
        contentDiv.className = 'ai-msg-content';
        contentDiv.innerHTML = formatMarkdownSimple(msg.content);
        bubble.appendChild(contentDiv);

        itemEl.appendChild(bubble);
        messagesEl.appendChild(itemEl);
      });

      if (isSending) {
        const loadingEl = document.createElement('div');
        loadingEl.className = 'ai-msg-item is-assistant is-loading';
        loadingEl.innerHTML = `
          <div class="ai-msg-bubble">
            <span class="ai-typing-indicator">${ICONS.sparkle} <span>AI კონსულტანტი ამოწმებს ოფიციალურ დოკუმენტებს...</span></span>
          </div>
        `;
        messagesEl.appendChild(loadingEl);
      }

      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function togglePanel(force) {
      if (!pubStatus.enabled || isExamActiveOnPage()) return;
      isOpen = typeof force === 'boolean' ? force : !isOpen;
      panelEl.hidden = !isOpen;
      fabEl.classList.toggle('is-open', isOpen);
      if (isOpen) {
        renderMessages();
        setTimeout(() => inputEl?.focus(), 20);
      }
    }

    async function sendQuestion(text) {
      const clean = String(text || '').trim();
      if (!clean || isSending) return;
      if (!isOpen) togglePanel(true);

      messages.push({
        role: 'user',
        content: clean,
        timestamp: new Date().toISOString(),
      });
      saveHistory();
      isSending = true;
      if (sendBtnEl) sendBtnEl.disabled = true;
      renderMessages();

      try {
        const apiMessages = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
        const resp = await fetch(`${API_BASE}/guide/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: apiMessages }),
        });

        if (!resp.ok) {
          let detail = 'დროებით ვერ მოხერხდა პასუხის მიღება.';
          try {
            const errJson = await resp.json();
            if (errJson?.detail) detail = String(errJson.detail);
          } catch {}
          throw new Error(detail);
        }

        const data = await resp.json();
        messages.push({
          role: 'assistant',
          content: data.reply || 'პასუხი მომზადებულია.',
          inspected_attachments: Array.isArray(data.inspected_attachments)
            ? data.inspected_attachments
            : [],
          timestamp: new Date().toISOString(),
        });
        saveHistory();
      } catch (err) {
        messages.push({
          role: 'assistant',
          content: `⚠️ ${err?.message || 'მოთხოვნა ვერ შესრულდა.'}`,
          inspected_attachments: [],
          timestamp: new Date().toISOString(),
        });
        saveHistory();
      } finally {
        isSending = false;
        if (sendBtnEl) sendBtnEl.disabled = false;
        renderMessages();
      }
    }

    on(fabEl, 'click', () => togglePanel());
    on(panelEl.querySelector('.ai-btn-close'), 'click', () => togglePanel(false));
    on(panelEl.querySelector('.ai-btn-expand'), 'click', () => {
      isExpanded = !isExpanded;
      panelEl.classList.toggle('is-expanded', isExpanded);
    });
    on(panelEl.querySelector('.ai-btn-clear'), 'click', () => {
      messages = [];
      saveHistory();
      renderMessages();
    });

    panelEl.querySelectorAll('.ai-quick-chip').forEach((chip) => {
      on(chip, 'click', () => {
        const q = chip.getAttribute('data-question') || chip.textContent.trim();
        void sendQuestion(q);
      });
    });

    function syncInputHeight() {
      if (!inputEl) return;
      inputEl.style.height = '40px';
      const nextH = Math.min(110, Math.max(40, inputEl.scrollHeight));
      inputEl.style.height = `${nextH}px`;
      inputEl.style.overflowY = inputEl.scrollHeight > 110 ? 'auto' : 'hidden';
    }

    on(inputEl, 'input', syncInputHeight);

    on(formEl, 'submit', (e) => {
      e.preventDefault();
      const text = String(inputEl?.value || '').trim();
      if (!text || isSending) return;
      inputEl.value = '';
      syncInputHeight();
      void sendQuestion(text);
    });

    on(inputEl, 'keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        formEl.requestSubmit();
      }
    });

    loadHistory();
    void fetchPublicStatus();

    window.PublicAiAssistant = {
      open: () => togglePanel(true),
      close: () => togglePanel(false),
      toggle: togglePanel,
    };

    document.addEventListener('click', (e) => {
      const trigger = closest(e.target, '[data-open-public-ai]');
      if (!trigger) return;
      e.preventDefault();
      const statementsOverlay = document.getElementById('userStatementsOverlay');
      if (statementsOverlay && statementsOverlay.classList.contains('open')) {
        document.getElementById('userStatementsClose')?.click();
      }
      const siteInfoModal = document.getElementById('siteInfoModal');
      if (siteInfoModal && siteInfoModal.classList.contains('open')) {
        siteInfoModal.querySelector('.modal-close')?.click();
      }
      togglePanel(true);
    });

    // Watch for exam modal activation so AI is hidden during exams
    const observer = new MutationObserver(() => {
      syncVisibilityAndStatus();
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      loadHeader();
      initPublicAiAssistant();
    }, { once: true });
  } else {
    loadHeader();
    initPublicAiAssistant();
  }
})();




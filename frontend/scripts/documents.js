(function () {
  'use strict';

  function getApiBase() {
    try {
      if (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === 'string') {
        return window.APP_CONFIG.API_BASE;
      }
    } catch {}
    return 'http://127.0.0.1:8000';
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

  function parseDocumentTitleAndCode(doc) {
    const rawTitle = String(doc?.title || 'უსათაურო დოკუმენტი').replace(/\s+/g, ' ').trim();
    const codeMatch = rawTitle.match(/\(([A-Z]{2,}-[A-Z0-9-]+)\)\s*$/);
    if (codeMatch) {
      const cleanTitle = rawTitle.slice(0, codeMatch.index).trim() || rawTitle;
      return { title: cleanTitle, code: codeMatch[1], fullTitle: rawTitle };
    }
    const contentMatch = String(doc?.content || '').match(/GIPC-[A-Z]+-\d+/);
    return {
      title: rawTitle,
      code: contentMatch ? contentMatch[0] : '',
      fullTitle: rawTitle,
    };
  }

  function initDocumentsPage() {
    const DOM = {
      totalCount: document.getElementById('documentsTotalCount'),
      resultsCount: document.getElementById('documentsResultsCount'),
      searchInput: document.getElementById('documentsSearch'),
      searchClear: document.getElementById('documentsSearchClear'),
      errorBox: document.getElementById('documentsError'),
      grid: document.getElementById('documentsGrid'),
    };

    if (!DOM.grid) return;

    let allDocuments = [];

    function renderDocuments(items, query = '') {
      const total = allDocuments.length;
      if (DOM.totalCount) DOM.totalCount.textContent = String(total);

      if (DOM.resultsCount) {
        if (!total) {
          DOM.resultsCount.textContent = '0 დოკუმენტი';
        } else if (query) {
          DOM.resultsCount.textContent = `${items.length} / ${total}`;
        } else {
          DOM.resultsCount.textContent = `${total} დოკუმენტი`;
        }
      }

      DOM.grid.setAttribute('aria-busy', 'false');

      if (!items.length) {
        DOM.grid.innerHTML = `<div class="documents-empty">${
          query
            ? 'მითითებული საძიებო სიტყვით დოკუმენტი ვერ მოიძებნა.'
            : 'ამ ეტაპზე დოკუმენტები არ არის ატვირთული.'
        }</div>`;
        return;
      }

      DOM.grid.innerHTML = items
        .map((doc, idx) => {
          const originalIdx = allDocuments.indexOf(doc);
          const displayNumber = String((originalIdx >= 0 ? originalIdx : idx) + 1).padStart(2, '0');
          const safeId = escapeHtml(String(doc.id));
          const parsed = parseDocumentTitleAndCode(doc);
          const safeTitle = escapeHtml(parsed.title);
          const safeFullTitle = escapeHtml(parsed.fullTitle);

          return `
            <article class="doc-public-card" role="listitem" tabindex="0" data-doc-card-id="${safeId}" aria-label="${safeFullTitle}">
              <div class="doc-public-index" aria-hidden="true">${displayNumber}</div>
              <div class="doc-public-body">
                <h2 class="doc-public-title">${safeTitle}</h2>
              </div>
              <div class="doc-public-actions">
                <button type="button" class="doc-public-view-btn" data-open-doc="${safeId}">
                  <span>დოკუმენტის ნახვა</span>
                </button>
                <button type="button" class="doc-public-pdf-btn" data-download-pdf="${safeId}" aria-label="${safeFullTitle} — PDF ჩამოტვირთვა">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span>PDF ჩამოტვირთვა</span>
                </button>
              </div>
            </article>
          `;
        })
        .join('');
    }

    function applyFilter() {
      const q = String(DOM.searchInput?.value || '').trim().toLowerCase();
      if (DOM.searchClear) {
        DOM.searchClear.hidden = !q;
      }
      if (!q) {
        renderDocuments(allDocuments, '');
        return;
      }
      const filtered = allDocuments.filter((doc) => {
        const title = String(doc.title || '').toLowerCase();
        const plain = String(doc.content || '').replace(/<[^>]*>/g, ' ').toLowerCase();
        return title.includes(q) || plain.includes(q);
      });
      renderDocuments(filtered, q);
    }

    async function loadDocuments() {
      DOM.grid.setAttribute('aria-busy', 'true');
      if (DOM.errorBox) DOM.errorBox.hidden = true;

      try {
        let docs = [];
        if (window.SiteDocuments?.fetchSiteDocuments) {
          docs = await window.SiteDocuments.fetchSiteDocuments(true);
        } else {
          const headers = {};
          try {
            const token = window.Auth?.getToken?.() || localStorage.getItem('access_token');
            if (token) headers.Authorization = `Bearer ${token}`;
          } catch {}
          const response = await fetch(`${getApiBase()}/documents`, { cache: 'no-cache', headers });
          if (!response.ok) throw new Error('Failed to load documents');
          const data = await response.json();
          docs = data.items || [];
        }
        allDocuments = Array.isArray(docs) ? docs : [];
        applyFilter();

        // Check if URL has ?doc=<id>
        try {
          const urlParams = new URLSearchParams(window.location.search);
          const requestedDocId = urlParams.get('doc');
          if (requestedDocId && !loadDocuments._openedInitialDoc) {
            loadDocuments._openedInitialDoc = true;
            const openRequested = () => {
              window.SiteDocuments?.openDocumentById?.(requestedDocId);
            };
            if (document.getElementById('siteInfoModal')) {
              openRequested();
            } else {
              document.addEventListener('headerReady', openRequested, { once: true });
            }
          }
        } catch {}
      } catch (err) {
        console.error('Failed to load public documents:', err);
        DOM.grid.setAttribute('aria-busy', 'false');
        if (DOM.errorBox) {
          DOM.errorBox.textContent = 'დოკუმენტების ჩატვირთვა ვერ მოხერხდა. გთხოვთ განაახლოთ გვერდი.';
          DOM.errorBox.hidden = false;
        }
      }
    }

    if (DOM.searchInput) {
      DOM.searchInput.addEventListener('input', applyFilter);
    }
    if (DOM.searchClear && DOM.searchInput) {
      DOM.searchClear.addEventListener('click', () => {
        DOM.searchInput.value = '';
        applyFilter();
        DOM.searchInput.focus();
      });
    }

    DOM.grid.addEventListener('click', (event) => {
      const target = event.target;
      if (!target) return;

      const pdfBtn = target.closest('[data-download-pdf]');
      if (pdfBtn) {
        event.preventDefault();
        event.stopPropagation();
        const docId = Number(pdfBtn.getAttribute('data-download-pdf'));
        const doc = allDocuments.find((d) => Number(d.id) === docId) || docId;
        if (window.SiteDocuments?.downloadDocumentPdf) {
          void window.SiteDocuments.downloadDocumentPdf(doc, pdfBtn);
        }
        return;
      }

      const card = target.closest('[data-doc-card-id]');
      if (card) {
        event.preventDefault();
        const docId = card.getAttribute('data-doc-card-id');
        if (docId && window.SiteDocuments?.openDocumentById) {
          void window.SiteDocuments.openDocumentById(docId);
        }
      }
    });

    DOM.grid.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target;
      if (!target || target.tagName === 'BUTTON') return;
      const card = target.closest('[data-doc-card-id]');
      if (card) {
        event.preventDefault();
        const docId = card.getAttribute('data-doc-card-id');
        if (docId && window.SiteDocuments?.openDocumentById) {
          void window.SiteDocuments.openDocumentById(docId);
        }
      }
    });

    document.addEventListener('auth:login', () => { void loadDocuments(); });
    document.addEventListener('auth:logout', () => { void loadDocuments(); });
    document.addEventListener('user:refreshed', () => { void loadDocuments(); });

    void loadDocuments();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDocumentsPage, { once: true });
  } else {
    initDocumentsPage();
  }
})();

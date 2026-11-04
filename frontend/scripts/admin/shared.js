(function (global) {
  const shared = {};

  const GEORGIA_TIME_ZONE = 'Asia/Tbilisi';
  const ISO_NO_TZ_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/;
  const ISO_WITH_SPACE_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/;
  let tbilisiDateTimeFormatter = null;

  function getTbilisiDateTimeFormatter() {
    if (!tbilisiDateTimeFormatter) {
      tbilisiDateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: GEORGIA_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    }
    return tbilisiDateTimeFormatter;
  }

  function normalizeIsoString(value) {
    if (!(typeof value === 'string')) return value;
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    if (trimmed.endsWith('Z')) return trimmed;
    if (/[+-]\d{2}:?\d{2}$/.test(trimmed)) return trimmed;
    if (ISO_NO_TZ_REGEX.test(trimmed)) return `${trimmed}Z`;
    if (ISO_WITH_SPACE_REGEX.test(trimmed)) return `${trimmed.replace(' ', 'T')}Z`;
    return trimmed;
  }

  function parseUtcDate(input) {
    if (!input) return null;
    if (input instanceof Date) {
      return Number.isNaN(input.getTime()) ? null : input;
    }
    const normalized = normalizeIsoString(String(input));
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  shared.arrayBufferToBase64 = function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return global.btoa(binary);
  };

  const scriptLoads = new Map();
  shared.loadExternalScript = function loadExternalScript(src) {
    if (scriptLoads.has(src)) return scriptLoads.get(src);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.dataset.dynamicSrc = src;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) {
          script.remove();
          reject(error);
        } else {
          script.dataset.loaded = 'true';
          resolve();
        }
      };
      const timeout = setTimeout(() => finish(new Error('Script loading timed out')), 30000);
      script.addEventListener('load', () => finish(), { once: true });
      script.addEventListener('error', () => finish(new Error('Script could not be loaded')), { once: true });
      try { document.head.appendChild(script); } catch (error) { finish(error); }
    });
    const retryable = promise.catch((error) => {
      scriptLoads.delete(src);
      throw error;
    });
    scriptLoads.set(src, retryable);
    return retryable;
  };

  shared.escapeHtml = function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  function getToastContainer() {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  shared.showToast = function showToast(message, type = 'success') {
    const container = getToastContainer();
    const toast = document.createElement('div');
    toast.className = `toast${type === 'error' ? ' error' : ''}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.textContent = String(message || '');
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 220);
    }, 2600);
  };

  shared.formatDateTime = function formatDateTime(iso) {
    if (!iso) return '';
    try {
      const date = parseUtcDate(iso);
      if (!date) return String(iso || '');
      const formatter = getTbilisiDateTimeFormatter();
      const parts = formatter.formatToParts(date);
      const mapped = parts.reduce((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
      }, {});
      const day = mapped.day || '00';
      const month = mapped.month || '00';
      const year = mapped.year || '0000';
      const hour = mapped.hour || '00';
      const minute = mapped.minute || '00';
      return `${day}-${month}-${year} ${hour}:${minute}`;
    } catch {
      return String(iso || '');
    }
  };

  shared.formatDuration = function formatDuration(startIso, endIso) {
    if (!startIso || !endIso) return '—';
    try {
      const start = parseUtcDate(startIso);
      const end = parseUtcDate(endIso);
      if (!start || !end || end <= start) return '—';
      const diffMs = end.getTime() - start.getTime();
      const totalSeconds = Math.floor(diffMs / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const parts = [];
      if (hours) parts.push(`${hours}სთ`);
      if (minutes || hours) parts.push(`${minutes}წთ`);
      parts.push(`${seconds}წმ`);
      return parts.join(' ');
    } catch {
      return '—';
    }
  };

  shared.handleAdminErrorResponse = async function handleAdminErrorResponse(response, fallbackMessage, showToastFn = shared.showToast) {
    if (!response) {
      showToastFn(fallbackMessage, 'error');
      return;
    }
    if (response.status === 401) {
      try { global.Auth?.clearSession?.(); global.localStorage?.setItem?.('authLoggedIn', 'false'); global.localStorage?.removeItem?.('auth_token'); global.localStorage?.removeItem?.('currentUser'); } catch {}
      showToastFn('ადმინის სესია არ არის ავტორიზებული', 'error');
      return;
    }
    let detail = '';
    try {
      const clone = response.clone();
      const data = await clone.json();
      const rawDetail = data?.detail ?? data?.message ?? '';
      if (Array.isArray(rawDetail)) {
        detail = rawDetail
          .map((item) => (typeof item === 'string' ? item : item?.msg || JSON.stringify(item)))
          .filter(Boolean)
          .join('; ');
      } else if (rawDetail && typeof rawDetail === 'object') {
        detail = rawDetail.msg || rawDetail.message || JSON.stringify(rawDetail);
      } else {
        detail = String(rawDetail || '');
      }
    } catch {
      try {
        const text = await response.clone().text();
        detail = (text || '').trim();
      } catch {}
    }
    showToastFn(detail || fallbackMessage, 'error');
  };

  shared.preparePdfSaveHandle = async function preparePdfSaveHandle(filename = 'document.pdf', options = {}) {
    const showToastFn = options.showToast || shared.showToast;
    if (typeof global.showSaveFilePicker !== 'function') {
      return { handle: null, aborted: false };
    }
    try {
      const handle = await global.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'PDF',
            accept: { 'application/pdf': ['.pdf'] },
          },
        ],
      });
      return { handle, aborted: false };
    } catch (error) {
      if (error?.name === 'AbortError') {
        showToastFn?.('ფაილის შენახვა გაუქმდა', 'info');
        return { handle: null, aborted: true };
      }
      return { handle: null, aborted: false };
    }
  };

  async function toPdfBlob(pdfInstance) {
    if (!pdfInstance || typeof pdfInstance.output !== 'function') {
      throw new Error('Invalid PDF instance');
    }
    const raw = pdfInstance.output('blob');
    if (raw instanceof Blob) {
      return raw;
    }
    if (raw && typeof raw.then === 'function') {
      const awaited = await raw;
      return awaited instanceof Blob ? awaited : new Blob([awaited], { type: 'application/pdf' });
    }
    if (raw == null) {
      throw new Error('PDF output was empty');
    }
    return raw instanceof Blob ? raw : new Blob([raw], { type: 'application/pdf' });
  }

  async function trySaveWithPicker(blob, filename, showToastFn) {
    if (typeof global.showSaveFilePicker !== 'function') {
      return false;
    }
    try {
      const handle = await global.showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'PDF',
            accept: { 'application/pdf': ['.pdf'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      showToastFn?.('PDF ფაილი შენახული იქნა', 'success');
      return true;
    } catch (error) {
      if (error?.name === 'AbortError') {
        showToastFn?.('ფაილის შენახვა გაუქმდა', 'info');
        return true;
      }
      return false;
    }
  }

  async function writeBlobToHandle(handle, blob, showToastFn) {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    showToastFn?.('PDF ფაილი შენახული იქნა', 'success');
    return true;
  }

  function openPdfInNewTab(blob, showToastFn) {
    const urlFactory = global.URL || global.webkitURL;
    if (!urlFactory || typeof urlFactory.createObjectURL !== 'function') {
      return false;
    }
    const blobUrl = urlFactory.createObjectURL(blob);
    const newWindow = global.open(blobUrl, '_blank');
    if (!newWindow || newWindow.closed) {
      urlFactory.revokeObjectURL(blobUrl);
      return false;
    }
    setTimeout(() => {
      try {
        urlFactory.revokeObjectURL(blobUrl);
      } catch {}
    }, 120000);
    showToastFn?.('PDF გაიხსნა ახალ ჩანართში, იქიდან შეგიძლია შეინახო', 'info');
    return true;
  }

  shared.deliverPdf = async function deliverPdf(pdfInstance, filename = 'certificate.pdf', options = {}) {
    const showToastFn = options.showToast || shared.showToast;
    const preHandle = options.handle || null;
    try {
      const blob = await toPdfBlob(pdfInstance);
      if (preHandle) {
        try {
          await writeBlobToHandle(preHandle, blob, showToastFn);
          return true;
        } catch {}
      }
      const saved = await trySaveWithPicker(blob, filename, showToastFn);
      if (saved) return true;
      const opened = openPdfInNewTab(blob, showToastFn);
      if (opened) return true;
      pdfInstance.save(filename);
      showToastFn?.('ბრაუზერმა ავტომატურად ჩამოტვირთა PDF', 'info');
      return true;
    } catch (error) {
      showToastFn?.('PDF-ის ჩამოტვირთვა ვერ მოხერხდა', 'error');
      return false;
    }
  };

  const AUDIT_CATEGORY_LABELS = {
    auth: 'ავტორიზაცია',
    exam: 'გამოცდა',
    grant: 'დაშვება',
    statement: 'განცხადება',
    letter: 'წერილი',
    certificate: 'სერტიფიკატი',
    registration: 'რეგისტრაცია',
  };

  function getAuditAuthHeaders() {
    try {
      if (global.Auth?.getAuthHeaders) {
        return global.Auth.getAuthHeaders();
      }
      const token = localStorage.getItem('auth_token');
      if (token) {
        return { Authorization: 'Bearer ' + token };
      }
    } catch {}
    return {};
  }

  function initAuditLogViewer() {
    const overlay = document.getElementById('auditLogModalOverlay');
    if (!overlay) return;

    const closeBtn = document.getElementById('auditLogModalClose');
    const refreshBtn = document.getElementById('auditLogRefreshBtn');
    const exportCsvBtn = document.getElementById('auditLogExportCsvBtn');
    const searchInput = document.getElementById('auditLogSearchInput');
    const categorySelect = document.getElementById('auditLogCategorySelect');
    const dateInput = document.getElementById('auditLogDateInput');
    const clearBtn = document.getElementById('auditLogClearFiltersBtn');
    const tableBody = document.getElementById('auditLogTableBody');
    const totalCountEl = document.getElementById('auditLogTotalCount');
    const lastUpdatedEl = document.getElementById('auditLogLastUpdated');

    let currentItems = [];
    let debounceTimer = null;

    function openModal() {
      overlay.classList.add('open');
      overlay.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      document.querySelector('.other-dropdown')?.classList.remove('show');
      document.querySelector('.nav-other')?.classList.remove('open');
      document.body.classList.remove('menu-open');
      loadAuditLogs();
    }

    function closeModal() {
      overlay.classList.remove('open');
      overlay.setAttribute('aria-hidden', 'true');
      if (!document.querySelector('.results-overlay.open')) {
        document.body.classList.remove('modal-open');
      }
    }

    function renderRows(items) {
      if (!tableBody) return;
      if (!Array.isArray(items) || !items.length) {
        tableBody.innerHTML = '<tr><td colspan="6" class="audit-log-empty">ჩანაწერები ვერ მოიძებნა</td></tr>';
        return;
      }
      tableBody.innerHTML = items.map((item) => {
        const cat = String(item.category || '').trim() || 'info';
        const catLabel = AUDIT_CATEGORY_LABELS[cat] || cat;
        const severity = String(item.severity || 'info').trim();
        const tsFormatted = shared.formatDateTime(item.timestamp);
        return `
          <tr class="audit-log-row is-${shared.escapeHtml(severity)}">
            <td class="audit-col-time">${shared.escapeHtml(tsFormatted)}</td>
            <td class="audit-col-cat"><span class="audit-cat-badge cat-${shared.escapeHtml(cat)}">${shared.escapeHtml(catLabel)}</span></td>
            <td class="audit-col-action">${shared.escapeHtml(item.action || '—')}</td>
            <td class="audit-col-actor">${shared.escapeHtml(item.actor || '—')}</td>
            <td class="audit-col-target">${shared.escapeHtml(item.target || '—')}</td>
            <td class="audit-col-details">${shared.escapeHtml(item.details || '—')}</td>
          </tr>
        `;
      }).join('');
    }

    async function loadAuditLogs() {
      if (!tableBody) return;
      tableBody.innerHTML = '<tr><td colspan="6" class="audit-log-empty">იტვირთება...</td></tr>';
      const apiBase = (global.APP_CONFIG && typeof global.APP_CONFIG.API_BASE === 'string')
        ? global.APP_CONFIG.API_BASE
        : '';
      const params = new URLSearchParams();
      const cat = (categorySelect?.value || 'all').trim();
      const search = (searchInput?.value || '').trim();
      const dateVal = (dateInput?.value || '').trim();
      params.set('category', cat || 'all');
      params.set('limit', '300');
      if (search) params.set('search', search);
      if (dateVal) params.set('date', dateVal);

      try {
        const response = await fetch(`${apiBase}/admin/audit-logs?${params.toString()}`, {
          headers: { ...getAuditAuthHeaders(), 'Cache-Control': 'no-cache' },
          credentials: 'include',
        });
        if (!response.ok) {
          await shared.handleAdminErrorResponse(response, 'ლოგირების ჩატვირთვა ვერ მოხერხდა', shared.showToast);
          tableBody.innerHTML = '<tr><td colspan="6" class="audit-log-empty">ჩატვირთვა ვერ მოხერხდა</td></tr>';
          return;
        }
        const data = await response.json();
        currentItems = Array.isArray(data?.items) ? data.items : [];
        const total = Number(data?.total ?? currentItems.length);
        if (totalCountEl) {
          totalCountEl.textContent = `ნაჩვენებია: ${currentItems.length} / სულ: ${total}`;
        }
        if (lastUpdatedEl) {
          lastUpdatedEl.textContent = `განახლდა: ${shared.formatDateTime(new Date().toISOString())}`;
        }
        renderRows(currentItems);
      } catch (err) {
        tableBody.innerHTML = '<tr><td colspan="6" class="audit-log-empty">სერვერთან დაკავშირება ვერ მოხერხდა</td></tr>';
      }
    }

    function exportCsv() {
      if (!currentItems.length) {
        shared.showToast('ექსპორტისთვის ჩანაწერები არ არის', 'info');
        return;
      }
      const headers = ['თარიღი/დრო', 'კატეგორია', 'მოქმედება', 'შემსრულებელი', 'ობიექტი/პირი', 'დეტალები'];
      const escapeCsv = (val) => `"${String(val ?? '').replace(/"/g, '""')}"`;
      const lines = [
        headers.map(escapeCsv).join(','),
        ...currentItems.map((it) => [
          shared.formatDateTime(it.timestamp),
          AUDIT_CATEGORY_LABELS[it.category] || it.category || '',
          it.action || '',
          it.actor || '',
          it.target || '',
          it.details || '',
        ].map(escapeCsv).join(',')),
      ];
      const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `gipc-audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    document.querySelectorAll('[data-open-audit-log="true"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openModal();
      });
    });

    closeBtn?.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) {
        closeModal();
      }
    });
    refreshBtn?.addEventListener('click', loadAuditLogs);
    exportCsvBtn?.addEventListener('click', exportCsv);
    categorySelect?.addEventListener('change', loadAuditLogs);
    dateInput?.addEventListener('change', loadAuditLogs);
    searchInput?.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(loadAuditLogs, 280);
    });
    clearBtn?.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      if (categorySelect) categorySelect.value = 'all';
      if (dateInput) dateInput.value = '';
      loadAuditLogs();
    });

    shared.openAuditLogModal = openModal;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuditLogViewer);
  } else {
    initAuditLogViewer();
  }

  global.AdminShared = shared;
})(window);



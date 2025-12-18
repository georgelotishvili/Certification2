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

  shared.loadExternalScript = function loadExternalScript(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-dynamic-src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === 'true') {
          resolve();
        } else {
          existing.addEventListener('load', () => resolve(), { once: true });
          existing.addEventListener('error', (error) => reject(error), { once: true });
        }
        return;
      }
      const script = document.createElement('script');
      script.src = src;
      script.async = true;
      script.defer = true;
      script.dataset.dynamicSrc = src;
      script.addEventListener('load', () => {
        script.dataset.loaded = 'true';
        resolve();
      }, { once: true });
      script.addEventListener('error', (error) => reject(error), { once: true });
      document.head.appendChild(script);
    });
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
      showToastFn('ადმინის სესია არ არის ავტორიზებული', 'error');
      return;
    }
    let detail = '';
    try {
      const clone = response.clone();
      const data = await clone.json();
      detail = data?.detail || data?.message || '';
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

  global.AdminShared = shared;
})(window);



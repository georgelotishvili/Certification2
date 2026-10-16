(function (global) {
  function createAppFilesModule(context) {
    const {
      API_BASE,
      on,
      escapeHtml,
      showToast,
      handleAdminErrorResponse,
      getAdminHeaders,
      getActorHeaders,
      formatDateTime,
    } = context;

    const state = {
      items: [],
      loading: false,
      uploading: false,
      downloads: new Map(),
    };

    const DOM = {
      grid: document.getElementById('appFilesGrid'),
      addBtn: document.getElementById('appAddFileBtn'),
      fileInput: document.getElementById('appFileInput'),
    };

    function ensureDom() {
      return !!(DOM.grid && DOM.addBtn && DOM.fileInput);
    }

    async function fetchFiles() {
      if (!DOM.grid) return;
      state.loading = true;
      DOM.grid.innerHTML = '<div class="empty-state">იტვირთება...</div>';
      try {
        const response = await fetch(`${API_BASE}/admin/app-files`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ფაილების ჩატვირთვა ვერ მოხერხდა', showToast);
          return;
        }
        const data = await response.json();
        state.items = Array.isArray(data) ? data.slice() : [];
        render();
      } catch {
        showToast('ფაილების ჩატვირთვა ვერ მოხერხდა', 'error');
        DOM.grid.innerHTML = '<div class="empty-state statements-error">ფაილების ჩატვირთვა ვერ მოხერხდა</div>';
      } finally {
        state.loading = false;
      }
    }

    function formatSize(bytes) {
      if (!bytes || typeof bytes !== 'number' || bytes <= 0) return '';
      const mb = bytes / (1024 * 1024);
      if (mb < 1) {
        const kb = bytes / 1024;
        return `${kb.toFixed(0)} KB`;
      }
      return `${mb.toFixed(1)} MB`;
    }

    function formatDownloadStats(receivedBytes, totalBytes, percent) {
      const receivedText = formatSize(receivedBytes) || '0 KB';
      const totalText = formatSize(totalBytes);
      if (totalText && percent != null) {
        return `${receivedText} / ${totalText} (${percent}%)`;
      }
      if (percent != null) {
        return `${percent}%`;
      }
      return receivedText;
    }

    function findCardElement(fileId) {
      if (!DOM.grid) return null;
      const cards = DOM.grid.querySelectorAll('.app-file-card');
      for (const card of cards) {
        if (String(card.dataset.fileId) === String(fileId)) {
          return card;
        }
      }
      return null;
    }

    function applyCardDownloadState(card, fileId) {
      if (!card) return;
      const key = String(fileId);
      const dl = state.downloads.get(key);
      const downloadBtn = card.querySelector('.app-file-download');
      const deleteBtn = card.querySelector('.head-delete');
      const progressWrap = card.querySelector('.app-file-progress');
      const statusEl = card.querySelector('.app-file-progress-status');
      const statsEl = card.querySelector('.app-file-progress-stats');
      const trackEl = card.querySelector('.app-file-progress-track');
      const fillEl = card.querySelector('.app-file-progress-fill');

      if (!dl) {
        card.classList.remove('is-downloading', 'is-download-complete');
        if (downloadBtn) {
          downloadBtn.disabled = false;
          downloadBtn.textContent = 'ჩამოტვირთვა';
        }
        if (deleteBtn) deleteBtn.disabled = false;
        if (progressWrap) progressWrap.hidden = true;
        if (fillEl) {
          fillEl.classList.remove('is-indeterminate');
          fillEl.style.width = '0%';
        }
        if (trackEl) trackEl.setAttribute('aria-valuenow', '0');
        return;
      }

      if (dl.status === 'completed') {
        card.classList.remove('is-downloading');
        card.classList.add('is-download-complete');
        if (downloadBtn) {
          downloadBtn.disabled = true;
          downloadBtn.textContent = 'ჩამოიტვირთა ✓';
        }
        if (deleteBtn) deleteBtn.disabled = false;
        if (progressWrap) progressWrap.hidden = false;
        if (statusEl) statusEl.textContent = 'ჩამოტვირთვა დასრულდა ✓';
        if (statsEl) {
          const finalBytes = dl.totalBytes || dl.receivedBytes;
          statsEl.textContent = formatDownloadStats(finalBytes, finalBytes, 100);
        }
        if (fillEl) {
          fillEl.classList.remove('is-indeterminate');
          fillEl.style.width = '100%';
        }
        if (trackEl) trackEl.setAttribute('aria-valuenow', '100');
        return;
      }

      card.classList.add('is-downloading');
      card.classList.remove('is-download-complete');
      const pctText = dl.percent != null ? ` ${dl.percent}%` : '';
      if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.innerHTML = `<span class="app-file-btn-spinner" aria-hidden="true"></span><span>იწერება...${pctText}</span>`;
      }
      if (deleteBtn) deleteBtn.disabled = true;
      if (progressWrap) progressWrap.hidden = false;
      if (statusEl) statusEl.textContent = 'მიმდინარეობს ჩამოტვირთვა...';
      if (statsEl) statsEl.textContent = formatDownloadStats(dl.receivedBytes, dl.totalBytes, dl.percent);
      if (fillEl) {
        const isIndeterminate = dl.percent == null;
        fillEl.classList.toggle('is-indeterminate', isIndeterminate);
        fillEl.style.width = isIndeterminate ? '38%' : `${Math.max(2, dl.percent)}%`;
      }
      if (trackEl) trackEl.setAttribute('aria-valuenow', String(dl.percent ?? 0));
    }

    function syncCardDownloadUI(fileId) {
      const card = findCardElement(fileId);
      if (card) applyCardDownloadState(card, fileId);
    }

    function render() {
      if (!DOM.grid) return;
      DOM.grid.innerHTML = '';

      if (!state.items.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state block-tile add-tile';
        empty.innerHTML = '<span class="add-text">ამ ეტაპზე საინსტალაციო ფაილი არ არის ატვირთული</span>';
        DOM.grid.appendChild(empty);
        return;
      }

      state.items.forEach((file) => {
        const card = document.createElement('div');
        card.className = 'block-tile block-card guide-video-card app-file-card';
        card.dataset.fileId = String(file.id);

        const sizeText = formatSize(file.size_bytes);
        const createdText = file.created_at ? formatDateTime(file.created_at) : '';

        card.innerHTML = `
          <div class="block-head guide-head app-file-head">
            <div class="guide-title app-file-title">
              <div class="guide-filename" title="${escapeHtml(file.filename || '')}">
                ${escapeHtml(file.filename || 'ფაილი')}
              </div>
              <div class="guide-meta">
                ${sizeText ? `<span>${escapeHtml(sizeText)}</span>` : ''}
                ${createdText ? `<span>${escapeHtml(createdText)}</span>` : ''}
              </div>
            </div>
            <div class="app-file-actions">
              <button class="primary-btn app-file-download" type="button">ჩამოტვირთვა</button>
              <button class="head-delete" type="button" aria-label="ფაილის წაშლა" title="წაშლა">×</button>
            </div>
          </div>
          <div class="app-file-progress" hidden>
            <div class="app-file-progress-meta">
              <span class="app-file-progress-status">მიმდინარეობს ჩამოტვირთვა...</span>
              <span class="app-file-progress-stats">0%</span>
            </div>
            <div class="app-file-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
              <div class="app-file-progress-fill"></div>
            </div>
          </div>
        `;

        applyCardDownloadState(card, file.id);
        DOM.grid.appendChild(card);
      });
    }

    async function uploadFile(file) {
      if (!file || state.uploading) return;
      state.uploading = true;
      const originalAddText = DOM.addBtn ? DOM.addBtn.textContent : 'ფაილის დამატება';
      if (DOM.addBtn) {
        DOM.addBtn.disabled = true;
        DOM.addBtn.textContent = 'იტვირთება... 0%';
      }

      try {
        const created = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `${API_BASE}/admin/app-files`, true);
          const headers = { ...getAdminHeaders(), ...getActorHeaders() };
          Object.entries(headers).forEach(([k, v]) => {
            if (v != null) xhr.setRequestHeader(k, String(v));
          });
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && DOM.addBtn) {
              const pct = Math.min(100, Math.round((event.loaded / event.total) * 100));
              DOM.addBtn.textContent = `იტვირთება... ${pct}%`;
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText));
              } catch {
                resolve(null);
              }
            } else {
              reject(new Error(`HTTP ${xhr.status}`));
            }
          };
          xhr.onerror = () => reject(new Error('Network error'));
          const formData = new FormData();
          formData.append('file', file);
          xhr.send(formData);
        });

        if (!created || typeof created !== 'object') {
          await fetchFiles();
          showToast('ფაილი ატვირთულია', 'success');
          return;
        }
        state.items.unshift(created);
        render();
        showToast('ფაილი ატვირთულია', 'success');
      } catch {
        showToast('ფაილის ატვირთვა ვერ მოხერხდა', 'error');
      } finally {
        state.uploading = false;
        if (DOM.addBtn) {
          DOM.addBtn.disabled = false;
          DOM.addBtn.textContent = originalAddText;
        }
      }
    }

    async function deleteFile(fileId) {
      if (state.downloads.has(String(fileId))) return;
      const confirmDelete = global.confirm('დარწმუნებული ხართ, რომ გინდათ ფაილის წაშლა?');
      if (!confirmDelete) return;

      try {
        const response = await fetch(`${API_BASE}/admin/app-files/${encodeURIComponent(fileId)}`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok && response.status !== 404) {
          await handleAdminErrorResponse(response, 'ფაილის წაშლა ვერ მოხერხდა', showToast);
          return;
        }
        state.items = state.items.filter((f) => String(f.id) !== String(fileId));
        render();
        showToast('ფაილი წაიშალა', 'success');
      } catch {
        showToast('ფაილის წაშლა ვერ მოხერხდა', 'error');
      }
    }

    async function downloadFile(fileId) {
      const key = String(fileId);
      if (state.downloads.has(key)) return;

      const file = state.items.find((f) => String(f.id) === key);
      if (!file) return;

      const knownTotal = Number(file.size_bytes) > 0 ? Number(file.size_bytes) : 0;
      state.downloads.set(key, {
        status: 'downloading',
        receivedBytes: 0,
        totalBytes: knownTotal,
        percent: knownTotal > 0 ? 0 : null,
      });
      syncCardDownloadUI(key);

      try {
        const response = await fetch(`${API_BASE}${file.url}`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) {
          state.downloads.delete(key);
          syncCardDownloadUI(key);
          showToast('ფაილის ჩამოტვირთვა ვერ მოხერხდა', 'error');
          return;
        }

        const headerLength = Number(response.headers.get('Content-Length')) || 0;
        const totalBytes = headerLength > 0 ? headerLength : knownTotal;
        const mimeType = response.headers.get('Content-Type') || file.mime_type || 'application/octet-stream';

        let blob;
        if (response.body && typeof response.body.getReader === 'function') {
          const reader = response.body.getReader();
          const chunks = [];
          let receivedBytes = 0;
          let lastUiTime = 0;

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              receivedBytes += value.byteLength;
              const now = Date.now();
              if (now - lastUiTime >= 45 || (totalBytes > 0 && receivedBytes >= totalBytes)) {
                lastUiTime = now;
                const percent = totalBytes > 0
                  ? Math.min(99, Math.floor((receivedBytes / totalBytes) * 100))
                  : null;
                state.downloads.set(key, {
                  status: 'downloading',
                  receivedBytes,
                  totalBytes,
                  percent,
                });
                syncCardDownloadUI(key);
              }
            }
          }
          blob = new Blob(chunks, { type: mimeType });
        } else {
          blob = await response.blob();
        }

        const finalBytes = totalBytes || blob.size || 0;
        state.downloads.set(key, {
          status: 'completed',
          receivedBytes: finalBytes,
          totalBytes: finalBytes,
          percent: 100,
        });
        syncCardDownloadUI(key);

        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = file.filename || 'file';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 10000);

        setTimeout(() => {
          state.downloads.delete(key);
          syncCardDownloadUI(key);
        }, 2200);
      } catch {
        state.downloads.delete(key);
        syncCardDownloadUI(key);
        showToast('ფაილის ჩამოტვირთვა ვერ მოხერხდა', 'error');
      }
    }

    function handleGridClick(event) {
      const target = event.target;
      if (!target || !DOM.grid) return;

      const card = target.closest('.app-file-card');
      if (!card) return;

      const fileId = card.dataset.fileId;
      if (!fileId) return;

      if (target.closest('.head-delete')) {
        void deleteFile(fileId);
        return;
      }

      if (target.closest('.app-file-download')) {
        void downloadFile(fileId);
        return;
      }
    }

    function handleAddClick() {
      if (!DOM.fileInput || state.uploading) return;
      DOM.fileInput.click();
    }

    function handleFileChange(event) {
      const input = event.target;
      if (!input || !input.files || !input.files.length) return;
      const file = input.files[0];
      // Reset input so selecting the same file again still fires change
      input.value = '';
      void uploadFile(file);
    }

    function init() {
      if (!ensureDom()) return;
      on(DOM.grid, 'click', handleGridClick);
      on(DOM.addBtn, 'click', handleAddClick);
      on(DOM.fileInput, 'change', handleFileChange);
      void fetchFiles();
    }

    return {
      init,
      render: () => render(),
      reload: () => fetchFiles(),
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createAppFilesModule = createAppFilesModule;
})(window);

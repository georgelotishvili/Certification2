(function (global) {
  const CONTRACT_SLOT_DEFS = [
    {
      key: 'exam',
      code: 'GIPC-CON-004',
      badge: 'საგამოცდო',
      badgeClass: 'is-exam',
      title: 'საგამოცდო ხელშეკრულება',
      subtitle: 'კანდიდატის საგამოცდო მომსახურების ხელშეკრულება (GIPC-CON-004)',
    },
    {
      key: 'cert_a',
      code: 'GIPC-CON-001',
      badge: 'კატეგორია A',
      badgeClass: 'is-cert-a',
      title: 'სასერტიფიკაციო ხელშეკრულება — კატეგორია A',
      subtitle: 'შენობა-ნაგებობის არქიტექტორი (GIPC-CON-001)',
    },
    {
      key: 'cert_a_transitional',
      code: 'GIPC-CON-001 (გარდამავალი)',
      badge: 'კატეგორია A (გარდამავალი)',
      badgeClass: 'is-cert-a',
      title: 'სასერტიფიკაციო ხელშეკრულება — კატეგორია A (საგამონაკლისო)',
      subtitle: 'შენობა-ნაგებობის არქიტექტორი — გარდამავალი წესით (GIPC-CON-001)',
    },
    {
      key: 'cert_b',
      code: 'GIPC-CON-002',
      badge: 'კატეგორია B',
      badgeClass: 'is-cert-b',
      title: 'სასერტიფიკაციო ხელშეკრულება — კატეგორია B',
      subtitle: 'არქიტექტურული პროექტის შემსწავლელი სპეციალისტი (GIPC-CON-002)',
    },
    {
      key: 'cert_b_transitional',
      code: 'GIPC-CON-002 (გარდამავალი)',
      badge: 'კატეგორია B (გარდამავალი)',
      badgeClass: 'is-cert-b',
      title: 'სასერტიფიკაციო ხელშეკრულება — კატეგორია B (საგამონაკლისო)',
      subtitle: 'შემსწავლელი სპეციალისტი — გარდამავალი წესით (GIPC-CON-002)',
    },
    {
      key: 'cert_c',
      code: 'GIPC-CON-003',
      badge: 'კატეგორია C',
      badgeClass: 'is-cert-c',
      title: 'სასერტიფიკაციო ხელშეკრულება — კატეგორია C',
      subtitle: 'არქიტექტურული პროექტის ექსპერტი (GIPC-CON-003)',
    },
  ];

  function createDocumentsModule(context) {
    const {
      API_BASE,
      showToast,
      escapeHtml,
      getAdminHeaders,
      getActorHeaders,
      loadExternalScript,
    } = context;

    const state = {
      documents: [],
      editingId: null,
      selectedFile: null,
      uploadingSlots: new Set(),
    };
    let fileReadVersion = 0;
    let fileImportPending = false;

    const els = {
      contractSlotsGrid: document.getElementById('contractSlotsGrid'),
      titleInput: document.getElementById('documentTitle'),
      contentEditor: document.getElementById('documentContent'),
      fileInput: document.getElementById('documentFile'),
      fileChooseBtn: document.getElementById('documentFileChoose'),
      fileNameDisplay: document.getElementById('documentFileName'),
      addBtn: document.getElementById('documentAddBtn'),
      cancelBtn: document.getElementById('documentCancelEdit'),
      list: document.getElementById('documentsList'),
    };

    async function fetchDocuments() {
      try {
        const response = await fetch(`${API_BASE}/admin/documents`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) throw new Error('Failed to fetch documents');
        const data = await response.json();
        return data.items || [];
      } catch (err) {
        console.error('Error fetching documents:', err);
        return [];
      }
    }

    async function uploadContractSlot(slotKey, file, content = '') {
      const formData = new FormData();
      if (content) formData.append('content', content);
      if (file) formData.append('file', file);

      const response = await fetch(`${API_BASE}/admin/documents/contracts/${encodeURIComponent(slotKey)}`, {
        method: 'POST',
        headers: {
          ...getAdminHeaders(),
          ...getActorHeaders(),
        },
        body: formData,
      });
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || 'Failed to upload contract');
      }
      return await response.json();
    }

    async function createDocument(title, content, file) {
      try {
        const formData = new FormData();
        formData.append('title', title);
        formData.append('content', content);
        if (file) {
          formData.append('file', file);
        }

        const response = await fetch(`${API_BASE}/admin/documents`, {
          method: 'POST',
          headers: {
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: formData,
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.detail || 'Failed to create');
        }
        return await response.json();
      } catch (err) {
        console.error('Error creating document:', err);
        throw err;
      }
    }

    async function updateDocument(docId, title, content, file) {
      try {
        const formData = new FormData();
        if (title !== null) formData.append('title', title);
        if (content !== null) formData.append('content', content);
        if (file) {
          formData.append('file', file);
        }

        const response = await fetch(`${API_BASE}/admin/documents/${docId}`, {
          method: 'PUT',
          headers: {
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: formData,
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.detail || 'Failed to update');
        }
        return await response.json();
      } catch (err) {
        console.error('Error updating document:', err);
        throw err;
      }
    }

    async function deleteDocument(docId) {
      try {
        const response = await fetch(`${API_BASE}/admin/documents/${docId}`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok && response.status !== 204) {
          throw new Error('Failed to delete');
        }
        return true;
      } catch (err) {
        console.error('Error deleting document:', err);
        throw err;
      }
    }

    async function changeOrder(docId, direction) {
      try {
        const response = await fetch(`${API_BASE}/admin/documents/${docId}/order`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({ direction }),
        });
        if (!response.ok && response.status !== 204) {
          throw new Error('Failed to change order');
        }
        return true;
      } catch (err) {
        console.error('Error changing order:', err);
        throw err;
      }
    }

    function formatFileSize(bytes) {
      if (!bytes) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function findContractDocForSlot(slotDef) {
      const byType = state.documents.find((d) => d.contract_type === slotDef.key);
      if (byType) return byType;
      return (
        state.documents.find(
          (d) => !d.contract_type && d.title && d.title.includes(slotDef.code)
        ) || null
      );
    }

    function renderContractSlots() {
      if (!els.contractSlotsGrid) return;
      els.contractSlotsGrid.innerHTML = CONTRACT_SLOT_DEFS.map((slot) => {
        const doc = findContractDocForSlot(slot);
        const isUploading = state.uploadingSlots.has(slot.key);
        const sizeStr = doc?.file_size_bytes ? formatFileSize(doc.file_size_bytes) : '';
        const statusHtml = doc
          ? `<div class="contract-slot-status is-uploaded">
               <span class="contract-slot-status-dot"></span>
               <span class="contract-slot-status-text">ატვირთულია: <strong>${escapeHtml(doc.filename || doc.title)}</strong>${sizeStr ? ` (${escapeHtml(sizeStr)})` : ''}</span>
             </div>`
          : `<div class="contract-slot-status is-empty">
               <span class="contract-slot-status-dot"></span>
               <span class="contract-slot-status-text">არ არის ატვირთული</span>
             </div>`;

        return `
          <div class="contract-slot-card" data-contract-slot="${escapeHtml(slot.key)}">
            <div class="contract-slot-head">
              <span class="contract-slot-badge ${escapeHtml(slot.badgeClass)}">${escapeHtml(slot.badge)}</span>
              <span class="contract-slot-code">${escapeHtml(slot.code)}</span>
            </div>
            <div class="contract-slot-title">${escapeHtml(slot.title)}</div>
            <div class="contract-slot-subtitle">${escapeHtml(slot.subtitle)}</div>
            ${statusHtml}
            <div class="contract-slot-actions">
              <input type="file" class="contract-slot-file-input" data-slot-input="${escapeHtml(slot.key)}" accept=".docx,.md,.pdf" style="display:none;" />
              <button type="button" class="primary-btn contract-slot-upload-btn" data-slot-upload="${escapeHtml(slot.key)}" ${isUploading ? 'disabled' : ''}>
                ${isUploading ? 'იტვირთება...' : (doc ? 'ფაილის განახლება' : 'ფაილის ატვირთვა')}
              </button>
              ${doc ? `<button type="button" class="secondary-btn contract-slot-edit-btn" data-slot-edit="${escapeHtml(String(doc.id))}">ნახვა / რედაქტირება</button>` : ''}
              ${doc?.download_url ? `<a href="${API_BASE}${doc.download_url}" class="secondary-btn contract-slot-download-btn" download>⬇ შაბლონი</a>` : ''}
            </div>
          </div>
        `;
      }).join('');
    }

    function renderDocumentCard(doc, isFirst, isLast) {
      const safeId = escapeHtml(String(doc.id));
      const safeTitle = escapeHtml(doc.title || 'უსათაურო');
      const plainText = (doc.content || '').replace(/<[^>]*>/g, '').trim();
      const preview = plainText.length > 100 ? plainText.substring(0, 100) + '...' : plainText;
      const safePreview = escapeHtml(preview);
      const slotDef = CONTRACT_SLOT_DEFS.find((s) => s.key === doc.contract_type);
      const badgeHtml = slotDef
        ? `<span class="contract-slot-badge ${escapeHtml(slotDef.badgeClass)}" style="margin-left:8px;vertical-align:middle;">${escapeHtml(slotDef.badge)}</span>`
        : '';

      let fileInfo = '';
      if (doc.filename) {
        const sizeStr = formatFileSize(doc.file_size_bytes);
        fileInfo = `
          <div class="document-card-file">
            <span class="file-icon">📄</span>
            <span class="file-name">${escapeHtml(doc.filename)}</span>
            ${sizeStr ? `<span class="file-size">(${sizeStr})</span>` : ''}
            <a href="${API_BASE}${doc.download_url}" class="file-download-btn" download>⬇ ჩამოტვირთვა</a>
          </div>
        `;
      }

      return `
        <div class="document-card" data-doc-id="${safeId}">
          <div class="document-card-order">
            <button class="i-btn doc-up" ${isFirst ? 'disabled' : ''} aria-label="ზემოთ">▲</button>
            <button class="i-btn doc-down" ${isLast ? 'disabled' : ''} aria-label="ქვემოთ">▼</button>
          </div>
          <div class="document-card-info">
            <div class="document-card-title">${safeTitle}${badgeHtml}</div>
            <div class="document-card-preview">${safePreview || '<em>ცარიელი</em>'}</div>
            ${fileInfo}
          </div>
          <div class="document-card-actions">
            <button class="doc-edit-btn" type="button" aria-label="რედაქტირება">✎</button>
            <button class="doc-delete-btn" type="button" aria-label="წაშლა">×</button>
          </div>
        </div>
      `;
    }

    function render() {
      renderContractSlots();
      if (!els.list) return;

      if (state.documents.length === 0) {
        els.list.innerHTML = '<div class="documents-empty">არცერთი დოკუმენტი არ არის დამატებული</div>';
        return;
      }

      els.list.innerHTML = state.documents.map((doc, index) =>
        renderDocumentCard(doc, index === 0, index === state.documents.length - 1)
      ).join('');
    }

    async function loadAndRender() {
      state.documents = await fetchDocuments();
      render();
    }

    function clearForm() {
      fileReadVersion += 1;
      fileImportPending = false;
      if (els.titleInput) els.titleInput.value = '';
      if (els.contentEditor) els.contentEditor.innerHTML = '';
      if (els.fileInput) els.fileInput.value = '';
      if (els.fileNameDisplay) els.fileNameDisplay.textContent = 'ფაილი არჩეული არ არის';
      state.editingId = null;
      state.selectedFile = null;
      if (els.addBtn) els.addBtn.textContent = 'დამატება';
      if (els.cancelBtn) els.cancelBtn.style.display = 'none';
    }

    function startEdit(doc) {
      fileReadVersion += 1;
      fileImportPending = false;
      state.editingId = doc.id;
      state.selectedFile = null;
      if (els.titleInput) els.titleInput.value = doc.title || '';
      if (els.contentEditor) els.contentEditor.innerHTML = doc.content || '';
      if (els.fileInput) els.fileInput.value = '';
      if (els.fileNameDisplay) {
        els.fileNameDisplay.textContent = doc.filename || 'ფაილი არჩეული არ არის';
      }
      if (els.addBtn) els.addBtn.textContent = 'შენახვა';
      if (els.cancelBtn) els.cancelBtn.style.display = 'inline-block';
      els.titleInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      els.titleInput?.focus();
    }

    function clearPublicDocsCache() {
      try {
        sessionStorage.removeItem('gipc_site_docs_v1');
        Object.keys(sessionStorage).forEach((k) => {
          if (k.startsWith('gipc_site_docs_')) sessionStorage.removeItem(k);
        });
      } catch {}
      try {
        global.dispatchEvent(new CustomEvent('admin:contractsChanged'));
      } catch {}
    }

    async function handleAddOrUpdate() {
      if (fileImportPending) {
        showToast('გთხოვთ, დაელოდოთ ფაილის დამუშავებას', 'error');
        return;
      }
      const title = (els.titleInput?.value || '').trim();
      const content = (els.contentEditor?.innerHTML || '').trim();

      if (!title) {
        showToast('სათაური აუცილებელია', 'error');
        return;
      }

      if (els.addBtn) els.addBtn.disabled = true;

      try {
        if (state.editingId) {
          await updateDocument(state.editingId, title, content, state.selectedFile);
          showToast('დოკუმენტი განახლდა');
        } else {
          await createDocument(title, content, state.selectedFile);
          showToast('დოკუმენტი დაემატა');
        }
        clearPublicDocsCache();
        clearForm();
        await loadAndRender();
      } catch (err) {
        showToast('შეცდომა დოკუმენტის შენახვისას', 'error');
      } finally {
        if (els.addBtn) els.addBtn.disabled = false;
      }
    }

    async function handleDelete(docId) {
      const confirmed = global.confirm('ნამდვილად გსურთ ამ დოკუმენტის წაშლა?\nფაილი და კონტენტი სრულად წაიშლება!');
      if (!confirmed) return;

      try {
        await deleteDocument(docId);
        clearPublicDocsCache();
        showToast('დოკუმენტი წაიშალა');
        if (state.editingId === docId) {
          clearForm();
        }
        await loadAndRender();
      } catch (err) {
        showToast('შეცდომა წაშლისას', 'error');
      }
    }

    async function handleOrderChange(docId, direction) {
      try {
        await changeOrder(docId, direction);
        clearPublicDocsCache();
        await loadAndRender();
      } catch (err) {
        showToast('შეცდომა რიგითობის შეცვლისას', 'error');
      }
    }

    function handleListClick(event) {
      const card = event.target.closest('.document-card');
      if (!card) return;
      const docId = parseInt(card.dataset.docId, 10);
      if (!docId) return;

      if (event.target.closest('.doc-delete-btn')) {
        handleDelete(docId);
        return;
      }

      if (event.target.closest('.doc-edit-btn')) {
        const doc = state.documents.find(d => d.id === docId);
        if (doc) startEdit(doc);
        return;
      }

      if (event.target.closest('.doc-up')) {
        handleOrderChange(docId, 'up');
        return;
      }

      if (event.target.closest('.doc-down')) {
        handleOrderChange(docId, 'down');
        return;
      }
    }

    // Word ფაილის კონვერტაცია mammoth.js-ით
    async function convertWordToHtml(file) {
      if (!global.mammoth?.convertToHtml) {
        await loadExternalScript('../vendor/mammoth.browser.min.js');
      }
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async function(e) {
          try {
            if (!global.mammoth?.convertToHtml) {
              reject(new Error('mammoth.js არ არის ჩატვირთული'));
              return;
            }
            const arrayBuffer = e.target.result;
            const result = await global.mammoth.convertToHtml({ arrayBuffer });
            resolve(result.value);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(new Error('ფაილის წაკითხვა ვერ მოხერხდა'));
        reader.readAsArrayBuffer(file);
      });
    }

    async function handleContractSlotGridClick(event) {
      const uploadBtn = event.target.closest('[data-slot-upload]');
      if (uploadBtn) {
        const slotKey = uploadBtn.getAttribute('data-slot-upload');
        const input = els.contractSlotsGrid?.querySelector(`input[data-slot-input="${slotKey}"]`);
        if (input) input.click();
        return;
      }

      const editBtn = event.target.closest('[data-slot-edit]');
      if (editBtn) {
        const docId = parseInt(editBtn.getAttribute('data-slot-edit'), 10);
        const doc = state.documents.find((d) => d.id === docId);
        if (doc) startEdit(doc);
      }
    }

    async function handleContractSlotFileChange(event) {
      const input = event.target.closest('input[data-slot-input]');
      if (!input) return;
      const slotKey = input.getAttribute('data-slot-input');
      const file = input.files?.[0];
      if (!slotKey || !file) return;

      const lowerName = file.name.toLowerCase();
      const isDocx = lowerName.endsWith('.docx');
      const isMd = lowerName.endsWith('.md');
      const isPdf = lowerName.endsWith('.pdf');

      if (!isDocx && !isMd && !isPdf) {
        showToast('მხოლოდ .docx, .md და .pdf ფაილებია დაშვებული', 'error');
        input.value = '';
        return;
      }

      state.uploadingSlots.add(slotKey);
      renderContractSlots();

      try {
        let convertedHtml = '';
        if (isDocx) {
          try {
            convertedHtml = await convertWordToHtml(file);
          } catch (e) {
            console.warn('mammoth conversion fallback to server:', e);
          }
        }
        await uploadContractSlot(slotKey, file, convertedHtml);
        clearPublicDocsCache();
        showToast('ხელშეკრულება წარმატებით აიტვირთა და განახლდა');
        await loadAndRender();
      } catch (err) {
        showToast(err.message || 'შეცდომა ხელშეკრულების ატვირთვისას', 'error');
      } finally {
        state.uploadingSlots.delete(slotKey);
        renderContractSlots();
      }
    }

    async function handleFileSelect(event) {
      const readVersion = ++fileReadVersion;
      fileImportPending = false;
      const file = event.target.files[0];
      if (!file) {
        state.selectedFile = null;
        if (els.fileNameDisplay) els.fileNameDisplay.textContent = 'ფაილი არჩეული არ არის';
        return;
      }

      const lowerName = file.name.toLowerCase();
      const isDocx = lowerName.endsWith('.docx');
      const isMd = lowerName.endsWith('.md');
      const isPdf = lowerName.endsWith('.pdf');

      if (!isDocx && !isMd && !isPdf) {
        showToast('მხოლოდ .docx, .md და .pdf ფაილებია დაშვებული', 'error');
        els.fileInput.value = '';
        state.selectedFile = null;
        return;
      }

      state.selectedFile = file;
      if (els.fileNameDisplay) els.fileNameDisplay.textContent = file.name;

      if (isPdf || isMd) {
        showToast(isMd ? 'Markdown (.md) ფაილი არჩეულია' : 'PDF ფაილი არჩეულია');
        return;
      }

      fileImportPending = true;

      // კონვერტაცია HTML-ად (.docx)
      try {
        if (els.contentEditor) {
          els.contentEditor.innerHTML = '<p style="opacity:0.5">იტვირთება...</p>';
        }
        const html = await convertWordToHtml(file);
        if (readVersion !== fileReadVersion) return;
        if (els.contentEditor) {
          els.contentEditor.innerHTML = html;
        }
        showToast('ფაილი წარმატებით დამუშავდა');
      } catch (err) {
        if (readVersion !== fileReadVersion) return;
        console.error('Word conversion error:', err);
        showToast('ფაილის კონვერტაცია ვერ მოხერხდა', 'error');
        if (els.contentEditor) {
          els.contentEditor.innerHTML = '';
        }
      } finally {
        if (readVersion === fileReadVersion) fileImportPending = false;
      }
    }

    function init() {
      if (els.contractSlotsGrid) {
        els.contractSlotsGrid.addEventListener('click', handleContractSlotGridClick);
        els.contractSlotsGrid.addEventListener('change', handleContractSlotFileChange);
      }
      if (els.addBtn) {
        els.addBtn.addEventListener('click', handleAddOrUpdate);
      }
      if (els.cancelBtn) {
        els.cancelBtn.addEventListener('click', clearForm);
      }
      if (els.list) {
        els.list.addEventListener('click', handleListClick);
      }
      if (els.fileInput) {
        els.fileInput.addEventListener('change', handleFileSelect);
      }
      if (els.fileChooseBtn && els.fileInput) {
        els.fileChooseBtn.addEventListener('click', () => {
          els.fileInput.click();
        });
      }
    }

    return {
      init,
      render: loadAndRender,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createDocumentsModule = createDocumentsModule;
})(window);

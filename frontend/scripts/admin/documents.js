(function (global) {
  function createDocumentsModule(context) {
    const {
      API_BASE,
      showToast,
      escapeHtml,
      getAdminHeaders,
      getActorHeaders,
    } = context;

    const state = {
      documents: [],
      editingId: null,
      selectedFile: null,
    };

    const els = {
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

    function renderDocumentCard(doc, isFirst, isLast) {
      const safeId = escapeHtml(String(doc.id));
      const safeTitle = escapeHtml(doc.title || 'უსათაურო');
      const plainText = (doc.content || '').replace(/<[^>]*>/g, '').trim();
      const preview = plainText.length > 100 ? plainText.substring(0, 100) + '...' : plainText;
      const safePreview = escapeHtml(preview);

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
            <div class="document-card-title">${safeTitle}</div>
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

    async function handleAddOrUpdate() {
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
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async function(e) {
          try {
            if (typeof mammoth === 'undefined') {
              reject(new Error('mammoth.js არ არის ჩატვირთული'));
              return;
            }
            const arrayBuffer = e.target.result;
            const result = await mammoth.convertToHtml({ arrayBuffer });
            resolve(result.value);
          } catch (err) {
            reject(err);
          }
        };
        reader.onerror = () => reject(new Error('ფაილის წაკითხვა ვერ მოხერხდა'));
        reader.readAsArrayBuffer(file);
      });
    }

    async function handleFileSelect(event) {
      const file = event.target.files[0];
      if (!file) {
        state.selectedFile = null;
        if (els.fileNameDisplay) els.fileNameDisplay.textContent = 'ფაილი არჩეული არ არის';
        return;
      }

      if (!file.name.toLowerCase().endsWith('.docx')) {
        showToast('მხოლოდ .docx ფაილებია დაშვებული', 'error');
        els.fileInput.value = '';
        state.selectedFile = null;
        return;
      }

      state.selectedFile = file;
      if (els.fileNameDisplay) els.fileNameDisplay.textContent = file.name;

      // კონვერტაცია HTML-ად
      try {
        if (els.contentEditor) {
          els.contentEditor.innerHTML = '<p style="opacity:0.5">იტვირთება...</p>';
        }
        const html = await convertWordToHtml(file);
        if (els.contentEditor) {
          els.contentEditor.innerHTML = html;
        }
        showToast('ფაილი წარმატებით დამუშავდა');
      } catch (err) {
        console.error('Word conversion error:', err);
        showToast('ფაილის კონვერტაცია ვერ მოხერხდა', 'error');
        if (els.contentEditor) {
          els.contentEditor.innerHTML = '';
        }
      }
    }

    function init() {
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

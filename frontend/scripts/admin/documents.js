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
    };

    const els = {
      titleInput: document.getElementById('documentTitle'),
      contentEditor: document.getElementById('documentContent'),
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

    async function createDocument(title, content) {
      try {
        const response = await fetch(`${API_BASE}/admin/documents`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({ title, content }),
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

    async function updateDocument(docId, title, content) {
      try {
        const response = await fetch(`${API_BASE}/admin/documents/${docId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({ title, content }),
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

    function renderDocumentCard(doc, isFirst, isLast) {
      const safeId = escapeHtml(String(doc.id));
      const safeTitle = escapeHtml(doc.title || 'უსათაურო');
      // Show preview of content (strip HTML, first 100 chars)
      const plainText = (doc.content || '').replace(/<[^>]*>/g, '').trim();
      const preview = plainText.length > 100 ? plainText.substring(0, 100) + '...' : plainText;
      const safePreview = escapeHtml(preview);

      return `
        <div class="document-card" data-doc-id="${safeId}">
          <div class="document-card-order">
            <button class="i-btn doc-up" ${isFirst ? 'disabled' : ''} aria-label="ზემოთ">▲</button>
            <button class="i-btn doc-down" ${isLast ? 'disabled' : ''} aria-label="ქვემოთ">▼</button>
          </div>
          <div class="document-card-info">
            <div class="document-card-title">${safeTitle}</div>
            <div class="document-card-preview">${safePreview || '<em>ცარიელი</em>'}</div>
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
      state.editingId = null;
      if (els.addBtn) els.addBtn.textContent = 'დამატება';
      if (els.cancelBtn) els.cancelBtn.style.display = 'none';
    }

    function startEdit(doc) {
      state.editingId = doc.id;
      if (els.titleInput) els.titleInput.value = doc.title || '';
      if (els.contentEditor) els.contentEditor.innerHTML = doc.content || '';
      if (els.addBtn) els.addBtn.textContent = 'შენახვა';
      if (els.cancelBtn) els.cancelBtn.style.display = 'inline-block';
      // Scroll to form
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
          await updateDocument(state.editingId, title, content);
          showToast('დოკუმენტი განახლდა');
        } else {
          await createDocument(title, content);
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
      const confirmed = global.confirm('ნამდვილად გსურთ ამ დოკუმენტის წაშლა?');
      if (!confirmed) return;

      try {
        await deleteDocument(docId);
        showToast('დოკუმენტი წაიშალა');
        // If we were editing this document, clear the form
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

      // Delete button
      if (event.target.closest('.doc-delete-btn')) {
        handleDelete(docId);
        return;
      }

      // Edit button
      if (event.target.closest('.doc-edit-btn')) {
        const doc = state.documents.find(d => d.id === docId);
        if (doc) startEdit(doc);
        return;
      }

      // Up button
      if (event.target.closest('.doc-up')) {
        handleOrderChange(docId, 'up');
        return;
      }

      // Down button
      if (event.target.closest('.doc-down')) {
        handleOrderChange(docId, 'down');
        return;
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
    }

    return {
      init,
      render: loadAndRender,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createDocumentsModule = createDocumentsModule;
})(window);

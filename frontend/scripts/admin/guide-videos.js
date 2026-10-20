(function (global) {
  function createGuideModule(context) {
    const {
      API_BASE,
      on,
      escapeHtml,
      showToast = () => {},
      handleAdminErrorResponse = () => {},
      getAdminHeaders = () => ({}),
      getActorHeaders = () => ({}),
      loadExternalScript = global.AdminShared?.loadExternalScript,
    } = context;

    let guideDocuments = [];
    let editingId = null;
    let selectedFile = null;
    let removeExistingFile = false;
    let isSaving = false;

    function getElements() {
      return {
        addNewBtn: document.getElementById('guideAddNewBtn'),
        formWrap: document.getElementById('guideDocForm'),
        formHeading: document.getElementById('guideDocFormHeading'),
        closeFormBtn: document.getElementById('guideDocCloseFormBtn'),
        cancelBtn: document.getElementById('guideDocCancelBtn'),
        statusCard: document.getElementById('guideDocStatusCard'),
        listEl: document.getElementById('guideDocsList'),
        titleInput: document.getElementById('guideDocTitle'),
        fileInput: document.getElementById('guideDocFile'),
        fileChooseBtn: document.getElementById('guideDocFileChoose'),
        fileNameSpan: document.getElementById('guideDocFileName'),
        removeFileBtn: document.getElementById('guideDocRemoveFileBtn'),
        contentEditor: document.getElementById('guideDocContent'),
        saveBtn: document.getElementById('guideDocSaveBtn'),
        formatBtn: document.getElementById('guideDocFormatBtn'),
        deleteBtn: document.getElementById('guideDocDeleteBtn'),
      };
    }

    function clearPublicGuideCache() {
      try {
        sessionStorage.removeItem('gipc_guide_docs_v1');
        Object.keys(sessionStorage).forEach((k) => {
          if (k.startsWith('gipc_guide_docs_') || k.startsWith('gipc_header_partial_')) {
            sessionStorage.removeItem(k);
          }
        });
      } catch {}
    }

    function formatFileSize(bytes) {
      if (!bytes || bytes <= 0) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function formatDateGeo(isoStr) {
      if (!isoStr) return '';
      try {
        const d = new Date(isoStr);
        if (Number.isNaN(d.getTime())) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      } catch {
        return '';
      }
    }

    function inlineFormatText(str) {
      const placeholder = '\u0000AST\u0000';
      const prepared = String(str || '').replace(/\\\*/g, placeholder);
      let s = escapeHtml(prepared);
      s = s.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
      s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
      s = s.replace(/`([^`]+?)`/g, '<strong>$1</strong>');
      s = s.replaceAll(placeholder, '*');
      const labelMatch = s.match(/^((?:შენიშვნა|მნიშვნელოვანია|ყურადღება|გაითვალისწინეთ|სავალდებულოა|რეკომენდაცია|მაგალითი)\s*:)\s*(.+)$/i);
      if (labelMatch) {
        return `<strong>${labelMatch[1]}</strong> ${labelMatch[2]}`;
      }
      return s;
    }

    function structuredTextToHtml(rawText) {
      const trimmed = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
      if (!trimmed) return '';

      const hasMarkdownHeadings = /^#{1,4}\s+\S/m.test(trimmed);
      const lines = trimmed.split('\n');
      const out = [];
      let i = 0;
      const n = lines.length;
      let seenH1 = false;

      const metaLineRe = /^\*\*(დოკუმენტის კოდი|ვერსია|თარიღი|კონფიდენციალურობა|სქემის მფლობელი|სერტიფიცირების ორგანო|საიდენტიფიკაციო კოდი|იურიდიული მისამართი|ფაქტობრივი \(საოფისე და საგამოცდო\) მისამართი|ვებგვერდი):\*\*\s*(.+)$/;
      const sectionH2Re = /^(?:(?:ნაწილი|თავი|ეტაპი|ნაბიჯი|მუხლი|კატეგორია|დანართი)\s*[№#]?\s*[0-9IVX]+|[IVX]+\.|[0-9]{1,2}\.)\s+.+$/i;
      const sectionH3Re = /^[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?\.?\s+.+$/;
      const bulletRe = /^(?:[-•*–—]|\([ა-ჰ0-9]+\)|[ა-ჰ]\))\s+(.+)$/;
      const olRe = /^\d+\.\s+(.+)$/;

      while (i < n) {
        const stripped = lines[i].trim();
        if (!stripped || stripped === '---') {
          i += 1;
          continue;
        }

        // Metadata table
        const metaMatch = stripped.match(metaLineRe);
        if (metaMatch) {
          const metaRows = [];
          while (i < n) {
            const m = lines[i].trim().match(metaLineRe);
            if (!m) break;
            metaRows.push([m[1].trim(), m[2].trim()]);
            i += 1;
          }
          out.push('<table>');
          metaRows.forEach(([label, val]) => {
            out.push(`<tr><th>${inlineFormatText(label)}</th><td>${inlineFormatText(val)}</td></tr>`);
          });
          out.push('</table>');
          continue;
        }

        if (stripped.startsWith('# ')) {
          seenH1 = true;
          out.push(`<h1 style="text-align:center;">${inlineFormatText(stripped.slice(2).trim())}</h1>`);
          i += 1;
          continue;
        }
        if (
          seenH1 &&
          out.length === 1 &&
          stripped.startsWith('**') &&
          stripped.endsWith('**') &&
          !stripped.includes(':')
        ) {
          const subText = stripped.replace(/^\*+|\*+$/g, '').trim();
          out.push(`<h2 style="text-align:center;">${inlineFormatText(subText)}</h2>`);
          i += 1;
          continue;
        }
        if (stripped.startsWith('## ')) {
          const hText = stripped.slice(3).trim();
          if (seenH1 && out.length === 1) {
            out.push(`<h2 style="text-align:center;">${inlineFormatText(hText)}</h2>`);
          } else {
            out.push(`<h2>${inlineFormatText(hText)}</h2>`);
          }
          i += 1;
          continue;
        }
        if (stripped.startsWith('### ')) {
          out.push(`<h3>${inlineFormatText(stripped.slice(4).trim())}</h3>`);
          i += 1;
          continue;
        }
        if (stripped.startsWith('#### ')) {
          out.push(`<h4>${inlineFormatText(stripped.slice(5).trim())}</h4>`);
          i += 1;
          continue;
        }

        // Markdown table
        if (stripped.startsWith('|') && stripped.endsWith('|')) {
          const tableRows = [];
          while (i < n && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
            const rowStr = lines[i].trim().slice(1, -1);
            const cells = rowStr.split('|').map((c) => c.trim());
            if (!cells.every((c) => /^[:\-]+$/.test(c || '-'))) {
              tableRows.push(cells);
            }
            i += 1;
          }
          if (tableRows.length) {
            out.push('<table>');
            tableRows.forEach((row, rIdx) => {
              const tag = rIdx === 0 ? 'th' : 'td';
              out.push(`<tr>${row.map((c) => `<${tag}>${inlineFormatText(c)}</${tag}>`).join('')}</tr>`);
            });
            out.push('</table>');
          }
          continue;
        }

        // Bullet list
        const bMatch = stripped.match(bulletRe);
        if (bMatch) {
          out.push('<ul>');
          while (i < n) {
            const curLine = lines[i];
            const curS = curLine.trim();
            const bm = curS.match(bulletRe);
            const subOl = (/^(?:  |\t)/.test(curLine)) ? curS.match(olRe) : null;
            if (bm) {
              out.push(`<li>${inlineFormatText(bm[1].trim())}</li>`);
              i += 1;
            } else if (subOl) {
              out.push(`<li>${inlineFormatText(subOl[1].trim())}</li>`);
              i += 1;
            } else if (/^(?:  |\t)/.test(curLine) && curS && !/^(?:#|\||---)/.test(curS)) {
              out[out.length - 1] = out[out.length - 1].slice(0, -5) + `<br>${inlineFormatText(curS)}</li>`;
              i += 1;
            } else {
              break;
            }
          }
          out.push('</ul>');
          continue;
        }

        // Ordered list when document already uses Markdown headings
        const olMatch = hasMarkdownHeadings ? stripped.match(olRe) : null;
        if (olMatch) {
          out.push('<ol>');
          while (i < n) {
            const om = lines[i].trim().match(olRe);
            if (!om) break;
            out.push(`<li>${inlineFormatText(om[1].trim())}</li>`);
            i += 1;
          }
          out.push('</ol>');
          continue;
        }

        // First short line -> centered H1
        if (!seenH1 && out.length === 0 && stripped.length <= 115 && !/[.;,]$/.test(stripped)) {
          seenH1 = true;
          const cleanT = stripped.replace(/^\*+|\*+$/g, '').trim();
          out.push(`<h1 style="text-align:center;">${inlineFormatText(cleanT)}</h1>`);
          i += 1;
          continue;
        }

        // Sub-numbered heading (1.1, 1.2) -> H3
        if (sectionH3Re.test(stripped) && stripped.length <= 120 && !/[.;,]$/.test(stripped)) {
          const cleanH3 = stripped.replace(/^\*+|\*+$/g, '').trim();
          out.push(`<h3>${inlineFormatText(cleanH3)}</h3>`);
          i += 1;
          continue;
        }

        // Major section -> H2
        if (sectionH2Re.test(stripped) && stripped.length <= 110 && !/[;,]$/.test(stripped)) {
          const cleanH2 = stripped.replace(/^\*+|\*+$/g, '').trim();
          out.push(`<h2>${inlineFormatText(cleanH2)}</h2>`);
          i += 1;
          continue;
        }

        // Standalone bold or short isolated title line
        const prevBlank = i === 0 || !lines[i - 1].trim();
        const nextBlank = i + 1 >= n || !lines[i + 1].trim();
        const isWrappedBold = stripped.startsWith('**') && stripped.endsWith('**') && stripped.length > 4;
        if (
          (isWrappedBold || (prevBlank && nextBlank && stripped.length <= 85 && !/[.;,]$/.test(stripped))) &&
          stripped.length <= 105
        ) {
          const cleanH = stripped.replace(/^\*+|\*+$/g, '').trim();
          if (!seenH1 && out.length === 0) {
            seenH1 = true;
            out.push(`<h1 style="text-align:center;">${inlineFormatText(cleanH)}</h1>`);
          } else {
            out.push(`<h2>${inlineFormatText(cleanH)}</h2>`);
          }
          i += 1;
          continue;
        }

        out.push(`<p>${inlineFormatText(stripped)}</p>`);
        i += 1;
      }

      return out.join('\n');
    }

    function sanitizeAndStructureEditorDom(container) {
      if (!container) return;
      try {
        const allElements = container.querySelectorAll('*');
        allElements.forEach((el) => {
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

        const bulletChars = '·•\\-–—■□►▪▸●○⁃◦◘◙';
        const bulletRegex = new RegExp('^[\\s\\u00A0]*[' + bulletChars + '][\\s\\u00A0]+');
        const stripLeadingBullet = (el) => {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
          const firstText = walker.nextNode();
          if (firstText && firstText.nodeValue) {
            firstText.nodeValue = firstText.nodeValue.replace(bulletRegex, '');
          }
        };

        const paragraphs = Array.from(container.querySelectorAll('p'));
        let currentUl = null;
        let lastWasBullet = false;

        paragraphs.forEach((p) => {
          const text = p.textContent || '';
          if (bulletRegex.test(text)) {
            const li = document.createElement('li');
            li.innerHTML = p.innerHTML;
            stripLeadingBullet(li);
            if (!currentUl) {
              currentUl = document.createElement('ul');
              p.parentNode.insertBefore(currentUl, p);
            }
            currentUl.appendChild(li);
            p.remove();
            lastWasBullet = true;
          } else {
            if (lastWasBullet) currentUl = null;
            lastWasBullet = false;
          }
        });

        container.querySelectorAll('li').forEach((li) => stripLeadingBullet(li));

        const hasSemanticBlocks = Boolean(container.querySelector('h1, h2, h3, ul, ol, table'));
        const topPs = Array.from(container.children).filter((el) => el.tagName === 'P');
        if (!hasSemanticBlocks && topPs.length === 0) {
          const plain = (container.innerText || container.textContent || '').trim();
          if (plain) {
            container.innerHTML = structuredTextToHtml(plain);
            return;
          }
        }

        if (!container.querySelector('h1, h2')) {
          const sectionH2Re = /^(?:(?:ნაწილი|თავი|ეტაპი|ნაბიჯი|მუხლი|კატეგორია|დანართი)\s*[№#]?\s*[0-9IVX]+|[IVX]+\.|[0-9]{1,2}\.)\s+.+$/i;
          const sectionH3Re = /^[0-9]{1,2}\.[0-9]{1,2}(?:\.[0-9]{1,2})?\.?\s+.+$/;
          let seenH1 = false;
          Array.from(container.children).forEach((el, idx) => {
            if (el.tagName !== 'P') return;
            const fullText = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (!fullText) return;
            const boldChild = el.querySelector(':scope > strong, :scope > b');
            const isAllBold = Boolean(
              boldChild &&
              el.children.length === 1 &&
              (boldChild.textContent || '').replace(/\s+/g, ' ').trim() === fullText
            );
            if (!seenH1 && idx === 0 && fullText.length <= 115 && (isAllBold || !/[.;,]$/.test(fullText))) {
              seenH1 = true;
              const h1 = document.createElement('h1');
              h1.style.textAlign = 'center';
              h1.textContent = fullText;
              el.replaceWith(h1);
            } else if (sectionH3Re.test(fullText) && fullText.length <= 120 && (isAllBold || !/[.;,]$/.test(fullText))) {
              const h3 = document.createElement('h3');
              h3.textContent = fullText;
              el.replaceWith(h3);
            } else if (
              (sectionH2Re.test(fullText) && fullText.length <= 110 && !/[;,]$/.test(fullText)) ||
              (isAllBold && fullText.length <= 95 && !/[.;,]$/.test(fullText))
            ) {
              const h2 = document.createElement('h2');
              h2.textContent = fullText;
              el.replaceWith(h2);
            }
          });
        }
      } catch (e) {
        console.error('sanitizeAndStructureEditorDom error:', e);
      }
    }

    function openFormForCreate() {
      const {
        formWrap,
        formHeading,
        titleInput,
        contentEditor,
        fileInput,
        fileNameSpan,
        removeFileBtn,
        saveBtn,
        deleteBtn,
      } = getElements();

      editingId = null;
      selectedFile = null;
      removeExistingFile = false;

      if (formHeading) {
        formHeading.textContent = 'ახალი დოკუმენტის დამატება („ინფორმაცია“ ნავიგაციაში)';
      }
      if (titleInput) titleInput.value = '';
      if (contentEditor) contentEditor.innerHTML = '';
      if (fileInput) fileInput.value = '';
      if (fileNameSpan) {
        fileNameSpan.textContent = 'ფაილი არჩეული არ არის';
        fileNameSpan.classList.remove('has-file');
      }
      if (removeFileBtn) removeFileBtn.style.display = 'none';
      if (saveBtn) saveBtn.textContent = 'შენახვა და გამოქვეყნება';
      if (deleteBtn) deleteBtn.style.display = 'none';

      if (formWrap) {
        formWrap.style.display = 'block';
        formWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      setTimeout(() => titleInput?.focus(), 50);
    }

    function openFormForEdit(doc) {
      if (!doc) return;
      const {
        formWrap,
        formHeading,
        titleInput,
        contentEditor,
        fileInput,
        fileNameSpan,
        removeFileBtn,
        saveBtn,
        deleteBtn,
      } = getElements();

      editingId = doc.id;
      selectedFile = null;
      removeExistingFile = false;

      if (formHeading) {
        formHeading.textContent = `დოკუმენტის რედაქტირება: ${doc.title || ''}`;
      }
      if (titleInput) titleInput.value = doc.title || '';
      if (contentEditor) {
        contentEditor.innerHTML = doc.content || '';
        sanitizeAndStructureEditorDom(contentEditor);
      }
      if (fileInput) fileInput.value = '';
      if (fileNameSpan) {
        const sizeLabel = doc.file_size_bytes ? ` (${formatFileSize(doc.file_size_bytes)})` : '';
        fileNameSpan.textContent = doc.filename
          ? `მიმდინარე ფაილი: ${doc.filename}${sizeLabel}`
          : 'ფაილი არჩეული არ არის';
        fileNameSpan.classList.toggle('has-file', Boolean(doc.filename));
      }
      if (removeFileBtn) {
        removeFileBtn.style.display = doc.filename ? 'inline-flex' : 'none';
      }
      if (saveBtn) saveBtn.textContent = 'ცვლილების შენახვა';
      if (deleteBtn) deleteBtn.style.display = 'inline-flex';

      if (formWrap) {
        formWrap.style.display = 'block';
        formWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      setTimeout(() => titleInput?.focus(), 50);
    }

    function closeForm() {
      const { formWrap, fileInput } = getElements();
      editingId = null;
      selectedFile = null;
      removeExistingFile = false;
      if (fileInput) fileInput.value = '';
      if (formWrap) formWrap.style.display = 'none';
    }

    function renderGuideCard(doc, index, total) {
      const isFirst = index === 0;
      const isLast = index === total - 1;
      const safeId = escapeHtml(String(doc.id));
      const safeTitle = escapeHtml(doc.title || 'უსათაურო');
      const plainText = (doc.content || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      const preview = plainText.length > 140 ? `${plainText.slice(0, 140)}...` : plainText;
      const safePreview = escapeHtml(preview);
      const updatedLabel = doc.updated_at ? formatDateGeo(doc.updated_at) : '';

      let fileInfo = '';
      if (doc.filename) {
        const sizeStr = formatFileSize(doc.file_size_bytes);
        const dlUrl = doc.download_url ? `${API_BASE}${doc.download_url}` : `${API_BASE}/guide/documents/${doc.id}/download`;
        fileInfo = `
          <div class="document-card-file" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:6px;">
            <span class="file-icon">📄</span>
            <span class="file-name">${escapeHtml(doc.filename)}</span>
            ${sizeStr ? `<span class="file-size">(${escapeHtml(sizeStr)})</span>` : ''}
            <a href="${escapeHtml(dlUrl)}" class="file-download-btn" target="_blank" download>⬇ ჩამოტვირთვა</a>
            <button type="button" class="file-download-btn doc-detach-file-btn" style="background:#fff; color:#b91c1c; border:1px solid #fecaca; cursor:pointer;">× ფაილის მოხსნა</button>
          </div>
        `;
      }

      return `
        <div class="document-card" data-guide-doc-id="${safeId}">
          <div class="document-card-order">
            <button class="i-btn doc-up" type="button" ${isFirst ? 'disabled' : ''} title="ზემოთ აწევა" aria-label="ზემოთ">▲</button>
            <button class="i-btn doc-down" type="button" ${isLast ? 'disabled' : ''} title="ქვემოთ ჩამოწევა" aria-label="ქვემოთ">▼</button>
          </div>
          <div class="document-card-info">
            <div class="document-card-title">
              <span style="display:inline-block; font-size:12px; font-weight:700; color:#475569; background:#f1f5f9; border:1px solid #cbd5e1; padding:1px 7px; margin-right:6px;">#${index + 1}</span>
              ${safeTitle}
              ${updatedLabel ? `<span style="font-size:12px; font-weight:400; color:#64748b; margin-left:8px;">განახლდა: ${escapeHtml(updatedLabel)}</span>` : ''}
            </div>
            <div class="document-card-preview">${safePreview || '<em>მხოლოდ მიბმული ფაილი / ტექსტი ცარიელია</em>'}</div>
            ${fileInfo}
          </div>
          <div class="document-card-actions">
            <button class="doc-edit-btn" type="button" title="რედაქტირება" aria-label="რედაქტირება">✎</button>
            <button class="doc-delete-btn" type="button" title="წაშლა" aria-label="წაშლა">×</button>
          </div>
        </div>
      `;
    }

    function renderGuideList() {
      const { listEl } = getElements();
      if (!listEl) return;

      if (!guideDocuments.length) {
        listEl.innerHTML = `
          <div class="documents-empty">
            საინფორმაციო ნავიგაციაში დოკუმენტები ჯერ არ არის დამატებული. დააჭირეთ <strong>„+ დოკუმენტის დამატება“</strong> ღილაკს.
          </div>
        `;
        return;
      }

      listEl.innerHTML = guideDocuments
        .map((doc, idx) => renderGuideCard(doc, idx, guideDocuments.length))
        .join('');
    }

    async function loadGuideDocuments() {
      const { listEl } = getElements();
      if (listEl && !guideDocuments.length) {
        listEl.innerHTML = '<div class="documents-empty">იტვირთება საინფორმაციო ნავიგაციის დოკუმენტები...</div>';
      }

      try {
        let response = await fetch(`${API_BASE}/admin/guide/documents`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
          cache: 'no-cache',
        });
        if (!response.ok) {
          response = await fetch(`${API_BASE}/guide/documents`, { cache: 'no-cache' });
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        guideDocuments = Array.isArray(data?.items) ? data.items : [];
        renderGuideList();
      } catch (err) {
        console.error('Failed to load guide documents:', err);
        if (listEl) {
          listEl.innerHTML = '<div class="documents-empty">დოკუმენტების ჩატვირთვა ვერ მოხერხდა</div>';
        }
      }
    }

    async function handleFileSelect(event) {
      const file = event?.target?.files?.[0];
      if (!file) return;

      const { fileNameSpan, removeFileBtn, contentEditor, titleInput } = getElements();
      const lowerName = file.name.toLowerCase();
      const isDocx = lowerName.endsWith('.docx') || lowerName.endsWith('.doc');
      const isMdOrTxt = lowerName.endsWith('.md') || lowerName.endsWith('.txt');
      const isPdf = lowerName.endsWith('.pdf');

      if (!isDocx && !isMdOrTxt && !isPdf) {
        showToast('დაშვებულია მხოლოდ .docx, .md, .txt ან .pdf ფაილები', 'error');
        event.target.value = '';
        return;
      }

      selectedFile = file;
      removeExistingFile = false;

      if (fileNameSpan) {
        fileNameSpan.textContent = `${file.name} (${formatFileSize(file.size)})`;
        fileNameSpan.classList.add('has-file');
      }
      if (removeFileBtn) {
        removeFileBtn.style.display = 'inline-flex';
      }

      if (titleInput && !titleInput.value.trim()) {
        const baseName = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').trim();
        if (baseName) titleInput.value = baseName;
      }

      if (isMdOrTxt && contentEditor) {
        try {
          const rawText = await file.text();
          contentEditor.innerHTML = structuredTextToHtml(rawText);
          sanitizeAndStructureEditorDom(contentEditor);
        } catch (err) {
          console.error('Error reading text/markdown file:', err);
        }
      } else if (isDocx && contentEditor) {
        try {
          contentEditor.innerHTML = '<p style="color:#64748b;">მიმდინარეობს Word ფაილის დამუშავება...</p>';
          if (!global.mammoth?.convertToHtml && typeof loadExternalScript === 'function') {
            await loadExternalScript('../vendor/mammoth.browser.min.js');
          }
          if (global.mammoth?.convertToHtml) {
            const arrayBuffer = await file.arrayBuffer();
            const result = await global.mammoth.convertToHtml(
              { arrayBuffer },
              {
                styleMap: [
                  "p[style-name='Heading 1'] => h1:fresh",
                  "p[style-name='Heading 2'] => h2:fresh",
                  "p[style-name='Heading 3'] => h3:fresh",
                  "p[style-name='Title'] => h1:fresh",
                  "b => strong",
                  "i => em",
                ],
              }
            );
            contentEditor.innerHTML = result.value || '';
            sanitizeAndStructureEditorDom(contentEditor);
          } else {
            contentEditor.innerHTML = '';
          }
        } catch (err) {
          console.error('Mammoth conversion error:', err);
          contentEditor.innerHTML = '';
        }
      }
    }

    function handleRemoveAttachedFileInForm() {
      const { fileInput, fileNameSpan, removeFileBtn } = getElements();
      selectedFile = null;
      removeExistingFile = true;
      if (fileInput) fileInput.value = '';
      if (fileNameSpan) {
        fileNameSpan.textContent = editingId
          ? 'მიბმული ფაილი მოიხსნება შენახვისას'
          : 'ფაილი არჩეული არ არის';
        fileNameSpan.classList.remove('has-file');
      }
      if (removeFileBtn) {
        removeFileBtn.style.display = 'none';
      }
    }

    async function saveGuideDocument() {
      if (isSaving) return;
      const { titleInput, contentEditor, saveBtn, fileInput } = getElements();

      const title = (titleInput?.value || '').trim();
      if (!title) {
        showToast('გთხოვთ მიუთითოთ დოკუმენტის სათაური (მაგ: ჩვენს შესახებ)', 'error');
        titleInput?.focus();
        return;
      }

      if (contentEditor) {
        const rawInner = (contentEditor.innerHTML || '').trim();
        const hasTags = /<(?:h1|h2|h3|p|ul|ol|table)\b/i.test(rawInner);
        if (!hasTags && (contentEditor.innerText || '').trim()) {
          contentEditor.innerHTML = structuredTextToHtml(contentEditor.innerText);
        }
        sanitizeAndStructureEditorDom(contentEditor);
      }

      const content = (contentEditor?.innerHTML || '').trim();
      const plainText = (contentEditor?.innerText || contentEditor?.textContent || '').trim();
      const currentEditingDoc = editingId ? guideDocuments.find((d) => d.id === editingId) : null;
      const hasExistingFile = Boolean(currentEditingDoc && currentEditingDoc.filename && !removeExistingFile);

      if (!plainText && !selectedFile && !hasExistingFile) {
        showToast('გთხოვთ ატვირთოთ დოკუმენტის ფაილი ან ჩასვათ ტექსტი რედაქტორში', 'error');
        return;
      }

      isSaving = true;
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'ინახება...';
      }

      try {
        const formData = new FormData();
        formData.append('title', title);
        formData.append('content', content);
        if (selectedFile) {
          formData.append('file', selectedFile);
        } else if (editingId && removeExistingFile) {
          formData.append('remove_file', 'true');
        }

        const isEdit = Boolean(editingId);
        const url = isEdit
          ? `${API_BASE}/admin/guide/documents/${editingId}`
          : `${API_BASE}/admin/guide/documents`;
        const method = isEdit ? 'PUT' : 'POST';

        const response = await fetch(url, {
          method,
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
          body: formData,
        });

        if (!response.ok) {
          await handleAdminErrorResponse(response, 'დოკუმენტის შენახვა ვერ მოხერხდა', showToast);
          return;
        }

        await response.json();
        selectedFile = null;
        removeExistingFile = false;
        if (fileInput) fileInput.value = '';

        clearPublicGuideCache();
        closeForm();
        await loadGuideDocuments();
        showToast(
          isEdit
            ? 'დოკუმენტი წარმატებით განახლდა'
            : 'დოკუმენტი წარმატებით დაემატა „ინფორმაცია“ ნავიგაციაში',
          'success'
        );
      } catch (err) {
        console.error('Failed to save guide document:', err);
        showToast('დოკუმენტის შენახვა ვერ მოხერხდა', 'error');
      } finally {
        isSaving = false;
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = editingId ? 'ცვლილების შენახვა' : 'შენახვა და გამოქვეყნება';
        }
      }
    }

    async function deleteGuideDocumentById(docId) {
      const targetDoc = guideDocuments.find((d) => d.id === docId);
      const label = targetDoc?.title ? `„${targetDoc.title}“` : 'ეს დოკუმენტი';
      if (!global.confirm(`ნამდვილად გსურთ წაშალოთ ${label} საინფორმაციო ნავიგაციიდან?`)) return;

      try {
        const response = await fetch(`${API_BASE}/admin/guide/documents/${docId}`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok && response.status !== 204) {
          await handleAdminErrorResponse(response, 'დოკუმენტის წაშლა ვერ მოხერხდა', showToast);
          return;
        }

        if (editingId === docId) {
          closeForm();
        }
        clearPublicGuideCache();
        await loadGuideDocuments();
        showToast('დოკუმენტი წაიშალა', 'success');
      } catch (err) {
        console.error('Failed to delete guide document:', err);
        showToast('დოკუმენტის წაშლა ვერ მოხერხდა', 'error');
      }
    }

    async function detachFileFromGuideDoc(docId) {
      const targetDoc = guideDocuments.find((d) => d.id === docId);
      if (!targetDoc || !targetDoc.filename) return;
      if (!global.confirm(`ნამდვილად გსურთ მიბმული ფაილის (${targetDoc.filename}) მოხსნა?`)) return;

      try {
        const formData = new FormData();
        formData.append('remove_file', 'true');
        const response = await fetch(`${API_BASE}/admin/guide/documents/${docId}`, {
          method: 'PUT',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
          body: formData,
        });
        if (!response.ok) {
          await handleAdminErrorResponse(response, 'ფაილის მოხსნა ვერ მოხერხდა', showToast);
          return;
        }
        clearPublicGuideCache();
        await loadGuideDocuments();
        showToast('მიბმული ფაილი მოიხსნა', 'success');
      } catch (err) {
        console.error('Failed to detach file:', err);
        showToast('ფაილის მოხსნა ვერ მოხერხდა', 'error');
      }
    }

    async function changeGuideDocOrder(docId, direction) {
      try {
        const response = await fetch(`${API_BASE}/admin/guide/documents/${docId}/order`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({ direction }),
        });
        if (!response.ok && response.status !== 204) {
          await handleAdminErrorResponse(response, 'რიგითობის შეცვლა ვერ მოხერხდა', showToast);
          return;
        }
        clearPublicGuideCache();
        await loadGuideDocuments();
      } catch (err) {
        console.error('Failed to change order:', err);
        showToast('რიგითობის შეცვლა ვერ მოხერხდა', 'error');
      }
    }

    function handleListClick(event) {
      const card = event.target.closest('[data-guide-doc-id]');
      if (!card) return;
      const docId = parseInt(card.getAttribute('data-guide-doc-id'), 10);
      if (!docId) return;

      if (event.target.closest('.doc-delete-btn')) {
        void deleteGuideDocumentById(docId);
        return;
      }

      if (event.target.closest('.doc-edit-btn')) {
        const doc = guideDocuments.find((d) => d.id === docId);
        if (doc) openFormForEdit(doc);
        return;
      }

      if (event.target.closest('.doc-detach-file-btn')) {
        void detachFileFromGuideDoc(docId);
        return;
      }

      if (event.target.closest('.doc-up')) {
        void changeGuideDocOrder(docId, 'up');
        return;
      }

      if (event.target.closest('.doc-down')) {
        void changeGuideDocOrder(docId, 'down');
        return;
      }
    }

    function bindEvents() {
      const {
        addNewBtn,
        closeFormBtn,
        cancelBtn,
        fileChooseBtn,
        fileInput,
        removeFileBtn,
        saveBtn,
        formatBtn,
        deleteBtn,
        contentEditor,
        listEl,
      } = getElements();

      if (addNewBtn) {
        on(addNewBtn, 'click', openFormForCreate);
      }
      if (closeFormBtn) {
        on(closeFormBtn, 'click', closeForm);
      }
      if (cancelBtn) {
        on(cancelBtn, 'click', closeForm);
      }

      if (fileChooseBtn && fileInput) {
        on(fileChooseBtn, 'click', () => fileInput.click());
        on(fileInput, 'change', handleFileSelect);
      }

      if (removeFileBtn) {
        on(removeFileBtn, 'click', handleRemoveAttachedFileInForm);
      }

      if (saveBtn) {
        on(saveBtn, 'click', () => void saveGuideDocument());
      }

      if (formatBtn && contentEditor) {
        on(formatBtn, 'click', () => {
          const plain = (contentEditor.innerText || contentEditor.textContent || '').trim();
          if (!plain) {
            showToast('რედაქტორში ტექსტი არ არის ჩაწერილი', 'error');
            return;
          }
          contentEditor.innerHTML = structuredTextToHtml(plain);
          sanitizeAndStructureEditorDom(contentEditor);
          showToast('ტექსტის სტრუქტურა და სიმეტრია გასწორდა', 'success');
        });
      }

      if (contentEditor) {
        on(contentEditor, 'paste', (e) => {
          const clipboard = e.clipboardData || window.clipboardData;
          if (!clipboard) return;
          const htmlData = clipboard.getData('text/html');
          const textData = clipboard.getData('text/plain');
          if (textData && (!htmlData || !/<(?:h1|h2|h3|table|ul|ol)\b/i.test(htmlData))) {
            e.preventDefault();
            const structured = structuredTextToHtml(textData);
            if ((contentEditor.innerText || '').trim().length === 0) {
              contentEditor.innerHTML = structured;
            } else {
              document.execCommand('insertHTML', false, structured);
            }
            sanitizeAndStructureEditorDom(contentEditor);
          } else {
            setTimeout(() => sanitizeAndStructureEditorDom(contentEditor), 20);
          }
        });
      }

      if (deleteBtn) {
        on(deleteBtn, 'click', () => {
          if (editingId) {
            void deleteGuideDocumentById(editingId);
          }
        });
      }

      if (listEl) {
        on(listEl, 'click', handleListClick);
      }
    }

    function init() {
      bindEvents();
      void loadGuideDocuments();
    }

    return {
      init,
      render: loadGuideDocuments,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createGuideModule = createGuideModule;
})(window);

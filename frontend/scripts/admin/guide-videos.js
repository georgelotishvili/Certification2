(function (global) {
  function createGuideModule(context) {
    const {
      DOM,
      API_BASE,
      on,
      escapeHtml,
      showToast = () => {},
      handleAdminErrorResponse = () => {},
      getAdminHeaders = () => ({}),
       getActorHeaders = () => ({}),
    } = context;

    let currentGuideDoc = null;
    let selectedFile = null;
    let isSaving = false;

    function getElements() {
      return {
        statusCard: document.getElementById('guideDocStatusCard'),
        titleInput: document.getElementById('guideDocTitle'),
        fileInput: document.getElementById('guideDocFile'),
        fileChooseBtn: document.getElementById('guideDocFileChoose'),
        fileNameSpan: document.getElementById('guideDocFileName'),
        contentEditor: document.getElementById('guideDocContent'),
        saveBtn: document.getElementById('guideDocSaveBtn'),
        formatBtn: document.getElementById('guideDocFormatBtn'),
        deleteBtn: document.getElementById('guideDocDeleteBtn'),
      };
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

        // If container only has raw text or <br>/<div> blocks without <h1/h2/p>, re-run structuredTextToHtml
        const hasSemanticBlocks = Boolean(container.querySelector('h1, h2, h3, ul, ol, table'));
        const topPs = Array.from(container.children).filter((el) => el.tagName === 'P');
        if (!hasSemanticBlocks && topPs.length === 0) {
          const plain = (container.innerText || container.textContent || '').trim();
          if (plain) {
            container.innerHTML = structuredTextToHtml(plain);
            return;
          }
        }

        // Promote standalone bold or numbered section <p> elements into <h1> / <h2> / <h3>
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

    function renderStatusCard() {
      const { statusCard, deleteBtn } = getElements();
      if (!statusCard) return;

      const doc = currentGuideDoc;
      const isAvailable = Boolean(doc && doc.available);
      const hasFile = Boolean(doc && doc.filename);
      const updatedLabel = doc?.updated_at ? formatDateGeo(doc.updated_at) : '';
      const sizeLabel = doc?.file_size_bytes ? formatFileSize(doc.file_size_bytes) : '';

      if (deleteBtn) {
        deleteBtn.style.display = isAvailable ? 'inline-flex' : 'none';
      }

      statusCard.innerHTML = `
        <div class="contract-slot-card ${isAvailable ? 'is-ready' : 'is-missing'}">
          <div class="contract-slot-head">
            <span class="contract-slot-code">GIPC-GDE-001</span>
            <span class="contract-slot-status ${isAvailable ? 'ok' : 'warn'}">
              ${isAvailable ? 'გამოქვეყნებულია საჯარო გზამკვლევში' : 'დოკუმენტი არ არის ატვირთული'}
            </span>
          </div>
          <div class="contract-slot-title">${escapeHtml(doc?.title || 'გზამკვლევი')}</div>
          <div class="contract-slot-meta">
            ${
              hasFile
                ? `ატვირთული ფაილი: <strong>${escapeHtml(doc.filename)}</strong>${sizeLabel ? ` (${escapeHtml(sizeLabel)})` : ''}`
                : isAvailable
                ? 'განთავსებულია სტრუქტურირებული ტექსტური გზამკვლევი'
                : 'ატვირთეთ Word (.docx), Markdown (.md), ტექსტური (.txt) ან PDF ფაილი, ან ჩასვით ტექსტი ქვემოთ რედაქტორში'
            }
            ${updatedLabel ? ` · განახლდა: ${escapeHtml(updatedLabel)}` : ''}
          </div>
          <div class="contract-slot-actions">
            <button type="button" class="contract-slot-btn primary" data-guide-quick-upload>
              დოკუმენტის ფაილის ატვირთვა (.docx / .md / .txt / .pdf)
            </button>
            ${
              hasFile
                ? `<button type="button" class="contract-slot-btn" data-guide-download-file>ფაილის ჩამოტვირთვა</button>`
                : ''
            }
          </div>
        </div>
      `;

      const quickUploadBtn = statusCard.querySelector('[data-guide-quick-upload]');
      if (quickUploadBtn) {
        on(quickUploadBtn, 'click', () => {
          const { fileInput } = getElements();
          fileInput?.click();
        });
      }

      const downloadBtn = statusCard.querySelector('[data-guide-download-file]');
      if (downloadBtn) {
        on(downloadBtn, 'click', () => {
          window.open(`${API_BASE}/guide/document/download`, '_blank');
        });
      }
    }

    async function loadGuideDocument() {
      const { statusCard, titleInput, contentEditor, fileNameSpan } = getElements();
      if (statusCard) {
        statusCard.innerHTML = '<div class="documents-empty">იტვირთება გზამკვლევის მონაცემები...</div>';
      }

      try {
        let response = await fetch(`${API_BASE}/admin/guide/document`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
          cache: 'no-cache',
        });
        if (!response.ok) {
          response = await fetch(`${API_BASE}/guide/document`, { cache: 'no-cache' });
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        currentGuideDoc = await response.json();
        if (titleInput) {
          titleInput.value = currentGuideDoc.title || 'გზამკვლევი';
        }
        if (contentEditor) {
          contentEditor.innerHTML = currentGuideDoc.content || '';
          sanitizeAndStructureEditorDom(contentEditor);
        }
        if (fileNameSpan) {
          fileNameSpan.textContent = currentGuideDoc.filename
            ? `მიმდინარე ფაილი: ${currentGuideDoc.filename}`
            : 'ფაილი არჩეული არ არის';
          fileNameSpan.classList.toggle('has-file', Boolean(currentGuideDoc.filename));
        }
        renderStatusCard();
      } catch (err) {
        console.error('Failed to load guide document:', err);
        if (statusCard) {
          statusCard.innerHTML = '<div class="documents-empty">გზამკვლევის ჩატვირთვა ვერ მოხერხდა</div>';
        }
      }
    }

    async function handleFileSelect(event) {
      const file = event?.target?.files?.[0];
      if (!file) return;

      const { fileNameSpan, contentEditor, titleInput } = getElements();
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
      if (fileNameSpan) {
        fileNameSpan.textContent = `${file.name} (${formatFileSize(file.size)})`;
        fileNameSpan.classList.add('has-file');
      }

      if (titleInput && !titleInput.value.trim()) {
        titleInput.value = 'გზამკვლევი';
      }

      if (isMdOrTxt && contentEditor) {
        try {
          const rawText = await file.text();
          contentEditor.innerHTML = structuredTextToHtml(rawText);
          sanitizeAndStructureEditorDom(contentEditor);
        } catch (err) {
          console.error('Error reading text/markdown file:', err);
        }
      } else if (isDocx && contentEditor && typeof mammoth !== 'undefined') {
        try {
          contentEditor.innerHTML = '<p style="color:#64748b;">მიმდინარეობს Word ფაილის დამუშავება...</p>';
          const arrayBuffer = await file.arrayBuffer();
          const result = await mammoth.convertToHtml(
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
        } catch (err) {
          console.error('Mammoth conversion error:', err);
          contentEditor.innerHTML = '';
        }
      }

      // Automatically save and publish when a file is chosen so uploading is immediate
      await saveGuideDocument({ autoFromFile: true });
    }

    async function saveGuideDocument(options = {}) {
      if (isSaving) return;
      const { titleInput, contentEditor, saveBtn, fileInput } = getElements();

      const title = (titleInput?.value || 'გზამკვლევი').trim() || 'გზამკვლევი';
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

      if (!plainText && !selectedFile && !(currentGuideDoc && currentGuideDoc.filename)) {
        if (!options.autoFromFile) {
          showToast('გთხოვთ ატვირთოთ დოკუმენტის ფაილი ან ჩასვათ გზამკვლევის ტექსტი', 'error');
        }
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
        }

        const response = await fetch(`${API_BASE}/admin/guide/document`, {
          method: 'POST',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
          body: formData,
        });

        if (!response.ok) {
          await handleAdminErrorResponse(response, 'გზამკვლევის შენახვა ვერ მოხერხდა', showToast);
          return;
        }

        currentGuideDoc = await response.json();
        selectedFile = null;
        if (fileInput) fileInput.value = '';

        if (contentEditor && currentGuideDoc.content) {
          contentEditor.innerHTML = currentGuideDoc.content;
          sanitizeAndStructureEditorDom(contentEditor);
        }

        renderStatusCard();
        showToast('გზამკვლევის დოკუმენტი წარმატებით შეინახა და გამოქვეყნდა', 'success');
      } catch (err) {
        console.error('Failed to save guide document:', err);
        showToast('გზამკვლევის შენახვა ვერ მოხერხდა', 'error');
      } finally {
        isSaving = false;
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'შენახვა და გამოქვეყნება';
        }
      }
    }

    async function deleteGuideDocument() {
      if (!confirm('ნამდვილად გსურთ გზამკვლევის დოკუმენტის წაშლა?')) return;

      const { contentEditor, fileNameSpan, fileInput } = getElements();
      try {
        const response = await fetch(`${API_BASE}/admin/guide/document`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok && response.status !== 204) {
          await handleAdminErrorResponse(response, 'გზამკვლევის წაშლა ვერ მოხერხდა', showToast);
          return;
        }

        currentGuideDoc = null;
        selectedFile = null;
        if (fileInput) fileInput.value = '';
        if (contentEditor) contentEditor.innerHTML = '';
        if (fileNameSpan) {
          fileNameSpan.textContent = 'ფაილი არჩეული არ არის';
          fileNameSpan.classList.remove('has-file');
        }
        renderStatusCard();
        showToast('გზამკვლევის დოკუმენტი წაიშალა', 'success');
      } catch (err) {
        console.error('Failed to delete guide document:', err);
        showToast('გზამკვლევის წაშლა ვერ მოხერხდა', 'error');
      }
    }

    function bindEvents() {
      const { fileChooseBtn, fileInput, saveBtn, formatBtn, deleteBtn, contentEditor } = getElements();

      if (fileChooseBtn && fileInput) {
        on(fileChooseBtn, 'click', () => fileInput.click());
        on(fileInput, 'change', handleFileSelect);
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
        on(deleteBtn, 'click', () => void deleteGuideDocument());
      }
    }

    function init() {
      bindEvents();
      void loadGuideDocument();
    }

    return {
      init,
      render: loadGuideDocument,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createGuideModule = createGuideModule;
})(window);

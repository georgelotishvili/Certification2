// frontend/scripts/registry.mini.js
// Small, shared registry modal module used by multiple pages.
// Exposes: window.Registry.init({ api, triggers, beforeOpen, onCardClick, refreshRating })
(function () {
  function init(options = {}) {
    const apiBase =
      options.api ||
      (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === 'string'
        ? window.APP_CONFIG.API_BASE
        : 'http://127.0.0.1:8000');

    const triggers = options.triggers || ['.nav-registry', '.drawer-registry'];
    const beforeOpen = typeof options.beforeOpen === 'function' ? options.beforeOpen : null;
    const onCardClick = typeof options.onCardClick === 'function' ? options.onCardClick : null;
    const refreshRating = options.refreshRating !== false;

    const DOM = {
      body: document.body,
      overlay: document.getElementById('registryOverlay'),
      closeBtn: document.getElementById('registryClose'),
      list: document.getElementById('registryList'),
      search: document.getElementById('registrySearch'),
      filterArchitect: document.getElementById('registryFilterArchitect'),
      filterExpert: document.getElementById('registryFilterExpert'),
      sort: document.getElementById('registrySort'),
    };

    const STATE = {
      open: false,
      loading: false,
      loaded: false,
      items: [],
      filtered: [],
    };

    const collator = new Intl.Collator('ka', { sensitivity: 'base', ignorePunctuation: true, usage: 'sort' });

    // Utils
    const toNumber = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };

    const normalizeText = (value) => String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

    const escapeHtml = (value) =>
      String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const formatRating = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(2) : '0.00';
    };

    const formatExamScore = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? `${Math.round(n)}%` : '0%';
    };

    const toTimeValue = (value) => {
      if (!value) return 0;
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) return parsed;
      const s = String(value).trim();
      const withTz = /Z$|[+-]\d{2}:?\d{2}$/.test(s) ? s : (s.includes('T') ? s : s.replace(' ', 'T')) + 'Z';
      const t = Date.parse(withTz);
      return Number.isNaN(t) ? 0 : t;
    };

    function bindEvents() {
      if (!DOM.overlay) return;

      // Event delegation: works for dynamically inserted header
      document.addEventListener('click', (event) => {
        const target = event.target;
        if (!target) return;
        const matched = triggers.map((sel) => target.closest(sel)).find(Boolean);
        if (!matched) return;
        event.preventDefault();
        beforeOpen?.(matched);
        open();
      });

      DOM.closeBtn?.addEventListener('click', (event) => {
        event.preventDefault();
        close();
      });

      DOM.overlay?.addEventListener('click', (event) => {
        if (event.target === DOM.overlay) close();
      });

      DOM.search?.addEventListener('input', applyFilters);
      DOM.filterArchitect?.addEventListener('change', applyFilters);
      DOM.filterExpert?.addEventListener('change', applyFilters);
      DOM.sort?.addEventListener('change', applyFilters);
    }

    function setOpen(value) {
      STATE.open = !!value;
      DOM.overlay?.classList.toggle('is-open', STATE.open);
      DOM.overlay?.setAttribute('aria-hidden', STATE.open ? 'false' : 'true');
      DOM.body?.classList.toggle('registry-open', STATE.open);
    }

    function open() {
      if (STATE.open) return;
      setOpen(true);
      ensureData();
    }

    function close() {
      if (!STATE.open) return;
      setOpen(false);
    }

    async function ensureData(force = false) {
      if (!DOM.list) return;
      if (STATE.loading) return;
      if (STATE.loaded && !force) {
        applyFilters();
        return;
      }
      STATE.loading = true;
      DOM.list.innerHTML = '<div class="registry-empty">იტვირთება...</div>';
      try {
        const params = new URLSearchParams({ limit: '500' });
        const response = await fetch(`${apiBase}/certified-persons/registry?${params.toString()}`, {
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!response.ok) throw new Error('registry failed');
        const data = await response.json();
        STATE.items = (Array.isArray(data) ? data : []).map(normalizePerson);
        STATE.loaded = true;
        applyFilters();
      } catch {
        DOM.list.innerHTML = `
          <div class="registry-empty">
            <div>რეესტრი ვერ ჩაიტვირთა</div>
            <button type="button" class="registry-retry">კიდევ სცადე</button>
          </div>`;
        DOM.list.querySelector('.registry-retry')?.addEventListener('click', (e) => {
          e.preventDefault();
          ensureData(true);
        });
      } finally {
        STATE.loading = false;
      }
    }

    function normalizePerson(person) {
      return {
        id: person?.id,
        full_name: (person?.full_name || '').trim(),
        photo_url: (person?.photo_url || '').trim(),
        unique_code: (person?.unique_code || '').trim(),
        qualification: (person?.qualification || '').trim().toLowerCase(),
        certificate_status: (person?.certificate_status || '').trim().toLowerCase(),
        rating: toNumber(person?.rating),
        exam_score: toNumber(person?.exam_score),
        registration_date: person?.registration_date || person?.created_at || null,
      };
    }

    // Default profile icon SVG
    const DEFAULT_PROFILE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:100%;height:100%;color:#9ca3af;">
      <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
    </svg>`;

    // Photo modal for enlarged view
    let photoModal = null;
    function showPhotoModal(photoUrl, altText) {
      if (!photoModal) {
        photoModal = document.createElement('div');
        photoModal.className = 'photo-modal-overlay';
        photoModal.innerHTML = `
          <div class="photo-modal-content">
            <button type="button" class="photo-modal-close" aria-label="დახურვა">×</button>
            <img class="photo-modal-img" src="" alt="" />
          </div>
        `;
        document.body.appendChild(photoModal);
        
        photoModal.addEventListener('click', (e) => {
          if (e.target === photoModal || e.target.classList.contains('photo-modal-close')) {
            photoModal.classList.remove('open');
          }
        });
        
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape' && photoModal.classList.contains('open')) {
            photoModal.classList.remove('open');
          }
        });
      }
      
      const img = photoModal.querySelector('.photo-modal-img');
      if (img) {
        img.src = photoUrl;
        img.alt = altText || 'ფოტო';
      }
      photoModal.classList.add('open');
    }

    function getSorter(key) {
      const map = {
        name_asc: (a, b) => collator.compare(a.full_name || '', b.full_name || ''),
        name_desc: (a, b) => collator.compare(b.full_name || '', a.full_name || ''),
        date_asc: (a, b) => toTimeValue(a.registration_date) - toTimeValue(b.registration_date),
        date_desc: (a, b) => toTimeValue(b.registration_date) - toTimeValue(a.registration_date),
        score_asc: (a, b) => (a.exam_score ?? -Infinity) - (b.exam_score ?? -Infinity),
        score_desc: (a, b) => (b.exam_score ?? -Infinity) - (a.exam_score ?? -Infinity),
        rating_asc: (a, b) => (a.rating ?? -Infinity) - (b.rating ?? -Infinity),
        rating_desc: (a, b) => (b.rating ?? -Infinity) - (a.rating ?? -Infinity),
      };
      return map[key] || map.date_desc;
    }

    function applyFilters() {
      if (!DOM.list) return;
      if (!STATE.loaded) {
        if (!STATE.loading && !STATE.items.length) {
          DOM.list.innerHTML = '<div class="registry-empty">ჩანაწერები ვერ მოიძებნა</div>';
        }
        return;
      }
      let next = STATE.items.slice();

      const query = normalizeText(DOM.search?.value);
      if (query) {
        next = next.filter((person) => {
          const parts = (person.full_name || '').split(/\s+/).filter(Boolean);
          const first = parts[0] || '';
          const last = parts.slice(1).join(' ') || '';
          const tokens = [normalizeText(person.full_name), normalizeText(person.unique_code), normalizeText(first), normalizeText(last)];
          return tokens.some((t) => t && t.includes(query));
        });
      }

      const architectChecked = !!DOM.filterArchitect?.checked;
      const expertChecked = !!DOM.filterExpert?.checked;
      if ((architectChecked && !expertChecked) || (!architectChecked && expertChecked)) {
        next = next.filter((p) => p.qualification === (architectChecked ? 'architect' : 'expert'));
      }

      const sortKey = DOM.sort?.value || 'date_desc';
      next.sort(getSorter(sortKey));

      renderList(next);
    }

    function renderList(items) {
      if (!DOM.list) return;
      if (!items.length) {
        DOM.list.innerHTML = '<div class="registry-empty">ჩანაწერები ვერ მოიძებნა</div>';
        return;
      }
      const fragment = document.createDocumentFragment();
      items.forEach((person) => fragment.appendChild(createCard(person)));
      DOM.list.innerHTML = '';
      DOM.list.appendChild(fragment);
    }

    function createCard(person) {
      const card = document.createElement('article');
      card.className = 'registry-card';
      card.dataset.qualification = person.qualification || '';
      card.dataset.status = person.certificate_status || '';
      card.setAttribute('role', 'listitem');
      
      const hasPhoto = !!(person.photo_url && person.photo_url.trim());
      const avatarContent = hasPhoto
        ? `<img src="${escapeHtml(person.photo_url)}" alt="${escapeHtml(person.full_name || 'სერტიფიცირებული პირი')}" class="registry-avatar-img" />`
        : DEFAULT_PROFILE_ICON;
      
      card.innerHTML = `
        <div class="registry-avatar${hasPhoto ? ' has-photo' : ''}">
          ${avatarContent}
        </div>
        <div class="registry-info">
          <div class="registry-name">${escapeHtml(person.full_name || '—')}</div>
          <div class="registry-meta">
            <span class="registry-rating" aria-label="რეიტინგი">⭐ ${formatRating(person.rating)}</span>
            <span class="registry-score" aria-label="გამოცდის ქულა">${formatExamScore(person.exam_score)}</span>
          </div>
        </div>`;

      // Photo click to enlarge (only if has photo)
      if (hasPhoto) {
        const avatar = card.querySelector('.registry-avatar');
        avatar?.addEventListener('click', (e) => {
          e.stopPropagation();
          showPhotoModal(person.photo_url, person.full_name);
        });
      }

      if (refreshRating) {
        void refreshCardRating(card, person.id);
      }

      card.addEventListener('click', () => {
        if (onCardClick) {
          onCardClick(person);
          return;
        }
        const id = person?.id;
        window.location.href = id ? `my.html?userId=${encodeURIComponent(id)}` : 'my.html';
      });

      return card;
    }

    async function refreshCardRating(card, userId) {
      try {
        if (!userId) return;
        const res = await fetch(`${apiBase}/reviews/${encodeURIComponent(userId)}/summary`, {
          headers: { 'Cache-Control': 'no-cache' },
        });
        if (!res.ok) return;
        const data = await res.json();
        const avg = Number(data?.average);
        if (!Number.isFinite(avg)) return;
        const ratingEl = card.querySelector('.registry-rating');
        if (ratingEl) ratingEl.textContent = `⭐ ${formatRating(avg)}`;
      } catch {}
    }

    // Wire up events on load
    bindEvents();

    return {
      open,
      close,
      refresh: ensureData,
      isOpen: () => STATE.open,
    };
  }

  window.Registry = { init };
})();



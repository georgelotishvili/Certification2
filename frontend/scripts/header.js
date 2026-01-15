(function () {
  'use strict';

  // Signal that header-specific bindings are handled here
  window.HEADER_JS_ACTIVE = true;

  function on(el, type, handler) {
    if (!el || !type || !handler) return;
    try { el.addEventListener(type, handler, false); } catch {}
  }
  function closest(target, selector) {
    try { return target && typeof target.closest === 'function' ? target.closest(selector) : null; } catch { return null; }
  }
  function isMyPage() {
    try { return window.location.pathname.includes('my.html'); } catch { return false; }
  }
  function isLoggedIn() {
    try { return window.Auth?.isLoggedIn?.() === true; } catch { return false; }
  }
  function openAuthModal() {
    try { return window.Auth?.openModal?.(); } catch {}
  }

  // Page cover crossfade (0.3s)
  function mountPageCover(opaque) {
    try {
      let el = document.getElementById('pageCover');
      if (!el) {
        el = document.createElement('div');
        el.id = 'pageCover';
        el.className = 'page-cover';
        document.documentElement.appendChild(el);
      } else {
        el.classList.add('page-cover');
      }
      el.style.opacity = opaque ? '1' : '0';
      return el;
    } catch { return null; }
  }

  function setupPageCoverOnLoad() {
    try {
      if (sessionStorage.getItem('pageCover') === '1') {
        const el = mountPageCover(true);
        requestAnimationFrame(() => {
          if (!el) return;
          el.style.transition = 'opacity 0.3s ease';
          el.style.opacity = '0';
          setTimeout(() => { try { el.remove(); } catch {}; sessionStorage.removeItem('pageCover'); }, 300);
        });
      }
    } catch {}
  }

  function transitionTo(url) {
    try {
      // Ensure URL doesn't have hash to scroll to top
      const cleanUrl = url.split('#')[0];
      // Skip transition for admin page
      if (cleanUrl.includes('admin.html')) {
        window.location.href = cleanUrl;
        return;
      }
      const el = mountPageCover(false);
      if (!el) { 
        window.location.href = cleanUrl;
        return; 
      }
      void el.offsetWidth; // reflow to ensure transition applies
      el.style.transition = 'opacity 0.3s ease';
      el.style.opacity = '1';
      sessionStorage.setItem('pageCover', '1');
      setTimeout(() => { window.location.href = cleanUrl; }, 300);
    } catch {
      const cleanUrl = url.split('#')[0];
      // Skip transition for admin page
      if (cleanUrl.includes('admin.html')) {
        window.location.href = cleanUrl;
        return;
      }
      window.location.href = cleanUrl;
    }
  }

  // Initialize cover fade on page load if requested
  setupPageCoverOnLoad();

  // Site Info Modal helpers (About / Terms)
  function getSiteInfoElements() {
    try {
      const modal = document.getElementById('siteInfoModal');
      if (!modal) return null;
      return {
        modal,
        title: modal.querySelector('#siteInfoTitle'),
        body: modal.querySelector('#siteInfoBody'),
        closeBtn: modal.querySelector('.modal-close'),
      };
    } catch {
      return null;
    }
  }

  function getSiteInfoPath(type) {
    switch (type) {
      case 'about':
      case 'terms':
      case 'process':
      case 'guide':
      case 'legal-base':
      case 'team':
        return `../partials/site-info/${type}.html`;
      case 'contract':
        return `../partials/site-info/exam-service-contract.html`;
      case 'certification-contract':
        return `../partials/site-info/certification-service-contract.html`;
      default:
        return `../partials/site-info/about.html`;
    }
  }

  function getApiBase() {
    try {
      if (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === 'string') {
        return window.APP_CONFIG.API_BASE;
      }
    } catch {}
    return 'http://127.0.0.1:8000';
  }

  // Site Documents - dynamic loading from API
  let cachedDocuments = null;

  async function fetchSiteDocuments() {
    if (cachedDocuments) return cachedDocuments;
    try {
      const API_BASE = getApiBase();
      const response = await fetch(`${API_BASE}/documents`, { cache: 'no-cache' });
      if (!response.ok) return [];
      const data = await response.json();
      cachedDocuments = data.items || [];
      return cachedDocuments;
    } catch (err) {
      console.error('Failed to fetch site documents:', err);
      return [];
    }
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

  async function populateInfoDropdowns() {
    try {
      const documents = await fetchSiteDocuments();
      
      // Desktop dropdown
      const desktopContainer = document.querySelector('.about-dropdown .dropdown-dynamic');
      if (desktopContainer) {
        if (documents.length === 0) {
          desktopContainer.innerHTML = '';
        } else {
          desktopContainer.innerHTML = documents.map(doc => 
            `<button type="button" class="dropdown-item" data-doc-id="${escapeHtml(String(doc.id))}">${escapeHtml(doc.title)}</button>`
          ).join('');
        }
      }
      
      // Mobile drawer submenu
      const mobileContainer = document.querySelector('.drawer-about-submenu .drawer-submenu-dynamic');
      if (mobileContainer) {
        if (documents.length === 0) {
          mobileContainer.innerHTML = '';
        } else {
          mobileContainer.innerHTML = documents.map(doc => 
            `<button type="button" class="drawer-submenu-item" data-doc-id="${escapeHtml(String(doc.id))}">${escapeHtml(doc.title)}</button>`
          ).join('');
        }
      }
    } catch (err) {
      console.error('Failed to populate info dropdowns:', err);
    }
  }

  // Word inline სტილების გასუფთავება და ბულეტების კონვერტაცია
  function sanitizeWordStyles(container) {
    if (!container) return;
    try {
      // ყველა ელემენტის სტილების გასუფთავება
      const allElements = container.querySelectorAll('*');
      allElements.forEach(el => {
        if (el.style) {
          el.style.fontSize = '';
          el.style.fontFamily = '';
          el.style.marginLeft = '';
          el.style.textIndent = '';
          if (el.style.cssText) {
            el.style.cssText = el.style.cssText.replace(/mso-[^;]+;?/gi, '');
          }
        }
        el.removeAttribute('class');
      });

      // ბულეტიანი აბზაცების კონვერტაცია <ul>/<li>-ში
      const bulletChars = '·•\\-–—§■□►▪▸●○⁃◦◘◙';
      const bulletRegex = new RegExp('^[\\s\\u00A0]*[' + bulletChars + '][\\s\\u00A0]*');
      const paragraphs = Array.from(container.querySelectorAll('p'));
      
      let currentUl = null;
      let lastWasBullet = false;
      
      paragraphs.forEach(p => {
        const text = p.textContent || '';
        const isBullet = bulletRegex.test(text);
        
        if (isBullet) {
          const li = document.createElement('li');
          // წავშალოთ ბულეტის სიმბოლო ტექსტიდან
          const cleanBulletRegex = new RegExp('[' + bulletChars + '][\\s\\u00A0]*', 'g');
          li.innerHTML = p.innerHTML.replace(cleanBulletRegex, '').trim();
          
          if (!currentUl) {
            currentUl = document.createElement('ul');
            p.parentNode.insertBefore(currentUl, p);
          }
          
          currentUl.appendChild(li);
          p.remove();
          lastWasBullet = true;
        } else {
          if (lastWasBullet) {
            currentUl = null;
          }
          lastWasBullet = false;
        }
      });

      // უკვე არსებული <li> ელემენტებიდანაც წავშალოთ ბულეტის სიმბოლოები
      container.querySelectorAll('li').forEach(li => {
        const cleanBulletRegex = new RegExp('[' + bulletChars + '][\\s\\u00A0]*', 'g');
        li.innerHTML = li.innerHTML.replace(cleanBulletRegex, '').trim();
      });
    } catch (e) { console.error('sanitizeWordStyles error:', e); }
  }

  async function openDocumentById(docId) {
    try {
      const els = getSiteInfoElements();
      if (!els) return;

      if (els.body) els.body.innerHTML = '<p style="opacity:.7">იტვირთება...</p>';
      els.modal.classList.add('show');
      els.modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      if (els.closeBtn && typeof els.closeBtn.focus === 'function') {
        setTimeout(() => { try { els.closeBtn.focus(); } catch {} }, 0);
      }

      const API_BASE = getApiBase();
      const response = await fetch(`${API_BASE}/documents/${docId}`, { cache: 'no-cache' });
      if (!response.ok) throw new Error('Document not found');
      const doc = await response.json();
      
      if (els.title) els.title.textContent = doc.title || 'დოკუმენტი';
      if (els.body) {
        els.body.innerHTML = doc.content || '<p>შიგთავსი არ არის.</p>';
        sanitizeWordStyles(els.body);
      }
    } catch (err) {
      console.error('Failed to load document:', err);
      const els = getSiteInfoElements();
      if (els?.body) els.body.innerHTML = '<p style="color:#b91c1c">დოკუმენტი ვერ ჩაიტვირთა.</p>';
    }
  }

  /**
   * Extract embed URL from various video platforms
   */
  function getVideoEmbedUrl(url) {
    if (!url || typeof url !== 'string') return null;

    // YouTube - various formats
    // https://www.youtube.com/watch?v=VIDEO_ID
    // https://youtu.be/VIDEO_ID
    // https://www.youtube.com/embed/VIDEO_ID
    const youtubeMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (youtubeMatch) {
      return `https://www.youtube.com/embed/${youtubeMatch[1]}`;
    }

    // Vimeo - various formats
    // https://vimeo.com/VIDEO_ID
    // https://player.vimeo.com/video/VIDEO_ID
    const vimeoMatch = url.match(/(?:vimeo\.com\/|player\.vimeo\.com\/video\/)(\d+)/);
    if (vimeoMatch) {
      return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
    }

    // Dailymotion
    // https://www.dailymotion.com/video/VIDEO_ID
    const dailymotionMatch = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/);
    if (dailymotionMatch) {
      return `https://www.dailymotion.com/embed/video/${dailymotionMatch[1]}`;
    }

    // Facebook video
    const facebookMatch = url.match(/facebook\.com.*\/videos\/(\d+)/);
    if (facebookMatch) {
      return `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`;
    }

    // Already an embed URL or other platform - return as is for iframe
    if (url.includes('embed') || url.includes('player')) {
      return url;
    }

    // Unknown format - return null
    return null;
  }

  async function loadGuideVideosInto(container) {
    try {
      if (!container) return;
      const listEl = container.querySelector('#guideVideosPublic') || container;
      const API_BASE = getApiBase();
      listEl.innerHTML = '<p style="opacity:.7">ვიდეოები იტვირთება...</p>';
      const response = await fetch(`${API_BASE}/guide/videos`, { cache: 'no-cache' });
      if (!response.ok) {
        listEl.innerHTML = '<p style="color:#b91c1c">ვიდეოების სია ვერ ჩაიტვირთა. სცადეთ მოგვიანებით.</p>';
        return;
      }
      const items = await response.json();
      if (!Array.isArray(items) || !items.length) {
        listEl.innerHTML = '<p style="opacity:.8">ამ ეტაპზე გზამკვლევის ვიდეო არ არის დამატებული.</p>';
        return;
      }
      listEl.innerHTML = '';
      items.forEach((video) => {
        const card = document.createElement('div');
        card.className = 'guide-video-public-card';
        const title = video.title || 'ვიდეო';
        const url = video.url || '';
        const embedUrl = getVideoEmbedUrl(url);

        const head = document.createElement('div');
        head.className = 'guide-video-public-head';
        const titleEl = document.createElement('div');
        titleEl.className = 'guide-video-public-title';
        titleEl.textContent = title;
        head.appendChild(titleEl);

        card.appendChild(head);

        if (embedUrl) {
          // Create iframe for embed
          const iframe = document.createElement('iframe');
          iframe.className = 'guide-video-embed';
          iframe.src = embedUrl;
          iframe.setAttribute('frameborder', '0');
          iframe.setAttribute('allowfullscreen', 'true');
          iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
          iframe.loading = 'lazy';
          card.appendChild(iframe);
        } else if (url) {
          // Fallback: show link if embed not supported
          const linkWrapper = document.createElement('div');
          linkWrapper.className = 'guide-video-link-wrapper';
          const link = document.createElement('a');
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.className = 'guide-video-link';
          link.textContent = 'ვიდეოს ნახვა →';
          linkWrapper.appendChild(link);
          card.appendChild(linkWrapper);
        } else {
          const noVideo = document.createElement('div');
          noVideo.className = 'guide-video-no-url';
          noVideo.textContent = 'ვიდეოს ლინკი არ არის მითითებული';
          card.appendChild(noVideo);
        }

        listEl.appendChild(card);
      });
    } catch (error) {
      console.error('Failed to load guide videos', error);
      try {
        if (container) {
          const listEl = container.querySelector('#guideVideosPublic') || container;
          listEl.innerHTML = '<p style="color:#b91c1c">ვიდეოების ჩატვირთვა ვერ მოხერხდა.</p>';
        }
      } catch {}
    }
  }

  async function openSiteInfo(type) {
    try {
      const els = getSiteInfoElements();
      if (!els) return;
      const titles = {
        about: 'ჩვენს შესახებ',
        terms: 'წესები და პირობები',
        process: 'საგამოცდო პროცესი',
        contract: 'საგამოცდო ხელშეკრულება',
        'certification-contract': 'სასერტიფიკაციო ხელშეკრულება',
        'legal-base': 'საკანონმდებლო ბაზა',
        team: 'ჩვენი გუნდი',
        guide: 'გზამკვლევი',
      };
      if (els.title) els.title.textContent = titles[type] || 'ინფორმაცია';

      if (els.body) els.body.innerHTML = '<p style="opacity:.7">იტვირთება...</p>';
      els.modal.classList.add('show');
      els.modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      if (els.closeBtn && typeof els.closeBtn.focus === 'function') {
        setTimeout(() => { try { els.closeBtn.focus(); } catch {} }, 0);
      }

      // Special handling for team - load from API
      if (type === 'team') {
        await loadTeamIntoModal(els.body);
        return;
      }

      const res = await fetch(getSiteInfoPath(type), { cache: 'no-cache' });
      if (!res.ok) throw new Error('load failed');
      const html = await res.text();
      if (els.body) {
        els.body.innerHTML = html;
        if (type === 'guide') {
          void loadGuideVideosInto(els.body);
        }
      }
    } catch {
      const els = getSiteInfoElements();
      if (els?.body) els.body.innerHTML = '<p style="color:#b91c1c">ვერ ჩაიტვირთა შიგთავსი. სცადეთ მოგვიანებით.</p>';
    }
  }

  async function loadTeamIntoModal(container) {
    if (!container) return;
    try {
      const API_BASE = getApiBase();
      container.innerHTML = '<p style="opacity:.7">გუნდი იტვირთება...</p>';
      const response = await fetch(`${API_BASE}/team`, { cache: 'no-cache' });
      if (!response.ok) {
        container.innerHTML = '<p style="color:#b91c1c">გუნდის ჩატვირთვა ვერ მოხერხდა. სცადეთ მოგვიანებით.</p>';
        return;
      }
      const data = await response.json();
      const members = data.items || [];
      
      if (!members.length) {
        container.innerHTML = '<p style="opacity:.8">გუნდის წევრები ჯერ არ არის დამატებული.</p>';
        return;
      }

      const categoryNames = {
        1: 'მმართველი გუნდი',
        2: 'სასერტიფიკაციო კომიტეტი და ექსპერტთა საბჭო',
        3: 'ადმინისტრაცია',
      };

      const escapeHtml = (str) => {
        if (!str) return '';
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      };

      let html = '';
      [1, 2, 3].forEach((category) => {
        const categoryMembers = members.filter(m => m.category === category);
        if (categoryMembers.length === 0) return;

        html += `<h3>${escapeHtml(categoryNames[category])}:</h3>`;
        html += '<ol class="team-list-public">';
        categoryMembers.forEach((member) => {
          const position = escapeHtml(member.position || '');
          const firstName = escapeHtml(member.first_name || '');
          const lastName = escapeHtml(member.last_name || '');
          const email = escapeHtml(member.email || '');
          const phone = escapeHtml(member.phone || '');

          let contacts = '';
          if (email || phone) {
            contacts = '<span class="team-contacts">';
            if (email) contacts += `<span class="team-email">${email}</span>`;
            if (phone) contacts += `<span class="team-phone">${phone}</span>`;
            contacts += '</span>';
          }

          html += `<li><strong>${position}:</strong> ${firstName} ${lastName}${contacts}</li>`;
        });
        html += '</ol>';
      });

      container.innerHTML = html || '<p style="opacity:.8">გუნდის წევრები ჯერ არ არის დამატებული.</p>';
    } catch (error) {
      console.error('Failed to load team', error);
      container.innerHTML = '<p style="color:#b91c1c">გუნდის ჩატვირთვა ვერ მოხერხდა.</p>';
    }
  }

  function closeSiteInfo() {
    try {
      const els = getSiteInfoElements();
      if (!els) return;
      els.modal.classList.remove('show');
      els.modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
      if (els.body) els.body.innerHTML = '';
    } catch {}
  }

  function bindHeader() {
    const DOM = {
      body: document.body,
      burger: document.querySelector('.burger'),
      overlay: document.querySelector('.overlay'),
      drawer: document.querySelector('.drawer'),
      drawerClose: document.querySelector('.drawer-close'),
      drawerLinks: Array.from(document.querySelectorAll('.drawer-nav a')),
      drawerAboutTrigger: document.querySelector('.drawer-about-trigger'),
      drawerAboutSubmenu: document.querySelector('.drawer-about-submenu'),
      loginBtn: document.querySelector('.login-btn'),
      drawerLoginBtn: document.querySelector('.drawer-login'),
      navLogo: document.querySelector('.nav-bar .logo'),
      aboutTrigger: document.querySelector('.nav .about-trigger'),
      aboutDropdown: document.querySelector('.nav .about-dropdown'),
    };

    function setMenu(open) {
      DOM.body?.classList.toggle('menu-open', !!open);
      if (DOM.burger) DOM.burger.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) {
        closeDrawerAboutSubmenu();
      }
    }
    function openMenu() { setMenu(true); }
    function closeMenu() { setMenu(false); }
    function toggleMenu() { setMenu(!DOM.body?.classList.contains('menu-open')); }

    function closeDrawerAboutSubmenu() {
      if (!DOM.drawerAboutSubmenu) return;
      DOM.drawerAboutSubmenu.setAttribute('hidden', '');
      DOM.drawerAboutTrigger?.setAttribute('aria-expanded', 'false');
    }

    function toggleDrawerAboutSubmenu(event) {
      event.preventDefault();
      event.stopPropagation();
      if (!DOM.drawerAboutSubmenu) return;
      const hidden = DOM.drawerAboutSubmenu.hasAttribute('hidden');
      if (hidden) {
        DOM.drawerAboutSubmenu.removeAttribute('hidden');
        DOM.drawerAboutTrigger?.setAttribute('aria-expanded', 'true');
      } else {
        closeDrawerAboutSubmenu();
      }
    }

    // Basic bindings for header UI
    on(DOM.burger, 'click', toggleMenu);
    on(DOM.overlay, 'click', closeMenu);
    on(DOM.drawerClose, 'click', closeMenu);
    DOM.drawerLinks.forEach((link) => on(link, 'click', closeMenu));
    on(DOM.drawerAboutTrigger, 'click', toggleDrawerAboutSubmenu);

    on(DOM.loginBtn, 'click', () => openAuthModal());
    on(DOM.drawerLoginBtn, 'click', () => { closeMenu(); openAuthModal(); });
    on(DOM.navLogo, 'click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      const isIndexPage = window.location.pathname.includes('index.html') || 
                         (window.location.pathname.endsWith('/') || window.location.pathname.endsWith('index.html'));
      if (isIndexPage) {
        // Already on index page, just scroll to top
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        // Navigate to index page
        transitionTo('index.html');
      }
    });

    // About dropdown (desktop)
    function closeAboutDropdown() {
      if (!DOM.aboutDropdown) return;
      DOM.aboutDropdown.classList.remove('show');
      DOM.aboutDropdown.setAttribute('aria-hidden', 'true');
      DOM.aboutTrigger?.setAttribute('aria-expanded', 'false');
    }
    function openAboutDropdown() {
      if (!DOM.aboutDropdown) return;
      DOM.aboutDropdown.classList.add('show');
      DOM.aboutDropdown.setAttribute('aria-hidden', 'false');
      DOM.aboutTrigger?.setAttribute('aria-expanded', 'true');
      setTimeout(() => document.addEventListener('click', handleDocClickCloseAbout), 0);
    }
    function handleDocClickCloseAbout(event) {
      if (event.target && closest(event.target, '.nav-about')) return;
      closeAboutDropdown();
      document.removeEventListener('click', handleDocClickCloseAbout);
    }
    function handleAboutTrigger(event) {
      event.preventDefault();
      if (!DOM.aboutDropdown) return;
      if (DOM.aboutDropdown.classList.contains('show')) {
        closeAboutDropdown();
      } else {
        openAboutDropdown();
      }
    }
    on(DOM.aboutTrigger, 'click', handleAboutTrigger);

    // Delegated for dropdown items (desktop) and drawer submenu (mobile)
    document.addEventListener('click', (event) => {
      const el = event.target;
      if (!el) return;
      
      // Dynamic document items (with data-doc-id)
      const dynamicItem = closest(el, '[data-doc-id]');
      if (dynamicItem && closest(dynamicItem, '.about-dropdown, .drawer-about-submenu')) {
        event.preventDefault();
        closeAboutDropdown();
        closeDrawerAboutSubmenu();
        if (DOM.body.classList.contains('menu-open')) closeMenu();
        const docId = dynamicItem.getAttribute('data-doc-id');
        if (docId) openDocumentById(docId);
        return;
      }
      
      // Fixed items: team
      if (closest(el, '.dropdown-item.team, .drawer-submenu-item.team')) {
        event.preventDefault();
        closeAboutDropdown();
        closeDrawerAboutSubmenu();
        if (DOM.body.classList.contains('menu-open')) closeMenu();
        openSiteInfo('team');
        return;
      }
      // Fixed items: guide
      if (closest(el, '.dropdown-item.guide, .drawer-submenu-item.guide')) {
        event.preventDefault();
        closeAboutDropdown();
        closeDrawerAboutSubmenu();
        if (DOM.body.classList.contains('menu-open')) closeMenu();
        openSiteInfo('guide');
        return;
      }
      // About panel items (desktop + mobile) - catch-all for any other items
      if (closest(el, '.about-dropdown .dropdown-item, .drawer-about-submenu .drawer-submenu-item')) {
        event.preventDefault();
        closeAboutDropdown();
        closeDrawerAboutSubmenu();
        return;
      }
    }, { capture: true });

    // Close menu with Escape
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (DOM.body?.classList.contains('menu-open')) closeMenu();
      closeAboutDropdown();
      closeDrawerAboutSubmenu();
      closeSiteInfo();
    });

    // Delegated gating for statements and profile
    document.addEventListener('click', (event) => {
      const el = event.target;
      if (!el) return;

      // Statements (both pages) - open modal directly
      const statements = closest(el, '.nav-statements, .drawer-statements');
      if (statements) {
        event.preventDefault();
        const fromDrawer = !!closest(el, '.drawer');
        if (!isLoggedIn()) {
          if (fromDrawer) closeMenu();
          alert('გთხოვთ გაიაროთ ავტორიზაცია');
          openAuthModal();
          return;
        }
        if (fromDrawer) closeMenu();
        // Open statements modal directly without page navigation
        try {
          window.dispatchEvent(new CustomEvent('openStatements'));
        } catch {}
        return;
      }

      // Profile/main navigation with fade
      const profile = closest(el, '.nav-profile[data-page-link], .drawer-profile[data-page-link]');
      if (profile) {
        const href = (profile.getAttribute('href') || '').trim();
        const fromDrawer = !!closest(el, '.drawer');
        const targetIsMy = href.includes('my.html');
        const targetIsIndex = href.includes('index.html');

        if (targetIsMy && !isLoggedIn()) {
          event.preventDefault();
          if (fromDrawer) closeMenu();
          alert('გთხოვთ გაიაროთ ავტორიზაცია');
          openAuthModal();
          return;
        }

        if (targetIsMy || targetIsIndex) {
          event.preventDefault();
          if (fromDrawer) closeMenu();
          transitionTo(href || (isMyPage() ? 'index.html' : 'my.html'));
          return;
        }
      }
    }, { capture: true });

    // Site Info Modal close bindings
    try {
      const els = getSiteInfoElements();
      if (els?.closeBtn) on(els.closeBtn, 'click', closeSiteInfo);
      if (els?.modal) {
        on(els.modal, 'click', (e) => {
          if (e && e.target === els.modal) closeSiteInfo();
        });
      }
    } catch {}
  }

  async function loadHeader() {
    try {
      const response = await fetch('../partials/header.html');
      if (!response.ok) return;
      const html = await response.text();
      document.body.insertAdjacentHTML('afterbegin', html);

      // Adjust profile link text/target based on page
      const profilePage = isMyPage();
      const navProfile = document.querySelector('.nav-profile[data-page-link]');
      const drawerProfile = document.querySelector('.drawer-profile[data-page-link]');
      if (profilePage) {
        if (navProfile) { navProfile.textContent = 'მთავარი გვერდი'; navProfile.href = 'index.html'; }
        if (drawerProfile) { drawerProfile.textContent = 'მთავარი გვერდი'; drawerProfile.href = 'index.html'; }
      } else {
        if (navProfile) navProfile.href = 'my.html';
        if (drawerProfile) drawerProfile.href = 'my.html';
      }

      // Back-compat: notify others header is ready
      document.dispatchEvent(new CustomEvent('headerReady', { detail: { isProfilePage: profilePage } }));

      // Bind behaviors
      bindHeader();
      
      // Populate dynamic documents in info dropdown
      populateInfoDropdowns();
      
      // Initialize statements module after header is loaded
      initStatementsModule();
    } catch {}
  }

  function initStatementsModule() {
    const API_BASE = (window.APP_CONFIG && typeof window.APP_CONFIG.API_BASE === 'string')
      ? window.APP_CONFIG.API_BASE
      : 'http://127.0.0.1:8000';
    
    const statementsDOM = {
      body: document.body,
      statementsOverlay: document.getElementById('userStatementsOverlay'),
      statementsClose: document.getElementById('userStatementsClose'),
      statementsList: document.getElementById('userStatementsList'),
      statementsMeta: document.getElementById('userStatementsMeta'),
      statementsForm: document.getElementById('userStatementForm'),
      statementsTextarea: document.querySelector('#userStatementForm textarea[name="message"]'),
      statementFileChoose: document.getElementById('statementFileChoose'),
      statementFileInput: document.getElementById('statementFileInput'),
      statementFileDisplay: document.getElementById('statementFileDisplay'),
    };

    let overlayOpen = false;
    let isLoading = false;
    let cache = [];

    function isLoggedIn() { try { return window.Auth?.isLoggedIn?.() === true; } catch { return false; } }
    function getCurrentUser() { try { return window.Auth?.getCurrentUser?.() || null; } catch { return null; } }
    function getActorEmail() { return (window.Auth?.getSavedEmail?.() || '').trim(); }
    function getActorHeaders() {
      return window.Auth?.getAuthHeaders?.() || {};
    }

    function ensureAuthForCompose(event) {
      if (isLoggedIn()) return true;
      if (event?.cancelable) event.preventDefault();
      alert('გთხოვთ გაიაროთ ავტორიზაცია');
      return false;
    }

    function setMetaFromUser() {
      if (!statementsDOM.statementsMeta) return;
      const user = getCurrentUser();
      const parts = [];
      if (user) {
        const name = `${user.firstName || user.first_name || ''} ${user.lastName || user.last_name || ''}`.trim();
        if (name) parts.push(name);
        if (user.code) parts.push(user.code);
      }
      statementsDOM.statementsMeta.textContent = parts.join(' - ');
    }

    function openOverlay() {
      if (!statementsDOM.statementsOverlay) return;
      overlayOpen = true;
      statementsDOM.statementsOverlay.classList.add('open');
      statementsDOM.statementsOverlay.setAttribute('aria-hidden', 'false');
      statementsDOM.body.classList.add('modal-open');
    }

    function closeOverlay() {
      if (!statementsDOM.statementsOverlay) return;
      overlayOpen = false;
      statementsDOM.statementsOverlay.classList.remove('open');
      statementsDOM.statementsOverlay.setAttribute('aria-hidden', 'true');
      statementsDOM.body.classList.remove('modal-open');
    }

    function renderPlaceholder(text, modifier) {
      if (!statementsDOM.statementsList) return;
      const placeholder = document.createElement('div');
      placeholder.className = `statements-placeholder${modifier ? ` ${modifier}` : ''}`;
      placeholder.textContent = text;
      statementsDOM.statementsList.innerHTML = '';
      statementsDOM.statementsList.appendChild(placeholder);
    }

    function renderList(items) {
      if (!statementsDOM.statementsList) return;
      if (!items.length) {
        renderPlaceholder('განცხადებები ჯერ არ გაქვთ.', 'statements-empty');
        return;
      }
      const fragment = document.createDocumentFragment();
      items.forEach((item) => {
        const details = document.createElement('details');
        details.className = 'statement-item';
        details.setAttribute('role', 'listitem');
        const summary = document.createElement('summary');
        summary.className = 'statement-summary';
        const dateSpan = document.createElement('span');
        dateSpan.className = 'statement-date';
        dateSpan.textContent = window.Utils?.formatDateTime?.(item.created_at);
        summary.appendChild(dateSpan);
        details.appendChild(summary);
        const message = document.createElement('div');
        message.className = 'statement-message';
        message.textContent = item.message || '';
        details.appendChild(message);
        
        if (item.attachment_filename) {
          const attachmentWrapper = document.createElement('div');
          attachmentWrapper.className = 'statement-attachment';
          const downloadBtn = document.createElement('button');
          downloadBtn.type = 'button';
          downloadBtn.className = 'statement-attachment-download';
          downloadBtn.textContent = 'ჩამოტვირთვა';
          const actorEmail = getActorEmail();
          const downloadUrl = `${API_BASE}/statements/${encodeURIComponent(item.id)}/attachment${actorEmail ? `?actor=${encodeURIComponent(actorEmail)}` : ''}`;
          downloadBtn.addEventListener('click', () => {
            window.location.href = downloadUrl;
          });
          const filenameSpan = document.createElement('span');
          filenameSpan.className = 'statement-attachment-filename';
          filenameSpan.textContent = item.attachment_filename;
          attachmentWrapper.appendChild(downloadBtn);
          attachmentWrapper.appendChild(filenameSpan);
          details.appendChild(attachmentWrapper);
        }
        
        fragment.appendChild(details);
      });
      statementsDOM.statementsList.innerHTML = '';
      statementsDOM.statementsList.appendChild(fragment);
    }

    async function fetchStatements() {
      if (!statementsDOM.statementsList || isLoading) return;
      const actorEmail = getActorEmail();
      if (!actorEmail) {
        renderPlaceholder('ავტორიზაცია ვერ დადასტურდა', 'statements-error');
        return;
      }
      isLoading = true;
      try {
        const response = await fetch(`${API_BASE}/statements/me`, {
          headers: {
            ...getActorHeaders(),
            'Cache-Control': 'no-cache',
          },
          credentials: 'include',
        });
        if (!response.ok) {
          if (response.status === 401) {
            renderPlaceholder('გთხოვთ გაიაროთ ავტორიზაცია', 'statements-error');
            alert('გთხოვთ გაიაროთ ავტორიზაცია');
            closeOverlay();
            return;
          }
          let detail = '';
          try {
            const json = await response.clone().json();
            detail = json?.detail || '';
          } catch {
            try { detail = (await response.clone().text()).trim(); } catch {}
          }
          throw new Error(detail || 'ჩატვირთვის შეცდომა');
        }
        const data = await response.json();
        cache = Array.isArray(data) ? data : [];
        renderList(cache);
      } catch {
        renderPlaceholder('ჩატვირთვის შეცდომა', 'statements-error');
      } finally {
        isLoading = false;
      }
    }

    function handleOpenRequest(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      try {
        const overlay = document.getElementById('registryOverlay');
        if (overlay) {
          overlay.classList.remove('is-open');
          overlay.setAttribute('aria-hidden', 'true');
          document.body.classList.remove('registry-open');
        }
      } catch {}
      if (!isLoggedIn()) {
        alert('გთხოვთ გაიაროთ ავტორიზაცია');
        return;
      }
      const actorEmail = getActorEmail();
      if (!actorEmail) {
        alert('ავტორიზაცია ვერ დადასტურდა');
        return;
      }
      setMetaFromUser();
      openOverlay();
      renderPlaceholder('იტვირთება...', 'statements-loading');
      fetchStatements();
    }

    function handleBackdropClick(event) {
      if (event.target === statementsDOM.statementsOverlay) {
        closeOverlay();
      }
    }

    async function handleComposeSubmit(event) {
      event.preventDefault();
      if (!statementsDOM.statementsForm) return;
      if (!isLoggedIn()) {
        alert('გთხოვთ გაიაროთ ავტორიზაცია');
        return;
      }
      const actorEmail = getActorEmail();
      if (!actorEmail) {
        alert('ავტორიზაცია ვერ დადასტურდა');
        return;
      }

      const fd = new FormData(statementsDOM.statementsForm);
      const message = (fd.get('message') || '').toString().trim();
      if (!message) return alert('გთხოვთ შეიყვანოთ შეტყობინება');

      const fileInput = statementsDOM.statementFileInput || statementsDOM.statementsForm.querySelector('input[name="attachment"]');
      const file = fileInput && fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      if (file) {
        if (file.size > 100 * 1024 * 1024) {
          alert('ფაილი აღემატება 100MB-ს');
          return;
        }
        if (!/\.(zip|rar|pdf|jpg|jpeg)$/i.test(file.name || '')) {
          alert('დასაშვებია: ZIP, RAR, PDF, JPEG');
          return;
        }
      }

      const body = new FormData();
      body.set('message', message);
      if (file) body.set('attachment', file);

      const submitBtn = statementsDOM.statementsForm.querySelector('button[type="submit"]');
      submitBtn?.setAttribute('disabled', 'true');
      try {
        const response = await fetch(`${API_BASE}/statements`, {
          method: 'POST',
          headers: { ...getActorHeaders() },
          body,
          credentials: 'include',
        });
        if (!response.ok) {
          let detail = '';
          try {
            const json = await response.clone().json();
            detail = json?.detail || '';
          } catch {
            try { detail = (await response.clone().text()).trim(); } catch {}
          }
          throw new Error(detail || 'გაგზავნა ვერ შესრულდა');
        }
        const data = await response.json();
        alert('თქვენი განცხადება მიღებულია!');
        statementsDOM.statementsForm.reset();
        updateFileDisplay();
        handleNewStatement(data);
      } catch (error) {
        alert(error.message || 'გაგზავნა ვერ შესრულდა');
      } finally {
        submitBtn?.removeAttribute('disabled');
      }
    }

    function handleNewStatement(statement) {
      if (!statement || typeof statement !== 'object') return;
      cache = [statement, ...cache.filter((item) => item.id !== statement.id)];
      if (overlayOpen) {
        renderList(cache);
      }
    }

    function reset() {
      cache = [];
      if (overlayOpen) {
        closeOverlay();
      }
      if (statementsDOM.statementsList) statementsDOM.statementsList.innerHTML = '';
      if (statementsDOM.statementsMeta) statementsDOM.statementsMeta.textContent = '';
    }

    function updateFileDisplay() {
      if (!statementsDOM.statementFileInput || !statementsDOM.statementFileDisplay) return;
      const file = statementsDOM.statementFileInput.files && statementsDOM.statementFileInput.files[0];
      if (file) {
        statementsDOM.statementFileDisplay.value = file.name;
      } else {
        statementsDOM.statementFileDisplay.value = '';
      }
    }

    function init() {
      on(statementsDOM.statementsClose, 'click', closeOverlay);
      on(statementsDOM.statementsOverlay, 'click', handleBackdropClick);
      on(statementsDOM.statementsForm, 'submit', handleComposeSubmit);
      on(statementsDOM.statementsTextarea, 'mousedown', ensureAuthForCompose);
      on(statementsDOM.statementsTextarea, 'focus', ensureAuthForCompose);
      if (statementsDOM.statementFileChoose) {
        on(statementsDOM.statementFileChoose, 'click', () => {
          if (statementsDOM.statementFileInput) statementsDOM.statementFileInput.click();
        });
      }
      if (statementsDOM.statementFileInput) {
        on(statementsDOM.statementFileInput, 'change', updateFileDisplay);
      }
      document.addEventListener('auth:logout', reset);
      document.addEventListener('auth:login', setMetaFromUser);
      setMetaFromUser();
    }

    init();
    window.addEventListener('openStatements', () => {
      try { handleOpenRequest(); } catch {}
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadHeader);
  } else {
    loadHeader();
  }
})();



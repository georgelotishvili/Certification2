(function (global) {
  function createTeamModule(context) {
    const {
      API_BASE,
      showToast,
      escapeHtml,
      getAdminHeaders,
      getActorHeaders,
    } = context;

    const state = { members: [] };

    const categoryContainers = {
      1: document.getElementById('teamCategory1'),
      2: document.getElementById('teamCategory2'),
      3: document.getElementById('teamCategory3'),
    };

    async function fetchMembers() {
      try {
        const response = await fetch(`${API_BASE}/admin/team`, {
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok) throw new Error('Failed to fetch team');
        const data = await response.json();
        return data.items || [];
      } catch (err) {
        console.error('Error fetching team:', err);
        return [];
      }
    }

    async function createMember(category, position, firstName, lastName, email, phone) {
      try {
        const response = await fetch(`${API_BASE}/admin/team`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAdminHeaders(),
            ...getActorHeaders(),
          },
          body: JSON.stringify({
            category,
            position: position.trim(),
            first_name: firstName.trim(),
            last_name: lastName.trim(),
            email: email.trim() || null,
            phone: phone.trim() || null,
          }),
        });
        if (!response.ok) {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.detail || 'Failed to create');
        }
        return await response.json();
      } catch (err) {
        console.error('Error creating member:', err);
        throw err;
      }
    }

    async function deleteMember(memberId) {
      try {
        const response = await fetch(`${API_BASE}/admin/team/${memberId}`, {
          method: 'DELETE',
          headers: { ...getAdminHeaders(), ...getActorHeaders() },
        });
        if (!response.ok && response.status !== 204) {
          throw new Error('Failed to delete');
        }
        return true;
      } catch (err) {
        console.error('Error deleting member:', err);
        throw err;
      }
    }

    async function changeOrder(memberId, direction) {
      try {
        const response = await fetch(`${API_BASE}/admin/team/${memberId}/order`, {
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

    function renderMemberCard(member, isFirst, isLast) {
      const safeId = escapeHtml(String(member.id));
      const safePosition = escapeHtml(member.position || '');
      const safeFirstName = escapeHtml(member.first_name || '');
      const safeLastName = escapeHtml(member.last_name || '');
      const safeEmail = escapeHtml(member.email || '');
      const safePhone = escapeHtml(member.phone || '');
      
      return `
        <div class="team-member-card" data-member-id="${safeId}">
          <div class="team-member-order">
            <button class="i-btn team-up" ${isFirst ? 'disabled' : ''} aria-label="ზემოთ">▲</button>
            <button class="i-btn team-down" ${isLast ? 'disabled' : ''} aria-label="ქვემოთ">▼</button>
          </div>
          <div class="team-member-info">
            <div class="team-member-name">
              <strong>${safePosition}:</strong> ${safeFirstName} ${safeLastName}
            </div>
            <div class="team-member-contacts">
              ${safeEmail ? `<span class="team-contact-email">${safeEmail}</span>` : ''}
              ${safePhone ? `<span class="team-contact-phone">${safePhone}</span>` : ''}
            </div>
          </div>
          <button class="team-delete-btn" type="button" aria-label="წაშლა" title="წაშლა">×</button>
        </div>
      `;
    }

    function renderCategory(category, members) {
      const container = categoryContainers[category];
      if (!container) return;

      const categoryMembers = members.filter(m => m.category === category);
      
      if (categoryMembers.length === 0) {
        container.innerHTML = '<div class="team-empty">არცერთი წევრი არ არის დამატებული</div>';
        return;
      }

      container.innerHTML = categoryMembers.map((member, index) => 
        renderMemberCard(member, index === 0, index === categoryMembers.length - 1)
      ).join('');
    }

    function render() {
      [1, 2, 3].forEach(cat => renderCategory(cat, state.members));
    }

    async function loadAndRender() {
      state.members = await fetchMembers();
      render();
    }

    function clearForm(form) {
      form.querySelector('.team-position').value = '';
      form.querySelector('.team-firstname').value = '';
      form.querySelector('.team-lastname').value = '';
      form.querySelector('.team-email').value = '';
      form.querySelector('.team-phone').value = '';
    }

    async function handleAddClick(event) {
      const btn = event.target.closest('.team-add-btn');
      if (!btn) return;

      const form = btn.closest('.team-add-form');
      if (!form) return;

      const category = parseInt(form.dataset.category, 10);
      const position = form.querySelector('.team-position').value.trim();
      const firstName = form.querySelector('.team-firstname').value.trim();
      const lastName = form.querySelector('.team-lastname').value.trim();
      const email = form.querySelector('.team-email').value.trim();
      const phone = form.querySelector('.team-phone').value.trim();

      if (!position || !firstName || !lastName) {
        showToast('თანამდებობა, სახელი და გვარი აუცილებელია', 'error');
        return;
      }

      btn.disabled = true;
      try {
        await createMember(category, position, firstName, lastName, email, phone);
        clearForm(form);
        showToast('წევრი დაემატა');
        await loadAndRender();
      } catch (err) {
        showToast('შეცდომა წევრის დამატებისას', 'error');
      } finally {
        btn.disabled = false;
      }
    }

    async function handleDeleteClick(event) {
      const btn = event.target.closest('.team-delete-btn');
      if (!btn) return;

      const card = btn.closest('.team-member-card');
      if (!card) return;

      const memberId = card.dataset.memberId;
      if (!memberId) return;

      const confirmed = global.confirm('ნამდვილად გსურთ ამ წევრის წაშლა?');
      if (!confirmed) return;

      btn.disabled = true;
      try {
        await deleteMember(memberId);
        showToast('წევრი წაიშალა');
        await loadAndRender();
      } catch (err) {
        showToast('შეცდომა წაშლისას', 'error');
        btn.disabled = false;
      }
    }

    async function handleOrderClick(event) {
      const upBtn = event.target.closest('.team-up');
      const downBtn = event.target.closest('.team-down');
      const btn = upBtn || downBtn;
      if (!btn) return;

      const card = btn.closest('.team-member-card');
      if (!card) return;

      const memberId = card.dataset.memberId;
      if (!memberId) return;

      const direction = upBtn ? 'up' : 'down';

      btn.disabled = true;
      try {
        await changeOrder(memberId, direction);
        await loadAndRender();
      } catch (err) {
        showToast('შეცდომა რიგითობის შეცვლისას', 'error');
        btn.disabled = false;
      }
    }

    function handleClick(event) {
      handleAddClick(event);
      handleDeleteClick(event);
      handleOrderClick(event);
    }

    function init() {
      const teamSection = document.getElementById('team-section');
      if (teamSection) {
        teamSection.addEventListener('click', handleClick);
      }
    }

    return {
      init,
      render: loadAndRender,
    };
  }

  global.AdminModules = global.AdminModules || {};
  global.AdminModules.createTeamModule = createTeamModule;
})(window);

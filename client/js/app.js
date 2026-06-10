/**
 * app.js — Index page logic
 * Handles: login UI, create room, join room
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-dot"></span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s ease forwards';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function isMobileExperience() {
  return document.body.classList.contains('mobile-home-page')
    || window.matchMedia?.('(max-width: 760px)').matches;
}

function getRoomPagePath() {
  return isMobileExperience() ? '/room-mobile.html' : '/room.html';
}

function goToRoom(roomId) {
  window.location.href = `${getRoomPagePath()}?room=${roomId}`;
}

// ─── Auth UI ──────────────────────────────────────────────────────────────────

const landingSection  = document.getElementById('landing-section');
const authSection     = document.getElementById('auth-section');
const roomSection     = document.getElementById('room-section');
const userAvatar      = document.getElementById('user-avatar');
const userDisplayName = document.getElementById('user-display-name');
const logoutBtn       = document.getElementById('logout-btn');

async function renderAuthState(session) {
  if (session) {
    // Logged in — show room creation/join
    landingSection.style.display = 'none';
    roomSection.style.display = '';

    const profile = await Auth.getProfile();
    const name = profile?.display_name || session.user.email?.split('@')[0] || 'Usuário';
    const avatarUrl = profile?.avatar_url;
    const initials = Auth.getInitials(name);
    const color = Auth.getAvatarColor(name);

    userDisplayName.textContent = name;
    if (avatarUrl) {
      userAvatar.innerHTML = `<img src="${avatarUrl}" alt="${name}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
    } else {
      userAvatar.style.background = color + '33';
      userAvatar.style.color = color;
      userAvatar.textContent = initials;
    }

    // Load saved rooms
    loadMyRooms();
  } else {
    // Not logged in — show auth buttons
    landingSection.style.display = '';
    roomSection.style.display = 'none';
  }
}

// Listen for auth changes
Auth.onAuthStateChange((event, session) => {
  renderAuthState(session);
});

// Initial render
Auth.getSession().then((session) => renderAuthState(session));

// ─── Login Buttons ────────────────────────────────────────────────────────────

document.getElementById('login-google-btn').addEventListener('click', async () => {
  await Auth.loginWithGoogle();
});

logoutBtn.addEventListener('click', async () => {
  await Auth.logout();
  showToast('Você saiu da conta.', 'info');
});

// ─── Create Room ──────────────────────────────────────────────────────────────

document.getElementById('create-btn').addEventListener('click', async () => {
  const user = await Auth.getUser();
  if (!user) { showToast('Faça login primeiro.', 'error'); return; }

  const btn = document.getElementById('create-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="loader"></span> Criando...';

  try {
    const roomId = generateRoomCode();
    const { error } = await sb.from('rooms').insert({
      id: roomId,
      host_id: user.id,
      is_playing: false,
      audio_offset: 0,
      current_track_index: 0,
    });

    if (error) throw error;

    // Save host flag and go to room
    sessionStorage.setItem('syncbeat_host', 'true');
    goToRoom(roomId);
  } catch (err) {
    showToast('Erro ao criar sala: ' + err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = 'Criar sala';
  }
});

async function loadMyRooms() {
  const user = await Auth.getUser();
  if (!user) return;

  const container = document.getElementById('my-rooms-container');
  const listEl = document.getElementById('my-rooms-list');
  if (!container || !listEl) return;

  // Fetch host's rooms with queue items count
  const { data: rooms, error } = await sb
    .from('rooms')
    .select('*, queue_items(count)')
    .eq('host_id', user.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Erro ao buscar minhas salas:', error);
    return;
  }

  if (rooms && rooms.length > 0) {
    container.style.display = '';
    listEl.innerHTML = '';

    rooms.forEach(room => {
      const trackCount = room.queue_items?.[0]?.count || 0;
      const item = document.createElement('div');
      item.className = 'glass my-room-item';

      item.innerHTML = `
        <div class="my-room-copy">
          <div class="my-room-title-row">
            <span class="my-room-code">${room.id}</span>
            <span class="badge badge-muted">${trackCount} ${trackCount === 1 ? 'música' : 'músicas'}</span>
          </div>
          <span class="my-room-date">Criada em ${new Date(room.created_at).toLocaleDateString('pt-BR')} às ${new Date(room.created_at).toLocaleTimeString('pt-BR', {hour: '2-digit', minute:'2-digit'})}</span>
        </div>
        <div class="my-room-actions">
          <button class="btn btn-secondary btn-sm enter-my-room-btn" data-room="${room.id}">Entrar</button>
          <button class="btn btn-ghost btn-sm delete-my-room-btn" data-room="${room.id}">Excluir</button>
        </div>
      `;
      listEl.appendChild(item);
    });

    // Bind events
    listEl.querySelectorAll('.enter-my-room-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        sessionStorage.setItem('syncbeat_host', 'true');
        goToRoom(btn.dataset.room);
      });
    });

    listEl.querySelectorAll('.delete-my-room-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const confirmed = await SyncBeatUI.confirm({
          title: `Excluir sala ${btn.dataset.room}?`,
          message: 'A sala e toda a fila de músicas serão removidas para todos.',
          confirmLabel: 'Excluir sala',
          cancelLabel: 'Cancelar',
          tone: 'danger',
        });
        if (!confirmed) return;
        btn.disabled = true;
        btn.innerHTML = '...';
        const { error: delErr } = await sb.from('rooms').delete().eq('id', btn.dataset.room);
        if (delErr) {
          showToast('Erro ao excluir: ' + delErr.message, 'error');
          btn.disabled = false;
          btn.innerHTML = 'Excluir';
        } else {
          showToast('Sala excluída com sucesso.', 'success');
          loadMyRooms();
        }
      });
    });
  } else {
    container.style.display = 'none';
    listEl.innerHTML = '';
  }
}

// ─── Join Room ────────────────────────────────────────────────────────────────

document.getElementById('join-btn').addEventListener('click', async () => {
  const user = await Auth.getUser();
  if (!user) { showToast('Faça login primeiro.', 'error'); return; }

  const codeEl = document.getElementById('join-code');
  const code = codeEl.value.trim().toUpperCase();

  if (!code || code.length < 4) {
    codeEl.focus();
    showToast('Digite o código da sala.', 'error');
    return;
  }

  // Verify room exists
  const { data: room } = await sb.from('rooms').select('id').eq('id', code).single();
  if (!room) {
    showToast(`Sala "${code}" não encontrada.`, 'error');
    return;
  }

  sessionStorage.removeItem('syncbeat_host');
  goToRoom(code);
});

document.getElementById('join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('join-btn').click();
});

document.getElementById('join-code').addEventListener('input', function () {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

// Auto-fill room code from URL param
const urlCode = new URLSearchParams(window.location.search).get('room');
if (urlCode) {
  const codeInput = document.getElementById('join-code');
  if (codeInput) {
    codeInput.value = urlCode.toUpperCase();
    // Scroll to join card
    codeInput.closest('.index-card, .mobile-action-card')?.scrollIntoView({ behavior: 'smooth' });
  }
}

// ─── Theme Toggle ─────────────────────────────────────────────────────────────
const themeToggle = document.getElementById('theme-toggle');
if (themeToggle) {
  const sunIcon = themeToggle.querySelector('.theme-icon-sun');
  const moonIcon = themeToggle.querySelector('.theme-icon-moon');
  
  const updateIcons = () => {
    const isLight = document.documentElement.classList.contains('light-theme');
    if (isLight) {
      if (sunIcon) sunIcon.style.display = 'none';
      if (moonIcon) moonIcon.style.display = 'block';
    } else {
      if (sunIcon) sunIcon.style.display = 'block';
      if (moonIcon) moonIcon.style.display = 'none';
    }
  };

  // Run on load
  updateIcons();

  themeToggle.addEventListener('click', () => {
    const isLight = document.documentElement.classList.toggle('light-theme');
    localStorage.setItem('syncbeat_theme', isLight ? 'light' : 'dark');
    updateIcons();
  });
}


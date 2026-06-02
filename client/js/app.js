/**
 * app.js — Index page logic
 * Handles: login UI, create room, join room
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  toast.innerHTML = `<span>${icons[type] || ''}</span><span>${message}</span>`;
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

document.getElementById('login-spotify-btn').addEventListener('click', async () => {
  await Auth.loginWithSpotify();
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
    // Clean up old rooms by this host
    await sb.from('rooms').delete().eq('host_id', user.id);

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
    window.location.href = `/room.html?room=${roomId}`;
  } catch (err) {
    showToast('Erro ao criar sala: ' + err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = '🚀 Criar sala';
  }
});

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
  window.location.href = `/room.html?room=${code}`;
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
    codeInput.closest('.index-card')?.scrollIntoView({ behavior: 'smooth' });
  }
}

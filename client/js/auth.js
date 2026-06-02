/**
 * auth.js — Authentication helpers
 * Provides login/logout/session management using Supabase Auth.
 */

window.Auth = (function () {
  let _session = null;
  let _profile = null;

  // ─── Session ────────────────────────────────────────────────────────────────

  async function getSession() {
    const { data } = await sb.auth.getSession();
    _session = data.session;
    return _session;
  }

  async function getUser() {
    const session = await getSession();
    return session?.user || null;
  }

  async function getProfile() {
    const user = await getUser();
    if (!user) return null;
    if (_profile) return _profile;

    const { data } = await sb.from('profiles').select('*').eq('id', user.id).single();
    _profile = data;
    return _profile;
  }

  // ─── Login ──────────────────────────────────────────────────────────────────

  async function loginWithGoogle() {
    return sb.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: window.location.origin + '/auth-callback.html',
        queryParams: { access_type: 'offline', prompt: 'consent' },
      },
    });
  }

  async function loginWithSpotify() {
    return sb.auth.signInWithOAuth({
      provider: 'spotify',
      options: {
        redirectTo: window.location.origin + '/auth-callback.html',
        scopes: 'user-read-email user-read-private',
      },
    });
  }

  async function logout() {
    _session = null;
    _profile = null;
    return sb.auth.signOut();
  }

  // ─── Auth state listener ────────────────────────────────────────────────────

  function onAuthStateChange(callback) {
    return sb.auth.onAuthStateChange((event, session) => {
      _session = session;
      if (!session) _profile = null;
      callback(event, session);
    });
  }

  // ─── Guard: redirect if not authed ─────────────────────────────────────────

  async function requireAuth(redirectUrl = '/') {
    const user = await getUser();
    if (!user) {
      window.location.href = redirectUrl;
      return null;
    }
    return user;
  }

  // ─── Avatar helpers ─────────────────────────────────────────────────────────

  function getInitials(name = '') {
    return name
      .split(' ')
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() || '')
      .join('');
  }

  const AVATAR_COLORS = [
    '#e4e4e7', '#a1a1aa', '#71717a', '#ffffff',
    '#d4d4d8', '#cbd5e1', '#94a3b8', '#e2e8f0'
  ];

  function getAvatarColor(str = '') {
    let hash = 0;
    for (const c of str) hash = (hash * 31 + c.charCodeAt(0)) & 0xfffffff;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  return {
    getSession,
    getUser,
    getProfile,
    loginWithGoogle,
    loginWithSpotify,
    logout,
    onAuthStateChange,
    requireAuth,
    getInitials,
    getAvatarColor,
  };
})();

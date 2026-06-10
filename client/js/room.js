/**
 * room.js - Room page logic
 *
 * YouTube tracks play through the official YouTube iframe player API.
 * The database remains the source of truth for room playback state and queue.
 */

const params = new URLSearchParams(window.location.search);
const ROOM_ID = params.get('room')?.toUpperCase();
const IS_MOBILE_ROOM = document.body.classList.contains('mobile-room-page');

function getHomePagePath() {
  return IS_MOBILE_ROOM || window.matchMedia?.('(max-width: 760px)').matches ? '/mobile.html' : '/';
}

function getRoomPagePath() {
  return IS_MOBILE_ROOM ? '/room-mobile.html' : '/room.html';
}

if (!ROOM_ID) window.location.href = getHomePagePath();

const DRIFT_CORRECTION_SECONDS = 1.25;
const SYNC_INTERVAL_MS = 5000;

let state = {
  user: null,
  profile: null,
  isHost: false,
  isController: false,
  roomData: null,
  queue: [],
  currentTrack: null,
  isPlaying: false,
  loop: false,
};

let realtimeChannel = null;
let syncTimerId = null;
let visualizerTimerId = null;
let playerProgressTimerId = null;
let audioUnlocked = false;
let pendingSync = null;
let youtubePlayer = null;
let youtubeInitPromise = null;
let youtubeReady = false;
let currentYouTubeVideoId = null;

const $ = (id) => document.getElementById(id);
const dom = {
  joinOverlay: $('join-overlay'),
  closedOverlay: $('closed-overlay'),
  closedMessage: $('closed-message'),
  roomCodeDisplay: $('room-code-display'),
  connectionBadge: $('connection-badge'),
  hostBadge: $('host-badge'),
  closeRoomBtn: $('close-room-btn'),
  copyCodeBtn: $('copy-code-btn'),
  copyLinkBtn: $('copy-link-btn'),
  userAvatarHeader: $('user-avatar-header'),
  userNameHeader: $('user-name-header'),
  artworkPlaceholder: $('artwork-placeholder'),
  playingIndicator: $('playing-indicator'),
  sourceBadgeArea: $('source-badge-area'),
  nowPlayingTrack: $('now-playing-track'),
  nowPlayingArtist: $('now-playing-artist'),
  currentTime: $('current-time'),
  totalTime: $('total-time'),
  progressBarTrack: $('progress-bar-track'),
  progressBar: $('progress-bar'),
  addMusicPanel: $('add-music-panel'),
  searchInput: $('search-input'),
  searchBtn: $('search-btn'),
  searchStatus: $('search-status'),
  tabSearch: $('tab-search'),
  tabUrl: $('tab-url'),
  tabContentSearch: $('tab-content-search'),
  tabContentUrl: $('tab-content-url'),
  urlInput: $('url-input'),
  urlAddBtn: $('url-add-btn'),
  urlStatus: $('url-status'),
  queueList: $('queue-list'),
  queueCount: $('queue-count'),
  clearQueueBtn: $('clear-queue-btn'),
  listenersList: $('listeners-list'),
  listenersCount: $('listeners-count'),
  listenerOnlyBar: $('listener-only-bar'),
  playerThumb: $('player-thumb'),
  playerTrackName: $('player-track-name'),
  playerArtistName: $('player-artist-name'),
  playBtn: $('play-btn'),
  prevBtn: $('prev-btn'),
  nextBtn: $('next-btn'),
  loopBtn: $('loop-btn'),
  volumeSlider: $('volume-slider'),
  volumeIcon: $('volume-icon'),
  visualizer: $('visualizer'),
  youtubePlayerShell: $('youtube-player-shell'),
  youtubeIframePlayer: $('youtube-iframe-player'),
  themeToggle: $('theme-toggle'),
};

function showToast(msg, type = 'info', duration = 3500) {
  const c = $('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span></span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toastOut .3s ease forwards';
    setTimeout(() => t.remove(), 300);
  }, duration);
}

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function getTrackVideoId(track) {
  if (!track) return '';
  if (track.youtube_video_id || track.youtubeVideoId) return track.youtube_video_id || track.youtubeVideoId;
  const source = track.original_url || track.audio_url || '';
  return (
    source.match(/[?&]v=([A-Za-z0-9_-]{11})/)?.[1] ||
    source.match(/youtu\.be\/([A-Za-z0-9_-]{11})/)?.[1] ||
    source.match(/embed\/([A-Za-z0-9_-]{11})/)?.[1] ||
    ''
  );
}

function getTrackSource(track) {
  return track?.source_type || track?.sourceType || 'youtube';
}

function estimateRoomPosition(roomData = state.roomData) {
  if (!roomData) return 0;
  const offset = Number(roomData.audio_offset || 0);
  if (!roomData.is_playing || !roomData.started_at) return offset;
  const startedAt = new Date(roomData.started_at).getTime();
  if (!Number.isFinite(startedAt)) return offset;
  return Math.max(0, offset + (Date.now() - startedAt) / 1000);
}

function clampPosition(position) {
  const duration = Number(getPlayerDuration() || state.currentTrack?.duration || 0);
  if (!Number.isFinite(position)) return 0;
  if (!duration) return Math.max(0, position);
  return Math.max(0, Math.min(position, Math.max(0, duration - 0.25)));
}

async function resolveAudioInput(input) {
  return sb.functions.invoke('resolve-audio', { body: { input } });
}

function ensureYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (window.__syncbeatYouTubeApiPromise) return window.__syncbeatYouTubeApiPromise;

  window.__syncbeatYouTubeApiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previousReady === 'function') previousReady();
      resolve(window.YT);
    };

    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      tag.onerror = () => reject(new Error('Não foi possível carregar o player do YouTube.'));
      document.head.appendChild(tag);
    }
  });

  return window.__syncbeatYouTubeApiPromise;
}

function initYouTubePlayer() {
  if (youtubePlayer) return youtubePlayer;
  if (!youtubeInitPromise) {
    youtubeInitPromise = ensureYouTubeApi()
      .then(() => new Promise((resolve) => {
        youtubePlayer = new YT.Player('youtube-iframe-player', {
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: 1,
            enablejsapi: 1,
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (event) => {
              youtubeReady = true;
              const iframe = event.target.getIframe?.();
              iframe?.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
              setYouTubeVolume(parseFloat(dom.volumeSlider.value || '1'));
              updateProgressFromPlayer();

              if (pendingSync) {
                const sync = pendingSync;
                pendingSync = null;
                syncYouTube(sync);
              }
              resolve(youtubePlayer);
            },
            onStateChange: handleYouTubeStateChange,
          },
        });
      }))
      .catch((err) => {
        showToast(err.message, 'error');
        throw err;
      });
  }

  return youtubePlayer;
}

function withYouTubePlayer(callback) {
  const player = initYouTubePlayer();
  if (player && youtubeReady) {
    callback(player);
    return;
  }
  youtubeInitPromise?.then((readyPlayer) => callback(readyPlayer));
}

function handleYouTubeStateChange(event) {
  if (!window.YT) return;
  if (event.data === YT.PlayerState.PLAYING) {
    updatePlayState(true);
  } else if (event.data === YT.PlayerState.PAUSED) {
    if (!state.roomData?.is_playing) updatePlayState(false);
  } else if (event.data === YT.PlayerState.ENDED) {
    handleTrackEnded();
  }
  updateProgressFromPlayer();
}

async function handleTrackEnded() {
  if (!state.isHost) return;
  if (state.loop) {
    await hostSeek(0);
    await hostPlay();
  } else {
    await hostNext();
  }
}

function getPlayerDuration() {
  try {
    const duration = youtubePlayer?.getDuration?.();
    return Number.isFinite(duration) ? duration : 0;
  } catch {
    return 0;
  }
}

function pauseYouTubePlayer() {
  try {
    youtubePlayer?.pauseVideo?.();
  } catch {
    // Ignore iframe teardown races while leaving or closing a room.
  }
}

function updateProgressFromPlayer() {
  let current = 0;
  try {
    current = Number(youtubePlayer?.getCurrentTime?.() || 0);
  } catch {
    current = 0;
  }
  const duration = getPlayerDuration() || state.currentTrack?.duration || 0;
  dom.currentTime.textContent = formatTime(current);
  dom.totalTime.textContent = formatTime(duration);
  dom.progressBar.style.width = duration > 0 ? `${Math.min(100, (current / duration) * 100)}%` : '0%';
}

function setYouTubeVolume(v) {
  const volume = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
  try {
    youtubePlayer?.setVolume?.(Math.round(volume * 100));
    if (volume === 0) {
      youtubePlayer?.mute?.();
    } else {
      youtubePlayer?.unMute?.();
    }
  } catch {
    // Volume is applied again when the iframe reports ready.
  }
  updateVolumeIcon(volume);
}

function getYouTubeVolume() {
  try {
    if (youtubePlayer?.isMuted?.()) return 0;
    const volume = youtubePlayer?.getVolume?.();
    if (Number.isFinite(volume)) return volume / 100;
  } catch {
    // Fall back to the visible slider below.
  }
  return parseFloat(dom.volumeSlider.value || '1');
}

function loadYouTubeTrack(track, autoPlay = false) {
  if (!track) return;
  const videoId = getTrackVideoId(track);
  const isSameTrack = state.currentTrack && state.currentTrack.id === track.id;
  const currentPos = isSameTrack ? currentPlayerPos() : 0;
  state.currentTrack = track;
  updateNowPlayingUI(track);

  if (!videoId) {
    showToast('Não consegui identificar essa música pela URL.', 'error');
    return;
  }

  const startSeconds = clampPosition(currentPos);
  withYouTubePlayer((player) => {
    if (currentYouTubeVideoId !== videoId) {
      currentYouTubeVideoId = videoId;
      if (autoPlay) {
        player.loadVideoById({ videoId, startSeconds });
      } else {
        player.cueVideoById({ videoId, startSeconds });
      }
    }

    updateProgressFromPlayer();
    if (autoPlay) {
      syncYouTube({
        serverTime: Date.now(),
        audioPosition: estimateRoomPosition(),
        isPlaying: true,
      });
    }
  });
}

function currentPlayerPos() {
  try {
    const current = Number(youtubePlayer?.getCurrentTime?.() || 0);
    return Number.isFinite(current) ? current : estimateRoomPosition();
  } catch {
    return estimateRoomPosition();
  }
}

function syncYouTube({ serverTime, audioPosition, isPlaying }) {
  const track = state.currentTrack;
  const videoId = getTrackVideoId(track);
  if (!track || !videoId) return;

  if (!youtubeReady) {
    initYouTubePlayer();
    pendingSync = { serverTime, audioPosition, isPlaying };
    return;
  }

  let pos = audioPosition || 0;
  if (isPlaying && serverTime) pos += (Date.now() - serverTime) / 1000;
  pos = clampPosition(pos);

  withYouTubePlayer((player) => {
    if (currentYouTubeVideoId !== videoId) {
      currentYouTubeVideoId = videoId;
      if (isPlaying) {
        player.loadVideoById({ videoId, startSeconds: pos });
      } else {
        player.cueVideoById({ videoId, startSeconds: pos });
      }
    } else if (Math.abs(currentPlayerPos() - pos) > DRIFT_CORRECTION_SECONDS) {
      player.seekTo(pos, true);
    }

    if (isPlaying) {
      if (!audioUnlocked && dom.joinOverlay.style.display !== 'none') return;
      player.playVideo();
    } else {
      player.pauseVideo();
    }
    updateProgressFromPlayer();
  });
}

function updatePlayState(isPlaying) {
  state.isPlaying = isPlaying;
  dom.playBtn.innerHTML = isPlaying
    ? `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>`;
  dom.playingIndicator.classList.toggle('paused', !isPlaying);
}

function setHostMode(isController) {
  state.isController = isController;
  dom.addMusicPanel.style.display = isController ? '' : 'none';
  dom.listenerOnlyBar.style.display = isController ? 'none' : '';
  if (dom.clearQueueBtn) dom.clearQueueBtn.style.display = state.isHost ? '' : 'none';

  if (state.isHost) {
    dom.hostBadge.textContent = 'Host';
    dom.hostBadge.style.display = '';
    dom.closeRoomBtn.style.display = '';
  } else if (isController) {
    dom.hostBadge.textContent = 'Co-Host';
    dom.hostBadge.style.display = '';
    dom.closeRoomBtn.style.display = 'none';
  } else {
    dom.hostBadge.style.display = 'none';
    dom.closeRoomBtn.style.display = 'none';
  }

  [dom.playBtn, dom.prevBtn, dom.nextBtn, dom.loopBtn].forEach((btn) => {
    btn.disabled = !isController;
    btn.style.opacity = isController ? '' : '0.35';
    btn.style.cursor = isController ? '' : 'not-allowed';
  });
}

function updateNowPlayingUI(track) {
  if (!track) {
    dom.nowPlayingTrack.textContent = 'Nenhuma música tocando';
    dom.nowPlayingArtist.textContent = 'Adicione músicas para começar';
    dom.playerTrackName.textContent = '-';
    dom.playerArtistName.textContent = 'Nada tocando';
    dom.currentTime.textContent = '0:00';
    dom.totalTime.textContent = '0:00';
    dom.progressBar.style.width = '0%';
    dom.sourceBadgeArea.innerHTML = '';
    dom.artworkPlaceholder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    dom.playerThumb.innerHTML = '';
    document.title = 'SyncBeat';
    return;
  }

  dom.nowPlayingTrack.textContent = track.name;
  dom.nowPlayingArtist.textContent = track.artist || 'Fonte externa';
  dom.playerTrackName.textContent = track.name;
  dom.playerArtistName.textContent = track.artist || 'Fonte externa';
  dom.totalTime.textContent = formatTime(track.duration || 0);
  dom.sourceBadgeArea.innerHTML = '<span class="badge badge-url">URL</span>';

  const thumb = track.thumbnail || `https://i.ytimg.com/vi/${getTrackVideoId(track)}/hqdefault.jpg`;
  dom.artworkPlaceholder.innerHTML = `<img src="${thumb}" alt="${track.name}" />`;
  dom.playerThumb.innerHTML = `<img src="${thumb}" alt="${track.name}" />`;
  document.title = `${track.name} - SyncBeat`;
}

function renderQueue() {
  const idx = state.roomData?.current_track_index ?? 0;
  dom.queueCount.textContent = `${state.queue.length} música${state.queue.length !== 1 ? 's' : ''}`;
  if (dom.clearQueueBtn) dom.clearQueueBtn.disabled = !state.queue.length;

  if (!state.queue.length) {
    dom.queueList.innerHTML = '<div class="queue-empty">A fila está vazia. Cole uma URL para começar.</div>';
    return;
  }

  const list = document.createElement('div');
  list.className = 'queue-list';

  state.queue.forEach((track, i) => {
    const isActive = i === idx;
    const thumb = track.thumbnail || `https://i.ytimg.com/vi/${getTrackVideoId(track)}/hqdefault.jpg`;
    const canRemove = state.isHost || track.added_by === state.user?.id;
    const trackName = escapeHtml(track.name);
    const trackArtist = escapeHtml(track.artist || 'Fonte externa');
    const item = document.createElement('div');
    item.className = `queue-item${isActive ? ' active' : ''}`;
    item.innerHTML = `
      <span class="queue-num">${i + 1}</span>
      <span class="queue-playing-icon" style="color:var(--accent-light)">♪</span>
      <div class="queue-thumb"><img src="${escapeHtml(thumb)}" alt="${trackName}" /></div>
      <div class="queue-info">
        <div class="queue-name" title="${trackName}">${trackName}</div>
        <div class="queue-artist">${trackArtist}</div>
      </div>
      <div class="queue-duration">${track.duration ? formatTime(track.duration) : '-'}</div>
      ${canRemove ? `
        <button class="queue-action-btn queue-remove" data-action="remove-track" data-id="${track.id}" title="Remover música" aria-label="Remover ${trackName}">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-.8 14H5.8L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
        </button>
      ` : ''}
    `;
    list.appendChild(item);
  });

  dom.queueList.innerHTML = '';
  dom.queueList.appendChild(list);
  list.querySelectorAll('.queue-remove').forEach((btn) => {
    btn.addEventListener('click', () => confirmQueueRemoval(btn.dataset.id));
  });
}

function renderListeners(presenceState) {
  const allListeners = Object.values(presenceState || {}).flatMap((arr) => arr);
  const unique = [];
  const seen = new Set();

  for (const listener of allListeners) {
    if (!listener.user_id || seen.has(listener.user_id)) continue;
    seen.add(listener.user_id);
    unique.push(listener);
  }

  dom.listenersCount.textContent = unique.length;
  dom.listenersList.innerHTML = '';

  unique.forEach((listener) => {
    const isMainHost = listener.user_id === state.roomData?.host_id;
    const isCoHost = state.roomData?.co_hosts?.includes(listener.user_id);
    const canManageRole = state.isHost && !isMainHost && listener.user_id !== state.user.id;
    const color = Auth.getAvatarColor(listener.display_name || '');
    const displayName = escapeHtml(listener.display_name || 'Anônimo');
    const item = document.createElement('div');
    item.className = 'listener-item';
    item.innerHTML = `
      <div class="listener-avatar" style="background:${color}22;color:${color}">
        ${listener.avatar_url
          ? `<img src="${listener.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
          : Auth.getInitials(listener.display_name || '?')}
      </div>
      <span class="listener-name">${displayName}</span>
      ${isMainHost ? '<span class="listener-host-tag">Host</span>' : ''}
      ${isCoHost ? '<span class="listener-cohost-tag">Co-host</span>' : ''}
      ${canManageRole ? `
        <div class="listener-actions">
          <button class="listener-role-btn ${isCoHost ? 'btn-demote' : 'btn-promote'}"
            data-action="${isCoHost ? 'demote-cohost' : 'promote-cohost'}"
            data-user-id="${listener.user_id}"
            data-name="${displayName}">
            ${isCoHost ? 'Remover' : 'Promover'}
          </button>
        </div>
      ` : ''}
    `;
    dom.listenersList.appendChild(item);
  });

  dom.listenersList.querySelectorAll('[data-action="promote-cohost"], [data-action="demote-cohost"]').forEach((btn) => {
    btn.addEventListener('click', () => toggleCoHost(btn.dataset.userId, btn.dataset.action === 'promote-cohost', btn.dataset.name));
  });
}

async function toggleCoHost(userId, shouldPromote, displayName = 'Convidado') {
  if (!state.isHost || !userId) return;
  const coHosts = new Set(state.roomData?.co_hosts || []);
  if (shouldPromote) coHosts.add(userId);
  else coHosts.delete(userId);

  const { error } = await sb.from('rooms').update({ co_hosts: Array.from(coHosts) }).eq('id', ROOM_ID);
  if (error) {
    showToast('Erro ao atualizar co-host: ' + error.message, 'error');
    return;
  }

  state.roomData = { ...state.roomData, co_hosts: Array.from(coHosts) };
  renderListeners(realtimeChannel?.presenceState?.() || {});
  showToast(shouldPromote ? `${displayName} agora pode adicionar músicas.` : `${displayName} voltou a ser ouvinte.`, 'success');
}

async function hostPlay() {
  const pos = currentPlayerPos();
  const now = new Date().toISOString();
  const serverTime = Date.now();
  const previousRoomData = state.roomData;

  audioUnlocked = true;
  state.roomData = { ...state.roomData, is_playing: true, started_at: now, audio_offset: pos };
  updatePlayState(true);
  syncYouTube({ serverTime, audioPosition: pos, isPlaying: true });

  const { error } = await sb.from('rooms').update({
    is_playing: true,
    started_at: now,
    audio_offset: pos,
  }).eq('id', ROOM_ID);
  if (error) {
    state.roomData = previousRoomData;
    pauseYouTubePlayer();
    updatePlayState(false);
    showToast('Erro: ' + error.message, 'error');
    return;
  }

  realtimeChannel.send({ type: 'broadcast', event: 'playback:play', payload: { serverTime, audioPosition: pos } });
}

async function hostPause() {
  const pos = currentPlayerPos();
  const { error } = await sb.from('rooms').update({
    is_playing: false,
    audio_offset: pos,
    started_at: null,
  }).eq('id', ROOM_ID);
  if (error) { showToast('Erro: ' + error.message, 'error'); return; }

  state.roomData = { ...state.roomData, is_playing: false, audio_offset: pos, started_at: null };
  realtimeChannel.send({ type: 'broadcast', event: 'playback:pause', payload: { audioPosition: pos } });
  pauseYouTubePlayer();
  updatePlayState(false);
}

async function hostSeek(position) {
  const now = state.roomData?.is_playing ? new Date().toISOString() : null;
  const serverTime = Date.now();
  const { error } = await sb.from('rooms').update({ audio_offset: position, started_at: now }).eq('id', ROOM_ID);
  if (error) return;

  state.roomData = { ...state.roomData, audio_offset: position, started_at: now };
  realtimeChannel.send({
    type: 'broadcast',
    event: 'playback:seek',
    payload: { serverTime, audioPosition: position, isPlaying: state.roomData.is_playing },
  });
  syncYouTube({ serverTime, audioPosition: position, isPlaying: state.roomData.is_playing });
}

async function hostNext() {
  if (!state.queue.length) return;
  const nextIdx = (state.roomData.current_track_index + 1) % state.queue.length;
  await hostChangeTrack(nextIdx);
}

async function hostPrev() {
  if (!state.queue.length) return;
  const prevIdx = (state.roomData.current_track_index - 1 + state.queue.length) % state.queue.length;
  await hostChangeTrack(prevIdx);
}

async function hostChangeTrack(trackIndex) {
  const startedAt = state.roomData.is_playing ? new Date().toISOString() : null;
  const serverTime = Date.now();
  const { error } = await sb.from('rooms').update({
    current_track_index: trackIndex,
    audio_offset: 0,
    started_at: startedAt,
  }).eq('id', ROOM_ID);
  if (error) return;

  state.roomData = { ...state.roomData, current_track_index: trackIndex, audio_offset: 0, started_at: startedAt };
  const track = state.queue[trackIndex];
  loadYouTubeTrack(track, state.roomData.is_playing);
  realtimeChannel.send({
    type: 'broadcast',
    event: 'playback:trackChange',
    payload: { serverTime, audioPosition: 0, trackIndex, isPlaying: state.roomData.is_playing },
  });
  renderQueue();
}

function broadcastQueueState(reason) {
  if (!realtimeChannel) return;
  realtimeChannel.send({
    type: 'broadcast',
    event: 'playback:queueChanged',
    payload: {
      reason,
      serverTime: Date.now(),
      trackIndex: state.roomData?.current_track_index || 0,
      audioPosition: estimateRoomPosition(),
      isPlaying: Boolean(state.roomData?.is_playing),
    },
  });
}

async function applyQueueChange(payload = {}) {
  if (state.roomData) {
    const nextIsPlaying = typeof payload.isPlaying === 'boolean' ? payload.isPlaying : state.roomData.is_playing;
    state.roomData = {
      ...state.roomData,
      current_track_index: payload.trackIndex ?? state.roomData.current_track_index ?? 0,
      audio_offset: payload.audioPosition ?? state.roomData.audio_offset ?? 0,
      is_playing: nextIsPlaying,
      started_at: nextIsPlaying ? new Date(payload.serverTime || Date.now()).toISOString() : null,
    };
  }

  await refreshQueue();

  if (!state.queue.length) {
    pauseYouTubePlayer();
    updatePlayState(false);
    return;
  }

  syncYouTube({
    serverTime: payload.serverTime || Date.now(),
    audioPosition: payload.audioPosition ?? estimateRoomPosition(),
    isPlaying: Boolean(state.roomData?.is_playing),
  });
  updatePlayState(Boolean(state.roomData?.is_playing));
}

async function removeTrack(trackId) {
  const removedIndex = state.queue.findIndex((track) => track.id === trackId);
  const currentIndex = state.roomData?.current_track_index || 0;
  const queueLengthBefore = state.queue.length;
  const { error } = await sb.from('queue_items').delete().eq('id', trackId);
  if (error) {
    showToast('Erro ao remover música: ' + error.message, 'error');
    return;
  }

  let roomPatch = null;
  if (removedIndex >= 0 && removedIndex < currentIndex) {
    roomPatch = { current_track_index: Math.max(0, currentIndex - 1) };
  } else if (removedIndex === currentIndex) {
    const nextLength = Math.max(0, queueLengthBefore - 1);
    roomPatch = nextLength
      ? {
          current_track_index: Math.min(currentIndex, nextLength - 1),
          audio_offset: 0,
          started_at: state.roomData?.is_playing ? new Date().toISOString() : null,
        }
      : { current_track_index: 0, is_playing: false, started_at: null, audio_offset: 0 };
  }

  if (roomPatch) {
    await sb.from('rooms').update(roomPatch).eq('id', ROOM_ID);
    state.roomData = { ...state.roomData, ...roomPatch };
  }

  await refreshQueue();
  broadcastQueueState('removeTrack');

  if (!state.queue.length) {
    pauseYouTubePlayer();
    updatePlayState(false);
  }
}

async function confirmQueueRemoval(trackId) {
  const track = state.queue.find((item) => item.id === trackId);
  const confirmed = await SyncBeatUI.confirm({
    title: 'Remover música?',
    message: track ? `"${track.name}" será retirada da fila.` : 'Esta música será retirada da fila.',
    confirmLabel: 'Remover',
    cancelLabel: 'Cancelar',
    tone: 'danger',
  });
  if (confirmed) await removeTrack(trackId);
}

async function clearQueue() {
  if (!state.queue.length) return;
  const confirmed = await SyncBeatUI.confirm({
    title: 'Limpar fila?',
    message: `${state.queue.length} ${state.queue.length === 1 ? 'música será removida' : 'músicas serão removidas'} da sala.`,
    confirmLabel: 'Limpar fila',
    cancelLabel: 'Cancelar',
    tone: 'danger',
  });
  if (!confirmed) return;

  const { error } = await sb.from('queue_items').delete().eq('room_id', ROOM_ID);
  if (error) {
    showToast('Erro ao limpar fila: ' + error.message, 'error');
    return;
  }

  await sb.from('rooms').update({
    current_track_index: 0,
    is_playing: false,
    started_at: null,
    audio_offset: 0,
  }).eq('id', ROOM_ID);
  state.roomData = { ...state.roomData, current_track_index: 0, is_playing: false, started_at: null, audio_offset: 0 };
  await refreshQueue();
  broadcastQueueState('clearQueue');
  pauseYouTubePlayer();
  updatePlayState(false);
  showToast('Fila limpa.', 'success');
}

async function resolveAndAddTrack(input, statusEl) {
  if (!input.trim()) return;
  statusEl.innerHTML = '<span class="loader"></span> Buscando música...';

  try {
    const { data, error } = await resolveAudioInput(input);
    if (error || !data?.ok) throw new Error(data?.error || error?.message || 'Erro desconhecido');

    const track = data.track;
    if (!track.youtubeVideoId) throw new Error('Não foi possível identificar essa música pela URL.');

    const isFirstTrack = state.queue.length === 0 && !state.isPlaying;
    const maxPos = state.queue.reduce((max, item) => Math.max(max, item.position), -1);

    const { error: insertErr } = await sb.from('queue_items').insert({
      room_id: ROOM_ID,
      position: maxPos + 1,
      name: track.name,
      artist: track.artist,
      duration: track.duration,
      thumbnail: track.thumbnail,
      audio_url: track.originalUrl,
      youtube_video_id: track.youtubeVideoId,
      source_type: 'youtube',
      original_url: track.originalUrl,
      added_by: state.user.id,
    });

    if (insertErr) throw insertErr;

    statusEl.innerHTML = `<span style="color:var(--green)">OK</span> <strong>${track.name}</strong> adicionada.`;
    showToast(`"${track.name}" adicionada!`, 'success');

    if (isFirstTrack) {
      setTimeout(async () => {
        await refreshQueue();
        const firstTrack = state.queue[0];
        if (firstTrack && !state.isPlaying) {
          loadYouTubeTrack(firstTrack, false);
        }
      }, 600);
    }
  } catch (err) {
    statusEl.innerHTML = `Erro: ${err.message}`;
    showToast(err.message, 'error');
  }
}

async function subscribeToRoom() {
  realtimeChannel = sb.channel(`room-${ROOM_ID}`, {
    config: { broadcast: { self: false }, presence: { key: state.user.id } },
  });

  realtimeChannel
    .on('presence', { event: 'sync' }, () => renderListeners(realtimeChannel.presenceState()))
    .on('presence', { event: 'join' }, () => renderListeners(realtimeChannel.presenceState()))
    .on('presence', { event: 'leave' }, () => renderListeners(realtimeChannel.presenceState()));

  realtimeChannel
    .on('broadcast', { event: 'playback:play' }, ({ payload }) => {
      state.roomData = { ...state.roomData, is_playing: true, started_at: new Date(payload.serverTime).toISOString(), audio_offset: payload.audioPosition };
      syncYouTube({ ...payload, isPlaying: true });
      updatePlayState(true);
    })
    .on('broadcast', { event: 'playback:pause' }, ({ payload }) => {
      state.roomData = { ...state.roomData, is_playing: false, audio_offset: payload.audioPosition, started_at: null };
      syncYouTube({ serverTime: Date.now(), audioPosition: payload.audioPosition, isPlaying: false });
      updatePlayState(false);
    })
    .on('broadcast', { event: 'playback:seek' }, ({ payload }) => {
      state.roomData = {
        ...state.roomData,
        is_playing: payload.isPlaying,
        started_at: payload.isPlaying ? new Date(payload.serverTime).toISOString() : null,
        audio_offset: payload.audioPosition,
      };
      syncYouTube({ ...payload });
      updatePlayState(payload.isPlaying);
    })
    .on('broadcast', { event: 'playback:trackChange' }, ({ payload }) => {
      state.roomData = {
        ...state.roomData,
        is_playing: payload.isPlaying,
        started_at: payload.isPlaying ? new Date(payload.serverTime).toISOString() : null,
        current_track_index: payload.trackIndex,
        audio_offset: payload.audioPosition || 0,
      };
      const track = state.queue[payload.trackIndex];
      if (track) loadYouTubeTrack(track, payload.isPlaying);
      updatePlayState(payload.isPlaying);
      renderQueue();
    })
    .on('broadcast', { event: 'playback:queueChanged' }, ({ payload }) => {
      applyQueueChange(payload);
    })
    .on('broadcast', { event: 'playback:requestSync' }, ({ payload }) => {
      if (!state.isController) return;
      realtimeChannel.send({
        type: 'broadcast',
        event: 'playback:syncResponse',
        payload: {
          targetId: payload.requesterId,
          serverTime: Date.now(),
          audioPosition: currentPlayerPos(),
          isPlaying: state.isPlaying,
          trackIndex: state.roomData?.current_track_index || 0,
        },
      });
    })
    .on('broadcast', { event: 'playback:syncResponse' }, ({ payload }) => {
      if (payload.targetId !== state.user.id) return;
      if (state.roomData && state.roomData.current_track_index !== payload.trackIndex) {
        state.roomData.current_track_index = payload.trackIndex;
        const track = state.queue[payload.trackIndex];
        if (track) loadYouTubeTrack(track, false);
      }
      state.roomData = {
        ...state.roomData,
        is_playing: payload.isPlaying,
        started_at: payload.isPlaying ? new Date(payload.serverTime).toISOString() : null,
        audio_offset: payload.audioPosition,
      };
      syncYouTube({ serverTime: payload.serverTime, audioPosition: payload.audioPosition, isPlaying: payload.isPlaying });
      updatePlayState(payload.isPlaying);
    })
    .on('broadcast', { event: 'playback:roomClosed' }, () => {
      pauseYouTubePlayer();
      dom.closedMessage.textContent = 'A sala foi encerrada pelo Host.';
      dom.closedOverlay.style.display = 'flex';
    });

  realtimeChannel.on('postgres_changes', {
    event: '*', schema: 'public', table: 'queue_items', filter: `room_id=eq.${ROOM_ID}`,
  }, async () => { await refreshQueue(); });

  realtimeChannel.on('postgres_changes', {
    event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${ROOM_ID}`,
  }, async (payload) => {
    const previousTrackIndex = state.roomData?.current_track_index ?? 0;
    state.roomData = payload.new;
    state.loop = payload.new.loop || false;
    dom.loopBtn.classList.toggle('active', state.loop);
    const isCoHost = payload.new.co_hosts?.includes(state.user.id);
    setHostMode(state.isHost || isCoHost);

    const currentTrackIndex = payload.new.current_track_index || 0;
    if (previousTrackIndex !== currentTrackIndex) {
      const track = state.queue[currentTrackIndex];
      if (track) loadYouTubeTrack(track, false);
    }

    syncYouTube({
      serverTime: Date.now(),
      audioPosition: estimateRoomPosition(payload.new),
      isPlaying: payload.new.is_playing,
    });
    updatePlayState(payload.new.is_playing);
    renderQueue();
    renderListeners(realtimeChannel.presenceState());
  });

  await realtimeChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      dom.connectionBadge.textContent = 'Conectado';
      dom.connectionBadge.className = 'badge badge-green';
      await realtimeChannel.track({
        user_id: state.user.id,
        display_name: state.profile?.display_name || state.user.email,
        avatar_url: state.profile?.avatar_url || null,
        is_host: state.isHost,
      });
    } else if (status === 'CHANNEL_ERROR') {
      dom.connectionBadge.textContent = 'Erro';
      dom.connectionBadge.className = 'badge badge-muted';
    }
  });
}

async function refreshQueue() {
  const { data } = await sb.from('queue_items')
    .select('*')
    .eq('room_id', ROOM_ID)
    .order('position', { ascending: true });

  state.queue = data || [];
  renderQueue();

  const track = state.queue[state.roomData?.current_track_index || 0];
  if (track) {
    const isCurrentTrack = state.currentTrack && track.id === state.currentTrack.id;
    if (!isCurrentTrack) loadYouTubeTrack(track, false);
    if (state.roomData?.is_playing) {
      syncYouTube({
        serverTime: Date.now(),
        audioPosition: estimateRoomPosition(),
        isPlaying: true,
      });
    }
  } else {
    state.currentTrack = null;
    updateNowPlayingUI(null);
  }
}

async function loadRoomState() {
  const { data: room, error } = await sb.from('rooms').select('*').eq('id', ROOM_ID).single();
  if (error || !room) {
    dom.closedMessage.textContent = `Sala "${ROOM_ID}" não encontrada.`;
    dom.closedOverlay.style.display = 'flex';
    return;
  }

  state.roomData = room;
  state.isHost = room.host_id === state.user.id;
  const isCoHost = room.co_hosts?.includes(state.user.id);
  setHostMode(state.isHost || isCoHost);
  dom.roomCodeDisplay.textContent = ROOM_ID;

  await refreshQueue();

  const track = state.queue[room.current_track_index || 0];
  if (track) {
    loadYouTubeTrack(track, false);
    syncYouTube({
      serverTime: Date.now(),
      audioPosition: estimateRoomPosition(room),
      isPlaying: false,
    });
    updatePlayState(room.is_playing);
  }

  state.loop = room.loop || false;
  dom.loopBtn.classList.toggle('active', state.loop);
}

function requestSyncWithHost() {
  if (realtimeChannel && state.user) {
    realtimeChannel.send({
      type: 'broadcast',
      event: 'playback:requestSync',
      payload: { requesterId: state.user.id },
    });
  }
}

async function refreshRoomPlaybackState() {
  if (!state.user || !state.roomData) return;

  const { data: room, error } = await sb.from('rooms').select('*').eq('id', ROOM_ID).single();
  if (error || !room) {
    pauseYouTubePlayer();
    dom.closedMessage.textContent = `Sala "${ROOM_ID}" não encontrada.`;
    dom.closedOverlay.style.display = 'flex';
    return;
  }

  const previousTrackIndex = state.roomData?.current_track_index ?? 0;
  state.roomData = room;
  state.loop = room.loop || false;
  dom.loopBtn.classList.toggle('active', state.loop);

  const currentTrackIndex = room.current_track_index || 0;
  if (previousTrackIndex !== currentTrackIndex || !state.currentTrack) {
    const track = state.queue[currentTrackIndex];
    if (track) loadYouTubeTrack(track, false);
  }

  if (state.currentTrack) {
    syncYouTube({
      serverTime: Date.now(),
      audioPosition: estimateRoomPosition(room),
      isPlaying: room.is_playing,
    });
  }
  updatePlayState(room.is_playing);
  renderQueue();
}

function startPlaybackSyncLoop() {
  if (syncTimerId) clearInterval(syncTimerId);
  syncTimerId = setInterval(() => {
    if (!document.hidden) refreshRoomPlaybackState();
  }, SYNC_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshRoomPlaybackState();
      requestSyncWithHost();
    }
  });
}

function startPlayerProgressLoop() {
  if (playerProgressTimerId) clearInterval(playerProgressTimerId);
  playerProgressTimerId = setInterval(() => {
    if (!document.hidden) updateProgressFromPlayer();
  }, 500);
}

function startVisualizer() {
  const canvas = dom.visualizer;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const resize = () => {
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
  };
  resize();
  window.addEventListener('resize', resize);

  visualizerTimerId = setInterval(() => {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const bars = 28;
    const gap = 4 * devicePixelRatio;
    const barW = (w - gap * (bars - 1)) / bars;
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    gradient.addColorStop(0, state.isPlaying ? 'rgba(64, 201, 255, 0.08)' : 'rgba(117, 129, 150, 0.08)');
    gradient.addColorStop(0.52, state.isPlaying ? 'rgba(64, 201, 255, 0.5)' : 'rgba(117, 129, 150, 0.2)');
    gradient.addColorStop(1, state.isPlaying ? 'rgba(246, 200, 95, 0.26)' : 'rgba(117, 129, 150, 0.08)');

    for (let i = 0; i < bars; i++) {
      const wave = Math.sin(Date.now() / 420 + i * 0.72);
      const active = state.isPlaying ? 0.24 + Math.abs(wave) * 0.58 : 0.14 + (i % 5) * 0.018;
      const bh = Math.max(3 * devicePixelRatio, h * active);
      const x = i * (barW + gap);
      const y = h - bh;
      const radius = Math.min(barW / 2, 5 * devicePixelRatio);
      ctx.fillStyle = gradient;
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(x, y, barW, bh, radius);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, barW, bh);
      }
    }
  }, 120);
}

function showJoinButton() {
  const card = dom.joinOverlay.querySelector('.overlay-card');
  if (!card) return;

  const isHostUser = state.roomData?.host_id === state.user.id;
  const welcomeText = isHostUser
    ? 'Tudo pronto! Você é o host e controla a reprodução para todos.'
    : 'A sala está pronta! Clique abaixo para entrar e ouvir junto com o host.';

  card.innerHTML = `
    <div style="margin-bottom:20px;">
      <div style="width:64px;height:64px;background:var(--accent);border-radius:12px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:var(--shadow-accent);color:#061019;">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="34" height="34"><path d="M9 3v10.55A4 4 0 1 0 11 17V7h4V3H9z"/></svg>
      </div>
      <h2 style="margin-bottom:8px;font-family:'Space Grotesk',sans-serif;">SyncBeat</h2>
    </div>
    <p style="margin:0 0 28px;color:var(--text-secondary);font-size:0.95rem;line-height:1.6;">${welcomeText}</p>
    <button id="join-room-active-btn" class="btn btn-primary" style="width:100%;padding:16px;font-size:1rem;font-weight:700;border-radius:14px;">
      Entrar e Ouvir Junto
    </button>
  `;

  document.getElementById('join-room-active-btn').addEventListener('click', () => {
    audioUnlocked = true;
    dom.joinOverlay.style.animation = 'toastOut .3s ease forwards';
    setTimeout(() => { dom.joinOverlay.style.display = 'none'; }, 300);

    if (state.currentTrack && state.roomData) {
      syncYouTube({
        serverTime: Date.now(),
        audioPosition: estimateRoomPosition(),
        isPlaying: state.roomData.is_playing,
      });
    }
    requestSyncWithHost();
  });
}

dom.playBtn.addEventListener('click', () => {
  if (!state.isController) return;
  state.isPlaying ? hostPause() : hostPlay();
});
dom.nextBtn.addEventListener('click', () => state.isController && hostNext());
dom.prevBtn.addEventListener('click', () => state.isController && hostPrev());
dom.loopBtn.addEventListener('click', async () => {
  if (!state.isController) return;
  state.loop = !state.loop;
  await sb.from('rooms').update({ loop: state.loop }).eq('id', ROOM_ID);
  dom.loopBtn.classList.toggle('active', state.loop);
  realtimeChannel.send({ type: 'broadcast', event: 'playback:loop', payload: { loop: state.loop } });
});
dom.clearQueueBtn?.addEventListener('click', () => state.isHost && clearQueue());

dom.progressBarTrack.addEventListener('click', (e) => {
  if (!state.isController) return;
  const dur = getPlayerDuration() || state.currentTrack?.duration || 0;
  if (!dur) return;
  const { left, width } = dom.progressBarTrack.getBoundingClientRect();
  hostSeek(((e.clientX - left) / width) * dur);
});

function updateVolumeIcon(v) {
  if (v === 0) {
    dom.volumeIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
  } else {
    dom.volumeIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
  }
}

let lastVol = 1;
dom.volumeSlider.addEventListener('input', () => {
  const v = parseFloat(dom.volumeSlider.value);
  lastVol = v;
  setYouTubeVolume(v);
});
dom.volumeIcon.addEventListener('click', () => {
  const currentVolume = getYouTubeVolume();
  if (currentVolume > 0) {
    lastVol = currentVolume;
    dom.volumeSlider.value = 0;
    setYouTubeVolume(0);
  } else {
    const restoredVolume = lastVol || 1;
    dom.volumeSlider.value = restoredVolume;
    setYouTubeVolume(restoredVolume);
  }
});

dom.copyCodeBtn.addEventListener('click', () =>
  navigator.clipboard.writeText(ROOM_ID).then(() => showToast('Código copiado!', 'success')));
dom.copyLinkBtn.addEventListener('click', () =>
  navigator.clipboard.writeText(`${location.origin}${getRoomPagePath()}?room=${ROOM_ID}`).then(() => showToast('Link copiado!', 'success')));
dom.closeRoomBtn.addEventListener('click', () => { window.location.href = getHomePagePath(); });

if (dom.themeToggle) {
  const sunIcon = dom.themeToggle.querySelector('.theme-icon-sun');
  const moonIcon = dom.themeToggle.querySelector('.theme-icon-moon');
  const updateIcons = () => {
    const isLight = document.documentElement.classList.contains('light-theme');
    if (sunIcon) sunIcon.style.display = isLight ? 'none' : 'block';
    if (moonIcon) moonIcon.style.display = isLight ? 'block' : 'none';
  };
  updateIcons();
  dom.themeToggle.addEventListener('click', () => {
    const isLight = document.documentElement.classList.toggle('light-theme');
    localStorage.setItem('syncbeat_theme', isLight ? 'light' : 'dark');
    updateIcons();
  });
}

function activateAddTab(tabName) {
  const isUrl = tabName === 'url';
  dom.tabSearch?.classList.toggle('active', !isUrl);
  dom.tabUrl?.classList.toggle('active', isUrl);
  dom.tabContentSearch?.classList.toggle('active', !isUrl);
  dom.tabContentUrl?.classList.toggle('active', isUrl);
  if (isUrl) dom.urlInput?.focus();
  else dom.searchInput?.focus();
}

dom.tabSearch?.addEventListener('click', () => activateAddTab('search'));
dom.tabUrl?.addEventListener('click', () => activateAddTab('url'));

dom.searchBtn.addEventListener('click', async () => {
  const q = dom.searchInput.value.trim();
  if (!q) return;
  await resolveAndAddTrack(q, dom.searchStatus);
  dom.searchInput.value = '';
});
dom.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dom.searchBtn.click();
});

dom.urlAddBtn?.addEventListener('click', async () => {
  const url = dom.urlInput.value.trim();
  if (!url) return;
  await resolveAndAddTrack(url, dom.urlStatus);
  dom.urlInput.value = '';
});
dom.urlInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dom.urlAddBtn.click();
});

async function init() {
  const session = await Auth.getSession();
  if (!session) {
    window.location.href = `${getHomePagePath()}?room=${ROOM_ID}`;
    return;
  }

  state.user = session.user;
  state.profile = await Auth.getProfile();

  const name = state.profile?.display_name || state.user.email?.split('@')[0] || '?';
  const avatarUrl = state.profile?.avatar_url;
  dom.userNameHeader.textContent = name;
  if (avatarUrl) {
    dom.userAvatarHeader.innerHTML = `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`;
  } else {
    const color = Auth.getAvatarColor(name);
    dom.userAvatarHeader.style.background = color + '33';
    dom.userAvatarHeader.style.color = color;
    dom.userAvatarHeader.textContent = Auth.getInitials(name);
  }

  initYouTubePlayer();
  await loadRoomState();
  await subscribeToRoom();
  startPlaybackSyncLoop();
  startPlayerProgressLoop();
  startVisualizer();
  showJoinButton();
}

init();

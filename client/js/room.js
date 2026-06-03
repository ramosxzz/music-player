/**
 * room.js — Room page logic (HTML5 Audio only — no YouTube iframe)
 *
 * Audio is played via native <audio> element.
 * The resolve-audio Edge Function returns direct streamable audio URLs via Cobalt.
 *
 * Uses Supabase Realtime:
 * - Broadcast: instant playback events (play/pause/seek/trackChange)
 * - Postgres Changes: queue updates
 * - Presence: connected listeners
 *
 * State source of truth:
 * - rooms table → is_playing, started_at, audio_offset, current_track_index
 * - queue_items table → the playlist
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Init
// ═══════════════════════════════════════════════════════════════════════════════

const params = new URLSearchParams(window.location.search);
const ROOM_ID = params.get('room')?.toUpperCase();

if (!ROOM_ID) window.location.href = '/';

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
let animFrameId = null;
let audioCtx = null;
let analyser = null;
let sourceNode = null;
let audioUnlocked = false;
let pendingSync = null;
let syncTimerId = null;
let visualizerFrame = 0;

const DRIFT_CORRECTION_SECONDS = 0.75;
const SYNC_INTERVAL_MS = 5000;

// ═══════════════════════════════════════════════════════════════════════════════
// DOM
// ═══════════════════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);
const dom = {
  joinOverlay:        $('join-overlay'),
  closedOverlay:      $('closed-overlay'),
  closedMessage:      $('closed-message'),

  roomCodeDisplay:    $('room-code-display'),
  connectionBadge:    $('connection-badge'),
  hostBadge:          $('host-badge'),
  closeRoomBtn:       $('close-room-btn'),
  copyCodeBtn:        $('copy-code-btn'),
  copyLinkBtn:        $('copy-link-btn'),
  userAvatarHeader:   $('user-avatar-header'),
  userNameHeader:     $('user-name-header'),

  artworkPlaceholder: $('artwork-placeholder'),
  playingIndicator:   $('playing-indicator'),
  sourceBadgeArea:    $('source-badge-area'),
  nowPlayingTrack:    $('now-playing-track'),
  nowPlayingArtist:   $('now-playing-artist'),
  currentTime:        $('current-time'),
  totalTime:          $('total-time'),
  progressBarTrack:   $('progress-bar-track'),
  progressBar:        $('progress-bar'),

  addMusicPanel:      $('add-music-panel'),
  searchInput:        $('search-input'),
  searchBtn:          $('search-btn'),
  searchStatus:       $('search-status'),
  urlInput:           $('url-input'),
  urlAddBtn:          $('url-add-btn'),
  urlStatus:          $('url-status'),
  fileDropArea:       $('file-drop-area'),
  fileInput:          $('fileInput'),
  uploadStatus:       $('upload-status'),

  queueList:          $('queue-list'),
  queueCount:         $('queue-count'),

  listenersList:      $('listeners-list'),
  listenersCount:     $('listeners-count'),

  listenerOnlyBar:    $('listener-only-bar'),

  playerThumb:        $('player-thumb'),
  playerTrackName:    $('player-track-name'),
  playerArtistName:   $('player-artist-name'),

  playBtn:            $('play-btn'),
  prevBtn:            $('prev-btn'),
  nextBtn:            $('next-btn'),
  loopBtn:            $('loop-btn'),

  volumeSlider:       $('volume-slider'),
  volumeIcon:         $('volume-icon'),

  visualizer:         $('visualizer'),
  audioPlayer:        $('audio-player'),
  themeToggle:        $('theme-toggle'),
};

const audio = dom.audioPlayer;

// ═══════════════════════════════════════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════════════════════════════════════

function showToast(msg, type = 'info', duration = 3500) {
  const c = $('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span></span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.animation = 'toastOut .3s ease forwards'; setTimeout(() => t.remove(), 300); }, duration);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Audio — HTML5 Native (no YouTube iframe)
// ═══════════════════════════════════════════════════════════════════════════════

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function getTrackUrl(track) {
  return track?.audio_url || track?.audioUrl || '';
}

function getTrackSource(track) {
  return track?.source_type || track?.sourceType || 'url';
}

function estimateRoomPosition(roomData = state.roomData) {
  if (!roomData) return 0;

  const offset = Number(roomData.audio_offset || 0);
  if (!roomData.is_playing || !roomData.started_at) return offset;

  const startedAt = new Date(roomData.started_at).getTime();
  if (!Number.isFinite(startedAt)) return offset;

  return Math.max(0, offset + (Date.now() - startedAt) / 1000);
}

function clampAudioPosition(position, track = state.currentTrack) {
  const duration = Number.isFinite(audio.duration) && audio.duration > 0
    ? audio.duration
    : Number(track?.duration || 0);

  if (!Number.isFinite(position)) return 0;
  if (!duration) return Math.max(0, position);
  return Math.max(0, Math.min(position, Math.max(0, duration - 0.25)));
}

async function resolveAudioInput(input) {
  const body = JSON.stringify({ input });
  const canUseLocalBackend =
    ['localhost', '127.0.0.1'].includes(location.hostname) && location.port === '3000';

  if (canUseLocalBackend) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 35_000);
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) return { data: await res.json(), error: null };
      if (res.status !== 404) {
        const data = await res.json().catch(() => null);
        return { data, error: { message: data?.error || res.statusText } };
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.warn('Backend local indisponível, usando Supabase:', err);
    }
  }

  return sb.functions.invoke('resolve-audio', { body: { input } });
}

function getOrCreateAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

let autoplayPromptActive = false;

function showAutoplayPrompt() {
  if (autoplayPromptActive || audioUnlocked) return;
  autoplayPromptActive = true;

  const bar = document.createElement('div');
  bar.id = 'autoplay-prompt-bar';
  bar.className = 'autoplay-prompt-bar';
  bar.innerHTML = `
    <span>Clique para ativar o som e sincronizar!</span>
    <button id="autoplay-unlock-btn">Ativar Som</button>
  `;
  document.body.appendChild(bar);

  const unlock = () => {
    audioUnlocked = true;
    getOrCreateAudioCtx().resume();
    if (state.isPlaying) {
      audio.play().then(() => {
        bar.remove();
        autoplayPromptActive = false;
        document.removeEventListener('click', unlock);
      }).catch(() => {});
    } else {
      bar.remove();
      autoplayPromptActive = false;
      document.removeEventListener('click', unlock);
    }
  };

  document.getElementById('autoplay-unlock-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    unlock();
  });
  document.addEventListener('click', unlock);
}

// Sync audio position and play/pause state with the room
function syncAudio({ serverTime, audioPosition, isPlaying }) {
  const trackUrl = getTrackUrl(state.currentTrack);
  if (!state.currentTrack || !trackUrl) return;

  if (audio.dataset.trackId !== state.currentTrack.id || audio.dataset.trackUrl !== trackUrl) {
    loadTrack(state.currentTrack, false);
  }

  let pos = audioPosition;
  if (isPlaying && serverTime) pos += (Date.now() - serverTime) / 1000;
  pos = clampAudioPosition(pos);

  if (audio.readyState === HTMLMediaElement.HAVE_NOTHING) {
    pendingSync = { serverTime, audioPosition, isPlaying };
    audio.load();
    return;
  }

  if (isPlaying) {
    if (Math.abs(audio.currentTime - pos) > DRIFT_CORRECTION_SECONDS) audio.currentTime = pos;
    if (!audioUnlocked && dom.joinOverlay.style.display !== 'none') return;
    if (audioUnlocked) {
      try { getOrCreateAudioCtx().resume(); } catch (_) {}
    }
    audio.play().catch((err) => {
      if (err.name === 'NotAllowedError') showAutoplayPrompt();
    });
  } else {
    if (Math.abs(audio.currentTime - pos) > 0.5) audio.currentTime = pos;
    audio.pause();
  }
}

// Load a track into the HTML5 audio player
function loadTrack(track, autoPlay = false) {
  if (!track) return;

  const trackUrl = getTrackUrl(track);
  const isSameTrack = state.currentTrack && state.currentTrack.id === track.id;
  const currentPos = isSameTrack ? audio.currentTime : 0;

  if (state.currentTrack && state.currentTrack.id !== track.id) {
    if (state.retryCounts) delete state.retryCounts[state.currentTrack.id];
  }
  state.currentTrack = track;

  if (audio.dataset.trackId !== track.id || audio.dataset.trackUrl !== trackUrl) {
    audio.dataset.trackId = track.id;
    audio.dataset.trackUrl = trackUrl;
    audio.src = trackUrl;
    audio.load();
  }

  if (currentPos > 0) {
    pendingSync = { serverTime: Date.now(), audioPosition: currentPos, isPlaying: false };
  }

  if (autoPlay && trackUrl) {
    syncAudio({
      serverTime: Date.now(),
      audioPosition: estimateRoomPosition(),
      isPlaying: true,
    });
  }

  updateNowPlayingUI(track);
}

// Audio element events
audio.addEventListener('loadedmetadata', () => {
  if (!pendingSync) return;
  const sync = pendingSync;
  pendingSync = null;
  syncAudio(sync);
});

audio.addEventListener('canplay', () => {
  if (!pendingSync) return;
  const sync = pendingSync;
  pendingSync = null;
  syncAudio(sync);
});

audio.addEventListener('timeupdate', () => {
  const cur = audio.currentTime;
  const dur = audio.duration || state.currentTrack?.duration || 0;
  dom.currentTime.textContent = formatTime(cur);
  dom.totalTime.textContent = formatTime(dur);
  if (dur > 0) dom.progressBar.style.width = `${(cur / dur) * 100}%`;
});

audio.addEventListener('ended', async () => {
  if (!state.isHost) return;
  if (state.loop) {
    await hostSeek(0);
    await hostPlay();
  } else {
    await hostNext();
  }
});

audio.addEventListener('error', async (e) => {
  const track = state.currentTrack;
  if (!track) return;
  console.error('Audio error:', e);

  // Se o link expirou e não for um arquivo local, tentamos re-resolver automaticamente (limite de 1 tentativa por track)
  state.retryCounts = state.retryCounts || {};
  const retries = state.retryCounts[track.id] || 0;

  if (track.original_url && getTrackSource(track) !== 'upload' && retries < 1) {
    state.retryCounts[track.id] = retries + 1;
    showToast('Link de áudio expirado. Atualizando automaticamente...', 'info');
    try {
      const { data, error } = await resolveAudioInput(track.original_url);

      if (error || !data?.ok) throw new Error(data?.error || error?.message || 'Erro ao resolver');

      const newAudioUrl = data.track.audioUrl;

      // Se formos o host, atualizamos no banco para todos os ouvintes
      try {
        const { error: updateErr } = await sb.from('queue_items')
          .update({ audio_url: newAudioUrl })
          .eq('id', track.id);
        if (updateErr) console.warn('Erro ao atualizar URL no banco:', updateErr);
      } catch (dbErr) {
        console.warn('Erro ao atualizar banco:', dbErr);
      }

      // Atualiza localmente e tenta reproduzir mantendo a posição
      track.audio_url = newAudioUrl;
      loadTrack(track, state.roomData?.is_playing);
      showToast('Link de áudio atualizado com sucesso!', 'success');
    } catch (resolveErr) {
      console.error('Erro ao re-resolver áudio:', resolveErr);
      showToast('Erro ao carregar áudio. Não foi possível re-resolver a música.', 'error');
    }
  } else {
    showToast('Erro ao carregar áudio. O link pode ter expirado — tente readicionar a música.', 'error');
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Visualizer — Real AudioContext (works because we're using HTML5 audio)
// ═══════════════════════════════════════════════════════════════════════════════

function startVisualizer() {
  const canvas = dom.visualizer;
  const ctx = canvas.getContext('2d');
  const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
  resize();
  new ResizeObserver(resize).observe(canvas);

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    visualizerFrame = (visualizerFrame + 1) % 6;
    if (!state.isPlaying && visualizerFrame !== 0) return;
    if (state.isPlaying && visualizerFrame % 2 !== 0) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!analyser) {
      // Visualizer not yet connected — show quiet idle bars
      drawIdleBars(ctx, canvas, state.isPlaying);
      return;
    }

    const buf = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(buf);

    const bw = (canvas.width / buf.length) * 2.2;
    let x = 0;
    const isLight = document.documentElement.classList.contains('light-theme');
    for (let i = 0; i < buf.length; i++) {
      const h = (buf[i] / 255) * canvas.height;
      if (h < 1) { x += bw; continue; }
      const g = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - h);
      if (isLight) {
        g.addColorStop(0, 'rgba(0, 0, 0, 0.8)');
        g.addColorStop(1, 'rgba(0, 0, 0, 0.1)');
      } else {
        g.addColorStop(0, 'rgba(255, 255, 255, 0.8)');
        g.addColorStop(1, 'rgba(255, 255, 255, 0.1)');
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x, canvas.height - h, bw - 2, h, 2);
      ctx.fill();
      x += bw;
    }
  }
  draw();
}

let idleAngles = Array.from({ length: 32 }, (_, i) => i * 0.12);

function drawIdleBars(ctx, canvas, isPlaying) {
  const numBars = 32;
  const bw = (canvas.width / numBars) * 2.2;
  let x = 0;
  const speed = isPlaying ? 0.04 : 0;
  const isLight = document.documentElement.classList.contains('light-theme');

  for (let i = 0; i < numBars; i++) {
    idleAngles[i] = (idleAngles[i] || 0) + speed;
    let factor = 0;
    if (isPlaying) {
      factor = Math.sin(idleAngles[i]) * 0.35 + Math.sin(idleAngles[i] * 2.1) * 0.3 + Math.cos(idleAngles[i] * 0.8) * 0.35;
      factor = Math.max(0.04, Math.abs(factor));
    }
    const h = factor * canvas.height * 0.8;
    if (h < 1) { x += bw; continue; }
    const g = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - h);
    if (isLight) {
      g.addColorStop(0, 'rgba(0, 0, 0, 0.4)');
      g.addColorStop(1, 'rgba(0, 0, 0, 0.05)');
    } else {
      g.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
      g.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(x, canvas.height - h, bw - 2, h, 2);
    ctx.fill();
    x += bw;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════════

const SOURCE_BADGES = {
  youtube: '<span class="badge badge-youtube">YouTube</span>',
  spotify: '<span class="badge badge-spotify">Spotify</span>',
  upload:  '<span class="badge badge-upload">Upload</span>',
  url:     '<span class="badge badge-url">URL</span>',
};

function updateNowPlayingUI(track) {
  if (!track) {
    dom.nowPlayingTrack.textContent = 'Nenhuma música tocando';
    dom.nowPlayingArtist.textContent = 'Adicione músicas para começar';
    dom.sourceBadgeArea.innerHTML = '';
    dom.artworkPlaceholder.innerHTML = '🎵';
    dom.playerTrackName.textContent = '—';
    dom.playerArtistName.textContent = 'Nada tocando';
    dom.playerThumb.innerHTML = '🎵';
    document.title = 'SyncBeat';
    return;
  }
  dom.nowPlayingTrack.textContent = track.name;
  dom.nowPlayingArtist.textContent = track.artist || 'Desconhecido';
  dom.sourceBadgeArea.innerHTML = SOURCE_BADGES[getTrackSource(track)] || '';
  const thumb = track.thumbnail;
  if (thumb) {
    dom.artworkPlaceholder.innerHTML = `<img src="${thumb}" alt="${track.name}" />`;
    dom.playerThumb.innerHTML = `<img src="${thumb}" alt="${track.name}" />`;
  } else {
    dom.artworkPlaceholder.innerHTML = '🎵';
    dom.playerThumb.innerHTML = '🎵';
  }
  dom.playerTrackName.textContent = track.name;
  dom.playerArtistName.textContent = track.artist || '';
  if (track.duration) dom.totalTime.textContent = formatTime(track.duration);
  document.title = `${track.name} — SyncBeat`;
}

function updatePlayState(isPlaying) {
  state.isPlaying = isPlaying;
  if (isPlaying) {
    dom.playBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>`;
  } else {
    dom.playBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>`;
  }
  dom.playingIndicator.classList.toggle('paused', !isPlaying);
}

function setHostMode(isController) {
  state.isController = isController;
  dom.addMusicPanel.style.display = isController ? '' : 'none';
  dom.listenerOnlyBar.style.display = isController ? 'none' : '';

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

  [dom.playBtn, dom.prevBtn, dom.nextBtn, dom.loopBtn].forEach((b) => {
    b.disabled = !isController;
    b.style.opacity = isController ? '' : '0.35';
    b.style.cursor = isController ? '' : 'not-allowed';
  });
}

function renderQueue() {
  const { queue, roomData } = state;
  const idx = roomData?.current_track_index ?? 0;
  dom.queueCount.textContent = `${queue.length} música${queue.length !== 1 ? 's' : ''}`;

  if (!queue.length) {
    dom.queueList.innerHTML = '<div class="queue-empty">A fila está vazia. Adicione músicas!</div>';
    return;
  }

  dom.queueList.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'queue-list';

  queue.forEach((track, i) => {
    const isActive = i === idx;
    const sourceText = { youtube:'YT', spotify:'SP', upload:'UP', url:'LINK' }[getTrackSource(track)] || 'AUD';
    const item = document.createElement('div');
    item.className = `queue-item${isActive ? ' active' : ''}`;
    item.innerHTML = `
      <span class="queue-num">${i + 1}</span>
      <span class="queue-playing-icon" style="color:var(--accent-light)">♪</span>
      <div class="queue-thumb">
        ${track.thumbnail ? `<img src="${track.thumbnail}" alt="${track.name}" />` : `<span class="source-txt">${sourceText}</span>`}
      </div>
      <div class="queue-info">
        <div class="queue-name" title="${track.name}">${track.name}</div>
        <div class="queue-artist">${track.artist || 'Desconhecido'}</div>
      </div>
      <div class="queue-duration">${track.duration ? formatTime(track.duration) : '—'}</div>
      ${state.isHost ? `<button class="queue-remove" data-id="${track.id}" title="Remover">✕</button>` : ''}
    `;
    list.appendChild(item);
  });

  dom.queueList.appendChild(list);
  list.querySelectorAll('.queue-remove').forEach((btn) => {
    btn.addEventListener('click', () => removeTrack(btn.dataset.id));
  });
}

function renderListeners(presenceState) {
  const allListeners = Object.values(presenceState).flatMap((arr) => arr);

  const uniqueListeners = [];
  const seenIds = new Set();
  for (const l of allListeners) {
    if (!l.user_id) continue;
    if (!seenIds.has(l.user_id)) {
      seenIds.add(l.user_id);
      uniqueListeners.push(l);
    }
  }

  dom.listenersCount.textContent = uniqueListeners.length;
  dom.listenersList.innerHTML = '';

  uniqueListeners.forEach((l) => {
    const isMainHost = l.user_id === state.roomData?.host_id;
    const isCoHost = state.roomData?.co_hosts?.includes(l.user_id);
    const isCurrentUserHost = state.user.id === state.roomData?.host_id;

    let tag = '';
    if (isMainHost) tag = '<span class="listener-host-tag">Host</span>';
    else if (isCoHost) tag = '<span class="listener-cohost-tag">Co-Host</span>';

    let actionBtn = '';
    if (isCurrentUserHost && !isMainHost) {
      actionBtn = isCoHost
        ? `<button class="btn-demote" data-user-id="${l.user_id}" title="Remover Co-Host"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="5" y1="12" x2="19" y2="12"/></svg></button>`
        : `<button class="btn-promote" data-user-id="${l.user_id}" title="Tornar Co-Host"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>`;
    }

    const item = document.createElement('div');
    item.className = 'listener-item';
    const color = Auth.getAvatarColor(l.display_name || '');
    item.innerHTML = `
      <div class="listener-avatar" style="background:${color}22;color:${color}">
        ${l.avatar_url
          ? `<img src="${l.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" />`
          : Auth.getInitials(l.display_name || '?')}
      </div>
      <span class="listener-name">${l.display_name || 'Anônimo'}</span>
      ${tag}
      ${actionBtn}
    `;
    dom.listenersList.appendChild(item);
  });

  dom.listenersList.querySelectorAll('.btn-promote').forEach(btn => {
    btn.addEventListener('click', () => promoteToCoHost(btn.dataset.userId));
  });
  dom.listenersList.querySelectorAll('.btn-demote').forEach(btn => {
    btn.addEventListener('click', () => demoteFromCoHost(btn.dataset.userId));
  });
}

async function promoteToCoHost(userId) {
  if (!state.isHost) return;
  const currentCoHosts = state.roomData?.co_hosts || [];
  if (currentCoHosts.includes(userId)) return;
  const { error } = await sb.from('rooms').update({ co_hosts: [...currentCoHosts, userId] }).eq('id', ROOM_ID);
  if (error) showToast('Erro ao promover: ' + error.message, 'error');
  else showToast('Usuário promovido a Co-Host!', 'success');
}

async function demoteFromCoHost(userId) {
  if (!state.isHost) return;
  const currentCoHosts = state.roomData?.co_hosts || [];
  const { error } = await sb.from('rooms').update({ co_hosts: currentCoHosts.filter(id => id !== userId) }).eq('id', ROOM_ID);
  if (error) showToast('Erro ao remover promoção: ' + error.message, 'error');
  else showToast('Co-Host rebaixado a ouvinte.', 'success');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Host Actions (DB + Broadcast)
// ═══════════════════════════════════════════════════════════════════════════════

function currentAudioPos() {
  if (state.isController && !audio.paused && Number.isFinite(audio.currentTime)) {
    return audio.currentTime;
  }
  return estimateRoomPosition();
}

async function hostPlay() {
  const pos = currentAudioPos();
  const now = new Date().toISOString();
  const serverTime = Date.now();
  const { error } = await sb.from('rooms').update({
    is_playing: true,
    started_at: now,
    audio_offset: pos,
  }).eq('id', ROOM_ID);
  if (error) { showToast('Erro: ' + error.message, 'error'); return; }

  state.roomData = { ...state.roomData, is_playing: true, started_at: now, audio_offset: pos };

  realtimeChannel.send({
    type: 'broadcast',
    event: 'playback:play',
    payload: { serverTime, audioPosition: pos },
  });
  updatePlayState(true);
  syncAudio({ serverTime, audioPosition: pos, isPlaying: true });
}

async function hostPause() {
  const pos = currentAudioPos();
  const { error } = await sb.from('rooms').update({
    is_playing: false,
    audio_offset: pos,
    started_at: null,
  }).eq('id', ROOM_ID);
  if (error) { showToast('Erro: ' + error.message, 'error'); return; }

  state.roomData = { ...state.roomData, is_playing: false, audio_offset: pos, started_at: null };

  realtimeChannel.send({
    type: 'broadcast',
    event: 'playback:pause',
    payload: { audioPosition: pos },
  });
  audio.pause();
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
  syncAudio({ serverTime, audioPosition: position, isPlaying: state.roomData.is_playing });
}

async function hostNext() {
  if (!state.queue.length) return;
  const nextIdx = (state.roomData.current_track_index + 1) % state.queue.length;
  const startedAt = state.roomData.is_playing ? new Date().toISOString() : null;
  const serverTime = Date.now();
  const { error } = await sb.from('rooms').update({
    current_track_index: nextIdx,
    audio_offset: 0,
    started_at: startedAt,
  }).eq('id', ROOM_ID);
  if (error) return;

  state.roomData = { ...state.roomData, current_track_index: nextIdx, audio_offset: 0, started_at: startedAt };
  const track = state.queue[nextIdx];
  loadTrack(track, state.roomData.is_playing);

  realtimeChannel.send({
    type: 'broadcast',
    event: 'playback:trackChange',
    payload: { serverTime, audioPosition: 0, trackIndex: nextIdx, isPlaying: state.roomData.is_playing },
  });
  renderQueue();
}

async function hostPrev() {
  if (!state.queue.length) return;
  const prevIdx = (state.roomData.current_track_index - 1 + state.queue.length) % state.queue.length;
  const startedAt = state.roomData.is_playing ? new Date().toISOString() : null;
  const serverTime = Date.now();
  const { error } = await sb.from('rooms').update({
    current_track_index: prevIdx,
    audio_offset: 0,
    started_at: startedAt,
  }).eq('id', ROOM_ID);
  if (error) return;

  state.roomData = { ...state.roomData, current_track_index: prevIdx, audio_offset: 0, started_at: startedAt };
  const track = state.queue[prevIdx];
  loadTrack(track, state.roomData.is_playing);

  realtimeChannel.send({
    type: 'broadcast',
    event: 'playback:trackChange',
    payload: { serverTime, audioPosition: 0, trackIndex: prevIdx, isPlaying: state.roomData.is_playing },
  });
  renderQueue();
}

async function removeTrack(trackId) {
  await sb.from('queue_items').delete().eq('id', trackId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Add Music
// ═══════════════════════════════════════════════════════════════════════════════

async function resolveAndAddTrack(input, statusEl) {
  if (!input.trim()) return;
  statusEl.innerHTML = '<span class="loader"></span> Resolvendo e extraindo áudio...';

  try {
    const { data, error } = await resolveAudioInput(input);

    if (error || !data?.ok) throw new Error(data?.error || error?.message || 'Erro desconhecido');

    const track = data.track;
    const isFirstTrack = state.queue.length === 0 && !state.isPlaying;
    const maxPos = state.queue.reduce((m, t) => Math.max(m, t.position), -1);

    const { error: insertErr } = await sb.from('queue_items').insert({
      room_id: ROOM_ID,
      position: maxPos + 1,
      name: track.name,
      artist: track.artist,
      duration: track.duration,
      thumbnail: track.thumbnail,
      audio_url: track.audioUrl,
      source_type: track.sourceType,
      original_url: track.originalUrl,
      added_by: state.user.id,
    });

    if (insertErr) throw insertErr;

    statusEl.innerHTML = `✅ <strong>${track.name}</strong> adicionada.`;
    showToast(`"${track.name}" adicionada!`, 'success');

    // Auto-play: se era a primeira música e a sala está parada
    if (isFirstTrack) {
      setTimeout(async () => {
        await refreshQueue();
        const firstTrack = state.queue[0];
        if (firstTrack && !state.isPlaying) {
          loadTrack(firstTrack, false);
          setTimeout(() => hostPlay(), 300);
        }
      }, 600);
    }
  } catch (err) {
    statusEl.innerHTML = `❌ ${err.message}`;
    showToast(err.message, 'error');
  }
}

async function handleFileUpload(files) {
  if (!files.length) return;
  dom.uploadStatus.innerHTML = `<span class="loader"></span> Fazendo upload de ${files.length} arquivo(s)...`;
  let uploaded = 0;

  for (const file of files) {
    const ext = file.name.split('.').pop();
    const path = `${state.user.id}/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { data: uploadData, error: uploadErr } = await sb.storage
      .from('audio-uploads')
      .upload(path, file, { cacheControl: '3600', upsert: false });

    if (uploadErr) { showToast(`Erro ao fazer upload de ${file.name}`, 'error'); continue; }

    const { data: urlData } = sb.storage.from('audio-uploads').getPublicUrl(uploadData.path);
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    const maxPos = state.queue.reduce((m, t) => Math.max(m, t.position), -1);

    await sb.from('queue_items').insert({
      room_id: ROOM_ID,
      position: maxPos + 1,
      name,
      artist: 'Upload',
      duration: 0,
      audio_url: urlData.publicUrl,
      source_type: 'upload',
      added_by: state.user.id,
    });
    uploaded++;
  }

  dom.uploadStatus.innerHTML = `✅ ${uploaded} arquivo(s) adicionado(s).`;
  dom.fileInput.value = '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Realtime Channel
// ═══════════════════════════════════════════════════════════════════════════════

async function subscribeToRoom() {
  realtimeChannel = sb.channel(`room-${ROOM_ID}`, {
    config: { broadcast: { self: false }, presence: { key: state.user.id } },
  });

  // Presence
  realtimeChannel
    .on('presence', { event: 'sync' }, () => renderListeners(realtimeChannel.presenceState()))
    .on('presence', { event: 'join' }, () => renderListeners(realtimeChannel.presenceState()))
    .on('presence', { event: 'leave' }, () => {
      renderListeners(realtimeChannel.presenceState());
    });

  // Playback broadcasts
  realtimeChannel
    .on('broadcast', { event: 'playback:play' }, ({ payload }) => {
      state.roomData = { ...state.roomData, is_playing: true, started_at: new Date(payload.serverTime).toISOString(), audio_offset: payload.audioPosition };
      syncAudio({ ...payload, isPlaying: true });
      updatePlayState(true);
    })
    .on('broadcast', { event: 'playback:pause' }, ({ payload }) => {
      state.roomData = { ...state.roomData, is_playing: false, audio_offset: payload.audioPosition, started_at: null };
      syncAudio({ serverTime: Date.now(), audioPosition: payload.audioPosition, isPlaying: false });
      updatePlayState(false);
    })
    .on('broadcast', { event: 'playback:seek' }, ({ payload }) => {
      state.roomData = {
        ...state.roomData,
        is_playing: payload.isPlaying,
        started_at: payload.isPlaying ? new Date(payload.serverTime).toISOString() : null,
        audio_offset: payload.audioPosition,
      };
      syncAudio({ ...payload });
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
      if (track) {
        loadTrack(track, payload.isPlaying);
        if (payload.isPlaying) {
          syncAudio({ ...payload, audioPosition: payload.audioPosition || 0 });
        }
      }
      updatePlayState(payload.isPlaying);
      renderQueue();
    })
    .on('broadcast', { event: 'playback:requestSync' }, ({ payload }) => {
      if (!state.isController) return;
      realtimeChannel.send({
        type: 'broadcast',
        event: 'playback:syncResponse',
        payload: {
          targetId: payload.requesterId,
          serverTime: Date.now(),
          audioPosition: currentAudioPos(),
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
        if (track) loadTrack(track, false);
      }
      state.roomData = {
        ...state.roomData,
        is_playing: payload.isPlaying,
        started_at: payload.isPlaying ? new Date(payload.serverTime).toISOString() : null,
        audio_offset: payload.audioPosition,
      };
      syncAudio({ serverTime: payload.serverTime, audioPosition: payload.audioPosition, isPlaying: payload.isPlaying });
      updatePlayState(payload.isPlaying);
    })
    .on('broadcast', { event: 'playback:roomClosed' }, () => {
      audio.pause();
      dom.closedMessage.textContent = 'A sala foi encerrada pelo Host.';
      dom.closedOverlay.style.display = 'flex';
    });

  // Queue & room changes
  realtimeChannel
    .on('postgres_changes', {
      event: '*', schema: 'public', table: 'queue_items', filter: `room_id=eq.${ROOM_ID}`,
    }, async () => { await refreshQueue(); });

  realtimeChannel
    .on('postgres_changes', {
      event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${ROOM_ID}`,
    }, async (payload) => {
      const previousTrackIndex = state.roomData?.current_track_index ?? 0;
      state.roomData = payload.new;
      state.loop = payload.new.loop || false;
      dom.loopBtn.classList.toggle('active', state.loop);
      const isCoHost = payload.new.co_hosts?.includes(state.user.id);
      state.isController = state.isHost || isCoHost;
      setHostMode(state.isController);

      const currentTrackIndex = payload.new.current_track_index || 0;
      if (previousTrackIndex !== currentTrackIndex) {
        const track = state.queue[currentTrackIndex];
        if (track) loadTrack(track, false);
      }

      syncAudio({
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

// ═══════════════════════════════════════════════════════════════════════════════
// Data Loading
// ═══════════════════════════════════════════════════════════════════════════════

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
    const urlChanged = isCurrentTrack && track.audio_url !== state.currentTrack.audio_url;
    if (!isCurrentTrack) {
      loadTrack(track, false);
    }
    if (urlChanged) {
      loadTrack(track, state.roomData?.is_playing);
    }
    if (state.roomData?.is_playing) {
      syncAudio({
        serverTime: Date.now(),
        audioPosition: estimateRoomPosition(),
        isPlaying: true,
      });
    }
  } else if (!track) {
    state.currentTrack = null;
    audio.removeAttribute('src');
    audio.removeAttribute('data-track-id');
    audio.removeAttribute('data-track-url');
    audio.load();
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
  state.isController = state.isHost || isCoHost;

  setHostMode(state.isController);
  dom.roomCodeDisplay.textContent = ROOM_ID;

  await refreshQueue();

  const track = state.queue[room.current_track_index || 0];
  if (track) {
    // Load the track into audio element but don't play yet (user must click join)
    loadTrack(track, false);
    syncAudio({
      serverTime: Date.now(),
      audioPosition: estimateRoomPosition(room),
      isPlaying: false,
    });
    updatePlayState(room.is_playing);
  }

  state.loop = room.loop || false;
  dom.loopBtn.classList.toggle('active', state.loop);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Event Listeners
// ═══════════════════════════════════════════════════════════════════════════════

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

dom.progressBarTrack.addEventListener('click', (e) => {
  if (!state.isController) return;
  const dur = audio.duration || state.currentTrack?.duration || 0;
  if (!dur) return;
  const { left, width } = dom.progressBarTrack.getBoundingClientRect();
  hostSeek(((e.clientX - left) / width) * dur);
});

// Volume
function updateVolumeIcon(v) {
  if (v === 0) {
    dom.volumeIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`;
  } else if (v < 0.5) {
    dom.volumeIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>`;
  } else {
    dom.volumeIcon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
  }
}

let lastVol = 1;
dom.volumeSlider.addEventListener('input', () => {
  const v = parseFloat(dom.volumeSlider.value);
  audio.volume = lastVol = v;
  updateVolumeIcon(v);
});

dom.volumeIcon.addEventListener('click', () => {
  if (audio.volume > 0) {
    lastVol = audio.volume;
    audio.volume = 0;
    dom.volumeSlider.value = 0;
    updateVolumeIcon(0);
  } else {
    audio.volume = lastVol;
    dom.volumeSlider.value = lastVol;
    updateVolumeIcon(lastVol);
  }
});

// Copy
dom.copyCodeBtn.addEventListener('click', () =>
  navigator.clipboard.writeText(ROOM_ID).then(() => showToast('Código copiado!', 'success')));
dom.copyLinkBtn.addEventListener('click', () =>
  navigator.clipboard.writeText(`${location.origin}/room.html?room=${ROOM_ID}`).then(() => showToast('Link copiado!', 'success')));

// Exit Room
dom.closeRoomBtn.addEventListener('click', () => {
  window.location.href = '/';
});

// Theme Toggle
if (dom.themeToggle) {
  const sunIcon = dom.themeToggle.querySelector('.theme-icon-sun');
  const moonIcon = dom.themeToggle.querySelector('.theme-icon-moon');
  
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

  dom.themeToggle.addEventListener('click', () => {
    const isLight = document.documentElement.classList.toggle('light-theme');
    localStorage.setItem('syncbeat_theme', isLight ? 'light' : 'dark');
    updateIcons();
  });
}

// Tabs
document.querySelectorAll('.add-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.add-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.add-tab-content').forEach((c) => c.classList.remove('active'));
    tab.classList.add('active');
    $(`tab-content-${tab.dataset.tab}`).classList.add('active');
  });
});

// Search
dom.searchBtn.addEventListener('click', async () => {
  const q = dom.searchInput.value.trim();
  if (!q) return;
  await resolveAndAddTrack(q, dom.searchStatus);
  dom.searchInput.value = '';
});
dom.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') dom.searchBtn.click(); });

// URL
dom.urlAddBtn.addEventListener('click', async () => {
  const url = dom.urlInput.value.trim();
  if (!url) return;
  await resolveAndAddTrack(url, dom.urlStatus);
  dom.urlInput.value = '';
});
dom.urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') dom.urlAddBtn.click(); });

// Upload
dom.fileDropArea.addEventListener('click', () => dom.fileInput.click());
dom.fileDropArea.addEventListener('dragover', (e) => { e.preventDefault(); dom.fileDropArea.classList.add('dragover'); });
dom.fileDropArea.addEventListener('dragleave', () => dom.fileDropArea.classList.remove('dragover'));
dom.fileDropArea.addEventListener('drop', (e) => { e.preventDefault(); dom.fileDropArea.classList.remove('dragover'); handleFileUpload(e.dataTransfer.files); });
dom.fileInput.addEventListener('change', () => handleFileUpload(dom.fileInput.files));

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
    audio.pause();
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
    if (track) loadTrack(track, false);
  }

  if (state.currentTrack) {
    syncAudio({
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

function showJoinButton() {
  const card = dom.joinOverlay.querySelector('.overlay-card');
  if (!card) return;

  const isHostUser = state.roomData?.host_id === state.user.id;
  const welcomeText = isHostUser
    ? 'Tudo pronto! Você é o host — controla a fila e o playback para todos.'
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
      🎵 Entrar e Ouvir Junto
    </button>
  `;

  document.getElementById('join-room-active-btn').addEventListener('click', () => {
    audioUnlocked = true;

    // Unlock AudioContext with user gesture
    try { getOrCreateAudioCtx().resume(); } catch(e) {}

    // If there's a track playing, sync and play
    if (state.currentTrack && state.roomData) {
      syncAudio({
        serverTime: Date.now(),
        audioPosition: estimateRoomPosition(),
        isPlaying: state.roomData.is_playing,
      });
    }

    dom.joinOverlay.style.animation = 'toastOut .3s ease forwards';
    setTimeout(() => { dom.joinOverlay.style.display = 'none'; }, 300);

    requestSyncWithHost();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
  const session = await Auth.getSession();
  if (!session) {
    window.location.href = `/?room=${ROOM_ID}`;
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

  await loadRoomState();
  await subscribeToRoom();
  startPlaybackSyncLoop();
  startVisualizer();
  showJoinButton();
}

init();

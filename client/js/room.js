/**
 * room.js — Room page logic
 *
 * Uses Supabase Realtime instead of Socket.io:
 * - Broadcast: instant playback events (play/pause/seek)
 * - Postgres Changes: queue updates (always consistent with DB)
 * - Presence: who's in the room
 *
 * State source of truth:
 * - rooms table → is_playing, started_at, audio_offset, current_track_index
 * - queue_items table → the playlist
 * - Presence state → connected listeners
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

// YouTube Player variables
let ytPlayer = null;
let ytPlayerReady = false;
let ytProgressInterval = null;

// YouTube Iframe API callback
window.onYouTubeIframeAPIReady = function () {
  const initialVideoId = state.currentTrack ? getYouTubeVideoId(state.currentTrack) : 'dQw4w9WgXcQ';

  ytPlayer = new YT.Player('youtube-player', {
    host: 'https://www.youtube-nocookie.com',
    height: '200',
    width: '200',
    videoId: initialVideoId,
    playerVars: {
      playsinline: 1,
      controls: 0,
      disablekb: 1,
      fs: 0,
      rel: 0,
      showinfo: 0,
      modestbranding: 1
    },
    events: {
      onReady: () => {
        ytPlayerReady = true;
        try {
          ytPlayer.unMute();
          if (dom.volumeSlider) {
            ytPlayer.setVolume(parseFloat(dom.volumeSlider.value) * 100);
          }
        } catch (e) {}

        // Se já tivermos carregado a música atual da sala, reinicializa a sincronização
        if (state.currentTrack && (state.currentTrack.source_type === 'youtube' || state.currentTrack.source_type === 'spotify')) {
          loadTrack(state.currentTrack, state.isPlaying);
          const room = state.roomData;
          if (room) {
            const pos = room.audio_offset || 0;
            const elapsed = room.is_playing && room.started_at
              ? (Date.now() - new Date(room.started_at).getTime()) / 1000
              : 0;
            const currentPos = pos + elapsed;
            syncAudio({ serverTime: Date.now(), audioPosition: currentPos, isPlaying: room.is_playing });
          }
        }
      },
      onStateChange: (event) => {
        if (event.data === YT.PlayerState.ENDED) {
          if (!state.isHost) return;
          if (state.loop) {
            hostSeek(0);
            hostPlay();
          } else {
            hostNext();
          }
        }
      },
      onError: (err) => {
        console.error('YouTube player error:', err);
        showToast('Erro ao reproduzir vídeo do YouTube.', 'error');
      }
    }
  });
};

// Injeta dinamicamente o script da API do YouTube Iframe para evitar condições de corrida (race conditions)
(function () {
  const tag = document.createElement('script');
  tag.src = "https://www.youtube.com/iframe_api";
  const firstScriptTag = document.getElementsByTagName('script')[0];
  firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
})();

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
};

const audio = dom.audioPlayer;

// ═══════════════════════════════════════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════════════════════════════════════

function showToast(msg, type = 'info', duration = 3500) {
  const c = $('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${{success:'✅',error:'❌',info:'ℹ️'}[type]||''}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(() => { t.style.animation = 'toastOut .3s ease forwards'; setTimeout(() => t.remove(), 300); }, duration);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Audio
// ═══════════════════════════════════════════════════════════════════════════════

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function getOrCreateAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.connect(audioCtx.destination);
    sourceNode = audioCtx.createMediaElementSource(audio);
    sourceNode.connect(analyser);
  }
  return audioCtx;
}

let autoplayPromptActive = false;

function showAutoplayPrompt() {
  if (autoplayPromptActive) return;
  autoplayPromptActive = true;

  const bar = document.createElement('div');
  bar.id = 'autoplay-prompt-bar';
  bar.className = 'autoplay-prompt-bar';
  bar.innerHTML = `
    <span>🔊 O navegador bloqueou o som automático. Clique para ativar e sincronizar!</span>
    <button id="autoplay-unlock-btn">Ativar Som</button>
  `;
  document.body.appendChild(bar);

  const unlock = () => {
    getOrCreateAudioCtx().resume();

    const isYt = state.currentTrack?.source_type === 'youtube' || state.currentTrack?.source_type === 'spotify';

    if (isYt) {
      if (ytPlayerReady && ytPlayer && typeof ytPlayer.playVideo === 'function') {
        try {
          ytPlayer.unMute();
          ytPlayer.playVideo();
          bar.remove();
          autoplayPromptActive = false;
          document.removeEventListener('click', unlock);
        } catch (e) {
          console.warn('Erro ao destravar som do YouTube:', e);
        }
      }
    } else {
      audio.play().then(() => {
        bar.remove();
        autoplayPromptActive = false;
        document.removeEventListener('click', unlock);
      }).catch((err) => {
        console.warn('Erro ao destravar áudio HTML5:', err);
      });
    }
  };

  document.getElementById('autoplay-unlock-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    unlock();
  });
  document.addEventListener('click', unlock);
}

function checkYtAutoplay() {
  if (state.isPlaying && ytPlayerReady && ytPlayer) {
    try {
      const stateCode = ytPlayer.getPlayerState();
      if (stateCode !== YT.PlayerState.PLAYING) {
        showAutoplayPrompt();
      }
    } catch (e) {}
  }
}

function getYouTubeVideoId(track) {
  if (!track) return null;
  const url = track.audio_url || track.original_url;
  if (!url) return null;

  const patterns = [
    /[?&]v=([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /embed\/([A-Za-z0-9_-]{11})/,
    /shorts\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function startYtProgressInterval() {
  if (ytProgressInterval) clearInterval(ytProgressInterval);

  ytProgressInterval = setInterval(() => {
    if (ytPlayerReady && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
      try {
        const stateCode = ytPlayer.getPlayerState();
        if (stateCode === YT.PlayerState.PLAYING) {
          const cur = ytPlayer.getCurrentTime();
          const dur = ytPlayer.getDuration() || state.currentTrack?.duration || 0;
          dom.currentTime.textContent = formatTime(cur);
          dom.totalTime.textContent = formatTime(dur);
          if (dur > 0) dom.progressBar.style.width = `${(cur / dur) * 100}%`;
        }
      } catch (e) {
        // Ignora erros temporários se o player estiver recarregando
      }
    }
  }, 250);
}

function syncAudio({ serverTime, audioPosition, isPlaying }) {
  if (!state.currentTrack) return;
  const isYt = state.currentTrack.source_type === 'youtube' || state.currentTrack.source_type === 'spotify';

  let pos = audioPosition;
  if (isPlaying && serverTime) pos += (Date.now() - serverTime) / 1000;

  if (isYt) {
    if (ytPlayerReady && ytPlayer && typeof ytPlayer.getPlayerState === 'function') {
      try {
        const currentPos = ytPlayer.getCurrentTime();
        if (Math.abs(currentPos - pos) > 0.8) {
          ytPlayer.seekTo(pos, true);
        }
        if (isPlaying) {
          const stateCode = ytPlayer.getPlayerState();
          if (stateCode !== YT.PlayerState.PLAYING) {
            ytPlayer.unMute();
            ytPlayer.playVideo();
            setTimeout(checkYtAutoplay, 1500);
          }
          startYtProgressInterval();
        } else {
          ytPlayer.pauseVideo();
          if (ytProgressInterval) {
            clearInterval(ytProgressInterval);
            ytProgressInterval = null;
          }
        }
      } catch (e) {
        console.warn('Erro ao sincronizar YouTube:', e);
      }
    }
  } else {
    if (Math.abs(audio.currentTime - pos) > 0.5) audio.currentTime = Math.max(0, pos);
    if (isPlaying) {
      getOrCreateAudioCtx().resume();
      audio.play().catch((err) => {
        if (err.name === 'NotAllowedError') {
          showAutoplayPrompt();
        }
      });
    } else {
      audio.pause();
    }
  }
}

function loadTrack(track, autoPlay = false) {
  if (!track) return;
  state.currentTrack = track;

  if (ytProgressInterval) {
    clearInterval(ytProgressInterval);
    ytProgressInterval = null;
  }

  const isYt = track.source_type === 'youtube' || track.source_type === 'spotify';

  if (isYt) {
    audio.pause();
    audio.src = '';

    const videoId = getYouTubeVideoId(track);
    if (videoId && ytPlayerReady && ytPlayer && typeof ytPlayer.cueVideoById === 'function') {
      try {
        ytPlayer.cueVideoById({ videoId });
        if (autoPlay) {
          ytPlayer.unMute();
          ytPlayer.playVideo();
          startYtProgressInterval();
          setTimeout(checkYtAutoplay, 1500);
        }
      } catch (e) {
        console.warn('Erro ao cueVideo no YouTube:', e);
      }
    }
  } else {
    if (ytPlayerReady && ytPlayer && typeof ytPlayer.stopVideo === 'function') {
      try {
        ytPlayer.stopVideo();
      } catch (e) {}
    }
    audio.src = track.audio_url;
    audio.load();
    if (autoPlay) {
      getOrCreateAudioCtx().resume();
      audio.play().catch((err) => {
        if (err.name === 'NotAllowedError') {
          showAutoplayPrompt();
        }
      });
    }
  }

  updateNowPlayingUI(track);
}

audio.addEventListener('timeupdate', () => {
  const isYt = state.currentTrack?.source_type === 'youtube' || state.currentTrack?.source_type === 'spotify';
  if (isYt) return; // O YouTube gerencia o próprio tempo

  const cur = audio.currentTime, dur = audio.duration || state.currentTrack?.duration || 0;
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

audio.addEventListener('error', () => {
  const isYt = state.currentTrack?.source_type === 'youtube' || state.currentTrack?.source_type === 'spotify';
  if (isYt) return; // Ignora erros do HTML5 audio se for faixa do YouTube
  showToast('Erro ao carregar áudio. Tente outra fonte.', 'error');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Visualizer
// ═══════════════════════════════════════════════════════════════════════════════

let mockAngles = Array.from({ length: 64 }, (_, i) => i * 0.1);

function startVisualizer() {
  const canvas = dom.visualizer;
  const ctx = canvas.getContext('2d');
  const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
  resize();
  new ResizeObserver(resize).observe(canvas);

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const isYt = state.currentTrack?.source_type === 'youtube' || state.currentTrack?.source_type === 'spotify';

    if (isYt) {
      const numBars = 32;
      const bw = (canvas.width / numBars) * 2.2;
      let x = 0;

      let volume = 1;
      let isPlaying = state.isPlaying;

      if (ytPlayerReady && ytPlayer && typeof ytPlayer.getVolume === 'function') {
        try {
          volume = ytPlayer.getVolume() / 100;
          isPlaying = ytPlayer.getPlayerState() === YT.PlayerState.PLAYING;
        } catch (e) {}
      }

      const speed = isPlaying && volume > 0 ? 0.05 : 0;

      for (let i = 0; i < numBars; i++) {
        mockAngles[i] = (mockAngles[i] || 0) + speed;
        let factor = 0;
        if (isPlaying && volume > 0) {
          factor = Math.sin(mockAngles[i]) * 0.4 + Math.sin(mockAngles[i] * 2.3) * 0.3 + Math.cos(mockAngles[i] * 0.7) * 0.3;
          factor = Math.max(0.05, Math.abs(factor));
        } else if (isPlaying) {
          factor = 0.02; // ondas mínimas se mutado
        }

        const h = factor * canvas.height * 0.85 * volume;

        const g = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - h);
        g.addColorStop(0, 'rgba(255, 255, 255, 0.4)');
        g.addColorStop(1, 'rgba(255, 255, 255, 0.02)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.roundRect(x, canvas.height - h, bw - 2, h, 2);
        ctx.fill();
        x += bw;
      }
    } else {
      if (!analyser) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
      const buf = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(buf);

      const bw = (canvas.width / buf.length) * 2.2;
      let x = 0;
      for (let i = 0; i < buf.length; i++) {
        const h = (buf[i] / 255) * canvas.height;
        const g = ctx.createLinearGradient(0, canvas.height, 0, canvas.height - h);
        g.addColorStop(0, 'rgba(255, 255, 255, 0.5)');
        g.addColorStop(1, 'rgba(255, 255, 255, 0.05)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.roundRect(x, canvas.height - h, bw - 2, h, 2);
        ctx.fill();
        x += bw;
      }
    }
  }
  draw();
}

// ═══════════════════════════════════════════════════════════════════════════════
// UI
// ═══════════════════════════════════════════════════════════════════════════════

const SOURCE_BADGES = {
  youtube: '<span class="badge badge-youtube">▶ YouTube</span>',
  spotify: '<span class="badge badge-spotify">● Spotify</span>',
  upload:  '<span class="badge badge-upload">📁 Upload</span>',
  url:     '<span class="badge badge-url">🔗 URL</span>',
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
  dom.sourceBadgeArea.innerHTML = SOURCE_BADGES[track.source_type] || '';
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
    dom.playBtn.innerHTML = `<svg id="play-icon-svg" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/></svg>`;
  } else {
    dom.playBtn.innerHTML = `<svg id="play-icon-svg" xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>`;
  }
  dom.playingIndicator.classList.toggle('paused', !isPlaying);
}

function setHostMode(isController) {
  state.isController = isController;
  dom.addMusicPanel.style.display = isController ? '' : 'none';
  dom.listenerOnlyBar.style.display = isController ? 'none' : '';

  if (state.isHost) {
    dom.hostBadge.textContent = '👑 Host';
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
    dom.queueList.innerHTML = '<div class="queue-empty">A fila está vazia.</div>';
    return;
  }

  dom.queueList.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'queue-list';

  queue.forEach((track, i) => {
    const isActive = i === idx;
    const sourceEmoji = { youtube:'▶', spotify:'●', upload:'📁', url:'🔗' }[track.source_type] || '🎵';
    const item = document.createElement('div');
    item.className = `queue-item${isActive ? ' active' : ''}`;
    item.innerHTML = `
      <span class="queue-num">${i + 1}</span>
      <span class="queue-playing-icon" style="color:var(--accent-light)">♪</span>
      <div class="queue-thumb">
        ${track.thumbnail ? `<img src="${track.thumbnail}" alt="${track.name}" />` : sourceEmoji}
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

  // Deduplica ouvintes pelo user_id para evitar duplicação no F5
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
    if (isMainHost) {
      tag = '<span class="listener-host-tag">Host</span>';
    } else if (isCoHost) {
      tag = '<span class="listener-cohost-tag">Co-Host</span>';
    }

    // Botão de ação para promover/rebaixar (apenas visível para o host principal)
    let actionBtn = '';
    if (isCurrentUserHost && !isMainHost) {
      if (isCoHost) {
        actionBtn = `<button class="btn-demote" data-user-id="${l.user_id}" title="Remover Co-Host">➖</button>`;
      } else {
        actionBtn = `<button class="btn-promote" data-user-id="${l.user_id}" title="Tornar Co-Host">➕</button>`;
      }
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

  // Vincula eventos nos botões de promoção/rebaixamento
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

  const newCoHosts = [...currentCoHosts, userId];
  const { error } = await sb.from('rooms')
    .update({ co_hosts: newCoHosts })
    .eq('id', ROOM_ID);

  if (error) {
    showToast('Erro ao promover: ' + error.message, 'error');
  } else {
    showToast('Usuário promovido a Co-Host!', 'success');
  }
}

async function demoteFromCoHost(userId) {
  if (!state.isHost) return;
  const currentCoHosts = state.roomData?.co_hosts || [];
  const newCoHosts = currentCoHosts.filter(id => id !== userId);

  const { error } = await sb.from('rooms')
    .update({ co_hosts: newCoHosts })
    .eq('id', ROOM_ID);

  if (error) {
    showToast('Erro ao remover promoção: ' + error.message, 'error');
  } else {
    showToast('Co-Host rebaixado a ouvinte.', 'success');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Host Actions (DB + Broadcast)
// ═══════════════════════════════════════════════════════════════════════════════

function currentAudioPos() {
  const rd = state.roomData;
  if (!rd) return 0;

  if (state.isController && state.currentTrack) {
    const isYt = state.currentTrack.source_type === 'youtube' || state.currentTrack.source_type === 'spotify';
    if (isYt && ytPlayerReady && ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
      try {
        return ytPlayer.getCurrentTime();
      } catch (e) {}
    } else if (!isYt && audio) {
      return audio.currentTime;
    }
  }

  if (!rd.is_playing || !rd.started_at) return rd.audio_offset || 0;
  return (rd.audio_offset || 0) + (Date.now() - new Date(rd.started_at).getTime()) / 1000;
}

async function hostPlay() {
  const pos = currentAudioPos();
  const now = new Date().toISOString();
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
    payload: { serverTime: Date.now(), audioPosition: pos },
  });
  updatePlayState(true);
  syncAudio({ serverTime: Date.now(), audioPosition: pos, isPlaying: true });
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

  const isYt = state.currentTrack?.source_type === 'youtube' || state.currentTrack?.source_type === 'spotify';
  if (isYt) {
    if (ytPlayerReady && ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
      try {
        ytPlayer.pauseVideo();
      } catch (e) {}
    }
    if (ytProgressInterval) {
      clearInterval(ytProgressInterval);
      ytProgressInterval = null;
    }
  } else {
    audio.pause();
  }
  updatePlayState(false);
}

async function hostSeek(position) {
  const now = state.roomData?.is_playing ? new Date().toISOString() : null;
  const { error } = await sb.from('rooms').update({
    audio_offset: position,
    started_at: now,
  }).eq('id', ROOM_ID);
  if (error) return;

  state.roomData = { ...state.roomData, audio_offset: position, started_at: now };

  realtimeChannel.send({
    type: 'broadcast',
    event: 'playback:seek',
    payload: { serverTime: Date.now(), audioPosition: position, isPlaying: state.roomData.is_playing },
  });
  syncAudio({ serverTime: Date.now(), audioPosition: position, isPlaying: state.roomData.is_playing });
}

async function hostNext() {
  if (!state.queue.length) return;
  const nextIdx = (state.roomData.current_track_index + 1) % state.queue.length;
  const { error } = await sb.from('rooms').update({
    current_track_index: nextIdx,
    audio_offset: 0,
    started_at: state.roomData.is_playing ? new Date().toISOString() : null,
  }).eq('id', ROOM_ID);
  if (error) return;

  state.roomData = { ...state.roomData, current_track_index: nextIdx, audio_offset: 0 };
  const track = state.queue[nextIdx];
  loadTrack(track, state.roomData.is_playing);

  realtimeChannel.send({
    type: 'broadcast',
    event: 'playback:trackChange',
    payload: { serverTime: Date.now(), trackIndex: nextIdx, isPlaying: state.roomData.is_playing },
  });
  renderQueue();
}

async function hostPrev() {
  if (!state.queue.length) return;
  const prevIdx = (state.roomData.current_track_index - 1 + state.queue.length) % state.queue.length;
  const { error } = await sb.from('rooms').update({
    current_track_index: prevIdx,
    audio_offset: 0,
    started_at: state.roomData.is_playing ? new Date().toISOString() : null,
  }).eq('id', ROOM_ID);
  if (error) return;

  state.roomData = { ...state.roomData, current_track_index: prevIdx, audio_offset: 0 };
  const track = state.queue[prevIdx];
  loadTrack(track, state.roomData.is_playing);

  realtimeChannel.send({
    type: 'broadcast',
    event: 'playback:trackChange',
    payload: { serverTime: Date.now(), trackIndex: prevIdx, isPlaying: state.roomData.is_playing },
  });
  renderQueue();
}

async function removeTrack(trackId) {
  await sb.from('queue_items').delete().eq('id', trackId);
  // Queue re-fetched via Postgres Changes subscription
}

// ═══════════════════════════════════════════════════════════════════════════════
// Add Music
// ═══════════════════════════════════════════════════════════════════════════════

async function resolveAndAddTrack(input, statusEl) {
  if (!input.trim()) return;
  statusEl.innerHTML = '<span class="loader"></span> Resolvendo...';

  try {
    const { data, error } = await sb.functions.invoke('resolve-audio', {
      body: { input },
    });

    if (error || !data?.ok) throw new Error(data?.error || error?.message || 'Erro desconhecido');

    const track = data.track;
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

    // Auto-play first track
    if (state.queue.length === 0 && !state.isPlaying) {
      setTimeout(hostPlay, 500);
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

  // ── Presence (listener list) ────────────────────────────────────────────────
  realtimeChannel
    .on('presence', { event: 'sync' }, () => {
      renderListeners(realtimeChannel.presenceState());
    })
    .on('presence', { event: 'join' }, ({ newPresences }) => {
      renderListeners(realtimeChannel.presenceState());
    })
    .on('presence', { event: 'leave' }, ({ leftPresences }) => {
      // If host left, show closed overlay
      const hostLeft = leftPresences.some((p) => p.is_host && p.user_id !== state.user.id);
      if (hostLeft && !state.isHost) {
        audio.pause();
        dom.closedMessage.textContent = 'O host saiu. A sala foi encerrada.';
        dom.closedOverlay.style.display = 'flex';
      }
      renderListeners(realtimeChannel.presenceState());
    });

  // ── Playback broadcasts ─────────────────────────────────────────────────────
  realtimeChannel
    .on('broadcast', { event: 'playback:play' }, ({ payload }) => {
      state.roomData = { ...state.roomData, is_playing: true, started_at: new Date(payload.serverTime).toISOString(), audio_offset: payload.audioPosition };
      syncAudio({ ...payload, isPlaying: true });
      updatePlayState(true);
    })
    .on('broadcast', { event: 'playback:pause' }, ({ payload }) => {
      state.roomData = { ...state.roomData, is_playing: false, audio_offset: payload.audioPosition, started_at: null };

      const isYt = state.currentTrack?.source_type === 'youtube' || state.currentTrack?.source_type === 'spotify';
      if (isYt) {
        if (ytPlayerReady && ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
          try {
            ytPlayer.pauseVideo();
          } catch (e) {}
        }
        if (ytProgressInterval) {
          clearInterval(ytProgressInterval);
          ytProgressInterval = null;
        }
      } else {
        audio.currentTime = payload.audioPosition;
        audio.pause();
      }
      updatePlayState(false);
    })
    .on('broadcast', { event: 'playback:seek' }, ({ payload }) => {
      state.roomData = { ...state.roomData, audio_offset: payload.audioPosition };
      syncAudio({ ...payload });
      updatePlayState(payload.isPlaying);
    })
    .on('broadcast', { event: 'playback:trackChange' }, ({ payload }) => {
      state.roomData = { ...state.roomData, current_track_index: payload.trackIndex, audio_offset: 0 };
      const track = state.queue[payload.trackIndex];
      if (track) { loadTrack(track, payload.isPlaying); syncAudio({ ...payload, audioPosition: 0 }); }
      updatePlayState(payload.isPlaying);
      renderQueue();
    })
    .on('broadcast', { event: 'playback:requestSync' }, ({ payload }) => {
      if (!state.isHost) return;
      const currentPos = currentAudioPos();
      realtimeChannel.send({
        type: 'broadcast',
        event: 'playback:syncResponse',
        payload: {
          targetId: payload.requesterId,
          serverTime: Date.now(),
          audioPosition: currentPos,
          isPlaying: state.isPlaying,
          trackIndex: state.roomData?.current_track_index || 0
        }
      });
    })
    .on('broadcast', { event: 'playback:syncResponse' }, ({ payload }) => {
      if (payload.targetId !== state.user.id) return;
      if (state.roomData && state.roomData.current_track_index !== payload.trackIndex) {
        state.roomData.current_track_index = payload.trackIndex;
        const track = state.queue[payload.trackIndex];
        if (track) loadTrack(track, payload.isPlaying);
      }
      syncAudio({
        serverTime: payload.serverTime,
        audioPosition: payload.audioPosition,
        isPlaying: payload.isPlaying
      });
      updatePlayState(payload.isPlaying);
    })
    .on('broadcast', { event: 'playback:roomClosed' }, () => {
      audio.pause();
      if (ytPlayerReady && ytPlayer && typeof ytPlayer.stopVideo === 'function') {
        try {
          ytPlayer.stopVideo();
        } catch (e) {}
      }
      dom.closedMessage.textContent = 'A sala foi encerrada pelo Host.';
      dom.closedOverlay.style.display = 'flex';
    });

  // ── Queue changes from DB ───────────────────────────────────────────────────
  realtimeChannel
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'queue_items',
      filter: `room_id=eq.${ROOM_ID}`,
    }, async () => {
      await refreshQueue();
    });

  // ── Room changes from DB (co-hosts, etc) ────────────────────────────────────
  realtimeChannel
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'rooms',
      filter: `id=eq.${ROOM_ID}`,
    }, async (payload) => {
      state.roomData = payload.new;
      state.loop = payload.new.loop || false;
      dom.loopBtn.classList.toggle('active', state.loop);

      const isCoHost = payload.new.co_hosts?.includes(state.user.id);
      state.isController = state.isHost || isCoHost;
      setHostMode(state.isController);
      renderQueue();
      renderListeners(realtimeChannel.presenceState());
    });

  // ── Subscribe ───────────────────────────────────────────────────────────────
  await realtimeChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      dom.connectionBadge.textContent = '● Conectado';
      dom.connectionBadge.className = 'badge badge-green';

      // Track presence
      await realtimeChannel.track({
        user_id: state.user.id,
        display_name: state.profile?.display_name || state.user.email,
        avatar_url: state.profile?.avatar_url || null,
        is_host: state.isHost,
      });
    } else if (status === 'CHANNEL_ERROR') {
      dom.connectionBadge.textContent = '○ Erro';
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

  // Reload track if current changed
  const track = state.queue[state.roomData?.current_track_index || 0];
  if (track && track.id !== state.currentTrack?.id) {
    updateNowPlayingUI(track);
    // Don't auto-play just from queue refresh
  } else if (!track) {
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

  // Determine host/listener UI
  setHostMode(state.isController);
  dom.roomCodeDisplay.textContent = ROOM_ID;

  // Load queue
  await refreshQueue();

  // Load current track and sync audio
  const track = state.queue[room.current_track_index || 0];
  if (track) {
    loadTrack(track, false);
    state.currentTrack = track;

    // Sync position
    const pos = room.audio_offset || 0;
    const elapsed = room.is_playing && room.started_at
      ? (Date.now() - new Date(room.started_at).getTime()) / 1000
      : 0;
    const currentPos = pos + elapsed;

    syncAudio({ serverTime: Date.now(), audioPosition: currentPos, isPlaying: room.is_playing });
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
  const dur = state.currentTrack?.duration || audio.duration || 0;
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
  if (ytPlayerReady && ytPlayer && typeof ytPlayer.setVolume === 'function') {
    try {
      ytPlayer.setVolume(v * 100);
    } catch (e) {}
  }
  updateVolumeIcon(v);
});

dom.volumeIcon.addEventListener('click', () => {
  const isCurrentlyMuted = audio.volume === 0 || (ytPlayerReady && ytPlayer && typeof ytPlayer.getVolume === 'function' && ytPlayer.getVolume() === 0);

  if (!isCurrentlyMuted) {
    lastVol = audio.volume || (ytPlayerReady && ytPlayer && typeof ytPlayer.getVolume === 'function' ? ytPlayer.getVolume() / 100 : 1) || 1;
    audio.volume = 0;
    if (ytPlayerReady && ytPlayer && typeof ytPlayer.setVolume === 'function') {
      try {
        ytPlayer.setVolume(0);
      } catch (e) {}
    }
    dom.volumeSlider.value = 0;
    updateVolumeIcon(0);
  } else {
    audio.volume = lastVol;
    if (ytPlayerReady && ytPlayer && typeof ytPlayer.setVolume === 'function') {
      try {
        ytPlayer.setVolume(lastVol * 100);
      } catch (e) {}
    }
    dom.volumeSlider.value = lastVol;
    updateVolumeIcon(lastVol);
  }
});

// Copy
dom.copyCodeBtn.addEventListener('click', () => navigator.clipboard.writeText(ROOM_ID).then(() => showToast('Código copiado!', 'success')));
dom.copyLinkBtn.addEventListener('click', () => navigator.clipboard.writeText(`${location.origin}/room.html?room=${ROOM_ID}`).then(() => showToast('Link copiado!', 'success')));

// Close Room
dom.closeRoomBtn.addEventListener('click', async () => {
  if (!confirm('Deseja realmente fechar esta sala? Todos os ouvintes serão desconectados.')) return;

  if (realtimeChannel) {
    try {
      realtimeChannel.send({
        type: 'broadcast',
        event: 'playback:roomClosed',
        payload: {}
      });
    } catch (e) {}
  }

  const { error } = await sb.from('rooms').delete().eq('id', ROOM_ID);
  if (error) {
    showToast('Erro ao fechar sala: ' + error.message, 'error');
  } else {
    window.location.href = '/';
  }
});

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
      payload: { requesterId: state.user.id }
    });
  }
}

function showJoinButton() {
  const card = dom.joinOverlay.querySelector('.overlay-card');
  if (!card) return;

  const isHostUser = state.roomData?.host_id === state.user.id;
  const welcomeText = isHostUser
    ? 'Tudo pronto! Você é o host e controla a reprodução.'
    : 'A sala está pronta! Clique abaixo para se conectar e ouvir junto com o host.';

  card.innerHTML = `
    <div style="font-size:2.5rem;margin-bottom:16px;">🎵</div>
    <h2 style="margin-bottom:8px;">SyncBeat</h2>
    <p style="margin:12px 0 24px;color:var(--text-secondary);font-size:0.95rem;">${welcomeText}</p>
    <button id="join-room-active-btn" class="btn btn-primary" style="width:100%;padding:14px;font-size:1rem;font-weight:700;">
      Entrar e Ouvir Junto
    </button>
  `;

  document.getElementById('join-room-active-btn').addEventListener('click', () => {
    // Destrava o áudio do contexto HTML5
    try {
      getOrCreateAudioCtx().resume();
    } catch(e) {}

    // Destrava e ativa o YouTube player se aplicável
    const isYt = state.currentTrack?.source_type === 'youtube' || state.currentTrack?.source_type === 'spotify';
    if (isYt && ytPlayerReady && ytPlayer && typeof ytPlayer.playVideo === 'function') {
      try {
        ytPlayer.unMute();
      } catch(e) {}
    }

    // Efeito suave de saída no overlay
    dom.joinOverlay.style.animation = 'toastOut .3s ease forwards';
    setTimeout(() => {
      dom.joinOverlay.style.display = 'none';
    }, 300);

    // Solicita sincronia de tempo imediata com o host
    requestSyncWithHost();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Bootstrap
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
  const session = await Auth.getSession();
  if (!session) {
    // Redirect to login, preserving room code
    window.location.href = `/?room=${ROOM_ID}`;
    return;
  }

  state.user = session.user;
  state.profile = await Auth.getProfile();

  // Update header avatar
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

  // Carrega os dados da sala e assina canais em segundo plano
  await loadRoomState();
  await subscribeToRoom();
  startVisualizer();

  // Exibe o botão de confirmação de entrada para destravar o autoplay no clique do usuário
  showJoinButton();
}

init();

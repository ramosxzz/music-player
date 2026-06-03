require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const RoomManager = require('./roomManager');
const { resolveSource, resolveUpload, resolveStreamUrl, initSpotify, checkYtDlp } = require('./sourceHandler');

// ─── Setup ───────────────────────────────────────────────────────────────────

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const CLIENT_DIR = path.join(__dirname, '../client');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.static(CLIENT_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── File Upload Config ───────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: (req, file, cb) => {
    const allowed = /mp3|wav|ogg|flac|m4a|aac|opus|webm/;
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    if (allowed.test(ext)) cb(null, true);
    else cb(new Error('Only audio files are allowed'));
  },
});

// ─── Room Manager ─────────────────────────────────────────────────────────────

const roomManager = new RoomManager();

// ─── REST Routes ──────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Upload audio file
app.post('/api/upload', upload.single('audio'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const serverPath = `/uploads/${req.file.filename}`;
  const track = resolveUpload(req.file.originalname, serverPath);

  res.json({ ok: true, track });
});

// Resolve a URL or search query (YouTube / Spotify / direct)
app.post('/api/resolve', async (req, res) => {
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: 'input is required' });

  try {
    const track = await resolveSource(input);
    res.json({ ok: true, track });
  } catch (err) {
    console.error('[resolve] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate a fresh direct audio URL at playback time.
app.get('/api/stream', async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    const directUrl = await resolveStreamUrl(url);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, directUrl);
  } catch (err) {
    console.error('[stream] Error:', err.message);
    res.status(500).json({
      error: 'Could not create a fresh audio stream. Check yt-dlp installation and try again.',
      details: err.message,
    });
  }
});

// Serve room page
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'room.html'));
});

// Serve index for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(CLIENT_DIR, 'index.html'));
});

// ─── Socket.io Events ─────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // ── Create Room ────────────────────────────────────────────────────────────
  socket.on('room:create', ({ userName }) => {
    const room = roomManager.createRoom(socket.id, userName);
    socket.join(room.roomId);
    socket.emit('room:created', { roomId: room.roomId });
    socket.emit('room:state', roomManager.getRoomSnapshot(room.roomId));
    console.log(`[Room] Created: ${room.roomId} by ${userName}`);
  });

  // ── Join Room ──────────────────────────────────────────────────────────────
  socket.on('room:join', ({ roomId, userName }) => {
    const roomIdUpper = roomId.toUpperCase();
    const room = roomManager.joinRoom(roomIdUpper, socket.id, userName);

    if (!room) {
      socket.emit('room:error', { message: `Sala "${roomId}" não encontrada.` });
      return;
    }

    socket.join(roomIdUpper);

    // Send current state to the newcomer
    const snapshot = roomManager.getRoomSnapshot(roomIdUpper);
    socket.emit('room:state', snapshot);

    // Notify everyone about the updated listener list
    io.to(roomIdUpper).emit('room:listeners', snapshot.listeners);

    console.log(`[Room] ${userName} joined ${roomIdUpper}`);
  });

  // ── Host: Add Track ────────────────────────────────────────────────────────
  socket.on('host:addTrack', ({ roomId, track }) => {
    if (!roomManager.isHost(roomId, socket.id)) {
      socket.emit('room:error', { message: 'Apenas o host pode adicionar músicas.' });
      return;
    }

    const result = roomManager.addTrack(roomId, track);
    if (!result) return;

    io.to(roomId).emit('queue:updated', {
      queue: result.room.queue,
      currentTrackIndex: result.room.currentTrackIndex,
    });

    // Auto-play if this is the first track and nothing is playing
    if (result.room.queue.length === 1 && !result.room.isPlaying) {
      const updatedRoom = roomManager.setPlay(roomId, 0);
      if (updatedRoom) {
        io.to(roomId).emit('playback:play', {
          serverTime: Date.now(),
          audioPosition: 0,
          track: roomManager.getCurrentTrack(roomId),
        });
      }
    }
  });

  // ── Host: Remove Track ─────────────────────────────────────────────────────
  socket.on('host:removeTrack', ({ roomId, trackId }) => {
    if (!roomManager.isHost(roomId, socket.id)) return;

    const room = roomManager.removeTrack(roomId, trackId);
    if (!room) return;

    io.to(roomId).emit('queue:updated', {
      queue: room.queue,
      currentTrackIndex: room.currentTrackIndex,
    });
  });

  // ── Host: Play ─────────────────────────────────────────────────────────────
  socket.on('host:play', ({ roomId }) => {
    if (!roomManager.isHost(roomId, socket.id)) return;

    const currentPos = roomManager.getCurrentPosition(roomId);
    const room = roomManager.setPlay(roomId, currentPos);
    if (!room) return;

    io.to(roomId).emit('playback:play', {
      serverTime: Date.now(),
      audioPosition: currentPos,
      track: roomManager.getCurrentTrack(roomId),
    });
  });

  // ── Host: Pause ────────────────────────────────────────────────────────────
  socket.on('host:pause', ({ roomId }) => {
    if (!roomManager.isHost(roomId, socket.id)) return;

    const room = roomManager.setPause(roomId);
    if (!room) return;

    io.to(roomId).emit('playback:pause', {
      audioPosition: room.audioOffset,
    });
  });

  // ── Host: Seek ─────────────────────────────────────────────────────────────
  socket.on('host:seek', ({ roomId, position }) => {
    if (!roomManager.isHost(roomId, socket.id)) return;

    const room = roomManager.seek(roomId, position);
    if (!room) return;

    io.to(roomId).emit('playback:seek', {
      serverTime: Date.now(),
      audioPosition: position,
      isPlaying: room.isPlaying,
    });
  });

  // ── Host: Next Track ───────────────────────────────────────────────────────
  socket.on('host:next', ({ roomId }) => {
    if (!roomManager.isHost(roomId, socket.id)) return;

    const room = roomManager.nextTrack(roomId);
    if (!room) return;

    const track = roomManager.getCurrentTrack(roomId);
    io.to(roomId).emit('playback:trackChange', {
      serverTime: Date.now(),
      audioPosition: 0,
      isPlaying: room.isPlaying,
      track,
      currentTrackIndex: room.currentTrackIndex,
    });
  });

  // ── Host: Previous Track ───────────────────────────────────────────────────
  socket.on('host:prev', ({ roomId }) => {
    if (!roomManager.isHost(roomId, socket.id)) return;

    const room = roomManager.prevTrack(roomId);
    if (!room) return;

    const track = roomManager.getCurrentTrack(roomId);
    io.to(roomId).emit('playback:trackChange', {
      serverTime: Date.now(),
      audioPosition: 0,
      isPlaying: room.isPlaying,
      track,
      currentTrackIndex: room.currentTrackIndex,
    });
  });

  // ── Host: Toggle Loop ──────────────────────────────────────────────────────
  socket.on('host:toggleLoop', ({ roomId }) => {
    if (!roomManager.isHost(roomId, socket.id)) return;

    const room = roomManager.getRoom(roomId);
    if (!room) return;

    room.loop = !room.loop;
    io.to(roomId).emit('playback:loop', { loop: room.loop });
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const affected = roomManager.removeListener(socket.id);

    for (const { roomId, closed, room } of affected) {
      if (closed) {
        io.to(roomId).emit('room:closed', { message: 'O host saiu. A sala foi encerrada.' });
        io.socketsLeave(roomId);
        console.log(`[Room] Closed: ${roomId} (host left)`);
      } else {
        io.to(roomId).emit('room:listeners', room.listeners);
      }
    }

    console.log(`[Socket] Disconnected: ${socket.id}`);
  });
});

// ── Heartbeat: Sync all Socket.io clients ────────────────────────────────────
// One process-wide interval. Creating it per connection causes duplicated work.
setInterval(() => {
  for (const [roomId] of roomManager.rooms) {
    const room = roomManager.getRoom(roomId);
    if (!room || !room.isPlaying) continue;

    io.to(roomId).emit('playback:sync', {
      serverTime: Date.now(),
      audioPosition: roomManager.getCurrentPosition(roomId),
      isPlaying: room.isPlaying,
    });
  }
}, 10_000);

// ─── Start Server ─────────────────────────────────────────────────────────────

async function main() {
  // Initialize Spotify if credentials are provided
  initSpotify(process.env.SPOTIFY_CLIENT_ID, process.env.SPOTIFY_CLIENT_SECRET);

  // Check yt-dlp availability
  const ytDlpAvailable = await checkYtDlp();
  if (!ytDlpAvailable) {
    console.warn('⚠️  yt-dlp not found. YouTube and Spotify URL support will be unavailable.');
    console.warn('   Install it with: sudo pip install yt-dlp');
  } else {
    console.log('✅ yt-dlp found. YouTube support enabled.');
  }

  server.listen(PORT, () => {
    console.log(`\n🎵 Music Player Server running at http://localhost:${PORT}`);
    console.log(`   Open your browser and go to http://localhost:${PORT}\n`);
  });
}

main().catch(console.error);

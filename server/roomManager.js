const { v4: uuidv4 } = require('uuid');

/**
 * RoomManager — manages all active music rooms in memory.
 *
 * Room state shape:
 * {
 *   roomId: string,
 *   hostId: string,        // socket.id of the host
 *   hostName: string,
 *   isPlaying: boolean,
 *   startedAt: number,     // server Date.now() when play was last triggered
 *   audioOffset: number,   // audio position (seconds) when play was triggered
 *   queue: [ { id, name, url, duration } ],
 *   currentTrackIndex: number,
 *   listeners: [ { id, name, joinedAt } ]
 * }
 */

class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  /**
   * Create a new room and add the host as first listener.
   */
  createRoom(hostId, hostName) {
    const roomId = this._generateRoomCode();
    const room = {
      roomId,
      hostId,
      hostName,
      isPlaying: false,
      startedAt: null,
      audioOffset: 0,
      queue: [],
      currentTrackIndex: 0,
      listeners: [{ id: hostId, name: hostName, isHost: true, joinedAt: Date.now() }],
    };
    this.rooms.set(roomId, room);
    return room;
  }

  /**
   * Add a listener to an existing room.
   * Returns the room state or null if room not found.
   */
  joinRoom(roomId, socketId, userName) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    // Remove duplicate connections from same user
    room.listeners = room.listeners.filter(l => l.id !== socketId);
    room.listeners.push({ id: socketId, name: userName, isHost: false, joinedAt: Date.now() });

    return room;
  }

  /**
   * Remove a listener from all rooms they were in.
   * Returns list of affected roomIds.
   */
  removeListener(socketId) {
    const affectedRooms = [];

    for (const [roomId, room] of this.rooms.entries()) {
      const wasInRoom = room.listeners.some(l => l.id === socketId);
      if (!wasInRoom) continue;

      room.listeners = room.listeners.filter(l => l.id !== socketId);

      // If host left, close the room
      if (room.hostId === socketId) {
        this.rooms.delete(roomId);
        affectedRooms.push({ roomId, closed: true });
      } else {
        affectedRooms.push({ roomId, closed: false, room });
      }
    }

    return affectedRooms;
  }

  /**
   * Add a track to the queue.
   */
  addTrack(roomId, track) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const trackWithId = { ...track, id: uuidv4() };
    room.queue.push(trackWithId);
    return { room, track: trackWithId };
  }

  /**
   * Remove a track from the queue by id.
   */
  removeTrack(roomId, trackId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const idx = room.queue.findIndex(t => t.id === trackId);
    if (idx === -1) return null;

    room.queue.splice(idx, 1);

    // Adjust currentTrackIndex if needed
    if (room.currentTrackIndex >= room.queue.length) {
      room.currentTrackIndex = Math.max(0, room.queue.length - 1);
    }

    return room;
  }

  /**
   * Set play state.
   */
  setPlay(roomId, audioOffset) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.isPlaying = true;
    room.startedAt = Date.now();
    room.audioOffset = audioOffset;
    return room;
  }

  /**
   * Set pause state.
   */
  setPause(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.isPlaying = false;
    room.audioOffset = this.getCurrentPosition(roomId);
    room.startedAt = null;
    return room;
  }

  /**
   * Seek to a specific audio position.
   */
  seek(roomId, position) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.audioOffset = position;
    if (room.isPlaying) {
      room.startedAt = Date.now();
    }
    return room;
  }

  /**
   * Skip to the next track.
   */
  nextTrack(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    if (room.queue.length === 0) return null;

    room.currentTrackIndex = (room.currentTrackIndex + 1) % room.queue.length;
    room.audioOffset = 0;
    room.startedAt = room.isPlaying ? Date.now() : null;
    return room;
  }

  /**
   * Skip to the previous track.
   */
  prevTrack(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    if (room.queue.length === 0) return null;

    room.currentTrackIndex = (room.currentTrackIndex - 1 + room.queue.length) % room.queue.length;
    room.audioOffset = 0;
    room.startedAt = room.isPlaying ? Date.now() : null;
    return room;
  }

  /**
   * Calculate the current playback position in seconds.
   */
  getCurrentPosition(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return 0;
    if (!room.isPlaying || !room.startedAt) return room.audioOffset;

    return room.audioOffset + (Date.now() - room.startedAt) / 1000;
  }

  /**
   * Get the current track object.
   */
  getCurrentTrack(roomId) {
    const room = this.rooms.get(roomId);
    if (!room || room.queue.length === 0) return null;
    return room.queue[room.currentTrackIndex] || null;
  }

  /**
   * Get a snapshot of the room state safe to send to clients.
   */
  getRoomSnapshot(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    return {
      roomId: room.roomId,
      hostId: room.hostId,
      hostName: room.hostName,
      isPlaying: room.isPlaying,
      currentPosition: this.getCurrentPosition(roomId),
      serverTime: Date.now(),
      queue: room.queue,
      currentTrackIndex: room.currentTrackIndex,
      currentTrack: this.getCurrentTrack(roomId),
      listeners: room.listeners,
    };
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  isHost(roomId, socketId) {
    const room = this.rooms.get(roomId);
    return room ? room.hostId === socketId : false;
  }

  /**
   * Generate a human-friendly 6-character room code.
   */
  _generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (this.rooms.has(code));
    return code;
  }
}

module.exports = RoomManager;

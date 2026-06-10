-- SyncBeat - store YouTube video ids for official iframe playback.

ALTER TABLE public.queue_items
  ADD COLUMN IF NOT EXISTS youtube_video_id TEXT;

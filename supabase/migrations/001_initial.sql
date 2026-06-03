-- ═══════════════════════════════════════════════════════════════════════════
-- SyncBeat — Schema inicial
-- Rode no Supabase Dashboard > SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Tabelas ─────────────────────────────────────────────────────────────────

-- Perfis de usuário (sincronizado com auth.users)
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Salas de música
CREATE TABLE IF NOT EXISTS public.rooms (
  id                  TEXT PRIMARY KEY,           -- código 6 chars ex: "ABC123"
  host_id             UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  is_playing          BOOLEAN DEFAULT false,
  started_at          TIMESTAMPTZ,                -- quando play foi acionado
  audio_offset        FLOAT DEFAULT 0,            -- posição do áudio em segundos
  current_track_index INT DEFAULT 0,
  loop                BOOLEAN DEFAULT false,
  co_hosts            UUID[] DEFAULT '{}',
  created_at          TIMESTAMPTZ DEFAULT now()
);

-- Itens da fila (playlist)
CREATE TABLE IF NOT EXISTS public.queue_items (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id      TEXT REFERENCES public.rooms(id) ON DELETE CASCADE,
  position     INT NOT NULL,
  name         TEXT NOT NULL,
  artist       TEXT,
  duration     INT DEFAULT 0,      -- segundos
  thumbnail    TEXT,
  audio_url    TEXT NOT NULL,
  source_type  TEXT DEFAULT 'url', -- youtube | spotify | upload | url
  original_url TEXT,
  added_by     UUID REFERENCES public.profiles(id),
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_queue_items_room_id ON public.queue_items(room_id, position);

-- ─── Trigger: Criar perfil automaticamente ao registrar ───────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name',
      split_part(NEW.email, '@', 1),
      'Usuário'
    ),
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    avatar_url   = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ─── Row Level Security ───────────────────────────────────────────────────────

ALTER TABLE public.profiles   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rooms      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.queue_items ENABLE ROW LEVEL SECURITY;

-- Profiles
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "profiles_insert" ON public.profiles FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "profiles_update" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- Rooms: qualquer autenticado pode criar; só o host pode atualizar/deletar
CREATE POLICY "rooms_select" ON public.rooms FOR SELECT USING (true);
CREATE POLICY "rooms_insert" ON public.rooms FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "rooms_update" ON public.rooms FOR UPDATE USING (auth.uid() = host_id);
CREATE POLICY "rooms_delete" ON public.rooms FOR DELETE USING (auth.uid() = host_id);

-- Queue items: qualquer autenticado pode adicionar; host pode remover
CREATE POLICY "queue_select" ON public.queue_items FOR SELECT USING (true);
CREATE POLICY "queue_insert" ON public.queue_items FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "queue_delete" ON public.queue_items FOR DELETE USING (
  auth.uid() = added_by
  OR auth.uid() = (SELECT host_id FROM public.rooms WHERE id = room_id)
);
CREATE POLICY "queue_update" ON public.queue_items FOR UPDATE USING (
  auth.uid() = (SELECT host_id FROM public.rooms WHERE id = room_id)
);

-- ─── Habilitar Realtime nas tabelas ──────────────────────────────────────────

ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms;
ALTER PUBLICATION supabase_realtime ADD TABLE public.queue_items;

-- SyncBeat - align room policies with host/co-host controls.

DROP POLICY IF EXISTS "rooms_insert" ON public.rooms;
DROP POLICY IF EXISTS "rooms_update" ON public.rooms;

CREATE POLICY "rooms_insert" ON public.rooms
  FOR INSERT
  WITH CHECK (auth.uid() = host_id);

CREATE POLICY "rooms_update" ON public.rooms
  FOR UPDATE
  USING (
    auth.uid() = host_id
    OR auth.uid() = ANY(co_hosts)
  )
  WITH CHECK (
    auth.uid() = host_id
    OR auth.uid() = ANY(co_hosts)
  );

/**
 * supabase-client.js — Shared Supabase client instance
 * Loaded first in every page via <script> tag.
 */
(function () {
  const SUPABASE_URL = 'https://jgrssamxwqdysfwedlnz.supabase.co';
  const SUPABASE_ANON_KEY =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpncnNzYW14d3FkeXNmd2VkbG56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0MTU5MjEsImV4cCI6MjA5NTk5MTkyMX0.xXLJAixySO8DMN5JV2wBlvdvdLHwwb2p57JrfaV8mU8';

  // Exposed on window so all scripts can use it
  window.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
    realtime: {
      params: { eventsPerSecond: 10 },
    },
  });

  window.SUPABASE_URL = SUPABASE_URL;
})();

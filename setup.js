#!/usr/bin/env node
/**
 * setup.js — Script de setup automático do SyncBeat
 *
 * Aplica o schema SQL no Supabase via Management API
 * Requer: SUPABASE_ACCESS_TOKEN (Personal Access Token do supabase.com)
 *
 * Uso:
 *   SUPABASE_ACCESS_TOKEN=sbp_xxx node setup.js
 *
 * Como obter o token:
 *   1. Acesse https://supabase.com/dashboard/account/tokens
 *   2. Clique em "Generate new token"
 *   3. Dê um nome (ex: "SyncBeat Setup") e copie o token
 */

const fs = require('fs');
const path = require('path');

const PROJECT_REF = 'jgrssamxwqdysfwedlnz';
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
  console.error('\n❌ SUPABASE_ACCESS_TOKEN não definido.\n');
  console.error('Como obter:');
  console.error('  1. Acesse: https://supabase.com/dashboard/account/tokens');
  console.error('  2. Clique em "Generate new token"');
  console.error('  3. Execute: SUPABASE_ACCESS_TOKEN=sbp_xxx node setup.js\n');
  process.exit(1);
}

async function runSQL(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function createStorageBucket() {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/storage/buckets`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: 'audio-uploads',
      name: 'audio-uploads',
      public: true,
      file_size_limit: 52428800, // 50 MB
      allowed_mime_types: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/mp4', 'audio/aac', 'audio/opus', 'audio/webm'],
    }),
  });
  const data = await res.json();
  // Bucket might already exist — that's ok
  if (!res.ok && !data.error?.includes('already exists')) {
    throw new Error('Storage bucket error: ' + JSON.stringify(data));
  }
  return data;
}

async function main() {
  console.log('\n🎵 SyncBeat — Setup automático\n');

  // 1. Apply SQL schema
  console.log('📦 Aplicando schema SQL...');
  const sqlPath = path.join(__dirname, 'supabase', 'migrations', '001_initial.sql');
  const sql = fs.readFileSync(sqlPath, 'utf-8');

  try {
    await runSQL(sql);
    console.log('✅ Schema aplicado com sucesso!');
  } catch (err) {
    console.error('❌ Falha ao aplicar o schema:', err.message);
    process.exit(1);
  }

  // 2. Create storage bucket
  console.log('🪣 Criando bucket de storage...');
  try {
    await createStorageBucket();
    console.log('✅ Bucket "audio-uploads" criado!\n');
  } catch (err) {
    console.error('⚠️  Storage:', err.message);
  }

  console.log('🎉 Setup concluído!\n');
  console.log('Próximos passos:');
  console.log('  1. Deploy da Edge Function:');
  console.log('     SUPABASE_ACCESS_TOKEN=sbp_xxx npx supabase functions deploy resolve-audio --project-ref jgrssamxwqdysfwedlnz');
  console.log('  2. Configure OAuth (Google/Spotify) no Supabase Dashboard:');
  console.log('     https://supabase.com/dashboard/project/jgrssamxwqdysfwedlnz/auth/providers');
  console.log('  3. Deploy o frontend para Cloudflare Pages (pasta client/)');
  console.log('  4. Atualize os Redirect URLs no Supabase Auth para o domínio do Cloudflare Pages\n');
}

main().catch(console.error);

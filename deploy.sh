#!/usr/bin/env bash
# deploy.sh — Deploy completo do SyncBeat
# Uso: bash deploy.sh
# Requer: supabase CLI no PATH, wrangler (Cloudflare)

set -e

SUPABASE_PATH="$HOME/.local/share/supabase"
PROJECT_REF="jgrssamxwqdysfwedlnz"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PATH="$SUPABASE_PATH:$PATH"

echo ""
echo "🎵 SyncBeat — Deploy Automático"
echo "================================"

# ─── 1. Verificar Supabase CLI ─────────────────────────────────────────────────
echo ""
echo "🔍 Verificando Supabase CLI..."
if ! command -v supabase &>/dev/null; then
  echo "❌ Supabase CLI não encontrada. Reinstalando..."
  mkdir -p "$SUPABASE_PATH"
  curl -sL "https://github.com/supabase/cli/releases/download/v2.104.0/supabase_2.104.0_linux_amd64.tar.gz" \
    | tar -xzf - -C "$SUPABASE_PATH"
fi
echo "✅ Supabase CLI: $(supabase --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"

# ─── 2. Login Supabase (abre browser) ──────────────────────────────────────────
echo ""
echo "🔐 Autenticando no Supabase..."
echo "   (Isso vai abrir o browser para você fazer login)"
supabase login

# ─── 3. Linkar projeto ─────────────────────────────────────────────────────────
echo ""
echo "🔗 Linkando ao projeto Supabase..."
cd "$PROJECT_DIR"
supabase link --project-ref "$PROJECT_REF" --workdir "$PROJECT_DIR"

# ─── 4. Aplicar schema SQL ─────────────────────────────────────────────────────
echo ""
echo "📦 Aplicando schema SQL no banco de dados remoto..."
supabase db push --workdir "$PROJECT_DIR" 2>&1 || {
  echo "⚠️  'db push' falhou. Tente aplicar o schema manualmente em:"
  echo "   https://supabase.com/dashboard/project/$PROJECT_REF/sql/new"
  echo ""
  echo "   (Cole o conteúdo de: supabase/migrations/001_initial.sql)"
  echo ""
  echo "   Continuando com o deploy da Edge Function..."
}

# ─── 5. Deploy Edge Function ───────────────────────────────────────────────────
echo ""
echo "⚡ Fazendo deploy da Edge Function resolve-audio..."
supabase functions deploy resolve-audio \
  --workdir "$PROJECT_DIR" \
  --project-ref "$PROJECT_REF" \
  --no-verify-jwt

echo "✅ Edge Function deployada!"

# ─── 6. Deploy Cloudflare Pages ────────────────────────────────────────────────
echo ""
echo "☁️  Deploy no Cloudflare Pages..."

if ! command -v wrangler &>/dev/null; then
  echo "📦 Instalando wrangler..."
  npm install -g wrangler 2>&1 | tail -3
fi

echo ""
echo "   Isso vai abrir o browser para você autenticar no Cloudflare."
echo "   Pressione Enter para continuar..."
read -r

wrangler pages publish "$PROJECT_DIR/client" \
  --project-name syncbeat \
  --branch main 2>&1 || {
    echo ""
    echo "⚠️  Se o projeto ainda não existe, execute:"
    echo "   wrangler pages project create syncbeat"
    echo "   wrangler pages publish client/ --project-name syncbeat"
  }

echo ""
echo "═══════════════════════════════════════════════════════"
echo "✅ Deploy concluído!"
echo ""
echo "📋 Passos manuais restantes:"
echo ""
echo "1. Configure Google OAuth:"
echo "   https://supabase.com/dashboard/project/$PROJECT_REF/auth/providers"
echo ""
echo "2. Configure Spotify OAuth (mesmo link acima)"
echo ""
echo "3. Configure Redirect URLs no Supabase Auth:"
echo "   https://supabase.com/dashboard/project/$PROJECT_REF/auth/url-configuration"
echo "   Adicione: https://<seu-projeto>.pages.dev/auth-callback.html"
echo ""
echo "4. Crie o bucket de storage (se não criou):"
echo "   https://supabase.com/dashboard/project/$PROJECT_REF/storage/buckets"
echo "   Nome: audio-uploads | Público: SIM | Limite: 50MB"
echo "═══════════════════════════════════════════════════════"

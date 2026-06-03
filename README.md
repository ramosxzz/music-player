# 🎵 SyncBeat — Music Player Compartilhado

Player de música sincronizado em tempo real. YouTube, Spotify, upload e URL direta. Login com Google ou Spotify.

**Stack:** Cloudflare Pages (frontend) + Supabase (Auth, DB, Realtime, Storage, Edge Functions)

---

## ⚙️ Setup Completo (passo a passo)

### Passo 1 — Configurar o Banco de Dados

1. Acesse o [Supabase SQL Editor](https://supabase.com/dashboard/project/jgrssamxwqdysfwedlnz/sql)
2. Clique em **New Query**
3. Cole o conteúdo do arquivo `supabase/migrations/001_initial.sql`
4. Clique em **Run**

Ou use o script automático:
```bash
# Obtenha seu Personal Access Token em:
# https://supabase.com/dashboard/account/tokens

SUPABASE_ACCESS_TOKEN=sbp_xxxx node setup.js
```

---

### Passo 2 — Criar o Storage Bucket

1. Acesse: [Storage](https://supabase.com/dashboard/project/jgrssamxwqdysfwedlnz/storage/buckets)
2. Clique em **New Bucket**
3. Nome: `audio-uploads`
4. Marque **Public bucket**
5. File size limit: `50 MB`
6. Allowed MIME types: `audio/*`
7. Clique em **Save**

---

### Passo 3 — Deploy da Edge Function

```bash
# Instalar Supabase CLI
mkdir -p "$HOME/.local/share/supabase"
curl -sL https://github.com/supabase/cli/releases/download/v2.104.0/supabase_2.104.0_linux_amd64.tar.gz \
  | tar -xzf - -C "$HOME/.local/share/supabase"
export PATH="$HOME/.local/share/supabase:$PATH"

# Login (abre browser)
supabase login

# Entrar na pasta do projeto
cd "music player"

# Iniciar projeto (já feito)
supabase init

# Linkar ao projeto Supabase
supabase link --project-ref jgrssamxwqdysfwedlnz

# Deploy da Edge Function
supabase functions deploy resolve-audio
```

#### Configurar variáveis da Edge Function (para Spotify)
1. Acesse: [Edge Functions Settings](https://supabase.com/dashboard/project/jgrssamxwqdysfwedlnz/functions)
2. Clique em `resolve-audio` → **Secrets**
3. Adicione:
   - `SPOTIFY_CLIENT_ID` = seu client id
   - `SPOTIFY_CLIENT_SECRET` = seu client secret

---

### Passo 4 — Configurar Login com Google

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/)
2. Crie um projeto → **APIs & Services** → **Credentials**
3. Clique em **Create Credentials** → **OAuth 2.0 Client ID**
4. Application type: **Web application**
5. **Authorized redirect URIs**, adicione:
   ```
   https://jgrssamxwqdysfwedlnz.supabase.co/auth/v1/callback
   ```
6. Copie o **Client ID** e **Client Secret**
7. No [Supabase Auth Providers](https://supabase.com/dashboard/project/jgrssamxwqdysfwedlnz/auth/providers):
   - Clique em **Google**
   - Cole Client ID e Client Secret
   - Habilite o provider
   - Salve

---

### Passo 5 — Configurar Login com Spotify

1. Acesse o [Spotify Developer Dashboard](https://developer.spotify.com/dashboard/)
2. Crie ou abra seu app
3. Em **Edit Settings** → **Redirect URIs**, adicione:
   ```
   https://jgrssamxwqdysfwedlnz.supabase.co/auth/v1/callback
   ```
4. Salve
5. No [Supabase Auth Providers](https://supabase.com/dashboard/project/jgrssamxwqdysfwedlnz/auth/providers):
   - Clique em **Spotify**
   - Cole Client ID e Client Secret
   - Habilite o provider
   - Salve

---

### Passo 6 — Deploy no Cloudflare Pages

#### Opção A: Via Git (recomendado)
1. Suba o projeto para um repositório GitHub/GitLab
2. Acesse o [Cloudflare Pages Dashboard](https://dash.cloudflare.com/)
3. **Create a project** → **Connect to Git**
4. Selecione o repositório
5. Configurações do build:
   - **Framework preset:** None
   - **Build command:** *(vazio)*
   - **Build output directory:** `client`
6. Clique em **Save and Deploy**

#### Opção B: Via CLI (deploy direto)
```bash
npm install -g wrangler
wrangler pages publish client/ --project-name syncbeat
```

---

### Passo 7 — Atualizar URLs no Supabase

Após o deploy no Cloudflare Pages, você terá uma URL como `https://syncbeat.pages.dev`.

1. Acesse [Supabase Auth URL Configuration](https://supabase.com/dashboard/project/jgrssamxwqdysfwedlnz/auth/url-configuration)
2. **Site URL:** `https://syncbeat.pages.dev`
3. **Redirect URLs**, adicione:
   ```
   https://syncbeat.pages.dev/auth-callback.html
   https://syncbeat.pages.dev/**
   ```
4. Salve

Também atualize os Redirect URIs no Google Cloud Console e Spotify Developer para incluir a URL do Cloudflare Pages.

---

## 🎮 Como Usar

### Como Host
1. Acesse a URL do app
2. Faça login com Google ou Spotify
3. Clique em **Criar Sala**
4. Compartilhe o **código** ou **link** com seus amigos
5. Adicione músicas pela busca (YouTube/Spotify), URL ou upload
6. Controle o playback — todos ouvem junto!

### Como Ouvinte
1. Acesse o link compartilhado pelo host
2. Faça login (se não estiver logado)
3. Curta a música! 🎧

---

## 📁 Estrutura do Projeto

```
music-player/
├── client/                      ← Deploy: Cloudflare Pages
│   ├── index.html               ← Tela inicial + Login
│   ├── room.html                ← Sala de música
│   ├── auth-callback.html       ← Redirect OAuth
│   ├── style.css                ← Dark mode premium
│   └── js/
│       ├── supabase-client.js   ← Config Supabase SDK
│       ├── auth.js              ← Login/logout Google/Spotify
│       ├── app.js               ← Lógica da tela inicial
│       └── room.js              ← Sala (Realtime + Sync)
│
├── supabase/
│   ├── migrations/
│   │   └── 001_initial.sql      ← Schema do banco
│   └── functions/
│       └── resolve-audio/
│           └── index.ts         ← Edge Function (audio resolver)
│
├── setup.js                     ← Script de setup automático
└── README.md
```

---

## 🔧 Solução de Problemas

| Problema | Solução |
|---|---|
| Login não funciona | Verifique se os Redirect URIs estão corretos no Google/Spotify e Supabase |
| YouTube não funciona | No backend local, verifique `yt-dlp --version`. Na Edge Function, configure uma instância Cobalt própria em `COBALT_API_URLS` se as instâncias públicas falharem. |
| Spotify não funciona | Com credenciais, configure `SPOTIFY_CLIENT_ID` e `SPOTIFY_CLIENT_SECRET`. Sem credenciais, o app usa fallback público via Spotify oEmbed e busca o áudio no YouTube. |
| Upload não funciona | Verifique se o bucket `audio-uploads` existe e é público |
| Áudio fora de sincronia | O app re-sincroniza periodicamente. Se persistir, recarregue a página (F5). |
| Sala não encontrada | A sala pode ter sido encerrada quando o host desconectou |

### Backend local para YouTube/Spotify

O backend Node usa `yt-dlp` para gerar uma URL fresca de áudio quando o player carrega a música:

```bash
pipx install yt-dlp
cd server
npm start
```

Para Spotify com metadados completos, configure `server/.env` com as credenciais do Spotify. Sem elas, o app ainda tenta resolver via `open.spotify.com/oembed`.

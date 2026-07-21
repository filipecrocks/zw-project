# SETUP — Assumindo o projeto ZW (guia do novo dono)

Este guia é pra quem vai **assumir e hospedar** o ZW com as **próprias contas e
chaves**. O repositório não contém nenhuma chave — todos os campos de credencial
estão vazios e você preenche com os seus.

Ordem recomendada: **1) Supabase → 2) Chaves de IA → 3) Deploy na Vercel →
4) Domínio**.

---

## 0) Visão geral do que roda

| Parte | Onde vive | Precisa de chave sua? |
|---|---|---|
| Site (portal + Arena) | HTML estático na **Vercel** | Não (mas aponta pro seu Supabase) |
| Auth, perfis, ranking, DB | **Supabase** (Postgres) | anon key (pública) no HTML |
| Chat "Guardião Z" (IA) | **Edge Function** `chat` no Supabase | `GROQ_API_KEY` (secret) |
| Embeddings (modo `vector`, opcional) | job `scripts/embed-kb.mjs` | `GEMINI_API_KEY` + `service_role` |

---

## 1) Supabase

1. Crie um projeto em <https://supabase.com> (ou use o que te foi transferido).
2. Pegue em **Project Settings → API**:
   - **Project URL** → algo como `https://xxxx.supabase.co`
   - **anon / publishable key** → `sb_publishable_...` (é pública, pode ir no client).
   - ⚠️ **NUNCA** use a `service_role` no HTML — ela é só pra scripts server-side.
3. **Rode os SQL** no **SQL Editor** (New query → cola → Run), nesta ordem:
   - `schema.sql`
   - `gamification.sql`
   - `admin_edit.sql`
   - `sql/chat_hardening.sql` (rate limit + cache do chat)
4. **Cole a URL e a anon key** nos arquivos do front (procure os campos vazios):

   **`index.html`** (topo do `<script>`):
   ```js
   const SUPA="https://xxxx.supabase.co";
   const ANON="sb_publishable_...";
   ```

   **`arena.html`** e **`arena-base.html`** (bloco `CONFIG`):
   ```js
   const CONFIG = {
     supabaseUrl: "https://xxxx.supabase.co",
     supabaseAnonKey: "sb_publishable_...",
   };
   ```
   > Deixar vazio faz a Arena rodar em **modo local** (2 abas), sem servidor.

5. **Usuários do clã / login:** Authentication → Providers → deixe **Email**
   habilitado. Crie usuários já confirmados em Authentication → Users → **Add user**
   → marque **Auto Confirm User**. (Detalhes e Admin API em `RAG-SETUP.md`.)

---

## 2) Chaves de IA (o chat)

O chat usa o **Groq** (geração). A chave fica como **secret da Edge Function** —
**não** no repositório.

1. Crie a sua chave em <https://console.groq.com> → API Keys.
2. Instale a CLI e faça deploy:
   ```bash
   supabase login
   supabase link --project-ref <seu-project-ref>

   supabase secrets set GROQ_API_KEY="<a sua chave Groq>"
   # GEMINI só é preciso no modo vector (corpus grande). Veja RAG-SETUP.md.

   supabase functions deploy chat
   supabase functions deploy gamify
   supabase functions deploy referral
   ```
3. Teste conforme o passo 3 do `RAG-SETUP.md`.

> Enquanto não setar `GROQ_API_KEY`, o site funciona (portal, Arena, login), só o
> chat que não responde.

---

## 3) Deploy na Vercel (conta nova)

O projeto Vercel **não é transferível no plano grátis** — então você cria um
**projeto novo** na **sua** conta apontando pra este repositório.

1. Garanta acesso ao repositório no GitHub (transferência do repo, ou entrar como
   colaborador, ou um fork na sua conta).
2. Em <https://vercel.com> → **Add New → Project** → **Import** este repositório.
3. Framework preset: **Other** (é HTML estático). Sem build command, sem output dir.
   O `vercel.json` já cuida do `cleanUrls` (rotas `/arena`, `/arena-base`).
4. **Deploy.** Vai subir num domínio `*.vercel.app` — teste por ali primeiro.

---

## 4) Domínio (`zwarriors.xyz`)

⚠️ **Um domínio só pode estar em UM projeto Vercel por vez** (em qualquer conta).
Então a ordem importa pra não dar conflito:

1. **No projeto Vercel antigo (dono anterior):** remova o domínio
   (**Project → Settings → Domains → Remove**) — **ou** delete o projeto antigo
   inteiro. Enquanto o domínio estiver preso lá, você não consegue adicioná-lo.
2. **No seu projeto novo:** Settings → **Domains → Add** → `zwarriors.xyz`
   (e `www.zwarriors.xyz`).
3. **DNS:** aponte o domínio pra Vercel conforme as instruções que ela mostra
   (registro `A`/`CNAME`). Se o domínio foi registrado fora da Vercel, isso é feito
   no seu registrador. Propaga em minutos/horas.

> Dica: faça o passo 3 (deploy no `*.vercel.app`) e confirme que tudo funciona
> **antes** de mexer no domínio — assim a troca de domínio é só o último clique.

---

## Checklist final

- [ ] SQL rodados no Supabase (`schema`, `gamification`, `admin_edit`, `chat_hardening`).
- [ ] URL + anon key coladas em `index.html`, `arena.html`, `arena-base.html`.
- [ ] `GROQ_API_KEY` setada como secret + `supabase functions deploy chat`.
- [ ] Functions `gamify` e `referral` deployadas.
- [ ] Projeto importado e deployado na sua conta Vercel.
- [ ] Domínio removido do projeto antigo e adicionado no seu + DNS apontado.
- [ ] Chat, login, ranking e Arena testados no ar.

## Para o dono anterior (limpeza das chaves dele)

Como as chaves de IA ficam como **secrets do Supabase** (não no repo), o dono
anterior deve, do lado dele:

- **Revogar** a chave Groq antiga em <https://console.groq.com> → API Keys → delete.
- **Revogar** a chave Gemini antiga em <https://aistudio.google.com/apikey> (se usou).

Assim, mesmo que a secret antiga ainda esteja no projeto, ela para de funcionar — e
o novo dono passa a usar só a dele (setada no passo 2).

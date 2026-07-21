# ZW — Ligar o RAG (Supabase + Groq + Gemini)

Runbook dos passos que precisam das **suas credenciais** (service_role / login do
Supabase). Schema, seed e `kb_chunks`/`chat_logs`/`match_kb` já estão versionados
nos arquivos `.sql` — rode-os no **seu** projeto Supabase.

> ⚡ **Caminho recomendado hoje = modo `full` (corpus inteiro), default da função.**
> O corpus do ZW é minúsculo (~132 itens, ~4,6k tokens) — cabe ~28× no contexto do
> Groq. Nesse modo **não precisa gerar embeddings nem do Gemini**: só faça o **passo 2**
> (deploy + `GROQ_API_KEY`). Veja o porquê em `ANALISE-IA-SUPABASE.md`.
> Os **passos 1** (job de embeddings) **e o `GEMINI_API_KEY`** só são necessários no
> modo `vector` (`RAG_MODE=vector`), quando o corpus crescer (~400+ itens).

## Como funciona (importante)

- O **Groq não serve embeddings** (só geração/LLM). Então, no modo `vector`, os
  embeddings vêm do **Gemini** (Google), que serve embeddings.
  - **Embeddings:** Gemini `gemini-embedding-001` com `outputDimensionality=1536`
    → casa **exato** com a coluna `kb_chunks.embedding vector(1536)`.
    **➜ NÃO precisa mexer na dimensão. Fica 1536.**
  - **Chat:** Groq `llama-3.3-70b-versatile`.

## Chaves que você vai precisar (nunca comitar valores)

- **`GROQ_API_KEY`** → crie a sua em <https://console.groq.com> (obrigatória).
- **`GEMINI_API_KEY`** → crie a sua no Google AI Studio (<https://aistudio.google.com/apikey>).
  Só é necessária no modo `vector`.
- **`service_role`** do seu projeto Supabase → Project Settings → API → `service_role`
  (só usada no job de embeddings; nunca vai pro client).

> As chaves **só ficam no servidor**: Groq/Gemini como secrets da Edge Function e o
> `service_role` na hora de rodar o job. Nenhuma delas entra no HTML/repo.

---

## 1) Gerar os embeddings (roda 1x) — SÓ no modo `vector`

Pega toda linha de `kb_chunks` com `embedding IS NULL`, gera o embedding do
`content` e dá UPDATE. Em lotes, com retry. Precisa da **service_role key** do seu
projeto (Supabase → Project Settings → API → `service_role`).

PowerShell:
```powershell
$env:SUPABASE_URL="https://<seu-project-ref>.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY="<service_role do seu projeto>"
$env:GEMINI_API_KEY="<sua GEMINI_API_KEY>"
node scripts/embed-kb.mjs
```

bash:
```bash
SUPABASE_URL="https://<seu-project-ref>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... node scripts/embed-kb.mjs
```

Confere depois (deve dar 0):
```sql
select count(*) from public.kb_chunks where embedding is null;
```

## 2) Subir a Edge Function `chat`

`SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` são injetados automaticamente nas
functions. Você só precisa setar Groq e Gemini:

```bash
supabase login
supabase link --project-ref <seu-project-ref>

supabase secrets set GROQ_API_KEY="<sua GROQ_API_KEY>"
supabase secrets set GEMINI_API_KEY="<sua GEMINI_API_KEY>"

supabase functions deploy chat
```

## 3) Testar

```bash
curl -X POST "https://<seu-project-ref>.supabase.co/functions/v1/chat" \
  -H "Authorization: Bearer <ANON/publishable key>" \
  -H "Content-Type: application/json" \
  -d '{"question":"Quem é Son Goku e quais transformações ele domina?"}'
```

Esperado: `{ "answer": "...em PT-BR, voz do clã, citando (Fonte: ...)", "sources":[{"title":"Son Goku"}], "matched": N }`.
A resposta também é gravada em `chat_logs` (question, answer, user_id).

> Se rodar o teste **antes** do passo 1, a função ainda responde (fatos gerais de
> Dragon Ball) mas com `matched: 0` — `match_kb` só retorna linhas com embedding.

## 4) Auth — usuários do clã (Auto Confirm por enquanto)

Supabase → **Authentication → Providers → Email**: deixe **Email** habilitado.
Crie os usuários do clã já confirmados:

- **Pelo painel:** Authentication → Users → **Add user** → marque
  **Auto Confirm User**.
- **Ou via Admin API** (service_role; `email_confirm: true` = já confirmado):
  ```bash
  curl -X POST "https://<seu-project-ref>.supabase.co/auth/v1/admin/users" \
    -H "apikey: <service_role>" -H "Authorization: Bearer <service_role>" \
    -H "Content-Type: application/json" \
    -d '{"email":"usuario@exemplo.com","password":"<senha>","email_confirm":true}'
  ```

Para abrir cadastro de verdade depois, ligue SMTP/Resend e desligue o Auto Confirm.

---

## Limites respeitados
- **Não** mexe no motor da Arena (`index.html` / engine TS) nem no fluxo de convidado.
- Groq (geração) + Gemini (embeddings) — **cada um com a sua própria chave**.
- Dimensão mantida em **1536**.

## Chat público — proteções (rate limit, sanitização, cache)

A função `chat` está pronta pra público. Para ativar 100%:

1. **Criar as tabelas** (rate limit + cache) — SQL Editor, uma vez:
   ```sql
   -- conteúdo de sql/chat_hardening.sql
   ```
   Rode o arquivo `sql/chat_hardening.sql`. Enquanto não rodar, a função
   **continua respondendo** (fail-open): o limite e o cache só ligam depois das tabelas.

2. **Re-deploy** da função: `supabase functions deploy chat`.

3. **Testar o limite** (estourando de propósito): mande 16 perguntas seguidas
   com o mesmo `session_id`, ou duas em menos de 3s — vem a resposta amigável
   (`"Calma, guerreiro! ⚡…"` / `"Você treinou bastante por agora! 🐉…"`) com `limited: true`,
   sem chamar o Groq.

O que está incluso:
- **Rate limit** por `session_id`: **15 msgs/h + cooldown 3s** (tabela `portal_rate_limit`).
- **Teto de 1.000 chars** na pergunta + **remoção de caracteres de controle** + recusa
  leve pra pergunta vazia.
- **Prompt injection**: o system prompt manda tratar contexto e pergunta como **dados** e
  ignorar instruções embutidas (mudar regras, trocar idioma, revelar o prompt).
- **Chaves só no servidor**: Groq e Gemini em secrets; `service_role` na função. As
  tabelas têm RLS ligado **sem policy pública** — só a função acessa.
- **Cache** (`chat_cache`, TTL 24h) das perguntas repetidas sem histórico → pula o Groq.
  > Obs.: o **Groq não tem prompt caching** (diferente da Anthropic), então no modo `full`
  > o corpus vai inteiro no prompt a cada pergunta nova — o `chat_cache` é a alavanca de custo.

## Arquivos entregues
- `scripts/embed-kb.mjs` — job de embeddings (1x, lotes + retry).
- `supabase/functions/chat/index.ts` — Edge Function do chat (RAG + Groq + rate limit + cache), server-side.
- `supabase/functions/chat/deno.json` — import map.
- `sql/chat_hardening.sql` — tabelas `portal_rate_limit` + `chat_cache`.

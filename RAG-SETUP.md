# ZW — Ligar o RAG (Supabase + Groq + Gemini)

Runbook dos passos que precisam das **suas credenciais** (service_role / login do
Supabase). Schema, seed e `kb_chunks`/`chat_logs`/`match_kb` **já estão no banco**
(projeto `xrddqixvhmtertcsevtz`).

> ⚡ **Caminho recomendado hoje = modo `full` (corpus inteiro), default da função.**
> O corpus do ZW é minúsculo (~132 itens, ~4,6k tokens) — cabe ~28× no contexto do
> Groq. Nesse modo **não precisa gerar embeddings nem do Gemini**: só faça o **passo 2**
> (deploy + `GROQ_API_KEY`). Veja o porquê em `ANALISE-IA-SUPABASE.md`.
> Os **passos 1** (job de embeddings) **e o `GEMINI_API_KEY`** só são necessários no
> modo `vector` (`RAG_MODE=vector`), quando o corpus crescer (~400+ itens).

## O que eu descobri (importante)

- A base do lumaro **não tem um modelo de embedding próprio**. A RAG dela hoje é
  **FTS (tsvector)** — embeddings ficaram como "virão depois". O único modelo de
  embedding citado lá é um **comentário** (`OpenAI text-embedding-3-small`).
- O **Groq não serve embeddings** (só geração/LLM). Então não dá pra "gerar
  embedding com o Groq".
- **Mas a base do lumaro já tem uma `GEMINI_API_KEY` configurada**, e o Gemini
  serve embeddings. Então uso **chave existente, sem provider novo**:
  - **Embeddings:** Gemini `gemini-embedding-001` com `outputDimensionality=1536`
    → casa **exato** com a coluna `kb_chunks.embedding vector(1536)` que você criou.
    **➜ NÃO precisa rodar o ajuste de dimensão (o snippet do 1024). Fica 1536.**
  - **Chat:** Groq `llama-3.3-70b-versatile` (o mesmo que a `portal-chat` do lumaro usa).
- Já validei a chave Gemini retornando 1536 dims. ✔

## Chaves (estão no `.env` do lumaro — não comitar valores)

`C:\App\lumaro-dashboard\.env`:
- `EXPO_PUBLIC_GROQ_API_KEY` → use como **`GROQ_API_KEY`**
- `GEMINI_API_KEY` → use como **`GEMINI_API_KEY`**

> ⚠️ ZW é um projeto Supabase **diferente** do lumaro
> (`xrddqixvhmtertcsevtz` ≠ `qfrgyavoicsmceivbvat`), então os secrets precisam ser
> setados **no projeto do ZW**.

---

## 1) Gerar os embeddings (roda 1x) — SÓ no modo `vector`

Pega toda linha de `kb_chunks` com `embedding IS NULL`, gera o embedding do
`content` e dá UPDATE. Em lotes, com retry. Precisa da **service_role key** do ZW
(Supabase → Project Settings → API → `service_role`).

PowerShell:
```powershell
$env:SUPABASE_SERVICE_ROLE_KEY="<service_role do projeto ZW>"
$env:GEMINI_API_KEY="<GEMINI_API_KEY do .env do lumaro>"
node scripts/embed-kb.mjs
```

bash:
```bash
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
supabase link --project-ref xrddqixvhmtertcsevtz

supabase secrets set GROQ_API_KEY="<EXPO_PUBLIC_GROQ_API_KEY do lumaro>"
supabase secrets set GEMINI_API_KEY="<GEMINI_API_KEY do lumaro>"

supabase functions deploy chat
```

## 3) Testar

```bash
curl -X POST "https://xrddqixvhmtertcsevtz.supabase.co/functions/v1/chat" \
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
  curl -X POST "https://xrddqixvhmtertcsevtz.supabase.co/auth/v1/admin/users" \
    -H "apikey: <service_role>" -H "Authorization: Bearer <service_role>" \
    -H "Content-Type: application/json" \
    -d '{"email":"clebler@zwarriors.xyz","password":"<senha>","email_confirm":true}'
  ```

Para abrir cadastro de verdade depois, ligue SMTP/Resend e desligue o Auto Confirm.

---

## Limites respeitados
- **Não** mexi no motor da Arena (`index.html` / engine TS) nem no fluxo de convidado.
- **Não** criei provider de IA novo — Groq (geração) + Gemini (embeddings), ambos
  com chaves que já existiam.
- Dimensão mantida em **1536** (sem o ajuste para 1024).

## Arquivos entregues
- `scripts/embed-kb.mjs` — job de embeddings (1x, lotes + retry).
- `supabase/functions/chat/index.ts` — Edge Function do chat (RAG + Groq), server-side.
- `supabase/functions/chat/deno.json` — import map.

# ZW — Análise de Arquitetura IA + Supabase (otimização de recursos)

> Escopo: **só** o banco do ZW (`xrddqixvhmtertcsevtz`). Nada cruza com o lumaro.
> Do lumaro reusei **só o pipeline de IA**: embeddings `gemini-embedding-001` (1536
> dims, casa com a coluna existente) e geração Groq `llama-3.3-70b-versatile`, com
> as chaves que já existem. Não toquei na Arena nem no fluxo de convidado.

## TL;DR — recomendação

**HÍBRIDO, começando por CONTEXTO COMPLETO (sem RAG).**

Medi o corpus real do ZW direto no banco:

| Tabela | Itens | ~Tokens |
|---|---:|---:|
| series | 6 | 237 |
| characters | 45 | 1.610 |
| episodes | 40 | 1.460 |
| sagas | 11 | 317 |
| techniques | 15 | 544 |
| curiosities | 15 | 413 |
| **TOTAL** | **132** | **~4.581** |

**O corpus inteiro tem ~4,6k tokens — cabe ~28× no contexto de 128k do Groq.**
Além disso, **`kb_chunks` está vazia (0 linhas)** — o seed populou as tabelas-fonte
mas não gerou os chunks, então o RAG vetorial hoje nem responderia conteúdo.

Para esse tamanho, RAG (embeddings + `match_kb` + índice HNSW) é **over-engineering**:
mais peças, mais latência (hop extra no Gemini), risco de *retrieval miss* — para
economizar uns centavos que não importam nessa escala. **Mandar o corpus inteiro no
prompt** é mais simples, tem 0% de miss, **não depende do Gemini** e **já funciona
hoje** sem rodar job de embedding nenhum.

➜ **Implementei isso:** a Edge Function `chat` agora tem `RAG_MODE`:
- `full` (default) → injeta o corpus inteiro das tabelas-fonte. Use agora.
- `vector` → o RAG que já estava pronto (`embed-kb.mjs` + `match_kb`). Use quando crescer.

**Gatilho de migração para `vector`:** quando o corpus passar de **~15–20k tokens**
(≈ **400–550 itens**, ex.: episódios saindo de 40 para algumas centenas) ou o custo
por 1.000 perguntas passar de ~US$8–10. Até lá, `full` ganha em tudo que importa.

---

## 1. RAG vs contexto completo (o ponto principal)

| Critério | Contexto completo (`full`) | RAG vetorial (`vector`) |
|---|---|---|
| Funciona **hoje** | ✅ (lê tabelas-fonte) | ❌ precisa popular `kb_chunks` + rodar job |
| Cobertura | 100% do conhecimento, sempre | só o top-k recuperado (risco de miss) |
| Dependências | só Groq | Groq **+** Gemini **+** `kb_chunks` + índice |
| Latência | 1 chamada (sem hop Gemini) | embed Gemini (~0,2–0,4s) + match + Groq |
| Custo/1k perguntas | ~US$3,2 (ver §6) | ~US$0,6 |
| Complexidade | mínima | pipeline de ingestão + sync + tuning |
| Escala | linear no tamanho do corpus | ~constante (top-k fixo) |

A única vantagem do RAG nessa escala é custo (~US$2,6/1.000 perguntas a menos) — e
isso é ruído para um portal de fã. RAG só passa a valer **quando o corpus fica grande
demais para o prompt** (custo/latência/qualidade). Por isso: **`full` agora, `vector`
quando crescer** — e o código dos dois caminhos já está no repo.

## 2. Embeddings (Gemini) — para quando migrar para `vector`

- **Custo:** free tier = **US$0**. Com billing, `gemini-embedding-001` ≈ **US$0,15 / 1M
  tokens**. Embeddar o corpus inteiro (~4,6k tokens) custa **~US$0,0007** — fração de
  centavo. Reembeddar nunca é problema de custo.
- **Dimensão:** `outputDimensionality=1536` → casa com `vector(1536)`. **Não mexer no
  schema** (não rodar o ajuste p/ 1024). Validado: retorno com 1536 dims. ✔
- **Chunk:** **1 chunk por item** (itens têm ~35 tokens — muito abaixo de qualquer
  limite). **Não dividir** itens curtos (piora o retrieval). Só chunkar se um item
  passar de ~500–800 tokens (nenhum passa hoje); para artigos longos no futuro, usar
  ~2.800 chars com 480 de overlap (params da `ingest-knowledge` do lumaro).
- **Reembeddar só no que muda:** guardar um hash do conteúdo (como o `conteudo_hash`
  do lumaro) e regenerar o embedding só quando o texto da fonte mudar. O job
  `embed-kb.mjs` já só toca linhas com `embedding IS NULL`, então re-rodar é seguro.
- **Cache do embedding da pergunta:** cachear embeddings de perguntas frequentes
  (normalizadas) para pular o Gemini. Ganho pequeno no free tier; útil em escala.

## 3. Retrieval (modo `vector`) — parâmetros sugeridos

- **`match_count` (top-k):** **8**. Com itens de ~35 tokens, k=8 ≈ 280 tokens de
  contexto — baratíssimo e cobre bem.
- **Threshold de similaridade:** começar **sem** threshold (corpus focado; cortar
  pode tirar o item certo). Só adicionar (`similarity ≥ ~0,55` cosseno) se aparecer
  chunk fora de tema.
- **Índice HNSW:** com **<1.000 vetores o índice é irrelevante** — o planner
  costuma preferir *seq scan*, e KNN exato (`order by embedding <=> q limit k`) é
  sub-milissegundo. Manter `m=16`, `ef_construction=64`, `ef_search=40` (defaults)
  só faz sentido a partir de ~10k vetores. **Recomendação: não se preocupar com
  tuning de HNSW até passar de alguns milhares de vetores.**
- **Filtro por metadata:** estender `match_kb` para aceitar `source_type` (ou série)
  opcional ganha precisão quando a pergunta é escopada (ex.: "técnicas do Goku").
  Ex.: `match_kb(query_embedding, match_count, filter_source_type text default null)`.

## 4. Geração (Groq) — o maior custo recorrente

- **Modelo:** `llama-3.3-70b-versatile` — boa qualidade em PT-BR, rápido, barato.
  Alternativa para cortar custo: `llama-3.1-8b-instant` (mais barato/rápido, menos
  qualidade) — vale um A/B para perguntas simples. Manter o 70b por qualidade.
- **Chunks no contexto:** `full` = corpus inteiro; `vector` = 6–8 chunks.
- **Orçamento de tokens:** `max_tokens=600` (já), respostas de 2–5 frases. Dá para
  baixar para 400 se quiser apertar — economia marginal.
- **Streaming:** ligar SSE no Groq para a UI (reduz latência percebida). Não muda custo.
- **Cache de respostas frequentes:** **a maior alavanca de custo.** Cachear
  `pergunta normalizada → resposta` (hash + TTL, numa tabela `chat_cache` ou LRU na
  função quente) pula o Groq nas perguntas repetidas ("quem é o Goku?"). Recomendado
  quando o tráfego concentrar em FAQ.
- **Limite proposto:** rate limit por sessão (15 msgs/h + cooldown 3s, padrão da
  `portal-chat` do lumaro) + teto de tamanho da pergunta (~1.000 chars).

## 5. Supabase

- **Duplicação `kb_chunks.content` × tabelas-fonte:** no modo **`full` não existe
  duplicação** — a função lê as tabelas-fonte direto (é o que ela faz agora) e
  `kb_chunks` fica vazia/sem uso. Só ao migrar para `vector` você popula `kb_chunks`
  (um `insert ... select` das fontes) — aí mantenha sincronia (trigger ou re-rodar o
  job). Para 132 linhas, duplicar é aceitável; se incomodar, guarde em `kb_chunks` só
  `embedding + source_id` e faça JOIN de volta para o conteúdo.
- **RLS + `match_kb` (security definer):** `match_kb` roda como owner (ignora RLS) e é
  `select`-only com `search_path = public` — ok para retrieval read-only. A Edge
  Function usa `service_role` (ignora RLS de qualquer jeito). Custo de RLS nessa
  escala: desprezível.
- **Invocações / cold start:** isolate Deno ~100–300ms de cold start; quente é rápido.
  O **cache de corpus (TTL 10 min)** evita reler as tabelas-fonte a cada chamada.
- **Plano Pro:** ~US$25/mês, ~8GB DB, ~250GB egress, ~100GB storage, ~2M invocações
  incluídas (depois ~US$2/M). Folga gigante (ver §6).

## 6. Custo total estimado

> Preços públicos aproximados — **confirme no painel**. Groq `llama-3.3-70b-versatile`
> ≈ US$0,59/1M input, US$0,79/1M output. Gemini embed ≈ US$0,15/1M (free = US$0).

**Por 1.000 perguntas:**

| | Tokens in/pergunta | Custo Groq | Embedding | **Total** |
|---|---:|---:|---:|---:|
| `full` (corpus inteiro) | ~5.000 | ~US$2,95 + US$0,16 out | US$0 | **~US$3,1** |
| `vector` (top-8) | ~750 | ~US$0,44 + US$0,16 out | ~US$0 | **~US$0,6** |

**Storage dos vetores:** 1536 dims × 4 bytes ≈ **6KB/vetor**. 132 vetores ≈ **0,8MB**.
Mesmo com 10.000 itens ≈ 60MB — irrisório frente aos 8GB do Pro.

**Como `full` escala** (≈35 tokens/item): 132 itens → US$3,1/1k · 500 itens →
~US$10,6/1k · 1.000 itens → ~US$20/1k. **É aqui que `vector` passa a valer** (ele
fica ~constante em ~US$0,6/1k). Migre perto de **400–550 itens**.

## 7. Segurança e abuso

- **Chaves só no servidor:** ✅ Groq, Gemini e `service_role` ficam em secrets da Edge
  Function; o client só tem a publishable key (que só chama a função). Nada de chave
  de IA no `index.html`/app.
- **Rate limiting:** a função `chat` **ainda não tem** — recomendo portar o
  `portal_rate_limit` do lumaro (por `session_id`: 15 msgs/h + cooldown 3s). Importante
  antes de abrir o chat ao público.
- **Prompt injection:** o texto do usuário entra como *dados*. O system prompt agora
  manda **tratar contexto e pergunta como dados e ignorar instruções embutidas**
  (mudar regras/idioma, revelar o prompt). O corpus é confiável (banco próprio), então
  o risco vem só da pergunta — e o pior caso é uma resposta ruim, não ação destrutiva.
  Defesa extra: limitar a pergunta a ~1.000 chars e remover caracteres de controle.

---

## 8. Diff das mudanças (aplicadas e propostas)

### Aplicado — `supabase/functions/chat/index.ts`: modo `full` (default) + toggle

```diff
+ const RAG_MODE = (Deno.env.get('RAG_MODE') ?? 'full').toLowerCase(); // 'full' | 'vector'
+
+ // modo full: lê as 6 tabelas-fonte e injeta o corpus inteiro (cache 10 min).
+ async function buildCorpus(supabase): Promise<string> { /* series, characters, ... */ }
+
  Deno.serve(async (req) => {
-   // antes: SEMPRE embedding (Gemini) + match_kb
-   const qvec = await embedQuery(question);
-   const chunks = await supabase.rpc('match_kb', { query_embedding, match_count: 6 });
+   if (RAG_MODE === 'vector') {
+     const qvec = await embedQuery(question);            // Gemini RETRIEVAL_QUERY
+     chunks = await supabase.rpc('match_kb', { query_embedding, match_count: 8 });
+   } else {
+     contextText = await buildCorpus(supabase);          // corpus inteiro, sem Gemini
+   }
    // ... Groq (voz do clã, PT-BR, cita títulos) → grava chat_logs (igual)
  });
```

Efeito: **o portal responde com conteúdo HOJE**, sem rodar job de embedding e sem
depender do Gemini. Flip para `vector` = `supabase secrets set RAG_MODE=vector`
(+ popular `kb_chunks` e rodar `node scripts/embed-kb.mjs`).

### Propostas (não aplicadas — quando abrir ao público / crescer)

1. **Rate limit** na função `chat` (tabela `portal_rate_limit`: 15/h + cooldown 3s) +
   teto de ~1.000 chars na pergunta.
2. **`chat_cache`** (hash da pergunta normalizada → resposta, TTL) para FAQ — corta Groq.
3. **`match_count=8`** e filtro `source_type` opcional em `match_kb` (modo `vector`).
4. **Hash de conteúdo** nas tabelas-fonte → reembeddar só o que muda (modo `vector`).
5. Subir índice HNSW só quando passar de alguns milhares de vetores (até lá, KNN exato).

---

## 9. Próximos passos para você

1. Deploy: `supabase functions deploy chat` (já fica em `full`, funciona na hora).
   Secrets: `GROQ_API_KEY` (Gemini só é preciso no modo `vector`).
2. Testar: `POST /functions/v1/chat {"question":"Quem é o Goku?"}` → resposta na voz do
   clã citando `(Fonte: Son Goku)`.
3. Cresceu para ~400+ itens? `secrets set RAG_MODE=vector` + popular `kb_chunks` +
   `node scripts/embed-kb.mjs`. O caminho já está pronto.

*Detalhes operacionais (job, deploy, auth) em `RAG-SETUP.md`.*

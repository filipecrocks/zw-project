#!/usr/bin/env node
// scripts/embed-kb.mjs
//
// Job de embeddings do RAG do ZW (roda 1x; idempotente — pode repetir).
// Para cada linha de public.kb_chunks com embedding IS NULL: gera o embedding
// do `content` e dá UPDATE. Em lotes, com retry/backoff.
//
// Reusa a chave de IA que a base do lumaro JÁ tem: GEMINI_API_KEY.
// (O Groq do lumaro só faz geração/LLM — não serve embeddings. A RAG do lumaro
//  hoje é FTS; vetorial "virá depois". Aqui ligamos a parte vetorial do ZW com
//  o modelo de embedding do Google que a chave já existente cobre.)
//
// Modelo: gemini-embedding-001 com outputDimensionality=1536 → casa exatamente
// com kb_chunks.embedding vector(1536). Sem mudança de schema.
//
// Uso (PowerShell):
//   $env:SUPABASE_SERVICE_ROLE_KEY="..."; $env:GEMINI_API_KEY="..."; node scripts/embed-kb.mjs
// Uso (bash):
//   SUPABASE_SERVICE_ROLE_KEY=... GEMINI_API_KEY=... node scripts/embed-kb.mjs
//
// Node 18+ (fetch global). Sem dependências.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xrddqixvhmtertcsevtz.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const EMBED_MODEL = 'gemini-embedding-001';
const DIMS = 1536;            // == vector(1536) da coluna kb_chunks.embedding
const BATCH = 32;            // chunks por chamada de embedding
const MAX_TEXT_CHARS = 8000;  // ~2k tokens; teto de segurança por chunk
const PATCH_CONCURRENCY = 6;  // UPDATEs simultâneos por lote
const REST = `${SUPABASE_URL}/rest/v1`;

if (!SERVICE_ROLE_KEY) fail('Falta SUPABASE_SERVICE_ROLE_KEY (a chave secreta/service_role do projeto ZW).');
if (!GEMINI_API_KEY) fail('Falta GEMINI_API_KEY (mesma chave da base do lumaro).');

function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn, tries = 5) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const wait = Math.min(1000 * 2 ** i, 15000) + Math.floor(Math.random() * 400);
      console.warn(`  … retry ${label} (${i + 1}/${tries}) em ${wait}ms — ${e.message}`);
      await sleep(wait);
    }
  }
  throw new Error(`${label} falhou após ${tries} tentativas: ${lastErr?.message}`);
}

// L2-normaliza (a saída MRL truncada do Gemini não vem normalizada). Não muda o
// ranking por cosseno do pgvector, mas deixa a similaridade correta e canônica.
function l2normalize(v) {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  if (!n) return v;
  return v.map((x) => x / n);
}

async function embedBatch(texts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${GEMINI_API_KEY}`;
  const requests = texts.map((t) => ({
    model: `models/${EMBED_MODEL}`,
    content: { parts: [{ text: t.slice(0, MAX_TEXT_CHARS) }] },
    taskType: 'RETRIEVAL_DOCUMENT',
    outputDimensionality: DIMS,
  }));
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 220)}`);
  const data = await res.json();
  const out = data?.embeddings;
  if (!Array.isArray(out) || out.length !== texts.length) {
    throw new Error(`Resposta de embedding inesperada (esperava ${texts.length}, veio ${out?.length})`);
  }
  return out.map((e) => l2normalize(e.values));
}

async function fetchNullBatch() {
  const url = `${REST}/kb_chunks?select=id,content&embedding=is.null&order=id.asc&limit=${BATCH}`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
  });
  if (!res.ok) throw new Error(`select kb_chunks HTTP ${res.status}: ${(await res.text()).slice(0, 220)}`);
  return res.json();
}

async function patchEmbedding(id, vec) {
  const url = `${REST}/kb_chunks?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    // pgvector aceita o texto "[v1,v2,...]" e faz cast text→vector.
    body: JSON.stringify({ embedding: `[${vec.join(',')}]` }),
  });
  if (!res.ok) throw new Error(`patch id=${id} HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`);
}

async function patchAll(rows, vectors) {
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const k = i++;
      await withRetry(`patch ${rows[k].id}`, () => patchEmbedding(rows[k].id, vectors[k]));
    }
  }
  await Promise.all(Array.from({ length: Math.min(PATCH_CONCURRENCY, rows.length) }, worker));
}

async function main() {
  console.log(`→ Projeto: ${SUPABASE_URL}`);
  console.log(`→ Modelo:  ${EMBED_MODEL} @ ${DIMS} dims (RETRIEVAL_DOCUMENT)\n`);

  let total = 0;
  let lote = 0;
  for (;;) {
    const rows = await withRetry('select pendentes', fetchNullBatch);
    if (rows.length === 0) break;
    lote++;

    const texts = rows.map((r) => (r.content ?? '').toString());
    const vectors = await withRetry(`embed lote ${lote}`, () => embedBatch(texts));
    await patchAll(rows, vectors);

    total += rows.length;
    console.log(`  lote ${lote}: +${rows.length} (total ${total})`);
    await sleep(250); // respiro p/ rate limit
  }

  if (total === 0) console.log('Nada pendente — todos os kb_chunks já têm embedding. ✔');
  else console.log(`\n✔ Pronto: ${total} chunk(s) embeddados.`);
}

main().catch((e) => fail(e.message));

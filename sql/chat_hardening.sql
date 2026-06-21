-- sql/chat_hardening.sql
-- Proteções do chat público do ZW. Rodar UMA vez no SQL Editor do Supabase
-- (projeto xrddqixvhmtertcsevtz). Idempotente.

-- Rate limiting por sessão (15 msgs/h + cooldown 3s). Mesmo padrão do
-- portal-chat do lumaro.
create table if not exists public.portal_rate_limit (
  session_id   text primary key,
  count        int  not null default 0,
  window_start timestamptz not null default now(),
  last_at      timestamptz not null default now()
);
alter table public.portal_rate_limit enable row level security;
-- sem policy pública: só a Edge Function (service_role) acessa.

-- Cache de respostas (hash da pergunta normalizada -> resposta, TTL 24h).
-- Economiza Groq nas perguntas repetidas (ex.: "quem é o Goku").
create table if not exists public.chat_cache (
  question_hash text primary key,
  question      text not null,
  answer        text not null,
  mode          text not null default 'full',
  created_at    timestamptz not null default now()
);
create index if not exists chat_cache_created_idx on public.chat_cache (created_at desc);
alter table public.chat_cache enable row level security;
-- sem policy pública: só a Edge Function (service_role) acessa.

-- (opcional) limpeza do cache vencido — rode manualmente ou agende:
-- delete from public.chat_cache where created_at < now() - interval '24 hours';

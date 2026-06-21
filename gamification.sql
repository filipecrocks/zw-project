-- gamification.sql — gamificação + referidos do ZW. Rodar UMA vez no SQL Editor
-- (projeto xrddqixvhmtertcsevtz). Idempotente. Mesma tabela profiles do portal+Arena.
--
-- Regra de ouro: CONCEDER badge e CREDITAR zenny só via SERVIDOR (service_role).
-- Por isso user_badges/referrals/zenny NÃO têm policy de escrita pública — só a
-- Edge Function (service role) escreve. O cliente só LÊ.

-- ── profiles: colunas de gamificação ───────────────────────────────────────
alter table public.profiles add column if not exists zenny         int  not null default 0;
alter table public.profiles add column if not exists reads         int  not null default 0;
alter table public.profiles add column if not exists referral_code text;
-- código de referido único (gerado pra quem não tiver)
update public.profiles set referral_code = upper(substr(md5(id::text || random()::text), 1, 8))
  where referral_code is null;
alter table public.profiles alter column referral_code set not null;
create unique index if not exists profiles_referral_code_idx on public.profiles (referral_code);

-- ── joia (like) e salvar (save) ─────────────────────────────────────────────
create table if not exists public.content_interactions (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  content_type text not null,                 -- character|episode|saga|technique|curiosity
  content_id   text not null,
  kind         text not null check (kind in ('like','save')),
  created_at   timestamptz not null default now(),
  unique (user_id, content_type, content_id, kind)
);
alter table public.content_interactions enable row level security;
create index if not exists ci_content_idx on public.content_interactions (content_type, content_id, kind);
-- joias legíveis por todos (pra contagem); save é privado do usuário
drop policy if exists ci_select on public.content_interactions;
create policy ci_select on public.content_interactions for select
  using (kind = 'like' or auth.uid() = user_id);
drop policy if exists ci_insert_own on public.content_interactions;
create policy ci_insert_own on public.content_interactions for insert
  with check (auth.uid() = user_id);
drop policy if exists ci_delete_own on public.content_interactions;
create policy ci_delete_own on public.content_interactions for delete
  using (auth.uid() = user_id);

-- ── atividade diária / streak / leituras ────────────────────────────────────
create table if not exists public.user_activity (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default current_date,
  reads   int  not null default 0,
  primary key (user_id, day)
);
alter table public.user_activity enable row level security;
drop policy if exists ua_own on public.user_activity;
create policy ua_own on public.user_activity for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── catálogo de badges ──────────────────────────────────────────────────────
create table if not exists public.badges (
  id          text primary key,
  name        text not null,
  description text,
  icon        text,
  sort        int  not null default 0
);
alter table public.badges enable row level security;
drop policy if exists badges_read on public.badges;
create policy badges_read on public.badges for select using (true);

insert into public.badges (id,name,description,icon,sort) values
  ('first_day','Primeiro dia','Sua primeira visita ao portal.','🌅',1),
  ('read_10','Leitor iniciante','Leu 10 conteúdos.','📖',2),
  ('read_50','Leitor dedicado','Leu 50 conteúdos.','📚',3),
  ('read_150','Erudito Z','Leu 150 conteúdos.','🧠',4),
  ('streak_7','Constância SSJ','7 dias seguidos de visita.','🔥',5),
  ('streak_30','Constância SSJ3','30 dias seguidos de visita.','🌟',6),
  ('all_curiosities','Caçador de curiosidades','Leu todas as curiosidades.','🔎',7),
  ('save_10','Colecionador','Salvou 10 itens.','💾',8),
  ('like_10','Energia positiva','Deu 10 joias.','💎',9),
  ('ref_1','Recrutador','Trouxe 1 amigo pro clã.','🤝',10),
  ('ref_5','Líder de esquadrão','Trouxe 5 amigos.','🛡️',11),
  ('ref_20','Comandante Z','Trouxe 20 amigos.','👑',12)
on conflict (id) do nothing;

-- ── badges concedidos (escrita só via service_role) ─────────────────────────
create table if not exists public.user_badges (
  user_id    uuid not null references auth.users(id) on delete cascade,
  badge_id   text not null references public.badges(id),
  awarded_at timestamptz not null default now(),
  primary key (user_id, badge_id)
);
alter table public.user_badges enable row level security;
drop policy if exists ub_read on public.user_badges;
create policy ub_read on public.user_badges for select using (true);
-- sem policy de INSERT: só a Edge Function (service_role) concede.

-- ── referidos (escrita só via service_role; anti-abuso) ─────────────────────
create table if not exists public.referrals (
  id          bigint generated always as identity primary key,
  referrer_id uuid not null references auth.users(id) on delete cascade,
  referred_id uuid not null unique references auth.users(id) on delete cascade,  -- conta 1x
  created_at  timestamptz not null default now(),
  check (referrer_id <> referred_id)          -- não pode indicar a si mesmo
);
alter table public.referrals enable row level security;
drop policy if exists ref_read on public.referrals;
create policy ref_read on public.referrals for select
  using (auth.uid() = referrer_id or auth.uid() = referred_id);
-- sem policy de INSERT: só a Edge Function (service_role) registra e credita zenny.

-- Recompensas sugeridas (aplicadas pela Edge Function, não aqui):
--   referrer: +100 zenny por amigo · novo usuário: +50 de boas-vindas
--   badges de referido em 1 / 5 / 20 amigos.

-- ZW Arena — schema do banco (profiles + matches) com RLS
-- Como rodar: Supabase → SQL Editor → New query → cole tudo → Run.
-- Idempotente: pode rodar de novo sem quebrar.

-- ========================= PROFILES =========================
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  nick       text,
  wins       int  not null default 0,
  losses     int  not null default 0,
  level      int  not null default 0,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Ranking visível para todos (inclusive convidados / anon)
drop policy if exists "profiles_select_public" on public.profiles;
create policy "profiles_select_public"
  on public.profiles for select
  using (true);

-- Cada usuário cria apenas o próprio perfil
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

-- Cada usuário edita apenas o próprio perfil
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create index if not exists profiles_wins_idx on public.profiles (wins desc);

-- ========================= MATCHES =========================
create table if not exists public.matches (
  id          uuid primary key default gen_random_uuid(),
  room        text,
  winner_nick text,
  loser_nick  text,
  turns       int,
  created_at  timestamptz not null default now()
);

alter table public.matches enable row level security;

-- Histórico legível por todos
drop policy if exists "matches_select_public" on public.matches;
create policy "matches_select_public"
  on public.matches for select
  using (true);

-- Só usuários autenticados registram partidas
drop policy if exists "matches_insert_auth" on public.matches;
create policy "matches_insert_auth"
  on public.matches for insert
  to authenticated
  with check (true);

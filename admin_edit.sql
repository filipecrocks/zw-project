-- admin_edit.sql — edição de conteúdo pelo front, só pra admins. Rodar UMA vez.
-- Segurança no banco (RLS): mesmo forçando a UI, só admin escreve.

create table if not exists public.admins ( email text primary key );
insert into public.admins(email) values
  ('cleber@netcks.com'), ('rafael@netcks.com'), ('filipe@netcks.com')
on conflict (email) do nothing;
alter table public.admins enable row level security;  -- sem policy pública: ninguém lê a lista

-- true se o e-mail do usuário logado está em admins
create or replace function public.is_zw_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins a where a.email = (auth.jwt() ->> 'email'));
$$;
grant execute on function public.is_zw_admin() to anon, authenticated;

-- pra cada tabela de conteúdo: garante leitura pública + UPDATE só de admin.
-- (idempotente; nomes de policy próprios pra não conflitar com os existentes)
do $$
declare t text;
begin
  foreach t in array array['series','characters','episodes','sagas','techniques','curiosities']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t||'_read_all', t);
    execute format('create policy %I on public.%I for select using (true)', t||'_read_all', t);
    execute format('drop policy if exists %I on public.%I', t||'_admin_update', t);
    execute format('create policy %I on public.%I for update using (public.is_zw_admin()) with check (public.is_zw_admin())', t||'_admin_update', t);
  end loop;
end $$;

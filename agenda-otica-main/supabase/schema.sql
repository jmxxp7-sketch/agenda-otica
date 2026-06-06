create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'app_role') then
    create type public.app_role as enum ('admin', 'store');
  end if;
end $$;

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  login_nick text not null unique,
  auth_email text not null unique,
  color text not null default '#2563eb',
  opening_time time not null default '09:00',
  closing_time time not null default '13:00',
  slot_minutes integer not null default 30 check (slot_minutes in (15, 30, 45, 60)),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stores' and column_name = 'login_email'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stores' and column_name = 'auth_email'
  ) then
    alter table public.stores rename column login_email to auth_email;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stores' and column_name = 'login_nick'
  ) then
    alter table public.stores add column login_nick text;
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'stores' and column_name = 'auth_email'
  ) then
    alter table public.stores add column auth_email text;
  end if;
end $$;

update public.stores
set login_nick = split_part(auth_email, '@', 1)
where login_nick is null and auth_email is not null;

update public.stores
set auth_email = login_nick || '@agenda.local'
where auth_email is null and login_nick is not null;

alter table public.stores alter column login_nick set not null;
alter table public.stores alter column auth_email set not null;
create unique index if not exists stores_login_nick_unique_idx on public.stores(login_nick);
create unique index if not exists stores_auth_email_unique_idx on public.stores(auth_email);
alter table public.stores alter column opening_time set default '09:00';
alter table public.stores alter column closing_time set default '13:00';
alter table public.stores alter column slot_minutes set default 30;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null,
  store_id uuid references public.stores(id) on delete set null,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_profile_requires_store check (
    (role = 'admin' and store_id is null)
    or (role = 'store' and store_id is not null)
  )
);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  phone text not null,
  email text,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, phone)
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  client_name text not null,
  client_phone text not null,
  date date not null,
  time time not null,
  notes text,
  status text not null default 'scheduled' check (status in ('scheduled', 'done', 'cancelled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, date, time)
);

create index if not exists idx_profiles_store on public.profiles(store_id);
create index if not exists idx_clients_store on public.clients(store_id);
create index if not exists idx_appointments_date on public.appointments(date);
create index if not exists idx_appointments_store_date on public.appointments(store_id, date);

create schema if not exists app_private;

create or replace function app_private.is_admin(check_user uuid default auth.uid())
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.profiles
    where id = check_user
      and role = 'admin'
  );
$$;

create or replace function app_private.user_store(check_user uuid default auth.uid())
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select store_id
  from public.profiles
  where id = check_user;
$$;

create or replace function app_private.has_profiles()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.profiles);
$$;

create or replace function app_private.admin_update_store_impl(
  p_store_id uuid,
  p_name text,
  p_login_nick text,
  p_password text,
  p_color text
)
returns public.stores
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  target_profile public.profiles;
  clean_nick text;
  new_email text;
  updated_store public.stores;
begin
  if not app_private.is_admin() then
    raise exception 'Apenas administradores podem editar lojas';
  end if;

  clean_nick := regexp_replace(lower(trim(coalesce(p_login_nick, ''))), '[^a-z0-9._-]+', '-', 'g');
  clean_nick := regexp_replace(clean_nick, '(^[-.]+|[-.]+$)', '', 'g');

  if length(trim(coalesce(p_name, ''))) = 0 or length(clean_nick) < 3 then
    raise exception 'Informe nome e nick com pelo menos 3 caracteres';
  end if;

  if p_password is not null and length(p_password) > 0 and length(p_password) < 6 then
    raise exception 'A senha precisa ter pelo menos 6 caracteres';
  end if;

  select *
  into target_profile
  from public.profiles
  where store_id = p_store_id and role = 'store'
  limit 1;

  if target_profile.id is null then
    raise exception 'Perfil da loja nao encontrado';
  end if;

  new_email := clean_nick || '@agenda.local';

  if exists (
    select 1
    from public.stores
    where id <> p_store_id
      and (login_nick = clean_nick or auth_email = new_email)
  ) then
    raise exception 'Este nick ja esta em uso';
  end if;

  update auth.users
  set
    email = new_email,
    encrypted_password = case
      when p_password is not null and length(p_password) > 0
        then crypt(p_password, gen_salt('bf'))
      else encrypted_password
    end,
    raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object('name', trim(p_name), 'nick', clean_nick),
    email_confirmed_at = coalesce(email_confirmed_at, now()),
    confirmation_token = '',
    confirmation_sent_at = null,
    updated_at = now()
  where id = target_profile.id;

  update auth.identities
  set
    provider_id = new_email,
    identity_data = coalesce(identity_data, '{}'::jsonb)
      || jsonb_build_object(
        'sub', target_profile.id::text,
        'email', new_email,
        'email_verified', true,
        'phone_verified', false
      ),
    updated_at = now()
  where user_id = target_profile.id
    and provider = 'email';

  update public.profiles
  set full_name = trim(p_name)
  where id = target_profile.id;

  update public.stores
  set
    name = trim(p_name),
    login_nick = clean_nick,
    auth_email = new_email,
    color = coalesce(nullif(p_color, ''), color)
  where id = p_store_id
  returning * into updated_store;

  return updated_store;
end;
$$;

create or replace function public.admin_update_store(
  p_store_id uuid,
  p_name text,
  p_login_nick text,
  p_password text default null,
  p_color text default null
)
returns public.stores
language sql
security invoker
set search_path = public
as $$
  select app_private.admin_update_store_impl(p_store_id, p_name, p_login_nick, p_password, p_color);
$$;

grant usage on schema app_private to authenticated;
grant execute on function app_private.is_admin(uuid) to authenticated;
grant execute on function app_private.user_store(uuid) to authenticated;
grant execute on function app_private.has_profiles() to authenticated;
grant execute on function app_private.admin_update_store_impl(uuid, text, text, text, text) to authenticated;
grant execute on function public.admin_update_store(uuid, text, text, text, text) to authenticated;

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_stores_updated_at on public.stores;
create trigger touch_stores_updated_at
before update on public.stores
for each row execute function public.touch_updated_at();

drop trigger if exists touch_profiles_updated_at on public.profiles;
create trigger touch_profiles_updated_at
before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists touch_clients_updated_at on public.clients;
create trigger touch_clients_updated_at
before update on public.clients
for each row execute function public.touch_updated_at();

drop trigger if exists touch_appointments_updated_at on public.appointments;
create trigger touch_appointments_updated_at
before update on public.appointments
for each row execute function public.touch_updated_at();

alter table public.stores enable row level security;
alter table public.profiles enable row level security;
alter table public.clients enable row level security;
alter table public.appointments enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.stores to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.clients to authenticated;
grant select, insert, update, delete on public.appointments to authenticated;

drop policy if exists "Stores are visible to authenticated users" on public.stores;
create policy "Stores are visible to authenticated users"
on public.stores
for select
to authenticated
using (active = true or app_private.is_admin());

drop policy if exists "Admins manage stores" on public.stores;
create policy "Admins manage stores"
on public.stores
for all
to authenticated
using (app_private.is_admin())
with check (app_private.is_admin());

drop policy if exists "Users see their own profile or admins see all" on public.profiles;
create policy "Users see their own profile or admins see all"
on public.profiles
for select
to authenticated
using (id = (select auth.uid()) or app_private.is_admin());

drop policy if exists "Bootstrap first admin profile" on public.profiles;
create policy "Bootstrap first admin profile"
on public.profiles
for insert
to authenticated
with check (
  id = (select auth.uid())
  and role = 'admin'
  and store_id is null
  and not app_private.has_profiles()
);

drop policy if exists "Admins manage profiles" on public.profiles;
create policy "Admins manage profiles"
on public.profiles
for all
to authenticated
using (app_private.is_admin())
with check (app_private.is_admin());

drop policy if exists "Clients visible by admin or own store" on public.clients;
create policy "Clients visible by admin or own store"
on public.clients
for select
to authenticated
using (true);

drop policy if exists "Clients inserted by admin or own store" on public.clients;
create policy "Clients inserted by admin or own store"
on public.clients
for insert
to authenticated
with check (app_private.is_admin() or store_id = app_private.user_store());

drop policy if exists "Clients updated by admin or own store" on public.clients;
create policy "Clients updated by admin or own store"
on public.clients
for update
to authenticated
using (app_private.is_admin() or store_id = app_private.user_store())
with check (app_private.is_admin() or store_id = app_private.user_store());

drop policy if exists "Appointments visible to authenticated users" on public.appointments;
create policy "Appointments visible to authenticated users"
on public.appointments
for select
to authenticated
using (true);

drop policy if exists "Appointments inserted by admin or own store" on public.appointments;
create policy "Appointments inserted by admin or own store"
on public.appointments
for insert
to authenticated
with check (app_private.is_admin() or store_id = app_private.user_store());

drop policy if exists "Appointments updated by admin or own store" on public.appointments;
create policy "Appointments updated by admin or own store"
on public.appointments
for update
to authenticated
using (app_private.is_admin() or store_id = app_private.user_store())
with check (app_private.is_admin() or store_id = app_private.user_store());

drop policy if exists "Appointments deleted by admin or own store" on public.appointments;
create policy "Appointments deleted by admin or own store"
on public.appointments
for delete
to authenticated
using (app_private.is_admin() or store_id = app_private.user_store());

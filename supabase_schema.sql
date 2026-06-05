-- ============================================================
-- Servis Takip Sistemi — Supabase şeması
-- Supabase Auth (e-posta + şifre) + profiles/companies/members/services
-- RLS (satır güvenliği) ile her kullanıcı yalnızca kendi şirketlerini görür
-- ============================================================

-- ---------- TABLOLAR ----------

create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  username     text,
  display_name text default '',
  phone        text default '',
  created_at   timestamptz default now()
);

create table if not exists public.companies (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz default now()
);
create index if not exists companies_owner_idx on public.companies(owner_id);

create table if not exists public.members (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  role         text not null check (role in ('owner','usta')),
  username     text,
  display_name text,
  phone        text,
  created_at   timestamptz default now(),
  unique (company_id, user_id)
);
create index if not exists members_company_idx on public.members(company_id);
create index if not exists members_user_idx on public.members(user_id);

create table if not exists public.services (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references public.companies(id) on delete cascade,
  customer_name   text not null,
  customer_phone  text not null,
  address         text default '',
  problem         text not null,
  status          text not null default 'open'
                    check (status in ('open','assigned','enroute','completed','closed')),
  assigned_user_id uuid references public.profiles(id) on delete set null,
  assigned_name   text,
  assigned_phone  text,
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz default now(),
  assigned_at     timestamptz,
  enroute_at      timestamptz,
  closed_at       timestamptz,
  completion      jsonb,   -- { description, amount, photos[], completedAt, completedBy }
  payment         jsonb    -- { amount, method, collectedAt }
);
create index if not exists services_company_idx on public.services(company_id);
create index if not exists services_assigned_idx on public.services(assigned_user_id);

-- ---------- YENİ KULLANICI → otomatik profil ----------
-- Kayıt (signUp) olunca auth.users'a satır eklenir; bu tetikleyici
-- otomatik olarak profiles satırını oluşturur. Böylece patron, ustanın
-- hesabını açtığında profil de kendiliğinden oluşur.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, username, display_name, phone)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data->>'display_name', ''),
    coalesce(new.raw_user_meta_data->>'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- YARDIMCI FONKSİYONLAR (RLS özyinelemesini önler) ----------

create or replace function public.is_company_member(cid uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.members m
    where m.company_id = cid and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_company_owner(cid uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.companies c
    where c.id = cid and c.owner_id = auth.uid()
  );
$$;

-- ---------- RLS'İ AÇ ----------
alter table public.profiles  enable row level security;
alter table public.companies enable row level security;
alter table public.members   enable row level security;
alter table public.services  enable row level security;

-- ---------- PROFILES politikaları ----------
-- Giriş yapmış herkes profilleri görebilir (usta eklerken e-postayla bulmak için).
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ---------- COMPANIES politikaları ----------
-- Patron, üyelik satırı oluşmadan önce de (insert RETURNING) kendi şirketini görebilmeli.
drop policy if exists companies_select on public.companies;
create policy companies_select on public.companies
  for select to authenticated using (public.is_company_member(id) or owner_id = auth.uid());

drop policy if exists companies_insert on public.companies;
create policy companies_insert on public.companies
  for insert to authenticated with check (owner_id = auth.uid());

drop policy if exists companies_update on public.companies;
create policy companies_update on public.companies
  for update to authenticated using (owner_id = auth.uid());

drop policy if exists companies_delete on public.companies;
create policy companies_delete on public.companies
  for delete to authenticated using (owner_id = auth.uid());

-- ---------- MEMBERS politikaları ----------
-- Şirketin üyeleri birbirini görebilir. (user_id = auth.uid() koşulu, yeni
-- üyelik eklenirken insert RETURNING'in çalışması için gerekli.)
drop policy if exists members_select on public.members;
create policy members_select on public.members
  for select to authenticated using (user_id = auth.uid() or public.is_company_member(company_id));

-- Şirketi kuran kişi kendini owner olarak ekleyebilir; patron usta ekleyebilir.
drop policy if exists members_insert on public.members;
create policy members_insert on public.members
  for insert to authenticated
  with check (public.is_company_owner(company_id) or user_id = auth.uid());

drop policy if exists members_delete on public.members;
create policy members_delete on public.members
  for delete to authenticated using (public.is_company_owner(company_id));

-- ---------- SERVICES politikaları ----------
drop policy if exists services_select on public.services;
create policy services_select on public.services
  for select to authenticated using (public.is_company_member(company_id));

drop policy if exists services_insert on public.services;
create policy services_insert on public.services
  for insert to authenticated with check (public.is_company_member(company_id));

drop policy if exists services_update on public.services;
create policy services_update on public.services
  for update to authenticated using (public.is_company_member(company_id));

drop policy if exists services_delete on public.services;
create policy services_delete on public.services
  for delete to authenticated using (public.is_company_owner(company_id));

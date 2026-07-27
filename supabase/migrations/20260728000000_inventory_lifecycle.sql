-- Run after 002_shared-account-security.sql.
-- Adds lot shelf-life metadata and one lifecycle row per opened package/unit.

alter table public.inventory_receipts
  add column if not exists expires_on date,
  add column if not exists shelf_life_hours numeric,
  add column if not exists storage_location text not null default 'Chưa ghi';

alter table public.inventory_receipts
  drop constraint if exists inventory_receipts_shelf_life_hours_check;

alter table public.inventory_receipts
  add constraint inventory_receipts_shelf_life_hours_check
  check (shelf_life_hours is null or shelf_life_hours > 0);

create table if not exists public.inventory_active_sessions (
  id uuid primary key default gen_random_uuid(),
  source_receipt_id uuid not null references public.inventory_receipts(id) on delete restrict,
  ingredient_key text not null,
  activated_at timestamptz not null default now(),
  use_by timestamptz,
  status text not null default 'active' check (status in ('active', 'used', 'wasted')),
  closed_at timestamptz,
  reason text not null default 'first_open',
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'active' and closed_at is null) or (status <> 'active' and closed_at is not null))
);

create index if not exists inventory_active_sessions_source_idx
  on public.inventory_active_sessions(source_receipt_id);

create index if not exists inventory_active_sessions_status_use_by_idx
  on public.inventory_active_sessions(status, use_by);

alter table public.inventory_active_sessions enable row level security;

drop policy if exists "shared staff can manage active inventory" on public.inventory_active_sessions;
create policy "shared staff can manage active inventory"
on public.inventory_active_sessions for all to authenticated
using (true) with check (true);

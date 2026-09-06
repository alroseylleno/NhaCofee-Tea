-- Store manual GRAB order reconciliation in Supabase so Production users see
-- the same actual-received ledger across devices.

create table if not exists public.finance_grab_reconciliations (
  id text primary key,
  platform_order_id text,
  order_code text not null,
  order_date date not null,
  reported_amount numeric not null default 0 check (reported_amount >= 0),
  received_amount numeric not null default 0 check (received_amount >= 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.finance_grab_reconciliations
  add column if not exists platform_order_id text;

-- The discount stack behind SAPO's single "Tổng giảm giá" figure, captured per
-- order during đối soát: [{"label": "...", "amount": 0}, ...].
alter table public.finance_grab_reconciliations
  add column if not exists discounts jsonb not null default '[]'::jsonb;

-- Per-order settlement snapshot from Grab's daily PDF report plus the editable
-- counter-price used by the "so với giá quầy" comparison.
alter table public.finance_grab_reconciliations
  add column if not exists settlement jsonb,
  add column if not exists counter_price numeric;

-- One row per Grab daily PDF report: day-level marketing spend and the match
-- outcome, powering the marketing dashboards.
create table if not exists public.finance_grab_daily_reports (
  id text primary key,
  report_date date not null unique,
  file_name text,
  imported_at timestamptz not null default now(),
  order_count integer not null default 0,
  matched_count integer not null default 0,
  total_order_value numeric not null default 0,
  total_expected_sapo numeric not null default 0,
  total_payout numeric not null default 0,
  total_marketing numeric not null default 0,
  marketing_lines jsonb not null default '[]'::jsonb,
  unmatched jsonb not null default '[]'::jsonb
);

alter table public.finance_grab_daily_reports enable row level security;
revoke all on table public.finance_grab_daily_reports from anon;
grant select, insert, update, delete on table public.finance_grab_daily_reports to authenticated;

drop policy if exists "authenticated staff can manage grab daily reports" on public.finance_grab_daily_reports;
create policy "authenticated staff can manage grab daily reports"
on public.finance_grab_daily_reports for all to authenticated
using (true)
with check (true);

create index if not exists finance_grab_reconciliations_order_date_idx
  on public.finance_grab_reconciliations (order_date desc);

create unique index if not exists finance_grab_reconciliations_order_code_date_idx
  on public.finance_grab_reconciliations (lower(order_code), order_date);

alter table public.finance_grab_reconciliations enable row level security;

revoke all on table public.finance_grab_reconciliations from anon;
grant select, insert, update, delete on table public.finance_grab_reconciliations to authenticated;

drop policy if exists "authenticated staff can manage finance grab reconciliations" on public.finance_grab_reconciliations;
create policy "authenticated staff can manage finance grab reconciliations"
on public.finance_grab_reconciliations for all to authenticated
using (true)
with check (true);

notify pgrst, 'reload schema';

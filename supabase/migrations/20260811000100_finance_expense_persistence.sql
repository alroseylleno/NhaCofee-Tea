-- Manual finance expenses were previously browser-local. Store them in
-- Supabase so authenticated Production users share one expense ledger.

create table if not exists public.finance_expenses (
  id text primary key,
  name text not null,
  category text not null check (category in ('fixed', 'operating', 'sales', 'investment')),
  subcategory text not null default 'Khác',
  amount numeric not null check (amount > 0),
  incurred_on date not null,
  recurrence text not null check (recurrence in ('once', 'weekly', 'monthly', 'quarterly', 'yearly')),
  payment_status text not null check (payment_status in ('unpaid', 'partial', 'paid')),
  payment_date date,
  invoice_code text,
  vendor text,
  note text,
  useful_life_months integer check (useful_life_months is null or useful_life_months > 0),
  salvage_value numeric check (salvage_value is null or salvage_value >= 0),
  in_service_on date,
  status text not null default 'active' check (status in ('active', 'voided')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists finance_expenses_incurred_on_idx
  on public.finance_expenses (incurred_on desc);

alter table public.finance_expenses enable row level security;

revoke all on table public.finance_expenses from anon;
grant select, insert, update, delete on table public.finance_expenses to authenticated;

drop policy if exists "authenticated staff can manage finance expenses" on public.finance_expenses;
create policy "authenticated staff can manage finance expenses"
on public.finance_expenses for all to authenticated
using (true)
with check (true);

notify pgrst, 'reload schema';

-- Keep the operational open timestamp separate from the accounting month used
-- to recognize the inventory issue in Finance.

alter table public.inventory_active_sessions
  add column if not exists cost_recognition_month date;

update public.inventory_active_sessions
set cost_recognition_month = date_trunc('month', activated_at)::date
where cost_recognition_month is null;

alter table public.inventory_active_sessions
  alter column cost_recognition_month set default date_trunc('month', now())::date,
  alter column cost_recognition_month set not null;

alter table public.inventory_active_sessions
  drop constraint if exists inventory_active_sessions_cost_recognition_month_check;

alter table public.inventory_active_sessions
  add constraint inventory_active_sessions_cost_recognition_month_check
  check (cost_recognition_month = date_trunc('month', cost_recognition_month)::date);

create index if not exists inventory_active_sessions_cost_month_idx
  on public.inventory_active_sessions(cost_recognition_month, status);

notify pgrst, 'reload schema';

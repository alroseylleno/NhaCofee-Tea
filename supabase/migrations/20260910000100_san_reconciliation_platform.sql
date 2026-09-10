-- Extend the Grab reconciliation storage to every sàn (ShopeeFood, GreenSM)
-- without renaming anything: a `platform` column tags each row, defaulting to
-- 'grab' so existing data keeps meaning what it always meant.
--
-- finance_grab_daily_reports carried UNIQUE(report_date), which was correct
-- while Grab was the only reporter — with three sàn reporting the same day the
-- uniqueness must be per (platform, report_date).

alter table public.finance_grab_reconciliations
  add column if not exists platform text not null default 'grab';

alter table public.finance_grab_daily_reports
  add column if not exists platform text not null default 'grab';

alter table public.finance_grab_daily_reports
  drop constraint if exists finance_grab_daily_reports_report_date_key;

create unique index if not exists finance_grab_daily_reports_platform_date_idx
  on public.finance_grab_daily_reports (platform, report_date);

create index if not exists finance_grab_reconciliations_platform_idx
  on public.finance_grab_reconciliations (platform);

notify pgrst, 'reload schema';

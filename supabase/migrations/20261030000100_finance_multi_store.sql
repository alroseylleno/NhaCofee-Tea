-- Tài chính đa điểm: Finance reads every number per điểm bán (N1, N2) or for
-- the whole chain.
--
-- Additive except one guarded data fix. The app derives most of the store
-- split itself:
--   * a SAPO order's store comes from its Khu vực / Thu ngân (rules kept on
--     `stores`), or from the sàn merchant that settled it, or from a manual
--     assignment;
--   * NVL cost follows the kho of the lot; transfers are read back from
--     inventory_history, which transfer_inventory already writes for every
--     move, so no inventory schema changes here.
--
-- What has to live in the database:
--   1. stores: kind (outlet / warehouse), opening date, the SAPO signals and
--      the sàn merchant accounts of each store;
--   2. finance_expenses.store_id — NULL means "Toàn chuỗi" (shared cost);
--   3. counter (non-sàn) invoices, which the import used to throw away, plus
--      the Khu vực / Thu ngân columns on every imported invoice;
--   4. manual order → store assignments, which no import ever touches;
--   5. a store on every sàn daily report, so a second Grab/Shopee/GreenSM
--      merchant can report the same day without overwriting the first, and the
--      full per-order settlement for merchants whose orders never reach SAPO.

-- 1. Store configuration ------------------------------------------------------

alter table public.stores
  add column if not exists kind text not null default 'outlet',
  add column if not exists opened_on date,
  add column if not exists sapo_areas text[] not null default '{}',
  add column if not exists sapo_cashiers text[] not null default '{}',
  add column if not exists platform_accounts jsonb not null default '[]'::jsonb;

alter table public.stores drop constraint if exists stores_kind_check;
alter table public.stores
  add constraint stores_kind_check check (kind in ('outlet', 'warehouse'));

alter table public.stores drop constraint if exists stores_platform_accounts_check;
alter table public.stores
  add constraint stores_platform_accounts_check check (jsonb_typeof(platform_accounts) = 'array');

-- Seed what Production already shows (checked 2026-10-29/30). Each statement is
-- a no-op where the store code does not exist, and never overwrites a store
-- whose configuration was already edited in the app.
update public.stores
set sapo_areas = array['NHÀ 01', 'Tại NHÀ'],
    -- The owner account sells at N1 when no Khu vực is picked (Long, 30/10).
    sapo_cashiers = array['NHÀ 01', 'NHÀ Coffee & Tea'],
    platform_accounts = jsonb_build_array(
      jsonb_build_object('platform', 'grab', 'merchantId', '5-C8BGGY6BV2V3RE', 'name', 'Nhà Coffee&Tea - Hàn Hải Nguyên', 'inSapo', true),
      jsonb_build_object('platform', 'shopee', 'merchantId', '10419674', 'name', 'Nhà Coffee & Tea - Hàn Hải Nguyên', 'inSapo', true),
      jsonb_build_object('platform', 'greensm', 'merchantId', '01KW6QK7GYCY10CYWA32ND0KYF', 'name', 'Nhà Coffee & Tea - Hàn Hải Nguyên', 'inSapo', true)
    ),
    updated_at = now()
where code = 'NHA-31-7'
  and platform_accounts = '[]'::jsonb
  and sapo_areas = '{}';

-- N2 opened 10/10/2026 ("N2 - Cúng khai trương", first NHÀ 02 invoice). Its
-- sàn stores are NOT linked to SAPO: their orders exist only in the sàn reports.
update public.stores
set opened_on = date '2026-10-10',
    sapo_areas = array['NHÀ 02'],
    sapo_cashiers = array['NHÀ 02'],
    platform_accounts = jsonb_build_array(
      jsonb_build_object('platform', 'shopee', 'merchantId', '10439891', 'name', 'NHÀ - Coffee & Tea - Trương Phước Phan', 'inSapo', false)
    ),
    updated_at = now()
where code = 'KHO-2'
  and platform_accounts = '[]'::jsonb
  and sapo_areas = '{}';

-- KHO TỔNG: central stock, never sells.
update public.stores
set kind = 'warehouse', updated_at = now()
where code = 'KHO-3' and kind = 'outlet';

-- 2. Expenses ---------------------------------------------------------------

alter table public.finance_expenses
  add column if not exists store_id uuid references public.stores(id);

create index if not exists finance_expenses_store_idx
  on public.finance_expenses (store_id);

-- Long, 30/10/2026: a cost whose name starts with "N2 -" / "N2-" is N2's.
-- Six on Production (713.800đ: cúng khai trương, cúng M2, poster menu,
-- danh thiếp, công thức nước ×2). Everything else stays Toàn chuỗi until it is
-- moved by hand — including "Phí vận chuyển N1->N2", which is the internal
-- transfer cost Long keeps as a chain cost.
update public.finance_expenses as expense
set store_id = store.id, updated_at = now()
from public.stores as store
where store.code = 'KHO-2'
  and expense.store_id is null
  and expense.name ~* '^\s*N2\s*-';

-- 3. Invoices ---------------------------------------------------------------

alter table public.finance_platform_order_rows
  add column if not exists sapo_area text,
  add column if not exists sapo_cashier text;

-- No non-negative checks here on purpose: these rows only split revenue by
-- store, and one odd counter invoice (a refund, a manual adjustment) must
-- never abort the whole SAPO bundle import the nightly job depends on.
create table if not exists public.finance_counter_order_rows (
  id text primary key,
  order_code text not null,
  order_date date not null,
  channel_name text not null default 'Tại nhà hàng',
  reported_amount numeric not null default 0,
  order_created_at timestamp without time zone,
  paid_at timestamp without time zone,
  goods_amount numeric not null default 0,
  discount_amount numeric not null default 0,
  service_fee numeric not null default 0,
  delivery_fee numeric not null default 0,
  tip_amount numeric not null default 0,
  refund_amount numeric not null default 0,
  payment_method text,
  service_type text,
  delivery_partner text,
  status text,
  source_file_name text,
  imported_at timestamptz not null default now(),
  items jsonb not null default '[]'::jsonb,
  sapo_area text,
  sapo_cashier text
);

create index if not exists finance_counter_order_rows_order_date_idx
  on public.finance_counter_order_rows (order_date desc);

alter table public.finance_counter_order_rows enable row level security;
revoke all on table public.finance_counter_order_rows from anon;
grant select, insert, update, delete on table public.finance_counter_order_rows to authenticated;
drop policy if exists "authenticated staff can manage finance counter order rows" on public.finance_counter_order_rows;
create policy "authenticated staff can manage finance counter order rows"
on public.finance_counter_order_rows for all to authenticated
using (true)
with check (true);

-- The platform import now carries Khu vực / Thu ngân. Same replace-by-period
-- semantics as 20260815000100.
create or replace function public.replace_finance_platform_order_import(
  p_file_name text,
  p_period_start date,
  p_period_end date,
  p_rows jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end then
    raise exception 'Invalid platform order import period';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'Platform order import must contain at least one row';
  end if;

  delete from public.finance_platform_order_rows
  where order_date between p_period_start and p_period_end;

  insert into public.finance_platform_order_rows (
    id, order_code, order_date, channel_name, reported_amount, order_created_at,
    paid_at, goods_amount, discount_amount, service_fee, delivery_fee,
    tip_amount, refund_amount, payment_method, service_type, delivery_partner,
    status, source_file_name, imported_at, items, sapo_area, sapo_cashier
  )
  select
    row_data.id, row_data.order_code, row_data.order_date, row_data.channel_name,
    row_data.reported_amount, row_data.order_created_at, row_data.paid_at,
    row_data.goods_amount, row_data.discount_amount, row_data.service_fee,
    row_data.delivery_fee, row_data.tip_amount, row_data.refund_amount,
    row_data.payment_method, row_data.service_type, row_data.delivery_partner,
    row_data.status, row_data.source_file_name, coalesce(row_data.imported_at, now()),
    coalesce(row_data.items, '[]'::jsonb), row_data.sapo_area, row_data.sapo_cashier
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row_data(
    id text, order_code text, order_date date, channel_name text,
    reported_amount numeric, order_created_at timestamp without time zone,
    paid_at timestamp without time zone, goods_amount numeric,
    discount_amount numeric, service_fee numeric, delivery_fee numeric,
    tip_amount numeric, refund_amount numeric, payment_method text,
    service_type text, delivery_partner text, status text,
    source_file_name text, imported_at timestamptz, items jsonb,
    sapo_area text, sapo_cashier text
  );

  insert into public.finance_imports (
    data_type, file_name, period_start, period_end, row_count, imported_at, imported_by
  ) values (
    'orders', p_file_name, p_period_start, p_period_end,
    jsonb_array_length(coalesce(p_rows, '[]'::jsonb)), now(), auth.uid()
  )
  on conflict (data_type) do update set
    file_name = excluded.file_name,
    period_start = excluded.period_start,
    period_end = excluded.period_end,
    row_count = excluded.row_count,
    imported_at = excluded.imported_at,
    imported_by = excluded.imported_by;
end;
$$;

revoke all on function public.replace_finance_platform_order_import(text, date, date, jsonb) from public;
grant execute on function public.replace_finance_platform_order_import(text, date, date, jsonb) to authenticated;

-- Counter invoices of the same file, replaced over the same period. An empty
-- list is valid: a period can have only sàn orders.
create or replace function public.replace_finance_counter_order_import(
  p_period_start date,
  p_period_end date,
  p_rows jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end then
    raise exception 'Invalid counter order import period';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Counter order rows must be a JSON array';
  end if;

  delete from public.finance_counter_order_rows
  where order_date between p_period_start and p_period_end;

  insert into public.finance_counter_order_rows (
    id, order_code, order_date, channel_name, reported_amount, order_created_at,
    paid_at, goods_amount, discount_amount, service_fee, delivery_fee,
    tip_amount, refund_amount, payment_method, service_type, delivery_partner,
    status, source_file_name, imported_at, items, sapo_area, sapo_cashier
  )
  select
    row_data.id, row_data.order_code, row_data.order_date,
    coalesce(row_data.channel_name, 'Tại nhà hàng'),
    coalesce(row_data.reported_amount, 0), row_data.order_created_at, row_data.paid_at,
    coalesce(row_data.goods_amount, 0), coalesce(row_data.discount_amount, 0),
    coalesce(row_data.service_fee, 0), coalesce(row_data.delivery_fee, 0),
    coalesce(row_data.tip_amount, 0), coalesce(row_data.refund_amount, 0),
    row_data.payment_method, row_data.service_type, row_data.delivery_partner,
    row_data.status, row_data.source_file_name, coalesce(row_data.imported_at, now()),
    coalesce(row_data.items, '[]'::jsonb), row_data.sapo_area, row_data.sapo_cashier
  from jsonb_to_recordset(p_rows) as row_data(
    id text, order_code text, order_date date, channel_name text,
    reported_amount numeric, order_created_at timestamp without time zone,
    paid_at timestamp without time zone, goods_amount numeric,
    discount_amount numeric, service_fee numeric, delivery_fee numeric,
    tip_amount numeric, refund_amount numeric, payment_method text,
    service_type text, delivery_partner text, status text,
    source_file_name text, imported_at timestamptz, items jsonb,
    sapo_area text, sapo_cashier text
  );
end;
$$;

revoke all on function public.replace_finance_counter_order_import(date, date, jsonb) from public;
grant execute on function public.replace_finance_counter_order_import(date, date, jsonb) to authenticated;

-- v2 plus the counter invoices, in one transaction.
create or replace function public.replace_finance_import_bundle_v3(
  p_revenue_file_name text,
  p_revenue_period_start date,
  p_revenue_period_end date,
  p_revenue_rows jsonb,
  p_products_file_name text,
  p_products_period_start date,
  p_products_period_end date,
  p_products_rows jsonb,
  p_service_file_name text,
  p_service_period_start date,
  p_service_period_end date,
  p_service_rows jsonb,
  p_orders_file_name text,
  p_orders_period_start date,
  p_orders_period_end date,
  p_orders_rows jsonb,
  p_counter_rows jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_revenue_rows is null and p_products_rows is null and p_service_rows is null and p_orders_rows is null then
    raise exception 'At least one finance report is required';
  end if;
  perform public.replace_finance_import_bundle_v2(
    p_revenue_file_name, p_revenue_period_start, p_revenue_period_end, p_revenue_rows,
    p_products_file_name, p_products_period_start, p_products_period_end, p_products_rows,
    p_service_file_name, p_service_period_start, p_service_period_end, p_service_rows,
    p_orders_file_name, p_orders_period_start, p_orders_period_end, p_orders_rows
  );
  if p_counter_rows is not null then
    if p_orders_period_start is null or p_orders_period_end is null then
      raise exception 'Counter orders need the invoice file period';
    end if;
    perform public.replace_finance_counter_order_import(p_orders_period_start, p_orders_period_end, p_counter_rows);
  end if;
end;
$$;

revoke all on function public.replace_finance_import_bundle_v3(text, date, date, jsonb, text, date, date, jsonb, text, date, date, jsonb, text, date, date, jsonb, jsonb) from public;
grant execute on function public.replace_finance_import_bundle_v3(text, date, date, jsonb, text, date, date, jsonb, text, date, date, jsonb, text, date, date, jsonb, jsonb) to authenticated;

-- 4. Manual order → store assignments ----------------------------------------

create table if not exists public.finance_order_store_assignments (
  order_id text primary key,
  store_id uuid not null references public.stores(id),
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);

alter table public.finance_order_store_assignments enable row level security;
revoke all on table public.finance_order_store_assignments from anon;
grant select, insert, update, delete on table public.finance_order_store_assignments to authenticated;
drop policy if exists "authenticated staff can manage order store assignments" on public.finance_order_store_assignments;
create policy "authenticated staff can manage order store assignments"
on public.finance_order_store_assignments for all to authenticated
using (true)
with check (true);

-- 5. Sàn reports per store ---------------------------------------------------

alter table public.finance_grab_daily_reports
  add column if not exists store_id uuid not null default '31070000-0000-4000-8000-000000000001' references public.stores(id),
  add column if not exists merchant_id text,
  add column if not exists orders jsonb not null default '[]'::jsonb;

drop index if exists public.finance_grab_daily_reports_platform_date_idx;
create unique index if not exists finance_grab_daily_reports_platform_store_date_idx
  on public.finance_grab_daily_reports (platform, store_id, report_date);

alter table public.finance_grab_reconciliations
  add column if not exists store_id uuid not null default '31070000-0000-4000-8000-000000000001' references public.stores(id);

create index if not exists finance_grab_reconciliations_store_idx
  on public.finance_grab_reconciliations (store_id);

-- Guarded data fix: the ShopeeFood reports of 11/10 and 18/10/2026 came from
-- N2's Shopee store (ID cửa hàng 10439891, verified in the CSV files) but were
-- ingested as N1's — their one order each sits in `unmatched` because N2's
-- Shopee orders never reach SAPO. Exact date + file + order code, and only
-- when KHO-2 exists.
update public.finance_grab_daily_reports as report
set store_id = store.id,
    merchant_id = '10439891'
from public.stores as store
where store.code = 'KHO-2'
  and report.platform = 'shopee'
  and report.store_id = '31070000-0000-4000-8000-000000000001'
  and report.matched_count = 0
  and (
    (report.report_date = date '2026-10-11'
      and report.file_name = 'Shopeefood_Income_Details_Merchant_11-10-2026.csv'
      and report.unmatched @> '[{"code": "11106-393452455"}]'::jsonb)
    or
    (report.report_date = date '2026-10-18'
      and report.file_name = 'Shopeefood_Income_Details_Merchant_18-10-2026.csv'
      and report.unmatched @> '[{"code": "18106-460223963"}]'::jsonb)
  );

notify pgrst, 'reload schema';

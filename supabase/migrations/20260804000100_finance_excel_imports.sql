-- Shared finance imports. Each RPC replaces one complete report dataset in a
-- single transaction, so users never see a half-imported report.

create table if not exists public.finance_imports (
  data_type text primary key check (data_type in ('revenue', 'products', 'service')),
  file_name text not null,
  period_start date not null,
  period_end date not null,
  row_count integer not null check (row_count >= 0),
  imported_at timestamptz not null default now(),
  imported_by uuid
);

create table if not exists public.finance_revenue_rows (
  id text primary key,
  report_date date not null unique,
  total_orders numeric not null default 0,
  cancelled_orders numeric not null default 0,
  item_quantity numeric not null default 0,
  average_items_per_order numeric not null default 0,
  average_order_value numeric not null default 0,
  goods_amount numeric not null default 0,
  cancelled_amount numeric not null default 0,
  returned_amount numeric not null default 0,
  discount_amount numeric not null default 0,
  tax_amount numeric not null default 0,
  service_fee_before_tax numeric not null default 0,
  delivery_fee numeric not null default 0,
  partner_fee numeric not null default 0,
  platform_tax_collected numeric not null default 0,
  tips numeric not null default 0,
  customer_debt numeric not null default 0,
  actual_revenue numeric not null default 0,
  sales numeric not null default 0
);

create table if not exists public.finance_product_rows (
  id text primary key,
  source_row integer not null,
  category_name text not null,
  sku text not null,
  product_name text not null,
  variant_name text not null default '',
  unit_name text not null default '',
  quantity numeric not null default 0,
  weight numeric not null default 0,
  usage_time text not null default '',
  quantity_ratio numeric not null default 0,
  goods_amount numeric not null default 0,
  goods_ratio numeric not null default 0,
  discount_amount numeric not null default 0,
  amount_after_discount numeric not null default 0,
  tax_amount numeric not null default 0,
  total_amount numeric not null default 0
);

create table if not exists public.finance_service_rows (
  id text primary key,
  source_row integer not null,
  service_name text not null,
  total_orders numeric not null default 0,
  cancelled_orders numeric not null default 0,
  revenue numeric not null default 0
);

alter table public.finance_imports enable row level security;
alter table public.finance_revenue_rows enable row level security;
alter table public.finance_product_rows enable row level security;
alter table public.finance_service_rows enable row level security;

drop policy if exists "authenticated staff can read finance imports" on public.finance_imports;
create policy "authenticated staff can read finance imports"
on public.finance_imports for select to authenticated using (true);

drop policy if exists "authenticated staff can read finance revenue" on public.finance_revenue_rows;
create policy "authenticated staff can read finance revenue"
on public.finance_revenue_rows for select to authenticated using (true);

drop policy if exists "authenticated staff can read finance products" on public.finance_product_rows;
create policy "authenticated staff can read finance products"
on public.finance_product_rows for select to authenticated using (true);

drop policy if exists "authenticated staff can read finance service" on public.finance_service_rows;
create policy "authenticated staff can read finance service"
on public.finance_service_rows for select to authenticated using (true);

create or replace function public.replace_finance_revenue_import(
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
declare
  imported_time timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'Invalid report period';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'Revenue import must contain at least one row';
  end if;

  delete from public.finance_revenue_rows;
  insert into public.finance_revenue_rows (
    id, report_date, total_orders, cancelled_orders, item_quantity,
    average_items_per_order, average_order_value, goods_amount,
    cancelled_amount, returned_amount, discount_amount, tax_amount,
    service_fee_before_tax, delivery_fee, partner_fee,
    platform_tax_collected, tips, customer_debt, actual_revenue, sales
  )
  select
    row.id, row.report_date, row.total_orders, row.cancelled_orders,
    row.item_quantity, row.average_items_per_order, row.average_order_value,
    row.goods_amount, row.cancelled_amount, row.returned_amount,
    row.discount_amount, row.tax_amount, row.service_fee_before_tax,
    row.delivery_fee, row.partner_fee, row.platform_tax_collected,
    row.tips, row.customer_debt, row.actual_revenue, row.sales
  from jsonb_to_recordset(p_rows) as row(
    id text, report_date date, total_orders numeric, cancelled_orders numeric,
    item_quantity numeric, average_items_per_order numeric,
    average_order_value numeric, goods_amount numeric,
    cancelled_amount numeric, returned_amount numeric,
    discount_amount numeric, tax_amount numeric,
    service_fee_before_tax numeric, delivery_fee numeric, partner_fee numeric,
    platform_tax_collected numeric, tips numeric, customer_debt numeric,
    actual_revenue numeric, sales numeric
  );

  insert into public.finance_imports (
    data_type, file_name, period_start, period_end, row_count,
    imported_at, imported_by
  ) values (
    'revenue', p_file_name, p_period_start, p_period_end,
    jsonb_array_length(p_rows), imported_time, auth.uid()
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

create or replace function public.replace_finance_product_import(
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
declare
  imported_time timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'Invalid report period';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'Product import must contain at least one row';
  end if;

  delete from public.finance_product_rows;
  insert into public.finance_product_rows (
    id, source_row, category_name, sku, product_name, variant_name,
    unit_name, quantity, weight, usage_time, quantity_ratio, goods_amount,
    goods_ratio, discount_amount, amount_after_discount, tax_amount,
    total_amount
  )
  select
    row.id, row.source_row, row.category_name, row.sku, row.product_name,
    coalesce(row.variant_name, ''), coalesce(row.unit_name, ''), row.quantity,
    row.weight, coalesce(row.usage_time, ''), row.quantity_ratio,
    row.goods_amount, row.goods_ratio, row.discount_amount,
    row.amount_after_discount, row.tax_amount, row.total_amount
  from jsonb_to_recordset(p_rows) as row(
    id text, source_row integer, category_name text, sku text,
    product_name text, variant_name text, unit_name text, quantity numeric,
    weight numeric, usage_time text, quantity_ratio numeric,
    goods_amount numeric, goods_ratio numeric, discount_amount numeric,
    amount_after_discount numeric, tax_amount numeric, total_amount numeric
  );

  insert into public.finance_imports (
    data_type, file_name, period_start, period_end, row_count,
    imported_at, imported_by
  ) values (
    'products', p_file_name, p_period_start, p_period_end,
    jsonb_array_length(p_rows), imported_time, auth.uid()
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

create or replace function public.replace_finance_service_import(
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
declare
  imported_time timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then
    raise exception 'Invalid report period';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Rows must be a JSON array';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'Service import must contain at least one row';
  end if;

  delete from public.finance_service_rows;
  insert into public.finance_service_rows (
    id, source_row, service_name, total_orders, cancelled_orders, revenue
  )
  select
    row.id, row.source_row, row.service_name, row.total_orders,
    row.cancelled_orders, row.revenue
  from jsonb_to_recordset(p_rows) as row(
    id text, source_row integer, service_name text, total_orders numeric,
    cancelled_orders numeric, revenue numeric
  );

  insert into public.finance_imports (
    data_type, file_name, period_start, period_end, row_count,
    imported_at, imported_by
  ) values (
    'service', p_file_name, p_period_start, p_period_end,
    jsonb_array_length(p_rows), imported_time, auth.uid()
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

revoke all on function public.replace_finance_revenue_import(text, date, date, jsonb) from public;
revoke all on function public.replace_finance_product_import(text, date, date, jsonb) from public;
revoke all on function public.replace_finance_service_import(text, date, date, jsonb) from public;
grant execute on function public.replace_finance_revenue_import(text, date, date, jsonb) to authenticated;
grant execute on function public.replace_finance_product_import(text, date, date, jsonb) to authenticated;
grant execute on function public.replace_finance_service_import(text, date, date, jsonb) to authenticated;

-- Import Center replaces only the report types included in the upload. All
-- selected datasets are committed together, so a failed parser payload rolls
-- the complete multi-file import back without touching the previous snapshot.
create or replace function public.replace_finance_import_bundle(
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
  p_service_rows jsonb
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
  if p_revenue_rows is null and p_products_rows is null and p_service_rows is null then
    raise exception 'At least one finance report is required';
  end if;

  if p_revenue_rows is not null then
    perform public.replace_finance_revenue_import(
      p_revenue_file_name,
      p_revenue_period_start,
      p_revenue_period_end,
      p_revenue_rows
    );
  end if;

  if p_products_rows is not null then
    perform public.replace_finance_product_import(
      p_products_file_name,
      p_products_period_start,
      p_products_period_end,
      p_products_rows
    );
  end if;

  if p_service_rows is not null then
    perform public.replace_finance_service_import(
      p_service_file_name,
      p_service_period_start,
      p_service_period_end,
      p_service_rows
    );
  end if;
end;
$$;

revoke all on function public.replace_finance_import_bundle(text, date, date, jsonb, text, date, date, jsonb, text, date, date, jsonb) from public;
grant execute on function public.replace_finance_import_bundle(text, date, date, jsonb, text, date, date, jsonb, text, date, date, jsonb) to authenticated;

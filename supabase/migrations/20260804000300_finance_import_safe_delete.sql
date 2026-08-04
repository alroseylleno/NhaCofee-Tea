-- pg-safeupdate on Production rejects DELETE statements without a WHERE
-- clause. Redefine the snapshot RPCs with an explicit primary-key predicate.
-- Each replacement still runs transactionally and only touches its own
-- finance dataset.

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

  delete from public.finance_revenue_rows where id is not null;
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

  delete from public.finance_product_rows where id is not null;
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

  delete from public.finance_service_rows where id is not null;
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

notify pgrst, 'reload schema';

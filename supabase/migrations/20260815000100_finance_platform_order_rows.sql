-- Store SAPO order-detail exports so platform reconciliation can select an
-- existing GRAB order instead of typing every order code manually.

create table if not exists public.finance_platform_order_rows (
  id text primary key,
  order_code text not null,
  order_date date not null,
  channel_name text not null default 'Không rõ kênh',
  reported_amount numeric not null default 0 check (reported_amount >= 0),
  order_created_at timestamp without time zone,
  paid_at timestamp without time zone,
  goods_amount numeric not null default 0 check (goods_amount >= 0),
  discount_amount numeric not null default 0 check (discount_amount >= 0),
  service_fee numeric not null default 0 check (service_fee >= 0),
  delivery_fee numeric not null default 0 check (delivery_fee >= 0),
  tip_amount numeric not null default 0 check (tip_amount >= 0),
  refund_amount numeric not null default 0 check (refund_amount >= 0),
  payment_method text,
  service_type text,
  delivery_partner text,
  status text,
  source_file_name text,
  imported_at timestamptz not null default now()
);

alter table public.finance_platform_order_rows
  add column if not exists order_created_at timestamp without time zone,
  add column if not exists paid_at timestamp without time zone,
  add column if not exists goods_amount numeric not null default 0,
  add column if not exists discount_amount numeric not null default 0,
  add column if not exists service_fee numeric not null default 0,
  add column if not exists delivery_fee numeric not null default 0,
  add column if not exists tip_amount numeric not null default 0,
  add column if not exists refund_amount numeric not null default 0,
  add column if not exists payment_method text,
  add column if not exists service_type text,
  add column if not exists delivery_partner text;

create index if not exists finance_platform_order_rows_order_date_idx
  on public.finance_platform_order_rows (order_date desc);

create index if not exists finance_platform_order_rows_channel_idx
  on public.finance_platform_order_rows (lower(channel_name));

create unique index if not exists finance_platform_order_rows_code_date_idx
  on public.finance_platform_order_rows (lower(order_code), order_date);

create unique index if not exists finance_grab_reconciliations_platform_order_id_idx
  on public.finance_grab_reconciliations (platform_order_id)
  where platform_order_id is not null;

alter table public.finance_platform_order_rows enable row level security;

revoke all on table public.finance_platform_order_rows from anon;
grant select, insert, update, delete on table public.finance_platform_order_rows to authenticated;

drop policy if exists "authenticated staff can manage finance platform order rows" on public.finance_platform_order_rows;
create policy "authenticated staff can manage finance platform order rows"
on public.finance_platform_order_rows for all to authenticated
using (true)
with check (true);

alter table public.finance_imports
  drop constraint if exists finance_imports_data_type_check;

alter table public.finance_imports
  add constraint finance_imports_data_type_check
  check (data_type in ('revenue', 'products', 'service', 'orders'));

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
    id,
    order_code,
    order_date,
    channel_name,
    reported_amount,
    order_created_at,
    paid_at,
    goods_amount,
    discount_amount,
    service_fee,
    delivery_fee,
    tip_amount,
    refund_amount,
    payment_method,
    service_type,
    delivery_partner,
    status,
    source_file_name,
    imported_at
  )
  select
    row_data.id,
    row_data.order_code,
    row_data.order_date,
    row_data.channel_name,
    row_data.reported_amount,
    row_data.order_created_at,
    row_data.paid_at,
    row_data.goods_amount,
    row_data.discount_amount,
    row_data.service_fee,
    row_data.delivery_fee,
    row_data.tip_amount,
    row_data.refund_amount,
    row_data.payment_method,
    row_data.service_type,
    row_data.delivery_partner,
    row_data.status,
    row_data.source_file_name,
    coalesce(row_data.imported_at, now())
  from jsonb_to_recordset(coalesce(p_rows, '[]'::jsonb)) as row_data(
    id text,
    order_code text,
    order_date date,
    channel_name text,
    reported_amount numeric,
    order_created_at timestamp without time zone,
    paid_at timestamp without time zone,
    goods_amount numeric,
    discount_amount numeric,
    service_fee numeric,
    delivery_fee numeric,
    tip_amount numeric,
    refund_amount numeric,
    payment_method text,
    service_type text,
    delivery_partner text,
    status text,
    source_file_name text,
    imported_at timestamptz
  );

  insert into public.finance_imports (
    data_type,
    file_name,
    period_start,
    period_end,
    row_count,
    imported_at,
    imported_by
  ) values (
    'orders',
    p_file_name,
    p_period_start,
    p_period_end,
    jsonb_array_length(coalesce(p_rows, '[]'::jsonb)),
    now(),
    auth.uid()
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

create or replace function public.replace_finance_import_bundle_v2(
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
  p_orders_rows jsonb
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
  if p_revenue_rows is not null then
    perform public.replace_finance_revenue_import(p_revenue_file_name, p_revenue_period_start, p_revenue_period_end, p_revenue_rows);
  end if;
  if p_products_rows is not null then
    perform public.replace_finance_product_import(p_products_file_name, p_products_period_start, p_products_period_end, p_products_rows);
  end if;
  if p_service_rows is not null then
    perform public.replace_finance_service_import(p_service_file_name, p_service_period_start, p_service_period_end, p_service_rows);
  end if;
  if p_orders_rows is not null then
    perform public.replace_finance_platform_order_import(p_orders_file_name, p_orders_period_start, p_orders_period_end, p_orders_rows);
  end if;
end;
$$;

revoke all on function public.replace_finance_import_bundle_v2(text, date, date, jsonb, text, date, date, jsonb, text, date, date, jsonb, text, date, date, jsonb) from public;
grant execute on function public.replace_finance_import_bundle_v2(text, date, date, jsonb, text, date, date, jsonb, text, date, date, jsonb, text, date, date, jsonb) to authenticated;

notify pgrst, 'reload schema';

-- Finance Product report becomes the sole Product Master catalog. Long
-- explicitly requested a one-time reset of all existing Product module data.

alter table public.finance_product_rows
  add column if not exists selling_price numeric not null default 0 check (selling_price >= 0);

alter table public.product_master
  add column if not exists variant text not null default '',
  add column if not exists selling_price_overridden boolean not null default false;

-- Recover prices imported before Gia mat hang had its own field. In those
-- snapshots the parser stored the numeric price in variant_name.
update public.finance_product_rows
set selling_price = regexp_replace(variant_name, '[^0-9]', '', 'g')::numeric,
    variant_name = ''
where selling_price = 0
  and variant_name ~ '^[[:space:][:digit:].,]+$'
  and regexp_replace(variant_name, '[^0-9]', '', 'g') <> '';

-- Declare the signature before replacing the Finance import RPC below. The
-- complete reconciliation body is installed later in this migration.
create or replace function public.reconcile_product_master_from_finance(p_store_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return;
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
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_period_start is null or p_period_end is null or p_period_end < p_period_start then raise exception 'Invalid report period'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'Rows must be a JSON array'; end if;
  if jsonb_array_length(p_rows) = 0 then raise exception 'Product import must contain at least one row'; end if;

  delete from public.finance_product_rows where id is not null;
  insert into public.finance_product_rows (
    id, source_row, category_name, sku, product_name, variant_name,
    selling_price, unit_name, quantity, weight, usage_time, quantity_ratio,
    goods_amount, goods_ratio, discount_amount, amount_after_discount,
    tax_amount, total_amount
  )
  select
    row.id, row.source_row, row.category_name, row.sku, row.product_name,
    coalesce(row.variant_name, ''), greatest(coalesce(row.selling_price, 0), 0),
    coalesce(row.unit_name, ''), row.quantity, row.weight,
    coalesce(row.usage_time, ''), row.quantity_ratio, row.goods_amount,
    row.goods_ratio, row.discount_amount, row.amount_after_discount,
    row.tax_amount, row.total_amount
  from jsonb_to_recordset(p_rows) as row(
    id text, source_row integer, category_name text, sku text,
    product_name text, variant_name text, selling_price numeric,
    unit_name text, quantity numeric, weight numeric, usage_time text,
    quantity_ratio numeric, goods_amount numeric, goods_ratio numeric,
    discount_amount numeric, amount_after_discount numeric,
    tax_amount numeric, total_amount numeric
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

  perform public.reconcile_product_master_from_finance(store.id)
  from public.stores store
  where store.code = 'NHA-31-7';
end;
$$;

create or replace function public.reconcile_product_master_from_finance(p_store_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.product_master product
  where product.store_id = p_store_id
    and not exists (
      select 1 from public.finance_product_rows finance
      where lower(trim(finance.sku)) = lower(trim(product.sku))
    );

  update public.product_master product
  set sku = trim(finance.sku)
  from (
    select distinct on (lower(trim(sku))) sku
    from public.finance_product_rows
    where trim(sku) <> ''
    order by lower(trim(sku)), source_row desc
  ) finance
  where product.store_id = p_store_id
    and lower(trim(product.sku)) = lower(trim(finance.sku))
    and product.sku <> trim(finance.sku);

  insert into public.product_master as product (
    store_id, sku, name, category, variant, selling_price,
    selling_price_overridden, packaging_cost, source, status, updated_at
  )
  select distinct on (lower(trim(finance.sku)))
    p_store_id,
    trim(finance.sku),
    trim(finance.product_name),
    coalesce(nullif(trim(finance.category_name), ''), 'Chưa phân loại'),
    coalesce(trim(finance.variant_name), ''),
    greatest(coalesce(finance.selling_price, 0), 0),
    false,
    0,
    'import',
    'active',
    now()
  from public.finance_product_rows finance
  where trim(finance.sku) <> ''
  order by lower(trim(finance.sku)), finance.source_row desc
  on conflict (store_id, sku) do update set
    name = excluded.name,
    category = excluded.category,
    variant = excluded.variant,
    selling_price = case
      when product.selling_price_overridden then product.selling_price
      else excluded.selling_price
    end,
    source = 'import',
    status = 'active',
    updated_at = now();
end;
$$;

revoke all on function public.reconcile_product_master_from_finance(uuid) from public;
grant execute on function public.reconcile_product_master_from_finance(uuid) to authenticated;

-- One-time owner-authorized Product module reset. Ingredient Master is rebuilt
-- from Kho NVL the next time Product Master loads.
delete from public.product_audit_events;
delete from public.product_master;
delete from public.ingredient_master;
drop table if exists public.product_recipe_import_issues;
alter table public.product_master drop column if exists aliases;

select public.reconcile_product_master_from_finance(id)
from public.stores
where code = 'NHA-31-7';

notify pgrst, 'reload schema';

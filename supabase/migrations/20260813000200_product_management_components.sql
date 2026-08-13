-- Persist the complete Product Management UAT contract in Production:
-- ingredient/packaging recipe components, manual "Khac" cost items, manual
-- products/clones and explicit Finance-catalog exclusions after deletion.

alter table public.product_recipe_items
  alter column ingredient_id drop not null,
  add column if not exists component_type text not null default 'ingredient',
  add column if not exists custom_name text,
  add column if not exists custom_brand text,
  add column if not exists custom_category text,
  add column if not exists custom_cost numeric;

alter table public.product_recipe_items
  drop constraint if exists product_recipe_items_component_type_check,
  add constraint product_recipe_items_component_type_check
    check (component_type in ('ingredient', 'packaging')),
  drop constraint if exists product_recipe_items_custom_cost_check,
  add constraint product_recipe_items_custom_cost_check
    check (custom_cost is null or custom_cost > 0),
  drop constraint if exists product_recipe_items_source_check,
  add constraint product_recipe_items_source_check check (
    (ingredient_id is not null and custom_name is null and custom_cost is null)
    or
    (ingredient_id is null and nullif(trim(custom_name), '') is not null and custom_cost > 0)
  );

grant select, insert, update, delete on public.product_master to authenticated;
grant select, insert, update, delete on public.product_recipe_versions to authenticated;
grant select, insert, update, delete on public.product_recipe_items to authenticated;
grant select, insert, update, delete on public.product_audit_events to authenticated;

create table if not exists public.product_catalog_exclusions (
  store_id uuid not null references public.stores(id) on delete cascade,
  sku_key text not null,
  sku text not null,
  excluded_at timestamptz not null default now(),
  excluded_by uuid,
  primary key (store_id, sku_key),
  check (sku_key = lower(trim(sku_key)) and sku_key <> '')
);

alter table public.product_catalog_exclusions enable row level security;

drop policy if exists "authenticated staff can manage product catalog exclusions" on public.product_catalog_exclusions;
create policy "authenticated staff can manage product catalog exclusions"
on public.product_catalog_exclusions
for all to authenticated
using (true)
with check (true);

grant select, insert, update, delete on public.product_catalog_exclusions to authenticated;

create or replace function public.save_product_master(
  p_id uuid,
  p_store_id uuid,
  p_sku text,
  p_name text,
  p_category text,
  p_variant text,
  p_selling_price numeric,
  p_selling_price_overridden boolean,
  p_packaging_cost numeric,
  p_source text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_id is null or p_store_id is null or nullif(trim(p_sku), '') is null or nullif(trim(p_name), '') is null then raise exception 'Invalid product'; end if;
  if p_source not in ('import', 'manual') then raise exception 'Invalid product source'; end if;
  if coalesce(p_selling_price, 0) < 0 or coalesce(p_packaging_cost, 0) < 0 then raise exception 'Product values cannot be negative'; end if;

  if p_source = 'manual' then
    delete from public.product_catalog_exclusions
    where store_id = p_store_id
      and sku_key = lower(trim(p_sku));
  end if;

  insert into public.product_master as product (
    id, store_id, sku, name, category, variant, selling_price,
    selling_price_overridden, packaging_cost, source, status, updated_at
  ) values (
    p_id, p_store_id, trim(p_sku), trim(p_name),
    coalesce(nullif(trim(p_category), ''), 'Chưa phân loại'),
    coalesce(trim(p_variant), ''), greatest(coalesce(p_selling_price, 0), 0),
    coalesce(p_selling_price_overridden, false),
    greatest(coalesce(p_packaging_cost, 0), 0), p_source, 'active', now()
  )
  on conflict (store_id, sku) do update set
    name = excluded.name,
    category = excluded.category,
    variant = excluded.variant,
    selling_price = excluded.selling_price,
    selling_price_overridden = excluded.selling_price_overridden,
    packaging_cost = excluded.packaging_cost,
    source = excluded.source,
    status = 'active',
    updated_at = now();

  insert into public.product_audit_events (
    store_id, entity_type, entity_id, action, detail
  ) values (
    p_store_id, 'product', p_id, 'save', 'Luu thong tin SKU ' || trim(p_sku)
  );
end;
$$;

revoke all on function public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text) from public;
grant execute on function public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text) to authenticated;

create or replace function public.reconcile_product_master_from_finance(p_store_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.product_master product
  where product.store_id = p_store_id
    and product.source = 'import'
    and (
      exists (
        select 1
        from public.product_catalog_exclusions exclusion
        where exclusion.store_id = product.store_id
          and exclusion.sku_key = lower(trim(product.sku))
      )
      or not exists (
        select 1
        from public.finance_product_rows finance
        where lower(trim(finance.sku)) = lower(trim(product.sku))
      )
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
    and product.source = 'import'
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
    and not exists (
      select 1
      from public.product_catalog_exclusions exclusion
      where exclusion.store_id = p_store_id
        and exclusion.sku_key = lower(trim(finance.sku))
    )
    and not exists (
      select 1
      from public.product_master manual_product
      where manual_product.store_id = p_store_id
        and manual_product.source = 'manual'
        and lower(trim(manual_product.sku)) = lower(trim(finance.sku))
    )
  order by lower(trim(finance.sku)), finance.source_row desc
  on conflict (store_id, sku) do update set
    name = excluded.name,
    category = excluded.category,
    variant = excluded.variant,
    selling_price = case
      when product.selling_price_overridden then product.selling_price
      else excluded.selling_price
    end,
    source = case when product.source = 'manual' then 'manual' else 'import' end,
    status = 'active',
    updated_at = now();
end;
$$;

create or replace function public.delete_product_master(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.product_master%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into target
  from public.product_master
  where id = p_product_id;

  if not found then raise exception 'Product not found'; end if;

  if target.source = 'import' then
    insert into public.product_catalog_exclusions (
      store_id, sku_key, sku, excluded_at, excluded_by
    ) values (
      target.store_id, lower(trim(target.sku)), target.sku, now(), auth.uid()
    )
    on conflict (store_id, sku_key) do update set
      sku = excluded.sku,
      excluded_at = excluded.excluded_at,
      excluded_by = excluded.excluded_by;
  end if;

  delete from public.product_master where id = target.id;

  insert into public.product_audit_events (
    store_id, entity_type, entity_id, action, detail
  ) values (
    target.store_id, 'product', target.id, 'delete',
    'Xoa san pham ' || target.sku || ' · ' || target.name
  );
end;
$$;

revoke all on function public.delete_product_master(uuid) from public;
grant execute on function public.delete_product_master(uuid) to authenticated;

create or replace function public.save_product_recipe_version(
  p_version_id uuid,
  p_product_id uuid,
  p_version integer,
  p_effective_from date,
  p_previous_version_id uuid,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  product_store_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_version_id is null or p_product_id is null or p_version < 1 or p_effective_from is null then raise exception 'Invalid recipe version'; end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'Recipe items must be an array'; end if;

  select store_id into product_store_id
  from public.product_master
  where id = p_product_id;

  if product_store_id is null then raise exception 'Product not found'; end if;

  if p_previous_version_id is not null then
    update public.product_recipe_versions
    set status = 'archived', effective_to = p_effective_from
    where id = p_previous_version_id
      and product_id = p_product_id;
  end if;

  insert into public.product_recipe_versions (
    id, product_id, version, effective_from, status, created_at
  ) values (
    p_version_id, p_product_id, p_version, p_effective_from, 'active', now()
  );

  insert into public.product_recipe_items (
    id, recipe_version_id, product_id, ingredient_id, component_type,
    custom_name, custom_brand, custom_category, custom_cost,
    quantity, unit, waste_percent, created_at, updated_at
  )
  select
    item.id,
    p_version_id,
    p_product_id,
    item.ingredient_id,
    item.component_type,
    item.custom_name,
    item.custom_brand,
    item.custom_category,
    item.custom_cost,
    item.quantity,
    item.unit,
    item.waste_percent,
    now(),
    now()
  from jsonb_to_recordset(p_items) as item(
    id uuid,
    ingredient_id uuid,
    component_type text,
    custom_name text,
    custom_brand text,
    custom_category text,
    custom_cost numeric,
    quantity numeric,
    unit text,
    waste_percent numeric
  );

  insert into public.product_audit_events (
    store_id, entity_type, entity_id, action, detail
  ) values (
    product_store_id, 'recipe', p_version_id, 'save',
    'Luu cong thuc v' || p_version
  );
end;
$$;

revoke all on function public.save_product_recipe_version(uuid, uuid, integer, date, uuid, jsonb) from public;
grant execute on function public.save_product_recipe_version(uuid, uuid, integer, date, uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';

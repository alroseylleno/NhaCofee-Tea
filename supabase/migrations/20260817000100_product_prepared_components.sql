-- Persist prepared recipes (for example, a 1L tea-milk base) and their
-- versioned references from finished-product formulas.
alter table public.product_master
  add column if not exists product_type text not null default 'sellable';

alter table public.product_master
  drop constraint if exists product_master_product_type_check,
  add constraint product_master_product_type_check
    check (product_type in ('sellable', 'packaging', 'prepared_component'));

alter table public.product_recipe_versions
  add column if not exists output_quantity numeric,
  add column if not exists output_unit text;

alter table public.product_recipe_versions
  drop constraint if exists product_recipe_versions_output_check,
  add constraint product_recipe_versions_output_check
    check (
      (output_quantity is null and output_unit is null)
      or (output_quantity > 0 and nullif(trim(output_unit), '') is not null)
    );

alter table public.product_recipe_items
  add column if not exists prepared_product_id uuid references public.product_master(id),
  add column if not exists prepared_recipe_version_id uuid references public.product_recipe_versions(id);

alter table public.product_recipe_items
  drop constraint if exists product_recipe_items_component_type_check,
  add constraint product_recipe_items_component_type_check
    check (component_type in ('ingredient', 'packaging', 'prepared')),
  drop constraint if exists product_recipe_items_source_check,
  add constraint product_recipe_items_source_check check (
    (ingredient_id is not null
      and custom_name is null and custom_cost is null
      and prepared_product_id is null and prepared_recipe_version_id is null)
    or
    (ingredient_id is null
      and nullif(trim(custom_name), '') is not null and custom_cost > 0
      and prepared_product_id is null and prepared_recipe_version_id is null)
    or
    (ingredient_id is null and custom_name is null and custom_cost is null
      and prepared_product_id is not null and prepared_recipe_version_id is not null)
  );

create index if not exists product_recipe_items_prepared_product_idx
  on public.product_recipe_items(prepared_product_id);

drop function if exists public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text);

create function public.save_product_master(
  p_id uuid,
  p_store_id uuid,
  p_sku text,
  p_name text,
  p_category text,
  p_variant text,
  p_selling_price numeric,
  p_selling_price_overridden boolean,
  p_packaging_cost numeric,
  p_source text,
  p_product_type text
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
  if coalesce(p_product_type, 'sellable') not in ('sellable', 'packaging', 'prepared_component') then raise exception 'Invalid product type'; end if;
  if coalesce(p_selling_price, 0) < 0 or coalesce(p_packaging_cost, 0) < 0 then raise exception 'Product values cannot be negative'; end if;

  if p_source = 'manual' then
    delete from public.product_catalog_exclusions
    where store_id = p_store_id and sku_key = lower(trim(p_sku));
  end if;

  insert into public.product_master as product (
    id, store_id, sku, name, category, variant, selling_price,
    selling_price_overridden, packaging_cost, source, product_type, status, updated_at
  ) values (
    p_id, p_store_id, trim(p_sku), trim(p_name),
    coalesce(nullif(trim(p_category), ''), 'Chưa phân loại'),
    coalesce(trim(p_variant), ''), greatest(coalesce(p_selling_price, 0), 0),
    coalesce(p_selling_price_overridden, false),
    greatest(coalesce(p_packaging_cost, 0), 0), p_source,
    coalesce(p_product_type, 'sellable'), 'active', now()
  )
  on conflict (store_id, sku) do update set
    name = excluded.name, category = excluded.category, variant = excluded.variant,
    selling_price = excluded.selling_price,
    selling_price_overridden = excluded.selling_price_overridden,
    packaging_cost = excluded.packaging_cost, source = excluded.source,
    product_type = excluded.product_type, status = 'active', updated_at = now();

  insert into public.product_audit_events (store_id, entity_type, entity_id, action, detail)
  values (p_store_id, 'product', p_id, 'save', 'Luu thong tin SKU ' || trim(p_sku));
end;
$$;

revoke all on function public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text, text) from public;
grant execute on function public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text, text) to authenticated;

drop function if exists public.save_product_recipe_version(uuid, uuid, integer, date, uuid, jsonb);

create function public.save_product_recipe_version(
  p_version_id uuid,
  p_product_id uuid,
  p_version integer,
  p_effective_from date,
  p_previous_version_id uuid,
  p_output_quantity numeric,
  p_output_unit text,
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

  select store_id into product_store_id from public.product_master where id = p_product_id;
  if product_store_id is null then raise exception 'Product not found'; end if;

  if p_previous_version_id is not null then
    update public.product_recipe_versions
    set status = 'archived', effective_to = p_effective_from
    where id = p_previous_version_id and product_id = p_product_id;
  end if;

  insert into public.product_recipe_versions (
    id, product_id, version, effective_from, status, output_quantity, output_unit, created_at
  ) values (
    p_version_id, p_product_id, p_version, p_effective_from, 'active',
    p_output_quantity, nullif(trim(p_output_unit), ''), now()
  );

  insert into public.product_recipe_items (
    id, recipe_version_id, product_id, ingredient_id, component_type,
    custom_name, custom_brand, custom_category, custom_cost,
    prepared_product_id, prepared_recipe_version_id,
    quantity, unit, waste_percent, created_at, updated_at
  )
  select
    item.id, p_version_id, p_product_id, item.ingredient_id, item.component_type,
    item.custom_name, item.custom_brand, item.custom_category, item.custom_cost,
    item.prepared_product_id, item.prepared_recipe_version_id,
    item.quantity, item.unit, item.waste_percent, now(), now()
  from jsonb_to_recordset(p_items) as item(
    id uuid, ingredient_id uuid, component_type text,
    custom_name text, custom_brand text, custom_category text, custom_cost numeric,
    prepared_product_id uuid, prepared_recipe_version_id uuid,
    quantity numeric, unit text, waste_percent numeric
  );

  insert into public.product_audit_events (store_id, entity_type, entity_id, action, detail)
  values (product_store_id, 'recipe', p_version_id, 'save', 'Luu cong thuc v' || p_version);
end;
$$;

revoke all on function public.save_product_recipe_version(uuid, uuid, integer, date, uuid, numeric, text, jsonb) from public;
grant execute on function public.save_product_recipe_version(uuid, uuid, integer, date, uuid, numeric, text, jsonb) to authenticated;

notify pgrst, 'reload schema';

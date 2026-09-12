-- Per-platform listed prices, plus name/category override flags.
--
-- A SKU is listed at a different price on every sàn, and each sàn takes a
-- different cut (đối soát 2026-09-11: Grab 24,538%, ShopeeFood 28,55%,
-- GreenSM 0%, all three plus GTGT 3% + TNCN 1,5%), so one `selling_price`
-- column cannot express what the business actually earns. `selling_price`
-- keeps meaning the counter price; the platform prices live beside it.
--
-- The override flags exist because reconcile_product_master_from_finance
-- rewrites name and category of every imported SKU from the latest Finance
-- snapshot. Without them a rename typed in Product Master would silently
-- revert on the next Production load, the same way a hand-set price would
-- without selling_price_overridden.

alter table public.product_master
  add column if not exists channel_prices jsonb not null default '{}'::jsonb,
  add column if not exists name_overridden boolean not null default false,
  add column if not exists category_overridden boolean not null default false;

-- A CHECK constraint cannot contain a subquery, and validating the shape of a
-- jsonb map needs one, so the test lives in an immutable helper the CHECK calls.
create or replace function public.product_channel_prices_valid(p_prices jsonb)
returns boolean
language sql
immutable
as $$
  select p_prices is not null
    and jsonb_typeof(p_prices) = 'object'
    and not exists (
      select 1
      from jsonb_each(p_prices) as entry(key, value)
      where entry.key not in ('grab', 'shopee', 'greensm')
        or jsonb_typeof(entry.value) <> 'number'
        or (entry.value)::numeric <= 0
    );
$$;

alter table public.product_master
  drop constraint if exists product_master_channel_prices_check,
  add constraint product_master_channel_prices_check
    check (public.product_channel_prices_valid(channel_prices));

drop function if exists public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text, text);

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
  p_product_type text,
  p_channel_prices jsonb,
  p_name_overridden boolean,
  p_category_overridden boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  resolved_channel_prices jsonb := coalesce(p_channel_prices, '{}'::jsonb);
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_id is null or p_store_id is null or nullif(trim(p_sku), '') is null or nullif(trim(p_name), '') is null then raise exception 'Invalid product'; end if;
  if p_source not in ('import', 'manual') then raise exception 'Invalid product source'; end if;
  if coalesce(p_product_type, 'sellable') not in ('sellable', 'packaging', 'prepared_component') then raise exception 'Invalid product type'; end if;
  if coalesce(p_selling_price, 0) < 0 or coalesce(p_packaging_cost, 0) < 0 then raise exception 'Product values cannot be negative'; end if;
  if jsonb_typeof(resolved_channel_prices) <> 'object' then raise exception 'Channel prices must be an object'; end if;

  -- Drop blanked-out platform prices rather than storing a zero, so "no price
  -- on this sàn" and "listed at 0" cannot be confused downstream.
  select coalesce(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
  into resolved_channel_prices
  from jsonb_each(resolved_channel_prices) as entry(key, value)
  where entry.key in ('grab', 'shopee', 'greensm')
    and jsonb_typeof(entry.value) = 'number'
    and (entry.value)::numeric > 0;

  if p_source = 'manual' then
    delete from public.product_catalog_exclusions
    where store_id = p_store_id and sku_key = lower(trim(p_sku));
  end if;

  insert into public.product_master as product (
    id, store_id, sku, name, category, variant, selling_price,
    selling_price_overridden, packaging_cost, source, product_type,
    channel_prices, name_overridden, category_overridden, status, updated_at
  ) values (
    p_id, p_store_id, trim(p_sku), trim(p_name),
    coalesce(nullif(trim(p_category), ''), 'Chưa phân loại'),
    coalesce(trim(p_variant), ''), greatest(coalesce(p_selling_price, 0), 0),
    coalesce(p_selling_price_overridden, false),
    greatest(coalesce(p_packaging_cost, 0), 0), p_source,
    coalesce(p_product_type, 'sellable'), resolved_channel_prices,
    coalesce(p_name_overridden, false), coalesce(p_category_overridden, false),
    'active', now()
  )
  on conflict (store_id, sku) do update set
    name = excluded.name, category = excluded.category, variant = excluded.variant,
    selling_price = excluded.selling_price,
    selling_price_overridden = excluded.selling_price_overridden,
    packaging_cost = excluded.packaging_cost, source = excluded.source,
    product_type = excluded.product_type,
    channel_prices = excluded.channel_prices,
    name_overridden = excluded.name_overridden,
    category_overridden = excluded.category_overridden,
    status = 'active', updated_at = now();

  insert into public.product_audit_events (store_id, entity_type, entity_id, action, detail)
  values (p_store_id, 'product', p_id, 'save', 'Luu thong tin SKU ' || trim(p_sku));
end;
$$;

revoke all on function public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text, text, jsonb, boolean, boolean) from public;
grant execute on function public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text, text, jsonb, boolean, boolean) to authenticated;

-- Finance reconciliation must now leave a hand-edited name or category alone.
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
    name = case when product.name_overridden then product.name else excluded.name end,
    category = case when product.category_overridden then product.category else excluded.category end,
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

revoke all on function public.reconcile_product_master_from_finance(uuid) from public;
grant execute on function public.reconcile_product_master_from_finance(uuid) to authenticated;

notify pgrst, 'reload schema';

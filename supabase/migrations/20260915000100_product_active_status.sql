-- Ngưng hoạt động một SKU, và làm cho nó DÍNH.
--
-- `product_master.status` đã tồn tại nhưng mọi đường ghi đều ép 'active':
-- `save_product_master` hardcode, và `reconcile_product_master_from_finance`
-- set lại 'active' ở cả nhánh INSERT lẫn ON CONFLICT. Nên nếu chỉ sửa UI thì
-- lần mở app kế tiếp trên Production sẽ bật lại toàn bộ SKU đã ngưng —
-- đúng cái bẫy mà name_overridden / selling_price_overridden đã gặp.

drop function if exists public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text, text, jsonb, boolean, boolean);

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
  p_category_overridden boolean,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  resolved_channel_prices jsonb := coalesce(p_channel_prices, '{}'::jsonb);
  resolved_status text := case when p_status = 'inactive' then 'inactive' else 'active' end;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_id is null or p_store_id is null or nullif(trim(p_sku), '') is null or nullif(trim(p_name), '') is null then raise exception 'Invalid product'; end if;
  if p_source not in ('import', 'manual') then raise exception 'Invalid product source'; end if;
  if coalesce(p_product_type, 'sellable') not in ('sellable', 'packaging', 'prepared_component') then raise exception 'Invalid product type'; end if;
  if coalesce(p_selling_price, 0) < 0 or coalesce(p_packaging_cost, 0) < 0 then raise exception 'Product values cannot be negative'; end if;
  if jsonb_typeof(resolved_channel_prices) <> 'object' then raise exception 'Channel prices must be an object'; end if;

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
    resolved_status, now()
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
    status = excluded.status, updated_at = now();

  insert into public.product_audit_events (store_id, entity_type, entity_id, action, detail)
  values (p_store_id, 'product', p_id, 'save', 'Luu thong tin SKU ' || trim(p_sku));
end;
$$;

revoke all on function public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text, text, jsonb, boolean, boolean, text) from public;
grant execute on function public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text, text, jsonb, boolean, boolean, text) to authenticated;

-- Finance reconciliation phải để yên SKU đã ngưng hoạt động.
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
        select 1 from public.product_catalog_exclusions exclusion
        where exclusion.store_id = product.store_id
          and exclusion.sku_key = lower(trim(product.sku))
      )
      or not exists (
        select 1 from public.finance_product_rows finance
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
    p_store_id, trim(finance.sku), trim(finance.product_name),
    coalesce(nullif(trim(finance.category_name), ''), 'Chưa phân loại'),
    coalesce(trim(finance.variant_name), ''),
    greatest(coalesce(finance.selling_price, 0), 0),
    false, 0, 'import', 'active', now()
  from public.finance_product_rows finance
  where trim(finance.sku) <> ''
    and not exists (
      select 1 from public.product_catalog_exclusions exclusion
      where exclusion.store_id = p_store_id and exclusion.sku_key = lower(trim(finance.sku))
    )
    and not exists (
      select 1 from public.product_master manual_product
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
    -- Ngưng hoạt động là quyết định của người dùng, Finance không được lật lại.
    status = case when product.status = 'inactive' then 'inactive' else 'active' end,
    updated_at = now();
end;
$$;

revoke all on function public.reconcile_product_master_from_finance(uuid) from public;
grant execute on function public.reconcile_product_master_from_finance(uuid) to authenticated;

notify pgrst, 'reload schema';

-- Combo: một SKU bán ra gồm nhiều món đã có trong danh mục.
--
-- Combo KHÔNG dùng lại `prepared_product_id`. Nhánh prepared bắt buộc phải ghim
-- một `prepared_recipe_version_id` và phải quy đổi được đơn vị đầu ra; combo thì
-- ngược lại — nó phải bám theo giá và giá vốn HIỆN TẠI của món thành viên, nên
-- ghim phiên bản là đúng cái phải tránh.
--
-- `combo_product_id` là `on delete set null`, không phải RESTRICT. Món thành viên
-- hầu hết là SKU nguồn Finance, mà `reconcile_product_master_from_finance` xoá
-- thẳng SKU nguồn Finance khi nó rơi khỏi snapshot. Nếu khoá FK cứng thì một SKU
-- biến mất khỏi bảng Finance sẽ làm reconcile văng lỗi 23503 và Quản lý sản phẩm
-- không mở được trên Production. Để null thì dòng combo vẫn còn, `combo_product_name`
-- giữ lại tên món đã mất, và app đọc ra là "món đã bị xoá" — giá vốn/giá gộp của
-- combo đó thành "Chưa đủ" chứ không âm thầm rẻ đi.

alter table public.product_master
  drop constraint if exists product_master_product_type_check,
  add constraint product_master_product_type_check
    check (product_type in ('sellable', 'packaging', 'prepared_component', 'combo'));

alter table public.product_recipe_items
  add column if not exists combo_product_id uuid references public.product_master(id) on delete set null,
  add column if not exists combo_product_name text;

alter table public.product_recipe_items
  drop constraint if exists product_recipe_items_component_type_check,
  add constraint product_recipe_items_component_type_check
    check (component_type in ('ingredient', 'packaging', 'prepared', 'combo')),
  drop constraint if exists product_recipe_items_source_check,
  add constraint product_recipe_items_source_check check (
    (component_type <> 'combo' and combo_product_id is null and combo_product_name is null
      and (
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
      ))
    or
    -- Dòng combo: chỉ trỏ tới một SKU khác. `combo_product_id` được phép null vì
    -- món thành viên có thể đã bị xoá; tên vẫn phải còn để nói ra món nào.
    (component_type = 'combo'
      and ingredient_id is null and custom_name is null and custom_cost is null
      and prepared_product_id is null and prepared_recipe_version_id is null
      and nullif(trim(combo_product_name), '') is not null)
  );

create index if not exists product_recipe_items_combo_product_idx
  on public.product_recipe_items(combo_product_id);

-- `save_product_master`: chỉ mở thêm 'combo' vào danh sách loại SKU hợp lệ.
drop function if exists public.save_product_master(uuid, uuid, text, text, text, text, numeric, boolean, numeric, text, text, jsonb, boolean, boolean, text);

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
  if coalesce(p_product_type, 'sellable') not in ('sellable', 'packaging', 'prepared_component', 'combo') then raise exception 'Invalid product type'; end if;
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

-- `save_product_recipe_version`: đọc thêm hai cột combo từ payload.
drop function if exists public.save_product_recipe_version(uuid, uuid, integer, date, uuid, numeric, text, jsonb);

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
  resolved_output_unit text := nullif(trim(p_output_unit), '');
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_version_id is null or p_product_id is null or p_version < 1 or p_effective_from is null then raise exception 'Invalid recipe version'; end if;
  if jsonb_typeof(p_items) <> 'array' then raise exception 'Recipe items must be an array'; end if;
  -- Giữ nguyên guard của 20260912000100: nửa cặp sản lượng đầu ra phải chặn ở đây
  -- vì CHECK chỉ từ chối FALSE, mà `output_quantity > 0` là NULL khi số lượng null.
  if p_output_quantity is null and resolved_output_unit is not null then
    raise exception 'Cong thuc nen phai co san luong dau ra lon hon 0';
  end if;
  if p_output_quantity is not null and (p_output_quantity <= 0 or resolved_output_unit is null) then
    raise exception 'Cong thuc nen phai co san luong dau ra lon hon 0 va don vi dau ra';
  end if;

  select store_id into product_store_id from public.product_master where id = p_product_id;
  if product_store_id is null then raise exception 'Product not found'; end if;

  -- Combo không được lồng combo: một vòng lặp combo sẽ làm giá vốn đệ quy vô tận.
  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(component_type text, combo_product_id uuid)
    join public.product_master member on member.id = item.combo_product_id
    where item.component_type = 'combo' and member.product_type <> 'sellable'
  ) then
    raise exception 'A combo may only contain sellable products';
  end if;

  if p_previous_version_id is not null then
    update public.product_recipe_versions
    set status = 'archived', effective_to = p_effective_from
    where id = p_previous_version_id and product_id = p_product_id;
  end if;

  insert into public.product_recipe_versions (
    id, product_id, version, effective_from, status, output_quantity, output_unit, created_at
  ) values (
    p_version_id, p_product_id, p_version, p_effective_from, 'active',
    p_output_quantity, resolved_output_unit, now()
  );

  insert into public.product_recipe_items (
    id, recipe_version_id, product_id, ingredient_id, component_type,
    custom_name, custom_brand, custom_category, custom_cost,
    prepared_product_id, prepared_recipe_version_id,
    combo_product_id, combo_product_name,
    quantity, unit, waste_percent, created_at, updated_at
  )
  select
    item.id, p_version_id, p_product_id, item.ingredient_id, item.component_type,
    item.custom_name, item.custom_brand, item.custom_category, item.custom_cost,
    item.prepared_product_id, item.prepared_recipe_version_id,
    item.combo_product_id, nullif(trim(item.combo_product_name), ''),
    item.quantity, item.unit, item.waste_percent, now(), now()
  from jsonb_to_recordset(p_items) as item(
    id uuid, ingredient_id uuid, component_type text,
    custom_name text, custom_brand text, custom_category text, custom_cost numeric,
    prepared_product_id uuid, prepared_recipe_version_id uuid,
    combo_product_id uuid, combo_product_name text,
    quantity numeric, unit text, waste_percent numeric
  );

  insert into public.product_audit_events (store_id, entity_type, entity_id, action, detail)
  values (product_store_id, 'recipe', p_version_id, 'save', 'Luu cong thuc v' || p_version);
end;
$$;

revoke all on function public.save_product_recipe_version(uuid, uuid, integer, date, uuid, numeric, text, jsonb) from public;
grant execute on function public.save_product_recipe_version(uuid, uuid, integer, date, uuid, numeric, text, jsonb) to authenticated;

-- Xoá một SKU đang là món của combo thì `combo_product_id` bị set null và combo
-- đó gãy trong im lặng ở lần mở kế tiếp. Nói ra trước khi xoá, kèm tên combo.
create or replace function public.delete_product_master(p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target public.product_master%rowtype;
  blocking text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  select * into target from public.product_master where id = p_product_id;
  if not found then raise exception 'Product not found'; end if;

  -- Combo: chỉ chặn khi phiên bản ĐANG hiệu lực còn dùng món này (FK là set null
  -- nên phiên bản lưu trữ không gãy). Prepared: chặn ở MỌI phiên bản, vì
  -- `prepared_product_id` không có on-delete nên xoá sẽ văng FK 23503 dù ở bản lưu trữ.
  select string_agg(distinct owner.sku || ' · ' || owner.name, ', ')
  into blocking
  from public.product_recipe_items item
  join public.product_recipe_versions version on version.id = item.recipe_version_id
  join public.product_master owner on owner.id = version.product_id
  where owner.id <> target.id
    and (
      (item.combo_product_id = target.id and version.status = 'active')
      or item.prepared_product_id = target.id
    );

  if blocking is not null then
    raise exception 'SKU % dang duoc dung trong: %. Hay go no khoi cac SKU do truoc khi xoa.', target.sku, blocking;
  end if;

  if target.source = 'import' then
    insert into public.product_catalog_exclusions (store_id, sku_key, sku, excluded_at, excluded_by)
    values (target.store_id, lower(trim(target.sku)), target.sku, now(), auth.uid())
    on conflict (store_id, sku_key) do update set
      sku = excluded.sku, excluded_at = excluded.excluded_at, excluded_by = excluded.excluded_by;
  end if;

  delete from public.product_master where id = target.id;

  insert into public.product_audit_events (store_id, entity_type, entity_id, action, detail)
  values (target.store_id, 'product', target.id, 'delete', 'Xoa san pham ' || target.sku || ' · ' || target.name);
end;
$$;

revoke all on function public.delete_product_master(uuid) from public;
grant execute on function public.delete_product_master(uuid) to authenticated;

notify pgrst, 'reload schema';

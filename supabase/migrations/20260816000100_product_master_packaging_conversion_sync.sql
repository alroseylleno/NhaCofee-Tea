-- Keep Product Master packaging units and unit costs aligned with the exact
-- Kho NVL receipt currently used as the Ingredient Master source.

create schema if not exists private;

alter table public.ingredient_master
  add column if not exists conversion_unit text;

create table if not exists private.product_master_conversion_backups (
  migration_key text primary key,
  captured_at timestamptz not null default now(),
  ingredient_rows jsonb not null,
  active_session_rows jsonb not null,
  recipe_rows jsonb not null
);

insert into private.product_master_conversion_backups (
  migration_key,
  ingredient_rows,
  active_session_rows,
  recipe_rows
) values (
  '20260816000100_product_master_packaging_conversion_sync',
  coalesce((
    select jsonb_agg(to_jsonb(ingredient) order by ingredient.id)
    from public.ingredient_master as ingredient
    where ingredient.source_inventory_receipt_id is not null
  ), '[]'::jsonb),
  coalesce((
    select jsonb_agg(to_jsonb(session) order by session.id)
    from public.inventory_active_sessions as session
    where session.status = 'active'
  ), '[]'::jsonb),
  coalesce((
    select jsonb_agg(to_jsonb(item) order by item.id)
    from public.product_recipe_items as item
    join public.product_master as product on product.id = item.product_id
    where upper(trim(product.sku)) = 'CM-M'
  ), '[]'::jsonb)
)
on conflict (migration_key) do nothing;

-- Persist the raw declared conversion unit even before recalculating prices.
update public.ingredient_master as ingredient
set conversion_unit = nullif(trim(receipt.conversion_unit), ''),
    updated_at = now()
from public.inventory_receipts as receipt
where receipt.id = ingredient.source_inventory_receipt_id
  and ingredient.conversion_unit is distinct from nullif(trim(receipt.conversion_unit), '');

with receipt_conversion as (
  select
    ingredient.id as ingredient_id,
    receipt.unit as purchase_unit,
    receipt.unit_cost,
    receipt.purchased_on,
    trim(receipt.conversion_unit) as conversion_unit,
    case
      when lower(trim(receipt.conversion_unit)) in ('mg', 'g', 'kg') then 'g'
      when lower(trim(receipt.conversion_unit)) in ('ml', 'l', 'oz') then 'ml'
      when lower(trim(receipt.conversion_unit)) in (
        'cái', 'tờ', 'viên', 'phần', 'gói', 'túi', 'hộp', 'chai', 'lon',
        'trái', 'miếng', 'muỗng', 'vá'
      ) then 'cái'
    end as base_unit,
    receipt.conversion_amount * case lower(trim(receipt.conversion_unit))
      when 'mg' then 0.001
      when 'g' then 1
      when 'kg' then 1000
      when 'ml' then 1
      when 'l' then 1000
      when 'oz' then 29.5735
      when 'cái' then 1
      when 'tờ' then 1
      when 'viên' then 1
      when 'phần' then 1
      when 'gói' then 1
      when 'túi' then 1
      when 'hộp' then 1
      when 'chai' then 1
      when 'lon' then 1
      when 'trái' then 1
      when 'miếng' then 1
      when 'muỗng' then 1
      when 'vá' then 1
    end as base_quantity
  from public.ingredient_master as ingredient
  join public.inventory_receipts as receipt
    on receipt.id = ingredient.source_inventory_receipt_id
  where receipt.conversion_amount > 0
    and nullif(trim(receipt.conversion_unit), '') is not null
)
update public.ingredient_master as ingredient
set base_unit = conversion.base_unit,
    conversion_unit = conversion.conversion_unit,
    purchase_unit = conversion.purchase_unit,
    latest_purchase_price = conversion.unit_cost,
    latest_purchase_price_per_base_unit = conversion.unit_cost / conversion.base_quantity,
    latest_purchased_on = conversion.purchased_on,
    updated_at = now()
from receipt_conversion as conversion
where ingredient.id = conversion.ingredient_id
  and conversion.base_unit is not null
  and conversion.base_quantity > 0;

-- An active session is an operational snapshot of its source receipt. Editing
-- that receipt must refresh the open quantity, unit and provisional cost.
update public.inventory_active_sessions as session
set opened_amount = receipt.conversion_amount,
    opened_unit = receipt.conversion_unit,
    provisional_cost = receipt.unit_cost,
    updated_at = now()
from public.inventory_receipts as receipt
where receipt.id = session.source_receipt_id
  and session.status = 'active'
  and receipt.conversion_amount > 0
  and nullif(trim(receipt.conversion_unit), '') is not null
  and (
    session.opened_amount is distinct from receipt.conversion_amount
    or session.opened_unit is distinct from receipt.conversion_unit
    or session.provisional_cost is distinct from receipt.unit_cost
  );

-- CM-M v4 was saved before "tờ" existed as a supported count unit. Keep the
-- same physical quantity while correcting the displayed/recipe unit.
update public.product_recipe_items as item
set unit = 'tờ',
    updated_at = now()
from public.product_recipe_versions as version,
     public.product_master as product,
     public.ingredient_master as ingredient
where version.id = item.recipe_version_id
  and product.id = item.product_id
  and ingredient.id = item.ingredient_id
  and version.status = 'active'
  and upper(trim(product.sku)) = 'CM-M'
  and item.component_type = 'packaging'
  and ingredient.source_key = 'giay chong tran|dung cu mang di|ukp'
  and item.unit = 'cái';

notify pgrst, 'reload schema';

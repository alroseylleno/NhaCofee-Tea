-- Công thức nền SKUs disappeared from the "Thêm công thức nền" picker because
-- their active recipe version was stored with output_quantity = NULL and
-- output_unit = 'ml'. The UI filters those out (no batch output => no cost per
-- ml), and nothing in the stack rejected the write:
--   * the Copy (clone) button never seeded the output form fields, so the first
--     save after a clone wrote Number("") || undefined = NULL;
--   * product_recipe_versions_output_check evaluated to NULL rather than FALSE
--     for that combination, and a CHECK constraint only rejects FALSE.
-- This migration repairs the data, then makes the constraint and the RPC reject
-- the combination for real.

-- 1. Active versions of the 7 Syrup Mứt bases: each batch is 1000 ml syrup plus
--    1000 ml mứt, so the real output is 2000 ml (confirmed by Long 2026-09-12).
update public.product_recipe_versions version
set output_quantity = 2000, output_unit = 'ml'
from public.product_master product
where product.id = version.product_id
  and product.product_type = 'prepared_component'
  and version.status = 'active'
  and version.output_quantity is null
  and version.output_unit is not null;

-- 2. Archived versions carrying an orphan unit never had a recorded output.
--    Normalise them to the honest "no output" shape so the strict constraint
--    below can be applied without rewriting history.
update public.product_recipe_versions
set output_unit = null
where output_quantity is null
  and output_unit is not null;

-- 3. Make the guard actually fire. `output_quantity > 0` is NULL when the
--    quantity is NULL, and `false or null` is null, which a CHECK accepts.
--    Testing the null-ness explicitly keeps the expression boolean.
alter table public.product_recipe_versions
  drop constraint if exists product_recipe_versions_output_check,
  add constraint product_recipe_versions_output_check
    check (
      (output_quantity is null and output_unit is null)
      or (output_quantity is not null and output_quantity > 0
          and nullif(trim(output_unit), '') is not null)
    );

-- 4. Reject the half-filled pair at the RPC boundary too, so a future client
--    bug fails loudly instead of writing an invisible SKU.
create or replace function public.save_product_recipe_version(
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
  if p_output_quantity is null and resolved_output_unit is not null then
    raise exception 'Cong thuc nen phai co san luong dau ra lon hon 0';
  end if;
  if p_output_quantity is not null and (p_output_quantity <= 0 or resolved_output_unit is null) then
    raise exception 'Cong thuc nen phai co san luong dau ra lon hon 0 va don vi dau ra';
  end if;

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
    p_output_quantity, resolved_output_unit, now()
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

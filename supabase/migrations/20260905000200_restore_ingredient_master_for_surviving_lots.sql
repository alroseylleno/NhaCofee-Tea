-- Repair for 20260905000100. That migration deleted the ingredient_master row
-- of every erased lot, but ingredient_master is keyed by (name, category,
-- brand) - source_key in the app - not by lot. "Bánh snack - nhỏ" still has a
-- surviving lot at 5.000đ (receipt 010726-041), so its master row must exist.
--
-- Symptom in Production: opening Quản lý sản phẩm fails with
--   duplicate key value violates unique constraint
--   "ingredient_master_store_id_code_key" [23505]
--
-- Cause: mergeInventoryDrafts sees a live lot with no matching master row and
-- pushes a new draft coded by ARRAY POSITION - ingredientCode(merged.length)
-- yields NVL-0001, NVL-0002, ... Deleting rows shortens that array, so the
-- generated code lands on a number an older row already owns. The client
-- upserts with onConflict "store_id,source_key", which cannot absorb a clash on
-- the separate (store_id, code) unique index, so the load aborts.
--
-- Fix: restore from the snapshot only the ingredient rows whose ingredient
-- still has a live receipt. Restoring the row makes source_key match again, so
-- the client takes the update branch instead of pushing a positionally coded
-- draft, and no code is ever regenerated.
--
-- "Nước ngọt COCA" is deliberately NOT restored: no receipt of that name
-- survives, so no draft is generated for it and it stays fully erased as the
-- owner asked. Only the ingredient behind a still-live lot comes back, and the
-- erased lots themselves are not resurrected.
--
-- Restored rows come back detached and inactive - source_inventory_receipt_id
-- null, zero stock - because their original receipt is gone. The next Product
-- Master load re-links them to the surviving lot and flips them back to active.

do $$
declare
  snapshot_ingredients jsonb;
  snapshot_recipe_items jsonb;
  restorable_ingredients jsonb;
  restorable_recipe_items jsonb;
  restored_ingredients integer;
  restored_recipe_items integer;
  skipped_ingredients integer;
begin
  select backup.ingredient_rows, backup.recipe_item_rows
  into snapshot_ingredients, snapshot_recipe_items
  from private.snack_coca_removal_backups as backup
  where backup.migration_key = '20260905000100_remove_snack_nho_1700_and_coca_5200_lots';

  if snapshot_ingredients is null then
    raise exception 'Ingredient restore found no snapshot for 20260905000100 - nothing to repair from';
  end if;

  -- An ingredient is restorable when a receipt of the same name still exists.
  -- Compare on NFC-normalised, case-folded, trimmed names: Kho NVL names are
  -- stored with mixed Unicode normalisation, so a raw byte compare would miss.
  select coalesce(jsonb_agg(
    ingredient_row
    || jsonb_build_object(
         'source_inventory_receipt_id', null,
         'stock_quantity_base', 0,
         'stock_lot_count', 0,
         'oldest_in_stock_purchased_on', null,
         'status', 'inactive'
       )
  ), '[]'::jsonb)
  into restorable_ingredients
  from jsonb_array_elements(snapshot_ingredients) as ingredient_row
  where exists (
    select 1
    from public.inventory_receipts as receipt
    where normalize(lower(btrim(receipt.name)), NFC)
        = normalize(lower(btrim(ingredient_row ->> 'name')), NFC)
  );

  skipped_ingredients := jsonb_array_length(snapshot_ingredients) - jsonb_array_length(restorable_ingredients);

  if jsonb_array_length(restorable_ingredients) = 0 then
    raise notice 'Ingredient restore found no ingredient with a surviving receipt; nothing restored, % row(s) stay erased', skipped_ingredients;
    return;
  end if;

  insert into public.ingredient_master
  select *
  from jsonb_populate_recordset(null::public.ingredient_master, restorable_ingredients)
  on conflict (id) do nothing;
  get diagnostics restored_ingredients = row_count;

  -- Bring back only the recipe components whose ingredient came back and whose
  -- product and recipe version still exist; anything else would violate its FK.
  select coalesce(jsonb_agg(recipe_item_row), '[]'::jsonb)
  into restorable_recipe_items
  from jsonb_array_elements(coalesce(snapshot_recipe_items, '[]'::jsonb)) as recipe_item_row
  where (recipe_item_row ->> 'ingredient_id')::uuid in (
      select (ingredient_row ->> 'id')::uuid
      from jsonb_array_elements(restorable_ingredients) as ingredient_row
    )
    and exists (
      select 1 from public.product_master as product
      where product.id = (recipe_item_row ->> 'product_id')::uuid
    )
    and (
      recipe_item_row ->> 'recipe_version_id' is null
      or exists (
        select 1 from public.product_recipe_versions as recipe_version
        where recipe_version.id = (recipe_item_row ->> 'recipe_version_id')::uuid
      )
    );

  if jsonb_array_length(restorable_recipe_items) > 0 then
    insert into public.product_recipe_items
    select *
    from jsonb_populate_recordset(null::public.product_recipe_items, restorable_recipe_items)
    on conflict (id) do nothing;
    get diagnostics restored_recipe_items = row_count;
  else
    restored_recipe_items := 0;
  end if;

  -- Every restored ingredient must now be findable by its own source_key, which
  -- is the condition that stops the client from generating a colliding code.
  if exists (
    select 1
    from jsonb_array_elements(restorable_ingredients) as ingredient_row
    where not exists (
      select 1 from public.ingredient_master as ingredient
      where ingredient.store_id = (ingredient_row ->> 'store_id')::uuid
        and ingredient.source_key = ingredient_row ->> 'source_key'
    )
  ) then
    raise exception 'Ingredient restore failed: a restored source_key is still missing from ingredient_master';
  end if;

  raise notice 'Ingredient restore complete: % ingredient master row(s) restored inactive/detached, % recipe component(s) restored, % row(s) left erased because no receipt of that name survives',
    restored_ingredients, restored_recipe_items, skipped_ingredients;
end $$;

notify pgrst, 'reload schema';

-- Owner-requested total erasure of two Kho NVL lots: the "Bánh snack - nhỏ" lot
-- priced 1.700 and the "Nước ngọt COCA" lot priced 5.200. Both must disappear
-- from the database as if they had never been recorded.
--
-- Everything attached to them is removed, in FK-safe order:
--   1. product_recipe_items rows whose ingredient came from these receipts
--   2. inventory_active_sessions rows in EVERY status - active, used, wasted -
--      which is where cost recognition lives (provisional_cost,
--      recognized_cost, cost_recognition_month), so recognized COGS for these
--      lots disappears with them
--   3. inventory_history audit rows
--   4. inventory_receipts, the lots themselves
--   5. ingredient_master rows fed by these receipts
--
-- This deliberately overrides the Product Master Sync Rule, which normally
-- keeps orphaned ingredient rows inactive for recipe history. The owner asked
-- for full erasure, so the rows are deleted outright and any recipe component
-- built on them is deleted too. Every deleted row is snapshotted first.
--
-- Reference figures from the 13/08/2026 export (Production may have drifted):
--   010726-042  Bánh snack - nhỏ  @1.700/gói  60 nhập · 30 tồn · 0 đang · 30 đã dùng
--   010726-050  Nước ngọt COCA    @5.200/chai 24 nhập · 18 tồn · 1 đang ·  5 đã dùng
-- Lot value removed ≈ 226.800đ; recognized COGS removed ≈ 82.200đ, lowering
-- July/August recognized inventory cost by that amount.
--
-- Matching is by ASCII substring plus exact unit_cost on purpose. Ingredient
-- names are stored with mixed Unicode normalisation, so matching on "nhỏ" or
-- "Nước ngọt" would silently miss NFD rows; "snack" and "coca" are ASCII-safe
-- and the unit_cost pins the exact lot.

create schema if not exists private;

create table if not exists private.snack_coca_removal_backups (
  migration_key text primary key,
  captured_at timestamptz not null default now(),
  receipt_rows jsonb not null,
  history_rows jsonb not null,
  active_session_rows jsonb not null,
  ingredient_rows jsonb not null,
  recipe_item_rows jsonb not null
);

revoke all on table private.snack_coca_removal_backups from public;
revoke all on table private.snack_coca_removal_backups from anon, authenticated;

do $$
declare
  snack_receipt_count integer;
  coca_receipt_count integer;
  target_receipt_count integer;
  blocked_settlement_count integer;
  blocked_return_lot_count integer;
  ingredient_count integer;
  recipe_item_count integer;
  affected_product_count integer;
  sessions_before integer;
  active_before integer;
  used_before integer;
  wasted_before integer;
  recognized_cost_before numeric;
  history_before integer;
  lot_value numeric;
  deleted_recipe_items integer;
  deleted_sessions integer;
  deleted_history integer;
  deleted_receipts integer;
  deleted_ingredients integer;
  receipts_after integer;
  ingredients_after integer;
begin
  create temporary table removal_target_receipts on commit drop as
  select receipt.id, receipt.receipt_code, receipt.name, receipt.unit_cost, receipt.total_quantity
  from public.inventory_receipts as receipt
  where (lower(receipt.name) like '%snack%' and receipt.unit_cost = 1700)
     or (lower(receipt.name) like '%coca%' and receipt.unit_cost = 5200);

  select
    count(*) filter (where lower(target.name) like '%snack%'),
    count(*) filter (where lower(target.name) like '%coca%'),
    count(*)
  into snack_receipt_count, coca_receipt_count, target_receipt_count
  from removal_target_receipts as target;

  if target_receipt_count = 0 then
    raise exception 'Snack 1700 / COCA 5200 erasure matched no receipt at all - wrong database or the lots are already gone';
  end if;

  if snack_receipt_count = 0 or coca_receipt_count = 0 then
    raise exception 'Snack 1700 / COCA 5200 erasure expected both lots, found % snack and % coca receipt(s)',
      snack_receipt_count, coca_receipt_count;
  end if;

  -- Sanity cap. The 13/08 snapshot holds exactly one lot per item; anything
  -- beyond a small handful means the matcher is catching lots nobody reviewed.
  if target_receipt_count > 4 then
    raise exception 'Snack 1700 / COCA 5200 erasure matched % receipts, which exceeds the reviewed scope - aborting instead of deleting blind',
      target_receipt_count;
  end if;

  -- Refuse to touch lifecycle rows that a period settlement already closed, or
  -- that produced a separate return-to-stock lot; deleting those would corrupt
  -- a receipt outside this scope.
  select count(*) into blocked_settlement_count
  from public.inventory_active_sessions as session
  where session.source_receipt_id in (select id from removal_target_receipts)
    and session.settlement is not null;

  select count(*) into blocked_return_lot_count
  from public.inventory_receipts as returned_receipt
  where returned_receipt.source_session_id in (
    select session.id
    from public.inventory_active_sessions as session
    where session.source_receipt_id in (select id from removal_target_receipts)
  )
  and returned_receipt.id not in (select id from removal_target_receipts);

  if blocked_settlement_count <> 0 or blocked_return_lot_count <> 0 then
    raise exception 'Snack 1700 / COCA 5200 erasure blocked: % settled session(s) and % external return lot(s) depend on these receipts',
      blocked_settlement_count, blocked_return_lot_count;
  end if;

  -- Capture the ingredient rows before the delete: source_inventory_receipt_id
  -- is ON DELETE SET NULL, so afterwards they cannot be told apart from older
  -- orphans left by the 09/08 full reset.
  create temporary table removal_target_ingredients on commit drop as
  select ingredient.id
  from public.ingredient_master as ingredient
  where ingredient.source_inventory_receipt_id in (select id from removal_target_receipts);

  select count(*) into ingredient_count from removal_target_ingredients;

  select
    count(*),
    count(distinct recipe_item.product_id)
  into recipe_item_count, affected_product_count
  from public.product_recipe_items as recipe_item
  where recipe_item.ingredient_id in (select id from removal_target_ingredients);

  select
    count(*),
    count(*) filter (where session.status = 'active'),
    count(*) filter (where session.status = 'used'),
    count(*) filter (where session.status = 'wasted'),
    coalesce(sum(coalesce(session.recognized_cost, session.provisional_cost, 0)), 0)
  into sessions_before, active_before, used_before, wasted_before, recognized_cost_before
  from public.inventory_active_sessions as session
  where session.source_receipt_id in (select id from removal_target_receipts);

  select count(*) into history_before
  from public.inventory_history as history
  where history.inventory_receipt_id in (select id from removal_target_receipts);

  select coalesce(sum(target.total_quantity * target.unit_cost), 0) into lot_value
  from removal_target_receipts as target;

  insert into private.snack_coca_removal_backups (
    migration_key,
    receipt_rows,
    history_rows,
    active_session_rows,
    ingredient_rows,
    recipe_item_rows
  ) values (
    '20260905000100_remove_snack_nho_1700_and_coca_5200_lots',
    coalesce((
      select jsonb_agg(to_jsonb(receipt) order by receipt.purchased_on, receipt.receipt_code, receipt.id)
      from public.inventory_receipts as receipt
      where receipt.id in (select id from removal_target_receipts)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(history) order by history.created_at, history.id)
      from public.inventory_history as history
      where history.inventory_receipt_id in (select id from removal_target_receipts)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(session) order by session.activated_at, session.id)
      from public.inventory_active_sessions as session
      where session.source_receipt_id in (select id from removal_target_receipts)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(ingredient) order by ingredient.id)
      from public.ingredient_master as ingredient
      where ingredient.id in (select id from removal_target_ingredients)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(recipe_item) order by recipe_item.product_id, recipe_item.id)
      from public.product_recipe_items as recipe_item
      where recipe_item.ingredient_id in (select id from removal_target_ingredients)
    ), '[]'::jsonb)
  );

  -- Keep the standard inventory recovery path populated as well, so a restore
  -- can be driven from the same table every other Kho NVL removal used.
  insert into private.inventory_reset_backups (
    period_start,
    period_end_exclusive,
    reason,
    receipts,
    history_rows,
    active_sessions,
    daily_sequences,
    ingredient_master_links
  ) values (
    date '0001-01-01',
    date '9999-12-31',
    'Owner-requested total erasure of the Bánh snack - nhỏ @1700 and Nước ngọt COCA @5200 lots, including every lifecycle status, cost recognition, ingredient master row and recipe component',
    coalesce((
      select jsonb_agg(to_jsonb(receipt) order by receipt.purchased_on, receipt.receipt_code, receipt.id)
      from public.inventory_receipts as receipt
      where receipt.id in (select id from removal_target_receipts)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(history) order by history.created_at, history.id)
      from public.inventory_history as history
      where history.inventory_receipt_id in (select id from removal_target_receipts)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(session) order by session.activated_at, session.id)
      from public.inventory_active_sessions as session
      where session.source_receipt_id in (select id from removal_target_receipts)
    ), '[]'::jsonb),
    '[]'::jsonb,
    coalesce((
      select jsonb_agg(to_jsonb(ingredient) order by ingredient.id)
      from public.ingredient_master as ingredient
      where ingredient.id in (select id from removal_target_ingredients)
    ), '[]'::jsonb)
  );

  -- 1. Recipe components first: product_recipe_items.ingredient_id is nullable
  -- but guarded by product_recipe_items_source_check, so the row cannot simply
  -- be detached from its ingredient - it has to go.
  delete from public.product_recipe_items as recipe_item
  where recipe_item.ingredient_id in (select id from removal_target_ingredients);
  get diagnostics deleted_recipe_items = row_count;

  -- 2. Lifecycle rows in every status. The receipt FK cascades since
  -- 20260728000100, but deleting explicitly keeps the counts verifiable.
  delete from public.inventory_active_sessions as session
  where session.source_receipt_id in (select id from removal_target_receipts);
  get diagnostics deleted_sessions = row_count;

  -- 3. Audit history.
  delete from public.inventory_history as history
  where history.inventory_receipt_id in (select id from removal_target_receipts);
  get diagnostics deleted_history = row_count;

  -- 4. The lots.
  delete from public.inventory_receipts as receipt
  where receipt.id in (select id from removal_target_receipts);
  get diagnostics deleted_receipts = row_count;

  -- 5. Master data, now unreferenced.
  delete from public.ingredient_master as ingredient
  where ingredient.id in (select id from removal_target_ingredients);
  get diagnostics deleted_ingredients = row_count;

  if deleted_recipe_items <> recipe_item_count then
    raise exception 'Snack 1700 / COCA 5200 erasure deleted % of % expected recipe component(s)', deleted_recipe_items, recipe_item_count;
  end if;

  if deleted_sessions <> sessions_before then
    raise exception 'Snack 1700 / COCA 5200 erasure deleted % of % expected lifecycle row(s)', deleted_sessions, sessions_before;
  end if;

  if deleted_history <> history_before then
    raise exception 'Snack 1700 / COCA 5200 erasure deleted % of % expected history row(s)', deleted_history, history_before;
  end if;

  if deleted_receipts <> target_receipt_count then
    raise exception 'Snack 1700 / COCA 5200 erasure deleted % of % expected receipt(s)', deleted_receipts, target_receipt_count;
  end if;

  if deleted_ingredients <> ingredient_count then
    raise exception 'Snack 1700 / COCA 5200 erasure deleted % of % expected ingredient master row(s)', deleted_ingredients, ingredient_count;
  end if;

  -- Re-run the original matcher against live data: nothing may survive.
  select count(*) into receipts_after
  from public.inventory_receipts as receipt
  where (lower(receipt.name) like '%snack%' and receipt.unit_cost = 1700)
     or (lower(receipt.name) like '%coca%' and receipt.unit_cost = 5200);

  select count(*) into ingredients_after
  from public.ingredient_master as ingredient
  where (lower(ingredient.name) like '%snack%' and ingredient.latest_purchase_price = 1700)
     or (lower(ingredient.name) like '%coca%' and ingredient.latest_purchase_price = 5200);

  if receipts_after <> 0 or ingredients_after <> 0 then
    raise exception 'Snack 1700 / COCA 5200 erasure incomplete: % receipt(s) and % ingredient master row(s) still match',
      receipts_after, ingredients_after;
  end if;

  if (
    select count(*)
    from public.inventory_active_sessions as session
    where session.source_receipt_id in (select id from removal_target_receipts)
  ) <> 0 then
    raise exception 'Snack 1700 / COCA 5200 erasure left lifecycle rows behind';
  end if;

  raise notice 'Snack 1700 / COCA 5200 erasure complete: % receipt(s) (% snack, % coca) worth %, % lifecycle row(s) (active %, used %, wasted %) carrying % recognized cost, % history row(s), % ingredient master row(s), % recipe component(s) across % product(s)',
    deleted_receipts, snack_receipt_count, coca_receipt_count, lot_value,
    deleted_sessions, active_before, used_before, wasted_before, recognized_cost_before,
    deleted_history, deleted_ingredients, deleted_recipe_items, affected_product_count;
end $$;

notify pgrst, 'reload schema';

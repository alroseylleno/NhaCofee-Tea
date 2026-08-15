-- Owner-requested production cleanup for receipt 010726-027.
-- Remove exactly 41 sealed CARNATION EXTRA cream boxes from stock value while
-- preserving every active, used, and wasted lifecycle session unchanged.

do $$
declare
  target_receipt_count integer;
  lifecycle_before integer;
  active_before integer;
  used_before integer;
  wasted_before integer;
  total_before numeric;
  sealed_before numeric;
  total_after numeric;
  sealed_after numeric;
  lifecycle_after integer;
  active_after integer;
  used_after integer;
  wasted_after integer;
begin
  create temporary table target_receipt on commit drop as
  select receipt.id
  from public.inventory_receipts as receipt
  where receipt.receipt_code = '010726-027'
    and receipt.total_quantity = 48
    and lower(receipt.name || ' ' || receipt.brand) like '%carnation extra%'
    and (
      lower(receipt.name || ' ' || receipt.brand) like '%kem béo%'
      or lower(receipt.name || ' ' || receipt.brand) like '%kem beo%'
    );

  select count(*) into target_receipt_count from target_receipt;
  if target_receipt_count <> 1 then
    raise exception 'Expected exactly one 48-box CARNATION EXTRA receipt 010726-027, found %', target_receipt_count;
  end if;

  select
    receipt.total_quantity,
    receipt.total_quantity - count(session.id)::numeric,
    count(session.id),
    count(*) filter (where session.status = 'active'),
    count(*) filter (where session.status = 'used'),
    count(*) filter (where session.status = 'wasted')
  into total_before, sealed_before, lifecycle_before, active_before, used_before, wasted_before
  from public.inventory_receipts as receipt
  left join public.inventory_active_sessions as session on session.source_receipt_id = receipt.id
  where receipt.id in (select id from target_receipt)
  group by receipt.id, receipt.total_quantity;

  if sealed_before <> 41 then
    raise exception 'Receipt 010726-027 safeguard expected 41 sealed boxes before cleanup, found %', sealed_before;
  end if;

  -- Snapshot the exact receipt and preserved lifecycle rows before this
  -- one-time stock-value adjustment for recovery/audit purposes.
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
    date '2026-07-01',
    date '2026-08-01',
    'Owner-requested: clear 41 sealed CARNATION EXTRA cream boxes from receipt 010726-027; retain all active, used, and wasted lifecycle rows',
    coalesce((
      select jsonb_agg(to_jsonb(receipt))
      from public.inventory_receipts as receipt
      where receipt.id in (select id from target_receipt)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(history) order by history.created_at, history.id)
      from public.inventory_history as history
      where history.inventory_receipt_id in (select id from target_receipt)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(session) order by session.activated_at, session.id)
      from public.inventory_active_sessions as session
      where session.source_receipt_id in (select id from target_receipt)
    ), '[]'::jsonb),
    '[]'::jsonb,
    coalesce((
      select jsonb_agg(to_jsonb(ingredient) order by ingredient.id)
      from public.ingredient_master as ingredient
      where ingredient.source_inventory_receipt_id in (select id from target_receipt)
    ), '[]'::jsonb)
  );

  -- Keeping the receipt quantity equal to its lifecycle count makes sealed
  -- quantity zero, so the 41 boxes no longer contribute inventory value.
  update public.inventory_receipts as receipt
  set total_quantity = lifecycle_before,
      updated_at = now()
  where receipt.id in (select id from target_receipt);

  insert into public.inventory_history (inventory_receipt_id, action, changes)
  select
    id,
    'updated',
    jsonb_build_array(jsonb_build_object(
      'field', 'quantity',
      'from', total_before::text,
      'to', lifecycle_before::text,
      'reason', 'Owner-requested clear of 41 sealed boxes; lifecycle sessions retained'
    ))
  from target_receipt;

  select
    receipt.total_quantity,
    receipt.total_quantity - count(session.id)::numeric,
    count(session.id),
    count(*) filter (where session.status = 'active'),
    count(*) filter (where session.status = 'used'),
    count(*) filter (where session.status = 'wasted')
  into total_after, sealed_after, lifecycle_after, active_after, used_after, wasted_after
  from public.inventory_receipts as receipt
  left join public.inventory_active_sessions as session on session.source_receipt_id = receipt.id
  where receipt.id in (select id from target_receipt)
  group by receipt.id, receipt.total_quantity;

  if total_after <> lifecycle_before or sealed_after <> 0 then
    raise exception 'Receipt 010726-027 cleanup failed: total %, lifecycle %, sealed %', total_after, lifecycle_before, sealed_after;
  end if;

  if lifecycle_after <> lifecycle_before
    or active_after <> active_before
    or used_after <> used_before
    or wasted_after <> wasted_before then
    raise exception 'Receipt 010726-027 lifecycle safeguard failed: sessions % -> %, active % -> %, used % -> %, wasted % -> %',
      lifecycle_before, lifecycle_after, active_before, active_after, used_before, used_after, wasted_before, wasted_after;
  end if;

  raise notice 'Receipt 010726-027 complete: cleared 41 sealed boxes from inventory value; retained % lifecycle rows (active %, used %, wasted %)',
    lifecycle_after, active_after, used_after, wasted_after;
end $$;

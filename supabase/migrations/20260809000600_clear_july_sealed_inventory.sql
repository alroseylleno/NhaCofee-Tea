-- Remove only sealed July 2026 inventory at the owner's request.
-- Receipts with active/used/wasted lifecycle rows are retained; their receipt
-- quantity is reduced to the lifecycle-row count so sealed stock becomes zero.

do $$
declare
  sessions_before integer;
  sessions_after integer;
  remaining_sealed_receipts integer;
begin
  select count(*)
    into sessions_before
    from public.inventory_active_sessions as session
    join public.inventory_receipts as receipt on receipt.id = session.source_receipt_id
   where receipt.purchased_on >= date '2026-07-01'
     and receipt.purchased_on < date '2026-08-01';

  create temporary table july_inventory_cleanup_targets on commit drop as
  select
    receipt.id,
    receipt.total_quantity as original_quantity,
    count(session.id)::numeric as lifecycle_quantity
  from public.inventory_receipts as receipt
  left join public.inventory_active_sessions as session on session.source_receipt_id = receipt.id
  where receipt.purchased_on >= date '2026-07-01'
    and receipt.purchased_on < date '2026-08-01'
  group by receipt.id, receipt.total_quantity;

  -- A receipt without lifecycle rows represents stock only and can be removed.
  delete from public.inventory_receipts as receipt
    using july_inventory_cleanup_targets as target
   where receipt.id = target.id
     and target.lifecycle_quantity = 0;

  -- Preserve every lifecycle row while removing any sealed units on mixed lots.
  update public.inventory_receipts as receipt
     set total_quantity = target.lifecycle_quantity,
         updated_at = now()
    from july_inventory_cleanup_targets as target
   where receipt.id = target.id
     and target.lifecycle_quantity > 0
     and receipt.total_quantity > target.lifecycle_quantity;

  insert into public.inventory_history (
    inventory_receipt_id, action, changes
  )
  select
    target.id,
    'updated',
    jsonb_build_array(jsonb_build_object(
      'field', 'quantity',
      'from', target.original_quantity::text,
      'to', target.lifecycle_quantity::text
    ))
  from july_inventory_cleanup_targets as target
  where target.lifecycle_quantity > 0
    and target.original_quantity > target.lifecycle_quantity;

  select count(*)
    into sessions_after
    from public.inventory_active_sessions as session
    join public.inventory_receipts as receipt on receipt.id = session.source_receipt_id
   where receipt.purchased_on >= date '2026-07-01'
     and receipt.purchased_on < date '2026-08-01';

  if sessions_after <> sessions_before then
    raise exception 'July lifecycle safeguard failed: before %, after %', sessions_before, sessions_after;
  end if;

  select count(*)
    into remaining_sealed_receipts
    from public.inventory_receipts as receipt
   where receipt.purchased_on >= date '2026-07-01'
     and receipt.purchased_on < date '2026-08-01'
     and receipt.total_quantity > (
       select count(*)
       from public.inventory_active_sessions as session
       where session.source_receipt_id = receipt.id
     );

  if remaining_sealed_receipts <> 0 then
    raise exception 'July inventory cleanup left % receipts with sealed stock', remaining_sealed_receipts;
  end if;
end $$;

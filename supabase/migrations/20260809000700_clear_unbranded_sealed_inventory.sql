-- Remove sealed stock for receipts without a recorded brand.
-- Lifecycle rows and the minimum receipt quantity needed by those rows remain.

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
   where receipt.brand is null
      or btrim(receipt.brand) = ''
      or lower(btrim(receipt.brand)) in ('chưa ghi thương hiệu', 'chua ghi thuong hieu');

  create temporary table unbranded_inventory_cleanup_targets on commit drop as
  select
    receipt.id,
    receipt.total_quantity as original_quantity,
    count(session.id)::numeric as lifecycle_quantity
  from public.inventory_receipts as receipt
  left join public.inventory_active_sessions as session on session.source_receipt_id = receipt.id
  where receipt.brand is null
     or btrim(receipt.brand) = ''
     or lower(btrim(receipt.brand)) in ('chưa ghi thương hiệu', 'chua ghi thuong hieu')
  group by receipt.id, receipt.total_quantity;

  delete from public.inventory_receipts as receipt
    using unbranded_inventory_cleanup_targets as target
   where receipt.id = target.id
     and target.lifecycle_quantity = 0;

  update public.inventory_receipts as receipt
     set total_quantity = target.lifecycle_quantity,
         updated_at = now()
    from unbranded_inventory_cleanup_targets as target
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
  from unbranded_inventory_cleanup_targets as target
  where target.lifecycle_quantity > 0
    and target.original_quantity > target.lifecycle_quantity;

  select count(*)
    into sessions_after
    from public.inventory_active_sessions as session
    join public.inventory_receipts as receipt on receipt.id = session.source_receipt_id
   where receipt.brand is null
      or btrim(receipt.brand) = ''
      or lower(btrim(receipt.brand)) in ('chưa ghi thương hiệu', 'chua ghi thuong hieu');

  if sessions_after <> sessions_before then
    raise exception 'Unbranded lifecycle safeguard failed: before %, after %', sessions_before, sessions_after;
  end if;

  select count(*)
    into remaining_sealed_receipts
    from public.inventory_receipts as receipt
   where (
       receipt.brand is null
       or btrim(receipt.brand) = ''
       or lower(btrim(receipt.brand)) in ('chưa ghi thương hiệu', 'chua ghi thuong hieu')
     )
     and receipt.total_quantity > (
       select count(*)
       from public.inventory_active_sessions as session
       where session.source_receipt_id = receipt.id
     );

  if remaining_sealed_receipts <> 0 then
    raise exception 'Unbranded cleanup left % receipts with sealed stock', remaining_sealed_receipts;
  end if;
end $$;

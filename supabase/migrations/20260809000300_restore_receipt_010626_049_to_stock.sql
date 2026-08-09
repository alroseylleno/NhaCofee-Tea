-- One-time Production correction requested for receipt 010626-049.
-- A used lifecycle session consumes one sealed unit, so deleting the exact
-- mistaken session returns that unit to inventory without changing the receipt.

do $$
declare
  matched_sessions integer;
begin
  select count(*)
    into matched_sessions
    from public.inventory_active_sessions as session
    join public.inventory_receipts as receipt on receipt.id = session.source_receipt_id
   where receipt.receipt_code = '010626-049'
     and session.status = 'used'
     and session.cost_recognition_month = date '2026-08-01';

  if matched_sessions <> 1 then
    raise exception 'Expected exactly one used August 2026 session for receipt 010626-049, found %', matched_sessions;
  end if;

  delete from public.inventory_active_sessions as session
    using public.inventory_receipts as receipt
   where receipt.id = session.source_receipt_id
     and receipt.receipt_code = '010626-049'
     and session.status = 'used'
     and session.cost_recognition_month = date '2026-08-01';
end $$;

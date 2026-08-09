-- Correct the calendar-date import bug for the 09 Aug 2026 inventory file.
-- The Excel file contains 87 receipt codes 010726-001..088 (without 033),
-- all intended as 2026-07-01 and incorrectly saved as 2026-06-30.

do $$
declare
  matched_receipts integer;
begin
  select count(*)
    into matched_receipts
    from public.inventory_receipts
   where receipt_code like '010726-%'
     and receipt_code <> '010726-033'
     and purchased_on = date '2026-06-30';

  if matched_receipts <> 87 then
    raise exception 'Expected 87 June 30 records for the 010726 inventory import, found %', matched_receipts;
  end if;

  update public.inventory_receipts
     set purchased_on = date '2026-07-01'
   where receipt_code like '010726-%'
     and receipt_code <> '010726-033'
     and purchased_on = date '2026-06-30';
end $$;

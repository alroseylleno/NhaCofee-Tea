-- Correct the calendar-date import bug for the 09 Aug 2026 inventory file.
-- The date bug also made the automatic receipt-code trigger generate
-- 300626-001..088 (without 033), rather than the intended 010726 codes.

do $$
declare
  matched_receipts integer;
  conflicting_receipts integer;
begin
  select count(*)
    into matched_receipts
    from public.inventory_receipts
   where receipt_code like '300626-%'
     and receipt_code <> '300626-033'
     and purchased_on = date '2026-06-30';

  if matched_receipts <> 87 then
    raise exception 'Expected 87 June 30 records for the 300626 inventory import, found %', matched_receipts;
  end if;

  -- Do not overwrite a legitimate 01 Jul receipt code if one already exists.
  select count(*)
    into conflicting_receipts
    from public.inventory_receipts
   where receipt_code like '010726-%';

  if conflicting_receipts <> 0 then
    raise exception 'Cannot correct inventory import: found % existing 010726 receipt codes', conflicting_receipts;
  end if;

  update public.inventory_receipts
     set purchased_on = date '2026-07-01',
         receipt_code = '010726-' || right(receipt_code, 3)
   where receipt_code like '300626-%'
     and receipt_code <> '300626-033'
     and purchased_on = date '2026-06-30';

  insert into public.inventory_receipt_daily_sequences (purchased_on, last_number)
  values (date '2026-07-01', 88)
  on conflict (purchased_on) do update
    set last_number = greatest(
      public.inventory_receipt_daily_sequences.last_number,
      excluded.last_number
    );
end $$;

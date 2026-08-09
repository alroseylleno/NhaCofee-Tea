-- Correct the calendar-date import bug for the 09 Aug 2026 inventory file.
-- The workbook explicitly supplies receipt codes 010726-001..088 (without
-- 033). Only these exact codes are in scope for the one-time correction.

do $$
declare
  matched_receipts integer;
begin
  select count(*)
    into matched_receipts
    from public.inventory_receipts
   where receipt_code ~ '^010726-(00[1-9]|0[1-7][0-9]|08[0-8])$'
     and receipt_code <> '010726-033'
     and purchased_on = date '2026-06-30';

  if matched_receipts = 0 then
    raise exception 'Could not find June 30 records from the supplied 01 Jul inventory workbook';
  end if;

  update public.inventory_receipts
     set purchased_on = date '2026-07-01'
   where receipt_code ~ '^010726-(00[1-9]|0[1-7][0-9]|08[0-8])$'
     and receipt_code <> '010726-033'
     and purchased_on = date '2026-06-30';

  insert into public.inventory_receipt_daily_sequences (purchased_on, last_number)
  values (date '2026-07-01', 88)
  on conflict (purchased_on) do update
    set last_number = greatest(
      public.inventory_receipt_daily_sequences.last_number,
      excluded.last_number
    );
end $$;

-- Store the usable-output conversion for a sealed inventory unit.
alter table public.inventory_receipts
  add column if not exists conversion_amount numeric,
  add column if not exists conversion_unit text;

alter table public.inventory_receipts
  drop constraint if exists inventory_receipts_conversion_check;

alter table public.inventory_receipts
  add constraint inventory_receipts_conversion_check
  check (
    (conversion_amount is null and conversion_unit is null)
    or (conversion_amount > 0 and conversion_unit is not null and length(trim(conversion_unit)) > 0)
  );

notify pgrst, 'reload schema';

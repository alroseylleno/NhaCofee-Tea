-- Store a complete Excel import in one transaction so a failed row cannot
-- leave a partially imported workbook in Production.

create or replace function public.import_inventory_receipts(payload jsonb)
returns table (created_count integer, updated_count integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  entry jsonb;
  item jsonb;
  event jsonb;
  meta jsonb;
  stored_id uuid;
  receipt_code_value text;
  existing_receipt boolean;
  created_total integer := 0;
  updated_total integer := 0;
begin
  if jsonb_typeof(payload) <> 'array' or jsonb_array_length(payload) = 0 then
    raise exception 'Inventory import payload must contain at least one row';
  end if;

  for entry in select value from jsonb_array_elements(payload)
  loop
    item := entry->'item';
    event := entry->'event';
    meta := entry->'meta';
    receipt_code_value := nullif(trim(item->>'receiptCode'), '');

    if item is null or event is null then
      raise exception 'Each inventory import row must include item and history data';
    end if;

    select receipt_code_value is not null and exists (
      select 1 from public.inventory_receipts where receipt_code = receipt_code_value
    ) into existing_receipt;

    insert into public.inventory_receipts (
      id, name, category, brand, receipt_code, total_quantity, unit, specification,
      conversion_amount, conversion_unit, unit_cost, purchased_on, supplier,
      expires_on, shelf_life_hours, storage_location, receipt_path, receipt_name
    ) values (
      (item->>'id')::uuid, item->>'name', item->>'category', item->>'brand', receipt_code_value,
      (item->>'quantity')::numeric, item->>'unit', item->>'specification',
      nullif(item->'conversion'->>'amount', '')::numeric, nullif(item->'conversion'->>'unit', ''),
      (item->>'unitCost')::numeric, (item->>'purchasedOn')::date, item->>'supplier',
      nullif(meta->>'expiresOn', '')::date, nullif(meta->>'shelfLifeHours', '')::numeric,
      coalesce(nullif(meta->>'storageLocation', ''), 'Chưa ghi'),
      nullif(item->'receipt'->>'path', ''), nullif(item->'receipt'->>'name', '')
    )
    on conflict (receipt_code) do update set
      name = excluded.name,
      category = excluded.category,
      brand = excluded.brand,
      total_quantity = excluded.total_quantity,
      unit = excluded.unit,
      specification = excluded.specification,
      conversion_amount = excluded.conversion_amount,
      conversion_unit = excluded.conversion_unit,
      unit_cost = excluded.unit_cost,
      purchased_on = excluded.purchased_on,
      supplier = excluded.supplier,
      expires_on = case when meta is null then public.inventory_receipts.expires_on else excluded.expires_on end,
      shelf_life_hours = case when meta is null then public.inventory_receipts.shelf_life_hours else excluded.shelf_life_hours end,
      storage_location = case when meta is null then public.inventory_receipts.storage_location else excluded.storage_location end,
      receipt_path = coalesce(excluded.receipt_path, public.inventory_receipts.receipt_path),
      receipt_name = coalesce(excluded.receipt_name, public.inventory_receipts.receipt_name),
      updated_at = now()
    returning id into stored_id;

    insert into public.inventory_history (id, inventory_receipt_id, action, changes, created_at)
    values (
      (event->>'id')::uuid, stored_id, event->>'action', coalesce(event->'changes', '[]'::jsonb),
      coalesce(nullif(event->>'at', '')::timestamptz, now())
    );

    if existing_receipt then updated_total := updated_total + 1; else created_total := created_total + 1; end if;
  end loop;

  return query select created_total, updated_total;
end;
$$;

revoke all on function public.import_inventory_receipts(jsonb) from public;
grant execute on function public.import_inventory_receipts(jsonb) to authenticated;

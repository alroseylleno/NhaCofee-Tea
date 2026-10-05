-- Multi-store Kho NVL: every lot belongs to one store (kho), and stock moves
-- between stores through an atomic transfer.
--
-- Additive only. Existing lots fall into the default store NHA-31-7 through the
-- column default, so nothing in Production changes until a second store exists.
--
-- A partial transfer SPLITS the lot instead of tracking an "issued elsewhere"
-- counter: the source loses q units, a child lot in the target store gains q at
-- the same unit cost and purchase date. Total quantity × cost and every purchase
-- date are preserved, so cash-out, opening/closing inventory, Product Master
-- availability and "sealed = quantity − sessions" need no change at all.

alter table public.inventory_receipts
  add column if not exists store_id uuid not null
    default '31070000-0000-4000-8000-000000000001'
    references public.stores(id),
  add column if not exists transferred_from_id uuid
    references public.inventory_receipts(id) on delete restrict,
  add column if not exists transferred_on date;

create index if not exists inventory_receipts_store_idx
  on public.inventory_receipts(store_id, stock_state);
create index if not exists inventory_receipts_transferred_from_idx
  on public.inventory_receipts(transferred_from_id)
  where transferred_from_id is not null;

-- Display name only; Product Master looks the store up by code.
update public.stores
set name = 'Hàn Hải Nguyên', updated_at = now()
where code = 'NHA-31-7' and name <> 'Hàn Hải Nguyên';

-- Return lots from period settlement (both settle RPCs) insert without a
-- store_id, so the column default would silently move an opened bottle from
-- kho 2 back to kho 1. Inherit the store of the lot the session was opened from.
create or replace function public.inherit_inventory_return_store()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  parent_store uuid;
begin
  if new.source_session_id is not null then
    select receipt.store_id into parent_store
    from public.inventory_active_sessions active_session
    join public.inventory_receipts receipt on receipt.id = active_session.source_receipt_id
    where active_session.id = new.source_session_id;
    if parent_store is not null then
      new.store_id := parent_store;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_receipts_inherit_return_store on public.inventory_receipts;
create trigger inventory_receipts_inherit_return_store
before insert on public.inventory_receipts
for each row execute function public.inherit_inventory_return_store();

-- Excel import now carries the store. A new row lands in item.storeId (or the
-- default store); an existing receipt code keeps its store — moving stock
-- between stores must go through transfer_inventory, never through an import.
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
      expires_on, shelf_life_hours, storage_location, receipt_path, receipt_name,
      store_id
    ) values (
      (item->>'id')::uuid, item->>'name', item->>'category', item->>'brand', receipt_code_value,
      (item->>'quantity')::numeric, item->>'unit', item->>'specification',
      nullif(item->'conversion'->>'amount', '')::numeric, nullif(item->'conversion'->>'unit', ''),
      (item->>'unitCost')::numeric, (item->>'purchasedOn')::date, item->>'supplier',
      nullif(meta->>'expiresOn', '')::date, nullif(meta->>'shelfLifeHours', '')::numeric,
      coalesce(nullif(meta->>'storageLocation', ''), 'Chưa ghi'),
      nullif(item->'receipt'->>'path', ''), nullif(item->'receipt'->>'name', ''),
      coalesce(nullif(item->>'storeId', '')::uuid, '31070000-0000-4000-8000-000000000001'::uuid)
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

-- One transfer slip = one call. Each line moves `quantity` sealed units of one
-- lot to `to_store_id`:
--   move  — the whole lot, never opened: only store_id changes.
--   merge — a whole, untouched child lot going back to its parent's store:
--           the quantity returns to the parent and the child is deleted.
--   split — anything else: the source shrinks, a child lot is created.
-- Either every line commits or none does.
create or replace function public.transfer_inventory(p_transferred_on date, p_lines jsonb)
returns table (source_id uuid, transfer_mode text, target_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
declare
  line jsonb;
  source_lot public.inventory_receipts%rowtype;
  parent_lot public.inventory_receipts%rowtype;
  move_quantity numeric;
  target_store uuid;
  new_lot_id uuid;
  issued_count integer;
  child_count integer;
  sealed_quantity numeric;
  from_store_name text;
  to_store_name text;
  generated_code text;
  event_at timestamptz;
begin
  if p_transferred_on is null or p_transferred_on > (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'Ngày chuyển kho không hợp lệ hoặc nằm trong tương lai';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Phiếu chuyển kho chưa có dòng nào';
  end if;
  event_at := now();

  for line in select value from jsonb_array_elements(p_lines)
  loop
    move_quantity := nullif(line->>'quantity', '')::numeric;
    target_store := nullif(line->>'to_store_id', '')::uuid;
    new_lot_id := nullif(line->>'new_lot_id', '')::uuid;

    select * into source_lot
    from public.inventory_receipts
    where id = nullif(line->>'source_id', '')::uuid
    for update;
    if not found then
      raise exception 'Không tìm thấy lô cần chuyển';
    end if;

    select name into to_store_name from public.stores where id = target_store and status = 'active';
    if to_store_name is null then
      raise exception 'Kho đích không tồn tại hoặc đã ngưng hoạt động';
    end if;
    if source_lot.store_id = target_store then
      raise exception 'Lô % đã nằm ở kho %', coalesce(source_lot.receipt_code, source_lot.name), to_store_name;
    end if;
    select name into from_store_name from public.stores where id = source_lot.store_id;

    select count(*) into issued_count
    from public.inventory_active_sessions
    where source_receipt_id = source_lot.id;
    sealed_quantity := source_lot.total_quantity - issued_count;
    if move_quantity is null or move_quantity <= 0 or move_quantity > sealed_quantity then
      raise exception 'Lô % chỉ còn % % niêm phong, không chuyển được %',
        coalesce(source_lot.receipt_code, source_lot.name), greatest(sealed_quantity, 0), source_lot.unit, coalesce(move_quantity, 0);
    end if;

    select count(*) into child_count
    from public.inventory_receipts
    where transferred_from_id = source_lot.id;

    if move_quantity = source_lot.total_quantity and issued_count = 0 then
      if source_lot.transferred_from_id is not null and child_count = 0 then
        select * into parent_lot
        from public.inventory_receipts
        where id = source_lot.transferred_from_id
        for update;
        if found and parent_lot.store_id = target_store and parent_lot.unit_cost = source_lot.unit_cost then
          update public.inventory_receipts
          set total_quantity = total_quantity + move_quantity, updated_at = now()
          where id = parent_lot.id;
          insert into public.inventory_history (id, inventory_receipt_id, action, changes, created_at)
          values (
            gen_random_uuid(), parent_lot.id, 'updated',
            jsonb_build_array(
              jsonb_build_object('field', 'quantity', 'from', parent_lot.total_quantity::text, 'to', (parent_lot.total_quantity + move_quantity)::text),
              jsonb_build_object('field', 'transfer', 'from', coalesce(from_store_name, '?') || ' · ' || coalesce(source_lot.receipt_code, ''), 'to', 'Gộp lại ' || to_store_name || ' · ' || to_char(p_transferred_on, 'DD/MM/YYYY'))
            ),
            event_at
          );
          delete from public.inventory_receipts where id = source_lot.id;
          source_id := source_lot.id; transfer_mode := 'merge'; target_id := parent_lot.id;
          return next;
          continue;
        end if;
      end if;

      update public.inventory_receipts
      set store_id = target_store, transferred_on = p_transferred_on, updated_at = now()
      where id = source_lot.id;
      insert into public.inventory_history (id, inventory_receipt_id, action, changes, created_at)
      values (
        gen_random_uuid(), source_lot.id, 'updated',
        jsonb_build_array(jsonb_build_object('field', 'store', 'from', coalesce(from_store_name, '?'), 'to', to_store_name || ' · ' || to_char(p_transferred_on, 'DD/MM/YYYY'))),
        event_at
      );
      source_id := source_lot.id; transfer_mode := 'move'; target_id := source_lot.id;
      return next;
      continue;
    end if;

    if new_lot_id is null then
      raise exception 'Thiếu mã lô mới cho dòng chuyển một phần';
    end if;
    generated_code := coalesce(source_lot.receipt_code, 'NO-CODE')
      || '-CK-' || to_char(p_transferred_on, 'YYYYMMDD')
      || '-' || upper(left(new_lot_id::text, 4));

    update public.inventory_receipts
    set total_quantity = total_quantity - move_quantity, updated_at = now()
    where id = source_lot.id;

    insert into public.inventory_receipts (
      id, name, category, brand, receipt_code, total_quantity, unit, specification,
      conversion_amount, conversion_unit, unit_cost, purchased_on, supplier,
      receipt_path, receipt_name, expires_on, shelf_life_hours, storage_location,
      stock_state, returned_on, first_opened_at, store_id, transferred_from_id,
      transferred_on, created_at, updated_at
    ) values (
      new_lot_id, source_lot.name, source_lot.category, source_lot.brand, generated_code,
      move_quantity, source_lot.unit, source_lot.specification,
      source_lot.conversion_amount, source_lot.conversion_unit, source_lot.unit_cost,
      source_lot.purchased_on, source_lot.supplier, source_lot.receipt_path,
      source_lot.receipt_name, source_lot.expires_on, source_lot.shelf_life_hours,
      source_lot.storage_location, source_lot.stock_state, source_lot.returned_on,
      source_lot.first_opened_at, target_store, source_lot.id, p_transferred_on, now(), now()
    );

    insert into public.inventory_history (id, inventory_receipt_id, action, changes, created_at)
    values
      (
        gen_random_uuid(), source_lot.id, 'updated',
        jsonb_build_array(
          jsonb_build_object('field', 'quantity', 'from', source_lot.total_quantity::text, 'to', (source_lot.total_quantity - move_quantity)::text),
          jsonb_build_object('field', 'transfer', 'from', coalesce(from_store_name, '?'), 'to', to_store_name || ' · ' || move_quantity::text || ' ' || source_lot.unit || ' · ' || to_char(p_transferred_on, 'DD/MM/YYYY'))
        ),
        event_at
      ),
      (
        gen_random_uuid(), new_lot_id, 'created',
        jsonb_build_array(jsonb_build_object('field', 'transfer', 'from', coalesce(from_store_name, '?') || ' · ' || coalesce(source_lot.receipt_code, ''), 'to', to_store_name || ' · ' || to_char(p_transferred_on, 'DD/MM/YYYY'))),
        event_at
      );

    source_id := source_lot.id; transfer_mode := 'split'; target_id := new_lot_id;
    return next;
  end loop;
end;
$$;

revoke all on function public.transfer_inventory(date, jsonb) from public;
grant execute on function public.transfer_inventory(date, jsonb) to authenticated;

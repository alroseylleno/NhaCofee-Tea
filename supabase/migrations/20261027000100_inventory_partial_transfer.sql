-- Chuyển kho theo định lượng: move PART of one unit (300 g out of a 500 g bag,
-- 500 cái out of a 2.000-cái thùng) to another kho.
--
-- The part that leaves and the part that stays each become a "piece": a
-- one-unit opened lot whose piece_amount is its real định lượng, with
-- conversion and unit cost scaled by amount / định lượng per unit. Rounding
-- goes to the moved piece (whole đồng, conversion to 2 decimals) and the
-- remainder takes the exact difference, so quantity × cost and total
-- conversion are conserved to the đồng.
--
-- A piece issues exactly like the opened return lots from period settlement:
-- "Mở" takes it as one unit at its own cost and conversion, so active
-- sessions, COGS, settlement and Product Master need no change. Unlike a
-- return lot it is still purchased stock (no source_session_id), which is how
-- Finance keeps counting it as a purchase on the original purchase date.
--
-- Additive: unit-based lines behave as in 20261005000100, except that the
-- quantity must now be a whole number, and a piece never merges back into its
-- parent (two pieces can carry the same cost — 250 g + 250 g of a 500 g bag —
-- and a merge would turn one unit into two).

alter table public.inventory_receipts
  add column if not exists piece_amount numeric;

alter table public.inventory_receipts
  drop constraint if exists inventory_receipts_piece_amount_check;
alter table public.inventory_receipts
  add constraint inventory_receipts_piece_amount_check
  check (piece_amount is null or (piece_amount > 0 and total_quantity = 1));

-- Leading number of the định lượng text ("500 g" -> 500). The browser parses
-- with the same pattern and sends its value as unit_amount; the RPC refuses a
-- line where the two disagree instead of splitting at the wrong ratio.
create or replace function public.inventory_spec_amount(spec text)
returns numeric
language sql
immutable
set search_path = public
as $$
  select nullif(replace(substring(coalesce(spec, '') from '^[[:space:]]*([0-9]+(?:[.,][0-9]+)?)[[:space:]]*[^[:space:][:digit:]]'), ',', '.'), '')::numeric
$$;

create or replace function public.inventory_spec_unit(spec text)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(substring(coalesce(spec, '') from '^[[:space:]]*[0-9]+(?:[.,][0-9]+)?[[:space:]]*([^[:space:][:digit:]]+)'), '')
$$;

-- One transfer slip = one call. A line either moves `quantity` whole units
-- (move / merge / split, unchanged) or, when it carries `amount`, moves that
-- định lượng out of ONE unit (piece). Either every line commits or none does.
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
  move_amount numeric;
  unit_amount numeric;
  spec_unit text;
  moved_cost numeric;
  moved_conversion numeric;
  opened_at timestamptz;
  target_store uuid;
  new_lot_id uuid;
  remainder_lot_id uuid;
  issued_count integer;
  child_count integer;
  sealed_quantity numeric;
  from_store_name text;
  to_store_name text;
  generated_code text;
  remainder_code text;
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
    move_amount := nullif(line->>'amount', '')::numeric;
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

    -- Piece: move part of one unit by định lượng.
    if move_amount is not null then
      if source_lot.stock_state = 'opened' and source_lot.piece_amount is null then
        raise exception 'Lô % là phần hoàn kho sau kết kỳ, chỉ chuyển được nguyên lô', coalesce(source_lot.receipt_code, source_lot.name);
      end if;
      if sealed_quantity < 1 then
        raise exception 'Lô % không còn đơn vị nào trong kho để tách', coalesce(source_lot.receipt_code, source_lot.name);
      end if;
      unit_amount := coalesce(source_lot.piece_amount, public.inventory_spec_amount(source_lot.specification));
      spec_unit := public.inventory_spec_unit(source_lot.specification);
      if unit_amount is null or unit_amount <= 0 then
        raise exception 'Lô % chưa có định lượng mỗi đơn vị nên không chuyển theo định lượng được', coalesce(source_lot.receipt_code, source_lot.name);
      end if;
      if nullif(line->>'unit_amount', '')::numeric is distinct from unit_amount then
        raise exception 'Định lượng của lô % vừa thay đổi. Tải lại trang rồi chuyển lại', coalesce(source_lot.receipt_code, source_lot.name);
      end if;
      if move_amount <= 0 or move_amount >= unit_amount then
        raise exception 'Lô % mỗi phần còn % %, chỉ tách được ít hơn mức này', coalesce(source_lot.receipt_code, source_lot.name), unit_amount, spec_unit;
      end if;
      if new_lot_id is null then
        raise exception 'Thiếu mã lô mới cho dòng chuyển theo định lượng';
      end if;

      moved_cost := round(source_lot.unit_cost * move_amount / unit_amount);
      moved_conversion := round(source_lot.conversion_amount * move_amount / unit_amount, 2);
      opened_at := coalesce(source_lot.first_opened_at, event_at);
      generated_code := coalesce(source_lot.receipt_code, 'NO-CODE')
        || '-CK-' || to_char(p_transferred_on, 'YYYYMMDD')
        || '-' || upper(left(new_lot_id::text, 4));

      if source_lot.piece_amount is not null or source_lot.total_quantity = 1 then
        -- The lot holds just this unit: it becomes the remainder in place.
        update public.inventory_receipts
        set piece_amount = unit_amount - move_amount,
            unit_cost = unit_cost - moved_cost,
            conversion_amount = conversion_amount - moved_conversion,
            stock_state = 'opened',
            first_opened_at = opened_at,
            updated_at = now()
        where id = source_lot.id;
        insert into public.inventory_history (id, inventory_receipt_id, action, changes, created_at)
        values (
          gen_random_uuid(), source_lot.id, 'updated',
          jsonb_build_array(
            jsonb_build_object('field', 'piece', 'from', unit_amount::text || ' ' || spec_unit, 'to', (unit_amount - move_amount)::text || ' ' || spec_unit),
            jsonb_build_object('field', 'unitCost', 'from', source_lot.unit_cost::text, 'to', (source_lot.unit_cost - moved_cost)::text),
            jsonb_build_object('field', 'transfer', 'from', coalesce(from_store_name, '?'), 'to', to_store_name || ' · ' || move_amount::text || ' ' || spec_unit || ' · ' || to_char(p_transferred_on, 'DD/MM/YYYY'))
          ),
          event_at
        );
      else
        -- Break one unit off a multi-unit lot: what stays becomes its own piece.
        remainder_lot_id := nullif(line->>'remainder_lot_id', '')::uuid;
        if remainder_lot_id is null then
          raise exception 'Thiếu mã lô phần còn lại cho dòng chuyển theo định lượng';
        end if;
        remainder_code := coalesce(source_lot.receipt_code, 'NO-CODE')
          || '-LE-' || to_char(p_transferred_on, 'YYYYMMDD')
          || '-' || upper(left(remainder_lot_id::text, 4));

        update public.inventory_receipts
        set total_quantity = total_quantity - 1, updated_at = now()
        where id = source_lot.id;

        insert into public.inventory_receipts (
          id, name, category, brand, receipt_code, total_quantity, unit, specification,
          conversion_amount, conversion_unit, unit_cost, purchased_on, supplier,
          receipt_path, receipt_name, expires_on, shelf_life_hours, storage_location,
          stock_state, first_opened_at, store_id, piece_amount, created_at, updated_at
        ) values (
          remainder_lot_id, source_lot.name, source_lot.category, source_lot.brand, remainder_code,
          1, source_lot.unit, source_lot.specification,
          source_lot.conversion_amount - moved_conversion, source_lot.conversion_unit, source_lot.unit_cost - moved_cost,
          source_lot.purchased_on, source_lot.supplier, source_lot.receipt_path,
          source_lot.receipt_name, source_lot.expires_on, source_lot.shelf_life_hours,
          source_lot.storage_location, 'opened', opened_at, source_lot.store_id,
          unit_amount - move_amount, now(), now()
        );

        insert into public.inventory_history (id, inventory_receipt_id, action, changes, created_at)
        values
          (
            gen_random_uuid(), source_lot.id, 'updated',
            jsonb_build_array(
              jsonb_build_object('field', 'quantity', 'from', source_lot.total_quantity::text, 'to', (source_lot.total_quantity - 1)::text),
              jsonb_build_object('field', 'piece', 'from', '1 ' || source_lot.unit || ' · ' || unit_amount::text || ' ' || spec_unit, 'to', move_amount::text || ' ' || spec_unit || ' sang ' || to_store_name || ' · ' || (unit_amount - move_amount)::text || ' ' || spec_unit || ' ở lại lô ' || remainder_code)
            ),
            event_at
          ),
          (
            gen_random_uuid(), remainder_lot_id, 'created',
            jsonb_build_array(jsonb_build_object('field', 'piece', 'from', coalesce(source_lot.receipt_code, '') || ' · 1 ' || source_lot.unit || ' ' || unit_amount::text || ' ' || spec_unit, 'to', 'Còn lại ' || (unit_amount - move_amount)::text || ' ' || spec_unit || ' · ' || to_char(p_transferred_on, 'DD/MM/YYYY'))),
            event_at
          );
      end if;

      insert into public.inventory_receipts (
        id, name, category, brand, receipt_code, total_quantity, unit, specification,
        conversion_amount, conversion_unit, unit_cost, purchased_on, supplier,
        receipt_path, receipt_name, expires_on, shelf_life_hours, storage_location,
        stock_state, first_opened_at, store_id, transferred_from_id, transferred_on,
        piece_amount, created_at, updated_at
      ) values (
        new_lot_id, source_lot.name, source_lot.category, source_lot.brand, generated_code,
        1, source_lot.unit, source_lot.specification,
        moved_conversion, source_lot.conversion_unit, moved_cost,
        source_lot.purchased_on, source_lot.supplier, source_lot.receipt_path,
        source_lot.receipt_name, source_lot.expires_on, source_lot.shelf_life_hours,
        source_lot.storage_location, 'opened', opened_at, target_store, source_lot.id,
        p_transferred_on, move_amount, now(), now()
      );
      insert into public.inventory_history (id, inventory_receipt_id, action, changes, created_at)
      values (
        gen_random_uuid(), new_lot_id, 'created',
        jsonb_build_array(jsonb_build_object('field', 'transfer', 'from', coalesce(from_store_name, '?') || ' · ' || coalesce(source_lot.receipt_code, ''), 'to', to_store_name || ' · ' || move_amount::text || ' ' || spec_unit || ' · ' || to_char(p_transferred_on, 'DD/MM/YYYY'))),
        event_at
      );

      source_id := source_lot.id; transfer_mode := 'piece'; target_id := new_lot_id;
      return next;
      continue;
    end if;

    if move_quantity is null or move_quantity <= 0 or move_quantity > sealed_quantity then
      raise exception 'Lô % chỉ còn % % niêm phong, không chuyển được %',
        coalesce(source_lot.receipt_code, source_lot.name), greatest(sealed_quantity, 0), source_lot.unit, coalesce(move_quantity, 0);
    end if;
    -- Sessions issue whole units, so a fractional lot would make
    -- "sealed = quantity − sessions" wrong. Parts of a unit go by định lượng.
    if move_quantity <> trunc(move_quantity) then
      raise exception 'Chuyển theo đơn vị phải là số nguyên. Phần lẻ của % hãy chuyển theo định lượng', source_lot.unit;
    end if;

    select count(*) into child_count
    from public.inventory_receipts
    where transferred_from_id = source_lot.id;

    if move_quantity = source_lot.total_quantity and issued_count = 0 then
      if source_lot.transferred_from_id is not null and child_count = 0 and source_lot.piece_amount is null then
        select * into parent_lot
        from public.inventory_receipts
        where id = source_lot.transferred_from_id
        for update;
        if found and parent_lot.store_id = target_store and parent_lot.unit_cost = source_lot.unit_cost and parent_lot.piece_amount is null then
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

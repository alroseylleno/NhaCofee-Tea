-- A lot can never be opened more times than the units bought on it.
--
-- 06/11/2026: 46 lots held more openings (inventory_active_sessions) than
-- their total_quantity — 85 units, ≈4,48tr of NVL cost with no purchase behind
-- it, while each lot's stock stopped at 0 ("⚠ Chưa khớp" in Tài chính). Two
-- causes, both possible because only the browser checked:
--   * 49 units: lots opened in August, then cut to the quantity on their bill
--     on 02–04/11 (the lot form now refuses such a cut).
--   * 36 units: from 03:14 on 06/11 the table passed PostgREST's 1000-row cap,
--     the app no longer loaded the oldest openings, showed their lots as sealed
--     again, and they were opened a second time (lib/select-all.ts now pages).
-- These triggers hold the rule for every client — a stale tab, two devices
-- opening the last unit at once, a script.
--
-- Rows already over the limit stay readable and editable: an opening that
-- exists is never re-checked (an upsert of it passes), and a lot's quantity
-- may still be raised; only a NEW opening on a used-up lot and a CUT below the
-- openings are refused.

create or replace function public.inventory_session_within_lot()
returns trigger
language plpgsql
as $$
declare
  lot record;
  opened integer;
begin
  if tg_op = 'UPDATE' and new.source_receipt_id is not distinct from old.source_receipt_id then
    return new;
  end if;
  -- An upsert of an opening that already exists fires BEFORE INSERT too.
  if tg_op = 'INSERT' and exists (select 1 from public.inventory_active_sessions where id = new.id) then
    return new;
  end if;
  -- Locking the lot serialises two devices opening its last unit at once.
  select id, name, receipt_code, total_quantity into lot
  from public.inventory_receipts
  where id = new.source_receipt_id
  for update;
  if not found then
    return new; -- the foreign key reports it
  end if;
  select count(*) into opened
  from public.inventory_active_sessions
  where source_receipt_id = new.source_receipt_id and id <> new.id;
  if opened + 1 > lot.total_quantity then
    raise exception 'Lô % (%) đã mở dùng % / % đơn vị — không còn đơn vị niêm phong để mở. Tải lại trang để thấy tồn kho mới nhất.',
      coalesce(lot.receipt_code, '—'), lot.name, opened, lot.total_quantity
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_session_within_lot on public.inventory_active_sessions;
create trigger inventory_session_within_lot
before insert or update of source_receipt_id on public.inventory_active_sessions
for each row execute function public.inventory_session_within_lot();

create or replace function public.inventory_quantity_covers_opened()
returns trigger
language plpgsql
as $$
declare
  opened integer;
begin
  if new.total_quantity >= old.total_quantity then
    return new;
  end if;
  select count(*) into opened
  from public.inventory_active_sessions
  where source_receipt_id = new.id;
  if new.total_quantity < opened then
    raise exception 'Lô % (%) đã mở dùng % đơn vị, nên SL tổng không thể nhỏ hơn % (đang nhập %).',
      coalesce(new.receipt_code, '—'), new.name, opened, opened, new.total_quantity
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists inventory_quantity_covers_opened on public.inventory_receipts;
create trigger inventory_quantity_covers_opened
before update of total_quantity on public.inventory_receipts
for each row execute function public.inventory_quantity_covers_opened();

notify pgrst, 'reload schema';

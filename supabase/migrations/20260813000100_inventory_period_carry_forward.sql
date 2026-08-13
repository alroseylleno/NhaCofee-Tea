-- Close an active inventory session and keep its unused converted balance in
-- the next accounting month as one active session. Everything happens in one
-- transaction so shared inventory can never be left half-settled.

create or replace function public.settle_inventory_period_with_carry(
  p_session_id uuid,
  p_period_end date,
  p_remaining_amount numeric,
  p_returned_lot_id uuid,
  p_continued_session_id uuid,
  p_history_id uuid default null
)
returns table (
  recognized_cost numeric,
  carried_cost numeric,
  returned_lot_id uuid,
  continued_session_id uuid,
  cost_recognition_month date
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  active_session public.inventory_active_sessions%rowtype;
  source_receipt public.inventory_receipts%rowtype;
  opening_amount numeric;
  opening_unit text;
  provisional_amount numeric;
  used_amount numeric;
  recognized_amount numeric;
  carry_amount numeric;
  closed_timestamp timestamptz;
  next_cost_month date;
  generated_receipt_code text;
begin
  if p_period_end is null then
    raise exception 'Settlement date is required';
  end if;

  if p_remaining_amount is null or p_remaining_amount <= 0 then
    raise exception 'Carry-forward requires a remaining amount greater than zero';
  end if;

  if p_returned_lot_id is null or p_continued_session_id is null then
    raise exception 'Carry-forward requires both return lot and continued session IDs';
  end if;

  if p_returned_lot_id = p_continued_session_id then
    raise exception 'Return lot and continued session IDs must differ';
  end if;

  select * into active_session
  from public.inventory_active_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'Active inventory session was not found';
  end if;

  if active_session.status <> 'active' or active_session.settlement is not null then
    raise exception 'Inventory session has already been closed or settled';
  end if;

  select * into source_receipt
  from public.inventory_receipts
  where id = active_session.source_receipt_id;

  if not found then
    raise exception 'Source inventory receipt was not found';
  end if;

  opening_amount := coalesce(active_session.opened_amount, source_receipt.conversion_amount);
  opening_unit := coalesce(active_session.opened_unit, source_receipt.conversion_unit);
  provisional_amount := coalesce(active_session.provisional_cost, source_receipt.unit_cost);

  if opening_amount is null or opening_amount <= 0 or nullif(btrim(opening_unit), '') is null then
    raise exception 'Inventory receipt has no usable conversion';
  end if;

  if p_remaining_amount > opening_amount then
    raise exception 'Remaining amount cannot exceed opening amount';
  end if;

  if p_period_end < (active_session.activated_at at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'Settlement date cannot predate activation';
  end if;

  if p_period_end > (now() at time zone 'Asia/Ho_Chi_Minh')::date then
    raise exception 'Settlement date cannot be in the future';
  end if;

  used_amount := opening_amount - p_remaining_amount;
  recognized_amount := round(provisional_amount * used_amount / opening_amount);
  carry_amount := greatest(0, provisional_amount - recognized_amount);
  closed_timestamp := (p_period_end + time '23:59:59') at time zone 'Asia/Ho_Chi_Minh';
  next_cost_month := (date_trunc('month', p_period_end)::date + interval '1 month')::date;
  generated_receipt_code := coalesce(source_receipt.receipt_code, 'NO-CODE')
    || '-HK-'
    || to_char(p_period_end, 'YYYYMMDD')
    || '-'
    || upper(left(p_returned_lot_id::text, 4));

  update public.inventory_active_sessions
  set status = 'used',
      closed_at = closed_timestamp,
      reason = 'period_close',
      opened_amount = opening_amount,
      opened_unit = opening_unit,
      provisional_cost = provisional_amount,
      recognized_cost = recognized_amount,
      settlement = jsonb_build_object(
        'mode', 'month',
        'periodEnd', p_period_end,
        'openingAmount', opening_amount,
        'remainingAmount', p_remaining_amount,
        'usedAmount', used_amount,
        'unit', opening_unit,
        'returnedLotId', p_returned_lot_id,
        'disposition', 'carry',
        'continuedSessionId', p_continued_session_id
      ),
      updated_at = now()
  where id = active_session.id;

  insert into public.inventory_receipts (
    id, name, category, brand, receipt_code, total_quantity, unit,
    specification, conversion_amount, conversion_unit, unit_cost, purchased_on,
    supplier, receipt_path, receipt_name, expires_on, shelf_life_hours,
    storage_location, stock_state, returned_on, source_session_id,
    first_opened_at, created_at, updated_at
  ) values (
    p_returned_lot_id, source_receipt.name, source_receipt.category,
    source_receipt.brand, generated_receipt_code, 1, source_receipt.unit,
    source_receipt.specification, p_remaining_amount, opening_unit, carry_amount,
    source_receipt.purchased_on, source_receipt.supplier, source_receipt.receipt_path,
    source_receipt.receipt_name, source_receipt.expires_on,
    source_receipt.shelf_life_hours, source_receipt.storage_location, 'opened',
    p_period_end, active_session.id,
    coalesce(source_receipt.first_opened_at, active_session.activated_at), now(), now()
  );

  insert into public.inventory_history (
    id, inventory_receipt_id, action, changes, created_at
  ) values (
    coalesce(p_history_id, gen_random_uuid()), p_returned_lot_id,
    'created', '[]'::jsonb, closed_timestamp
  );

  insert into public.inventory_active_sessions (
    id, source_receipt_id, ingredient_key, activated_at, cost_recognition_month,
    use_by, status, reason, note, opened_amount, opened_unit, provisional_cost,
    recognized_cost, settlement, created_at, updated_at
  ) values (
    p_continued_session_id, p_returned_lot_id, active_session.ingredient_key,
    closed_timestamp, next_cost_month, active_session.use_by, 'active',
    'period_carry', format('Chuyển tiếp %s %s từ kỳ kết thúc %s', p_remaining_amount, opening_unit, to_char(p_period_end, 'DD/MM/YYYY')),
    p_remaining_amount, opening_unit, carry_amount, null, null, now(), now()
  );

  return query
  select recognized_amount, carry_amount, p_returned_lot_id,
    p_continued_session_id, next_cost_month;
end;
$$;

revoke all on function public.settle_inventory_period_with_carry(uuid, date, numeric, uuid, uuid, uuid) from public;
grant execute on function public.settle_inventory_period_with_carry(uuid, date, numeric, uuid, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

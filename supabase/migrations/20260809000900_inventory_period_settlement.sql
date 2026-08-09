-- Persist period settlement in Production and atomically return the unused
-- converted quantity as an opened inventory lot.

alter table public.inventory_receipts
  add column if not exists stock_state text not null default 'sealed',
  add column if not exists returned_on date,
  add column if not exists source_session_id uuid,
  add column if not exists first_opened_at timestamptz;

alter table public.inventory_receipts
  drop constraint if exists inventory_receipts_stock_state_check;

alter table public.inventory_receipts
  add constraint inventory_receipts_stock_state_check
  check (stock_state in ('sealed', 'opened'));

alter table public.inventory_receipts
  drop constraint if exists inventory_receipts_source_session_id_fkey;

alter table public.inventory_receipts
  add constraint inventory_receipts_source_session_id_fkey
  foreign key (source_session_id)
  references public.inventory_active_sessions(id)
  on delete set null;

create unique index if not exists inventory_receipts_source_session_unique
  on public.inventory_receipts(source_session_id)
  where source_session_id is not null;

alter table public.inventory_active_sessions
  add column if not exists opened_amount numeric,
  add column if not exists opened_unit text,
  add column if not exists provisional_cost numeric,
  add column if not exists recognized_cost numeric,
  add column if not exists settlement jsonb;

alter table public.inventory_active_sessions
  drop constraint if exists inventory_active_sessions_opened_amount_check,
  drop constraint if exists inventory_active_sessions_provisional_cost_check,
  drop constraint if exists inventory_active_sessions_recognized_cost_check;

alter table public.inventory_active_sessions
  add constraint inventory_active_sessions_opened_amount_check
    check (opened_amount is null or opened_amount > 0),
  add constraint inventory_active_sessions_provisional_cost_check
    check (provisional_cost is null or provisional_cost >= 0),
  add constraint inventory_active_sessions_recognized_cost_check
    check (recognized_cost is null or recognized_cost >= 0);

update public.inventory_active_sessions as session
set opened_amount = coalesce(session.opened_amount, receipt.conversion_amount),
    opened_unit = coalesce(session.opened_unit, receipt.conversion_unit),
    provisional_cost = coalesce(session.provisional_cost, receipt.unit_cost)
from public.inventory_receipts as receipt
where receipt.id = session.source_receipt_id
  and (
    session.opened_amount is null
    or session.opened_unit is null
    or session.provisional_cost is null
  );

create or replace function public.settle_inventory_period(
  p_session_id uuid,
  p_mode text,
  p_period_end date,
  p_remaining_amount numeric,
  p_returned_lot_id uuid default null,
  p_history_id uuid default null
)
returns table (
  recognized_cost numeric,
  returned_cost numeric,
  returned_lot_id uuid
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
  return_amount numeric;
  closed_timestamp timestamptz;
  generated_receipt_code text;
begin
  if p_mode not in ('week', 'month') then
    raise exception 'Settlement mode must be week or month';
  end if;

  if p_period_end is null then
    raise exception 'Settlement date is required';
  end if;

  if p_remaining_amount is null or p_remaining_amount < 0 then
    raise exception 'Remaining amount must be zero or greater';
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

  if p_remaining_amount > 0 and p_returned_lot_id is null then
    raise exception 'Returned lot ID is required when inventory remains';
  end if;

  used_amount := opening_amount - p_remaining_amount;
  recognized_amount := round(provisional_amount * used_amount / opening_amount);
  return_amount := greatest(0, provisional_amount - recognized_amount);
  closed_timestamp := (p_period_end + time '23:59:59') at time zone 'Asia/Ho_Chi_Minh';

  update public.inventory_active_sessions
  set status = 'used',
      closed_at = closed_timestamp,
      reason = 'period_close',
      opened_amount = opening_amount,
      opened_unit = opening_unit,
      provisional_cost = provisional_amount,
      recognized_cost = recognized_amount,
      settlement = jsonb_build_object(
        'mode', p_mode,
        'periodEnd', p_period_end,
        'openingAmount', opening_amount,
        'remainingAmount', p_remaining_amount,
        'usedAmount', used_amount,
        'unit', opening_unit,
        'returnedLotId', case when p_remaining_amount > 0 then p_returned_lot_id else null end
      ),
      updated_at = now()
  where id = active_session.id;

  if p_remaining_amount > 0 then
    generated_receipt_code := source_receipt.receipt_code
      || '-HK-'
      || to_char(p_period_end, 'YYYYMMDD')
      || '-'
      || upper(left(p_returned_lot_id::text, 4));

    insert into public.inventory_receipts (
      id,
      name,
      category,
      brand,
      receipt_code,
      total_quantity,
      unit,
      specification,
      conversion_amount,
      conversion_unit,
      unit_cost,
      purchased_on,
      supplier,
      receipt_path,
      receipt_name,
      expires_on,
      shelf_life_hours,
      storage_location,
      stock_state,
      returned_on,
      source_session_id,
      first_opened_at,
      created_at,
      updated_at
    ) values (
      p_returned_lot_id,
      source_receipt.name,
      source_receipt.category,
      source_receipt.brand,
      generated_receipt_code,
      1,
      source_receipt.unit,
      source_receipt.specification,
      p_remaining_amount,
      opening_unit,
      return_amount,
      source_receipt.purchased_on,
      source_receipt.supplier,
      source_receipt.receipt_path,
      source_receipt.receipt_name,
      source_receipt.expires_on,
      source_receipt.shelf_life_hours,
      source_receipt.storage_location,
      'opened',
      p_period_end,
      active_session.id,
      coalesce(source_receipt.first_opened_at, active_session.activated_at),
      now(),
      now()
    );

    insert into public.inventory_history (
      id,
      inventory_receipt_id,
      action,
      changes,
      created_at
    ) values (
      coalesce(p_history_id, gen_random_uuid()),
      p_returned_lot_id,
      'created',
      '[]'::jsonb,
      closed_timestamp
    );
  end if;

  return query
  select recognized_amount, return_amount,
    case when p_remaining_amount > 0 then p_returned_lot_id else null end;
end;
$$;

revoke all on function public.settle_inventory_period(uuid, text, date, numeric, uuid, uuid) from public;
grant execute on function public.settle_inventory_period(uuid, text, date, numeric, uuid, uuid) to authenticated;

notify pgrst, 'reload schema';

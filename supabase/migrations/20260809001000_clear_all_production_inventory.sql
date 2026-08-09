-- Irreversibly clear all remaining Production Kho NVL operational data at the
-- owner's request. The private snapshot is for emergency database restoration.

do $$
declare
  receipts_before integer;
  history_before integer;
  sessions_before integer;
  active_before integer;
  used_before integer;
  wasted_before integer;
  sequences_before integer;
  receipts_after integer;
  history_after integer;
  sessions_after integer;
  sequences_after integer;
begin
  select count(*) into receipts_before from public.inventory_receipts;
  select count(*) into history_before from public.inventory_history;
  select count(*) into sessions_before from public.inventory_active_sessions;
  select count(*) into sequences_before from public.inventory_receipt_daily_sequences;

  select
    count(*) filter (where status = 'active'),
    count(*) filter (where status = 'used'),
    count(*) filter (where status = 'wasted')
  into active_before, used_before, wasted_before
  from public.inventory_active_sessions;

  insert into private.inventory_reset_backups (
    period_start,
    period_end_exclusive,
    reason,
    receipts,
    history_rows,
    active_sessions,
    daily_sequences,
    ingredient_master_links
  ) values (
    date '0001-01-01',
    date '9999-12-31',
    'Owner-requested full Kho NVL reset before clean Excel re-import',
    coalesce((select jsonb_agg(to_jsonb(receipt) order by receipt.purchased_on, receipt.receipt_code, receipt.id) from public.inventory_receipts as receipt), '[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(history) order by history.created_at, history.id) from public.inventory_history as history), '[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(session) order by session.activated_at, session.id) from public.inventory_active_sessions as session), '[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(daily_sequence) order by daily_sequence.purchased_on) from public.inventory_receipt_daily_sequences as daily_sequence), '[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(ingredient) order by ingredient.id) from public.ingredient_master as ingredient where ingredient.source_inventory_receipt_id is not null), '[]'::jsonb)
  );

  delete from public.inventory_active_sessions;
  delete from public.inventory_history;
  delete from public.inventory_receipts;
  delete from public.inventory_receipt_daily_sequences;

  select count(*) into receipts_after from public.inventory_receipts;
  select count(*) into history_after from public.inventory_history;
  select count(*) into sessions_after from public.inventory_active_sessions;
  select count(*) into sequences_after from public.inventory_receipt_daily_sequences;

  if receipts_after <> 0 or history_after <> 0 or sessions_after <> 0 or sequences_after <> 0 then
    raise exception 'Full Kho NVL reset incomplete: receipts %, history %, sessions %, sequences %',
      receipts_after, history_after, sessions_after, sequences_after;
  end if;

  raise notice 'Full Kho NVL reset complete: % receipts, % history rows, % sessions (active %, used %, wasted %), % sequences archived and removed',
    receipts_before, history_before, sessions_before, active_before, used_before, wasted_before, sequences_before;
end $$;

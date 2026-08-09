-- Irreversibly clear Production Kho NVL receipts purchased from June through
-- August 2026 at the owner's request. A private snapshot is retained for an
-- emergency database-level restore; it is not exposed through the app API.

create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create table if not exists private.inventory_reset_backups (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end_exclusive date not null,
  reason text not null,
  receipts jsonb not null,
  history_rows jsonb not null,
  active_sessions jsonb not null,
  daily_sequences jsonb not null,
  ingredient_master_links jsonb not null,
  created_at timestamptz not null default now(),
  check (period_end_exclusive > period_start)
);

revoke all on table private.inventory_reset_backups from public;
revoke all on table private.inventory_reset_backups from anon, authenticated;

do $$
declare
  period_start constant date := date '2026-06-01';
  period_end_exclusive constant date := date '2026-09-01';
  receipts_before integer;
  history_before integer;
  sessions_before integer;
  active_before integer;
  used_before integer;
  wasted_before integer;
  sequences_before integer;
  deleted_receipts integer;
  deleted_sequences integer;
  remaining_receipts integer;
  remaining_sessions integer;
begin
  select count(*) into receipts_before
  from public.inventory_receipts
  where purchased_on >= period_start
    and purchased_on < period_end_exclusive;

  select count(*) into history_before
  from public.inventory_history as history
  join public.inventory_receipts as receipt
    on receipt.id = history.inventory_receipt_id
  where receipt.purchased_on >= period_start
    and receipt.purchased_on < period_end_exclusive;

  select count(*) into sessions_before
  from public.inventory_active_sessions as session
  join public.inventory_receipts as receipt
    on receipt.id = session.source_receipt_id
  where receipt.purchased_on >= period_start
    and receipt.purchased_on < period_end_exclusive;

  select
    count(*) filter (where session.status = 'active'),
    count(*) filter (where session.status = 'used'),
    count(*) filter (where session.status = 'wasted')
  into active_before, used_before, wasted_before
  from public.inventory_active_sessions as session
  join public.inventory_receipts as receipt
    on receipt.id = session.source_receipt_id
  where receipt.purchased_on >= period_start
    and receipt.purchased_on < period_end_exclusive;

  select count(*) into sequences_before
  from public.inventory_receipt_daily_sequences
  where purchased_on >= period_start
    and purchased_on < period_end_exclusive;

  insert into private.inventory_reset_backups (
    period_start,
    period_end_exclusive,
    reason,
    receipts,
    history_rows,
    active_sessions,
    daily_sequences,
    ingredient_master_links
  )
  values (
    period_start,
    period_end_exclusive,
    'Owner-requested Kho NVL reset before clean Excel re-import',
    coalesce((
      select jsonb_agg(to_jsonb(receipt) order by receipt.purchased_on, receipt.receipt_code, receipt.id)
      from public.inventory_receipts as receipt
      where receipt.purchased_on >= period_start
        and receipt.purchased_on < period_end_exclusive
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(history) order by history.created_at, history.id)
      from public.inventory_history as history
      join public.inventory_receipts as receipt
        on receipt.id = history.inventory_receipt_id
      where receipt.purchased_on >= period_start
        and receipt.purchased_on < period_end_exclusive
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(session) order by session.activated_at, session.id)
      from public.inventory_active_sessions as session
      join public.inventory_receipts as receipt
        on receipt.id = session.source_receipt_id
      where receipt.purchased_on >= period_start
        and receipt.purchased_on < period_end_exclusive
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(daily_sequence) order by daily_sequence.purchased_on)
      from public.inventory_receipt_daily_sequences as daily_sequence
      where daily_sequence.purchased_on >= period_start
        and daily_sequence.purchased_on < period_end_exclusive
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(ingredient) order by ingredient.id)
      from public.ingredient_master as ingredient
      join public.inventory_receipts as receipt
        on receipt.id = ingredient.source_inventory_receipt_id
      where receipt.purchased_on >= period_start
        and receipt.purchased_on < period_end_exclusive
    ), '[]'::jsonb)
  );

  -- Receipt deletion cascades to history and every lifecycle status. The
  -- ingredient master FK intentionally becomes null and is linked again by a
  -- subsequent clean inventory import/sync.
  delete from public.inventory_receipts
  where purchased_on >= period_start
    and purchased_on < period_end_exclusive;
  get diagnostics deleted_receipts = row_count;

  delete from public.inventory_receipt_daily_sequences
  where purchased_on >= period_start
    and purchased_on < period_end_exclusive;
  get diagnostics deleted_sequences = row_count;

  select count(*) into remaining_receipts
  from public.inventory_receipts
  where purchased_on >= period_start
    and purchased_on < period_end_exclusive;

  select count(*) into remaining_sessions
  from public.inventory_active_sessions as session
  join public.inventory_receipts as receipt
    on receipt.id = session.source_receipt_id
  where receipt.purchased_on >= period_start
    and receipt.purchased_on < period_end_exclusive;

  if deleted_receipts <> receipts_before then
    raise exception 'Kho NVL reset deleted % of % targeted receipts', deleted_receipts, receipts_before;
  end if;

  if deleted_sequences <> sequences_before then
    raise exception 'Kho NVL reset deleted % of % targeted daily sequences', deleted_sequences, sequences_before;
  end if;

  if remaining_receipts <> 0 or remaining_sessions <> 0 then
    raise exception 'Kho NVL reset incomplete: % receipts and % sessions remain', remaining_receipts, remaining_sessions;
  end if;

  raise notice 'Kho NVL reset complete: % receipts, % history rows, % lifecycle sessions (active %, used %, wasted %), % daily sequences archived and removed',
    receipts_before, history_before, sessions_before, active_before, used_before, wasted_before, sequences_before;
end $$;

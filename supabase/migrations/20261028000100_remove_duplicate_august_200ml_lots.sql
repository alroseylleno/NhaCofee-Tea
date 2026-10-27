-- Owner-requested removal of two August lots that duplicate July receipts:
--   010826-018  Ly 200ml   1 thùng × 1.000 cái  (July: 010726-010, 20 cây × 50)
--   010826-019  nắp 200ml  1 thùng × 1.000 cái  (July: 010726-014, 20 cây × 50)
-- The same goods were entered once in July and again on 02/08, and each August
-- lot was then "opened" once on 11/08, so August carries a phantom purchase and
-- a phantom COGS of 200.000đ + 150.000đ (prices as corrected on 2026-10-28).
--
-- Removed, in FK-safe order: the one used session of each lot (that is where
-- the August COGS lives), the lot's history rows, the two lots. Used sessions
-- cannot be deleted through RLS on purpose, which is why this is a migration.
--
-- Guards: matched by exact receipt code; aborts unless both lots exist with the
-- expected name and a 1-thùng × 1.000-cái shape, carry exactly one session each
-- and it is closed as used, and nothing depends on them (no transfer child, no
-- settlement return lot, no Product Master link). Every deleted row is
-- snapshotted into private first.

create schema if not exists private;

create table if not exists private.duplicate_lot_removal_backups (
  migration_key text primary key,
  captured_at timestamptz not null default now(),
  receipt_rows jsonb not null,
  history_rows jsonb not null,
  active_session_rows jsonb not null
);

revoke all on table private.duplicate_lot_removal_backups from public;
revoke all on table private.duplicate_lot_removal_backups from anon, authenticated;

do $$
declare
  target_count integer;
  shape_count integer;
  session_count integer;
  used_session_count integer;
  child_count integer;
  return_lot_count integer;
  ingredient_link_count integer;
  deleted_sessions integer;
  deleted_receipts integer;
begin
  create temporary table duplicate_targets on commit drop as
  select receipt.id, receipt.receipt_code, receipt.name, receipt.unit, receipt.total_quantity, receipt.conversion_amount
  from public.inventory_receipts as receipt
  where receipt.receipt_code in ('010826-018', '010826-019');

  select count(*) into target_count from duplicate_targets;
  if target_count <> 2 then
    raise exception 'Expected lots 010826-018 and 010826-019, found % of them', target_count;
  end if;

  -- ASCII-only name checks: stored names mix NFC and NFD.
  select count(*) into shape_count
  from duplicate_targets
  where total_quantity = 1 and conversion_amount = 1000
    and ((receipt_code = '010826-018' and lower(name) like 'ly 200ml%')
      or (receipt_code = '010826-019' and lower(name) like '%200ml%' and lower(name) not like 'ly%'));
  if shape_count <> 2 then
    raise exception 'Lots 010826-018/019 no longer look like 1 thùng × 1.000 cái Ly/nắp 200ml (% match)', shape_count;
  end if;

  select count(*), count(*) filter (where session.status = 'used')
  into session_count, used_session_count
  from public.inventory_active_sessions as session
  where session.source_receipt_id in (select id from duplicate_targets);
  if session_count <> 2 or used_session_count <> 2 then
    raise exception 'Expected one used session per lot, found % sessions (% used)', session_count, used_session_count;
  end if;

  select count(*) into child_count
  from public.inventory_receipts
  where transferred_from_id in (select id from duplicate_targets);
  select count(*) into return_lot_count
  from public.inventory_receipts
  where source_session_id in (
    select id from public.inventory_active_sessions where source_receipt_id in (select id from duplicate_targets)
  );
  select count(*) into ingredient_link_count
  from public.ingredient_master
  where source_inventory_receipt_id in (select id from duplicate_targets);
  if child_count > 0 or return_lot_count > 0 or ingredient_link_count > 0 then
    raise exception 'Lots 010826-018/019 have dependents: % transfer children, % return lots, % Product Master links',
      child_count, return_lot_count, ingredient_link_count;
  end if;

  insert into private.duplicate_lot_removal_backups (migration_key, receipt_rows, history_rows, active_session_rows)
  values (
    '20261028000100_remove_duplicate_august_200ml_lots',
    (select jsonb_agg(to_jsonb(receipt)) from public.inventory_receipts as receipt where receipt.id in (select id from duplicate_targets)),
    coalesce((select jsonb_agg(to_jsonb(history)) from public.inventory_history as history where history.inventory_receipt_id in (select id from duplicate_targets)), '[]'::jsonb),
    (select jsonb_agg(to_jsonb(session)) from public.inventory_active_sessions as session where session.source_receipt_id in (select id from duplicate_targets))
  )
  on conflict (migration_key) do nothing;

  delete from public.inventory_active_sessions
  where source_receipt_id in (select id from duplicate_targets);
  get diagnostics deleted_sessions = row_count;

  -- inventory_history rows go with the receipts (on delete cascade).
  delete from public.inventory_receipts
  where id in (select id from duplicate_targets);
  get diagnostics deleted_receipts = row_count;

  if deleted_sessions <> 2 or deleted_receipts <> 2 then
    raise exception 'Removal touched % sessions and % lots, expected 2 and 2', deleted_sessions, deleted_receipts;
  end if;
end;
$$;

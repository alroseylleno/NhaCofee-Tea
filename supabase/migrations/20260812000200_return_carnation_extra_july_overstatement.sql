-- Return the 9 CARNATION EXTRA cream boxes mistakenly recognized as July 2026
-- inventory cost. Lifecycle rows consume sealed units, so deleting only the
-- exact overstated sessions removes the cost and raises sealed stock 32 -> 41.

do $$
declare
  target_receipt_count integer;
  target_session_count integer;
  settled_session_count integer;
  sealed_before numeric;
  sealed_after numeric;
  deleted_sessions integer;
begin
  create temporary table carnation_extra_receipts on commit drop as
  select receipt.id
  from public.inventory_receipts as receipt
  where lower(receipt.name || ' ' || receipt.brand) like '%carnation extra%'
    and (
      lower(receipt.name || ' ' || receipt.brand) like '%kem béo%'
      or lower(receipt.name || ' ' || receipt.brand) like '%kem beo%'
    );

  select count(*) into target_receipt_count
  from carnation_extra_receipts;

  if target_receipt_count = 0 then
    raise exception 'CARNATION EXTRA correction found no matching Kem béo receipt';
  end if;

  select
    coalesce((
      select sum(receipt.total_quantity)
      from public.inventory_receipts as receipt
      where receipt.id in (select id from carnation_extra_receipts)
    ), 0)
    - coalesce((
      select count(*)
      from public.inventory_active_sessions as session
      where session.source_receipt_id in (select id from carnation_extra_receipts)
    ), 0)
  into sealed_before;

  if sealed_before <> 32 then
    raise exception 'CARNATION EXTRA safeguard expected 32 sealed boxes before correction, found %', sealed_before;
  end if;

  create temporary table carnation_extra_july_sessions on commit drop as
  select session.id, session.source_receipt_id
  from public.inventory_active_sessions as session
  where session.source_receipt_id in (select id from carnation_extra_receipts)
    and session.cost_recognition_month = date '2026-07-01';

  select count(*) into target_session_count
  from carnation_extra_july_sessions;

  if target_session_count <> 9 then
    raise exception 'CARNATION EXTRA safeguard expected exactly 9 July 2026 sessions, found %', target_session_count;
  end if;

  select count(*) into settled_session_count
  from public.inventory_active_sessions as session
  where session.id in (select id from carnation_extra_july_sessions)
    and (
      session.settlement is not null
      or exists (
        select 1
        from public.inventory_receipts as returned_receipt
        where returned_receipt.source_session_id = session.id
      )
    );

  if settled_session_count <> 0 then
    raise exception 'CARNATION EXTRA correction refuses to delete % settled session(s)', settled_session_count;
  end if;

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
    date '2026-07-01',
    date '2026-08-01',
    'Owner-requested correction: return 9 excess CARNATION EXTRA cream boxes from July cost to sealed inventory (32 -> 41)',
    coalesce((
      select jsonb_agg(to_jsonb(receipt) order by receipt.purchased_on, receipt.receipt_code, receipt.id)
      from public.inventory_receipts as receipt
      where receipt.id in (select id from carnation_extra_receipts)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(history) order by history.created_at, history.id)
      from public.inventory_history as history
      where history.inventory_receipt_id in (select id from carnation_extra_receipts)
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(to_jsonb(session) order by session.activated_at, session.id)
      from public.inventory_active_sessions as session
      where session.id in (select id from carnation_extra_july_sessions)
    ), '[]'::jsonb),
    '[]'::jsonb,
    coalesce((
      select jsonb_agg(to_jsonb(ingredient) order by ingredient.id)
      from public.ingredient_master as ingredient
      where ingredient.source_inventory_receipt_id in (select id from carnation_extra_receipts)
    ), '[]'::jsonb)
  );

  delete from public.inventory_active_sessions as session
  where session.id in (select id from carnation_extra_july_sessions);
  get diagnostics deleted_sessions = row_count;

  if deleted_sessions <> 9 then
    raise exception 'CARNATION EXTRA correction deleted % of 9 expected sessions', deleted_sessions;
  end if;

  select
    coalesce((
      select sum(receipt.total_quantity)
      from public.inventory_receipts as receipt
      where receipt.id in (select id from carnation_extra_receipts)
    ), 0)
    - coalesce((
      select count(*)
      from public.inventory_active_sessions as session
      where session.source_receipt_id in (select id from carnation_extra_receipts)
    ), 0)
  into sealed_after;

  if sealed_after <> 41 then
    raise exception 'CARNATION EXTRA safeguard expected 41 sealed boxes after correction, found %', sealed_after;
  end if;

  raise notice 'CARNATION EXTRA correction complete: deleted % July sessions; sealed stock % -> %',
    deleted_sessions, sealed_before, sealed_after;
end $$;

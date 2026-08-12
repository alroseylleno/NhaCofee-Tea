-- Return the 9 CARNATION EXTRA cream boxes overstated in July 2026 inventory
-- cost for receipt 010726-027. This 48-box lot has 16 lifecycle rows in total,
-- including 13 recognized in July. Keep the first 4 legitimate July issues
-- and remove the latest 9 excess July rows, raising sealed stock 32 -> 41.

do $$
declare
  target_receipt_count integer;
  july_session_count integer;
  matching_active_count integer;
  august_active_count integer;
  settled_session_count integer;
  sealed_before numeric;
  sealed_after numeric;
  deleted_sessions integer;
begin
  create temporary table carnation_extra_receipts on commit drop as
  select receipt.id
  from public.inventory_receipts as receipt
  where receipt.receipt_code = '010726-027'
    and receipt.total_quantity = 48
    and lower(receipt.name || ' ' || receipt.brand) like '%carnation extra%'
    and (
      lower(receipt.name || ' ' || receipt.brand) like '%kem béo%'
      or lower(receipt.name || ' ' || receipt.brand) like '%kem beo%'
    );

  select count(*) into target_receipt_count
  from carnation_extra_receipts;

  if target_receipt_count <> 1 then
    raise exception 'CARNATION EXTRA correction expected exactly one 48-box receipt 010726-027, found %', target_receipt_count;
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

  select count(*) into july_session_count
  from public.inventory_active_sessions as session
  where session.source_receipt_id in (select id from carnation_extra_receipts)
    and session.cost_recognition_month = date '2026-07-01';

  if july_session_count <> 13 then
    raise exception 'CARNATION EXTRA safeguard expected 13 July 2026 sessions before removing the 9 excess rows, found %', july_session_count;
  end if;

  select
    count(*) filter (where session.status = 'active'),
    count(*) filter (
      where session.status = 'active'
        and session.cost_recognition_month = date '2026-08-01'
    )
  into matching_active_count, august_active_count
  from public.inventory_active_sessions as session
  where session.source_receipt_id in (select id from carnation_extra_receipts);

  if matching_active_count <> 1 or august_active_count <> 1 then
    raise exception 'CARNATION EXTRA safeguard expected exactly one active August 2026 box to preserve, found % active / % active in August',
      matching_active_count, august_active_count;
  end if;

  create temporary table carnation_extra_excess_sessions on commit drop as
  select session.id, session.source_receipt_id
  from public.inventory_active_sessions as session
  where session.source_receipt_id in (select id from carnation_extra_receipts)
    and session.cost_recognition_month = date '2026-07-01'
    and session.status <> 'active'
  order by session.activated_at desc, session.created_at desc, session.id desc
  limit 9;

  if (select count(*) from carnation_extra_excess_sessions) <> 9 then
    raise exception 'CARNATION EXTRA safeguard could not isolate 9 closed July 2026 excess sessions';
  end if;

  select count(*) into settled_session_count
  from public.inventory_active_sessions as session
  where session.id in (select id from carnation_extra_excess_sessions)
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
      where session.id in (select id from carnation_extra_excess_sessions)
    ), '[]'::jsonb),
    '[]'::jsonb,
    coalesce((
      select jsonb_agg(to_jsonb(ingredient) order by ingredient.id)
      from public.ingredient_master as ingredient
      where ingredient.source_inventory_receipt_id in (select id from carnation_extra_receipts)
    ), '[]'::jsonb)
  );

  delete from public.inventory_active_sessions as session
  where session.id in (select id from carnation_extra_excess_sessions);
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

  if (
    select count(*)
    from public.inventory_active_sessions as session
    where session.source_receipt_id in (select id from carnation_extra_receipts)
  ) <> 7 then
    raise exception 'CARNATION EXTRA safeguard expected 7 lifecycle rows after correction';
  end if;

  if (
    select count(*)
    from public.inventory_active_sessions as session
    where session.source_receipt_id in (select id from carnation_extra_receipts)
      and session.cost_recognition_month = date '2026-07-01'
  ) <> 4 then
    raise exception 'CARNATION EXTRA safeguard expected 4 legitimate July 2026 sessions after correction';
  end if;

  if (
    select count(*)
    from public.inventory_active_sessions as session
    where session.source_receipt_id in (select id from carnation_extra_receipts)
      and session.status = 'active'
      and session.cost_recognition_month = date '2026-08-01'
  ) <> 1 then
    raise exception 'CARNATION EXTRA safeguard failed to preserve the one active August 2026 box';
  end if;

  raise notice 'CARNATION EXTRA correction complete: kept 4 legitimate July sessions, deleted % excess July sessions, preserved 1 active August box; sealed stock % -> %',
    deleted_sessions, sealed_before, sealed_after;
end $$;

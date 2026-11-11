-- Owner-requested reclassification (Long, 12/11/2026): three costs entered as
-- assets (nhóm Đầu tư, depreciated) are period costs and belong to the month
-- they were paid, as in the monthly P&L Long keeps:
--   * "Chạy quảng cáo FB" 1.000.000 (01/08/2026, KH 1 tháng)   → Bán hàng / Quảng cáo Facebook
--   * "Chạy quảng cáo FB" 2.400.000 (15/09/2026, KH 3 tháng)   → Bán hàng / Quảng cáo Facebook
--   * "Thuế" 2.000.000 (21/09/2026, ghi ở Thuê mặt bằng, KH 24) → Cố định / Thuế & lệ phí
-- and the rent deposit "Cọc 1 tháng tiền thuê nhà" 9.000.000 (09/06/2026) stops
-- depreciating: a deposit comes back at the end of the lease, so it is not a
-- cost (it was taking 750.000đ a month off the P&L). It stays an asset in
-- nhóm Đầu tư at its full value; with no useful life the app depreciates 0.
-- Each update is guarded on the exact current row (id, name, amount, date,
-- category), so a row edited by hand since 11/11 is left alone and the
-- migration is a no-op on any database that does not hold these rows (UAT,
-- a fresh project). Asset-only fields are cleared because a period cost has no
-- useful life. Data only: no schema change.

update public.finance_expenses
set category = 'sales', subcategory = 'Quảng cáo Facebook',
    useful_life_months = null, salvage_value = null, in_service_on = null, updated_at = now()
where id in ('ccb49193-5664-468f-9751-31b7c297ce0f', 'dcde88d0-5d1b-42ac-89db-8b94f455251e')
  and category = 'investment'
  and name = 'Chạy quảng cáo FB'
  and ((id = 'ccb49193-5664-468f-9751-31b7c297ce0f' and amount = 1000000 and incurred_on = '2026-08-01')
    or (id = 'dcde88d0-5d1b-42ac-89db-8b94f455251e' and amount = 2400000 and incurred_on = '2026-09-15'));

update public.finance_expenses
set category = 'fixed', subcategory = 'Thuế & lệ phí',
    useful_life_months = null, salvage_value = null, in_service_on = null, updated_at = now()
where id = '799ae0ab-bba7-4b1b-9273-0f1971614a36'
  and category = 'investment'
  and name = 'Thuế'
  and amount = 2000000
  and incurred_on = '2026-09-21';

update public.finance_expenses
set useful_life_months = null, updated_at = now()
where id = '38fb1885-228c-4dfa-a34a-aefd538dc553'
  and category = 'investment'
  and name = 'Cọc 1 tháng tiền thuê nhà'
  and amount = 9000000
  and incurred_on = '2026-06-09'
  and useful_life_months = 12;

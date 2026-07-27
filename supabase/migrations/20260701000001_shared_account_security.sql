-- Run this after 001_inventory.sql. It permits only signed-in staff to access shop data.
alter table public.inventory_receipts add column if not exists receipt_name text;

drop policy if exists "shared staff can manage inventory" on public.inventory_receipts;
create policy "shared staff can manage inventory"
on public.inventory_receipts for all to authenticated using (true) with check (true);

drop policy if exists "shared staff can manage inventory history" on public.inventory_history;
create policy "shared staff can manage inventory history"
on public.inventory_history for all to authenticated using (true) with check (true);

drop policy if exists "shared staff can manage bills" on storage.objects;
create policy "shared staff can manage bills"
on storage.objects for all to authenticated
using (bucket_id = 'bills') with check (bucket_id = 'bills');

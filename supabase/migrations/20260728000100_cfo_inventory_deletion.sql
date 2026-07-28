-- Only the CFO may delete an inventory receipt. Its audit history and all
-- lifecycle rows cascade with the source receipt so derived reports refresh cleanly.

alter table public.inventory_active_sessions
  drop constraint if exists inventory_active_sessions_source_receipt_id_fkey;

alter table public.inventory_active_sessions
  add constraint inventory_active_sessions_source_receipt_id_fkey
  foreign key (source_receipt_id)
  references public.inventory_receipts(id)
  on delete cascade;

drop policy if exists "shared staff can manage inventory" on public.inventory_receipts;

drop policy if exists "authenticated staff can read inventory" on public.inventory_receipts;
create policy "authenticated staff can read inventory"
on public.inventory_receipts for select to authenticated
using (true);

drop policy if exists "authenticated staff can add inventory" on public.inventory_receipts;
create policy "authenticated staff can add inventory"
on public.inventory_receipts for insert to authenticated
with check (true);

drop policy if exists "authenticated staff can update inventory" on public.inventory_receipts;
create policy "authenticated staff can update inventory"
on public.inventory_receipts for update to authenticated
using (true) with check (true);

drop policy if exists "cfo can delete inventory" on public.inventory_receipts;
create policy "cfo can delete inventory"
on public.inventory_receipts for delete to authenticated
using (
  lower(coalesce(auth.jwt() ->> 'email', '')) = 'cfo@nhacoffeentea.com'
  and not exists (
    select 1
    from public.inventory_active_sessions
    where source_receipt_id = inventory_receipts.id
  )
);

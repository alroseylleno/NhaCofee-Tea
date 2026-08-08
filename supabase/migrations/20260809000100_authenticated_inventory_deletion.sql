-- All authenticated staff can delete a receipt that has never been issued,
-- and can return only an active issued unit back to sealed inventory.

drop policy if exists "cfo can delete inventory" on public.inventory_receipts;
drop policy if exists "authenticated staff can delete inventory" on public.inventory_receipts;
create policy "authenticated staff can delete inventory"
on public.inventory_receipts for delete to authenticated
using (
  not exists (
    select 1
    from public.inventory_active_sessions
    where source_receipt_id = inventory_receipts.id
  )
);

drop policy if exists "cfo can return active inventory to stock" on public.inventory_active_sessions;
drop policy if exists "authenticated staff can return active inventory to stock" on public.inventory_active_sessions;
create policy "authenticated staff can return active inventory to stock"
on public.inventory_active_sessions for delete to authenticated
using (status = 'active');

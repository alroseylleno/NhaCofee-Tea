-- Only the CFO may reverse an active inventory issue back into sealed stock.
-- Other staff keep their existing read, open, use-up and waste workflows.

drop policy if exists "shared staff can manage active inventory" on public.inventory_active_sessions;

create policy "authenticated staff can read active inventory"
on public.inventory_active_sessions for select to authenticated
using (true);

create policy "authenticated staff can add active inventory"
on public.inventory_active_sessions for insert to authenticated
with check (true);

create policy "authenticated staff can update active inventory"
on public.inventory_active_sessions for update to authenticated
using (true) with check (true);

create policy "cfo can return active inventory to stock"
on public.inventory_active_sessions for delete to authenticated
using (
  lower(coalesce(auth.jwt() ->> 'email', '')) = 'cfo@nhacoffeentea.com'
  and status = 'active'
);

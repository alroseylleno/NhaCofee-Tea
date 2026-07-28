-- One-time production cleanup requested before the operational launch.
-- Receipt deletion cascades to inventory history and all lifecycle rows.
-- Storage objects are cleared separately through the Storage API/UI because
-- direct SQL deletion of managed storage metadata can fail in migrations.

delete from public.inventory_receipts;

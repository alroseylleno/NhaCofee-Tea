-- Irreversibly reset Production Kho NVL data at the owner's request.
-- Finance imports and Product Master data are intentionally out of scope.

delete from public.inventory_active_sessions;
delete from public.inventory_history;
delete from public.inventory_receipts;
delete from public.inventory_receipt_daily_sequences;

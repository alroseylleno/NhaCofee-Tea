-- One-time production cleanup requested before the operational launch.
-- Receipt deletion cascades to inventory history and all lifecycle rows.

delete from storage.objects where bucket_id = 'bills';
delete from public.inventory_receipts;

-- The full inventory reset intentionally preserved recipe history.  Its receipt
-- FK nullification leaves obsolete ingredient-master rows, which must not be
-- selectable as live Kho NVL data.  The client sync reactivates rows matching
-- newly imported receipts and refreshes their source link on the next load.
update public.ingredient_master
set
  status = 'inactive',
  stock_quantity_base = 0,
  stock_lot_count = 0,
  oldest_in_stock_purchased_on = null,
  updated_at = now()
where source_inventory_receipt_id is null
  and status <> 'inactive';

notify pgrst, 'reload schema';

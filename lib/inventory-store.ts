import { supabase } from "@/lib/supabase";

export type CloudReceipt = { name: string; dataUrl?: string; path?: string };
export type CloudHistory = { id: string; at: string; action: "created" | "updated"; changes: unknown[] };
export type CloudItem = { id: string; name: string; category: string; brand: string; unit: string; quantity: number; specification: string; unitCost: number; purchasedOn: string; supplier: string; receipt?: CloudReceipt; history: CloudHistory[] };

function requireClient() { if (!supabase) throw new Error("Supabase chưa được cấu hình."); return supabase; }

export async function loadInventory(): Promise<CloudItem[]> {
  const client = requireClient();
  const { data: rows, error } = await client.from("inventory_receipts").select("*").order("purchased_on", { ascending: false });
  if (error) throw error;
  const ids = rows.map((row) => row.id);
  const { data: historyRows, error: historyError } = ids.length ? await client.from("inventory_history").select("*").in("inventory_receipt_id", ids).order("created_at", { ascending: false }) : { data: [], error: null };
  if (historyError) throw historyError;
  const histories = new Map<string, CloudHistory[]>();
  for (const row of historyRows || []) histories.set(row.inventory_receipt_id, [...(histories.get(row.inventory_receipt_id) || []), { id: row.id, at: row.created_at, action: row.action, changes: row.changes || [] }]);
  return Promise.all(rows.map(async (row) => {
    const receipt = row.receipt_path ? await client.storage.from("bills").createSignedUrl(row.receipt_path, 3600) : { data: null };
    return { id: row.id, name: row.name, category: row.category, brand: row.brand, unit: row.unit, quantity: Number(row.total_quantity), specification: row.specification, unitCost: Number(row.unit_cost), purchasedOn: row.purchased_on, supplier: row.supplier, receipt: row.receipt_path ? { name: row.receipt_name || "Hóa đơn", path: row.receipt_path, dataUrl: receipt.data?.signedUrl } : undefined, history: histories.get(row.id) || [] };
  }));
}

export async function saveInventory(item: CloudItem, event: CloudHistory, file?: File) {
  const client = requireClient(); let receipt = item.receipt;
  if (file) { const path = `shared/${item.id}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`; const { error } = await client.storage.from("bills").upload(path, file, { upsert: false }); if (error) throw error; receipt = { name: file.name, path }; }
  const { error } = await client.from("inventory_receipts").upsert({ id: item.id, name: item.name, category: item.category, brand: item.brand, total_quantity: item.quantity, unit: item.unit, specification: item.specification, unit_cost: item.unitCost, purchased_on: item.purchasedOn, supplier: item.supplier, receipt_path: receipt?.path || null, receipt_name: receipt?.name || null });
  if (error) throw error;
  const { error: historyError } = await client.from("inventory_history").insert({ id: event.id, inventory_receipt_id: item.id, action: event.action, changes: event.changes, created_at: event.at });
  if (historyError) throw historyError;
}

export async function removeInventory(id: string) { const { error } = await requireClient().from("inventory_receipts").delete().eq("id", id); if (error) throw error; }

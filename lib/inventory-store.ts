import { supabase } from "@/lib/supabase";

export type CloudReceipt = { name: string; dataUrl?: string; path?: string };
export type CloudHistory = { id: string; at: string; action: "created" | "updated"; changes: unknown[] };
export type CloudItem = { id: string; name: string; category: string; brand: string; unit: string; quantity: number; specification: string; unitCost: number; purchasedOn: string; supplier: string; receipt?: CloudReceipt; history: CloudHistory[] };
export type CloudLotMeta = { expiresOn: string; shelfLifeHours?: number; storageLocation: string };
export type CloudActiveSession = { id: string; sourceReceiptId: string; ingredientKey: string; activatedAt: string; useBy?: string; status: "active" | "used" | "wasted"; closedAt?: string; reason: string; note?: string };
export type CloudInventoryState = { items: CloudItem[]; lotMeta: Record<string, CloudLotMeta>; activeSessions: CloudActiveSession[]; lifecycleReady: boolean };

function requireClient() { if (!supabase) throw new Error("Supabase chưa được cấu hình."); return supabase; }
function lifecycleTableMissing(error: { code?: string; message?: string } | null) { return Boolean(error && (error.code === "42P01" || error.code === "PGRST205" || error.message?.includes("inventory_active_sessions"))); }

export async function loadInventory(): Promise<CloudInventoryState> {
  const client = requireClient();
  const { data: rows, error } = await client.from("inventory_receipts").select("*").order("purchased_on", { ascending: false });
  if (error) throw error;
  const ids = rows.map((row) => row.id);
  const { data: historyRows, error: historyError } = ids.length ? await client.from("inventory_history").select("*").in("inventory_receipt_id", ids).order("created_at", { ascending: false }) : { data: [], error: null };
  if (historyError) throw historyError;
  const { data: activeRows, error: activeError } = await client.from("inventory_active_sessions").select("*").order("activated_at", { ascending: false });
  if (activeError && !lifecycleTableMissing(activeError)) throw activeError;
  const lifecycleReady = !activeError;
  const histories = new Map<string, CloudHistory[]>();
  for (const row of historyRows || []) histories.set(row.inventory_receipt_id, [...(histories.get(row.inventory_receipt_id) || []), { id: row.id, at: row.created_at, action: row.action, changes: row.changes || [] }]);
  const lotMeta: Record<string, CloudLotMeta> = {};
  const items = await Promise.all(rows.map(async (row) => {
    if (lifecycleReady) lotMeta[row.id] = { expiresOn: row.expires_on || "", shelfLifeHours: row.shelf_life_hours ? Number(row.shelf_life_hours) : undefined, storageLocation: row.storage_location || "Chưa ghi" };
    const receipt = row.receipt_path ? await client.storage.from("bills").createSignedUrl(row.receipt_path, 3600) : { data: null };
    return { id: row.id, name: row.name, category: row.category, brand: row.brand, unit: row.unit, quantity: Number(row.total_quantity), specification: row.specification, unitCost: Number(row.unit_cost), purchasedOn: row.purchased_on, supplier: row.supplier, receipt: row.receipt_path ? { name: row.receipt_name || "Hóa đơn", path: row.receipt_path, dataUrl: receipt.data?.signedUrl } : undefined, history: histories.get(row.id) || [] };
  }));
  const activeSessions: CloudActiveSession[] = (activeRows || []).map((row) => ({ id: row.id, sourceReceiptId: row.source_receipt_id, ingredientKey: row.ingredient_key, activatedAt: row.activated_at, useBy: row.use_by || undefined, status: row.status, closedAt: row.closed_at || undefined, reason: row.reason, note: row.note || undefined }));
  return { items, lotMeta, activeSessions, lifecycleReady };
}

export async function saveInventory(item: CloudItem, event: CloudHistory, file?: File, meta?: CloudLotMeta) {
  const client = requireClient(); let receipt = item.receipt;
  if (file) { const path = `shared/${item.id}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`; const { error } = await client.storage.from("bills").upload(path, file, { upsert: false }); if (error) throw error; receipt = { name: file.name, path }; }
  const row: Record<string, unknown> = { id: item.id, name: item.name, category: item.category, brand: item.brand, total_quantity: item.quantity, unit: item.unit, specification: item.specification, unit_cost: item.unitCost, purchased_on: item.purchasedOn, supplier: item.supplier, receipt_path: receipt?.path || null, receipt_name: receipt?.name || null };
  if (meta) { row.expires_on = meta.expiresOn || null; row.shelf_life_hours = meta.shelfLifeHours || null; row.storage_location = meta.storageLocation; }
  const { error } = await client.from("inventory_receipts").upsert(row);
  if (error) throw error;
  const { error: historyError } = await client.from("inventory_history").insert({ id: event.id, inventory_receipt_id: item.id, action: event.action, changes: event.changes, created_at: event.at });
  if (historyError) throw historyError;
}

export async function createActiveSession(activeSession: CloudActiveSession) {
  const { error } = await requireClient().from("inventory_active_sessions").insert({ id: activeSession.id, source_receipt_id: activeSession.sourceReceiptId, ingredient_key: activeSession.ingredientKey, activated_at: activeSession.activatedAt, use_by: activeSession.useBy || null, status: activeSession.status, closed_at: activeSession.closedAt || null, reason: activeSession.reason, note: activeSession.note || null });
  if (error) throw error;
}

export async function updateActiveSession(activeSession: CloudActiveSession) {
  const { error } = await requireClient().from("inventory_active_sessions").update({ ingredient_key: activeSession.ingredientKey, use_by: activeSession.useBy || null, status: activeSession.status, closed_at: activeSession.closedAt || null, reason: activeSession.reason, note: activeSession.note || null, updated_at: new Date().toISOString() }).eq("id", activeSession.id);
  if (error) throw error;
}

export async function migrateLocalLifecycle(lotMeta: Record<string, CloudLotMeta>, activeSessions: CloudActiveSession[]) {
  const client = requireClient();
  for (const [id, meta] of Object.entries(lotMeta)) {
    const { error } = await client.from("inventory_receipts").update({ expires_on: meta.expiresOn || null, shelf_life_hours: meta.shelfLifeHours || null, storage_location: meta.storageLocation }).eq("id", id);
    if (error) throw error;
  }
  if (activeSessions.length) {
    const { error } = await client.from("inventory_active_sessions").upsert(activeSessions.map((activeSession) => ({ id: activeSession.id, source_receipt_id: activeSession.sourceReceiptId, ingredient_key: activeSession.ingredientKey, activated_at: activeSession.activatedAt, use_by: activeSession.useBy || null, status: activeSession.status, closed_at: activeSession.closedAt || null, reason: activeSession.reason, note: activeSession.note || null })));
    if (error) throw error;
  }
}

export async function removeInventory(id: string) { const { error } = await requireClient().from("inventory_receipts").delete().eq("id", id); if (error) throw error; }

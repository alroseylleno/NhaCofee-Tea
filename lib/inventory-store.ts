import { supabase } from "@/lib/supabase";

export type CloudReceipt = { name: string; dataUrl?: string; path?: string };
export type CloudHistory = { id: string; at: string; action: "created" | "updated"; changes: unknown[] };
export type CloudPeriodSettlement = { mode: "week" | "month"; periodEnd: string; openingAmount: number; remainingAmount: number; usedAmount: number; unit: string; returnedLotId?: string; disposition?: "return" | "carry"; continuedSessionId?: string };
export type CloudItem = { id: string; name: string; category: string; brand: string; unit: string; quantity: number; specification: string; conversion?: { amount: number; unit: string }; unitCost: number; purchasedOn: string; supplier: string; receiptCode?: string; receipt?: CloudReceipt; history: CloudHistory[]; stockState?: "sealed" | "opened"; returnedOn?: string; sourceSessionId?: string; firstOpenedAt?: string };
export type CloudLotMeta = { expiresOn: string; shelfLifeHours?: number; storageLocation: string };
export type CloudActiveSession = { id: string; sourceReceiptId: string; ingredientKey: string; activatedAt: string; costRecognitionMonth?: string; useBy?: string; status: "active" | "used" | "wasted"; closedAt?: string; reason: string; note?: string; openedAmount?: number; openedUnit?: string; provisionalCost?: number; recognizedCost?: number; settlement?: CloudPeriodSettlement };
export type CloudInventoryState = { items: CloudItem[]; lotMeta: Record<string, CloudLotMeta>; activeSessions: CloudActiveSession[]; lifecycleReady: boolean };
export type CloudInventoryImport = { item: CloudItem; event: CloudHistory; meta?: CloudLotMeta };

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
    return { id: row.id, name: row.name, category: row.category, brand: row.brand, unit: row.unit, quantity: Number(row.total_quantity), specification: row.specification, conversion: row.conversion_amount ? { amount: Number(row.conversion_amount), unit: row.conversion_unit || "ml" } : undefined, unitCost: Number(row.unit_cost), purchasedOn: row.purchased_on, supplier: row.supplier, receiptCode: row.receipt_code || undefined, receipt: row.receipt_path ? { name: row.receipt_name || "Hóa đơn", path: row.receipt_path, dataUrl: receipt.data?.signedUrl } : undefined, history: histories.get(row.id) || [], stockState: row.stock_state === "opened" ? "opened" as const : "sealed" as const, returnedOn: row.returned_on || undefined, sourceSessionId: row.source_session_id || undefined, firstOpenedAt: row.first_opened_at || undefined };
  }));
  const activeSessions: CloudActiveSession[] = (activeRows || []).map((row) => ({ id: row.id, sourceReceiptId: row.source_receipt_id, ingredientKey: row.ingredient_key, activatedAt: row.activated_at, costRecognitionMonth: row.cost_recognition_month ? String(row.cost_recognition_month).slice(0, 7) : undefined, useBy: row.use_by || undefined, status: row.status, closedAt: row.closed_at || undefined, reason: row.reason, note: row.note || undefined, openedAmount: row.opened_amount ? Number(row.opened_amount) : undefined, openedUnit: row.opened_unit || undefined, provisionalCost: row.provisional_cost === null || row.provisional_cost === undefined ? undefined : Number(row.provisional_cost), recognizedCost: row.recognized_cost === null || row.recognized_cost === undefined ? undefined : Number(row.recognized_cost), settlement: row.settlement || undefined }));
  return { items, lotMeta, activeSessions, lifecycleReady };
}

export async function saveInventory(item: CloudItem, event: CloudHistory, file?: File, meta?: CloudLotMeta) {
  const client = requireClient(); let receipt = item.receipt;
  if (file) { const path = `shared/${item.id}-${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`; const { error } = await client.storage.from("bills").upload(path, file, { upsert: false }); if (error) throw error; receipt = { name: file.name, path }; }
  const row: Record<string, unknown> = { name: item.name, category: item.category, brand: item.brand, receipt_code: item.receiptCode || null, total_quantity: item.quantity, unit: item.unit, specification: item.specification, conversion_amount: item.conversion?.amount || null, conversion_unit: item.conversion?.unit || null, unit_cost: item.unitCost, purchased_on: item.purchasedOn, supplier: item.supplier, receipt_path: receipt?.path || null, receipt_name: receipt?.name || null, stock_state: item.stockState || "sealed", returned_on: item.returnedOn || null, source_session_id: item.sourceSessionId || null, first_opened_at: item.firstOpenedAt || null };
  if (meta) { row.expires_on = meta.expiresOn || null; row.shelf_life_hours = meta.shelfLifeHours || null; row.storage_location = meta.storageLocation; }
  let result = event.action === "created"
    ? await client.from("inventory_receipts").insert({ id: item.id, ...row })
    : await client.from("inventory_receipts").update(row).eq("id", item.id);
  if (result.error?.code === "PGRST204" && result.error.message.includes("conversion_amount")) {
    if (item.conversion) throw new Error("Chưa thể lưu Quy đổi vì Supabase chưa có cột quy đổi. Hãy chạy migration 20260807000100_inventory_conversions.sql trước khi dùng tính năng này.");
    const { conversion_amount: _conversionAmount, conversion_unit: _conversionUnit, ...legacyRow } = row;
    result = event.action === "created"
      ? await client.from("inventory_receipts").insert({ id: item.id, ...legacyRow })
      : await client.from("inventory_receipts").update(legacyRow).eq("id", item.id);
  }
  // Keep existing environments usable until the receipt-code migration reaches them.
  if (result.error?.code === "PGRST204" && result.error.message.includes("receipt_code")) {
    const { receipt_code: _receiptCode, ...legacyRow } = row;
    result = event.action === "created"
      ? await client.from("inventory_receipts").insert({ id: item.id, ...legacyRow })
      : await client.from("inventory_receipts").update(legacyRow).eq("id", item.id);
  }
  if (result.error) throw result.error;
  const { error: historyError } = await client.from("inventory_history").insert({ id: event.id, inventory_receipt_id: item.id, action: event.action, changes: event.changes, created_at: event.at });
  if (historyError) throw historyError;
}

export async function importInventoryBatch(entries: CloudInventoryImport[]) {
  const client = requireClient();
  const { error } = await client.rpc("import_inventory_receipts", { payload: entries });
  if (error?.code === "PGRST202") throw new Error("Supabase chưa có chức năng nhập kho theo lô. Hãy chạy migration 20260809000500 trước khi nhập file Excel.");
  if (error) throw error;
}

export async function createActiveSession(activeSession: CloudActiveSession) {
  const client = requireClient();
  const row = { id: activeSession.id, source_receipt_id: activeSession.sourceReceiptId, ingredient_key: activeSession.ingredientKey, activated_at: activeSession.activatedAt, cost_recognition_month: activeSession.costRecognitionMonth ? `${activeSession.costRecognitionMonth}-01` : activeSession.activatedAt.slice(0, 7) + "-01", use_by: activeSession.useBy || null, status: activeSession.status, closed_at: activeSession.closedAt || null, reason: activeSession.reason, note: activeSession.note || null, opened_amount: activeSession.openedAmount || null, opened_unit: activeSession.openedUnit || null, provisional_cost: activeSession.provisionalCost ?? null, recognized_cost: activeSession.recognizedCost ?? null, settlement: activeSession.settlement || null };
  let result = await client.from("inventory_active_sessions").insert(row);
  if (result.error?.code === "PGRST204" && result.error.message.includes("cost_recognition_month")) {
    const { cost_recognition_month: _costRecognitionMonth, ...legacyRow } = row;
    result = await client.from("inventory_active_sessions").insert(legacyRow);
  }
  if (result.error) throw result.error;
}

export async function updateActiveSession(activeSession: CloudActiveSession) {
  const client = requireClient();
  const row = { ingredient_key: activeSession.ingredientKey, cost_recognition_month: activeSession.costRecognitionMonth ? `${activeSession.costRecognitionMonth}-01` : activeSession.activatedAt.slice(0, 7) + "-01", use_by: activeSession.useBy || null, status: activeSession.status, closed_at: activeSession.closedAt || null, reason: activeSession.reason, note: activeSession.note || null, opened_amount: activeSession.openedAmount || null, opened_unit: activeSession.openedUnit || null, provisional_cost: activeSession.provisionalCost ?? null, recognized_cost: activeSession.recognizedCost ?? null, settlement: activeSession.settlement || null, updated_at: new Date().toISOString() };
  let result = await client.from("inventory_active_sessions").update(row).eq("id", activeSession.id);
  if (result.error?.code === "PGRST204" && result.error.message.includes("cost_recognition_month")) {
    const { cost_recognition_month: _costRecognitionMonth, ...legacyRow } = row;
    result = await client.from("inventory_active_sessions").update(legacyRow).eq("id", activeSession.id);
  }
  if (result.error) throw result.error;
}

export async function migrateLocalLifecycle(lotMeta: Record<string, CloudLotMeta>, activeSessions: CloudActiveSession[]) {
  const client = requireClient();
  for (const [id, meta] of Object.entries(lotMeta)) {
    const { error } = await client.from("inventory_receipts").update({ expires_on: meta.expiresOn || null, shelf_life_hours: meta.shelfLifeHours || null, storage_location: meta.storageLocation }).eq("id", id);
    if (error) throw error;
  }
  if (activeSessions.length) {
    const rows = activeSessions.map((activeSession) => ({ id: activeSession.id, source_receipt_id: activeSession.sourceReceiptId, ingredient_key: activeSession.ingredientKey, activated_at: activeSession.activatedAt, cost_recognition_month: activeSession.costRecognitionMonth ? `${activeSession.costRecognitionMonth}-01` : activeSession.activatedAt.slice(0, 7) + "-01", use_by: activeSession.useBy || null, status: activeSession.status, closed_at: activeSession.closedAt || null, reason: activeSession.reason, note: activeSession.note || null, opened_amount: activeSession.openedAmount || null, opened_unit: activeSession.openedUnit || null, provisional_cost: activeSession.provisionalCost ?? null, recognized_cost: activeSession.recognizedCost ?? null, settlement: activeSession.settlement || null }));
    let result = await client.from("inventory_active_sessions").upsert(rows);
    if (result.error?.code === "PGRST204" && result.error.message.includes("cost_recognition_month")) {
      result = await client.from("inventory_active_sessions").upsert(rows.map(({ cost_recognition_month: _costRecognitionMonth, ...row }) => row));
    }
    if (result.error) throw result.error;
  }
}

export async function removeInventory(id: string) { const { error } = await requireClient().from("inventory_receipts").delete().eq("id", id); if (error) throw error; }
export async function removeActiveSession(id: string) { const { error } = await requireClient().from("inventory_active_sessions").delete().eq("id", id); if (error) throw error; }

export async function settleInventoryPeriod(input: { sessionId: string; mode: "week" | "month"; periodEnd: string; remainingAmount: number; returnedLotId?: string; historyId?: string }) {
  const { data, error } = await requireClient().rpc("settle_inventory_period", {
    p_session_id: input.sessionId,
    p_mode: input.mode,
    p_period_end: input.periodEnd,
    p_remaining_amount: input.remainingAmount,
    p_returned_lot_id: input.returnedLotId || null,
    p_history_id: input.historyId || null,
  });
  if (error?.code === "PGRST202") throw new Error("Supabase chưa có chức năng Chốt kỳ. Hãy chạy migration 20260809000900 trước.");
  if (error) throw error;
  return data?.[0] as { recognized_cost: number; returned_cost: number; returned_lot_id?: string } | undefined;
}

export async function settleInventoryPeriodWithCarry(input: { sessionId: string; periodEnd: string; remainingAmount: number; returnedLotId: string; continuedSessionId: string; historyId?: string }) {
  const { data, error } = await requireClient().rpc("settle_inventory_period_with_carry", {
    p_session_id: input.sessionId,
    p_period_end: input.periodEnd,
    p_remaining_amount: input.remainingAmount,
    p_returned_lot_id: input.returnedLotId,
    p_continued_session_id: input.continuedSessionId,
    p_history_id: input.historyId || null,
  });
  if (error?.code === "PGRST202") throw new Error("Supabase chưa có chức năng chuyển tiếp kỳ. Hãy chạy migration 20260813000100 trước.");
  if (error) throw error;
  return data?.[0] as { recognized_cost: number; carried_cost: number; returned_lot_id: string; continued_session_id: string; cost_recognition_month: string } | undefined;
}

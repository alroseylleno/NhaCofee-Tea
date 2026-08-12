import { loadFinanceImports, type FinanceProductRecord } from "@/lib/finance-store";
import {
  DEFAULT_STORE,
  type AuditEvent,
  type ImportedProductSource,
  type IngredientMaster,
  type InventorySourceLot,
  type MasterDataState,
  type ProductMaster,
  type RecipeVersion,
  emptyMasterDataState,
  mergeInventoryDrafts,
} from "@/lib/master-data";
import { supabase } from "@/lib/supabase";

type CloudLoad = { state: MasterDataState; products: ImportedProductSource[]; imports: Array<{ dataType: "products"; fileName: string; periodStart: string; periodEnd: string; rowCount: number; importedAt: string }> };

function requireClient() { if (!supabase) throw new Error("Supabase chưa được cấu hình."); return supabase; }
function number(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function aliases(value: unknown) { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
function codeFor(sourceKey: string) { let hash = 0; for (let index = 0; index < sourceKey.length; index += 1) hash = (hash * 31 + sourceKey.charCodeAt(index)) | 0; return `NVL-${(hash >>> 0).toString(36).toUpperCase()}`; }

function toIngredient(row: Record<string, unknown>): IngredientMaster {
  return { id: String(row.id), storeId: String(row.store_id), code: String(row.code), name: String(row.name), aliases: aliases(row.aliases), category: String(row.category), brand: String(row.brand), baseUnit: String(row.base_unit), purchaseUnit: String(row.purchase_unit), latestPurchasePrice: number(row.latest_purchase_price), latestPurchasePricePerBaseUnit: number(row.latest_purchase_price_per_base_unit), standardWastePercent: number(row.standard_waste_percent), latestPurchasedOn: row.latest_purchased_on ? String(row.latest_purchased_on) : undefined, oldestInStockPurchasedOn: row.oldest_in_stock_purchased_on ? String(row.oldest_in_stock_purchased_on) : undefined, sourceInventoryLotId: row.source_inventory_receipt_id ? String(row.source_inventory_receipt_id) : undefined, stockQuantityBase: number(row.stock_quantity_base), stockLotCount: number(row.stock_lot_count), sourceKey: String(row.source_key), status: row.status === "inactive" ? "inactive" : "active", updatedAt: String(row.updated_at || new Date().toISOString()) };
}
function toProduct(row: Record<string, unknown>): ProductMaster {
  return { id: String(row.id), storeId: String(row.store_id), sku: String(row.sku), name: String(row.name), category: String(row.category), variant: String(row.variant || ""), sellingPrice: number(row.selling_price), sellingPriceOverridden: Boolean(row.selling_price_overridden), packagingCost: number(row.packaging_cost), status: "active", source: "import", updatedAt: String(row.updated_at || new Date().toISOString()) };
}
function financeSource(row: FinanceProductRecord): ImportedProductSource { return { sku: row.sku, name: row.name, category: row.category, variant: row.variant, unit: row.unit, sellingPrice: row.sellingPrice, quantity: row.quantity, totalAmount: row.totalAmount }; }

async function loadFinanceSource() {
  const finance = await loadFinanceImports();
  const importMeta = finance.imports.filter((entry) => entry.dataType === "products").map((entry) => ({ ...entry, dataType: "products" as const }));
  return { products: finance.products.map(financeSource), imports: importMeta };
}

export async function loadCloudMasterData(inventoryLots: InventorySourceLot[]): Promise<CloudLoad> {
  const client = requireClient();
  const { data: store, error: storeError } = await client.from("stores").select("*").eq("code", DEFAULT_STORE.code).maybeSingle();
  if (storeError || !store) throw new Error("Chưa thấy cửa hàng Product Master trên Supabase. Hãy kiểm tra migration Product Master đã chạy.");
  const storeId = String(store.id);
  const finance = await loadFinanceSource();
  const [ingredientsResult] = await Promise.all([
    client.from("ingredient_master").select("*").eq("store_id", storeId),
  ]);
  if (ingredientsResult.error) throw ingredientsResult.error;
  const syncedIngredients = mergeInventoryDrafts((ingredientsResult.data || []).map((row) => toIngredient(row)), inventoryLots);
  const ingredientRows = syncedIngredients.map((ingredient) => ({ store_id: storeId, code: ingredient.code || codeFor(ingredient.sourceKey), name: ingredient.name, aliases: ingredient.aliases, category: ingredient.category, brand: ingredient.brand, base_unit: ingredient.baseUnit, purchase_unit: ingredient.purchaseUnit, latest_purchase_price: ingredient.latestPurchasePrice, latest_purchase_price_per_base_unit: ingredient.latestPurchasePricePerBaseUnit, standard_waste_percent: ingredient.standardWastePercent, latest_purchased_on: ingredient.latestPurchasedOn || null, oldest_in_stock_purchased_on: ingredient.oldestInStockPurchasedOn || null, source_inventory_receipt_id: ingredient.sourceInventoryLotId || null, stock_quantity_base: ingredient.stockQuantityBase, stock_lot_count: ingredient.stockLotCount, source_key: ingredient.sourceKey, status: ingredient.status, updated_at: new Date().toISOString() }));
  if (ingredientRows.length) { const { error } = await client.from("ingredient_master").upsert(ingredientRows, { onConflict: "store_id,source_key" }); if (error) throw error; }
  const { error: reconcileError } = await client.rpc("reconcile_product_master_from_finance", { p_store_id: storeId });
  if (reconcileError) throw reconcileError;
  const [freshIngredients, freshProducts, versionsResult, eventsResult] = await Promise.all([
    client.from("ingredient_master").select("*").eq("store_id", storeId),
    client.from("product_master").select("*").eq("store_id", storeId),
    client.from("product_recipe_versions").select("*, product_recipe_items(*)"),
    client.from("product_audit_events").select("*").order("created_at", { ascending: false }).limit(250),
  ]);
  if (freshIngredients.error || freshProducts.error || versionsResult.error || eventsResult.error) throw freshIngredients.error || freshProducts.error || versionsResult.error || eventsResult.error;
  const recipeVersions: RecipeVersion[] = (versionsResult.data || []).map((row) => ({ id: row.id, productId: row.product_id, version: number(row.version), effectiveFrom: row.effective_from, effectiveTo: row.effective_to || undefined, status: row.status, createdAt: row.created_at, items: (row.product_recipe_items || []).map((item: Record<string, unknown>) => ({ id: String(item.id), ingredientId: String(item.ingredient_id), quantity: number(item.quantity), unit: String(item.unit), wastePercent: number(item.waste_percent) })) }));
  const auditEvents: AuditEvent[] = (eventsResult.data || []).map((row) => ({ id: row.id, entityType: row.entity_type, entityId: row.entity_id, action: row.action, detail: row.detail, createdAt: row.created_at }));
  const products = (freshProducts.data || []).map((row) => toProduct(row));
  const productIds = new Set(products.map((product) => product.id));
  return { state: { ...emptyMasterDataState(), stores: [{ ...DEFAULT_STORE, id: storeId }], ingredients: mergeInventoryDrafts((freshIngredients.data || []).map((row) => toIngredient(row)), inventoryLots), products, recipeVersions: recipeVersions.filter((version) => productIds.has(version.productId)), auditEvents }, ...finance };
}

export async function saveCloudProduct(product: ProductMaster) {
  const client = requireClient();
  const { error } = await client.from("product_master").upsert({ id: product.id, store_id: product.storeId, sku: product.sku, name: product.name, category: product.category, variant: product.variant, selling_price: product.sellingPrice, selling_price_overridden: product.sellingPriceOverridden, packaging_cost: product.packagingCost, source: "import", status: "active", updated_at: product.updatedAt }, { onConflict: "store_id,sku" });
  if (error) throw error;
  const { error: auditError } = await client.from("product_audit_events").insert({ store_id: product.storeId, entity_type: "product", entity_id: product.id, action: "save", detail: "Lưu thông tin SKU" });
  if (auditError) throw auditError;
}

export async function saveCloudRecipe(version: RecipeVersion, storeId: string, previousVersionId?: string) {
  const client = requireClient();
  const now = new Date().toISOString();
  if (previousVersionId) { const { error } = await client.from("product_recipe_versions").update({ status: "archived", effective_to: version.effectiveFrom }).eq("id", previousVersionId); if (error) throw error; }
  const { error: versionError } = await client.from("product_recipe_versions").insert({ id: version.id, product_id: version.productId, version: version.version, effective_from: version.effectiveFrom, status: "active", created_at: version.createdAt });
  if (versionError) throw versionError;
  if (version.items.length) { const { error } = await client.from("product_recipe_items").insert(version.items.map((item) => ({ id: item.id, recipe_version_id: version.id, product_id: version.productId, ingredient_id: item.ingredientId, quantity: item.quantity, unit: item.unit, waste_percent: item.wastePercent, created_at: now, updated_at: now }))); if (error) throw error; }
  const { error: auditError } = await client.from("product_audit_events").insert({ store_id: storeId, entity_type: "recipe", entity_id: version.id, action: "save", detail: `Lưu công thức v${version.version}` });
  if (auditError) throw auditError;
}

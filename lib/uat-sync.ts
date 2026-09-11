import { loadInventory } from "./inventory-store";
import { loadCogsCatalog } from "./master-data-store";
import { DEFAULT_STORE, type ImportedProductSource, type ProductMaster } from "./master-data";

/// One-way Production -> Local/UAT snapshot.
///
/// UAT must stay a sandbox, so this module only ever READS Supabase and only
/// ever WRITES browser storage. There is no code path back to Production, which
/// is what keeps the UAT/Production boundary intact while still letting UAT be
/// exercised against the real catalogue instead of six sample lots.
///
/// It reuses `loadCogsCatalog` (explicitly upsert-free and reconciliation-free)
/// and `loadInventory` rather than re-mapping the tables, so the UAT copy cannot
/// drift from the shapes the app actually reads.

export const UAT_STORAGE_KEYS = {
  masterData: "nha-ops-master-data-uat-v5",
  masterDataReset: "nha-ops-master-data-uat-v5-reset-20260812",
  masterDeletedSkus: "nha-ops-master-data-uat-deleted-skus-v1",
  finance: "nha-ops-finance-uat-v2",
  inventory: "nha-ops-inventory-local-uat-v1",
  inventoryActive: "nha-ops-active-local-uat-v1",
  inventoryMeta: "nha-ops-meta-local-uat-v1",
} as const;

export type UatSyncSummary = { products: number; recipeVersions: number; ingredients: number; lots: number; activeSessions: number };

/// The Product Master UAT loader rebuilds imported SKUs from the Finance
/// snapshot and keeps only `manual` rows out of storage, so writing the master
/// state alone would silently drop every imported SKU on the next reload.
/// Writing the matching Finance product list is what makes the copy survive.
function financeSnapshotFrom(products: ProductMaster[]): ImportedProductSource[] {
  return products
    .filter((product) => product.source !== "manual")
    .map((product) => ({ sku: product.sku, name: product.name, category: product.category, variant: product.variant, sellingPrice: product.sellingPrice }));
}

export async function syncProductionToUat(): Promise<UatSyncSummary> {
  const [catalog, inventory] = await Promise.all([loadCogsCatalog(), loadInventory()]);
  // Receipt files are served from Supabase Storage behind signed URLs that
  // expire within the hour, so the UAT copy drops them instead of keeping a
  // link that will be dead the next time the sandbox is opened.
  const lots = inventory.items.map(({ receipt: _receipt, ...lot }) => lot);
  const existingFinance = (() => {
    try { return JSON.parse(window.localStorage.getItem(UAT_STORAGE_KEYS.finance) || "{}") as Record<string, unknown>; }
    catch { return {}; }
  })();

  window.localStorage.setItem(UAT_STORAGE_KEYS.finance, JSON.stringify({ ...existingFinance, products: financeSnapshotFrom(catalog.products) }));
  window.localStorage.setItem(UAT_STORAGE_KEYS.masterData, JSON.stringify({
    version: 5,
    stores: [DEFAULT_STORE],
    ingredients: catalog.ingredients,
    products: catalog.products,
    recipeVersions: catalog.recipeVersions,
    costSnapshots: [],
    auditEvents: [],
    importBatches: [],
  }));
  // The reset flag gates whether the stored master state is read at all, and a
  // stale delete list would hide SKUs that Production still has.
  window.localStorage.setItem(UAT_STORAGE_KEYS.masterDataReset, "1");
  window.localStorage.setItem(UAT_STORAGE_KEYS.masterDeletedSkus, "[]");
  window.localStorage.setItem(UAT_STORAGE_KEYS.inventory, JSON.stringify(lots));
  window.localStorage.setItem(UAT_STORAGE_KEYS.inventoryActive, JSON.stringify(inventory.activeSessions));
  window.localStorage.setItem(UAT_STORAGE_KEYS.inventoryMeta, JSON.stringify(inventory.lotMeta));

  return {
    products: catalog.products.length,
    recipeVersions: catalog.recipeVersions.length,
    ingredients: catalog.ingredients.length,
    lots: lots.length,
    activeSessions: inventory.activeSessions.length,
  };
}

export type MasterStatus = "unmapped" | "draft" | "ready" | "active" | "inactive";
export type UnitFamily = "mass" | "volume" | "count";
export type RecipeVersionStatus = "draft" | "active" | "archived";

export type StoreMaster = {
  id: string;
  code: string;
  name: string;
  status: "active" | "inactive";
  isDefault: boolean;
};

export type InventorySourceLot = {
  id: string;
  name: string;
  category: string;
  brand: string;
  unit: string;
  quantity: number;
  stockQuantity: number;
  sealedQuantity?: number;
  activeQuantity?: number;
  specification: string;
  conversion?: { amount: number; unit: string };
  unitCost: number;
  purchasedOn: string;
};

export type ImportedProductSource = {
  sku: string;
  name: string;
  category: string;
  variant?: string;
  unit?: string;
  sellingPrice?: number;
  totalAmount?: number;
  quantity?: number;
};

export type IngredientMaster = {
  id: string;
  storeId: string;
  code: string;
  name: string;
  aliases: string[];
  category: string;
  brand: string;
  baseUnit: string;
  conversionUnit?: string;
  purchaseUnit: string;
  latestPurchasePrice: number;
  latestPurchasePricePerBaseUnit: number;
  standardWastePercent: number;
  latestPurchasedOn?: string;
  oldestInStockPurchasedOn?: string;
  sourceInventoryLotId?: string;
  stockQuantityBase: number;
  stockLotCount: number;
  sourceKey: string;
  status: MasterStatus;
  updatedAt: string;
};

export type ProductMaster = {
  id: string;
  storeId: string;
  sku: string;
  name: string;
  category: string;
  variant: string;
  sellingPrice: number;
  sellingPriceOverridden: boolean;
  packagingCost: number;
  status: MasterStatus;
  source: "import" | "manual";
  updatedAt: string;
};

export type ProductRecipeItem = {
  id: string;
  ingredientId: string;
  quantity: number;
  unit: string;
  wastePercent: number;
  // Manual exception for components that intentionally have no Kho NVL conversion.
  customName?: string;
  customBrand?: string;
  customCategory?: string;
  customCost?: number;
};

export type RecipeVersion = {
  id: string;
  productId: string;
  version: number;
  effectiveFrom: string;
  effectiveTo?: string;
  status: RecipeVersionStatus;
  items: ProductRecipeItem[];
  packagingItems?: ProductRecipeItem[];
  createdAt: string;
  source?: "workbook" | "manual";
  sourceLabel?: string;
  expectedItemCount?: number;
  importIssues?: string[];
};

export type CostSnapshot = {
  id: string;
  productId: string;
  recipeVersionId: string;
  effectiveFrom: string;
  sellingPrice: number;
  theoreticalCost: number;
  grossMarginPercent: number;
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  entityType: "product" | "ingredient" | "recipe";
  entityId: string;
  action: string;
  detail: string;
  createdAt: string;
};

export type ImportBatchRecord = {
  id: string;
  storeId: string;
  dataType: "revenue" | "products" | "service";
  fileName: string;
  periodStart: string;
  periodEnd: string;
  rowCount: number;
  importedAt: string;
  status: "completed" | "failed";
};

export type MasterDataState = {
  version: 5;
  stores: StoreMaster[];
  ingredients: IngredientMaster[];
  products: ProductMaster[];
  recipeVersions: RecipeVersion[];
  costSnapshots: CostSnapshot[];
  auditEvents: AuditEvent[];
  importBatches: ImportBatchRecord[];
};

export const DEFAULT_STORE: StoreMaster = {
  id: "store-nha-31-7",
  code: "NHA-31-7",
  name: "Nhà Coffee & Tea - 31:7",
  status: "active",
  isDefault: true,
};

export const MASS_UNITS = ["mg", "g", "kg"] as const;
export const VOLUME_UNITS = ["ml", "l", "oz"] as const;
export const COUNT_UNITS = ["cái", "tờ", "viên", "phần", "gói", "túi", "hộp", "chai", "lon", "trái", "miếng", "muỗng", "vá"] as const;
export const ALL_RECIPE_UNITS = [...MASS_UNITS, ...VOLUME_UNITS, ...COUNT_UNITS];
const MASTER_STATUSES: MasterStatus[] = ["unmapped", "draft", "ready", "active", "inactive"];

const unitFactors: Record<string, { family: UnitFamily; factor: number; base: string }> = {
  mg: { family: "mass", factor: 0.001, base: "g" },
  g: { family: "mass", factor: 1, base: "g" },
  kg: { family: "mass", factor: 1000, base: "g" },
  ml: { family: "volume", factor: 1, base: "ml" },
  l: { family: "volume", factor: 1000, base: "ml" },
  oz: { family: "volume", factor: 29.5735, base: "ml" },
  cai: { family: "count", factor: 1, base: "cái" },
  to: { family: "count", factor: 1, base: "cái" },
  vien: { family: "count", factor: 1, base: "cái" },
  phan: { family: "count", factor: 1, base: "cái" },
  goi: { family: "count", factor: 1, base: "cái" },
  tui: { family: "count", factor: 1, base: "cái" },
  hop: { family: "count", factor: 1, base: "cái" },
  "chai": { family: "count", factor: 1, base: "cái" },
  "lon": { family: "count", factor: 1, base: "cái" },
  trai: { family: "count", factor: 1, base: "cái" },
  mieng: { family: "count", factor: 1, base: "cái" },
  muong: { family: "count", factor: 1, base: "cái" },
  va: { family: "count", factor: 1, base: "cái" },
};

export function normalizedText(value: string) {
  return value.trim().toLocaleLowerCase("vi").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/\s+/g, " ");
}

export function unitDefinition(unit: string) {
  return unitFactors[normalizedText(unit)];
}

export function compatibleUnits(baseUnit: string) {
  const base = unitDefinition(baseUnit);
  if (!base) return [baseUnit];
  return ALL_RECIPE_UNITS.filter((unit) => unitDefinition(unit)?.family === base.family);
}

export function convertToBase(quantity: number, unit: string, baseUnit: string) {
  const from = unitDefinition(unit);
  const target = unitDefinition(baseUnit);
  if (!from || !target || from.family !== target.family) return undefined;
  return quantity * from.factor / target.factor;
}

function sourceKey(lot: Pick<InventorySourceLot, "name" | "category" | "brand">) {
  return [lot.name, lot.category, lot.brand].map(normalizedText).join("|");
}

function slug(value: string) {
  return normalizedText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function ingredientCode(index: number) {
  return `NVL-${String(index + 1).padStart(4, "0")}`;
}

function specificationBase(specification: string, purchaseUnit: string, conversion?: InventorySourceLot["conversion"]) {
  if (conversion?.amount && unitDefinition(conversion.unit)) {
    const definition = unitDefinition(conversion.unit)!;
    return { baseUnit: definition.base, baseQuantity: conversion.amount * definition.factor };
  }
  const match = specification.trim().match(/^([\d.,]+)\s*(mg|g|kg|ml|l|oz|cái|tờ|viên|phần|gói|túi|hộp|chai|lon|trái|miếng|muỗng|vá)\b/i);
  if (match) {
    const amount = Number(match[1].replace(",", "."));
    const unit = normalizedText(match[2]);
    const definition = unitDefinition(unit);
    if (amount > 0 && definition) return { baseUnit: definition.base, baseQuantity: amount * definition.factor };
  }
  const purchaseDefinition = unitDefinition(purchaseUnit);
  return { baseUnit: purchaseDefinition?.base || "cái", baseQuantity: 1 };
}

export function ingredientDraftsFromInventory(lots: InventorySourceLot[], storeId = DEFAULT_STORE.id) {
  const grouped = new Map<string, InventorySourceLot[]>();
  for (const lot of lots) {
    const key = sourceKey(lot);
    grouped.set(key, [...(grouped.get(key) || []), lot]);
  }
  return [...grouped.entries()].map(([key, sourceLots], index): IngredientMaster => {
    const latestLot = [...sourceLots].sort((a, b) => b.purchasedOn.localeCompare(a.purchasedOn))[0];
    const inStockLots = sourceLots.filter((lot) => lot.stockQuantity > 0).sort((a, b) => a.purchasedOn.localeCompare(b.purchasedOn));
    const activeLots = inStockLots.filter((lot) => (lot.activeQuantity || 0) > 0);
    const sealedLots = inStockLots.filter((lot) => (lot.sealedQuantity || 0) > 0);
    // Formula cost follows the lot being used now; otherwise it follows FIFO sealed stock.
    const preferredLot = activeLots[0] || sealedLots[0] || inStockLots[0] || latestLot;
    const preferredSpecification = specificationBase(preferredLot.specification, preferredLot.unit, preferredLot.conversion);
    const stockQuantityBase = sourceLots.reduce((sum, lot) => {
      const definition = specificationBase(lot.specification, lot.unit, lot.conversion);
      if (definition.baseUnit !== preferredSpecification.baseUnit) return sum;
      return sum + Math.max(0, lot.stockQuantity) * definition.baseQuantity;
    }, 0);
    return {
      id: `ingredient-${slug(preferredLot.name) || index + 1}-${index + 1}`,
      storeId,
      code: ingredientCode(index),
      name: preferredLot.name,
      aliases: [],
      category: preferredLot.category,
      brand: preferredLot.brand,
      baseUnit: preferredSpecification.baseUnit,
      conversionUnit: preferredLot.conversion?.amount && unitDefinition(preferredLot.conversion.unit) ? preferredLot.conversion.unit.trim() : undefined,
      purchaseUnit: preferredLot.unit,
      latestPurchasePrice: preferredLot.unitCost,
      latestPurchasePricePerBaseUnit: preferredSpecification.baseQuantity ? preferredLot.unitCost / preferredSpecification.baseQuantity : 0,
      standardWastePercent: 0,
      latestPurchasedOn: preferredLot.purchasedOn,
      oldestInStockPurchasedOn: inStockLots[0]?.purchasedOn,
      sourceInventoryLotId: preferredLot.id,
      stockQuantityBase,
      stockLotCount: inStockLots.length,
      sourceKey: key,
      status: "active",
      updatedAt: new Date().toISOString(),
    };
  });
}

export function productDraftFromSource(source: ImportedProductSource, storeId = DEFAULT_STORE.id): ProductMaster {
  const observedPrice = source.sellingPrice || (source.quantity && source.totalAmount ? source.totalAmount / source.quantity : 0);
  return {
    id: crypto.randomUUID(),
    storeId,
    sku: source.sku.trim(),
    name: source.name.trim(),
    category: source.category.trim() || "Chưa phân loại",
    variant: source.variant?.trim() || "",
    sellingPrice: Math.max(0, Math.round(observedPrice || 0)),
    sellingPriceOverridden: false,
    packagingCost: 0,
    status: "active",
    source: "import",
    updatedAt: new Date().toISOString(),
  };
}

export function mergeProductDrafts(current: ProductMaster[], imported: ImportedProductSource[], storeId = DEFAULT_STORE.id) {
  const merged: ProductMaster[] = [];
  const uniqueSources = new Map<string, ImportedProductSource>();
  for (const source of imported) uniqueSources.set(normalizedText(source.sku), source);
  for (const source of uniqueSources.values()) {
    const existing = current.find((product) => normalizedText(product.sku) === normalizedText(source.sku));
    const observedPrice = source.sellingPrice || (source.quantity && source.totalAmount ? Math.max(0, Math.round(source.totalAmount / source.quantity)) : 0);
    if (!existing) {
      merged.push(productDraftFromSource(source, storeId));
      continue;
    }
    merged.push({
      ...existing,
      name: source.name.trim() || existing.name,
      category: source.category.trim() || "Chưa phân loại",
      variant: source.variant?.trim() || "",
      sellingPrice: existing.sellingPriceOverridden ? existing.sellingPrice : Math.max(0, Math.round(observedPrice || 0)),
      status: "active",
      source: "import",
      updatedAt: new Date().toISOString(),
    });
  }
  // Manual UAT drafts are intentionally not part of the Finance snapshot.
  for (const product of current) if (product.source === "manual") merged.push(product);
  return merged;
}

export function activeRecipeVersion(productId: string, versions: RecipeVersion[]) {
  return versions.filter((version) => version.productId === productId && version.status === "active").sort((a, b) => b.version - a.version)[0];
}

export function editableRecipeVersion(productId: string, versions: RecipeVersion[]) {
  return activeRecipeVersion(productId, versions);
}

export function recipeItemCost(recipe: ProductRecipeItem, ingredient?: IngredientMaster) {
  if (recipe.customName) return recipe.customCost && recipe.customCost > 0 ? recipe.customCost : undefined;
  if (!ingredient || !recipe.quantity) return undefined;
  const baseQuantity = convertToBase(recipe.quantity, recipe.unit, ingredient.baseUnit);
  if (baseQuantity === undefined || ingredient.latestPurchasePricePerBaseUnit <= 0) return undefined;
  return baseQuantity * ingredient.latestPurchasePricePerBaseUnit * (1 + Math.max(0, recipe.wastePercent) / 100);
}

export function recipeItemsCost(items: ProductRecipeItem[] | undefined, ingredients: IngredientMaster[]) {
  if (!items?.length) return 0;
  let total = 0;
  for (const item of items) {
    const cost = recipeItemCost(item, ingredients.find((ingredient) => ingredient.id === item.ingredientId));
    if (cost === undefined) return undefined;
    total += cost;
  }
  return total;
}

export function recipeVersionCost(version: RecipeVersion | undefined, ingredients: IngredientMaster[], packagingCost = 0) {
  if (!version?.items.length || version.importIssues?.length || (version.expectedItemCount !== undefined && version.items.length < version.expectedItemCount)) return undefined;
  const ingredientCost = recipeItemsCost(version.items, ingredients);
  const packagingIngredientCost = recipeItemsCost(version.packagingItems, ingredients);
  return ingredientCost === undefined || packagingIngredientCost === undefined ? undefined : ingredientCost + packagingIngredientCost + packagingCost;
}

export function theoreticalProductCost(product: ProductMaster, versions: RecipeVersion[], ingredients: IngredientMaster[]) {
  return recipeVersionCost(activeRecipeVersion(product.id, versions), ingredients, product.packagingCost);
}

export function productValidationErrors(product: ProductMaster, versions: RecipeVersion[], ingredients: IngredientMaster[]) {
  const errors: string[] = [];
  const activeRecipe = activeRecipeVersion(product.id, versions);
  const recipe = activeRecipe;
  if (!product.sku.trim()) errors.push("Thiếu mã SKU");
  if (!product.name.trim()) errors.push("Thiếu tên sản phẩm");
  if (!product.category.trim() || product.category === "Chưa phân loại") errors.push("Thiếu category chuẩn");
  if (product.sellingPrice <= 0) errors.push("Thiếu giá bán");
  if (!recipe?.items.length) errors.push("Chưa có công thức");
  for (const issue of recipe?.importIssues || []) errors.push(`CT Excel: ${issue}`);
  for (const item of recipe?.items || []) {
    if (item.customName) {
      if (!item.customCost || item.customCost <= 0) errors.push(`${item.customName}: mục Khác chưa có giá vốn để tính`);
      continue;
    }
    const ingredient = ingredients.find((entry) => entry.id === item.ingredientId);
    if (!ingredient) errors.push("Công thức tham chiếu nguyên liệu không tồn tại");
    else if (ingredient.status !== "active" || ingredient.stockQuantityBase <= 0) errors.push(`${ingredient.name} · ${ingredient.brand}: không còn khả dụng ở Kho hay Đang dùng`);
    else if (recipeItemCost(item, ingredient) === undefined) errors.push(`${ingredient.name}: thiếu giá hoặc sai nhóm đơn vị`);
  }
  return [...new Set(errors)];
}

export function auditEvent(entityType: AuditEvent["entityType"], entityId: string, action: string, detail: string): AuditEvent {
  return { id: crypto.randomUUID(), entityType, entityId, action, detail, createdAt: new Date().toISOString() };
}

export function emptyMasterDataState(): MasterDataState {
  return { version: 5, stores: [DEFAULT_STORE], ingredients: [], products: [], recipeVersions: [], costSnapshots: [], auditEvents: [], importBatches: [] };
}

export function normalizeMasterDataState(value: unknown): MasterDataState {
  if (!value || typeof value !== "object") return emptyMasterDataState();
  const stored = value as Partial<MasterDataState> & { recipes?: Array<ProductRecipeItem & { productId?: string }> };
  const now = new Date().toISOString();
  const normalizeStatus = (status: unknown): MasterStatus => MASTER_STATUSES.includes(status as MasterStatus) ? status as MasterStatus : "draft";
  const products = Array.isArray(stored.products) ? stored.products.map((product) => ({ ...product, variant: typeof product.variant === "string" ? product.variant : "", sellingPriceOverridden: Boolean(product.sellingPriceOverridden), status: "active" as MasterStatus })) : [];
  const ingredients = Array.isArray(stored.ingredients) ? stored.ingredients.map((ingredient) => ({ ...ingredient, conversionUnit: typeof ingredient.conversionUnit === "string" && unitDefinition(ingredient.conversionUnit) ? ingredient.conversionUnit : undefined, aliases: Array.isArray(ingredient.aliases) ? ingredient.aliases : [], standardWastePercent: Number(ingredient.standardWastePercent) || 0, stockQuantityBase: Number(ingredient.stockQuantityBase) || 0, stockLotCount: Number(ingredient.stockLotCount) || 0, status: normalizeStatus(ingredient.status) })) : [];
  let recipeVersions = Array.isArray(stored.recipeVersions) ? stored.recipeVersions : [];
  if (!recipeVersions.length && Array.isArray(stored.recipes)) {
    const grouped = new Map<string, ProductRecipeItem[]>();
    for (const legacy of stored.recipes) {
      if (!legacy.productId) continue;
      const item: ProductRecipeItem = { id: legacy.id, ingredientId: legacy.ingredientId, quantity: legacy.quantity, unit: legacy.unit, wastePercent: legacy.wastePercent };
      grouped.set(legacy.productId, [...(grouped.get(legacy.productId) || []), item]);
    }
    recipeVersions = [...grouped.entries()].map(([productId, items]) => ({ id: crypto.randomUUID(), productId, version: 1, effectiveFrom: now.slice(0, 10), status: "draft" as const, items, createdAt: now }));
  }
  // Old drafts represented an unfinished activation flow. The latest version is now the saved current recipe.
  const latestRecipeIdByProduct = new Map<string, string>();
  for (const version of [...recipeVersions].sort((left, right) => right.version - left.version)) {
    if (!latestRecipeIdByProduct.has(version.productId) && version.status !== "archived") latestRecipeIdByProduct.set(version.productId, version.id);
  }
  recipeVersions = recipeVersions.map((version) => ({ ...version, status: latestRecipeIdByProduct.get(version.productId) === version.id ? "active" as const : "archived" as const }));
  return {
    version: 5,
    stores: Array.isArray(stored.stores) && stored.stores.length ? stored.stores : [DEFAULT_STORE],
    ingredients,
    products,
    recipeVersions,
    costSnapshots: Array.isArray(stored.costSnapshots) ? stored.costSnapshots : [],
    auditEvents: Array.isArray(stored.auditEvents) ? stored.auditEvents : [],
    importBatches: Array.isArray(stored.importBatches) ? stored.importBatches : [],
  };
}

export function mergeInventoryDrafts(current: IngredientMaster[], lots: InventorySourceLot[]) {
  const incoming = ingredientDraftsFromInventory(lots);
  const currentByKey = new Map(current.map((ingredient) => [ingredient.sourceKey, ingredient]));
  const incomingKeys = new Set(incoming.map((ingredient) => ingredient.sourceKey));
  // Keep referenced master rows for recipe history, but remove stale lots from live choices.
  const merged = current.map((ingredient) => incomingKeys.has(ingredient.sourceKey) ? ingredient : {
    ...ingredient,
    sourceInventoryLotId: undefined,
    stockQuantityBase: 0,
    stockLotCount: 0,
    oldestInStockPurchasedOn: undefined,
    status: "inactive" as const,
    updatedAt: new Date().toISOString(),
  });
  for (const draft of incoming) {
    const existing = currentByKey.get(draft.sourceKey);
    if (!existing) {
      merged.push({ ...draft, code: ingredientCode(merged.length) });
      continue;
    }
    const index = merged.findIndex((ingredient) => ingredient.id === existing.id);
    merged[index] = {
      ...existing,
      name: draft.name,
      category: draft.category,
      brand: draft.brand,
      baseUnit: draft.baseUnit,
      conversionUnit: draft.conversionUnit,
      purchaseUnit: draft.purchaseUnit,
      latestPurchasePrice: draft.latestPurchasePrice,
      latestPurchasePricePerBaseUnit: draft.latestPurchasePricePerBaseUnit,
      latestPurchasedOn: draft.latestPurchasedOn,
      oldestInStockPurchasedOn: draft.oldestInStockPurchasedOn,
      sourceInventoryLotId: draft.sourceInventoryLotId,
      stockQuantityBase: draft.stockQuantityBase,
      stockLotCount: draft.stockLotCount,
      status: "active",
      updatedAt: new Date().toISOString(),
    };
  }
  return merged;
}

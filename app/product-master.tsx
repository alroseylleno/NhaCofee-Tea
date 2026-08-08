"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  ALL_RECIPE_UNITS,
  DEFAULT_STORE,
  type ImportedProductSource,
  type IngredientMaster,
  type InventorySourceLot,
  type MasterDataState,
  type MasterStatus,
  type ProductMaster,
  type ProductRecipeItem,
  type RecipeVersion,
  activeRecipeVersion,
  auditEvent,
  compatibleUnits,
  convertToBase,
  emptyMasterDataState,
  mergeInventoryDrafts,
  mergeProductDrafts,
  normalizeMasterDataState,
  normalizedText,
  productDraftFromSource,
  productValidationErrors,
  recipeItemCost,
  recipeVersionCost,
  theoreticalProductCost,
} from "@/lib/master-data";
import { loadCloudMasterData, saveCloudProduct, saveCloudRecipe } from "@/lib/master-data-store";
import styles from "./product-master.module.css";

type MasterTab = "overview" | "queue" | "products";
type DetailTab = "summary" | "recipe" | "history";
type FinanceLocalState = {
  products?: ImportedProductSource[];
  imports?: Array<{ dataType: "revenue" | "products" | "service"; fileName: string; periodStart: string; periodEnd: string; rowCount: number; importedAt: string }>;
  importHistory?: Array<{ dataType: "revenue" | "products" | "service"; fileName: string; periodStart: string; periodEnd: string; rowCount: number; importedAt: string }>;
};
type ProductForm = { sku: string; name: string; aliases: string; category: string; sellingPrice: string; packagingCost: string };
type CapacityRow = { ingredient?: IngredientMaster; requiredBase: number; capacity: number };
type CapacityEstimate = { servings: number; limiting?: IngredientMaster; rows: CapacityRow[] };
type StockIssue = { key: string; product: ProductMaster; version: RecipeVersion; ingredient: IngredientMaster; candidates: IngredientMaster[] };
type ProductCostMetric = { product: ProductMaster; cost: number; margin?: number };
type FinanceCategoryMetric = { name: string; revenue: number; quantity: number; skuCount: number };

const MASTER_UAT_STORAGE_KEY = "nha-ops-master-data-uat-v3";
const MASTER_LEGACY_UAT_STORAGE_KEYS = ["nha-ops-master-data-uat-v2", "nha-ops-master-data-uat-v1"];
const FINANCE_UAT_STORAGE_KEY = "nha-ops-finance-uat-v2";
const demoProducts: ImportedProductSource[] = [
  { sku: "NHA-CF-001", name: "Cà phê sữa Nhà", category: "Cà phê", quantity: 16, totalAmount: 560_000 },
  { sku: "NHA-CF-002", name: "Bạc xỉu", category: "Cà phê", quantity: 12, totalAmount: 468_000 },
  { sku: "NHA-TEA-001", name: "Trà lài macchiato", category: "Trà", quantity: 10, totalAmount: 450_000 },
  { sku: "NHA-TEA-002", name: "Trà đào cam sả", category: "Trà", quantity: 8, totalAmount: 392_000 },
  { sku: "NHA-MAT-001", name: "Matcha latte", category: "Matcha", quantity: 7, totalAmount: 364_000 },
  { sku: "NHA-FRT-001", name: "Trà dâu Nhà", category: "Trà trái cây", quantity: 6, totalAmount: 288_000 },
];

function money(value: number) {
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value || 0);
}

function numberLabel(value: number, maximumFractionDigits = 1) {
  return value.toLocaleString("vi-VN", { maximumFractionDigits });
}

function percent(value: number | undefined) {
  return value === undefined ? "-" : `${numberLabel(value)}%`;
}

function dateLabel(value?: string) {
  if (!value) return "-";
  const [year, month, day] = value.slice(0, 10).split("-");
  return day && month && year ? `${day}/${month}/${year}` : value;
}

function amountInput(value: number | string) {
  const digits = String(value).replace(/\D/g, "");
  return digits ? Number(digits).toLocaleString("en-US") : "";
}

function parseAmount(value: string) {
  return Number(value.replace(/\D/g, "")) || 0;
}

function parseAliases(value: string) {
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function productDefaults(): ProductForm {
  return { sku: "", name: "", aliases: "", category: "", sellingPrice: "", packagingCost: "" };
}

function readFinanceLocalState(): FinanceLocalState {
  try { return JSON.parse(window.localStorage.getItem(FINANCE_UAT_STORAGE_KEY) || "{}") as FinanceLocalState; }
  catch { return {}; }
}

function sourceProducts() {
  const finance = readFinanceLocalState();
  return finance.products?.length ? finance.products : demoProducts;
}

function sortIngredientsForUse(ingredients: IngredientMaster[]) {
  return [...ingredients].sort((left, right) => {
    const stockOrder = Number(right.stockQuantityBase > 0) - Number(left.stockQuantityBase > 0);
    if (stockOrder) return stockOrder;
    const dateOrder = (left.oldestInStockPurchasedOn || "9999-12-31").localeCompare(right.oldestInStockPurchasedOn || "9999-12-31");
    if (dateOrder) return dateOrder;
    return `${left.name} ${left.brand}`.localeCompare(`${right.name} ${right.brand}`, "vi");
  });
}

function sameUnitFamily(left: IngredientMaster, right: IngredientMaster) {
  return convertToBase(1, left.baseUnit, right.baseUnit) !== undefined;
}

function capacityEstimate(version: RecipeVersion | undefined, ingredients: IngredientMaster[]): CapacityEstimate | undefined {
  if (!version?.items.length) return undefined;
  const rows = version.items.map((item): CapacityRow => {
    const ingredient = ingredients.find((entry) => entry.id === item.ingredientId);
    const converted = ingredient ? convertToBase(item.quantity, item.unit, ingredient.baseUnit) : undefined;
    const requiredBase = converted === undefined ? 0 : converted * (1 + Math.max(0, item.wastePercent) / 100);
    return { ingredient, requiredBase, capacity: ingredient && requiredBase > 0 ? Math.floor(ingredient.stockQuantityBase / requiredBase) : 0 };
  });
  const limitingRow = [...rows].sort((left, right) => left.capacity - right.capacity)[0];
  return { servings: limitingRow?.capacity || 0, limiting: limitingRow?.ingredient, rows };
}

function mergeSourceData(state: MasterDataState, inventoryLots: InventorySourceLot[]) {
  const finance = readFinanceLocalState();
  const importedProducts = finance.products?.length ? finance.products : demoProducts;
  const importBatches = [...state.importBatches];
  for (const imported of finance.importHistory || finance.imports || []) {
    const id = `finance-${imported.dataType}-${imported.importedAt}`;
    if (!importBatches.some((batch) => batch.id === id)) importBatches.push({ id, storeId: DEFAULT_STORE.id, ...imported, status: "completed" });
  }
  return {
    ...state,
    ingredients: mergeInventoryDrafts(state.ingredients, inventoryLots),
    products: mergeProductDrafts(state.products, importedProducts),
    importBatches,
  };
}

function completeUatState(inventoryLots: InventorySourceLot[]) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  let ingredients = mergeInventoryDrafts([], inventoryLots);
  if (!ingredients.length) {
    ingredients = [
      { id: crypto.randomUUID(), storeId: DEFAULT_STORE.id, code: "NVL-0001", name: "Cà phê hạt", aliases: [], category: "CÀ PHÊ", brand: "Nhà", baseUnit: "g", purchaseUnit: "kg", latestPurchasePrice: 320_000, latestPurchasePricePerBaseUnit: 320, standardWastePercent: 2, latestPurchasedOn: today, oldestInStockPurchasedOn: today, stockQuantityBase: 4_000, stockLotCount: 1, sourceKey: "demo-coffee", status: "active", updatedAt: now },
      { id: crypto.randomUUID(), storeId: DEFAULT_STORE.id, code: "NVL-0002", name: "Sữa tươi", aliases: [], category: "SỮA TƯƠI", brand: "Vinamilk", baseUnit: "ml", purchaseUnit: "hộp", latestPurchasePrice: 36_000, latestPurchasePricePerBaseUnit: 36, standardWastePercent: 1, latestPurchasedOn: today, oldestInStockPurchasedOn: today, stockQuantityBase: 12_000, stockLotCount: 12, sourceKey: "demo-milk", status: "active", updatedAt: now },
      { id: crypto.randomUUID(), storeId: DEFAULT_STORE.id, code: "NVL-0003", name: "Trà lài", aliases: [], category: "TRÀ", brand: "Nhà", baseUnit: "g", purchaseUnit: "túi", latestPurchasePrice: 185_000, latestPurchasePricePerBaseUnit: 185, standardWastePercent: 2, latestPurchasedOn: today, oldestInStockPurchasedOn: today, stockQuantityBase: 1_000, stockLotCount: 2, sourceKey: "demo-tea", status: "active", updatedAt: now },
    ];
  }
  const usableIngredients = sortIngredientsForUse(ingredients).filter((ingredient) => ingredient.stockQuantityBase > 0);
  const recipeIngredients = usableIngredients.length ? usableIngredients : sortIngredientsForUse(ingredients);
  const products = sourceProducts().map((source) => ({ ...productDraftFromSource(source), status: "active" as MasterStatus }));
  const recipeVersions: RecipeVersion[] = products.map((product, productIndex) => ({
    id: crypto.randomUUID(),
    productId: product.id,
    version: 1,
    effectiveFrom: today,
    status: "active",
    createdAt: now,
    items: recipeIngredients.slice(0, Math.min(2, recipeIngredients.length)).map((ingredient, index) => ({ id: crypto.randomUUID(), ingredientId: ingredient.id, quantity: ingredient.baseUnit === "ml" ? 25 + productIndex * 2 : 12 + productIndex + index, unit: ingredient.baseUnit, wastePercent: ingredient.standardWastePercent })),
  }));
  const costSnapshots = products.flatMap((product) => {
    const recipe = recipeVersions.find((entry) => entry.productId === product.id);
    const cost = recipeVersionCost(recipe, ingredients, product.packagingCost);
    if (cost === undefined || !recipe) return [];
    return [{ id: crypto.randomUUID(), productId: product.id, recipeVersionId: recipe.id, effectiveFrom: today, sellingPrice: product.sellingPrice, theoreticalCost: cost, grossMarginPercent: product.sellingPrice ? (product.sellingPrice - cost) / product.sellingPrice * 100 : 0, createdAt: now }];
  });
  return { ...emptyMasterDataState(), ingredients, products, recipeVersions, costSnapshots, auditEvents: products.map((product) => auditEvent("product", product.id, "seed", "Tạo dữ liệu mẫu UAT hoàn chỉnh")) };
}

export default function ProductMaster({ inventoryLots, uatMode }: { inventoryLots: InventorySourceLot[]; uatMode: boolean }) {
  const [state, setState] = useState<MasterDataState>(emptyMasterDataState);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<MasterTab>("overview");
  const [search, setSearch] = useState("");
  const [financeSnapshot, setFinanceSnapshot] = useState<FinanceLocalState>({});
  const [replacementSelection, setReplacementSelection] = useState<Record<string, string>>({});
  const [inlineReplacementKey, setInlineReplacementKey] = useState("");
  const [selectedProductId, setSelectedProductId] = useState("");
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const [editingProductId, setEditingProductId] = useState<string>();
  const [showProductForm, setShowProductForm] = useState(false);
  const [productForm, setProductForm] = useState<ProductForm>(productDefaults);
  const [recipeCategory, setRecipeCategory] = useState("");
  const [recipeIngredientId, setRecipeIngredientId] = useState("");
  const [recipeQuantity, setRecipeQuantity] = useState("");
  const [recipeUnit, setRecipeUnit] = useState("g");
  const [recipeWaste, setRecipeWaste] = useState("0");
  const [selectedRecipeVersionId, setSelectedRecipeVersionId] = useState("");
  const [recipeDraftProductId, setRecipeDraftProductId] = useState("");
  const [recipeDraftSourceId, setRecipeDraftSourceId] = useState("");
  const [recipeDraftItems, setRecipeDraftItems] = useState<ProductRecipeItem[]>([]);

  useEffect(() => {
    if (!uatMode) {
      let cancelled = false;
      loadCloudMasterData(inventoryLots).then((cloud) => {
        if (cancelled) return;
        setState(cloud.state);
        setFinanceSnapshot({ products: cloud.products, imports: cloud.imports });
        setSelectedProductId("");
        setSelectedRecipeVersionId("");
        setLoaded(true);
      }).catch((error: unknown) => {
        if (!cancelled) { window.alert(error instanceof Error ? error.message : "Không thể tải Sản phẩm từ Supabase."); setLoaded(true); }
      });
      return () => { cancelled = true; };
    }
    let current = emptyMasterDataState();
    try {
      const stored = window.localStorage.getItem(MASTER_UAT_STORAGE_KEY) || MASTER_LEGACY_UAT_STORAGE_KEYS.map((key) => window.localStorage.getItem(key)).find(Boolean);
      current = normalizeMasterDataState(stored ? JSON.parse(stored) : null);
    } catch { current = emptyMasterDataState(); }
    setFinanceSnapshot(readFinanceLocalState());
    setState(mergeSourceData(current, inventoryLots));
    setSelectedProductId("");
    setSelectedRecipeVersionId("");
    setLoaded(true);
  }, [inventoryLots]);

  useEffect(() => {
    if (loaded && uatMode) window.localStorage.setItem(MASTER_UAT_STORAGE_KEY, JSON.stringify(state));
  }, [state, loaded, uatMode]);

  const ingredientCategories = useMemo(() => [...new Set(state.ingredients.map((ingredient) => ingredient.category).filter(Boolean))].sort((left, right) => left.localeCompare(right, "vi")), [state.ingredients]);
  const activeProducts = state.products;
  const inStockIngredients = state.ingredients.filter((ingredient) => ingredient.stockQuantityBase > 0);
  const filteredProducts = useMemo(() => state.products.filter((product) => normalizedText(`${product.sku} ${product.name} ${product.aliases.join(" ")} ${product.category}`).includes(normalizedText(search))), [state.products, search]);
  const selectedProduct = state.products.find((product) => product.id === selectedProductId);
  const selectedVersions = state.recipeVersions.filter((version) => version.productId === selectedProductId).sort((a, b) => b.version - a.version);
  const currentRecipe = activeRecipeVersion(selectedProductId, state.recipeVersions);
  const selectedVersion = selectedVersions.find((version) => version.id === selectedRecipeVersionId) || currentRecipe;
  const isCurrentRecipe = !selectedVersion || selectedVersion.id === currentRecipe?.id;
  const recipeItems = isCurrentRecipe && recipeDraftProductId === selectedProductId ? recipeDraftItems : selectedVersion?.items || [];
  const recipeDraftDirty = recipeDraftProductId === selectedProductId && JSON.stringify(recipeDraftItems) !== JSON.stringify(currentRecipe?.items || []);
  const selectedProductErrors = selectedProduct ? productValidationErrors(selectedProduct, state.recipeVersions, state.ingredients) : [];
  const selectedProductCost = selectedProduct ? theoreticalProductCost(selectedProduct, state.recipeVersions, state.ingredients) : undefined;
  const selectedProductMargin = selectedProductCost !== undefined && selectedProduct?.sellingPrice ? (selectedProduct.sellingPrice - selectedProductCost) / selectedProduct.sellingPrice * 100 : undefined;
  const selectedCapacity = capacityEstimate(isCurrentRecipe ? { ...(currentRecipe || { id: "", productId: selectedProductId, version: 0, effectiveFrom: "", status: "active" as const, createdAt: "" }), items: recipeItems } : selectedVersion, state.ingredients);
  const recipeCandidates = sortIngredientsForUse(state.ingredients.filter((ingredient) => !recipeCategory || ingredient.category === recipeCategory));
  const selectedRecipeIngredient = state.ingredients.find((ingredient) => ingredient.id === recipeIngredientId);
  const allowedRecipeUnits = selectedRecipeIngredient ? compatibleUnits(selectedRecipeIngredient.baseUnit) : ALL_RECIPE_UNITS;

  const stockIssues = useMemo<StockIssue[]>(() => {
    const issues = new Map<string, StockIssue>();
    for (const product of state.products) {
      const version = activeRecipeVersion(product.id, state.recipeVersions);
      if (!version) continue;
      for (const item of version.items) {
        const ingredient = state.ingredients.find((entry) => entry.id === item.ingredientId);
        if (!ingredient || ingredient.stockQuantityBase > 0) continue;
        const key = `${product.id}-${ingredient.id}`;
        const candidates = sortIngredientsForUse(state.ingredients.filter((candidate) => candidate.id !== ingredient.id && candidate.stockQuantityBase > 0 && candidate.category === ingredient.category && sameUnitFamily(ingredient, candidate)));
        issues.set(key, { key, product, version, ingredient, candidates });
      }
    }
    return [...issues.values()];
  }, [state]);

  const totalEstimatedServings = activeProducts.reduce((sum, product) => sum + (capacityEstimate(activeRecipeVersion(product.id, state.recipeVersions), state.ingredients)?.servings || 0), 0);
  const productCostMetrics = useMemo<ProductCostMetric[]>(() => state.products.flatMap((product) => {
    const cost = theoreticalProductCost(product, state.recipeVersions, state.ingredients);
    if (cost === undefined) return [];
    return [{ product, cost, margin: product.sellingPrice > 0 ? (product.sellingPrice - cost) / product.sellingPrice * 100 : undefined }];
  }), [state.products, state.recipeVersions, state.ingredients]);
  const averageProductCost = productCostMetrics.length ? productCostMetrics.reduce((sum, entry) => sum + entry.cost, 0) / productCostMetrics.length : 0;
  const averageMargin = productCostMetrics.filter((entry) => entry.margin !== undefined).length ? productCostMetrics.reduce((sum, entry) => sum + (entry.margin || 0), 0) / productCostMetrics.filter((entry) => entry.margin !== undefined).length : undefined;
  const highestCostProducts = [...productCostMetrics].sort((left, right) => right.cost - left.cost).slice(0, 5);
  const lowestCostProducts = [...productCostMetrics].sort((left, right) => left.cost - right.cost).slice(0, 5);
  const financeProducts = financeSnapshot.products || [];
  const topFinanceProducts = [...financeProducts].sort((left, right) => (right.totalAmount || 0) - (left.totalAmount || 0)).slice(0, 6);
  const financeCategories = useMemo<FinanceCategoryMetric[]>(() => {
    const categories = new Map<string, FinanceCategoryMetric>();
    for (const product of financeProducts) {
      const name = product.category?.trim() || "Chưa phân loại";
      const current = categories.get(name) || { name, revenue: 0, quantity: 0, skuCount: 0 };
      current.revenue += product.totalAmount || 0;
      current.quantity += product.quantity || 0;
      current.skuCount += 1;
      categories.set(name, current);
    }
    return [...categories.values()].sort((left, right) => right.revenue - left.revenue).slice(0, 6);
  }, [financeProducts]);
  const productsImport = [...(financeSnapshot.importHistory || []), ...(financeSnapshot.imports || [])].filter((entry) => entry.dataType === "products").sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0];

  function syncSources() {
    if (!uatMode) {
      setLoaded(false);
      loadCloudMasterData(inventoryLots).then((cloud) => {
        setState(cloud.state);
        setFinanceSnapshot({ products: cloud.products, imports: cloud.imports });
      }).catch((error: unknown) => window.alert(error instanceof Error ? error.message : "Không thể đồng bộ Product Master.")).finally(() => setLoaded(true));
      return;
    }
    setFinanceSnapshot(readFinanceLocalState());
    setState((current) => ({ ...mergeSourceData(current, inventoryLots), auditEvents: [auditEvent("ingredient", "sync", "sync", "Đồng bộ tồn Kho NVL và sản phẩm Finance local"), ...current.auditEvents] }));
  }

  function loadCompleteSample() {
    if (!window.confirm("Nạp bộ Sản phẩm UAT hoàn chỉnh để test? Dữ liệu Sản phẩm hiện tại trên trình duyệt sẽ được thay thế.")) return;
    setFinanceSnapshot(readFinanceLocalState());
    setState(completeUatState(inventoryLots));
    setSelectedProductId("");
    setSelectedRecipeVersionId("");
    setTab("overview");
  }

  function resetUat() {
    if (!window.confirm("Xóa dữ liệu Sản phẩm UAT và đồng bộ lại Kho NVL/Finance?")) return;
    setState(mergeSourceData(emptyMasterDataState(), inventoryLots));
    setSelectedProductId("");
    setSelectedRecipeVersionId("");
    setTab("queue");
  }

  function openProduct(product?: ProductMaster) {
    setEditingProductId(product?.id);
    setProductForm(product ? { sku: product.sku, name: product.name, aliases: product.aliases.join(", "), category: product.category, sellingPrice: amountInput(product.sellingPrice), packagingCost: amountInput(product.packagingCost) } : productDefaults());
    setShowProductForm(true);
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sku = productForm.sku.trim();
    if (!sku || !productForm.name.trim()) return;
    if (state.products.some((product) => normalizedText(product.sku) === normalizedText(sku) && product.id !== editingProductId)) { window.alert("Mã SKU đã tồn tại."); return; }
    const id = editingProductId || crypto.randomUUID();
    const existing = state.products.find((product) => product.id === editingProductId);
    const product: ProductMaster = { id, storeId: existing?.storeId || state.stores[0]?.id || DEFAULT_STORE.id, sku, name: productForm.name.trim(), aliases: parseAliases(productForm.aliases), category: productForm.category.trim() || "Chưa phân loại", sellingPrice: parseAmount(productForm.sellingPrice), packagingCost: parseAmount(productForm.packagingCost), status: "active", source: existing?.source || "manual", updatedAt: new Date().toISOString() };
    try {
      if (!uatMode) await saveCloudProduct(product);
      setState((current) => ({ ...current, products: existing ? current.products.map((entry) => entry.id === existing.id ? product : entry) : [product, ...current.products], auditEvents: [auditEvent("product", id, existing ? "update" : "create", existing ? "Cập nhật thông tin SKU" : "Tạo SKU thủ công"), ...current.auditEvents] }));
    } catch (error) { window.alert(error instanceof Error ? error.message : "Không thể lưu SKU."); return; }
    setShowProductForm(false);
    setSelectedProductId(id);
  }

  function startRecipeDraft(productId: string, items = activeRecipeVersion(productId, state.recipeVersions)?.items || []) {
    const source = activeRecipeVersion(productId, state.recipeVersions);
    setRecipeDraftProductId(productId);
    setRecipeDraftSourceId(source?.id || "");
    setRecipeDraftItems(items.map((item) => ({ ...item })));
    setSelectedRecipeVersionId(source?.id || "");
    setDetailTab("recipe");
  }

  function selectRecipeCategory(category: string) {
    setRecipeCategory(category);
    const preferred = sortIngredientsForUse(state.ingredients.filter((ingredient) => ingredient.category === category))[0];
    setRecipeIngredientId(preferred?.id || "");
    setRecipeUnit(preferred?.baseUnit || "g");
    setRecipeWaste(String(preferred?.standardWastePercent || 0));
  }

  function selectRecipeIngredient(id: string) {
    setRecipeIngredientId(id);
    const ingredient = state.ingredients.find((entry) => entry.id === id);
    setRecipeUnit(ingredient?.baseUnit || "g");
    setRecipeWaste(String(ingredient?.standardWastePercent || 0));
  }

  function addRecipeItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const quantity = Number(recipeQuantity);
    if (!selectedProduct || !isCurrentRecipe || !recipeIngredientId || quantity <= 0) return;
    const ingredient = state.ingredients.find((entry) => entry.id === recipeIngredientId);
    if (!ingredient || !compatibleUnits(ingredient.baseUnit).some((unit) => unit === recipeUnit)) { window.alert("Đơn vị công thức không cùng nhóm với đơn vị chuẩn."); return; }
    setRecipeDraftItems((current) => [...current, { id: crypto.randomUUID(), ingredientId: recipeIngredientId, quantity, unit: recipeUnit, wastePercent: Math.max(0, Number(recipeWaste) || 0) }]);
    setRecipeQuantity("");
  }

  function removeRecipeItem(itemId: string) {
    setRecipeDraftItems((current) => current.filter((item) => item.id !== itemId));
  }

  async function saveRecipe() {
    if (!selectedProduct || !isCurrentRecipe || !recipeDraftDirty) return;
    const invalidItem = recipeDraftItems.find((item) => {
      const ingredient = state.ingredients.find((entry) => entry.id === item.ingredientId);
      return !ingredient || recipeItemCost(item, ingredient) === undefined;
    });
    if (invalidItem) { window.alert("Không thể lưu vì có nguyên liệu không tồn tại, thiếu giá hoặc sai nhóm đơn vị."); return; }
    const now = new Date().toISOString();
    const effectiveFrom = now.slice(0, 10);
    const version: RecipeVersion = { id: crypto.randomUUID(), productId: selectedProduct.id, version: Math.max(0, ...state.recipeVersions.filter((entry) => entry.productId === selectedProduct.id).map((entry) => entry.version)) + 1, effectiveFrom, status: "active", items: recipeDraftItems.map((item) => ({ ...item, id: crypto.randomUUID() })), createdAt: now };
    const cost = recipeVersionCost(version, state.ingredients, selectedProduct.packagingCost);
    const margin = cost !== undefined && selectedProduct.sellingPrice ? (selectedProduct.sellingPrice - cost) / selectedProduct.sellingPrice * 100 : 0;
    try { if (!uatMode) await saveCloudRecipe(version, selectedProduct.storeId, recipeDraftSourceId || undefined); }
    catch (error) { window.alert(error instanceof Error ? error.message : "Không thể lưu công thức."); return; }
    setState((current) => ({
      ...current,
      recipeVersions: [version, ...current.recipeVersions.map((entry) => entry.productId === selectedProduct.id && entry.status === "active" ? { ...entry, status: "archived" as const, effectiveTo: effectiveFrom } : entry)],
      products: current.products.map((entry) => entry.id === selectedProduct.id ? { ...entry, status: "active", updatedAt: now } : entry),
      costSnapshots: cost === undefined ? current.costSnapshots : [{ id: crypto.randomUUID(), productId: selectedProduct.id, recipeVersionId: version.id, effectiveFrom, sellingPrice: selectedProduct.sellingPrice, theoreticalCost: cost, grossMarginPercent: margin, createdAt: now }, ...current.costSnapshots],
      auditEvents: [auditEvent("recipe", version.id, "save", `Lưu công thức v${version.version}${recipeDraftSourceId ? ` thay v${current.recipeVersions.find((entry) => entry.id === recipeDraftSourceId)?.version || "cũ"}` : ""}`), ...current.auditEvents],
    }));
    setSelectedRecipeVersionId(version.id);
    setRecipeDraftSourceId(version.id);
    setRecipeDraftItems(version.items.map((item) => ({ ...item })));
  }

  function replaceIngredient(issue: StockIssue) {
    const replacementId = replacementSelection[issue.key] || issue.candidates[0]?.id;
    const replacement = state.ingredients.find((ingredient) => ingredient.id === replacementId);
    if (!replacement) return;
    const source = activeRecipeVersion(issue.product.id, state.recipeVersions);
    if (!source) return;
    const sourceItems = recipeDraftProductId === issue.product.id ? recipeDraftItems : source.items;
    startRecipeDraft(issue.product.id, sourceItems.map((item) => item.ingredientId === issue.ingredient.id ? { ...item, ingredientId: replacement.id, wastePercent: replacement.standardWastePercent } : item));
    setSelectedProductId(issue.product.id);
    setTab("products");
    setInlineReplacementKey("");
  }

  function openDetail(product: ProductMaster, nextTab: DetailTab = "summary") {
    setSelectedProductId(product.id);
    startRecipeDraft(product.id);
    setDetailTab(nextTab);
    setRecipeCategory("");
    setRecipeIngredientId("");
  }

  return <section className={styles.module}>
    <header className={styles.hero}>
      <div><span className={styles.eyebrow}>SẢN PHẨM · {uatMode ? "UAT LOCAL" : "PRODUCTION"}</span><h1>Sản phẩm, giá vốn và sức bán trong một nơi.</h1><p>Công thức luôn soi chiếu trực tiếp với tồn Kho NVL để biết món nào đang bán được và ước tính làm được bao nhiêu ly.</p></div>
      <div className={styles.logo}><Image src="/nha-coffee-logo-transparent.png" alt="Nhà Coffee & Tea" width={750} height={420} priority /></div>
      <div className={styles.heroMetric}><span>SKU đang dùng</span><strong>{activeProducts.length}/{state.products.length}</strong><small>{stockIssues.length} công thức cần thay NVL · {numberLabel(totalEstimatedServings, 0)} ly ước tính</small></div>
    </header>

    {uatMode ? <div className={styles.uatBanner}><span><b>UAT LOCAL</b> · Dữ liệu Sản phẩm chỉ lưu trong trình duyệt này.</span><div><button onClick={syncSources}>Đồng bộ Kho</button><button onClick={loadCompleteSample}>Mẫu hoàn chỉnh</button><button onClick={resetUat}>Reset</button></div></div> : <div className={styles.uatBanner}><span><b>PRODUCTION</b> · SKU và công thức được lưu dùng chung trên Supabase.</span><div><button onClick={syncSources}>Đồng bộ dữ liệu</button></div></div>}

    <nav className={styles.tabs} aria-label="Sản phẩm">
      <button className={tab === "overview" ? styles.active : ""} onClick={() => setTab("overview")}>Tổng quan</button>
      <button className={tab === "queue" ? styles.active : ""} onClick={() => setTab("queue")}>Chờ xử lý {stockIssues.length > 0 && <span>{stockIssues.length}</span>}</button>
      <button className={tab === "products" ? styles.active : ""} onClick={() => setTab("products")}>Sản phẩm & Giá vốn</button>
    </nav>

    <div className={styles.content}>
      {tab === "overview" && <>
        <div className={styles.pageIntro}><div><span>PRODUCT INTELLIGENCE</span><h2>Dashboard sản phẩm</h2><p>Kết hợp công thức, giá vốn, tồn Kho NVL và báo cáo Mặt hàng đã import ở Tài Chính.</p></div><button onClick={syncSources}>Cập nhật dữ liệu</button></div>
        <section className={styles.dashboardKpis}>
          <article className={styles.primaryKpi}><span>GIÁ VỐN TRUNG BÌNH</span><strong>{productCostMetrics.length ? money(averageProductCost) : "Chưa đủ dữ liệu"}</strong><small>Tính trên {productCostMetrics.length}/{state.products.length} SKU có công thức</small></article>
          <article><span>BIÊN GỘP TRUNG BÌNH</span><strong>{percent(averageMargin)}</strong><small>Theo giá bán hiện tại</small></article>
          <article><span>ĐỦ GIÁ VỐN</span><strong>{productCostMetrics.length}/{state.products.length}</strong><small>SKU tính được theoretical COGS</small></article>
          <article className={stockIssues.length ? styles.alertKpi : ""}><span>CẦN THAY NVL</span><strong>{stockIssues.length}</strong><small>Công thức đang tham chiếu NVL hết kho</small></article>
          <article><span>CÔNG SUẤT ƯỚC TÍNH</span><strong>{numberLabel(totalEstimatedServings, 0)} ly</strong><small>{inStockIngredients.length}/{state.ingredients.length} NVL còn tồn kín</small></article>
        </section>

        <section className={styles.costDashboard}>
          <article className={styles.dashboardPanel}><div className={styles.panelTitle}><div><span>TOP 5 GIÁ VỐN CAO</span><h3>Sản phẩm cost cao nhất</h3></div></div>{highestCostProducts.length ? <div className={styles.costChart}>{highestCostProducts.map((entry, index) => <button key={entry.product.id} onClick={() => openDetail(entry.product)}><span><i>{index + 1}</i><b>{entry.product.name}</b></span><strong>{money(entry.cost)}</strong><em><i style={{ width: `${entry.cost / Math.max(1, highestCostProducts[0].cost) * 100}%` }} /></em></button>)}</div> : <div className={styles.panelEmpty}>Chưa có sản phẩm đủ công thức.</div>}</article>
          <article className={styles.dashboardPanel}><div className={styles.panelTitle}><div><span>TOP 5 GIÁ VỐN THẤP</span><h3>Sản phẩm cost thấp nhất</h3></div></div>{lowestCostProducts.length ? <div className={styles.costChart}>{lowestCostProducts.map((entry, index) => <button key={entry.product.id} onClick={() => openDetail(entry.product)}><span><i>{index + 1}</i><b>{entry.product.name}</b></span><strong>{money(entry.cost)}</strong><em><i style={{ width: `${entry.cost / Math.max(1, ...lowestCostProducts.map((item) => item.cost)) * 100}%` }} /></em></button>)}</div> : <div className={styles.panelEmpty}>Chưa có sản phẩm đủ công thức.</div>}</article>
        </section>

        <section className={styles.financeDashboard}>
          <div className={styles.financeDashboardHead}><div><span>FINANCE · MẶT HÀNG</span><h2>Hiệu suất bán hàng</h2></div><p>{productsImport ? `${productsImport.fileName} · ${dateLabel(productsImport.periodStart)}–${dateLabel(productsImport.periodEnd)}` : "Import Báo cáo Mặt hàng ở Tài Chính để hiển thị dữ liệu thật."}</p></div>
          <div className={styles.financeGrid}>
            <article className={styles.dashboardPanel}><div className={styles.panelTitle}><div><span>TOP MẶT HÀNG</span><h3>Theo tổng tiền</h3></div></div>{topFinanceProducts.length ? <div className={styles.rankList}>{topFinanceProducts.map((entry, index) => <div key={`${entry.sku}-${entry.variant || "base"}`}><i>{index + 1}</i><span><b>{entry.name}{entry.variant ? ` · ${entry.variant}` : ""}</b><small>{entry.category} · {numberLabel(entry.quantity || 0, 0)} SP</small></span><strong>{money(entry.totalAmount || 0)}</strong></div>)}</div> : <div className={styles.panelEmpty}>Chưa import Báo cáo Mặt hàng.</div>}</article>
            <article className={styles.dashboardPanel}><div className={styles.panelTitle}><div><span>TOP DANH MỤC</span><h3>Theo doanh thu mặt hàng</h3></div></div>{financeCategories.length ? <div className={styles.categoryBars}>{financeCategories.map((entry) => <div key={entry.name}><div><span><b>{entry.name}</b><small>{numberLabel(entry.quantity, 0)} SP · {entry.skuCount} SKU</small></span><strong>{money(entry.revenue)}</strong></div><div><i style={{ width: `${entry.revenue / Math.max(1, financeCategories[0].revenue) * 100}%` }} /></div></div>)}</div> : <div className={styles.panelEmpty}>Chưa có dữ liệu danh mục.</div>}</article>
          </div>
        </section>
      </>}

      {tab === "queue" && <>
        <div className={styles.pageIntro}><div><span>RECIPE ALERTS</span><h2>Công thức cần cập nhật</h2><p>Nguyên liệu hết kho được flag tự động. Chọn NVL thay thế cùng category; hệ thống ưu tiên món còn tồn lâu nhất theo FIFO.</p></div><button onClick={syncSources}>Đồng bộ lại Kho</button></div>
        {!stockIssues.length ? <div className={styles.empty}><b>Không có công thức cần thay nguyên liệu</b><span>Khi một NVL trong công thức hết tồn, cảnh báo sẽ tự xuất hiện tại đây.</span></div> : <div className={styles.queueList}>{stockIssues.map((issue) => <article className={styles.queueCard} key={issue.key}>
          <div className={styles.queueProblem}><span>{issue.ingredient.category}</span><h3>{issue.product.name}</h3><p>Công thức v{issue.version.version} đang dùng <b>{issue.ingredient.name} · {issue.ingredient.brand}</b></p></div>
          <div className={styles.outBadge}><span>TRẠNG THÁI</span><strong>Hết kho</strong><small>{issue.ingredient.code}</small></div>
          {issue.candidates.length ? <label>NVL thay thế cùng category<select value={replacementSelection[issue.key] || issue.candidates[0].id} onChange={(event) => setReplacementSelection((current) => ({ ...current, [issue.key]: event.target.value }))}>{issue.candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name} · {candidate.brand} · còn {numberLabel(candidate.stockQuantityBase)} {candidate.baseUnit} · tồn từ {dateLabel(candidate.oldestInStockPurchasedOn)}</option>)}</select><small>Mặc định chọn NVL còn tồn có ngày nhập cũ nhất, không chọn lô mới nhất.</small></label> : <div className={styles.noReplacement}><b>Chưa có NVL thay thế cùng category</b><span>Hãy nhập thêm {issue.ingredient.category} ở Kho NVL rồi đồng bộ lại.</span></div>}
          <div className={styles.queueActions}><button onClick={() => openDetail(issue.product, "recipe")}>Xem công thức</button><button className={styles.primary} disabled={!issue.candidates.length} onClick={() => replaceIngredient(issue)}>Chỉnh thay thế</button></div>
        </article>)}</div>}
      </>}

      {tab === "products" && <>
        <div className={styles.pageIntro}><div><span>PRODUCT & COGS</span><h2>Sản phẩm và giá vốn</h2><p>Giá bán, công thức, giá vốn, biên gộp và công suất ước tính được quản lý trên cùng một SKU.</p></div><button onClick={() => openProduct()}>+ Thêm SKU</button></div>
        <div className={styles.toolbar}><label className={styles.search}><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm SKU, sản phẩm, category..." /></label></div>
        {!loaded ? <div className={styles.empty}>Đang tải sản phẩm...</div> : !filteredProducts.length ? <div className={styles.empty}>Không có SKU phù hợp.</div> : <>
          <div className={styles.productTable}><div className={styles.tableHead}><span>SKU / Sản phẩm</span><span>Giá bán</span><span>Giá vốn</span><span>Biên gộp</span><span>Ước tính</span></div>{filteredProducts.map((product) => { const cost = theoreticalProductCost(product, state.recipeVersions, state.ingredients); const margin = cost !== undefined && product.sellingPrice ? (product.sellingPrice - cost) / product.sellingPrice * 100 : undefined; const capacity = capacityEstimate(activeRecipeVersion(product.id, state.recipeVersions), state.ingredients); return <button className={styles.tableRow} onClick={() => openDetail(product)} key={product.id}><span><b>{product.sku}</b><strong>{product.name}</strong><small>{product.category}</small></span><span>{money(product.sellingPrice)}</span><span>{cost === undefined ? "Chưa đủ" : money(cost)}</span><span className={margin !== undefined && margin < 55 ? styles.negative : ""}>{percent(margin)}</span><span>{capacity ? `${numberLabel(capacity.servings, 0)} ly` : "-"}</span></button>; })}</div>
          <div className={styles.productCards}>{filteredProducts.map((product) => { const cost = theoreticalProductCost(product, state.recipeVersions, state.ingredients); const margin = cost !== undefined && product.sellingPrice ? (product.sellingPrice - cost) / product.sellingPrice * 100 : undefined; const capacity = capacityEstimate(activeRecipeVersion(product.id, state.recipeVersions), state.ingredients); const errors = productValidationErrors(product, state.recipeVersions, state.ingredients); return <button className={styles.productCard} onClick={() => openDetail(product)} key={product.id}><div><span>{product.sku}</span><small>AUTO ACTIVE</small></div><h3>{product.name}</h3><p>{product.category} · {product.source === "import" ? "Từ Finance" : "Khai báo tay"}</p><div className={styles.moneyGrid}><div><span>Giá bán</span><strong>{money(product.sellingPrice)}</strong></div><div><span>Giá vốn</span><strong>{cost === undefined ? "Chưa đủ" : money(cost)}</strong></div><div><span>Biên gộp</span><strong>{percent(margin)}</strong></div><div><span>Ước tính</span><strong>{capacity ? `${numberLabel(capacity.servings, 0)} ly` : "-"}</strong></div></div>{errors.length > 0 && <small className={styles.issueLine}>{errors.length} điểm cần xử lý · {errors[0]}</small>}</button>; })}</div>
        </>}
      </>}
    </div>

    {selectedProduct && <div className={styles.detailBackdrop} onMouseDown={() => setSelectedProductId("")}><aside className={styles.detailPanel} onMouseDown={(event) => event.stopPropagation()}>
      <div className={styles.detailHeader}><div><span>{selectedProduct.sku}</span><h2>{selectedProduct.name}</h2><p>{selectedProduct.category} · {selectedProduct.source === "import" ? "Nguồn Finance" : "Khai báo tay"}</p></div><button onClick={() => setSelectedProductId("")}>×</button></div>
      <div className={styles.detailStatus}><i className={styles.autoActive}>SKU AUTO ACTIVE</i><span>{selectedProductErrors.length ? `${selectedProductErrors.length} điểm cần xử lý` : "Đủ dữ liệu"}</span><b>{selectedProductCost === undefined ? "Chưa có giá vốn" : `${money(selectedProductCost)} · Biên ${percent(selectedProductMargin)}`}</b></div>
      <nav className={styles.detailTabs}><button className={detailTab === "summary" ? styles.active : ""} onClick={() => setDetailTab("summary")}>Tổng quan</button><button className={detailTab === "recipe" ? styles.active : ""} onClick={() => setDetailTab("recipe")}>Công thức & NVL</button><button className={detailTab === "history" ? styles.active : ""} onClick={() => setDetailTab("history")}>Lịch sử</button></nav>
      <div className={styles.detailBody}>
        {detailTab === "summary" && <>
          <div className={styles.detailMetrics}><div><span>Giá bán</span><strong>{money(selectedProduct.sellingPrice)}</strong></div><div><span>Giá vốn</span><strong>{selectedProductCost === undefined ? "Chưa đủ" : money(selectedProductCost)}</strong></div><div><span>Biên gộp</span><strong className={selectedProductMargin !== undefined && selectedProductMargin < 55 ? styles.negative : ""}>{percent(selectedProductMargin)}</strong></div><div><span>Công thức</span><strong>{activeRecipeVersion(selectedProduct.id, state.recipeVersions) ? `v${activeRecipeVersion(selectedProduct.id, state.recipeVersions)?.version}` : "Chưa lưu"}</strong></div></div>
          <section className={styles.estimateCard}><div><span>ƯỚC TÍNH</span><h3>{selectedCapacity ? `${numberLabel(selectedCapacity.servings, 0)} ly` : "Chưa tính được"}</h3><p>{selectedCapacity?.limiting ? `Giới hạn bởi ${selectedCapacity.limiting.name} · ${selectedCapacity.limiting.brand}` : "Cần hoàn thiện công thức và dữ liệu tồn kho."}</p></div>{selectedCapacity && <div className={styles.capacityRows}>{selectedCapacity.rows.map((row, index) => <div key={`${row.ingredient?.id || "missing"}-${index}`}><span><b>{row.ingredient?.name || "NVL không tồn tại"}</b><small>Cần {numberLabel(row.requiredBase)} {row.ingredient?.baseUnit || ""}/ly · Tồn {numberLabel(row.ingredient?.stockQuantityBase || 0)} {row.ingredient?.baseUnit || ""}</small></span><strong>{numberLabel(row.capacity, 0)} ly</strong></div>)}</div>}</section>
          {selectedProductErrors.length ? <div className={styles.blockerBox}><span>CẦN XỬ LÝ</span>{selectedProductErrors.map((error) => <p key={error}>• {error}</p>)}</div> : <div className={styles.readyBox}><b>SKU đã đủ dữ liệu vận hành.</b><span>Giá vốn và ước tính đang dùng công thức đã lưu cùng tồn Kho NVL hiện tại.</span></div>}
          <div className={styles.aliasBox}><span>ALIAS</span><p>{selectedProduct.aliases.length ? selectedProduct.aliases.join(" · ") : "Chưa có tên thay thế."}</p></div>
          <div className={styles.detailActions}><button onClick={() => openProduct(selectedProduct)}>Sửa thông tin SKU</button></div>
        </>}

        {detailTab === "recipe" && <>
          <div className={styles.recipeToolbar}><label>Phiên bản đã lưu<select value={selectedVersion?.id || ""} onChange={(event) => { setSelectedRecipeVersionId(event.target.value); if (event.target.value === currentRecipe?.id) startRecipeDraft(selectedProduct.id); }}><option value="">Chưa có công thức</option>{selectedVersions.map((version) => <option value={version.id} key={version.id}>v{version.version} · {version.id === currentRecipe?.id ? "hiện hành" : "lưu trữ"} · {dateLabel(version.effectiveFrom)}</option>)}</select></label>{!isCurrentRecipe && <button onClick={() => startRecipeDraft(selectedProduct.id)}>Chỉnh công thức hiện hành</button>}</div>
          <div className={styles.recipeVersionMeta}><span>{currentRecipe ? `Đang chỉnh sửa từ v${currentRecipe.version}` : "Công thức mới"}</span><i className={recipeDraftDirty ? styles.draft : styles.active}>{recipeDraftDirty ? "chưa lưu" : "đã lưu"}</i><b>{recipeVersionCost({ id: "draft", productId: selectedProduct.id, version: 0, effectiveFrom: "", status: "active", createdAt: "", items: recipeItems }, state.ingredients, selectedProduct.packagingCost) === undefined ? "Chưa tính được" : money(recipeVersionCost({ id: "draft", productId: selectedProduct.id, version: 0, effectiveFrom: "", status: "active", createdAt: "", items: recipeItems }, state.ingredients, selectedProduct.packagingCost) || 0)}</b></div>
          <div className={styles.recipeList}>{recipeItems.length ? recipeItems.map((item) => { const ingredient = state.ingredients.find((entry) => entry.id === item.ingredientId); const cost = recipeItemCost(item, ingredient); const required = ingredient ? convertToBase(item.quantity, item.unit, ingredient.baseUnit) : undefined; const itemCapacity = ingredient && required ? Math.floor(ingredient.stockQuantityBase / (required * (1 + item.wastePercent / 100))) : 0; const issue = ingredient && ingredient.stockQuantityBase <= 0 ? { key: `${selectedProduct.id}-${ingredient.id}`, product: selectedProduct, version: currentRecipe || { id: "", productId: selectedProduct.id, version: 0, effectiveFrom: "", status: "active" as const, createdAt: "", items: recipeItems }, ingredient, candidates: sortIngredientsForUse(state.ingredients.filter((candidate) => candidate.id !== ingredient.id && candidate.stockQuantityBase > 0 && candidate.category === ingredient.category && sameUnitFamily(ingredient, candidate))) } : undefined; return <div className={styles.recipeItemBlock} key={item.id}><div className={`${styles.recipeRow} ${issue ? styles.recipeOut : ""}`}><span><b>{ingredient ? `${ingredient.name} · ${ingredient.brand}` : "Nguyên liệu đã xóa"}</b><small>{ingredient?.category || "-"} · {item.quantity} {item.unit} · HH {item.wastePercent}% · ước tính {numberLabel(itemCapacity, 0)} ly</small></span><strong>{cost === undefined ? "Thiếu giá" : money(cost)}</strong>{isCurrentRecipe && issue ? <><button className={styles.replaceButton} onClick={() => setInlineReplacementKey((current) => current === issue.key ? "" : issue.key)}>Thay thế</button><button className={styles.deleteButton} onClick={() => removeRecipeItem(item.id)}>Xóa</button></> : isCurrentRecipe && <button className={styles.deleteButton} onClick={() => removeRecipeItem(item.id)}>Xóa</button>}</div>{isCurrentRecipe && issue && inlineReplacementKey === issue.key && <div className={styles.inlineReplacement}><div><span>THAY NGUYÊN LIỆU / THƯƠNG HIỆU</span><b>{issue.ingredient.category}</b></div>{issue.candidates.length ? <><select value={replacementSelection[issue.key] || issue.candidates[0].id} onChange={(event) => setReplacementSelection((current) => ({ ...current, [issue.key]: event.target.value }))}>{issue.candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name} · {candidate.brand} · còn {numberLabel(candidate.stockQuantityBase)} {candidate.baseUnit} · tồn từ {dateLabel(candidate.oldestInStockPurchasedOn)}</option>)}</select><button onClick={() => replaceIngredient(issue)}>Thay trong bản nháp</button></> : <p>Chưa có NVL còn tồn cùng category và nhóm đơn vị. Hãy nhập thêm ở Kho NVL.</p>}</div>}</div>; }) : <div className={styles.emptySmall}>Chưa có thành phần. Thêm NVL rồi lưu để tạo công thức đầu tiên.</div>}</div>
          {isCurrentRecipe && <><form className={styles.recipeForm} onSubmit={addRecipeItem}><div className={styles.recipeSelectors}><label>1. Category<select required value={recipeCategory} onChange={(event) => selectRecipeCategory(event.target.value)}><option value="">Chọn category</option>{ingredientCategories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label><label>2. Nguyên liệu / thương hiệu<select required disabled={!recipeCategory} value={recipeIngredientId} onChange={(event) => selectRecipeIngredient(event.target.value)}><option value="">Chọn nguyên liệu</option>{recipeCandidates.map((ingredient) => <option value={ingredient.id} key={ingredient.id}>{ingredient.name} · {ingredient.brand} · {ingredient.stockQuantityBase > 0 ? `còn ${numberLabel(ingredient.stockQuantityBase)} ${ingredient.baseUnit}` : "hết kho"}</option>)}</select><small>Ưu tiên mặc định: còn kho và tồn lâu nhất.</small></label></div><div><label>Định lượng<input required min="0.001" step="0.001" type="number" value={recipeQuantity} onChange={(event) => setRecipeQuantity(event.target.value)} /></label><label>Đơn vị<select value={recipeUnit} onChange={(event) => setRecipeUnit(event.target.value)}>{allowedRecipeUnits.map((unit) => <option key={unit}>{unit}</option>)}</select></label><label>Hao hụt %<input min="0" step="0.1" type="number" value={recipeWaste} onChange={(event) => setRecipeWaste(event.target.value)} /></label></div><button>Thêm nguyên liệu</button></form><button className={styles.saveRecipe} disabled={!recipeDraftDirty} onClick={saveRecipe}>Lưu công thức{currentRecipe ? ` thành v${currentRecipe.version + 1}` : ""}</button></>}
        </>}

        {detailTab === "history" && <div className={styles.historyList}>{state.auditEvents.filter((event) => event.entityId === selectedProduct.id || state.recipeVersions.some((version) => version.productId === selectedProduct.id && version.id === event.entityId)).length ? state.auditEvents.filter((event) => event.entityId === selectedProduct.id || state.recipeVersions.some((version) => version.productId === selectedProduct.id && version.id === event.entityId)).map((event) => <div key={event.id}><span><b>{event.action}</b><small>{event.detail}</small></span><time>{new Date(event.createdAt).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })}</time></div>) : <div className={styles.emptySmall}>Chưa có lịch sử cho SKU này.</div>}</div>}
      </div>
    </aside></div>}

    {showProductForm && <div className={styles.backdrop} onMouseDown={() => setShowProductForm(false)}><form className={styles.sheet} onSubmit={saveProduct} onMouseDown={(event) => event.stopPropagation()}><div className={styles.handle} /><div className={styles.sheetTitle}><div><span>SẢN PHẨM</span><h2>{editingProductId ? "Sửa sản phẩm" : "Thêm sản phẩm"}</h2></div><button type="button" onClick={() => setShowProductForm(false)}>×</button></div><div className={styles.formRow}><label className={styles.field}>Mã SKU *<input required value={productForm.sku} onChange={(event) => setProductForm((current) => ({ ...current, sku: event.target.value }))} /></label><label className={styles.field}>Category<input value={productForm.category} onChange={(event) => setProductForm((current) => ({ ...current, category: event.target.value }))} /></label></div><label className={styles.field}>Tên sản phẩm *<input required value={productForm.name} onChange={(event) => setProductForm((current) => ({ ...current, name: event.target.value }))} /></label><label className={styles.field}>Alias, cách nhau bằng dấu phẩy<input value={productForm.aliases} onChange={(event) => setProductForm((current) => ({ ...current, aliases: event.target.value }))} placeholder="CF sữa, Cafe Sua Nhà" /></label><div className={styles.formRow}><label className={styles.field}>Giá bán<input inputMode="numeric" value={productForm.sellingPrice} onChange={(event) => setProductForm((current) => ({ ...current, sellingPrice: amountInput(event.target.value) }))} /></label><label className={styles.field}>Chi phí bao bì<input inputMode="numeric" value={productForm.packagingCost} onChange={(event) => setProductForm((current) => ({ ...current, packagingCost: amountInput(event.target.value) }))} /></label></div><button className={styles.saveButton}>Lưu sản phẩm</button></form></div>}
  </section>;
}

"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_STORE,
  type ImportedProductSource,
  type IngredientMaster,
  type InventorySourceLot,
  type MasterDataState,
  type ProductMaster,
  type ProductRecipeItem,
  type RecipeVersion,
  activeRecipeVersion,
  auditEvent,
  convertToBase,
  emptyMasterDataState,
  mergeInventoryDrafts,
  mergeProductDrafts,
  normalizeMasterDataState,
  normalizedText,
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
type ProductForm = { sellingPrice: string; packagingCost: string };
type CapacityRow = { ingredient?: IngredientMaster; requiredBase: number; capacity: number };
type CapacityEstimate = { servings: number; limiting?: IngredientMaster; rows: CapacityRow[] };
type StockIssue = { key: string; product: ProductMaster; version: RecipeVersion; ingredient: IngredientMaster; candidates: IngredientMaster[] };
type ProductQueueEntry = { product: ProductMaster; errors: string[]; stockIssues: StockIssue[] };
type ProductCostMetric = { product: ProductMaster; cost: number; margin?: number };
type FinanceCategoryMetric = { name: string; revenue: number; quantity: number; skuCount: number };

const MASTER_UAT_STORAGE_KEY = "nha-ops-master-data-uat-v5";
const MASTER_UAT_RESET_KEY = "nha-ops-master-data-uat-v5-reset-20260812";
const MASTER_LEGACY_UAT_STORAGE_KEYS = ["nha-ops-master-data-uat-v4", "nha-ops-master-data-uat-v3", "nha-ops-master-data-uat-v2", "nha-ops-master-data-uat-v1"];
const FINANCE_UAT_STORAGE_KEY = "nha-ops-finance-uat-v2";

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

function purchaseMonthLabel(value?: string) {
  if (!value) return "chưa rõ tháng";
  const [year, month] = value.slice(0, 10).split("-");
  return year && month ? `${Number(month)}/${year}` : value;
}

function ingredientChoiceLabel(ingredient: IngredientMaster) {
  return `${ingredient.name} - ${ingredient.brand} - ${purchaseMonthLabel(ingredient.latestPurchasedOn)}`;
}

function amountInput(value: number | string) {
  const digits = String(value).replace(/\D/g, "");
  return digits ? Number(digits).toLocaleString("en-US") : "";
}

function parseAmount(value: string) {
  return Number(value.replace(/\D/g, "")) || 0;
}

function productDefaults(): ProductForm {
  return { sellingPrice: "", packagingCost: "" };
}

function legacyNumericPrice(value?: string) {
  if (!value || !/^[\d.,\s]+$/.test(value)) return 0;
  return Number(value.replace(/\D/g, "")) || 0;
}

function normalizeFinanceProduct(product: ImportedProductSource): ImportedProductSource {
  const legacyPrice = legacyNumericPrice(product.variant);
  const sellingPrice = Number(product.sellingPrice) || legacyPrice || (product.quantity && product.totalAmount ? product.totalAmount / product.quantity : 0);
  return { ...product, variant: legacyPrice ? "" : product.variant, sellingPrice: Math.max(0, Math.round(sellingPrice)) };
}

function readFinanceLocalState(): FinanceLocalState {
  try {
    const stored = JSON.parse(window.localStorage.getItem(FINANCE_UAT_STORAGE_KEY) || "{}") as FinanceLocalState;
    return { ...stored, products: (stored.products || []).map(normalizeFinanceProduct) };
  }
  catch { return {}; }
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

function conversionUnitForRecipe(ingredient: IngredientMaster | undefined, uatMode: boolean) {
  // UAT recipes must use the unit explicitly declared in Kho NVL's Quy đổi field.
  return ingredient?.conversionUnit || (!uatMode ? ingredient?.baseUnit : undefined);
}

function ingredientIsAvailable(ingredient: IngredientMaster | undefined) {
  return Boolean(ingredient && ingredient.status === "active" && ingredient.stockQuantityBase > 0);
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
  const products = mergeProductDrafts(state.products, finance.products || []);
  const productIds = new Set(products.map((product) => product.id));
  const importBatches = [...state.importBatches];
  for (const imported of finance.importHistory || finance.imports || []) {
    const id = `finance-${imported.dataType}-${imported.importedAt}`;
    if (!importBatches.some((batch) => batch.id === id)) importBatches.push({ id, storeId: DEFAULT_STORE.id, ...imported, status: "completed" });
  }
  return {
    ...state,
    ingredients: mergeInventoryDrafts(state.ingredients, inventoryLots),
    products,
    recipeVersions: state.recipeVersions.filter((version) => productIds.has(version.productId)),
    costSnapshots: state.costSnapshots.filter((snapshot) => productIds.has(snapshot.productId)),
    auditEvents: state.auditEvents.filter((event) => event.entityType === "ingredient" || productIds.has(event.entityId) || state.recipeVersions.some((version) => productIds.has(version.productId) && version.id === event.entityId)),
    importBatches,
  };
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
  const [recipePickerOpen, setRecipePickerOpen] = useState(false);
  const recipePickerRef = useRef<HTMLDivElement>(null);
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
        setLoaded(true);
      }).catch((error: unknown) => {
        if (!cancelled) { window.alert(error instanceof Error ? error.message : "Không thể tải Sản phẩm từ Supabase."); setLoaded(true); }
      });
      return () => { cancelled = true; };
    }
    let current = emptyMasterDataState();
    try {
      const resetComplete = window.localStorage.getItem(MASTER_UAT_RESET_KEY) === "1";
      const stored = resetComplete ? window.localStorage.getItem(MASTER_UAT_STORAGE_KEY) : null;
      current = normalizeMasterDataState(stored ? JSON.parse(stored) : null);
      if (!resetComplete) {
        MASTER_LEGACY_UAT_STORAGE_KEYS.forEach((key) => window.localStorage.removeItem(key));
        window.localStorage.removeItem(MASTER_UAT_STORAGE_KEY);
        window.localStorage.setItem(MASTER_UAT_RESET_KEY, "1");
      }
    } catch { current = emptyMasterDataState(); }
    setFinanceSnapshot(readFinanceLocalState());
    setState(mergeSourceData(current, inventoryLots));
    setLoaded(true);
  }, [inventoryLots, uatMode]);

  useEffect(() => {
    if (loaded && uatMode) window.localStorage.setItem(MASTER_UAT_STORAGE_KEY, JSON.stringify(state));
  }, [state, loaded, uatMode]);

  useEffect(() => {
    if (!recipePickerOpen) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!recipePickerRef.current?.contains(event.target as Node)) setRecipePickerOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setRecipePickerOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [recipePickerOpen]);

  const selectableIngredients = state.ingredients.filter(ingredientIsAvailable);
  const ingredientCategories = useMemo(() => [...new Set(selectableIngredients.map((ingredient) => ingredient.category).filter(Boolean))].sort((left, right) => left.localeCompare(right, "vi")), [selectableIngredients]);
  const activeProducts = state.products;
  const availableIngredients = state.ingredients.filter(ingredientIsAvailable);
  const filteredProducts = useMemo(() => state.products.filter((product) => normalizedText(`${product.sku} ${product.name} ${product.category}`).includes(normalizedText(search))), [state.products, search]);
  const productGroups = useMemo(() => {
    const groups = new Map<string, ProductMaster[]>();
    for (const product of filteredProducts) {
      const category = product.category.trim() || "Chưa phân loại";
      groups.set(category, [...(groups.get(category) || []), product]);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "vi"));
  }, [filteredProducts]);
  const selectedProduct = state.products.find((product) => product.id === selectedProductId);
  const selectedVersions = state.recipeVersions.filter((version) => version.productId === selectedProductId).sort((a, b) => b.version - a.version);
  const currentRecipe = activeRecipeVersion(selectedProductId, state.recipeVersions);
  const selectedVersion = selectedVersions.find((version) => version.id === selectedRecipeVersionId) || currentRecipe;
  const isCurrentRecipe = !selectedVersion || selectedVersion.id === currentRecipe?.id;
  const recipeItems = isCurrentRecipe && recipeDraftProductId === selectedProductId ? recipeDraftItems : selectedVersion?.items || [];
  const recipeDraftDirty = recipeDraftProductId === selectedProductId && JSON.stringify(recipeDraftItems) !== JSON.stringify(currentRecipe?.items || []);
  const recipeHasUnsavedChanges = recipeDraftDirty || Boolean(recipeQuantity.trim());
  const selectedProductErrors = selectedProduct ? productValidationErrors(selectedProduct, state.recipeVersions, state.ingredients) : [];
  const selectedProductCost = selectedProduct ? theoreticalProductCost(selectedProduct, state.recipeVersions, state.ingredients) : undefined;
  const selectedProductMargin = selectedProductCost !== undefined && selectedProduct?.sellingPrice ? (selectedProduct.sellingPrice - selectedProductCost) / selectedProduct.sellingPrice * 100 : undefined;
  const selectedVersionCosts = useMemo(() => selectedVersions.slice().reverse().map((version) => ({ version, cost: recipeVersionCost(version, state.ingredients, selectedProduct?.packagingCost || 0) })), [selectedVersions, state.ingredients, selectedProduct?.packagingCost]);
  const selectedCapacity = capacityEstimate(isCurrentRecipe ? { ...(currentRecipe || { id: "", productId: selectedProductId, version: 0, effectiveFrom: "", status: "active" as const, createdAt: "" }), items: recipeItems } : selectedVersion, state.ingredients);
  const recipeCandidates = sortIngredientsForUse(selectableIngredients.filter((ingredient) => !recipeCategory || ingredient.category === recipeCategory)).sort((left, right) => Number(Boolean(conversionUnitForRecipe(right, uatMode))) - Number(Boolean(conversionUnitForRecipe(left, uatMode))));
  const selectedRecipeIngredient = state.ingredients.find((ingredient) => ingredient.id === recipeIngredientId);
  const allowedRecipeUnits = conversionUnitForRecipe(selectedRecipeIngredient, uatMode) ? [conversionUnitForRecipe(selectedRecipeIngredient, uatMode)!] : [];

  const stockIssues = useMemo<StockIssue[]>(() => {
    const issues = new Map<string, StockIssue>();
    for (const product of state.products) {
      const version = activeRecipeVersion(product.id, state.recipeVersions);
      if (!version) continue;
      for (const item of version.items) {
        const ingredient = state.ingredients.find((entry) => entry.id === item.ingredientId);
        if (!ingredient || ingredientIsAvailable(ingredient)) continue;
        const key = `${product.id}-${ingredient.id}`;
        const candidates = sortIngredientsForUse(state.ingredients.filter((candidate) => candidate.id !== ingredient.id && ingredientIsAvailable(candidate) && candidate.category === ingredient.category && sameUnitFamily(ingredient, candidate)));
        issues.set(key, { key, product, version, ingredient, candidates });
      }
    }
    return [...issues.values()];
  }, [state]);

  const queueEntries = useMemo<ProductQueueEntry[]>(() => state.products.flatMap((product) => {
    const errors = productValidationErrors(product, state.recipeVersions, state.ingredients);
    const productStockIssues = stockIssues.filter((issue) => issue.product.id === product.id);
    if (!errors.length && !productStockIssues.length) return [];
    return [{ product, errors, stockIssues: productStockIssues }];
  }), [state.products, state.recipeVersions, state.ingredients, stockIssues]);
  const queueGroups = useMemo(() => {
    const groups = new Map<string, ProductQueueEntry[]>();
    for (const entry of queueEntries) groups.set(entry.product.category || "Chưa phân loại", [...(groups.get(entry.product.category || "Chưa phân loại") || []), entry]);
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "vi"));
  }, [queueEntries]);

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

  function resetUat() {
    if (!window.confirm("Xóa dữ liệu Sản phẩm UAT và đồng bộ lại Kho NVL/Finance?")) return;
    setState(mergeSourceData(emptyMasterDataState(), inventoryLots));
    setSelectedProductId("");
    setSelectedRecipeVersionId("");
    setTab("queue");
  }

  function openProduct(product: ProductMaster) {
    setEditingProductId(product.id);
    setProductForm({ sellingPrice: amountInput(product.sellingPrice), packagingCost: amountInput(product.packagingCost) });
    setShowProductForm(true);
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const existing = state.products.find((product) => product.id === editingProductId);
    if (!existing) return;
    const product: ProductMaster = { ...existing, sellingPrice: parseAmount(productForm.sellingPrice), sellingPriceOverridden: true, packagingCost: parseAmount(productForm.packagingCost), updatedAt: new Date().toISOString() };
    try {
      if (!uatMode) await saveCloudProduct(product);
      setState((current) => ({ ...current, products: current.products.map((entry) => entry.id === existing.id ? product : entry), auditEvents: [auditEvent("product", existing.id, "update", "Cập nhật giá bán/chi phí bao bì"), ...current.auditEvents] }));
    } catch (error) { window.alert(error instanceof Error ? error.message : "Không thể lưu SKU."); return; }
    setShowProductForm(false);
    setSelectedProductId(existing.id);
  }

  function startRecipeDraft(productId: string, items = activeRecipeVersion(productId, state.recipeVersions)?.items || []) {
    const source = activeRecipeVersion(productId, state.recipeVersions);
    setRecipeDraftProductId(productId);
    setRecipeDraftSourceId(source?.id || "");
    setRecipeDraftItems(items.map((item) => ({ ...item })));
    setSelectedRecipeVersionId(source?.id || "");
    setDetailTab("recipe");
    setRecipePickerOpen(false);
  }

  function alertOutOfStockRecipe(productId: string) {
    const version = activeRecipeVersion(productId, state.recipeVersions);
    const ingredients = [...new Map((version?.items || []).flatMap((item) => {
      const ingredient = state.ingredients.find((entry) => entry.id === item.ingredientId);
      return ingredient && !ingredientIsAvailable(ingredient) ? [[ingredient.id, ingredient] as const] : [];
    })).values()];
    if (!ingredients.length) return;
    window.alert(`Công thức đang dùng ${ingredients.length} NVL không còn khả dụng:\n${ingredients.map((ingredient) => `- ${ingredient.name} - ${ingredient.brand}`).join("\n")}\n\nNVL có thể đã hết tồn, đã dùng hết hoặc được ghi nhận hư hỏng. Hãy bấm \"Thay thế\" trước khi lưu công thức mới.`);
  }

  function selectDetailTab(nextTab: DetailTab) {
    setRecipePickerOpen(false);
    setInlineReplacementKey("");
    setDetailTab(nextTab);
    if (nextTab === "recipe" && selectedProductId) alertOutOfStockRecipe(selectedProductId);
  }

  function closeDetail() {
    if (recipeHasUnsavedChanges && !window.confirm("Công thức đang có dữ liệu chưa lưu. Bạn có chắc muốn đóng và bỏ các thay đổi này?")) return;
    setRecipePickerOpen(false);
    setInlineReplacementKey("");
    setSelectedProductId("");
  }

  function selectRecipeVersion(versionId: string) {
    if (versionId === selectedVersion?.id) return;
    if (recipeHasUnsavedChanges && !window.confirm("Đổi phiên bản sẽ bỏ dữ liệu công thức chưa lưu. Bạn có chắc muốn tiếp tục?")) return;
    const source = activeRecipeVersion(selectedProductId, state.recipeVersions);
    setRecipeDraftProductId(selectedProductId);
    setRecipeDraftSourceId(source?.id || "");
    setRecipeDraftItems((source?.items || []).map((item) => ({ ...item })));
    setRecipeQuantity("");
    setSelectedRecipeVersionId(versionId);
  }

  function selectRecipeCategory(category: string) {
    setRecipeCategory(category);
    setRecipePickerOpen(false);
    const preferred = sortIngredientsForUse(selectableIngredients.filter((ingredient) => ingredient.category === category && conversionUnitForRecipe(ingredient, uatMode)))[0];
    setRecipeIngredientId(preferred?.id || "");
    setRecipeUnit(conversionUnitForRecipe(preferred, uatMode) || "");
    setRecipeWaste(String(preferred?.standardWastePercent || 0));
  }

  function selectRecipeIngredient(id: string) {
    const ingredient = state.ingredients.find((entry) => entry.id === id);
    if (!ingredient || !ingredientIsAvailable(ingredient)) {
      setRecipeIngredientId("");
      setRecipeUnit("");
      setRecipePickerOpen(false);
      window.alert("NVL đã hết tồn, đã dùng hết hoặc được ghi nhận hư hỏng. Hãy chọn NVL còn trong kho hoặc đang dùng để thay thế.");
      return;
    }
    setRecipeIngredientId(id);
    setRecipeUnit(conversionUnitForRecipe(ingredient, uatMode) || "");
    setRecipeWaste(String(ingredient?.standardWastePercent || 0));
    setRecipePickerOpen(false);
  }

  function addRecipeItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const quantity = Number(recipeQuantity);
    if (!selectedProduct || !isCurrentRecipe || !recipeIngredientId || quantity <= 0) return;
    const ingredient = state.ingredients.find((entry) => entry.id === recipeIngredientId);
    const conversionUnit = conversionUnitForRecipe(ingredient, uatMode);
    if (!ingredient || !ingredientIsAvailable(ingredient)) {
      setRecipeIngredientId("");
      setRecipeUnit("");
      window.alert("NVL đã hết tồn, đã dùng hết hoặc được ghi nhận hư hỏng. Hãy chọn NVL còn trong kho hoặc đang dùng để thay thế.");
      return;
    }
    if (!ingredient || !conversionUnit || recipeUnit !== conversionUnit) { window.alert("NVL này chưa có Đơn vị quy đổi hợp lệ. Hãy khai báo Quy đổi ở Kho NVL trước khi thêm vào công thức."); return; }
    setRecipeDraftItems((current) => [...current, { id: crypto.randomUUID(), ingredientId: recipeIngredientId, quantity, unit: recipeUnit, wastePercent: Math.max(0, Number(recipeWaste) || 0) }]);
    setRecipeQuantity("");
  }

  function removeRecipeItem(itemId: string) {
    setRecipeDraftItems((current) => current.filter((item) => item.id !== itemId));
  }

  async function saveRecipe() {
    if (!selectedProduct || !isCurrentRecipe || !recipeDraftDirty) return;
    const unavailableItem = recipeDraftItems.find((item) => {
      const ingredient = state.ingredients.find((entry) => entry.id === item.ingredientId);
      return ingredient && !ingredientIsAvailable(ingredient);
    });
    if (unavailableItem) {
      const ingredient = state.ingredients.find((entry) => entry.id === unavailableItem.ingredientId);
      window.alert(`${ingredient?.name || "NVL trong công thức"} không còn khả dụng ở Kho hay Đang dùng. NVL có thể đã dùng hết hoặc hư hỏng; hãy bấm \"Thay thế\" trước khi lưu phiên bản mới.`);
      return;
    }
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
    if (!replacement || !ingredientIsAvailable(replacement)) {
      window.alert("NVL thay thế đã hết tồn, đã dùng hết hoặc được ghi nhận hư hỏng. Hãy chọn NVL còn trong kho hoặc đang dùng.");
      return;
    }
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
    setRecipePickerOpen(false);
    setInlineReplacementKey("");
    setRecipeCategory("");
    setRecipeIngredientId("");
    if (nextTab === "recipe") alertOutOfStockRecipe(product.id);
  }

  return <section className={styles.module}>
    <header className={styles.hero}>
      <div><span className={styles.eyebrow}>SẢN PHẨM · {uatMode ? "UAT LOCAL" : "PRODUCTION"}</span><h1>Sản phẩm & giá vốn</h1></div>
      <div className={styles.logo}><Image src="/nha-coffee-logo-transparent.png" alt="Nhà Coffee & Tea" width={750} height={420} priority /></div>
      <div className={styles.heroMetric}><span>SKU đang dùng</span><strong>{activeProducts.length}/{state.products.length}</strong><small>{queueEntries.length} sản phẩm chờ xử lý · {numberLabel(totalEstimatedServings, 0)} ly ước tính</small></div>
    </header>

    {uatMode ? <div className={styles.uatBanner}><span><b>UAT LOCAL</b> · Danh mục SKU lấy duy nhất từ Tài chính → Doanh thu → Mặt hàng.</span><div><button onClick={syncSources}>Đồng bộ Kho & Mặt hàng</button><button onClick={resetUat}>Reset công thức</button></div></div> : <div className={styles.uatBanner}><span><b>PRODUCTION</b> · SKU, giá bán và category theo báo cáo Mặt hàng; công thức lưu dùng chung trên Supabase.</span><div><button onClick={syncSources}>Đồng bộ dữ liệu</button></div></div>}

    <nav className={styles.tabs} aria-label="Sản phẩm">
      <button className={tab === "overview" ? styles.active : ""} onClick={() => setTab("overview")}>Tổng quan</button>
      <button className={tab === "queue" ? styles.active : ""} onClick={() => setTab("queue")}>Chờ xử lý {queueEntries.length > 0 && <span>{queueEntries.length}</span>}</button>
      <button className={tab === "products" ? styles.active : ""} onClick={() => setTab("products")}>Sản phẩm & Giá vốn</button>
    </nav>

    <div className={styles.content}>
      {tab === "overview" && <>
        <div className={styles.pageIntro}><div><span>PRODUCT INTELLIGENCE</span><h2>Dashboard sản phẩm</h2><p>Kết hợp công thức, giá vốn, tồn Kho NVL và báo cáo Mặt hàng đã import ở Tài Chính.</p></div><button onClick={syncSources}>Cập nhật dữ liệu</button></div>
        <section className={styles.dashboardKpis}>
          <article className={styles.primaryKpi}><span>GIÁ VỐN TRUNG BÌNH</span><strong>{productCostMetrics.length ? money(averageProductCost) : "Chưa đủ dữ liệu"}</strong><small>Tính trên {productCostMetrics.length}/{state.products.length} SKU có công thức</small></article>
          <article><span>BIÊN GỘP TRUNG BÌNH</span><strong>{percent(averageMargin)}</strong><small>Theo giá bán hiện tại</small></article>
          <article><span>ĐỦ GIÁ VỐN</span><strong>{productCostMetrics.length}/{state.products.length}</strong><small>SKU tính được theoretical COGS</small></article>
          <article className={queueEntries.length ? styles.alertKpi : ""}><span>CHỜ XỬ LÝ</span><strong>{queueEntries.length}</strong><small>Thiếu công thức, giá bán hoặc NVL cần rà soát</small></article>
          <article><span>CÔNG SUẤT ƯỚC TÍNH</span><strong>{numberLabel(totalEstimatedServings, 0)} ly</strong><small>{availableIngredients.length}/{state.ingredients.length} NVL khả dụng · Kho + Đang dùng</small></article>
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
        <div className={styles.pageIntro}><div><span>DATA & RECIPE ALERTS</span><h2>Sản phẩm chờ xử lý</h2><p>Gom theo Category của báo cáo Mặt hàng; mỗi SKU chỉ hiện tóm tắt 1–2 dòng để xử lý nhanh.</p></div><button onClick={syncSources}>Đồng bộ lại Kho</button></div>
        {!queueEntries.length ? <div className={styles.empty}><b>Tất cả sản phẩm đã đủ dữ liệu</b><span>Công thức, giá bán và NVL hiện tại đều đã qua kiểm tra.</span></div> : <div className={styles.queueGroups}>{queueGroups.map(([category, entries]) => <section className={styles.categoryGroup} key={category}><div className={styles.categoryHeading}><span>{category}</span><b>{entries.length} SKU</b></div><div className={styles.queueList}>{entries.map((entry) => { const stockIssue = entry.stockIssues[0]; const summary = [!activeRecipeVersion(entry.product.id, state.recipeVersions) ? "Chưa có công thức" : "", entry.stockIssues.length ? `${entry.stockIssues.length} NVL cần thay` : "", entry.product.sellingPrice <= 0 ? "Thiếu giá bán" : ""].filter(Boolean).join(" · ") || `${entry.errors.length} điểm cần xử lý`; return <article className={styles.queueCard} key={entry.product.id}>
          <button className={styles.queueMain} onClick={() => openDetail(entry.product, stockIssue ? "recipe" : "summary")}><span><b>{entry.product.name}{entry.product.variant ? ` · ${entry.product.variant}` : ""}</b><small>{entry.product.sku} · {summary}</small></span><em>›</em></button>
        </article>; })}</div></section>)}</div>}
      </>}

      {tab === "products" && <>
        <div className={styles.pageIntro}><div><span>PRODUCT & COGS</span><h2>Sản phẩm và giá vốn</h2><p>Danh mục và Category đồng bộ từ Tài chính → Doanh thu → Mặt hàng. Không tạo SKU thủ công tại đây.</p></div></div>
        <div className={styles.toolbar}><label className={styles.search}><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm SKU, sản phẩm, category..." /></label></div>
        {!loaded ? <div className={styles.empty}>Đang tải sản phẩm...</div> : !filteredProducts.length ? <div className={styles.empty}>Không có SKU phù hợp.</div> : <>
          <div className={styles.productGroups}>{productGroups.map(([category, products]) => <section className={styles.categoryGroup} key={category}><div className={styles.categoryHeading}><span>{category}</span><b>{products.length} SKU</b></div><div className={styles.productTable}><div className={styles.tableHead}><span>SKU / Sản phẩm</span><span>Giá bán</span><span>Giá vốn</span><span>Biên gộp</span><span>Ước tính</span></div>{products.map((product) => { const cost = theoreticalProductCost(product, state.recipeVersions, state.ingredients); const margin = cost !== undefined && product.sellingPrice ? (product.sellingPrice - cost) / product.sellingPrice * 100 : undefined; const capacity = capacityEstimate(activeRecipeVersion(product.id, state.recipeVersions), state.ingredients); return <button className={styles.tableRow} onClick={() => openDetail(product)} key={product.id}><span><b>{product.sku}</b><strong>{product.name}{product.variant ? ` · ${product.variant}` : ""}</strong></span><span>{money(product.sellingPrice)}{product.sellingPriceOverridden && <small>Chỉnh tay</small>}</span><span>{cost === undefined ? "Chưa đủ" : money(cost)}</span><span className={margin !== undefined && margin < 55 ? styles.negative : ""}>{percent(margin)}</span><span>{capacity ? `${numberLabel(capacity.servings, 0)} ly` : "-"}</span></button>; })}</div><div className={styles.productCards}>{products.map((product) => { const cost = theoreticalProductCost(product, state.recipeVersions, state.ingredients); const margin = cost !== undefined && product.sellingPrice ? (product.sellingPrice - cost) / product.sellingPrice * 100 : undefined; const errors = productValidationErrors(product, state.recipeVersions, state.ingredients); return <button className={styles.productCard} onClick={() => openDetail(product)} key={product.id}><div><span>{product.sku}</span>{product.sellingPriceOverridden && <small>ĐÃ CHỈNH GIÁ</small>}</div><h3>{product.name}{product.variant ? ` · ${product.variant}` : ""}</h3><div className={styles.moneyGrid}><div><span>Giá bán</span><strong>{money(product.sellingPrice)}</strong></div><div><span>Giá vốn</span><strong>{cost === undefined ? "Chưa đủ" : money(cost)}</strong></div><div><span>Biên gộp</span><strong>{percent(margin)}</strong></div></div>{errors.length > 0 && <small className={styles.issueLine}>{errors.length} điểm cần xử lý · {errors[0]}</small>}</button>; })}</div></section>)}</div>
        </>}
      </>}
    </div>

    {selectedProduct && <div className={styles.detailBackdrop} onMouseDown={closeDetail}><aside className={styles.detailPanel} onMouseDown={(event) => event.stopPropagation()}>
      <div className={styles.detailHeader}><div><span>{selectedProduct.sku}{selectedProduct.variant ? ` · ${selectedProduct.variant}` : ""}</span><h2>{selectedProduct.name}</h2><p>{selectedProduct.category} · Từ báo cáo Mặt hàng</p></div><button onClick={closeDetail}>×</button></div>
      <div className={styles.detailStatus}><i className={styles.autoActive}>SKU AUTO ACTIVE</i><span>{selectedProductErrors.length ? `${selectedProductErrors.length} điểm cần xử lý` : "Đủ dữ liệu"}</span><b>{selectedProductCost === undefined ? "Chưa có giá vốn" : `${money(selectedProductCost)} · Biên ${percent(selectedProductMargin)}`}</b></div>
      <nav className={styles.detailTabs}><button className={detailTab === "summary" ? styles.active : ""} onClick={() => selectDetailTab("summary")}>Tổng quan</button><button className={detailTab === "recipe" ? styles.active : ""} onClick={() => selectDetailTab("recipe")}>Công thức & NVL</button><button className={detailTab === "history" ? styles.active : ""} onClick={() => selectDetailTab("history")}>Lịch sử</button></nav>
      <div className={styles.detailBody}>
        {detailTab === "summary" && <>
          <div className={styles.detailMetrics}><div><span>Giá bán</span><strong>{money(selectedProduct.sellingPrice)}</strong><small>{selectedProduct.sellingPriceOverridden ? "Đã chỉnh tay" : "Theo Finance"}</small></div><div><span>Giá vốn hiện hành</span><strong>{selectedProductCost === undefined ? "Chưa đủ" : money(selectedProductCost)}</strong></div><div><span>Biên gộp</span><strong className={selectedProductMargin !== undefined && selectedProductMargin < 55 ? styles.negative : ""}>{percent(selectedProductMargin)}</strong></div><div><span>Công thức</span><strong>{activeRecipeVersion(selectedProduct.id, state.recipeVersions) ? `v${activeRecipeVersion(selectedProduct.id, state.recipeVersions)?.version}` : "Chưa lưu"}</strong></div></div>
          <CostTrendChart points={selectedVersionCosts} />
          <section className={styles.estimateCard}><div><span>ƯỚC TÍNH</span><h3>{selectedCapacity ? `${numberLabel(selectedCapacity.servings, 0)} ly` : "Chưa tính được"}</h3><p>{selectedCapacity?.limiting ? `Giới hạn bởi ${selectedCapacity.limiting.name} · ${selectedCapacity.limiting.brand}` : "Cần hoàn thiện công thức và dữ liệu NVL khả dụng."}</p></div>{selectedCapacity && <div className={styles.capacityRows}>{selectedCapacity.rows.map((row, index) => <div key={`${row.ingredient?.id || "missing"}-${index}`}><span><b>{row.ingredient?.name || "NVL không tồn tại"}</b><small>Cần {numberLabel(row.requiredBase)} {row.ingredient?.baseUnit || ""}/ly · Khả dụng {numberLabel(row.ingredient?.stockQuantityBase || 0)} {row.ingredient?.baseUnit || ""}</small></span><strong>{numberLabel(row.capacity, 0)} ly</strong></div>)}</div>}</section>
          {selectedProductErrors.length ? <div className={styles.blockerBox}><span>CẦN XỬ LÝ</span>{selectedProductErrors.map((error) => <p key={error}>• {error}</p>)}</div> : <div className={styles.readyBox}><b>SKU đã đủ dữ liệu vận hành.</b><span>Giá vốn và ước tính đang dùng công thức đã lưu cùng tồn Kho NVL hiện tại.</span></div>}
          <div className={styles.detailActions}><button onClick={() => openProduct(selectedProduct)}>Chỉnh giá bán & bao bì</button></div>
        </>}

        {detailTab === "recipe" && <>
          <div className={styles.recipeToolbar}><label>Phiên bản đã lưu<select value={selectedVersion?.id || ""} onChange={(event) => selectRecipeVersion(event.target.value)}><option value="">Chưa có công thức</option>{selectedVersions.map((version) => <option value={version.id} key={version.id}>v{version.version} · {version.id === currentRecipe?.id ? "hiện hành" : "lưu trữ"} · {dateLabel(version.effectiveFrom)}</option>)}</select></label>{!isCurrentRecipe && <button onClick={() => startRecipeDraft(selectedProduct.id)}>Chỉnh công thức hiện hành</button>}</div>
          <div className={styles.recipeVersionMeta}><span>{currentRecipe ? `Đang chỉnh sửa từ v${currentRecipe.version}` : "Công thức mới"}</span><i className={recipeDraftDirty ? styles.draft : styles.active}>{recipeDraftDirty ? "chưa lưu" : "đã lưu"}</i><b>{recipeVersionCost({ id: "draft", productId: selectedProduct.id, version: 0, effectiveFrom: "", status: "active", createdAt: "", items: recipeItems }, state.ingredients, selectedProduct.packagingCost) === undefined ? "Chưa tính được" : money(recipeVersionCost({ id: "draft", productId: selectedProduct.id, version: 0, effectiveFrom: "", status: "active", createdAt: "", items: recipeItems }, state.ingredients, selectedProduct.packagingCost) || 0)}</b></div>
          <div className={styles.recipeList}>{recipeItems.length ? recipeItems.map((item) => { const ingredient = state.ingredients.find((entry) => entry.id === item.ingredientId); const cost = recipeItemCost(item, ingredient); const required = ingredient ? convertToBase(item.quantity, item.unit, ingredient.baseUnit) : undefined; const itemCapacity = ingredient && required ? Math.floor(ingredient.stockQuantityBase / (required * (1 + item.wastePercent / 100))) : 0; const issue = ingredient && !ingredientIsAvailable(ingredient) ? { key: `${selectedProduct.id}-${ingredient.id}`, product: selectedProduct, version: currentRecipe || { id: "", productId: selectedProduct.id, version: 0, effectiveFrom: "", status: "active" as const, createdAt: "", items: recipeItems }, ingredient, candidates: sortIngredientsForUse(state.ingredients.filter((candidate) => candidate.id !== ingredient.id && ingredientIsAvailable(candidate) && candidate.category === ingredient.category && sameUnitFamily(ingredient, candidate))) } : undefined; return <div className={styles.recipeItemBlock} key={item.id}><div className={`${styles.recipeRow} ${issue ? styles.recipeOut : ""}`}><span><b>{ingredient ? `${ingredient.name} · ${ingredient.brand}` : "Nguyên liệu đã xóa"}</b><small>{ingredient?.category || "-"} · {item.quantity} {item.unit} · HH {item.wastePercent}% · ước tính {numberLabel(itemCapacity, 0)} ly</small></span><strong>{cost === undefined ? "Thiếu giá" : money(cost)}</strong>{isCurrentRecipe && issue ? <><button className={styles.replaceButton} onClick={() => setInlineReplacementKey((current) => current === issue.key ? "" : issue.key)}>Thay thế</button><button className={styles.deleteButton} onClick={() => removeRecipeItem(item.id)}>Xóa</button></> : isCurrentRecipe && <button className={styles.deleteButton} onClick={() => removeRecipeItem(item.id)}>Xóa</button>}</div>{isCurrentRecipe && issue && inlineReplacementKey === issue.key && <div className={styles.inlineReplacement}><div><span>THAY NGUYÊN LIỆU / THƯƠNG HIỆU</span><b>{issue.ingredient.category}</b></div>{issue.candidates.length ? <><select value={replacementSelection[issue.key] || issue.candidates[0].id} onChange={(event) => setReplacementSelection((current) => ({ ...current, [issue.key]: event.target.value }))}>{issue.candidates.map((candidate) => <option value={candidate.id} key={candidate.id}>{ingredientChoiceLabel(candidate)} · khả dụng {numberLabel(candidate.stockQuantityBase)} {candidate.baseUnit}</option>)}</select><button onClick={() => replaceIngredient(issue)}>Thay trong bản nháp</button></> : <p>Chưa có NVL còn trong kho hoặc đang dùng cùng category và nhóm đơn vị. Hãy nhập thêm ở Kho NVL.</p>}</div>}</div>; }) : <div className={styles.emptySmall}>Chưa có thành phần. Thêm NVL rồi lưu để tạo công thức đầu tiên.</div>}</div>
          {isCurrentRecipe && <><form className={styles.recipeForm} onSubmit={addRecipeItem}><div className={styles.recipeSelectors}><label>1. Category<select required value={recipeCategory} onChange={(event) => selectRecipeCategory(event.target.value)}><option value="">Chọn category</option>{ingredientCategories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label><div className={styles.recipePickerField}><span>2. Nguyên liệu / thương hiệu</span><div className={styles.recipeIngredientPicker} ref={recipePickerRef}><button type="button" className={styles.recipeIngredientTrigger} disabled={!recipeCategory} aria-haspopup="listbox" aria-expanded={recipePickerOpen} onClick={() => setRecipePickerOpen((open) => !open)}>{recipeIngredientId ? (() => { const ingredient = state.ingredients.find((entry) => entry.id === recipeIngredientId); return ingredient ? `${ingredientChoiceLabel(ingredient)} · quy đổi ${conversionUnitForRecipe(ingredient, uatMode)}` : "Chọn nguyên liệu"; })() : recipeCandidates.length ? "Chọn nguyên liệu" : "Chưa có NVL còn trong kho hoặc đang dùng"}<i>{recipePickerOpen ? "−" : "+"}</i></button>{recipePickerOpen && <div className={styles.recipeIngredientOptions} role="listbox" aria-label="Nguyên liệu và thương hiệu">{recipeCandidates.map((ingredient) => { const conversionUnit = conversionUnitForRecipe(ingredient, uatMode); return <button type="button" role="option" aria-selected={recipeIngredientId === ingredient.id} aria-disabled={!conversionUnit} className={!conversionUnit ? styles.unconvertedOption : ""} disabled={!conversionUnit} onClick={() => selectRecipeIngredient(ingredient.id)} key={ingredient.id}><span>{ingredientChoiceLabel(ingredient)}</span><b>{conversionUnit ? `QUY ĐỔI ${conversionUnit}` : "CHƯA QUY ĐỔI"}</b></button>; })}</div>}</div><small>Chỉ hiện NVL còn trong kho hoặc đang dùng; không hiện NVL đã dùng hết hay hư hỏng.</small></div></div><div><label>Định lượng<input required min="0.001" step="0.001" type="number" value={recipeQuantity} onChange={(event) => setRecipeQuantity(event.target.value)} /></label><label>Đơn vị quy đổi<select required disabled={!allowedRecipeUnits.length} value={recipeUnit} onChange={(event) => setRecipeUnit(event.target.value)}><option value="">Chọn đơn vị quy đổi</option>{allowedRecipeUnits.map((unit) => <option key={unit}>{unit}</option>)}</select></label><label>Hao hụt %<input min="0" step="0.1" type="number" value={recipeWaste} onChange={(event) => setRecipeWaste(event.target.value)} /></label></div><button disabled={!recipeIngredientId || !allowedRecipeUnits.length}>Thêm nguyên liệu</button></form><button className={styles.saveRecipe} disabled={!recipeDraftDirty} onClick={saveRecipe}>Lưu công thức{currentRecipe ? ` thành v${currentRecipe.version + 1}` : ""}</button></>}
        </>}

        {detailTab === "history" && <div className={styles.historyList}>{state.auditEvents.filter((event) => event.entityId === selectedProduct.id || state.recipeVersions.some((version) => version.productId === selectedProduct.id && version.id === event.entityId)).length ? state.auditEvents.filter((event) => event.entityId === selectedProduct.id || state.recipeVersions.some((version) => version.productId === selectedProduct.id && version.id === event.entityId)).map((event) => <div key={event.id}><span><b>{event.action}</b><small>{event.detail}</small></span><time>{new Date(event.createdAt).toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" })}</time></div>) : <div className={styles.emptySmall}>Chưa có lịch sử cho SKU này.</div>}</div>}
      </div>
    </aside></div>}

    {showProductForm && selectedProduct && <div className={styles.backdrop} onMouseDown={() => setShowProductForm(false)}><form className={styles.sheet} onSubmit={saveProduct} onMouseDown={(event) => event.stopPropagation()}><div className={styles.handle} /><div className={styles.sheetTitle}><div><span>{selectedProduct.sku} · {selectedProduct.category}</span><h2>Chỉnh giá {selectedProduct.name}</h2></div><button type="button" onClick={() => setShowProductForm(false)}>×</button></div><p className={styles.formNote}>Tên, SKU và Category luôn theo báo cáo Mặt hàng. Khi lưu giá bán tại đây, Finance sẽ không ghi đè giá này trong các lần đồng bộ sau.</p><div className={styles.formRow}><label className={styles.field}>Giá bán<input inputMode="numeric" value={productForm.sellingPrice} onChange={(event) => setProductForm((current) => ({ ...current, sellingPrice: amountInput(event.target.value) }))} /></label><label className={styles.field}>Chi phí bao bì<input inputMode="numeric" value={productForm.packagingCost} onChange={(event) => setProductForm((current) => ({ ...current, packagingCost: amountInput(event.target.value) }))} /></label></div><button className={styles.saveButton}>Lưu thay đổi</button></form></div>}
  </section>;
}

function CostTrendChart({ points }: { points: Array<{ version: RecipeVersion; cost: number | undefined }> }) {
  const valid = points.filter((point): point is { version: RecipeVersion; cost: number } => point.cost !== undefined);
  if (!valid.length) return <section className={styles.costTrend}><div><span>GIÁ VỐN THEO VERSION</span><b>Chưa có version đủ dữ liệu</b></div></section>;
  const width = 320;
  const height = 76;
  const padding = 10;
  const min = Math.min(...valid.map((point) => point.cost));
  const max = Math.max(...valid.map((point) => point.cost));
  const range = Math.max(1, max - min);
  const coordinates = valid.map((point, index) => ({ ...point, x: valid.length === 1 ? width / 2 : padding + index * (width - padding * 2) / (valid.length - 1), y: height - padding - (point.cost - min) / range * (height - padding * 2) }));
  const delta = valid.length > 1 ? valid[valid.length - 1].cost - valid[valid.length - 2].cost : 0;
  return <section className={styles.costTrend}><div><span>GIÁ VỐN THEO VERSION</span><b>{valid.length} version · {delta === 0 ? "Không đổi" : `${delta > 0 ? "Tăng" : "Giảm"} ${money(Math.abs(delta))}`}</b></div><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Biểu đồ giá vốn theo phiên bản"><polyline points={coordinates.map((point) => `${point.x},${point.y}`).join(" ")} /><g>{coordinates.map((point) => <circle key={point.version.id} cx={point.x} cy={point.y} r="3.5"><title>{`v${point.version.version}: ${money(point.cost)}`}</title></circle>)}</g></svg><div className={styles.costTrendLabels}>{valid.map((point) => <span key={point.version.id}><b>v{point.version.version}</b><small>{money(point.cost)}</small></span>)}</div></section>;
}

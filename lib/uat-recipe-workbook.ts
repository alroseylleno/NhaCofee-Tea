import {
  type IngredientMaster,
  type MasterDataState,
  type ProductMaster,
  type ProductRecipeItem,
  type RecipeVersion,
  normalizedText,
  unitDefinition,
} from "@/lib/master-data";

export const UAT_RECIPE_WORKBOOK_LABEL = "Copy of BẢNG TỔNG HỢP CT (1).xlsx";
const UAT_RECIPE_IMPORT_ID = "nha-ops-uat-recipe-workbook-20260813-v1";

type Size = "M" | "L";
type WorkbookIngredient = {
  name: string;
  quantity: number;
  unit: string;
  aliases?: string[];
  brandHints?: string[];
  note?: string;
};
type WorkbookRecipe = {
  skus: string[];
  ingredients: WorkbookIngredient[];
  issues?: string[];
};

const serving = (m: number, l: number) => ({ M: m, L: l });
const ingredient = (name: string, quantity: number, unit: string, aliases: string[] = [], brandHints: string[] = [], note?: string): WorkbookIngredient => ({ name, quantity, unit, aliases, brandHints, note });
const bySize = (size: Size, name: string, quantities: { M: number; L: number }, unit: string, aliases: string[] = [], brandHints: string[] = [], note?: string) => ingredient(name, quantities[size], unit, aliases, brandHints, note);

function sizedRecipe(baseSku: string, sizes: Size[], build: (size: Size) => WorkbookIngredient[], issues?: string[]) {
  return sizes.map((size): WorkbookRecipe => ({ skus: [`${baseSku}-${size}`], ingredients: build(size), issues }));
}

const RECIPES: WorkbookRecipe[] = [
  ...sizedRecipe("CCD", ["M", "L"], (size) => [
    bySize(size, "Cà phê", serving(60, 80), "ml", ["Cafe", "Cốt cà phê", "Cốt cafe"]),
    bySize(size, "Sữa đặc", serving(20, 40), "ml"),
    bySize(size, "Cốt dừa", serving(20, 40), "ml", ["Nước cốt dừa"]),
    bySize(size, "Dừa khô", serving(1, 2), "muỗng"),
  ]),
  ...sizedRecipe("CSD", ["M", "L"], (size) => [
    bySize(size, "Cốt dừa", serving(10, 20), "ml", ["Nước cốt dừa"]),
    bySize(size, "Sữa tươi không đường", serving(20, 40), "ml"),
    bySize(size, "Sữa đặc", serving(10, 20), "ml"),
    bySize(size, "Cacao", serving(10, 20), "ml", ["Bột cacao", "Bột ca cao"]),
  ]),
  ...sizedRecipe("CM", ["M", "L"], (size) => [
    bySize(size, "Syrup bạc hà", serving(10, 20), "ml"),
    bySize(size, "Sữa tươi không đường", serving(50, 70), "ml"),
    bySize(size, "Sữa đặc", serving(10, 20), "ml"),
    bySize(size, "Cacao", serving(10, 20), "ml", ["Bột cacao", "Bột ca cao"]),
  ]),
  ...sizedRecipe("CL", ["M", "L"], (size) => [
    bySize(size, "Cacao", serving(10, 20), "ml", ["Bột cacao", "Bột ca cao"]),
    bySize(size, "Sữa tươi không đường", serving(50, 70), "ml"),
    bySize(size, "Sữa đặc", serving(10, 20), "ml"),
  ]),
  ...sizedRecipe("CST", ["M", "L"], (size) => [
    bySize(size, "Cà phê", serving(60, 80), "ml", ["Cafe", "Cốt cà phê", "Cốt cafe"]),
    bySize(size, "Sữa tươi không đường", serving(50, 70), "ml"),
    bySize(size, "Sữa đặc", serving(10, 20), "ml"),
  ]),
  ...sizedRecipe("BX", ["M", "L"], (size) => [
    bySize(size, "Cà phê", serving(60, 80), "ml", ["Cafe", "Cốt cà phê", "Cốt cafe"]),
    bySize(size, "Sữa tươi không đường", serving(50, 70), "ml"),
    bySize(size, "Sữa đặc", serving(20, 30), "ml"),
  ]),
  ...sizedRecipe("C-LC", ["M", "L"], (size) => [
    bySize(size, "Cà phê", serving(60, 80), "ml", ["Cafe", "Cốt cà phê", "Cốt cafe"]),
    bySize(size, "Sữa tươi không đường", serving(50, 70), "ml"),
  ]),
  { skus: ["C-PD-M"], ingredients: [ingredient("Cà phê", 60, "ml", ["Cafe", "Cốt cà phê", "Cốt cafe"]), ingredient("Nước đường", 20, "ml")] },
  { skus: ["C-PS-M"], ingredients: [ingredient("Cà phê", 60, "ml", ["Cafe", "Cốt cà phê", "Cốt cafe"]), ingredient("Sữa đặc", 15, "ml"), ingredient("Nước đường", 10, "ml")] },
  ...sizedRecipe("MN", ["M", "L"], (size) => [
    bySize(size, "Matcha", serving(4, 5), "g", ["Bột matcha"], ["MK4", "Nhật"]),
    bySize(size, "Sữa tươi không đường", serving(50, 70), "ml"),
    bySize(size, "Nước đường", serving(20, 30), "ml"),
  ]),
  ...sizedRecipe("M-ML", ["M", "L"], (size) => [
    bySize(size, "Matcha", serving(3, 4), "g", ["Bột matcha"], ["NOVIA", "Đài"]),
    bySize(size, "Sữa tươi không đường", serving(50, 70), "ml"),
    bySize(size, "Nước đường", serving(20, 30), "ml"),
  ]),
  ...sizedRecipe("M-MC", ["M", "L"], (size) => [
    bySize(size, "Matcha", serving(4, 5), "g", ["Bột matcha"], ["MK4", "Nhật"]),
    bySize(size, "Sữa tươi không đường", serving(50, 70), "ml"),
    bySize(size, "Sữa đặc", serving(10, 20), "ml"),
    bySize(size, "Nước đường", serving(20, 30), "ml"),
  ]),
  ...sizedRecipe("M-MO", ["M", "L"], (size) => [
    bySize(size, "Matcha", serving(4, 5), "g", ["Bột matcha"], ["MK4", "Nhật"]),
    bySize(size, "Oatside", serving(50, 70), "ml", ["Sữa Oatside", "Sữa yến mạch"]),
    bySize(size, "Nước đường", serving(20, 30), "ml"),
  ]),
  ...sizedRecipe("M-CC", ["M"], (size) => [
    bySize(size, "Matcha", serving(4, 5), "g", ["Bột matcha"], ["MK4", "Nhật"]),
    bySize(size, "Sữa đặc", serving(10, 20), "ml"),
    bySize(size, "Sữa béo", serving(10, 20), "ml", ["Kem béo", "Kem béo Rich"]),
    bySize(size, "Nước dừa", serving(50, 70), "ml"),
    bySize(size, "Nước đường", serving(20, 30), "ml"),
  ]),
  ...sizedRecipe("CCM", ["L"], (size) => [
    bySize(size, "Matcha", serving(4, 5), "g", ["Bột matcha"], ["MK4", "Nhật"]),
    bySize(size, "Sữa đặc", serving(10, 20), "ml"),
    bySize(size, "Sữa béo", serving(10, 20), "ml", ["Kem béo", "Kem béo Rich"]),
    bySize(size, "Nước dừa", serving(50, 70), "ml"),
    bySize(size, "Nước đường", serving(20, 30), "ml"),
  ]),
  ...sizedRecipe("MLD", ["M", "L"], (size) => [
    bySize(size, "Mứt dâu", serving(10, 20), "g"),
    bySize(size, "Matcha", serving(4, 5), "g", ["Bột matcha"], ["MK4", "Nhật"]),
    bySize(size, "Sữa tươi không đường", serving(50, 70), "ml"),
    bySize(size, "Nước đường", serving(20, 30), "ml"),
  ]),
  ...sizedRecipe("M-LX", ["M", "L"], (size) => [
    bySize(size, "Mứt xoài", serving(10, 20), "g"),
    bySize(size, "Matcha", serving(4, 5), "g", ["Bột matcha"], ["MK4", "Nhật"]),
    bySize(size, "Sữa tươi không đường", serving(50, 70), "ml"),
    bySize(size, "Nước đường", serving(20, 30), "ml"),
  ]),
  ...sizedRecipe("MSD", ["M", "L"], (size) => [
    bySize(size, "Matcha", serving(4, 5), "g", ["Bột matcha"], ["MK4", "Nhật"]),
    bySize(size, "Cốt dừa", serving(20, 30), "ml", ["Nước cốt dừa"]),
    bySize(size, "Sữa đặc", serving(10, 20), "ml"),
    bySize(size, "Sữa tươi không đường", serving(50, 70), "ml"),
    bySize(size, "Nước đường", serving(20, 30), "ml"),
  ]),
  { skus: ["TS-TT"], ingredients: [ingredient("Cốt trà sữa pha sẵn", 150, "ml", ["Trà sữa truyền thống", "Cốt trà sữa"])] },
  { skus: ["TS-GR"], ingredients: [ingredient("Trà sữa gạo rang", 150, "ml", ["Cốt trà sữa gạo rang"])] },
  { skus: ["TS-LT"], ingredients: [ingredient("Lục trà sữa", 150, "ml", ["Cốt lục trà sữa"]), ingredient("Nước đường", 30, "ml")] },
  { skus: ["TS-OL"], ingredients: [ingredient("Trà sữa Olong lài", 150, "ml", ["Cốt trà sữa Olong lài"]), ingredient("Trân châu", 1, "vá", ["Trân châu đen", "Trân châu trắng"])] },
  { skus: ["TSONS"], ingredients: [ingredient("Cốt trà sữa pha sẵn", 150, "ml", ["Trà sữa Olong nhãn sen", "Cốt trà sữa"]), ingredient("Nước đường", 30, "ml"), ingredient("Nhãn trái", 3, "trái"), ingredient("Hạt sen", 1, "vá")] },
  { skus: ["TS-LTX"], ingredients: [ingredient("Mứt xoài", 20, "g"), ingredient("Cốt trà sữa pha sẵn", 150, "ml", ["Lục trà sữa", "Cốt lục trà sữa"]), ingredient("Nước đường", 30, "ml")] },
  { skus: ["T-D"], ingredients: [ingredient("Trà đen", 150, "ml"), ingredient("Syrup đào", 30, "ml"), ingredient("Mứt đào", 10, "ml"), ingredient("Nước đường", 30, "ml"), ingredient("Đào miếng", 4, "miếng")] },
  { skus: ["T-VL"], ingredients: [ingredient("Trà lài", 150, "ml", ["Trà lài/olong", "Trà olong"]), ingredient("Syrup vải", 30, "ml"), ingredient("Mứt vải", 10, "ml"), ingredient("Cốt chanh", 10, "ml", ["Cốt chanh/tắc"]), ingredient("Nước đường", 30, "ml"), ingredient("Vải trái", 4, "trái")] },
  { skus: ["T-TM"], ingredients: [ingredient("Trà olong", 150, "ml"), ingredient("Syrup ổi", 30, "ml"), ingredient("Cốt chanh", 10, "ml", ["Cốt chanh/tắc"]), ingredient("Nước đường", 30, "ml"), ingredient("Nhãn trái", 4, "trái")] },
  { skus: ["T-LTX"], ingredients: [ingredient("Trà lài", 150, "ml"), ingredient("Syrup xoài", 30, "ml"), ingredient("Mứt xoài", 10, "ml"), ingredient("Cốt chanh", 10, "ml", ["Cốt chanh/tắc"]), ingredient("Nước đường", 30, "ml")] },
  { skus: ["T-TCD"], ingredients: [ingredient("Trà lài", 150, "ml"), ingredient("Syrup chanh dây", 20, "trái"), ingredient("Mứt chanh dây", 20, "trái"), ingredient("Nước đường", 30, "ml"), ingredient("Trân châu", 1, "vá", ["Trân châu đen", "Trân châu trắng"])] },
  { skus: ["T-TMO"], ingredients: [ingredient("Trà đen", 150, "ml"), ingredient("Mật ong", 20, "ml"), ingredient("Tắc tươi", 10, "ml"), ingredient("Nước đường", 30, "ml"), ingredient("Trân châu", 1, "vá", ["Trân châu đen", "Trân châu trắng"])] },
  { skus: ["TD"], ingredients: [ingredient("Trà đen", 150, "ml"), ingredient("Syrup dâu", 10, "ml"), ingredient("Mứt dâu", 20, "ml"), ingredient("Cốt chanh", 10, "ml", ["Cốt chanh/tắc"]), ingredient("Nước đường", 20, "ml"), ingredient("Trân châu", 1, "vá", ["Trân châu đen", "Trân châu trắng"])] },
  { skus: ["TO"], ingredients: [ingredient("Trà lài", 150, "ml"), ingredient("Syrup ổi", 20, "ml"), ingredient("Mứt ổi", 10, "ml"), ingredient("Tắc tươi", 10, "ml"), ingredient("Nước đường", 30, "ml")] },
  { skus: ["TTTX"], ingredients: [ingredient("Trà Thái", 150, "ml", ["Thái đỏ", "Thái xanh", "Trà Thái đỏ", "Trà Thái xanh"]), ingredient("Nước đường", 50, "ml"), ingredient("Tắc tươi", 15, "ml"), ingredient("Trân châu", 1, "vá", ["Trân châu đen", "Trân châu trắng"])] },
  { skus: ["TSTX"], ingredients: [ingredient("Trà sữa Thái", 150, "ml", ["Trà sữa Thái xanh", "Trà sữa Thái đỏ", "Cốt trà sữa Thái"])] },
];

function normalizeSku(value: string) {
  return value.trim().toLocaleUpperCase("vi").replace(/\s+/g, "");
}

function ingredientTerms(source: WorkbookIngredient) {
  return [source.name, ...(source.aliases || [])].map(normalizedText).filter(Boolean);
}

function findIngredient(source: WorkbookIngredient, ingredients: IngredientMaster[]) {
  const terms = ingredientTerms(source);
  const candidates = ingredients.filter((candidate) => {
    const name = normalizedText(candidate.name);
    return terms.some((term) => name === term || name.includes(term) || term.includes(name));
  });
  if (!candidates.length) return { issue: `thiếu NVL ${source.name}` } as const;

  const unit = unitDefinition(source.unit);
  const compatible = candidates.filter((candidate) => !unit || unitDefinition(candidate.baseUnit)?.family === unit.family);
  if (!compatible.length) return { issue: `${source.name} sai nhóm đơn vị (${source.unit})` } as const;

  const brandHints = (source.brandHints || []).map(normalizedText);
  const brandMatched = brandHints.length ? compatible.filter((candidate) => {
    const identity = normalizedText(`${candidate.name} ${candidate.brand}`);
    return brandHints.some((hint) => identity.includes(hint));
  }) : compatible;
  if (brandHints.length && !brandMatched.length) return { issue: `thiếu đúng loại ${source.name} (${source.brandHints?.join("/")})` } as const;
  const scored = brandMatched.map((candidate) => {
    const name = normalizedText(candidate.name);
    const brand = normalizedText(candidate.brand);
    const exactName = terms.includes(name) ? 20 : 0;
    const brandScore = brandHints.some((hint) => brand.includes(hint) || name.includes(hint)) ? 12 : 0;
    const availableScore = candidate.status === "active" && candidate.stockQuantityBase > 0 ? 5 : 0;
    const dateScore = candidate.oldestInStockPurchasedOn || candidate.latestPurchasedOn || "9999-12-31";
    return { candidate, score: exactName + brandScore + availableScore, dateScore };
  }).sort((left, right) => right.score - left.score || left.dateScore.localeCompare(right.dateScore));

  const top = scored[0];
  const tied = scored.filter((entry) => entry.score === top.score);
  if (tied.length > 1) return { issue: `${source.name} có nhiều nguyên liệu/thương hiệu phù hợp` } as const;
  return { ingredient: top.candidate } as const;
}

function recipeForProduct(product: ProductMaster) {
  const sku = normalizeSku(product.sku);
  return RECIPES.find((recipe) => recipe.skus.some((candidate) => normalizeSku(candidate) === sku));
}

function importedRecipe(product: ProductMaster, recipe: WorkbookRecipe, ingredients: IngredientMaster[], now: string, existing?: RecipeVersion): RecipeVersion {
  const items: ProductRecipeItem[] = [];
  const issues = [...(recipe.issues || [])];
  for (const source of recipe.ingredients) {
    const match = findIngredient(source, ingredients);
    if (match.issue) {
      issues.push(match.issue);
      continue;
    }
    const unit = normalizedText(source.unit);
    if (!unitDefinition(unit)) {
      issues.push(`${source.name} dùng đơn vị ${source.unit} chưa hỗ trợ quy đổi`);
      continue;
    }
    if (!match.ingredient) continue;
    items.push({ id: crypto.randomUUID(), ingredientId: match.ingredient.id, quantity: source.quantity, unit, wastePercent: match.ingredient.standardWastePercent });
  }
  return {
    id: existing?.id || crypto.randomUUID(),
    productId: product.id,
    version: existing?.version || 1,
    effectiveFrom: existing?.effectiveFrom || now.slice(0, 10),
    status: "active",
    items,
    createdAt: existing?.createdAt || now,
    source: "workbook",
    sourceLabel: UAT_RECIPE_WORKBOOK_LABEL,
    expectedItemCount: recipe.ingredients.length,
    importIssues: [...new Set(issues)],
  };
}

export function applyUatWorkbookRecipes(state: MasterDataState) {
  const now = new Date().toISOString();
  const imported: RecipeVersion[] = [];
  const replacedVersionIds = new Set<string>();
  let coveredProducts = 0;
  for (const product of state.products) {
    const current = state.recipeVersions.find((version) => version.productId === product.id && version.status === "active");
    if (current && current.source !== "workbook") continue;
    const recipe = recipeForProduct(product);
    if (!recipe) continue;
    const candidate = importedRecipe(product, recipe, state.ingredients, now, current);
    const currentSignature = current ? JSON.stringify({
      items: current.items.map((item) => [item.ingredientId, item.quantity, item.unit, item.wastePercent]),
      expectedItemCount: current.expectedItemCount,
      importIssues: current.importIssues || [],
    }) : "";
    const candidateSignature = JSON.stringify({
      items: candidate.items.map((item) => [item.ingredientId, item.quantity, item.unit, item.wastePercent]),
      expectedItemCount: candidate.expectedItemCount,
      importIssues: candidate.importIssues || [],
    });
    if (currentSignature === candidateSignature) continue;
    coveredProducts += 1;
    imported.push(candidate);
    if (current) replacedVersionIds.add(current.id);
  }
  if (!imported.length) return state;
  return {
    ...state,
    recipeVersions: [...imported, ...state.recipeVersions.filter((version) => !replacedVersionIds.has(version.id))],
    auditEvents: [{
      id: crypto.randomUUID(),
      entityType: "recipe" as const,
      entityId: UAT_RECIPE_IMPORT_ID,
      action: "workbook_import",
      detail: `Nạp công thức UAT từ ${UAT_RECIPE_WORKBOOK_LABEL}: ${coveredProducts} SKU được đối chiếu; phần thiếu/mơ hồ được flag để xử lý.`,
      createdAt: now,
    }, ...state.auditEvents],
  };
}

export function workbookRecipeSummary(product: ProductMaster, versions: RecipeVersion[]) {
  const version = versions.find((entry) => entry.productId === product.id && entry.status === "active" && entry.source === "workbook");
  if (!version) return undefined;
  const missing = version.importIssues || [];
  return missing.length ? `${missing.length} lỗi CT Excel · ${missing[0]}` : `Đã nạp ${version.items.length} NVL từ CT Excel`;
}

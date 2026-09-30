import { activeRecipeVersion, comboMembers, theoreticalProductCostWithComponents, type IngredientMaster, type ProductMaster, type RecipeVersion } from "./master-data";

/// Giá vốn lý thuyết cho một dòng món trên hoá đơn sàn.
///
/// Dòng sàn chỉ mang TÊN món (không size, không SKU) cộng chuỗi lựa chọn của
/// khách, vd `Size L,Trân châu Đen,Thạch nổ củ năng,70%,Đá Chung`. Tiền của
/// topping chọn thêm và của nâng size đã nằm trong giá dòng, nên giá vốn phải
/// cộng chúng vào — đọc mỗi tên món sẽ báo lãi cao hơn thật.
export type SanCogsBook = {
  /// tên món → giá vốn 1 phần ở size mặc định (M; không có M thì biến thể rẻ nhất).
  base: Map<string, number>;
  /// tên món → giá vốn 1 phần khi khách nâng size L. Combo: đổi từng món thành
  /// viên sang biến thể L cùng tên.
  large: Map<string, number>;
  /// tên topping → giá vốn 1 phần, để khớp với từng mục trong chuỗi lựa chọn.
  toppings: Map<string, number>;
  /// Món mà công thức đã có sẵn trân châu/thạch (trà, trà sữa). Topping trong
  /// chuỗi lựa chọn của món này thường CHÍNH LÀ phần kèm mặc định, nên không cộng
  /// thêm — cộng sẽ tính trùng.
  builtInTopping: Set<string>;
};

export function sanCogsKey(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase("vi").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/\s+/g, " ");
}

const TOPPING_INGREDIENT = /tran chau|thach/;
const LARGE_OPTION = /size\s*\(?l\)?$|\(l\)/;

export function emptySanCogsBook(): SanCogsBook {
  return { base: new Map(), large: new Map(), toppings: new Map(), builtInTopping: new Set() };
}

export function buildSanCogsBook(products: ProductMaster[], versions: RecipeVersion[], ingredients: IngredientMaster[]): SanCogsBook {
  const book = emptySanCogsBook();
  const costOf = new Map<string, number | undefined>();
  const cost = (product: ProductMaster) => {
    if (!costOf.has(product.id)) costOf.set(product.id, theoreticalProductCostWithComponents(product, products, versions, ingredients));
    return costOf.get(product.id);
  };
  const ingredientName = new Map(ingredients.map((ingredient) => [ingredient.id, ingredient.name] as const));
  const hasBuiltInTopping = (product: ProductMaster) => (activeRecipeVersion(product.id, versions)?.items || []).some((item) => TOPPING_INGREDIENT.test(sanCogsKey(item.ingredientId ? ingredientName.get(item.ingredientId) : item.customName)));
  const largeOf = new Map<string, number>();
  for (const product of products) {
    const value = cost(product);
    if (value !== undefined && value > 0 && sanCogsKey(product.variant) === "l") largeOf.set(sanCogsKey(product.name), value);
  }

  // Sàn listings carry no size, so variant M — the size the sàn menu is priced
  // from — wins; without an M the cheapest variant stands in.
  const best = new Map<string, { cost: number; sellingPrice: number; isM: boolean; product: ProductMaster }>();
  for (const product of products) {
    // Combo cũng là một dòng bán ra trên hoá đơn sàn, nên nó phải có giá vốn
    // trong sổ; chỉ Công thức nền và Bao bì mới không bao giờ bán lẻ.
    if (product.productType && product.productType !== "sellable" && product.productType !== "combo") continue;
    const value = cost(product);
    if (value === undefined || value <= 0) continue;
    const key = sanCogsKey(product.name);
    if (sanCogsKey(product.category) === "topping") book.toppings.set(key, value);
    const isM = sanCogsKey(product.variant) === "m";
    const current = best.get(key);
    if (!current || (isM && !current.isM) || (isM === current.isM && product.sellingPrice > 0 && (current.sellingPrice <= 0 || product.sellingPrice < current.sellingPrice))) {
      best.set(key, { cost: value, sellingPrice: product.sellingPrice, isM, product });
    }
  }

  for (const [key, entry] of best) {
    book.base.set(key, entry.cost);
    if (entry.product.productType === "combo") {
      const members = comboMembers(entry.product, versions, products);
      if (members.some((member) => member.product && hasBuiltInTopping(member.product))) book.builtInTopping.add(key);
      let upsize = 0;
      for (const member of members) {
        if (!member.product || sanCogsKey(member.product.variant) === "l") continue;
        const large = largeOf.get(sanCogsKey(member.product.name));
        const regular = cost(member.product);
        if (large !== undefined && regular !== undefined && large > regular) upsize += (large - regular) * member.quantity;
      }
      if (upsize > 0) book.large.set(key, entry.cost + upsize);
    } else {
      if (hasBuiltInTopping(entry.product)) book.builtInTopping.add(key);
      const large = largeOf.get(key);
      if (large !== undefined && large > entry.cost) book.large.set(key, large);
    }
  }
  return book;
}

/// Giá vốn 1 phần của một dòng sàn, hoặc undefined khi tên món chưa có giá vốn.
export function sanLineUnitCogs(book: SanCogsBook, name: string, option?: string) {
  const key = sanCogsKey(name);
  const base = book.base.get(key);
  if (base === undefined) return undefined;
  const choices = String(option ?? "").split(",").map(sanCogsKey).filter(Boolean);
  let unit = choices.some((choice) => LARGE_OPTION.test(choice)) ? book.large.get(key) ?? base : base;
  if (!book.builtInTopping.has(key)) {
    for (const choice of choices) unit += book.toppings.get(choice) ?? 0;
  }
  return unit;
}

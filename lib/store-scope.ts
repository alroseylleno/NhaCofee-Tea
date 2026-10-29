import type { CloudStore, StorePlatformAccount } from "./inventory-store";

// Which điểm bán a Finance record belongs to. Pure functions so the rules can
// be tested without the UI.
//
// Outlets (điểm bán) sell; a warehouse (KHO TỔNG) only stores. Finance filters
// by outlet; whatever belongs to no outlet (shared expenses, warehouse stock)
// is "Toàn chuỗi" and is spread over the outlets by revenue share.

export type StoreAttributionSource = "manual" | "single-outlet" | "doi-soat" | "san-merchant" | "khu-vuc" | "thu-ngan" | "mac-dinh";

export const ATTRIBUTION_LABELS: Record<StoreAttributionSource, string> = {
  manual: "chuyển tay",
  "single-outlet": "chỉ một điểm bán đang mở",
  "doi-soat": "theo merchant đã đối soát",
  "san-merchant": "theo tài khoản sàn",
  "khu-vuc": "theo khu vực",
  "thu-ngan": "theo thu ngân",
  "mac-dinh": "mặc định",
};

/// Accent-, case- and spacing-insensitive, so "NHÀ 02", "Nhà 02" and the NFD
/// spelling SAPO sometimes exports all compare equal.
export function foldSignal(value: unknown) {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();
}

/// The configuration migration 20261030000100 seeds on Production. UAT stores
/// copied from a Production that has not run it yet carry none of it, so the
/// UAT loader fills the same values in; a store already configured is left as is.
const FINANCE_SEED: Record<string, Partial<CloudStore>> = {
  "NHA-31-7": { kind: "outlet", sapoAreas: ["NHÀ 01", "Tại NHÀ"], sapoCashiers: ["NHÀ 01", "NHÀ Coffee & Tea"], platformAccounts: [
    { platform: "grab", merchantId: "5-C8BGGY6BV2V3RE", name: "Nhà Coffee&Tea - Hàn Hải Nguyên", inSapo: true },
    { platform: "shopee", merchantId: "10419674", name: "Nhà Coffee & Tea - Hàn Hải Nguyên", inSapo: true },
    { platform: "greensm", merchantId: "01KW6QK7GYCY10CYWA32ND0KYF", name: "Nhà Coffee & Tea - Hàn Hải Nguyên", inSapo: true },
  ] },
  "KHO-2": { kind: "outlet", openedOn: "2026-10-10", sapoAreas: ["NHÀ 02"], sapoCashiers: ["NHÀ 02"], platformAccounts: [{ platform: "shopee", merchantId: "10439891", name: "NHÀ - Coffee & Tea - Trương Phước Phan", inSapo: false }] },
  "KHO-3": { kind: "warehouse" },
};
export function withFinanceSeed(stores: CloudStore[]): CloudStore[] {
  return stores.map((store) => {
    const unconfigured = !store.kind && !store.sapoAreas?.length && !store.sapoCashiers?.length && !store.platformAccounts?.length;
    return unconfigured && FINANCE_SEED[store.code] ? { ...store, ...FINANCE_SEED[store.code] } : store;
  });
}

export function isOutlet(store: CloudStore) {
  return store.status === "active" && (store.kind || "outlet") === "outlet";
}

export function outletsOf(stores: CloudStore[]) {
  return stores.filter(isOutlet);
}

/// The outlet that takes what no rule can place: the default store when it
/// sells, else the first outlet.
export function defaultOutletId(stores: CloudStore[]) {
  const outlets = outletsOf(stores);
  return (outlets.find((store) => store.isDefault) || outlets[0] || stores.find((store) => store.isDefault) || stores[0])?.id;
}

/// Outlets open on `date`: a store without an opening date has always been open.
export function outletsOpenOn(stores: CloudStore[], date: string) {
  return outletsOf(stores).filter((store) => !store.openedOn || store.openedOn <= date);
}

/// The SAPO rule Long set on 30/10/2026: Khu vực (the table belongs to a store)
/// wins over Thu ngân; with no Khu vực the Thu ngân decides; the owner account
/// with no Khu vực falls to the default outlet.
export function signalStoreId(stores: CloudStore[], area?: string, cashier?: string): { storeId: string; source: "khu-vuc" | "thu-ngan" } | undefined {
  const outlets = outletsOf(stores);
  const areaKey = foldSignal(area);
  if (areaKey) {
    const byArea = outlets.find((store) => (store.sapoAreas || []).some((entry) => foldSignal(entry) === areaKey));
    if (byArea) return { storeId: byArea.id, source: "khu-vuc" };
  }
  const cashierKey = foldSignal(cashier);
  if (cashierKey) {
    const byCashier = outlets.find((store) => (store.sapoCashiers || []).some((entry) => foldSignal(entry) === cashierKey));
    if (byCashier) return { storeId: byCashier.id, source: "thu-ngan" };
  }
  return undefined;
}

export type OrderForAttribution = { id: string; orderDate: string; sapoArea?: string; sapoCashier?: string };

/// Store of one SAPO invoice. `marketplace` is the sàn key for sàn orders;
/// `reconciledStoreId` is the store of the merchant whose report settled it.
export function attributeOrder(order: OrderForAttribution, input: {
  stores: CloudStore[];
  manualStoreId?: string;
  marketplace?: string;
  reconciledStoreId?: string;
}): { storeId: string; source: StoreAttributionSource } {
  const fallback = defaultOutletId(input.stores) || "";
  if (input.manualStoreId) return { storeId: input.manualStoreId, source: "manual" };
  const open = outletsOpenOn(input.stores, order.orderDate);
  if (open.length === 1) return { storeId: open[0].id, source: "single-outlet" };
  if (input.marketplace) {
    if (input.reconciledStoreId) return { storeId: input.reconciledStoreId, source: "doi-soat" };
    // Not settled yet: the outlet whose account on this sàn feeds SAPO.
    const viaSapo = open.filter((store) => (store.platformAccounts || []).some((account) => account.platform === input.marketplace && account.inSapo));
    if (viaSapo.length === 1) return { storeId: viaSapo[0].id, source: "san-merchant" };
    return { storeId: fallback, source: "mac-dinh" };
  }
  const bySignal = signalStoreId(input.stores, order.sapoArea, order.sapoCashier);
  if (bySignal) return bySignal;
  return { storeId: fallback, source: "mac-dinh" };
}

/// "N2 - Trương Phước Phan" → "truong phuoc phan": the branch part of a store
/// name, which is what sàn files print ("Nhà Coffee&Tea - Trương Phước Phan").
export function storeLocationKey(name: string) {
  return foldSignal(String(name || "").replace(/^\s*N\s*\d+\s*[-–:]\s*/i, ""));
}

export type ReportStore = { store: CloudStore; inSapo: boolean; merchantId?: string; via: "id" | "branch" | "name" };

/// The store that produced a sàn report (or one row of it).
/// 1. The branch named in the file — Grab and GreenSM print "<brand> - <branch>",
///    and N2 is registered as a new branch under N1's owner account, so its
///    merchant id may be shared while the branch name never is.
/// 2. The merchant id (Shopee/GreenSM "ID cửa hàng", Grab file name): both
///    Shopee stores call themselves "NHÀ Coffee & Tea", only the id differs.
/// 3. An account name configured verbatim, when exactly one store claims it.
/// A branch with no account configured for that sàn yet counts as outside SAPO
/// unless it is the default outlet (N2's sàn stores are not linked to SAPO).
export function storeForReport(stores: CloudStore[], platform: string, merchantId?: string, storeName?: string): ReportStore | undefined {
  const accountsOf = (store: CloudStore) => (store.platformAccounts || []).filter((account) => account.platform === platform);
  const nameKey = foldSignal(storeName);
  const branches = nameKey ? outletsOf(stores).filter((store) => { const key = storeLocationKey(store.name); return key.length >= 4 && nameKey.includes(key); }) : [];
  const branch = branches.length === 1 ? branches[0] : undefined;
  const idKey = foldSignal(merchantId);
  const byId = idKey ? stores.flatMap((store) => accountsOf(store).filter((account) => foldSignal(account.merchantId) === idKey).map((account) => ({ store, account }))) : [];
  const idHit = branch ? byId.find((entry) => entry.store.id === branch.id) : byId[0];
  if (idHit) return { store: idHit.store, inSapo: idHit.account.inSapo, merchantId: merchantId || idHit.account.merchantId, via: "id" };
  if (branch) {
    const account = accountsOf(branch)[0];
    return { store: branch, inSapo: account ? account.inSapo : branch.id === defaultOutletId(stores), merchantId: merchantId || account?.merchantId, via: "branch" };
  }
  const byName = nameKey ? stores.flatMap((store) => accountsOf(store).filter((account) => account.name && foldSignal(account.name) === nameKey).map((account) => ({ store, account }))) : [];
  if (byName.length === 1) return { store: byName[0].store, inSapo: byName[0].account.inSapo, merchantId: merchantId || byName[0].account.merchantId, via: "name" };
  return undefined;
}

/// Long, 30/10/2026: a cost named "N2 - …" / "N2-…" belongs to N2. Matches the
/// "N<k>" prefix of an outlet's name; anything else stays Toàn chuỗi.
export function storeFromExpenseName(stores: CloudStore[], name: string) {
  const prefix = String(name || "").normalize("NFC").match(/^\s*(N\s*\d+)\s*-/i)?.[1].replace(/\s+/g, "").toUpperCase();
  if (!prefix) return undefined;
  return outletsOf(stores).find((store) => store.name.normalize("NFC").match(/^\s*(N\s*\d+)\s*[-–:]/i)?.[1].replace(/\s+/g, "").toUpperCase() === prefix)?.id;
}

/// Every distinct Khu vực / Thu ngân seen in SAPO that no store claims, so a new
/// cashier account or area shows up as a warning instead of silently landing in
/// the default outlet.
export function unclaimedSignals(stores: CloudStore[], orders: Array<{ sapoArea?: string; sapoCashier?: string; orderDate: string }>, ignoredCashiers: string[] = []) {
  const claimedAreas = new Set(stores.flatMap((store) => (store.sapoAreas || []).map(foldSignal)));
  const claimedCashiers = new Set(stores.flatMap((store) => (store.sapoCashiers || []).map(foldSignal)));
  const ignored = new Set(ignoredCashiers.map(foldSignal));
  const areas = new Map<string, number>();
  const cashiers = new Map<string, number>();
  for (const order of orders) {
    if (outletsOpenOn(stores, order.orderDate).length < 2) continue;
    if (order.sapoArea && !claimedAreas.has(foldSignal(order.sapoArea))) areas.set(order.sapoArea, (areas.get(order.sapoArea) || 0) + 1);
    if (!order.sapoArea && order.sapoCashier && !claimedCashiers.has(foldSignal(order.sapoCashier)) && !ignored.has(foldSignal(order.sapoCashier))) cashiers.set(order.sapoCashier, (cashiers.get(order.sapoCashier) || 0) + 1);
  }
  return { areas: [...areas.entries()].map(([value, count]) => ({ value, count })), cashiers: [...cashiers.entries()].map(([value, count]) => ({ value, count })) };
}

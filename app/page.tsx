"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import type { Session } from "@supabase/supabase-js";
import FinanceModule from "@/app/finance-module";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { createActiveSession, loadInventory, migrateLocalLifecycle, removeInventory, saveInventory, updateActiveSession } from "@/lib/inventory-store";

type Receipt = { name: string; dataUrl?: string; path?: string };
type Change = { field: string; from: string; to: string };
type HistoryEvent = { id: string; at: string; action: "created" | "updated"; changes: Change[] };
type Ingredient = {
  id: string; name: string; category: string; brand: string; unit: string; quantity: number; specification: string;
  unitCost: number; purchasedOn: string; supplier: string; receiptCode?: string; receipt?: Receipt; history: HistoryEvent[];
};
type ShelfLifeUnit = "minutes" | "hours" | "days" | "weeks";
type FormValues = { name: string; category: string; brand: string; invoiceCode: string; unit: string; quantity: string; specificationAmount: string; specificationUnit: string; specificationNote: string; unitCost: string; purchasedOn: string; supplier: string; expiresOn: string; shelfLifeValue: string; shelfLifeUnit: ShelfLifeUnit; storageLocation: string };
type SortKey = "purchasedOn" | "name" | "quantity" | "unitCost" | "total";
type LotMeta = { expiresOn: string; shelfLifeHours?: number; storageLocation: string };
type ActiveStatus = "active" | "used" | "wasted";
type ActiveSession = { id: string; sourceReceiptId: string; ingredientKey: string; activatedAt: string; costRecognitionMonth?: string; useBy?: string; status: ActiveStatus; closedAt?: string; reason: string; note?: string };
type IngredientGroup = { key: string; name: string; category: string; brand: string; unit: string; specification: string; lots: Ingredient[] };
type ActivationCandidate = { group: IngredientGroup; lot: Ingredient };
type CloseCandidate = { session: ActiveSession; status: "used" | "wasted" };
type LifecycleFilter = "active" | "soon" | "overdue" | "loss";

const STORAGE_KEY = "nha-ops-inventory-v1";
const ACTIVE_STORAGE_KEY = "nha-ops-active-uat-v1";
const LOT_META_STORAGE_KEY = "nha-ops-lot-meta-uat-v1";
const LOCAL_UAT_STORAGE_KEY = "nha-ops-inventory-local-uat-v1";
const LOCAL_UAT_ACTIVE_STORAGE_KEY = "nha-ops-active-local-uat-v1";
const LOCAL_UAT_META_STORAGE_KEY = "nha-ops-meta-local-uat-v1";
const LOCAL_UAT_AUTH_KEY = "nha-ops-auth-local-uat-v1";
const CLOUD_MIGRATION_KEY = "nha-ops-lifecycle-cloud-v1";
const WASTE_ALLOWANCE_STORAGE_KEY = "nha-ops-waste-allowance-v1";
const IS_LOCAL_UAT = process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_UAT_MODE === "true";
const formDefaults = (): FormValues => { const purchasedOn = new Date().toISOString().slice(0, 10); return { name: "", category: "", brand: "", invoiceCode: "", unit: "chai", quantity: "", specificationAmount: "", specificationUnit: "ml", specificationNote: "", unitCost: "", purchasedOn, supplier: "", expiresOn: defaultExpiryFor(purchasedOn), shelfLifeValue: "", shelfLifeUnit: "days", storageLocation: "Tủ mát" }; };
const fieldLabels: Record<string, string> = { name: "Tên NVL", category: "Category", brand: "Thương hiệu", receiptCode: "Mã hóa đơn", unit: "Đơn vị", quantity: "SL tổng", specification: "Định lượng", unitCost: "Đơn giá", purchasedOn: "Ngày mua", supplier: "Nhà cung cấp", receipt: "Hóa đơn" };
const activationReasons = [
  ["additional_peak", "Giờ cao điểm, cần mở thêm"], ["additional_station", "Dùng tại quầy/khu vực khác"], ["additional_recipe", "Dùng cho món hoặc công thức khác"], ["additional_batch", "Chuẩn bị batch trước giờ bán"], ["additional_insufficient", "Hộp đang mở không đủ cho đơn hiện tại"], ["additional_quality", "Kiểm tra chất lượng hoặc thử món"], ["other", "Lý do khác"],
] as const;
const closeReasons = [
  ["used_up", "Đã sử dụng hết"], ["expired", "Hết hạn sau khi mở"], ["spoiled", "Có dấu hiệu hư hỏng"], ["spill", "Đổ vỡ hoặc rơi"], ["contaminated", "Nhiễm bẩn khi sử dụng"], ["temperature", "Bảo quản sai nhiệt độ"], ["package", "Bao bì rách, phồng hoặc rò rỉ"], ["quality", "Chất lượng hoặc hương vị bất thường"], ["recipe_error", "Pha chế sai công thức"], ["training", "Dùng thử hoặc đào tạo"], ["variance", "Sai lệch kiểm kê"], ["other", "Lý do khác"],
] as const;

function formatMoney(value: number) { return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value); }
function formatDate(date: string) { const [year, month, day] = date.split("-"); return year && month && day ? `${day}/${month}/${year}` : date; }
function parseVietnameseDate(value: string) { const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (!match) return undefined; const [, day, month, year] = match; const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))); if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return undefined; return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`; }
function formatTime(value: string) { return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatPriceInput(value: string) { const digits = value.replace(/\D/g, ""); return digits ? Number(digits).toLocaleString("en-US") : ""; }
function parsePrice(value: string) { return Number(value.replace(/\D/g, "")); }
function parseSpecification(value: string) { const match = value.trim().match(/^([\d.,]+)\s*(ml|l|g|kg|mg|oz|cái|viên|phần)\b\s*(.*)$/i); if (!match) return { amount: "", unit: "ml", note: value === "Chưa ghi định lượng" ? "" : value }; return { amount: match[1], unit: match[2].toLowerCase(), note: match[3] }; }
function buildSpecification(amount: string, unit: string, note: string) { const core = amount.trim() ? `${amount.trim()} ${unit}` : ""; return [core, note.trim()].filter(Boolean).join(" ") || "Chưa ghi định lượng"; }
function ingredientKey(item: Pick<Ingredient, "name" | "brand" | "unit" | "specification">) { return [item.name, item.brand, item.unit, item.specification].map((value) => value.trim().toLocaleLowerCase("vi")).join("|"); }
function addDays(value: string, days: number) { const [year, month, day] = value.split("-").map(Number); if (!year || !month || !day) return ""; const date = new Date(Date.UTC(year, month - 1, day)); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function defaultExpiryFor(purchasedOn: string) { return addDays(purchasedOn, 1); }
function addHours(value: string, hours: number) { return new Date(new Date(value).getTime() + hours * 60 * 60 * 1000).toISOString(); }
function endOfDate(value: string) { return value ? new Date(`${value}T23:59:59`).toISOString() : undefined; }
function useByFor(activatedAt: string, meta?: LotMeta) { const openedLimit = meta?.shelfLifeHours ? addHours(activatedAt, meta.shelfLifeHours) : undefined; const expiryLimit = endOfDate(meta?.expiresOn || ""); if (openedLimit && expiryLimit) return openedLimit < expiryLimit ? openedLimit : expiryLimit; return openedLimit || expiryLimit; }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatDuration(milliseconds: number) { const absolute = Math.abs(milliseconds); const hours = Math.floor(absolute / 3_600_000); if (hours < 24) return `${hours} giờ`; const days = Math.floor(hours / 24); const rest = hours % 24; return rest ? `${days} ngày ${rest} giờ` : `${days} ngày`; }
function reasonLabel(value: string) { return [...activationReasons, ...closeReasons].find(([key]) => key === value)?.[1] || value; }
function shelfLifeLabel(hours?: number) { if (!hours) return "Chưa ghi"; if (hours % 168 === 0) return `${hours / 168} tuần`; if (hours % 24 === 0) return `${hours / 24} ngày`; if (hours >= 1) return `${hours} giờ`; return `${Math.round(hours * 60)} phút`; }
function shelfLifeFormValues(hours?: number): { value: string; unit: ShelfLifeUnit } { if (!hours) return { value: "", unit: "days" }; if (hours % 168 === 0) return { value: String(hours / 168), unit: "weeks" }; if (hours % 24 === 0) return { value: String(hours / 24), unit: "days" }; if (hours >= 1) return { value: String(hours), unit: "hours" }; return { value: String(hours * 60), unit: "minutes" }; }
function shelfLifeHoursFor(value: string, unit: ShelfLifeUnit) { const amount = Number(value); if (!amount) return undefined; return amount * ({ minutes: 1 / 60, hours: 1, days: 24, weeks: 168 } as const)[unit]; }
function escapeXml(value: string) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function VietnameseDateInput({ value, onChange, required = false }: { value: string; onChange: (value: string) => void; required?: boolean }) {
  const [display, setDisplay] = useState(formatDate(value));
  useEffect(() => setDisplay(formatDate(value)), [value]);
  function commit() { const parsed = parseVietnameseDate(display); if (parsed) { onChange(parsed); setDisplay(formatDate(parsed)); } else setDisplay(formatDate(value)); }
  return <input required={required} type="text" inputMode="numeric" value={display} onChange={(event) => setDisplay(event.target.value)} onBlur={commit} placeholder="dd/mm/yyyy" aria-label="Ngày theo định dạng dd/mm/yyyy" />;
}
function safeItems(value: unknown): Ingredient[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    ...item, category: typeof item.category === "string" ? item.category : "Chưa phân loại",
    brand: typeof item.brand === "string" ? item.brand : "Chưa ghi thương hiệu",
    specification: typeof item.specification === "string" ? item.specification : "Chưa ghi định lượng",
    history: Array.isArray(item.history) ? item.history : [{ id: crypto.randomUUID(), at: new Date().toISOString(), action: "created", changes: [] }],
  }));
}
function seedInventoryUat(): { items: Ingredient[]; lotMeta: Record<string, LotMeta>; activeSessions: ActiveSession[] } {
  const today = new Date().toISOString().slice(0, 10);
  const atHours = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
  const receiptPreview = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='1100'%3E%3Crect width='100%25' height='100%25' fill='%23fffdf6'/%3E%3Ctext x='50%25' y='46%25' text-anchor='middle' font-family='Arial' font-size='54' fill='%231e4b3f'%3EHOA DON UAT%3C/text%3E%3Ctext x='50%25' y='53%25' text-anchor='middle' font-family='Arial' font-size='30' fill='%2371786e'%3ENHA COFFEE %26 TEA%3C/text%3E%3C/svg%3E";
  const created = (id: string, purchasedOn: string): HistoryEvent[] => [{ id: `${id}-history`, at: `${purchasedOn}T08:00:00.000Z`, action: "created", changes: [] }];
  const items: Ingredient[] = [
    { id: "uat-lot-milk", name: "Sữa tươi không đường", category: "Sữa", brand: "Dalat Milk", unit: "hộp", quantity: 5, specification: "1 l", unitCost: 34_000, purchasedOn: addDays(today, -2), supplier: "WinMart", receiptCode: "UAT-MILK-001", receipt: { name: "hoa-don-sua-tuoi-uat.jpg", dataUrl: receiptPreview }, history: created("uat-lot-milk", addDays(today, -2)) },
    { id: "uat-lot-syrup", name: "Syrup dâu", category: "Syrup", brand: "Monin", unit: "chai", quantity: 3, specification: "700 ml", unitCost: 198_000, purchasedOn: addDays(today, -4), supplier: "Nhất Hương", receiptCode: "UAT-SYRUP-002", receipt: { name: "hoa-don-syrup-uat.jpg", dataUrl: receiptPreview }, history: created("uat-lot-syrup", addDays(today, -4)) },
    { id: "uat-lot-tea", name: "Trà lài", category: "Trà", brand: "Phúc Long", unit: "túi", quantity: 2, specification: "500 g", unitCost: 165_000, purchasedOn: addDays(today, -7), supplier: "Phúc Long Coffee & Tea", receiptCode: "UAT-TEA-003", receipt: { name: "hoa-don-tra-lai-uat.jpg", dataUrl: receiptPreview }, history: created("uat-lot-tea", addDays(today, -7)) },
    { id: "uat-lot-cream", name: "Sữa béo", category: "Sữa", brand: "Rich's", unit: "hộp", quantity: 4, specification: "1 l", unitCost: 82_000, purchasedOn: addDays(today, -5), supplier: "Nhất Hương", receiptCode: "UAT-CREAM-004", receipt: { name: "hoa-don-sua-beo-uat.jpg", dataUrl: receiptPreview }, history: created("uat-lot-cream", addDays(today, -5)) },
  ];
  return {
    items,
    lotMeta: {
      "uat-lot-milk": { expiresOn: addDays(today, 5), shelfLifeHours: 72, storageLocation: "Tủ mát" },
      "uat-lot-syrup": { expiresOn: addDays(today, 180), shelfLifeHours: 720, storageLocation: "Kho khô" },
      "uat-lot-tea": { expiresOn: addDays(today, 120), shelfLifeHours: 168, storageLocation: "Kho khô" },
      "uat-lot-cream": { expiresOn: addDays(today, 14), shelfLifeHours: 48, storageLocation: "Tủ mát" },
    },
    activeSessions: [
      { id: "uat-active-milk", sourceReceiptId: "uat-lot-milk", ingredientKey: ingredientKey(items[0]), activatedAt: atHours(-30), useBy: atHours(42), status: "active", reason: "first_open", note: "Dữ liệu mẫu UAT" },
      { id: "uat-used-tea", sourceReceiptId: "uat-lot-tea", ingredientKey: ingredientKey(items[2]), activatedAt: atHours(-96), useBy: atHours(72), status: "used", closedAt: atHours(-60), reason: "used_up", note: "Dữ liệu mẫu UAT" },
      { id: "uat-waste-cream", sourceReceiptId: "uat-lot-cream", ingredientKey: ingredientKey(items[3]), activatedAt: atHours(-72), useBy: atHours(-24), status: "wasted", closedAt: atHours(-36), reason: "temperature", note: "Tủ mát mất điện - dữ liệu mẫu UAT" },
    ],
  };
}
function changesFor(item: Ingredient, next: Omit<Ingredient, "id" | "history">): Change[] {
  const pairs: Array<[keyof Omit<Ingredient, "id" | "history">, string, string]> = [
    ["name", item.name, next.name], ["category", item.category, next.category], ["brand", item.brand, next.brand], ["receiptCode", item.receiptCode || "Chưa có", next.receiptCode || "Chưa có"], ["unit", item.unit, next.unit], ["quantity", String(item.quantity), String(next.quantity)], ["specification", item.specification, next.specification], ["unitCost", String(item.unitCost), String(next.unitCost)], ["purchasedOn", item.purchasedOn, next.purchasedOn], ["supplier", item.supplier, next.supplier], ["receipt", item.receipt?.name || "Không có", next.receipt?.name || "Không có"],
  ];
  return pairs.filter(([, from, to]) => from !== to).map(([field, from, to]) => ({ field: String(field), from, to }));
}

export default function Home() {
  const [items, setItems] = useState<Ingredient[]>([]);
  const [form, setForm] = useState<FormValues>(formDefaults);
  const [receipt, setReceipt] = useState<Receipt | undefined>();
  const [receiptFile, setReceiptFile] = useState<File | undefined>();
  const [session, setSession] = useState<Session | null>(null);
  const [uatAuthenticated, setUatAuthenticated] = useState(false);
  const [loginEmail, setLoginEmail] = useState(IS_LOCAL_UAT ? "UAT" : "");
  const [loginPassword, setLoginPassword] = useState(IS_LOCAL_UAT ? "Giang21c" : "");
  const [authError, setAuthError] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [lotMeta, setLotMeta] = useState<Record<string, LotMeta>>({});
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [wasteAllowance, setWasteAllowance] = useState("4");
  const [wasteAllowanceLoaded, setWasteAllowanceLoaded] = useState(false);
  const [cloudLifecycleReady, setCloudLifecycleReady] = useState(false);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [historyItem, setHistoryItem] = useState<Ingredient | undefined>();
  const [detailGroup, setDetailGroup] = useState<IngredientGroup | undefined>();
  const [detailLot, setDetailLot] = useState<Ingredient | undefined>();
  const [activationCandidate, setActivationCandidate] = useState<ActivationCandidate | undefined>();
  const [activationReason, setActivationReason] = useState("");
  const [activationNote, setActivationNote] = useState("");
  const [activationCostMonth, setActivationCostMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [closeCandidate, setCloseCandidate] = useState<CloseCandidate | undefined>();
  const [closeReason, setCloseReason] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [workspace, setWorkspace] = useState<"inventory" | "finance">("inventory");
  const [tab, setTab] = useState<"inventory" | "active" | "report">("inventory");
  const [inventoryView, setInventoryView] = useState<"stock" | "used">("stock");
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>("active");
  const [search, setSearch] = useState("");
  const [reportSearch, setReportSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [brandFilter, setBrandFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "purchasedOn", direction: "desc" });
  const [loaded, setLoaded] = useState(false);
  const [deletingId, setDeletingId] = useState<string | undefined>();
  const canDeleteInventory = IS_LOCAL_UAT || session?.user.email?.toLocaleLowerCase() === "cfo@nhacoffeentea.com";
  const canAccessFinance = IS_LOCAL_UAT ? uatAuthenticated : !isSupabaseConfigured || Boolean(session);

  function loadLocalUatInventory() {
    const seed = seedInventoryUat();
    const storedItems = window.localStorage.getItem(LOCAL_UAT_STORAGE_KEY);
    const storedActive = window.localStorage.getItem(LOCAL_UAT_ACTIVE_STORAGE_KEY);
    const storedMeta = window.localStorage.getItem(LOCAL_UAT_META_STORAGE_KEY);
    setItems(storedItems ? safeItems(JSON.parse(storedItems)) : seed.items);
    setActiveSessions(storedActive ? JSON.parse(storedActive) as ActiveSession[] : seed.activeSessions);
    setLotMeta(storedMeta ? JSON.parse(storedMeta) as Record<string, LotMeta> : seed.lotMeta);
    setCloudLifecycleReady(false);
    setLoaded(true);
  }
  function resetLocalUatInventory() {
    if (!window.confirm("Nạp lại dữ liệu mẫu Kho NVL? Các thay đổi UAT local hiện tại sẽ mất.")) return;
    window.localStorage.removeItem(LOCAL_UAT_STORAGE_KEY);
    window.localStorage.removeItem(LOCAL_UAT_ACTIVE_STORAGE_KEY);
    window.localStorage.removeItem(LOCAL_UAT_META_STORAGE_KEY);
    const seed = seedInventoryUat();
    setItems(seed.items);
    setActiveSessions(seed.activeSessions);
    setLotMeta(seed.lotMeta);
    setDetailGroup(undefined);
    setDetailLot(undefined);
  }

  async function refreshCloud() {
    try {
      if (IS_LOCAL_UAT) { loadLocalUatInventory(); return; }
      let cloud = await loadInventory();
      if (cloud.lifecycleReady && !window.localStorage.getItem(CLOUD_MIGRATION_KEY)) {
        const storedActive = JSON.parse(window.localStorage.getItem(ACTIVE_STORAGE_KEY) || "[]") as ActiveSession[];
        const storedMeta = JSON.parse(window.localStorage.getItem(LOT_META_STORAGE_KEY) || "{}") as Record<string, LotMeta>;
        const validIds = new Set(cloud.items.map((item) => item.id));
        const validMeta = Object.fromEntries(Object.entries(storedMeta).filter(([id]) => validIds.has(id)));
        const validActive = storedActive.filter((activeSession) => validIds.has(activeSession.sourceReceiptId));
        if (Object.keys(validMeta).length || validActive.length) { await migrateLocalLifecycle(validMeta, validActive); cloud = await loadInventory(); }
        window.localStorage.setItem(CLOUD_MIGRATION_KEY, "done");
        window.localStorage.removeItem(ACTIVE_STORAGE_KEY);
        window.localStorage.removeItem(LOT_META_STORAGE_KEY);
      }
      setItems(safeItems(cloud.items));
      setCloudLifecycleReady(cloud.lifecycleReady);
      if (cloud.lifecycleReady) { setLotMeta(cloud.lotMeta); setActiveSessions(cloud.activeSessions); }
      else {
        setLotMeta(JSON.parse(window.localStorage.getItem(LOT_META_STORAGE_KEY) || "{}"));
        setActiveSessions(JSON.parse(window.localStorage.getItem(ACTIVE_STORAGE_KEY) || "[]"));
      }
    } finally { setLoaded(true); }
  }
  useEffect(() => {
    if (IS_LOCAL_UAT) {
      loadLocalUatInventory();
      setUatAuthenticated(window.sessionStorage.getItem(LOCAL_UAT_AUTH_KEY) === "authenticated");
      return;
    }
    if (!isSupabaseConfigured || !supabase) { const stored = window.localStorage.getItem(STORAGE_KEY); if (stored) setItems(safeItems(JSON.parse(stored))); setActiveSessions(JSON.parse(window.localStorage.getItem(ACTIVE_STORAGE_KEY) || "[]")); setLotMeta(JSON.parse(window.localStorage.getItem(LOT_META_STORAGE_KEY) || "{}")); setLoaded(true); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); if (data.session) refreshCloud(); else setLoaded(true); });
    return supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); if (nextSession) refreshCloud(); }).data.subscription.unsubscribe;
  }, []);
  useEffect(() => { if (loaded && (IS_LOCAL_UAT || !isSupabaseConfigured)) window.localStorage.setItem(IS_LOCAL_UAT ? LOCAL_UAT_STORAGE_KEY : STORAGE_KEY, JSON.stringify(items)); }, [items, loaded]);
  useEffect(() => { if (loaded && !cloudLifecycleReady) window.localStorage.setItem(IS_LOCAL_UAT ? LOCAL_UAT_ACTIVE_STORAGE_KEY : ACTIVE_STORAGE_KEY, JSON.stringify(activeSessions)); }, [activeSessions, loaded, cloudLifecycleReady]);
  useEffect(() => { if (loaded && !cloudLifecycleReady) window.localStorage.setItem(IS_LOCAL_UAT ? LOCAL_UAT_META_STORAGE_KEY : LOT_META_STORAGE_KEY, JSON.stringify(lotMeta)); }, [lotMeta, loaded, cloudLifecycleReady]);
  useEffect(() => { const stored = window.localStorage.getItem(WASTE_ALLOWANCE_STORAGE_KEY); if (stored) setWasteAllowance(stored); setWasteAllowanceLoaded(true); }, []);
  useEffect(() => { if (wasteAllowanceLoaded) window.localStorage.setItem(WASTE_ALLOWANCE_STORAGE_KEY, wasteAllowance); }, [wasteAllowance, wasteAllowanceLoaded]);

  const totalValue = items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
  const wastedValue = activeSessions.filter((activeSession) => activeSession.status === "wasted").reduce((sum, activeSession) => sum + (items.find((item) => item.id === activeSession.sourceReceiptId)?.unitCost || 0), 0);
  const wasteRate = totalValue ? (wastedValue / totalValue) * 100 : 0;
  const wasteAllowancePercent = Math.max(0, Number(wasteAllowance) || 0);
  const isWasteOverAllowance = wasteRate > wasteAllowancePercent;
  const ingredientGroups = useMemo<IngredientGroup[]>(() => {
    const grouped = new Map<string, IngredientGroup>();
    for (const item of items) {
      const key = ingredientKey(item);
      const existing = grouped.get(key);
      if (existing) existing.lots.push(item);
      else grouped.set(key, { key, name: item.name, category: item.category, brand: item.brand, unit: item.unit, specification: item.specification, lots: [item] });
    }
    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name, "vi"));
  }, [items]);
  const filteredGroups = useMemo(() => ingredientGroups.filter((group) => `${group.name} ${group.category} ${group.brand} ${group.lots.map((lot) => lot.supplier).join(" ")}`.toLowerCase().includes(search.toLowerCase())), [ingredientGroups, search]);
  const openSessions = useMemo(() => activeSessions.filter((session) => session.status === "active"), [activeSessions]);
  const wastedSessions = useMemo(() => activeSessions.filter((session) => session.status === "wasted"), [activeSessions]);
  const inventoryGroups = useMemo(() => filteredGroups.filter((group) => {
    const sealed = group.lots.reduce((sum, lot) => sum + Math.max(0, lot.quantity - activeSessions.filter((session) => session.sourceReceiptId === lot.id).length), 0);
    const active = activeSessions.some((session) => session.status === "active" && (items.find((item) => item.id === session.sourceReceiptId) ? ingredientKey(items.find((item) => item.id === session.sourceReceiptId)!) === group.key : session.ingredientKey === group.key));
    return inventoryView === "stock" ? sealed > 0 || active : sealed === 0 && !active;
  }), [filteredGroups, inventoryView, activeSessions, items]);
  const selectedGroup = detailGroup ? ingredientGroups.find((group) => group.key === detailGroup.key) || detailGroup : undefined;
  const now = Date.now();
  const expiringSoonCount = openSessions.filter((session) => session.useBy && new Date(session.useBy).getTime() >= now && new Date(session.useBy).getTime() - now <= 86_400_000).length;
  const overdueCount = openSessions.filter((session) => session.useBy && new Date(session.useBy).getTime() < now).length;
  const lifecycleDashboard = useMemo(() => {
    if (lifecycleFilter === "soon") return openSessions.filter((activeSession) => activeSession.useBy && new Date(activeSession.useBy).getTime() >= now && new Date(activeSession.useBy).getTime() - now <= 86_400_000).sort((a, b) => (a.useBy || "9999").localeCompare(b.useBy || "9999"));
    if (lifecycleFilter === "overdue") return openSessions.filter((activeSession) => activeSession.useBy && new Date(activeSession.useBy).getTime() < now).sort((a, b) => (a.useBy || "9999").localeCompare(b.useBy || "9999"));
    if (lifecycleFilter === "loss") return [...wastedSessions].sort((a, b) => (items.find((item) => item.id === b.sourceReceiptId)?.unitCost || 0) - (items.find((item) => item.id === a.sourceReceiptId)?.unitCost || 0));
    return [...openSessions].sort((a, b) => (a.useBy || "9999").localeCompare(b.useBy || "9999"));
  }, [lifecycleFilter, openSessions, wastedSessions, items, now]);
  const lifecycleHeading: Record<LifecycleFilter, [string, string]> = {
    active: ["Đang active", "Tất cả nguyên liệu đang được mở để sử dụng"],
    soon: ["Sắp hạn trong 24 giờ", "Ưu tiên sử dụng trước khi chất lượng giảm"],
    overdue: ["Đã quá hạn", "Cần kiểm tra và xử lý ngay"],
    loss: ["Hao hụt đã ghi nhận", "Sắp xếp theo giá trị hao hụt cao nhất"],
  };
  const suppliers = useMemo(() => [...new Set(items.map((item) => item.supplier))].sort(), [items]);
  const categories = useMemo(() => [...new Set(items.map((item) => item.category))].sort(), [items]);
  const brands = useMemo(() => [...new Set(items.map((item) => item.brand))].sort(), [items]);
  const reportRows = useMemo(() => {
    const result = items.filter((item) => `${item.name} ${item.category} ${item.brand} ${item.supplier}`.toLowerCase().includes(reportSearch.toLowerCase()) && (supplierFilter === "all" || item.supplier === supplierFilter) && (categoryFilter === "all" || item.category === categoryFilter) && (brandFilter === "all" || item.brand === brandFilter) && (!dateFrom || item.purchasedOn >= dateFrom) && (!dateTo || item.purchasedOn <= dateTo));
    return [...result].sort((a, b) => {
      const values: Record<SortKey, [string | number, string | number]> = { purchasedOn: [a.purchasedOn, b.purchasedOn], name: [a.name, b.name], quantity: [a.quantity, b.quantity], unitCost: [a.unitCost, b.unitCost], total: [a.quantity * a.unitCost, b.quantity * b.unitCost] };
      const [left, right] = values[sort.key]; const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), "vi");
      return sort.direction === "asc" ? order : -order;
    });
  }, [items, reportSearch, supplierFilter, categoryFilter, brandFilter, dateFrom, dateTo, sort]);

  function updateForm<K extends keyof FormValues>(field: K, value: FormValues[K]) { setForm((current) => ({ ...current, [field]: value })); }
  function updatePurchasedOn(purchasedOn: string) {
    setForm((current) => ({
      ...current,
      purchasedOn,
      // Keep a manually chosen expiry date, but move the automatic one with the purchase date.
      expiresOn: !current.expiresOn || current.expiresOn === defaultExpiryFor(current.purchasedOn) ? defaultExpiryFor(purchasedOn) : current.expiresOn,
    }));
  }
  function takenFromLot(lotId: string) { return activeSessions.filter((session) => session.sourceReceiptId === lotId).length; }
  function activeFromLot(lotId: string) { return openSessions.filter((session) => session.sourceReceiptId === lotId).length; }
  function sealedInLot(lot: Ingredient) { return Math.max(0, lot.quantity - takenFromLot(lot.id)); }
  function sealedInGroup(group: IngredientGroup) { return group.lots.reduce((sum, lot) => sum + sealedInLot(lot), 0); }
  function activeInGroup(group: IngredientGroup) { return openSessions.filter((activeSession) => { const source = items.find((item) => item.id === activeSession.sourceReceiptId); return source ? ingredientKey(source) === group.key : activeSession.ingredientKey === group.key; }); }
  function wastedInGroup(group: IngredientGroup) { return wastedSessions.filter((activeSession) => { const source = items.find((item) => item.id === activeSession.sourceReceiptId); return source ? ingredientKey(source) === group.key : activeSession.ingredientKey === group.key; }); }
  async function activate(group: IngredientGroup, lot: Ingredient, reason: string, costRecognitionMonth: string, note = "") {
    const activatedAt = new Date().toISOString();
    const nextSession: ActiveSession = { id: crypto.randomUUID(), sourceReceiptId: lot.id, ingredientKey: group.key, activatedAt, costRecognitionMonth, useBy: useByFor(activatedAt, lotMeta[lot.id]), status: "active", reason, note: note.trim() || undefined };
    setActiveSessions((current) => [nextSession, ...current]);
    setActivationCandidate(undefined); setActivationReason(""); setActivationNote(""); setActivationCostMonth(new Date().toISOString().slice(0, 7));
    if (cloudLifecycleReady && session) { try { await createActiveSession(nextSession); await refreshCloud(); } catch (error) { await refreshCloud(); window.alert(error instanceof Error ? error.message : "Không thể đồng bộ lần mở nguyên liệu."); } }
  }
  function requestActivation(group: IngredientGroup, lot: Ingredient) {
    if (sealedInLot(lot) < 1) return;
    setActivationCandidate({ group, lot });
    setActivationReason(activeInGroup(group).length ? "" : "first_open");
    setActivationNote("");
    setActivationCostMonth(new Date().toISOString().slice(0, 7));
  }
  async function confirmActivation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activationCandidate || !activationReason || !activationCostMonth) return;
    const purchaseMonth = activationCandidate.lot.purchasedOn.slice(0, 7);
    const currentMonth = new Date().toISOString().slice(0, 7);
    if (activationCostMonth < purchaseMonth || activationCostMonth > currentMonth) {
      window.alert(`Tháng ghi nhận chi phí phải từ tháng mua ${purchaseMonth.split("-").reverse().join("/")} đến tháng hiện tại.`);
      return;
    }
    const previous = activeInGroup(activationCandidate.group).sort((a, b) => a.activatedAt.localeCompare(b.activatedAt))[0];
    let updatedPrevious: ActiveSession | undefined;
    if (previous && activationReason === "previous_used") updatedPrevious = { ...previous, status: "used", closedAt: new Date().toISOString(), reason: "used_up" };
    if (previous && activationReason.startsWith("previous_waste_")) updatedPrevious = { ...previous, status: "wasted", closedAt: new Date().toISOString(), reason: activationReason.replace("previous_waste_", ""), note: activationNote.trim() || previous.note };
    if (updatedPrevious) {
      setActiveSessions((current) => current.map((activeSession) => activeSession.id === updatedPrevious!.id ? updatedPrevious! : activeSession));
      if (cloudLifecycleReady && session) { try { await updateActiveSession(updatedPrevious); } catch (error) { await refreshCloud(); window.alert(error instanceof Error ? error.message : "Không thể cập nhật hộp đang active."); return; } }
    }
    await activate(activationCandidate.group, activationCandidate.lot, activationReason, activationCostMonth, activationNote);
  }
  function requestClose(session: ActiveSession, status: "used" | "wasted") { setCloseCandidate({ session, status }); setCloseReason(status === "used" ? "used_up" : ""); setCloseNote(""); }
  async function confirmClose(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!closeCandidate || !closeReason) return; const updated: ActiveSession = { ...closeCandidate.session, status: closeCandidate.status, closedAt: new Date().toISOString(), reason: closeReason, note: closeNote.trim() || closeCandidate.session.note }; setActiveSessions((current) => current.map((activeSession) => activeSession.id === updated.id ? updated : activeSession)); setCloseCandidate(undefined); setCloseReason(""); setCloseNote(""); if (cloudLifecycleReady && session) { try { await updateActiveSession(updated); await refreshCloud(); } catch (error) { await refreshCloud(); window.alert(error instanceof Error ? error.message : "Không thể đồng bộ trạng thái nguyên liệu."); } } }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSigningIn) return;

    setAuthError("");
    if (IS_LOCAL_UAT) {
      if (loginEmail.trim() === "UAT" && loginPassword === "Giang21c") {
        window.sessionStorage.setItem(LOCAL_UAT_AUTH_KEY, "authenticated");
        setUatAuthenticated(true);
      } else setAuthError("User hoặc mật khẩu UAT chưa đúng. Vui lòng thử lại.");
      return;
    }
    if (!supabase) return;
    setIsSigningIn(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmail.trim(),
      password: loginPassword,
    });
    setIsSigningIn(false);
    if (error) setAuthError("Tên đăng nhập hoặc mật khẩu chưa đúng. Vui lòng thử lại.");
  }
  function attachReceipt(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; setReceiptFile(file); const reader = new FileReader(); reader.onload = () => setReceipt({ name: file.name, dataUrl: String(reader.result) }); reader.readAsDataURL(file); }
  function openAdd() { setForm(formDefaults()); setReceipt(undefined); setReceiptFile(undefined); setEditingId(undefined); setShowForm(true); }
  function openEdit(item: Ingredient) { const meta = lotMeta[item.id]; const parsedSpecification = parseSpecification(item.specification); const shelfLife = shelfLifeFormValues(meta?.shelfLifeHours); setForm({ name: item.name, category: item.category, brand: item.brand, invoiceCode: item.receiptCode || "", unit: item.unit, quantity: String(item.quantity), specificationAmount: parsedSpecification.amount, specificationUnit: parsedSpecification.unit, specificationNote: parsedSpecification.note, unitCost: formatPriceInput(String(item.unitCost)), purchasedOn: item.purchasedOn, supplier: item.supplier, expiresOn: meta?.expiresOn || defaultExpiryFor(item.purchasedOn), shelfLifeValue: shelfLife.value, shelfLifeUnit: shelfLife.unit, storageLocation: meta?.storageLocation || "Tủ mát" }); setReceipt(item.receipt); setEditingId(item.id); setShowForm(true); }
  function closeForm() { setShowForm(false); setEditingId(undefined); }
  async function saveIngredient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const quantity = Number(form.quantity); const unitCost = parsePrice(form.unitCost);
    if (!form.name.trim() || !quantity || !unitCost) return;
    const current = editingId ? items.find((item) => item.id === editingId) : undefined;
    const enteredInvoiceCode = form.invoiceCode.trim();
    if (!current && !enteredInvoiceCode && !window.confirm("Chưa nhập mã hóa đơn. Bạn có đồng ý dùng mã tự tạo theo DDMMYY-STT làm mã hóa đơn và mã phiếu nhập kho không?")) return;
    const next = { name: form.name.trim(), category: form.category.trim() || "Chưa phân loại", brand: form.brand.trim() || "Chưa ghi thương hiệu", receiptCode: enteredInvoiceCode || current?.receiptCode, unit: form.unit, quantity, specification: buildSpecification(form.specificationAmount, form.specificationUnit, form.specificationNote), unitCost, purchasedOn: form.purchasedOn, supplier: form.supplier.trim() || "Chưa ghi nhà cung cấp", receipt };
    const changes = current ? changesFor(current, next) : [];
    const item: Ingredient = current ? { ...current, ...next, history: current.history } : { id: crypto.randomUUID(), ...next, history: [] };
    const eventRecord: HistoryEvent = { id: crypto.randomUUID(), at: new Date().toISOString(), action: current ? "updated" : "created", changes };
    const nextMeta: LotMeta = { expiresOn: form.expiresOn, shelfLifeHours: shelfLifeHoursFor(form.shelfLifeValue, form.shelfLifeUnit), storageLocation: form.storageLocation.trim() || "Chưa ghi" };
    const metaChanged = JSON.stringify(lotMeta[item.id] || {}) !== JSON.stringify(nextMeta);
    const updatedActive = current ? activeSessions
      .filter((activeSession) => activeSession.status === "active" && activeSession.sourceReceiptId === item.id)
      .map((activeSession) => ({ ...activeSession, ingredientKey: ingredientKey(item), useBy: useByFor(activeSession.activatedAt, nextMeta) })) : [];
    setLotMeta((metadata) => ({ ...metadata, [item.id]: nextMeta }));
    if (current && !changes.length && !metaChanged) { closeForm(); return; }
    if (updatedActive.length) setActiveSessions((sessions) => sessions.map((activeSession) => updatedActive.find((updated) => updated.id === activeSession.id) || activeSession));
    if (!IS_LOCAL_UAT && isSupabaseConfigured && session) {
      try {
        await saveInventory(item, eventRecord, receiptFile, cloudLifecycleReady ? nextMeta : undefined);
        if (cloudLifecycleReady && updatedActive.length) await Promise.all(updatedActive.map(updateActiveSession));
        await refreshCloud();
      } catch (error) {
        await refreshCloud();
        window.alert(error instanceof Error ? error.message : "Không thể lưu thay đổi lô nhập kho.");
        return;
      }
    } else setItems((all) => current ? all.map((entry) => entry.id === item.id ? { ...item, history: [eventRecord, ...entry.history] } : entry) : [{ ...item, history: [eventRecord] }, ...all]);
    closeForm();
  }
  async function removeItem(id: string) {
    if (!canDeleteInventory) {
      window.alert("Chỉ tài khoản CFO mới có quyền xóa lô nhập kho.");
      return;
    }
    if (takenFromLot(id) > 0) {
      window.alert("Không thể xóa phiếu này vì nguyên liệu đã từng được xuất sang Đang dùng. Phiếu chỉ xóa được khi chưa có lần xuất nào.");
      return;
    }
    if (!window.confirm("Xóa lô nhập kho này? Toàn bộ lịch sử, dữ liệu đã dùng/báo hỏng liên quan và dòng báo cáo sẽ bị xóa.")) return;
    if (IS_LOCAL_UAT) {
      setItems((current) => current.filter((item) => item.id !== id));
      setLotMeta((current) => Object.fromEntries(Object.entries(current).filter(([lotId]) => lotId !== id)));
      setActiveSessions((current) => current.filter((activeSession) => activeSession.sourceReceiptId !== id));
      setDetailLot((current) => current?.id === id ? undefined : current);
      setDetailGroup(undefined);
      return;
    }
    if (!isSupabaseConfigured || !session) {
      window.alert("Không thể xác nhận phiên đăng nhập. Vui lòng tải lại trang và đăng nhập lại.");
      return;
    }
    setDeletingId(id);
    try {
      await removeInventory(id);
      setDetailLot((current) => current?.id === id ? undefined : current);
      setDetailGroup(undefined);
      await refreshCloud();
    } catch (error) {
      try { await refreshCloud(); } catch { /* Preserve the original deletion error for the user. */ }
      window.alert(error instanceof Error ? error.message : "Không thể xóa lô nhập kho.");
    } finally {
      setDeletingId(undefined);
    }
  }
  function changeSort(key: SortKey) { setSort((current) => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }); }
  function sortMarker(key: SortKey) { return sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : " ↕"; }
  function exportReportExcel() {
    const stringCell = (value: string, style = "Text") => `<Cell ss:StyleID="${style}"><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
    const numberCell = (value: number, style = "Number") => `<Cell ss:StyleID="${style}"><Data ss:Type="Number">${value}</Data></Cell>`;
    const dateCell = (value: string) => value ? `<Cell ss:StyleID="Date"><Data ss:Type="DateTime">${value}T00:00:00.000</Data></Cell>` : stringCell("", "Date");
    const filterDescription = [reportSearch && `Từ khóa: ${reportSearch}`, supplierFilter !== "all" && `NCC: ${supplierFilter}`, categoryFilter !== "all" && `Category: ${categoryFilter}`, brandFilter !== "all" && `Thương hiệu: ${brandFilter}`, dateFrom && `Từ ngày: ${formatDate(dateFrom)}`, dateTo && `Đến ngày: ${formatDate(dateTo)}`].filter(Boolean).join(" | ") || "Tất cả dữ liệu";
    const headers = ["Mã phiếu", "Ngày mua", "Hạn sử dụng", "Nguyên liệu", "Category", "Thương hiệu", "Nhà cung cấp", "SL nhập", "Đơn vị", "Định lượng/đơn vị", "Tồn niêm phong", "Đang active", "Đơn giá", "Thành tiền", "Nơi bảo quản", "Dùng sau khi mở", "Hóa đơn", "Link hóa đơn"];
    const rows = reportRows.map((item) => {
      const meta = lotMeta[item.id];
      const openCount = openSessions.filter((activeSession) => activeSession.sourceReceiptId === item.id).length;
      const receiptLink = item.receipt?.dataUrl || "";
      const linkCell = receiptLink ? `<Cell ss:StyleID="Link" ss:HRef="${escapeXml(receiptLink)}"><Data ss:Type="String">Mở hóa đơn</Data></Cell>` : stringCell("");
      return `<Row>${stringCell(item.receiptCode || "-")}${dateCell(item.purchasedOn)}${dateCell(meta?.expiresOn || "")}${stringCell(item.name)}${stringCell(item.category)}${stringCell(item.brand)}${stringCell(item.supplier)}${numberCell(item.quantity)}${stringCell(item.unit)}${stringCell(item.specification)}${numberCell(sealedInLot(item))}${numberCell(openCount)}${numberCell(item.unitCost, "Currency")}${numberCell(item.quantity * item.unitCost, "Currency")}${stringCell(meta?.storageLocation || "Chưa ghi")}${stringCell(shelfLifeLabel(meta?.shelfLifeHours))}${stringCell(item.receipt?.name || "Không có")}${linkCell}</Row>`;
    }).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Aptos" ss:Size="10"/></Style><Style ss:ID="Title"><Font ss:FontName="Aptos Display" ss:Size="16" ss:Bold="1" ss:Color="#17312B"/><Alignment ss:Vertical="Center"/></Style><Style ss:ID="Subtitle"><Font ss:FontName="Aptos" ss:Size="9" ss:Color="#71786E"/><Alignment ss:Vertical="Center"/></Style><Style ss:ID="Header"><Font ss:FontName="Aptos" ss:Size="9" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1E4B3F" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:WrapText="1"/></Style><Style ss:ID="Text"><Alignment ss:Vertical="Center" ss:WrapText="1"/></Style><Style ss:ID="Number"><NumberFormat ss:Format="#,##0.00"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style><Style ss:ID="Currency"><NumberFormat ss:Format="#,##0 [$₫-vi-VN]"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style><Style ss:ID="Date"><NumberFormat ss:Format="dd/mm/yyyy"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style><Style ss:ID="Link"><Font ss:Color="#1E4B3F" ss:Underline="Single"/><Alignment ss:Vertical="Center"/></Style></Styles><Worksheet ss:Name="Báo cáo nhập kho"><Table ss:ExpandedColumnCount="18" ss:ExpandedRowCount="${reportRows.length + 3}" x:FullColumns="1" x:FullRows="1"><Column ss:Width="86"/><Column ss:Width="72"/><Column ss:Width="78"/><Column ss:Width="130"/><Column ss:Width="80"/><Column ss:Width="90"/><Column ss:Width="120"/><Column ss:Width="58"/><Column ss:Width="55"/><Column ss:Width="105"/><Column ss:Width="82"/><Column ss:Width="70"/><Column ss:Width="82"/><Column ss:Width="90"/><Column ss:Width="90"/><Column ss:Width="95"/><Column ss:Width="130"/><Column ss:Width="82"/><Row ss:Height="26"><Cell ss:MergeAcross="17" ss:StyleID="Title"><Data ss:Type="String">Báo cáo nhập kho — Nhà Coffee &amp; Tea</Data></Cell></Row><Row ss:Height="22"><Cell ss:MergeAcross="17" ss:StyleID="Subtitle"><Data ss:Type="String">Bộ lọc: ${escapeXml(filterDescription)} | Xuất lúc: ${escapeXml(formatDateTime(new Date().toISOString()))}</Data></Cell></Row><Row ss:Height="30">${headers.map((header) => stringCell(header, "Header")).join("")}</Row>${rows}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>3</SplitHorizontal><TopRowBottomPane>3</TopRowBottomPane><DoNotDisplayGridlines/></WorksheetOptions><AutoFilter x:Range="R3C1:R${reportRows.length + 3}C18" xmlns="urn:schemas-microsoft-com:office:excel"/></Worksheet></Workbook>`;
    const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `bao-cao-nhap-kho-${new Date().toISOString().slice(0, 10)}.xls`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }

  if ((IS_LOCAL_UAT && !uatAuthenticated) || (!IS_LOCAL_UAT && isSupabaseConfigured && !session)) return <main className="login">
    <section className="login-visual">
      <div className="login-brand"><Image src="/nha-coffee-logo-transparent.png" alt="Nhà Coffee & Tea" width={750} height={420} priority /></div>
      <div className="eyebrow">NHA COFFEE & TEA</div>
      <h1>Nhà Ops</h1>
      <p>Quản lý nhập kho rõ ràng, đồng bộ cho cả quán.</p>
      <div className="login-note"><span aria-hidden="true">✓</span> Dữ liệu dùng chung, có lịch sử thay đổi</div>
    </section>
    <form className="login-form" onSubmit={signIn}>
      <div className="login-heading"><h2>Chào mừng trở lại</h2><p>{IS_LOCAL_UAT ? "Đăng nhập vào môi trường UAT local, tách biệt hoàn toàn với production." : "Đăng nhập để tiếp tục vào kho nguyên liệu."}</p></div>
      <label htmlFor="login-username">{IS_LOCAL_UAT ? "User" : "Tên đăng nhập"}</label>
      <input id="login-username" required autoComplete="username" inputMode={IS_LOCAL_UAT ? "text" : "email"} type={IS_LOCAL_UAT ? "text" : "email"} value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} placeholder={IS_LOCAL_UAT ? "UAT" : "email@nhacoffee.vn"} />
      <div className="password-label"><label htmlFor="login-password">Mật khẩu</label><span>Chỉ dành cho nhân sự</span></div>
      <input id="login-password" required autoComplete="current-password" type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} placeholder="Nhập mật khẩu" />
      {authError && <p className="login-error" role="alert">{authError}</p>}
      <button className="login-submit" type="submit" disabled={isSigningIn}>{isSigningIn ? "Đang đăng nhập..." : "Đăng nhập"}<span aria-hidden="true">→</span></button>
      <p className="login-help">{IS_LOCAL_UAT ? "Dữ liệu chỉ lưu trong trình duyệt này, không kết nối Supabase DB." : "Tên đăng nhập hiện dùng email của tài khoản vận hành."}</p>
    </form>
  </main>;
  return <main>
    {canAccessFinance && <nav className="module-switcher" aria-label="Khu vực quản lý"><button className={workspace === "inventory" ? "active" : ""} onClick={() => setWorkspace("inventory")}>Kho NVL</button><button className={workspace === "finance" ? "active" : ""} onClick={() => setWorkspace("finance")}>Tài chính</button></nav>}
    {workspace === "finance" && canAccessFinance ? <FinanceModule
      uatMode={IS_LOCAL_UAT}
      inventoryLots={items.map((item) => ({ id: item.id, name: item.name, quantity: item.quantity, unit: item.unit, unitCost: item.unitCost, purchasedOn: item.purchasedOn, receiptCode: item.receiptCode }))}
      inventorySessions={activeSessions.map((entry) => ({ id: entry.id, sourceReceiptId: entry.sourceReceiptId, activatedAt: entry.activatedAt, costRecognitionMonth: entry.costRecognitionMonth, status: entry.status, closedAt: entry.closedAt, reason: entry.reason }))}
      onOpenInventoryLot={(id) => { const lot = items.find((item) => item.id === id); if (!lot) return; setWorkspace("inventory"); setTab("inventory"); setDetailLot(lot); }}
    /> : <>
    <section className="hero">
      <div className="eyebrow">NHA COFFEE & TEA</div>
      <div className="hero-row"><div><h1>{tab === "inventory" ? "Kho nguyên liệu" : tab === "active" ? "Đang sử dụng" : "Báo cáo nhập kho"}</h1><p>{tab === "inventory" ? "Tìm nguyên liệu, xem tồn và mở để sử dụng." : tab === "active" ? "Ưu tiên những món sắp hư hoặc đã mở lâu." : "Lọc và sắp xếp dữ liệu nhập nguyên liệu."}</p></div><div className="hero-logo"><Image src="/nha-coffee-logo-transparent.png" alt="Nhà Coffee & Tea" width={750} height={420} priority /></div></div>
      <div className="metric"><span>{tab === "active" ? "Đơn vị đang active" : "Giá trị kho đã ghi nhận"}</span><strong>{tab === "active" ? openSessions.length : formatMoney(totalValue)}</strong><small>{tab === "active" ? `${overdueCount} quá hạn · ${expiringSoonCount} sắp đến hạn` : `${items.length} lần nhập hàng`}</small></div>
    </section>
    {IS_LOCAL_UAT && <div className="uat-local-banner"><span><b>UAT LOCAL</b> · Dữ liệu mẫu không đồng bộ lên production.</span><button onClick={resetLocalUatInventory}>Nạp lại dữ liệu mẫu</button></div>}
    <nav className="tabs" aria-label="Điều hướng"><button className={tab === "inventory" ? "active" : ""} onClick={() => setTab("inventory")}>Kho NVL</button><button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>Đang dùng</button><button className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>Báo cáo</button></nav>

    {tab === "inventory" && <section className="content">
      <div className="section-head"><div><h2>Nguyên vật liệu</h2><p>{items.length ? "Gộp theo sản phẩm, xem chi tiết theo lô" : "Bắt đầu bằng lần nhập đầu tiên"}</p></div><button className="add-button" onClick={openAdd} aria-label="Thêm nguyên vật liệu">+</button></div>
      <div className="inventory-views" role="tablist" aria-label="Chế độ xem kho"><button type="button" role="tab" aria-selected={inventoryView === "stock"} className={inventoryView === "stock" ? "selected" : ""} onClick={() => setInventoryView("stock")}>Tồn kho</button><button type="button" role="tab" aria-selected={inventoryView === "used"} className={inventoryView === "used" ? "selected" : ""} onClick={() => setInventoryView("used")}>Dùng hết</button></div>
      <label className="search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm NVL, thương hiệu hoặc nhà cung cấp" /></label>
      {!loaded ? <p className="empty">Đang tải kho...</p> : inventoryGroups.length === 0 ? <div className="empty"><b>{items.length ? inventoryView === "stock" ? "Không còn nguyên liệu trong kho" : "Chưa có nguyên liệu dùng hết" : "Kho đang trống"}</b><span>{items.length ? "Thử chuyển view hoặc tìm bằng từ khóa khác." : "Nhấn dấu + để ghi nhận lần mua nguyên liệu đầu tiên."}</span></div> : <div className="inventory-list">{inventoryGroups.map((group) => {
        const sealed = sealedInGroup(group); const active = activeInGroup(group).length; const wasted = wastedInGroup(group).length; const receiptCodes = [...new Set([...group.lots].sort((a, b) => b.purchasedOn.localeCompare(a.purchasedOn)).map((lot) => lot.receiptCode).filter(Boolean))];
        return <button className="ingredient-summary" key={group.key} onClick={() => setDetailGroup(group)}><div><div className="summary-tags"><span className="category-pill">{group.category}</span>{receiptCodes[0] && <span className="receipt-pill" title={receiptCodes.join(", ")}>Phiếu {receiptCodes[0]}{receiptCodes.length > 1 ? ` +${receiptCodes.length - 1}` : ""}</span>}</div><h3>{group.name}</h3><p>{group.brand} · {group.specification}</p></div><div className="summary-counts"><span><b>{sealed.toLocaleString("vi-VN")}</b> niêm phong</span><span className={active ? "has-active" : ""}><b>{active}</b> active</span><span className={wasted ? "has-waste" : ""}><b>{wasted}</b> hao hụt</span></div><span className="summary-arrow">→</span></button>;
      })}</div>}
    </section>}

    {tab === "active" && <section className="content active-dashboard">
      <div className="status-grid">
        <button className={`status-filter ${lifecycleFilter === "active" ? "selected" : ""}`} aria-pressed={lifecycleFilter === "active"} onClick={() => setLifecycleFilter("active")}><span>Đang active</span><strong>{openSessions.length}</strong></button>
        <button className={`status-filter warning ${lifecycleFilter === "soon" ? "selected" : ""}`} aria-pressed={lifecycleFilter === "soon"} onClick={() => setLifecycleFilter("soon")}><span>Sắp hạn 24h</span><strong>{expiringSoonCount}</strong></button>
        <button className={`status-filter danger ${lifecycleFilter === "overdue" ? "selected" : ""}`} aria-pressed={lifecycleFilter === "overdue"} onClick={() => setLifecycleFilter("overdue")}><span>Quá hạn</span><strong>{overdueCount}</strong></button>
        <button className={`status-filter ${isWasteOverAllowance ? "danger" : ""} ${lifecycleFilter === "loss" ? "selected" : ""}`} aria-pressed={lifecycleFilter === "loss"} onClick={() => setLifecycleFilter("loss")}><span>Hao hụt đã ghi nhận</span><strong><span>{wasteRate.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%</span><small>({formatMoney(wastedValue)})</small></strong></button>
      </div>
      <section className={`waste-monitor ${isWasteOverAllowance ? "over-limit" : ""}`} aria-label="Theo dõi hao hụt kho">
        <div className="waste-monitor-head"><div><span>THEO DÕI HAO HỤT</span><div className="waste-status-line"><h2>{isWasteOverAllowance ? "Hao hụt đang vượt mức cho phép" : "Hao hụt đang trong mức cho phép"} ({wasteAllowancePercent.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%)</h2><label className="waste-allowance"><span>Điều chỉnh</span><div><input aria-label="Ngưỡng hao hụt cho phép" min="0" max="100" step="0.1" type="number" inputMode="decimal" value={wasteAllowance} onChange={(event) => setWasteAllowance(event.target.value)} /><b>%</b></div></label></div></div></div>
        <div className="waste-bar" aria-label={`Hao hụt ${wasteRate.toFixed(1)} phần trăm trên mức cho phép ${wasteAllowancePercent.toFixed(1)} phần trăm`}><i className="waste-limit-marker" style={{ left: `${Math.min(100, wasteAllowancePercent)}%` }} /><b style={{ width: `${Math.min(100, wasteRate)}%` }} /></div>
        <div className="waste-monitor-foot"><span>Đã báo hỏng: {formatMoney(wastedValue)} / {formatMoney(totalValue)} giá trị nhập kho</span><strong>{isWasteOverAllowance ? `Vượt ${Math.max(0, wasteRate - wasteAllowancePercent).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}% — cần kiểm tra nguyên nhân.` : `Còn ${Math.max(0, wasteAllowancePercent - wasteRate).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}% trước ngưỡng.`}</strong></div>
      </section>
      <div className="dashboard-head"><div><h2>{lifecycleHeading[lifecycleFilter][0]}</h2><p>{lifecycleHeading[lifecycleFilter][1]}</p></div><span>{lifecycleDashboard.length} kết quả</span></div>
      {lifecycleDashboard.length === 0 ? <div className="empty"><b>Không có dữ liệu trong bộ lọc này</b><span>Chọn một chỉ số khác để xem các nguyên liệu liên quan.</span></div> : <div className="active-list">{lifecycleDashboard.map((activeSession) => {
        const lot = items.find((entry) => entry.id === activeSession.sourceReceiptId); const group = ingredientGroups.find((entry) => entry.key === (lot ? ingredientKey(lot) : activeSession.ingredientKey)); const remaining = activeSession.useBy ? new Date(activeSession.useBy).getTime() - now : undefined; const totalLife = activeSession.useBy ? new Date(activeSession.useBy).getTime() - new Date(activeSession.activatedAt).getTime() : undefined; const elapsed = totalLife ? Math.min(100, Math.max(4, ((now - new Date(activeSession.activatedAt).getTime()) / totalLife) * 100)) : 12; const urgency = remaining === undefined ? "neutral" : remaining < 0 ? "overdue" : remaining <= 86_400_000 ? "soon" : "safe";
        if (activeSession.status === "wasted") return <article className="active-card wasted" key={activeSession.id}><div className="active-card-top"><div><span>{group?.category || "Nguyên liệu"}</span><h3>{group?.name || lot?.name || "Không xác định"}</h3><p>Báo hỏng {activeSession.closedAt ? formatDateTime(activeSession.closedAt) : "chưa rõ thời gian"}</p></div><b>{formatMoney(lot?.unitCost || 0)}</b></div><div className="waste-reason"><span>{reasonLabel(activeSession.reason)}</span>{activeSession.note && <small>{activeSession.note}</small>}</div><div className="active-meta"><span>Lô {lot ? formatDate(lot.purchasedOn) : "-"}</span><span>Mở lúc {formatDateTime(activeSession.activatedAt)}</span></div><div className="active-actions"><button onClick={() => group && setDetailGroup(group)}>Chi tiết nguồn hàng</button></div></article>;
        return <article className={`active-card ${urgency}`} key={activeSession.id}><div className="active-card-top"><div><span>{group?.category || "Nguyên liệu"}</span><h3>{group?.name || lot?.name || "Không xác định"}</h3><p>Mở {formatDateTime(activeSession.activatedAt)} · đã {formatDuration(now - new Date(activeSession.activatedAt).getTime())} · Chi phí T{(activeSession.costRecognitionMonth || activeSession.activatedAt.slice(0, 7)).split("-").reverse().join("/")}</p></div><b>{remaining === undefined ? "Chưa đặt hạn" : remaining < 0 ? `Quá ${formatDuration(remaining)}` : `Còn ${formatDuration(remaining)}`}</b></div><div className="life-bar"><i style={{ width: `${elapsed}%` }} /></div><div className="active-meta"><span>Lô {lot ? formatDate(lot.purchasedOn) : "-"}</span><span>{lotMeta[activeSession.sourceReceiptId]?.storageLocation || "Chưa ghi nơi bảo quản"}</span></div><div className="active-actions"><button onClick={() => requestClose(activeSession, "used")}>Đã dùng hết</button><button className="waste" onClick={() => requestClose(activeSession, "wasted")}>Báo hỏng</button><button onClick={() => group && setDetailGroup(group)}>Chi tiết</button></div></article>;
      })}</div>}
    </section>}

    {tab === "report" && <section className="content report"><div className="report-toolbar"><div className="report-summary"><div><span>Số dòng</span><strong>{reportRows.length}</strong></div><div><span>Giá trị theo bộ lọc</span><strong>{formatMoney(reportRows.reduce((sum, item) => sum + item.quantity * item.unitCost, 0))}</strong></div></div><button className="export-button" type="button" disabled={!reportRows.length} onClick={exportReportExcel}><span>⇩</span> Xuất Excel</button></div><label className="search"><span>⌕</span><input value={reportSearch} onChange={(event) => setReportSearch(event.target.value)} placeholder="Tìm NVL, category, thương hiệu..." /></label><div className="filters"><label>Nhà cung cấp<select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}><option value="all">Tất cả</option>{suppliers.map((supplier) => <option key={supplier}>{supplier}</option>)}</select></label><label>Category<select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">Tất cả</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><label>Thương hiệu<select value={brandFilter} onChange={(event) => setBrandFilter(event.target.value)}><option value="all">Tất cả</option>{brands.map((brand) => <option key={brand}>{brand}</option>)}</select></label><label>Từ ngày<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>Đến ngày<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div><div className="table-wrap"><table className="report-table"><thead><tr><th><button onClick={() => changeSort("purchasedOn")}>Ngày mua{sortMarker("purchasedOn")}</button></th><th>HSD</th><th>Mã phiếu</th><th><button onClick={() => changeSort("name")}>Nguyên liệu{sortMarker("name")}</button></th><th>Category</th><th>Thương hiệu</th><th>Nhà cung cấp</th><th><button onClick={() => changeSort("quantity")}>SL nhập{sortMarker("quantity")}</button></th><th>Định lượng</th><th>Tồn kín</th><th>Active</th><th><button onClick={() => changeSort("unitCost")}>Đơn giá{sortMarker("unitCost")}</button></th><th><button onClick={() => changeSort("total")}>Thành tiền{sortMarker("total")}</button></th><th>Bảo quản</th><th>Sau mở</th><th>Hóa đơn</th></tr></thead><tbody>{reportRows.map((item) => { const meta = lotMeta[item.id]; const activeCount = openSessions.filter((activeSession) => activeSession.sourceReceiptId === item.id).length; return <tr key={item.id}><td>{formatDate(item.purchasedOn)}</td><td>{meta?.expiresOn ? formatDate(meta.expiresOn) : "-"}</td><td>{item.receiptCode || "-"}</td><td><button className="table-detail-button" onClick={() => setDetailLot(item)}><b>{item.name}</b><span>Xem chi tiết</span></button></td><td>{item.category}</td><td>{item.brand}</td><td>{item.supplier}</td><td>{item.quantity.toLocaleString("vi-VN")} {item.unit}</td><td>{item.specification}</td><td>{sealedInLot(item).toLocaleString("vi-VN")} {item.unit}</td><td>{activeCount}</td><td>{formatMoney(item.unitCost)}</td><td><b>{formatMoney(item.quantity * item.unitCost)}</b></td><td>{meta?.storageLocation || "-"}</td><td>{shelfLifeLabel(meta?.shelfLifeHours)}</td><td>{item.receipt?.dataUrl ? <a className="table-receipt" href={item.receipt.dataUrl} target="_blank" rel="noreferrer">Mở HĐ</a> : item.receipt ? "Có file" : "-"}</td></tr>; })}{reportRows.length === 0 && <tr><td colSpan={16} className="no-result">Không có dữ liệu phù hợp.</td></tr>}</tbody></table></div></section>}

    {selectedGroup && <div className="sheet-backdrop" role="presentation" onMouseDown={() => setDetailGroup(undefined)}><aside className="sheet detail-sheet" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>CHI TIẾT NGUYÊN LIỆU</p><h2>{selectedGroup.name}</h2><span>{selectedGroup.brand} · {selectedGroup.specification}</span></div><button type="button" className="close" onClick={() => setDetailGroup(undefined)}>×</button></div><div className="detail-totals"><div><span>Niêm phong</span><strong>{sealedInGroup(selectedGroup).toLocaleString("vi-VN")} {selectedGroup.unit}</strong></div><div><span>Đang active</span><strong>{activeInGroup(selectedGroup).length} {selectedGroup.unit}</strong></div></div>
      <section className="detail-section"><h3>Đang active</h3>{activeInGroup(selectedGroup).length === 0 ? <p className="detail-empty">Chưa có {selectedGroup.unit} nào đang sử dụng.</p> : activeInGroup(selectedGroup).map((activeSession, index) => <article className="detail-active" key={activeSession.id}><div><b>{selectedGroup.unit} active #{index + 1}</b><span>Mở {formatDateTime(activeSession.activatedAt)}</span><span>Chi phí ghi nhận T{(activeSession.costRecognitionMonth || activeSession.activatedAt.slice(0, 7)).split("-").reverse().join("/")}</span><span>{activeSession.useBy ? `Dùng trước ${formatDateTime(activeSession.useBy)}` : "Chưa thiết lập hạn sau khi mở"}</span></div><div><button onClick={() => requestClose(activeSession, "used")}>Dùng hết</button><button className="waste" onClick={() => requestClose(activeSession, "wasted")}>Báo hỏng</button></div></article>)}</section>
      <section className="detail-section"><h3>Lô hàng nguồn</h3>{[...selectedGroup.lots].sort((a, b) => (lotMeta[a.id]?.expiresOn || "9999").localeCompare(lotMeta[b.id]?.expiresOn || "9999")).map((lot) => { const meta = lotMeta[lot.id]; const sealed = sealedInLot(lot); const hasBeenIssued = takenFromLot(lot.id) > 0; return <article className="lot-card" key={lot.id}><button className="lot-summary-button" onClick={() => setDetailLot(lot)}><div className="lot-top"><div><b>Nhập {formatDate(lot.purchasedOn)}</b><span>{lot.receiptCode ? `Phiếu ${lot.receiptCode} · ` : ""}{lot.supplier}</span></div><strong>{sealed.toLocaleString("vi-VN")}/{lot.quantity.toLocaleString("vi-VN")} {lot.unit}</strong></div><div className="lot-meta"><span>HSD: {meta?.expiresOn ? formatDate(meta.expiresOn) : "Chưa ghi"}</span><span>Sau mở: {shelfLifeLabel(meta?.shelfLifeHours)}</span><span>{meta?.storageLocation || "Chưa ghi nơi bảo quản"}</span></div><span className="lot-detail-link">Xem chi tiết nhập kho & hóa đơn →</span></button><button className="activate-button" disabled={sealed < 1} onClick={() => requestActivation(selectedGroup, lot)}>{sealed < 1 ? "Lô đã hết" : `Mở 1 ${lot.unit} để sử dụng`}</button><div className="lot-actions"><button onClick={() => openEdit(lot)}>Sửa lô</button><button onClick={() => setHistoryItem(lot)}>Lịch sử</button>{canDeleteInventory && <button disabled={hasBeenIssued || deletingId === lot.id} title={hasBeenIssued ? "Không thể xóa phiếu đã có lần xuất sang Đang dùng" : undefined} onClick={() => removeItem(lot.id)}>{deletingId === lot.id ? "Đang xóa..." : "Xóa"}</button>}</div></article>; })}</section>
    </aside></div>}

    {detailLot && <div className="sheet-backdrop lot-detail-backdrop" role="presentation" onMouseDown={() => setDetailLot(undefined)}><aside className="sheet lot-detail-sheet" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>CHI TIẾT LÔ NHẬP KHO</p><h2>{detailLot.name}</h2><span>{detailLot.category} · {detailLot.brand}</span></div><button type="button" className="close" onClick={() => setDetailLot(undefined)}>×</button></div><div className="lot-detail-grid"><div><span>Mã phiếu</span><strong>{detailLot.receiptCode || "Chưa có"}</strong></div><div><span>SL tổng</span><strong>{detailLot.quantity.toLocaleString("vi-VN")} {detailLot.unit}</strong></div><div><span>Tồn niêm phong</span><strong>{sealedInLot(detailLot).toLocaleString("vi-VN")} {detailLot.unit}</strong></div><div><span>Định lượng/{detailLot.unit}</span><strong>{detailLot.specification}</strong></div><div><span>Đơn giá</span><strong>{formatMoney(detailLot.unitCost)}</strong></div><div><span>Thành tiền</span><strong>{formatMoney(detailLot.quantity * detailLot.unitCost)}</strong></div><div><span>Ngày mua</span><strong>{formatDate(detailLot.purchasedOn)}</strong></div><div><span>Hạn sử dụng</span><strong>{lotMeta[detailLot.id]?.expiresOn ? formatDate(lotMeta[detailLot.id].expiresOn) : "Chưa ghi"}</strong></div><div><span>Dùng sau khi mở</span><strong>{shelfLifeLabel(lotMeta[detailLot.id]?.shelfLifeHours)}</strong></div><div><span>Nhà cung cấp</span><strong>{detailLot.supplier}</strong></div><div><span>Nơi bảo quản</span><strong>{lotMeta[detailLot.id]?.storageLocation || "Chưa ghi"}</strong></div></div><section className="receipt-detail"><h3>Hóa đơn đính kèm</h3>{detailLot.receipt ? <div><span>▣ {detailLot.receipt.name}</span>{detailLot.receipt.dataUrl ? <a href={detailLot.receipt.dataUrl} target="_blank" rel="noreferrer">Mở hóa đơn</a> : <small>File đã ghi nhận nhưng đường dẫn xem hiện không khả dụng.</small>}</div> : <p>Chưa có hóa đơn được đính kèm cho lô này.</p>}</section><div className="lot-detail-actions"><button onClick={() => { setDetailLot(undefined); openEdit(detailLot); }}>Sửa thông tin lô</button><button onClick={() => setHistoryItem(detailLot)}>Xem lịch sử</button>{canDeleteInventory && <button disabled={takenFromLot(detailLot.id) > 0 || deletingId === detailLot.id} title={takenFromLot(detailLot.id) > 0 ? "Không thể xóa phiếu đã có lần xuất sang Đang dùng" : undefined} onClick={() => removeItem(detailLot.id)}>{deletingId === detailLot.id ? "Đang xóa..." : "Xóa lô nhập kho"}</button>}</div></aside></div>}

    {showForm && <div className="sheet-backdrop" role="presentation" onMouseDown={closeForm}><form className="sheet" onSubmit={saveIngredient} onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>{editingId ? "CẬP NHẬT LÔ NHẬP" : "NHẬP KHO"}</p><h2>{editingId ? "Sửa nguyên liệu" : "Thêm nguyên liệu"}</h2></div><button type="button" className="close" onClick={closeForm}>×</button></div><label>Tên nguyên liệu<input required autoFocus value={form.name} onChange={(event) => updateForm("name", event.target.value)} placeholder="Ví dụ: Sữa tươi" /></label><div className="form-row"><label>Category<input required list="category-options" value={form.category} onChange={(event) => updateForm("category", event.target.value)} placeholder="Ví dụ: Sữa" /><datalist id="category-options">{categories.map((category) => <option value={category} key={category} />)}</datalist></label><label>Thương hiệu<input list="brand-options" value={form.brand} onChange={(event) => updateForm("brand", event.target.value)} placeholder="Gõ để chọn hoặc thêm mới" /><datalist id="brand-options">{brands.map((brand) => <option value={brand} key={brand} />)}</datalist></label></div><label>Mã hóa đơn<input value={form.invoiceCode} onChange={(event) => updateForm("invoiceCode", event.target.value)} placeholder="Ví dụ: HD-000123" /><small>Bắt buộc nhập. Nếu để trống, hệ thống sẽ hỏi trước khi dùng mã DDMMYY-STT.</small></label><div className="form-row"><label>SL tổng<input required min="0" step="0.01" inputMode="decimal" value={form.quantity} onChange={(event) => updateForm("quantity", event.target.value)} placeholder="Ví dụ: 3" /></label><label>Đơn vị<select value={form.unit} onChange={(event) => updateForm("unit", event.target.value)}><option>chai</option><option>gói</option><option>hộp</option><option>lon</option><option>túi</option><option>kg</option><option>lít</option></select></label></div><div className="form-row specification-row"><label>Định lượng mỗi đơn vị<input min="0" step="0.01" inputMode="decimal" type="number" value={form.specificationAmount} onChange={(event) => updateForm("specificationAmount", event.target.value)} placeholder="Ví dụ: 200" /></label><label>Đơn vị định lượng<select value={form.specificationUnit} onChange={(event) => updateForm("specificationUnit", event.target.value)}><option value="ml">ml</option><option value="l">lít (l)</option><option value="g">gram (g)</option><option value="kg">kilogram (kg)</option><option value="mg">milligram (mg)</option><option value="oz">ounce (oz)</option><option value="cái">cái</option><option value="viên">viên</option><option value="phần">phần</option></select></label></div><label>Đơn giá (VND)<input required inputMode="numeric" value={form.unitCost} onChange={(event) => updateForm("unitCost", formatPriceInput(event.target.value))} placeholder="Ví dụ: 53,000" /><small>Giá của một {form.unit}; có thể gõ theo dạng 53,000.</small></label><div className="form-row"><label>Ngày mua (có thể backdate)<VietnameseDateInput required value={form.purchasedOn} onChange={updatePurchasedOn} /><small>Định dạng: dd/mm/yyyy · Có thể chọn ngày trong quá khứ.</small></label><label>Hạn sử dụng<VietnameseDateInput value={form.expiresOn} onChange={(expiresOn) => updateForm("expiresOn", expiresOn)} /><small>Định dạng: dd/mm/yyyy</small></label></div><div className="form-row shelf-life-row"><label>Dùng trong vòng sau mở<input min="0" type="number" inputMode="decimal" value={form.shelfLifeValue} onChange={(event) => updateForm("shelfLifeValue", event.target.value)} placeholder="Ví dụ: 3" /></label><label>Đơn vị thời gian<select value={form.shelfLifeUnit} onChange={(event) => updateForm("shelfLifeUnit", event.target.value as ShelfLifeUnit)}><option value="minutes">Phút</option><option value="hours">Giờ</option><option value="days">Ngày</option><option value="weeks">Tuần</option></select></label></div><div className="form-row"><label>Nhà cung cấp<input list="supplier-options" value={form.supplier} onChange={(event) => updateForm("supplier", event.target.value)} placeholder="Gõ để chọn hoặc thêm mới" /><datalist id="supplier-options">{suppliers.map((supplier) => <option value={supplier} key={supplier} />)}</datalist></label><label>Nơi bảo quản<select value={form.storageLocation} onChange={(event) => updateForm("storageLocation", event.target.value)}><option>Tủ mát</option><option>Tủ đông</option><option>Kho khô</option><option>Quầy bar</option><option>Khác</option></select></label></div><fieldset className="receipt-fieldset"><legend>Đính kèm hóa đơn</legend><div className="receipt-options"><label className="receipt-choice camera-choice"><input type="file" accept="image/*" capture="environment" onChange={attachReceipt} /><span className="receipt-icon">◎</span><b>Chụp bằng camera</b><small>Mở camera sau trên điện thoại</small></label><label className="receipt-choice"><input type="file" accept="image/*,.pdf" onChange={attachReceipt} /><span className="receipt-icon">⇧</span><b>Chọn ảnh / PDF</b><small>Tải file có sẵn từ thiết bị</small></label></div>{receipt && <div className="selected-receipt">✓ Đã chọn: <b>{receipt.name}</b></div>}</fieldset><p className="uat-note">{IS_LOCAL_UAT ? "Dữ liệu UAT đang lưu riêng trên trình duyệt và không đồng bộ lên production." : cloudLifecycleReady ? "HSD, nơi bảo quản và trạng thái active đang đồng bộ qua Supabase." : "Cần chạy migration 003 để bật đồng bộ lifecycle giữa các thiết bị."}</p><button className="save-button" type="submit">{editingId ? "Lưu thay đổi" : "Lưu lần nhập kho"}</button></form></div>}

    {activationCandidate && <div className="sheet-backdrop action-backdrop" role="presentation" onMouseDown={() => setActivationCandidate(undefined)}><form className="sheet action-sheet" onSubmit={confirmActivation} onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>{activeInGroup(activationCandidate.group).length ? "CROSS-CHECK TRƯỚC KHI MỞ" : "MỞ NGUYÊN LIỆU ĐỂ SỬ DỤNG"}</p><h2>{activeInGroup(activationCandidate.group).length ? `Đang có ${activeInGroup(activationCandidate.group).length} ${activationCandidate.group.unit} active` : activationCandidate.group.name}</h2></div><button type="button" className="close" onClick={() => setActivationCandidate(undefined)}>×</button></div>
      <label>Tháng ghi nhận chi phí<input required min={activationCandidate.lot.purchasedOn.slice(0, 7)} max={new Date().toISOString().slice(0, 7)} type="month" value={activationCostMonth} onChange={(event) => setActivationCostMonth(event.target.value)} /><small>Giá vốn của 1 {activationCandidate.group.unit} sẽ được ghi nhận vào tháng này. Thời gian mở thực tế vẫn được lưu riêng để theo dõi HSD.</small></label>
      {activeInGroup(activationCandidate.group).length > 0 && <><div className="cross-check-alert"><b>{activationCandidate.group.name}</b><span>Đơn vị cũ chưa được đánh dấu là đã sử dụng hết. Chọn tình huống thực tế trước khi mở thêm.</span></div><label>Tình huống<select required value={activationReason} onChange={(event) => setActivationReason(event.target.value)}><option value="">Chọn một lý do</option><optgroup label="Đơn vị cũ đã kết thúc"><option value="previous_used">Đơn vị cũ đã sử dụng hết</option>{closeReasons.filter(([key]) => key !== "used_up").map(([key, label]) => <option value={`previous_waste_${key}`} key={key}>Đơn vị cũ: {label}</option>)}</optgroup><optgroup label="Giữ đơn vị cũ và mở thêm">{activationReasons.map(([key, label]) => <option value={key} key={key}>{label}</option>)}</optgroup></select></label></>}
      <label>Ghi chú {activationReason.endsWith("other") ? "(bắt buộc)" : "(không bắt buộc)"}<textarea required={activationReason.endsWith("other")} value={activationNote} onChange={(event) => setActivationNote(event.target.value)} placeholder="Mô tả ngắn nếu cần" /></label><button className="save-button" type="submit">Xác nhận mở 1 {activationCandidate.group.unit}</button></form></div>}

    {closeCandidate && <div className="sheet-backdrop action-backdrop" role="presentation" onMouseDown={() => setCloseCandidate(undefined)}><form className="sheet action-sheet" onSubmit={confirmClose} onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>KẾT THÚC ACTIVE</p><h2>{closeCandidate.status === "used" ? "Xác nhận đã dùng hết" : "Ghi nhận hư hỏng"}</h2></div><button type="button" className="close" onClick={() => setCloseCandidate(undefined)}>×</button></div>{closeCandidate.status === "wasted" && <label>Lý do<select required value={closeReason} onChange={(event) => setCloseReason(event.target.value)}><option value="">Chọn lý do</option>{closeReasons.filter(([key]) => key !== "used_up").map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>}<label>Ghi chú {closeReason === "other" ? "(bắt buộc)" : "(không bắt buộc)"}<textarea required={closeReason === "other"} value={closeNote} onChange={(event) => setCloseNote(event.target.value)} placeholder="Mô tả ngắn nếu cần" /></label><button className={`save-button ${closeCandidate.status === "wasted" ? "danger-button" : ""}`} type="submit">{closeCandidate.status === "used" ? "Đánh dấu đã dùng hết" : "Ghi nhận hư/hủy"}</button></form></div>}

    {historyItem && <div className="sheet-backdrop" role="presentation" onMouseDown={() => setHistoryItem(undefined)}><aside className="sheet history-sheet" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>NHẬT KÝ THAY ĐỔI</p><h2>{historyItem.name}</h2></div><button type="button" className="close" onClick={() => setHistoryItem(undefined)}>×</button></div><div className="history-list">{historyItem.history.map((event) => <article className="history-event" key={event.id}><div><strong>{event.action === "created" ? "Tạo lần nhập" : "Đã cập nhật"}</strong><span>{formatTime(event.at)}</span></div>{event.action === "created" ? <p>Đã ghi nhận lần nhập kho đầu tiên.</p> : event.changes.map((change) => <p key={change.field}><b>{fieldLabels[change.field]}</b><del>{change.from}</del><ins>{change.to}</ins></p>)}</article>)}</div></aside></div>}
    </>}
  </main>;
}

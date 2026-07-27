"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "@/lib/supabase";
import { loadInventory, removeInventory, saveInventory } from "@/lib/inventory-store";

type Receipt = { name: string; dataUrl?: string; path?: string };
type Change = { field: string; from: string; to: string };
type HistoryEvent = { id: string; at: string; action: "created" | "updated"; changes: Change[] };
type Ingredient = {
  id: string; name: string; category: string; brand: string; unit: string; quantity: number; specification: string;
  unitCost: number; purchasedOn: string; supplier: string; receipt?: Receipt; history: HistoryEvent[];
};
type FormValues = { name: string; category: string; brand: string; unit: string; quantity: string; specificationAmount: string; specificationUnit: string; specificationNote: string; unitCost: string; purchasedOn: string; supplier: string; expiresOn: string; shelfLifeValue: string; shelfLifeUnit: "hours" | "days"; storageLocation: string };
type SortKey = "purchasedOn" | "name" | "quantity" | "unitCost" | "total";
type LotMeta = { expiresOn: string; shelfLifeHours?: number; storageLocation: string };
type ActiveStatus = "active" | "used" | "wasted";
type ActiveSession = { id: string; sourceReceiptId: string; ingredientKey: string; activatedAt: string; useBy?: string; status: ActiveStatus; closedAt?: string; reason: string; note?: string };
type IngredientGroup = { key: string; name: string; category: string; brand: string; unit: string; specification: string; lots: Ingredient[] };
type ActivationCandidate = { group: IngredientGroup; lot: Ingredient };
type CloseCandidate = { session: ActiveSession; status: "used" | "wasted" };

const STORAGE_KEY = "nha-ops-inventory-v1";
const ACTIVE_STORAGE_KEY = "nha-ops-active-uat-v1";
const LOT_META_STORAGE_KEY = "nha-ops-lot-meta-uat-v1";
const formDefaults = (): FormValues => ({ name: "", category: "", brand: "", unit: "chai", quantity: "", specificationAmount: "", specificationUnit: "ml", specificationNote: "", unitCost: "", purchasedOn: new Date().toISOString().slice(0, 10), supplier: "", expiresOn: "", shelfLifeValue: "", shelfLifeUnit: "days", storageLocation: "Tủ mát" });
const fieldLabels: Record<string, string> = { name: "Tên NVL", category: "Category", brand: "Thương hiệu", unit: "Đơn vị", quantity: "SL tổng", specification: "Định lượng", unitCost: "Đơn giá", purchasedOn: "Ngày mua", supplier: "Nhà cung cấp", receipt: "Hóa đơn" };
const activationReasons = [
  ["additional_peak", "Giờ cao điểm, cần mở thêm"], ["additional_station", "Dùng tại quầy/khu vực khác"], ["additional_recipe", "Dùng cho món hoặc công thức khác"], ["additional_batch", "Chuẩn bị batch trước giờ bán"], ["additional_insufficient", "Hộp đang mở không đủ cho đơn hiện tại"], ["additional_quality", "Kiểm tra chất lượng hoặc thử món"], ["other", "Lý do khác"],
] as const;
const closeReasons = [
  ["used_up", "Đã sử dụng hết"], ["expired", "Hết hạn sau khi mở"], ["spoiled", "Có dấu hiệu hư hỏng"], ["spill", "Đổ vỡ hoặc rơi"], ["contaminated", "Nhiễm bẩn khi sử dụng"], ["temperature", "Bảo quản sai nhiệt độ"], ["package", "Bao bì rách, phồng hoặc rò rỉ"], ["quality", "Chất lượng hoặc hương vị bất thường"], ["recipe_error", "Pha chế sai công thức"], ["training", "Dùng thử hoặc đào tạo"], ["variance", "Sai lệch kiểm kê"], ["other", "Lý do khác"],
] as const;

function formatMoney(value: number) { return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value); }
function formatDate(date: string) { const [year, month, day] = date.split("-"); return year && month && day ? `${day}/${month}/${year}` : date; }
function formatTime(value: string) { return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatPriceInput(value: string) { const digits = value.replace(/\D/g, ""); return digits ? Number(digits).toLocaleString("en-US") : ""; }
function parsePrice(value: string) { return Number(value.replace(/\D/g, "")); }
function parseSpecification(value: string) { const match = value.trim().match(/^([\d.,]+)\s*(ml|l|g|kg|mg|oz|cái|viên|phần)\b\s*(.*)$/i); if (!match) return { amount: "", unit: "ml", note: value === "Chưa ghi định lượng" ? "" : value }; return { amount: match[1], unit: match[2].toLowerCase(), note: match[3] }; }
function buildSpecification(amount: string, unit: string, note: string) { const core = amount.trim() ? `${amount.trim()} ${unit}` : ""; return [core, note.trim()].filter(Boolean).join(" ") || "Chưa ghi định lượng"; }
function ingredientKey(item: Pick<Ingredient, "name" | "brand" | "unit" | "specification">) { return [item.name, item.brand, item.unit, item.specification].map((value) => value.trim().toLocaleLowerCase("vi")).join("|"); }
function addHours(value: string, hours: number) { return new Date(new Date(value).getTime() + hours * 60 * 60 * 1000).toISOString(); }
function endOfDate(value: string) { return value ? new Date(`${value}T23:59:59`).toISOString() : undefined; }
function useByFor(activatedAt: string, meta?: LotMeta) { const openedLimit = meta?.shelfLifeHours ? addHours(activatedAt, meta.shelfLifeHours) : undefined; const expiryLimit = endOfDate(meta?.expiresOn || ""); if (openedLimit && expiryLimit) return openedLimit < expiryLimit ? openedLimit : expiryLimit; return openedLimit || expiryLimit; }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatDuration(milliseconds: number) { const absolute = Math.abs(milliseconds); const hours = Math.floor(absolute / 3_600_000); if (hours < 24) return `${hours} giờ`; const days = Math.floor(hours / 24); const rest = hours % 24; return rest ? `${days} ngày ${rest} giờ` : `${days} ngày`; }
function reasonLabel(value: string) { return [...activationReasons, ...closeReasons].find(([key]) => key === value)?.[1] || value; }
function shelfLifeLabel(hours?: number) { if (!hours) return "Chưa ghi"; return hours >= 24 && hours % 24 === 0 ? `${hours / 24} ngày` : `${hours} giờ`; }
function escapeXml(value: string) { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }
function safeItems(value: unknown): Ingredient[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    ...item, category: typeof item.category === "string" ? item.category : "Chưa phân loại",
    brand: typeof item.brand === "string" ? item.brand : "Chưa ghi thương hiệu",
    specification: typeof item.specification === "string" ? item.specification : "Chưa ghi định lượng",
    history: Array.isArray(item.history) ? item.history : [{ id: crypto.randomUUID(), at: new Date().toISOString(), action: "created", changes: [] }],
  }));
}
function changesFor(item: Ingredient, next: Omit<Ingredient, "id" | "history">): Change[] {
  const pairs: Array<[keyof Omit<Ingredient, "id" | "history">, string, string]> = [
    ["name", item.name, next.name], ["category", item.category, next.category], ["brand", item.brand, next.brand], ["unit", item.unit, next.unit], ["quantity", String(item.quantity), String(next.quantity)], ["specification", item.specification, next.specification], ["unitCost", String(item.unitCost), String(next.unitCost)], ["purchasedOn", item.purchasedOn, next.purchasedOn], ["supplier", item.supplier, next.supplier], ["receipt", item.receipt?.name || "Không có", next.receipt?.name || "Không có"],
  ];
  return pairs.filter(([, from, to]) => from !== to).map(([field, from, to]) => ({ field: String(field), from, to }));
}

export default function Home() {
  const [items, setItems] = useState<Ingredient[]>([]);
  const [form, setForm] = useState<FormValues>(formDefaults);
  const [receipt, setReceipt] = useState<Receipt | undefined>();
  const [receiptFile, setReceiptFile] = useState<File | undefined>();
  const [session, setSession] = useState<Session | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [lotMeta, setLotMeta] = useState<Record<string, LotMeta>>({});
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [historyItem, setHistoryItem] = useState<Ingredient | undefined>();
  const [detailGroup, setDetailGroup] = useState<IngredientGroup | undefined>();
  const [detailLot, setDetailLot] = useState<Ingredient | undefined>();
  const [activationCandidate, setActivationCandidate] = useState<ActivationCandidate | undefined>();
  const [activationReason, setActivationReason] = useState("");
  const [activationNote, setActivationNote] = useState("");
  const [closeCandidate, setCloseCandidate] = useState<CloseCandidate | undefined>();
  const [closeReason, setCloseReason] = useState("");
  const [closeNote, setCloseNote] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [tab, setTab] = useState<"inventory" | "active" | "report">("inventory");
  const [search, setSearch] = useState("");
  const [reportSearch, setReportSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [brandFilter, setBrandFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; direction: "asc" | "desc" }>({ key: "purchasedOn", direction: "desc" });
  const [loaded, setLoaded] = useState(false);

  async function refreshCloud() { try { setItems(safeItems(await loadInventory())); } finally { setLoaded(true); } }
  useEffect(() => {
    const storedActive = window.localStorage.getItem(ACTIVE_STORAGE_KEY);
    const storedMeta = window.localStorage.getItem(LOT_META_STORAGE_KEY);
    if (storedActive) setActiveSessions(JSON.parse(storedActive));
    if (storedMeta) setLotMeta(JSON.parse(storedMeta));
    if (!isSupabaseConfigured || !supabase) { const stored = window.localStorage.getItem(STORAGE_KEY); if (stored) setItems(safeItems(JSON.parse(stored))); setLoaded(true); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); if (data.session) refreshCloud(); else setLoaded(true); });
    return supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); if (nextSession) refreshCloud(); }).data.subscription.unsubscribe;
  }, []);
  useEffect(() => { if (loaded && !isSupabaseConfigured) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); }, [items, loaded]);
  useEffect(() => { window.localStorage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify(activeSessions)); }, [activeSessions]);
  useEffect(() => { window.localStorage.setItem(LOT_META_STORAGE_KEY, JSON.stringify(lotMeta)); }, [lotMeta]);

  const totalValue = items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
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
  const selectedGroup = detailGroup ? ingredientGroups.find((group) => group.key === detailGroup.key) || detailGroup : undefined;
  const now = Date.now();
  const expiringSoonCount = openSessions.filter((session) => session.useBy && new Date(session.useBy).getTime() >= now && new Date(session.useBy).getTime() - now <= 86_400_000).length;
  const overdueCount = openSessions.filter((session) => session.useBy && new Date(session.useBy).getTime() < now).length;
  const wastedThisWeek = activeSessions.filter((session) => session.status === "wasted" && session.closedAt && now - new Date(session.closedAt).getTime() <= 7 * 86_400_000).length;
  const activeDashboard = useMemo(() => [...openSessions].sort((a, b) => (a.useBy || "9999").localeCompare(b.useBy || "9999")), [openSessions]);
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
  function takenFromLot(lotId: string) { return activeSessions.filter((session) => session.sourceReceiptId === lotId).length; }
  function sealedInLot(lot: Ingredient) { return Math.max(0, lot.quantity - takenFromLot(lot.id)); }
  function sealedInGroup(group: IngredientGroup) { return group.lots.reduce((sum, lot) => sum + sealedInLot(lot), 0); }
  function activeInGroup(group: IngredientGroup) { return openSessions.filter((session) => session.ingredientKey === group.key); }
  function activate(group: IngredientGroup, lot: Ingredient, reason: string, note = "") {
    const activatedAt = new Date().toISOString();
    const session: ActiveSession = { id: crypto.randomUUID(), sourceReceiptId: lot.id, ingredientKey: group.key, activatedAt, useBy: useByFor(activatedAt, lotMeta[lot.id]), status: "active", reason, note: note.trim() || undefined };
    setActiveSessions((current) => [session, ...current]);
    setActivationCandidate(undefined); setActivationReason(""); setActivationNote("");
  }
  function requestActivation(group: IngredientGroup, lot: Ingredient) {
    if (sealedInLot(lot) < 1) return;
    if (activeInGroup(group).length) { setActivationCandidate({ group, lot }); setActivationReason(""); setActivationNote(""); }
    else activate(group, lot, "first_open");
  }
  function confirmActivation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activationCandidate || !activationReason) return;
    const previous = activeInGroup(activationCandidate.group).sort((a, b) => a.activatedAt.localeCompare(b.activatedAt))[0];
    if (previous && activationReason === "previous_used") setActiveSessions((current) => current.map((session) => session.id === previous.id ? { ...session, status: "used", closedAt: new Date().toISOString(), reason: "used_up" } : session));
    if (previous && activationReason.startsWith("previous_waste_")) { const reason = activationReason.replace("previous_waste_", ""); setActiveSessions((current) => current.map((session) => session.id === previous.id ? { ...session, status: "wasted", closedAt: new Date().toISOString(), reason, note: activationNote.trim() || session.note } : session)); }
    activate(activationCandidate.group, activationCandidate.lot, activationReason, activationNote);
  }
  function requestClose(session: ActiveSession, status: "used" | "wasted") { setCloseCandidate({ session, status }); setCloseReason(status === "used" ? "used_up" : ""); setCloseNote(""); }
  function confirmClose(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (!closeCandidate || !closeReason) return; setActiveSessions((current) => current.map((session) => session.id === closeCandidate.session.id ? { ...session, status: closeCandidate.status, closedAt: new Date().toISOString(), reason: closeReason, note: closeNote.trim() || session.note } : session)); setCloseCandidate(undefined); setCloseReason(""); setCloseNote(""); }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || isSigningIn) return;

    setAuthError("");
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
  function openEdit(item: Ingredient) { const meta = lotMeta[item.id]; const parsedSpecification = parseSpecification(item.specification); const shelfLifeHours = meta?.shelfLifeHours; const useDays = shelfLifeHours && shelfLifeHours % 24 === 0; setForm({ name: item.name, category: item.category, brand: item.brand, unit: item.unit, quantity: String(item.quantity), specificationAmount: parsedSpecification.amount, specificationUnit: parsedSpecification.unit, specificationNote: parsedSpecification.note, unitCost: formatPriceInput(String(item.unitCost)), purchasedOn: item.purchasedOn, supplier: item.supplier, expiresOn: meta?.expiresOn || "", shelfLifeValue: shelfLifeHours ? String(useDays ? shelfLifeHours / 24 : shelfLifeHours) : "", shelfLifeUnit: useDays ? "days" : "hours", storageLocation: meta?.storageLocation || "Tủ mát" }); setReceipt(item.receipt); setEditingId(item.id); setShowForm(true); }
  function closeForm() { setShowForm(false); setEditingId(undefined); }
  async function saveIngredient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const quantity = Number(form.quantity); const unitCost = parsePrice(form.unitCost);
    if (!form.name.trim() || !quantity || !unitCost) return;
    const next = { name: form.name.trim(), category: form.category.trim() || "Chưa phân loại", brand: form.brand.trim() || "Chưa ghi thương hiệu", unit: form.unit, quantity, specification: buildSpecification(form.specificationAmount, form.specificationUnit, form.specificationNote), unitCost, purchasedOn: form.purchasedOn, supplier: form.supplier.trim() || "Chưa ghi nhà cung cấp", receipt };
    const current = editingId ? items.find((item) => item.id === editingId) : undefined;
    const changes = current ? changesFor(current, next) : [];
    const item: Ingredient = current ? { ...current, ...next, history: current.history } : { id: crypto.randomUUID(), ...next, history: [] };
    const eventRecord: HistoryEvent = { id: crypto.randomUUID(), at: new Date().toISOString(), action: current ? "updated" : "created", changes };
    const shelfLifeValue = Number(form.shelfLifeValue);
    setLotMeta((metadata) => ({ ...metadata, [item.id]: { expiresOn: form.expiresOn, shelfLifeHours: shelfLifeValue ? shelfLifeValue * (form.shelfLifeUnit === "days" ? 24 : 1) : undefined, storageLocation: form.storageLocation.trim() || "Chưa ghi" } }));
    if (current && !changes.length) { closeForm(); return; }
    if (isSupabaseConfigured && session) { await saveInventory(item, eventRecord, receiptFile); await refreshCloud(); }
    else setItems((all) => current ? all.map((entry) => entry.id === item.id ? { ...item, history: [eventRecord, ...entry.history] } : entry) : [{ ...item, history: [eventRecord] }, ...all]);
    closeForm();
  }
  async function removeItem(id: string) { if (!window.confirm("Xóa lần nhập kho này? Lịch sử của lần nhập cũng sẽ bị xóa.")) return; if (isSupabaseConfigured && session) { await removeInventory(id); await refreshCloud(); } else setItems((current) => current.filter((item) => item.id !== id)); }
  function changeSort(key: SortKey) { setSort((current) => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }); }
  function sortMarker(key: SortKey) { return sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : " ↕"; }
  function exportReportExcel() {
    const stringCell = (value: string, style = "Text") => `<Cell ss:StyleID="${style}"><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
    const numberCell = (value: number, style = "Number") => `<Cell ss:StyleID="${style}"><Data ss:Type="Number">${value}</Data></Cell>`;
    const dateCell = (value: string) => value ? `<Cell ss:StyleID="Date"><Data ss:Type="DateTime">${value}T00:00:00.000</Data></Cell>` : stringCell("", "Date");
    const filterDescription = [reportSearch && `Từ khóa: ${reportSearch}`, supplierFilter !== "all" && `NCC: ${supplierFilter}`, categoryFilter !== "all" && `Category: ${categoryFilter}`, brandFilter !== "all" && `Thương hiệu: ${brandFilter}`, dateFrom && `Từ ngày: ${formatDate(dateFrom)}`, dateTo && `Đến ngày: ${formatDate(dateTo)}`].filter(Boolean).join(" | ") || "Tất cả dữ liệu";
    const headers = ["Ngày mua", "Hạn sử dụng", "Nguyên liệu", "Category", "Thương hiệu", "Nhà cung cấp", "SL nhập", "Đơn vị", "Định lượng/đơn vị", "Tồn niêm phong", "Đang active", "Đơn giá", "Thành tiền", "Nơi bảo quản", "Dùng sau khi mở", "Hóa đơn", "Link hóa đơn"];
    const rows = reportRows.map((item) => {
      const meta = lotMeta[item.id];
      const openCount = openSessions.filter((activeSession) => activeSession.sourceReceiptId === item.id).length;
      const receiptLink = item.receipt?.dataUrl || "";
      const linkCell = receiptLink ? `<Cell ss:StyleID="Link" ss:HRef="${escapeXml(receiptLink)}"><Data ss:Type="String">Mở hóa đơn</Data></Cell>` : stringCell("");
      return `<Row>${dateCell(item.purchasedOn)}${dateCell(meta?.expiresOn || "")}${stringCell(item.name)}${stringCell(item.category)}${stringCell(item.brand)}${stringCell(item.supplier)}${numberCell(item.quantity)}${stringCell(item.unit)}${stringCell(item.specification)}${numberCell(sealedInLot(item))}${numberCell(openCount)}${numberCell(item.unitCost, "Currency")}${numberCell(item.quantity * item.unitCost, "Currency")}${stringCell(meta?.storageLocation || "Chưa ghi")}${stringCell(shelfLifeLabel(meta?.shelfLifeHours))}${stringCell(item.receipt?.name || "Không có")}${linkCell}</Row>`;
    }).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Aptos" ss:Size="10"/></Style><Style ss:ID="Title"><Font ss:FontName="Aptos Display" ss:Size="16" ss:Bold="1" ss:Color="#17312B"/><Alignment ss:Vertical="Center"/></Style><Style ss:ID="Subtitle"><Font ss:FontName="Aptos" ss:Size="9" ss:Color="#71786E"/><Alignment ss:Vertical="Center"/></Style><Style ss:ID="Header"><Font ss:FontName="Aptos" ss:Size="9" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1E4B3F" ss:Pattern="Solid"/><Alignment ss:Vertical="Center" ss:WrapText="1"/></Style><Style ss:ID="Text"><Alignment ss:Vertical="Center" ss:WrapText="1"/></Style><Style ss:ID="Number"><NumberFormat ss:Format="#,##0.00"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style><Style ss:ID="Currency"><NumberFormat ss:Format="#,##0 [$₫-vi-VN]"/><Alignment ss:Horizontal="Right" ss:Vertical="Center"/></Style><Style ss:ID="Date"><NumberFormat ss:Format="dd/mm/yyyy"/><Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style><Style ss:ID="Link"><Font ss:Color="#1E4B3F" ss:Underline="Single"/><Alignment ss:Vertical="Center"/></Style></Styles><Worksheet ss:Name="Báo cáo nhập kho"><Table ss:ExpandedColumnCount="17" ss:ExpandedRowCount="${reportRows.length + 3}" x:FullColumns="1" x:FullRows="1"><Column ss:Width="72"/><Column ss:Width="78"/><Column ss:Width="130"/><Column ss:Width="80"/><Column ss:Width="90"/><Column ss:Width="120"/><Column ss:Width="58"/><Column ss:Width="55"/><Column ss:Width="105"/><Column ss:Width="82"/><Column ss:Width="70"/><Column ss:Width="82"/><Column ss:Width="90"/><Column ss:Width="90"/><Column ss:Width="95"/><Column ss:Width="130"/><Column ss:Width="82"/><Row ss:Height="26"><Cell ss:MergeAcross="16" ss:StyleID="Title"><Data ss:Type="String">Báo cáo nhập kho — Nhà Coffee &amp; Tea</Data></Cell></Row><Row ss:Height="22"><Cell ss:MergeAcross="16" ss:StyleID="Subtitle"><Data ss:Type="String">Bộ lọc: ${escapeXml(filterDescription)} | Xuất lúc: ${escapeXml(formatDateTime(new Date().toISOString()))}</Data></Cell></Row><Row ss:Height="30">${headers.map((header) => stringCell(header, "Header")).join("")}</Row>${rows}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>3</SplitHorizontal><TopRowBottomPane>3</TopRowBottomPane><DoNotDisplayGridlines/></WorksheetOptions><AutoFilter x:Range="R3C1:R${reportRows.length + 3}C17" xmlns="urn:schemas-microsoft-com:office:excel"/></Worksheet></Workbook>`;
    const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = `bao-cao-nhap-kho-${new Date().toISOString().slice(0, 10)}.xls`; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }

  if (isSupabaseConfigured && !session) return <main className="login">
    <section className="login-visual">
      <div className="login-mark" aria-hidden="true">N</div>
      <div className="eyebrow">NHA COFFEE & TEA</div>
      <h1>Nhà Ops</h1>
      <p>Quản lý nhập kho rõ ràng, đồng bộ cho cả quán.</p>
      <div className="login-note"><span aria-hidden="true">✓</span> Dữ liệu dùng chung, có lịch sử thay đổi</div>
    </section>
    <form className="login-form" onSubmit={signIn}>
      <div className="login-heading"><h2>Chào mừng trở lại</h2><p>Đăng nhập để tiếp tục vào kho nguyên liệu.</p></div>
      <label htmlFor="login-username">Tên đăng nhập</label>
      <input id="login-username" required autoComplete="username" inputMode="email" type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} placeholder="email@nhacoffee.vn" />
      <div className="password-label"><label htmlFor="login-password">Mật khẩu</label><span>Chỉ dành cho nhân sự</span></div>
      <input id="login-password" required autoComplete="current-password" type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} placeholder="Nhập mật khẩu" />
      {authError && <p className="login-error" role="alert">{authError}</p>}
      <button className="login-submit" type="submit" disabled={isSigningIn}>{isSigningIn ? "Đang đăng nhập..." : "Đăng nhập"}<span aria-hidden="true">→</span></button>
      <p className="login-help">Tên đăng nhập hiện dùng email của tài khoản vận hành.</p>
    </form>
  </main>;
  return <main>
    <section className="hero">
      <div className="eyebrow">NHA COFFEE & TEA</div>
      <div className="hero-row"><div><h1>{tab === "inventory" ? "Kho nguyên liệu" : tab === "active" ? "Đang sử dụng" : "Báo cáo nhập kho"}</h1><p>{tab === "inventory" ? "Tìm nguyên liệu, xem tồn và mở để sử dụng." : tab === "active" ? "Ưu tiên những món sắp hư hoặc đã mở lâu." : "Lọc và sắp xếp dữ liệu nhập nguyên liệu."}</p></div><span className="live-dot">UAT local</span></div>
      <div className="metric"><span>{tab === "active" ? "Đơn vị đang active" : "Giá trị kho đã ghi nhận"}</span><strong>{tab === "active" ? openSessions.length : formatMoney(totalValue)}</strong><small>{tab === "active" ? `${overdueCount} quá hạn · ${expiringSoonCount} sắp đến hạn` : `${items.length} lần nhập hàng`}</small></div>
    </section>
    <nav className="tabs" aria-label="Điều hướng"><button className={tab === "inventory" ? "active" : ""} onClick={() => setTab("inventory")}>Kho NVL</button><button className={tab === "active" ? "active" : ""} onClick={() => setTab("active")}>Đang dùng</button><button className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>Báo cáo</button></nav>

    {tab === "inventory" && <section className="content">
      <div className="section-head"><div><h2>Nguyên vật liệu</h2><p>{items.length ? "Gộp theo sản phẩm, xem chi tiết theo lô" : "Bắt đầu bằng lần nhập đầu tiên"}</p></div><button className="add-button" onClick={openAdd} aria-label="Thêm nguyên vật liệu">+</button></div>
      <label className="search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm NVL, thương hiệu hoặc nhà cung cấp" /></label>
      {!loaded ? <p className="empty">Đang tải kho...</p> : filteredGroups.length === 0 ? <div className="empty"><b>{items.length ? "Không tìm thấy nguyên liệu" : "Kho đang trống"}</b><span>{items.length ? "Thử một từ khóa khác." : "Nhấn dấu + để ghi nhận lần mua nguyên liệu đầu tiên."}</span></div> : <div className="inventory-list">{filteredGroups.map((group) => {
        const sealed = sealedInGroup(group); const active = activeInGroup(group).length;
        return <button className="ingredient-summary" key={group.key} onClick={() => setDetailGroup(group)}><div><span className="category-pill">{group.category}</span><h3>{group.name}</h3><p>{group.brand} · {group.specification}</p></div><div className="summary-counts"><span><b>{sealed.toLocaleString("vi-VN")}</b> niêm phong</span><span className={active ? "has-active" : ""}><b>{active}</b> active</span></div><span className="summary-arrow">→</span></button>;
      })}</div>}
    </section>}

    {tab === "active" && <section className="content active-dashboard">
      <div className="status-grid"><div><span>Đang active</span><strong>{openSessions.length}</strong></div><div className="warning"><span>Sắp hạn 24h</span><strong>{expiringSoonCount}</strong></div><div className="danger"><span>Quá hạn</span><strong>{overdueCount}</strong></div><div><span>Hao hụt 7 ngày</span><strong>{wastedThisWeek}</strong></div></div>
      <div className="dashboard-head"><div><h2>Cần theo dõi</h2><p>Sắp xếp theo hạn dùng gần nhất</p></div></div>
      {activeDashboard.length === 0 ? <div className="empty"><b>Chưa có nguyên liệu active</b><span>Vào Kho NVL, chọn một nguyên liệu và nhấn “Mở để sử dụng”.</span></div> : <div className="active-list">{activeDashboard.map((activeSession) => {
        const group = ingredientGroups.find((entry) => entry.key === activeSession.ingredientKey); const lot = items.find((entry) => entry.id === activeSession.sourceReceiptId); const remaining = activeSession.useBy ? new Date(activeSession.useBy).getTime() - now : undefined; const totalLife = activeSession.useBy ? new Date(activeSession.useBy).getTime() - new Date(activeSession.activatedAt).getTime() : undefined; const elapsed = totalLife ? Math.min(100, Math.max(4, ((now - new Date(activeSession.activatedAt).getTime()) / totalLife) * 100)) : 12; const urgency = remaining === undefined ? "neutral" : remaining < 0 ? "overdue" : remaining <= 86_400_000 ? "soon" : "safe";
        return <article className={`active-card ${urgency}`} key={activeSession.id}><div className="active-card-top"><div><span>{group?.category || "Nguyên liệu"}</span><h3>{group?.name || lot?.name || "Không xác định"}</h3><p>Mở {formatDateTime(activeSession.activatedAt)} · đã {formatDuration(now - new Date(activeSession.activatedAt).getTime())}</p></div><b>{remaining === undefined ? "Chưa đặt hạn" : remaining < 0 ? `Quá ${formatDuration(remaining)}` : `Còn ${formatDuration(remaining)}`}</b></div><div className="life-bar"><i style={{ width: `${elapsed}%` }} /></div><div className="active-meta"><span>Lô {lot ? formatDate(lot.purchasedOn) : "-"}</span><span>{lotMeta[activeSession.sourceReceiptId]?.storageLocation || "Chưa ghi nơi bảo quản"}</span></div><div className="active-actions"><button onClick={() => requestClose(activeSession, "used")}>Đã dùng hết</button><button className="waste" onClick={() => requestClose(activeSession, "wasted")}>Báo hỏng</button><button onClick={() => group && setDetailGroup(group)}>Chi tiết</button></div></article>;
      })}</div>}
    </section>}

    {tab === "report" && <section className="content report"><div className="report-toolbar"><div className="report-summary"><div><span>Số dòng</span><strong>{reportRows.length}</strong></div><div><span>Giá trị theo bộ lọc</span><strong>{formatMoney(reportRows.reduce((sum, item) => sum + item.quantity * item.unitCost, 0))}</strong></div></div><button className="export-button" type="button" disabled={!reportRows.length} onClick={exportReportExcel}><span>⇩</span> Xuất Excel</button></div><label className="search"><span>⌕</span><input value={reportSearch} onChange={(event) => setReportSearch(event.target.value)} placeholder="Tìm NVL, category, thương hiệu..." /></label><div className="filters"><label>Nhà cung cấp<select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}><option value="all">Tất cả</option>{suppliers.map((supplier) => <option key={supplier}>{supplier}</option>)}</select></label><label>Category<select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">Tất cả</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><label>Thương hiệu<select value={brandFilter} onChange={(event) => setBrandFilter(event.target.value)}><option value="all">Tất cả</option>{brands.map((brand) => <option key={brand}>{brand}</option>)}</select></label><label>Từ ngày<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>Đến ngày<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div><div className="table-wrap"><table className="report-table"><thead><tr><th><button onClick={() => changeSort("purchasedOn")}>Ngày mua{sortMarker("purchasedOn")}</button></th><th>HSD</th><th><button onClick={() => changeSort("name")}>Nguyên liệu{sortMarker("name")}</button></th><th>Category</th><th>Thương hiệu</th><th>Nhà cung cấp</th><th><button onClick={() => changeSort("quantity")}>SL nhập{sortMarker("quantity")}</button></th><th>Định lượng</th><th>Tồn kín</th><th>Active</th><th><button onClick={() => changeSort("unitCost")}>Đơn giá{sortMarker("unitCost")}</button></th><th><button onClick={() => changeSort("total")}>Thành tiền{sortMarker("total")}</button></th><th>Bảo quản</th><th>Sau mở</th><th>Hóa đơn</th></tr></thead><tbody>{reportRows.map((item) => { const meta = lotMeta[item.id]; const activeCount = openSessions.filter((activeSession) => activeSession.sourceReceiptId === item.id).length; return <tr key={item.id}><td>{formatDate(item.purchasedOn)}</td><td>{meta?.expiresOn ? formatDate(meta.expiresOn) : "-"}</td><td><button className="table-detail-button" onClick={() => setDetailLot(item)}><b>{item.name}</b><span>Xem chi tiết</span></button></td><td>{item.category}</td><td>{item.brand}</td><td>{item.supplier}</td><td>{item.quantity.toLocaleString("vi-VN")} {item.unit}</td><td>{item.specification}</td><td>{sealedInLot(item).toLocaleString("vi-VN")} {item.unit}</td><td>{activeCount}</td><td>{formatMoney(item.unitCost)}</td><td><b>{formatMoney(item.quantity * item.unitCost)}</b></td><td>{meta?.storageLocation || "-"}</td><td>{shelfLifeLabel(meta?.shelfLifeHours)}</td><td>{item.receipt?.dataUrl ? <a className="table-receipt" href={item.receipt.dataUrl} target="_blank" rel="noreferrer">Mở HĐ</a> : item.receipt ? "Có file" : "-"}</td></tr>; })}{reportRows.length === 0 && <tr><td colSpan={15} className="no-result">Không có dữ liệu phù hợp.</td></tr>}</tbody></table></div></section>}

    {selectedGroup && <div className="sheet-backdrop" role="presentation" onMouseDown={() => setDetailGroup(undefined)}><aside className="sheet detail-sheet" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>CHI TIẾT NGUYÊN LIỆU</p><h2>{selectedGroup.name}</h2><span>{selectedGroup.brand} · {selectedGroup.specification}</span></div><button type="button" className="close" onClick={() => setDetailGroup(undefined)}>×</button></div><div className="detail-totals"><div><span>Niêm phong</span><strong>{sealedInGroup(selectedGroup).toLocaleString("vi-VN")} {selectedGroup.unit}</strong></div><div><span>Đang active</span><strong>{activeInGroup(selectedGroup).length} {selectedGroup.unit}</strong></div></div>
      <section className="detail-section"><h3>Đang active</h3>{activeInGroup(selectedGroup).length === 0 ? <p className="detail-empty">Chưa có {selectedGroup.unit} nào đang sử dụng.</p> : activeInGroup(selectedGroup).map((activeSession, index) => <article className="detail-active" key={activeSession.id}><div><b>{selectedGroup.unit} active #{index + 1}</b><span>Mở {formatDateTime(activeSession.activatedAt)}</span><span>{activeSession.useBy ? `Dùng trước ${formatDateTime(activeSession.useBy)}` : "Chưa thiết lập hạn sau khi mở"}</span></div><div><button onClick={() => requestClose(activeSession, "used")}>Dùng hết</button><button className="waste" onClick={() => requestClose(activeSession, "wasted")}>Báo hỏng</button></div></article>)}</section>
      <section className="detail-section"><h3>Lô hàng nguồn</h3>{[...selectedGroup.lots].sort((a, b) => (lotMeta[a.id]?.expiresOn || "9999").localeCompare(lotMeta[b.id]?.expiresOn || "9999")).map((lot) => { const meta = lotMeta[lot.id]; const sealed = sealedInLot(lot); return <article className="lot-card" key={lot.id}><button className="lot-summary-button" onClick={() => setDetailLot(lot)}><div className="lot-top"><div><b>Nhập {formatDate(lot.purchasedOn)}</b><span>{lot.supplier}</span></div><strong>{sealed.toLocaleString("vi-VN")}/{lot.quantity.toLocaleString("vi-VN")} {lot.unit}</strong></div><div className="lot-meta"><span>HSD: {meta?.expiresOn ? formatDate(meta.expiresOn) : "Chưa ghi"}</span><span>Sau mở: {meta?.shelfLifeHours ? meta.shelfLifeHours >= 24 && meta.shelfLifeHours % 24 === 0 ? `${meta.shelfLifeHours / 24} ngày` : `${meta.shelfLifeHours} giờ` : "Chưa ghi"}</span><span>{meta?.storageLocation || "Chưa ghi nơi bảo quản"}</span></div><span className="lot-detail-link">Xem chi tiết nhập kho & hóa đơn →</span></button><button className="activate-button" disabled={sealed < 1} onClick={() => requestActivation(selectedGroup, lot)}>{sealed < 1 ? "Lô đã hết" : `Mở 1 ${lot.unit} để sử dụng`}</button><div className="lot-actions"><button onClick={() => openEdit(lot)}>Sửa lô</button><button onClick={() => setHistoryItem(lot)}>Lịch sử</button><button disabled={takenFromLot(lot.id) > 0} onClick={() => removeItem(lot.id)}>Xóa</button></div></article>; })}</section>
    </aside></div>}

    {detailLot && <div className="sheet-backdrop lot-detail-backdrop" role="presentation" onMouseDown={() => setDetailLot(undefined)}><aside className="sheet lot-detail-sheet" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>CHI TIẾT LÔ NHẬP KHO</p><h2>{detailLot.name}</h2><span>{detailLot.category} · {detailLot.brand}</span></div><button type="button" className="close" onClick={() => setDetailLot(undefined)}>×</button></div><div className="lot-detail-grid"><div><span>SL tổng</span><strong>{detailLot.quantity.toLocaleString("vi-VN")} {detailLot.unit}</strong></div><div><span>Tồn niêm phong</span><strong>{sealedInLot(detailLot).toLocaleString("vi-VN")} {detailLot.unit}</strong></div><div><span>Định lượng/{detailLot.unit}</span><strong>{detailLot.specification}</strong></div><div><span>Đơn giá</span><strong>{formatMoney(detailLot.unitCost)}</strong></div><div><span>Thành tiền</span><strong>{formatMoney(detailLot.quantity * detailLot.unitCost)}</strong></div><div><span>Ngày mua</span><strong>{formatDate(detailLot.purchasedOn)}</strong></div><div><span>Hạn sử dụng</span><strong>{lotMeta[detailLot.id]?.expiresOn ? formatDate(lotMeta[detailLot.id].expiresOn) : "Chưa ghi"}</strong></div><div><span>Dùng sau khi mở</span><strong>{lotMeta[detailLot.id]?.shelfLifeHours ? lotMeta[detailLot.id].shelfLifeHours! >= 24 && lotMeta[detailLot.id].shelfLifeHours! % 24 === 0 ? `${lotMeta[detailLot.id].shelfLifeHours! / 24} ngày` : `${lotMeta[detailLot.id].shelfLifeHours} giờ` : "Chưa ghi"}</strong></div><div><span>Nhà cung cấp</span><strong>{detailLot.supplier}</strong></div><div><span>Nơi bảo quản</span><strong>{lotMeta[detailLot.id]?.storageLocation || "Chưa ghi"}</strong></div></div><section className="receipt-detail"><h3>Hóa đơn đính kèm</h3>{detailLot.receipt ? <div><span>▣ {detailLot.receipt.name}</span>{detailLot.receipt.dataUrl ? <a href={detailLot.receipt.dataUrl} target="_blank" rel="noreferrer">Mở hóa đơn</a> : <small>File đã ghi nhận nhưng đường dẫn xem hiện không khả dụng.</small>}</div> : <p>Chưa có hóa đơn được đính kèm cho lô này.</p>}</section><div className="lot-detail-actions"><button onClick={() => { setDetailLot(undefined); openEdit(detailLot); }}>Sửa thông tin lô</button><button onClick={() => setHistoryItem(detailLot)}>Xem lịch sử</button></div></aside></div>}

    {showForm && <div className="sheet-backdrop" role="presentation" onMouseDown={closeForm}><form className="sheet" onSubmit={saveIngredient} onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>{editingId ? "CẬP NHẬT LÔ NHẬP" : "NHẬP KHO"}</p><h2>{editingId ? "Sửa nguyên liệu" : "Thêm nguyên liệu"}</h2></div><button type="button" className="close" onClick={closeForm}>×</button></div><label>Tên nguyên liệu<input required autoFocus value={form.name} onChange={(event) => updateForm("name", event.target.value)} placeholder="Ví dụ: Sữa tươi" /></label><div className="form-row"><label>Category<input required list="category-options" value={form.category} onChange={(event) => updateForm("category", event.target.value)} placeholder="Ví dụ: Sữa" /><datalist id="category-options">{categories.map((category) => <option value={category} key={category} />)}</datalist></label><label>Thương hiệu<input list="brand-options" value={form.brand} onChange={(event) => updateForm("brand", event.target.value)} placeholder="Gõ để chọn hoặc thêm mới" /><datalist id="brand-options">{brands.map((brand) => <option value={brand} key={brand} />)}</datalist></label></div><div className="form-row"><label>SL tổng<input required min="0" step="0.01" inputMode="decimal" value={form.quantity} onChange={(event) => updateForm("quantity", event.target.value)} placeholder="Ví dụ: 3" /></label><label>Đơn vị<select value={form.unit} onChange={(event) => updateForm("unit", event.target.value)}><option>chai</option><option>gói</option><option>hộp</option><option>lon</option><option>túi</option><option>kg</option><option>lít</option></select></label></div><div className="form-row specification-row"><label>Định lượng mỗi đơn vị<input min="0" step="0.01" inputMode="decimal" type="number" value={form.specificationAmount} onChange={(event) => updateForm("specificationAmount", event.target.value)} placeholder="Ví dụ: 200" /></label><label>Đơn vị định lượng<select value={form.specificationUnit} onChange={(event) => updateForm("specificationUnit", event.target.value)}><option value="ml">ml</option><option value="l">lít (l)</option><option value="g">gram (g)</option><option value="kg">kilogram (kg)</option><option value="mg">milligram (mg)</option><option value="oz">ounce (oz)</option><option value="cái">cái</option><option value="viên">viên</option><option value="phần">phần</option></select></label></div><label>Đơn giá (VND)<input required inputMode="numeric" value={form.unitCost} onChange={(event) => updateForm("unitCost", formatPriceInput(event.target.value))} placeholder="Ví dụ: 53,000" /><small>Giá của một {form.unit}; có thể gõ theo dạng 53,000.</small></label><div className="form-row"><label>Ngày mua<input required type="date" value={form.purchasedOn} onChange={(event) => updateForm("purchasedOn", event.target.value)} /><small>Hiển thị trong hệ thống: {form.purchasedOn ? formatDate(form.purchasedOn) : "dd/mm/yyyy"}</small></label><label>Hạn sử dụng<input type="date" value={form.expiresOn} onChange={(event) => updateForm("expiresOn", event.target.value)} /><small>Hiển thị trong hệ thống: {form.expiresOn ? formatDate(form.expiresOn) : "dd/mm/yyyy"}</small></label></div><div className="form-row shelf-life-row"><label>Dùng trong vòng sau mở<input min="0" type="number" inputMode="decimal" value={form.shelfLifeValue} onChange={(event) => updateForm("shelfLifeValue", event.target.value)} placeholder="Ví dụ: 3" /></label><label>Đơn vị thời gian<select value={form.shelfLifeUnit} onChange={(event) => updateForm("shelfLifeUnit", event.target.value as FormValues["shelfLifeUnit"])}><option value="hours">Giờ</option><option value="days">Ngày</option></select></label></div><div className="form-row"><label>Nhà cung cấp<input list="supplier-options" value={form.supplier} onChange={(event) => updateForm("supplier", event.target.value)} placeholder="Gõ để chọn hoặc thêm mới" /><datalist id="supplier-options">{suppliers.map((supplier) => <option value={supplier} key={supplier} />)}</datalist></label><label>Nơi bảo quản<select value={form.storageLocation} onChange={(event) => updateForm("storageLocation", event.target.value)}><option>Tủ mát</option><option>Tủ đông</option><option>Kho khô</option><option>Quầy bar</option><option>Khác</option></select></label></div><fieldset className="receipt-fieldset"><legend>Đính kèm hóa đơn</legend><div className="receipt-options"><label className="receipt-choice camera-choice"><input type="file" accept="image/*" capture="environment" onChange={attachReceipt} /><span className="receipt-icon">◎</span><b>Chụp bằng camera</b><small>Mở camera sau trên điện thoại</small></label><label className="receipt-choice"><input type="file" accept="image/*,.pdf" onChange={attachReceipt} /><span className="receipt-icon">⇧</span><b>Chọn ảnh / PDF</b><small>Tải file có sẵn từ thiết bị</small></label></div>{receipt && <div className="selected-receipt">✓ Đã chọn: <b>{receipt.name}</b></div>}</fieldset><p className="uat-note">Dữ liệu HSD và active đang lưu local trong bản UAT; chưa thay đổi Supabase thật.</p><button className="save-button" type="submit">{editingId ? "Lưu thay đổi" : "Lưu lần nhập kho"}</button></form></div>}

    {activationCandidate && <div className="sheet-backdrop action-backdrop" role="presentation" onMouseDown={() => setActivationCandidate(undefined)}><form className="sheet action-sheet" onSubmit={confirmActivation} onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>CROSS-CHECK TRƯỚC KHI MỞ</p><h2>Đang có {activeInGroup(activationCandidate.group).length} {activationCandidate.group.unit} active</h2></div><button type="button" className="close" onClick={() => setActivationCandidate(undefined)}>×</button></div><div className="cross-check-alert"><b>{activationCandidate.group.name}</b><span>Hộp cũ chưa được đánh dấu là đã sử dụng hết. Chọn tình huống thực tế trước khi mở thêm.</span></div><label>Tình huống<select required value={activationReason} onChange={(event) => setActivationReason(event.target.value)}><option value="">Chọn một lý do</option><optgroup label="Hộp cũ đã kết thúc"><option value="previous_used">Hộp cũ đã sử dụng hết</option>{closeReasons.filter(([key]) => key !== "used_up").map(([key, label]) => <option value={`previous_waste_${key}`} key={key}>Hộp cũ: {label}</option>)}</optgroup><optgroup label="Giữ hộp cũ và mở thêm">{activationReasons.map(([key, label]) => <option value={key} key={key}>{label}</option>)}</optgroup></select></label><label>Ghi chú {activationReason.endsWith("other") ? "(bắt buộc)" : "(không bắt buộc)"}<textarea required={activationReason.endsWith("other")} value={activationNote} onChange={(event) => setActivationNote(event.target.value)} placeholder="Mô tả ngắn nếu cần" /></label><button className="save-button" type="submit">Xác nhận mở thêm 1 {activationCandidate.group.unit}</button></form></div>}

    {closeCandidate && <div className="sheet-backdrop action-backdrop" role="presentation" onMouseDown={() => setCloseCandidate(undefined)}><form className="sheet action-sheet" onSubmit={confirmClose} onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>KẾT THÚC ACTIVE</p><h2>{closeCandidate.status === "used" ? "Xác nhận đã dùng hết" : "Ghi nhận hư hỏng"}</h2></div><button type="button" className="close" onClick={() => setCloseCandidate(undefined)}>×</button></div>{closeCandidate.status === "wasted" && <label>Lý do<select required value={closeReason} onChange={(event) => setCloseReason(event.target.value)}><option value="">Chọn lý do</option>{closeReasons.filter(([key]) => key !== "used_up").map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>}<label>Ghi chú {closeReason === "other" ? "(bắt buộc)" : "(không bắt buộc)"}<textarea required={closeReason === "other"} value={closeNote} onChange={(event) => setCloseNote(event.target.value)} placeholder="Mô tả ngắn nếu cần" /></label><button className={`save-button ${closeCandidate.status === "wasted" ? "danger-button" : ""}`} type="submit">{closeCandidate.status === "used" ? "Đánh dấu đã dùng hết" : "Ghi nhận hư/hủy"}</button></form></div>}

    {historyItem && <div className="sheet-backdrop" role="presentation" onMouseDown={() => setHistoryItem(undefined)}><aside className="sheet history-sheet" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>NHẬT KÝ THAY ĐỔI</p><h2>{historyItem.name}</h2></div><button type="button" className="close" onClick={() => setHistoryItem(undefined)}>×</button></div><div className="history-list">{historyItem.history.map((event) => <article className="history-event" key={event.id}><div><strong>{event.action === "created" ? "Tạo lần nhập" : "Đã cập nhật"}</strong><span>{formatTime(event.at)}</span></div>{event.action === "created" ? <p>Đã ghi nhận lần nhập kho đầu tiên.</p> : event.changes.map((change) => <p key={change.field}><b>{fieldLabels[change.field]}</b><del>{change.from}</del><ins>{change.to}</ins></p>)}</article>)}</div></aside></div>}
  </main>;
}

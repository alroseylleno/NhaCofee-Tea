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
type FormValues = { name: string; category: string; brand: string; unit: string; quantity: string; specification: string; unitCost: string; purchasedOn: string; supplier: string };
type SortKey = "purchasedOn" | "name" | "quantity" | "unitCost" | "total";

const STORAGE_KEY = "nha-ops-inventory-v1";
const formDefaults = (): FormValues => ({ name: "", category: "", brand: "", unit: "chai", quantity: "", specification: "", unitCost: "", purchasedOn: new Date().toISOString().slice(0, 10), supplier: "" });
const fieldLabels: Record<string, string> = { name: "Tên NVL", category: "Category", brand: "Thương hiệu", unit: "Đơn vị", quantity: "SL tổng", specification: "Định lượng", unitCost: "Đơn giá", purchasedOn: "Ngày mua", supplier: "Nhà cung cấp", receipt: "Hóa đơn" };

function formatMoney(value: number) { return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value); }
function formatDate(date: string) { return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${date}T00:00:00`)); }
function formatTime(value: string) { return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatPriceInput(value: string) { const digits = value.replace(/\D/g, ""); return digits ? Number(digits).toLocaleString("en-US") : ""; }
function parsePrice(value: string) { return Number(value.replace(/\D/g, "")); }
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
  const [editingId, setEditingId] = useState<string | undefined>();
  const [historyItem, setHistoryItem] = useState<Ingredient | undefined>();
  const [showForm, setShowForm] = useState(false);
  const [tab, setTab] = useState<"inventory" | "report">("inventory");
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
    if (!isSupabaseConfigured || !supabase) { const stored = window.localStorage.getItem(STORAGE_KEY); if (stored) setItems(safeItems(JSON.parse(stored))); setLoaded(true); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); if (data.session) refreshCloud(); else setLoaded(true); });
    return supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); if (nextSession) refreshCloud(); }).data.subscription.unsubscribe;
  }, []);
  useEffect(() => { if (loaded && !isSupabaseConfigured) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); }, [items, loaded]);

  const totalValue = items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);
  const filteredInventory = useMemo(() => items.filter((item) => `${item.name} ${item.category} ${item.brand} ${item.supplier}`.toLowerCase().includes(search.toLowerCase())), [items, search]);
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

  function updateForm(field: keyof FormValues, value: string) { setForm((current) => ({ ...current, [field]: value })); }
  function attachReceipt(event: ChangeEvent<HTMLInputElement>) { const file = event.target.files?.[0]; if (!file) return; setReceiptFile(file); const reader = new FileReader(); reader.onload = () => setReceipt({ name: file.name, dataUrl: String(reader.result) }); reader.readAsDataURL(file); }
  function openAdd() { setForm(formDefaults()); setReceipt(undefined); setReceiptFile(undefined); setEditingId(undefined); setShowForm(true); }
  function openEdit(item: Ingredient) { setForm({ name: item.name, category: item.category, brand: item.brand, unit: item.unit, quantity: String(item.quantity), specification: item.specification, unitCost: formatPriceInput(String(item.unitCost)), purchasedOn: item.purchasedOn, supplier: item.supplier }); setReceipt(item.receipt); setEditingId(item.id); setShowForm(true); }
  function closeForm() { setShowForm(false); setEditingId(undefined); }
  async function saveIngredient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const quantity = Number(form.quantity); const unitCost = parsePrice(form.unitCost);
    if (!form.name.trim() || !quantity || !unitCost) return;
    const next = { name: form.name.trim(), category: form.category.trim() || "Chưa phân loại", brand: form.brand.trim() || "Chưa ghi thương hiệu", unit: form.unit, quantity, specification: form.specification.trim() || "Chưa ghi định lượng", unitCost, purchasedOn: form.purchasedOn, supplier: form.supplier.trim() || "Chưa ghi nhà cung cấp", receipt };
    const current = editingId ? items.find((item) => item.id === editingId) : undefined;
    const changes = current ? changesFor(current, next) : [];
    const item: Ingredient = current ? { ...current, ...next, history: current.history } : { id: crypto.randomUUID(), ...next, history: [] };
    const eventRecord: HistoryEvent = { id: crypto.randomUUID(), at: new Date().toISOString(), action: current ? "updated" : "created", changes };
    if (current && !changes.length) { closeForm(); return; }
    if (isSupabaseConfigured && session) { await saveInventory(item, eventRecord, receiptFile); await refreshCloud(); }
    else setItems((all) => current ? all.map((entry) => entry.id === item.id ? { ...item, history: [eventRecord, ...entry.history] } : entry) : [{ ...item, history: [eventRecord] }, ...all]);
    closeForm();
  }
  async function removeItem(id: string) { if (!window.confirm("Xóa lần nhập kho này? Lịch sử của lần nhập cũng sẽ bị xóa.")) return; if (isSupabaseConfigured && session) { await removeInventory(id); await refreshCloud(); } else setItems((current) => current.filter((item) => item.id !== id)); }
  function changeSort(key: SortKey) { setSort((current) => current.key === key ? { key, direction: current.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }); }
  function sortMarker(key: SortKey) { return sort.key === key ? (sort.direction === "asc" ? " ↑" : " ↓") : " ↕"; }

  if (isSupabaseConfigured && !session) return <main className="login"><section className="hero"><div className="eyebrow">NHA COFFEE & TEA</div><h1>Nhà Ops</h1><p>Đăng nhập tài khoản vận hành quán.</p></section><form className="content" onSubmit={async (event) => { event.preventDefault(); if (!supabase) return; const { error } = await supabase.auth.signInWithPassword({ email: loginEmail, password: loginPassword }); setAuthError(error?.message || ""); }}><label>Email<input required type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} /></label><label>Mật khẩu<input required type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} /></label>{authError && <p>{authError}</p>}<button className="save-button">Đăng nhập</button></form></main>;
  return <main>
    <section className="hero"><div className="eyebrow">NHA COFFEE & TEA</div><div className="hero-row"><div><h1>{tab === "inventory" ? "Kho nguyên liệu" : "Báo cáo nhập kho"}</h1><p>{tab === "inventory" ? "Ghi lại từng lần nhập, không bỏ sót hóa đơn." : "Lọc và sắp xếp dữ liệu nhập nguyên liệu."}</p></div><span className="live-dot">Đang dùng</span></div><div className="metric"><span>Giá trị kho đã ghi nhận</span><strong>{formatMoney(totalValue)}</strong><small>{items.length} lần nhập hàng</small></div></section>
    <nav className="tabs" aria-label="Điều hướng"><button className={tab === "inventory" ? "active" : ""} onClick={() => setTab("inventory")}>Kho NVL</button><button className={tab === "report" ? "active" : ""} onClick={() => setTab("report")}>Báo cáo</button></nav>
    {tab === "inventory" ? <section className="content"><div className="section-head"><div><h2>Nguyên vật liệu</h2><p>{items.length ? "Theo từng lần nhập hàng" : "Bắt đầu bằng lần nhập đầu tiên"}</p></div><button className="add-button" onClick={openAdd} aria-label="Thêm nguyên vật liệu">+</button></div><label className="search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm NVL, thương hiệu hoặc nhà cung cấp" /></label>
      {!loaded ? <p className="empty">Đang tải kho...</p> : filteredInventory.length === 0 ? <div className="empty"><b>{items.length ? "Không tìm thấy nguyên liệu" : "Kho đang trống"}</b><span>{items.length ? "Thử một từ khóa khác." : "Nhấn dấu + để ghi nhận lần mua nguyên liệu đầu tiên."}</span></div> : <div className="inventory-list">{filteredInventory.map((item) => <article className="inventory-card" key={item.id}><div className="item-top"><div><h3>{item.name}</h3><p><em>{item.category}</em> · {item.brand} · {formatDate(item.purchasedOn)}</p><p>{item.supplier}</p></div><button className="delete-button" onClick={() => removeItem(item.id)}>Xóa</button></div><div className="item-data"><div><span>SL tổng</span><strong>{item.quantity.toLocaleString("vi-VN")} {item.unit}</strong></div><div><span>Định lượng/{item.unit}</span><strong>{item.specification}</strong></div><div><span>Thành tiền</span><strong>{formatMoney(item.quantity * item.unitCost)}</strong></div></div><p className="unit-price">Đơn giá: {formatMoney(item.unitCost)}/{item.unit}</p>{item.receipt && <a className="receipt" href={item.receipt.dataUrl} target="_blank" rel="noreferrer">▣ Hóa đơn: {item.receipt.name}</a>}<div className="card-actions"><button onClick={() => openEdit(item)}>Sửa lần nhập</button><button onClick={() => setHistoryItem(item)}>Lịch sử ({item.history.length})</button></div></article>)}</div>}
    </section> : <section className="content report"><div className="report-summary"><div><span>Số dòng</span><strong>{reportRows.length}</strong></div><div><span>Giá trị theo bộ lọc</span><strong>{formatMoney(reportRows.reduce((sum, item) => sum + item.quantity * item.unitCost, 0))}</strong></div></div><label className="search"><span>⌕</span><input value={reportSearch} onChange={(event) => setReportSearch(event.target.value)} placeholder="Tìm NVL, category, thương hiệu..." /></label><div className="filters"><label>Nhà cung cấp<select value={supplierFilter} onChange={(event) => setSupplierFilter(event.target.value)}><option value="all">Tất cả</option>{suppliers.map((supplier) => <option key={supplier}>{supplier}</option>)}</select></label><label>Category<select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}><option value="all">Tất cả</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><label>Thương hiệu<select value={brandFilter} onChange={(event) => setBrandFilter(event.target.value)}><option value="all">Tất cả</option>{brands.map((brand) => <option key={brand}>{brand}</option>)}</select></label><label>Từ ngày<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>Đến ngày<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div><div className="table-wrap"><table><thead><tr><th><button onClick={() => changeSort("purchasedOn")}>Ngày{sortMarker("purchasedOn")}</button></th><th><button onClick={() => changeSort("name")}>Nguyên liệu{sortMarker("name")}</button></th><th>Category</th><th>Thương hiệu</th><th>Nhà cung cấp</th><th><button onClick={() => changeSort("quantity")}>SL tổng{sortMarker("quantity")}</button></th><th>Định lượng</th><th><button onClick={() => changeSort("unitCost")}>Đơn giá{sortMarker("unitCost")}</button></th><th><button onClick={() => changeSort("total")}>Thành tiền{sortMarker("total")}</button></th><th>HĐ</th></tr></thead><tbody>{reportRows.map((item) => <tr key={item.id}><td>{formatDate(item.purchasedOn)}</td><td><b>{item.name}</b></td><td>{item.category}</td><td>{item.brand}</td><td>{item.supplier}</td><td>{item.quantity.toLocaleString("vi-VN")} {item.unit}</td><td>{item.specification}</td><td>{formatMoney(item.unitCost)}</td><td><b>{formatMoney(item.quantity * item.unitCost)}</b></td><td>{item.receipt ? "Có" : "-"}</td></tr>)}{reportRows.length === 0 && <tr><td colSpan={10} className="no-result">Không có dữ liệu phù hợp.</td></tr>}</tbody></table></div></section>}
    {showForm && <div className="sheet-backdrop" role="presentation" onMouseDown={closeForm}><form className="sheet" onSubmit={saveIngredient} onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>{editingId ? "CẬP NHẬT LẦN NHẬP" : "NHẬP KHO"}</p><h2>{editingId ? "Sửa nguyên liệu" : "Thêm nguyên liệu"}</h2></div><button type="button" className="close" onClick={closeForm}>×</button></div><label>Tên nguyên liệu<input required autoFocus value={form.name} onChange={(event) => updateForm("name", event.target.value)} placeholder="Ví dụ: Syrup dâu" /></label><div className="form-row"><label>Category<input required list="category-options" value={form.category} onChange={(event) => updateForm("category", event.target.value)} placeholder="Ví dụ: Syrup" /><datalist id="category-options">{categories.map((category) => <option value={category} key={category} />)}</datalist></label><label>Thương hiệu<input list="brand-options" value={form.brand} onChange={(event) => updateForm("brand", event.target.value)} placeholder="Gõ để chọn hoặc thêm mới" /><datalist id="brand-options">{brands.map((brand) => <option value={brand} key={brand} />)}</datalist></label></div><div className="form-row"><label>SL tổng<input required min="0" step="0.01" inputMode="decimal" value={form.quantity} onChange={(event) => updateForm("quantity", event.target.value)} placeholder="Ví dụ: 1" /></label><label>Đơn vị<select value={form.unit} onChange={(event) => updateForm("unit", event.target.value)}><option>chai</option><option>gói</option><option>hộp</option><option>lon</option><option>túi</option><option>kg</option><option>lít</option></select></label></div><label>Định lượng mỗi đơn vị<input value={form.specification} onChange={(event) => updateForm("specification", event.target.value)} placeholder="Ví dụ: 500g syrup dâu" /></label><label>Đơn giá (VND)<input required inputMode="numeric" value={form.unitCost} onChange={(event) => updateForm("unitCost", formatPriceInput(event.target.value))} placeholder="Ví dụ: 53,000" /><small>Giá của một {form.unit}; có thể gõ theo dạng 53,000.</small></label><div className="form-row"><label>Ngày mua<input required type="date" value={form.purchasedOn} onChange={(event) => updateForm("purchasedOn", event.target.value)} /></label><label>Nhà cung cấp<input list="supplier-options" value={form.supplier} onChange={(event) => updateForm("supplier", event.target.value)} placeholder="Gõ để chọn hoặc thêm mới" /><datalist id="supplier-options">{suppliers.map((supplier) => <option value={supplier} key={supplier} />)}</datalist></label></div><label className="upload">Đính kèm hóa đơn<input type="file" accept="image/*,.pdf" onChange={attachReceipt} /><span>{receipt ? `Đã chọn: ${receipt.name}` : "Chọn ảnh hoặc PDF hóa đơn"}</span></label><button className="save-button" type="submit">{editingId ? "Lưu thay đổi" : "Lưu lần nhập kho"}</button></form></div>}
    {historyItem && <div className="sheet-backdrop" role="presentation" onMouseDown={() => setHistoryItem(undefined)}><aside className="sheet history-sheet" onMouseDown={(event) => event.stopPropagation()}><div className="sheet-handle" /><div className="sheet-title"><div><p>NHẬT KÝ THAY ĐỔI</p><h2>{historyItem.name}</h2></div><button type="button" className="close" onClick={() => setHistoryItem(undefined)}>×</button></div><div className="history-list">{historyItem.history.map((event) => <article className="history-event" key={event.id}><div><strong>{event.action === "created" ? "Tạo lần nhập" : "Đã cập nhật"}</strong><span>{formatTime(event.at)}</span></div>{event.action === "created" ? <p>Đã ghi nhận lần nhập kho đầu tiên.</p> : event.changes.map((change) => <p key={change.field}><b>{fieldLabels[change.field]}</b><del>{change.from}</del><ins>{change.to}</ins></p>)}</article>)}</div></aside></div>}
  </main>;
}

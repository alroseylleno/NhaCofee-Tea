"use client";

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";

type Receipt = { name: string; dataUrl: string };
type Ingredient = {
  id: string;
  name: string;
  unit: string;
  quantity: number;
  unitCost: number;
  purchasedOn: string;
  supplier: string;
  receipt?: Receipt;
};

const STORAGE_KEY = "nha-ops-inventory-v1";
const emptyForm = { name: "", unit: "g", quantity: "", unitCost: "", purchasedOn: new Date().toISOString().slice(0, 10), supplier: "" };

function formatMoney(value: number) {
  return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value);
}

function formatDate(date: string) {
  return new Intl.DateTimeFormat("vi-VN", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(`${date}T00:00:00`));
}

export default function Home() {
  const [items, setItems] = useState<Ingredient[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [receipt, setReceipt] = useState<Receipt | undefined>();
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) setItems(JSON.parse(stored));
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (loaded) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }, [items, loaded]);

  const filtered = useMemo(() => items.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())), [items, search]);
  const totalValue = items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0);

  function updateForm(field: keyof typeof form, value: string) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function attachReceipt(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setReceipt({ name: file.name, dataUrl: String(reader.result) });
    reader.readAsDataURL(file);
  }

  function saveIngredient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const quantity = Number(form.quantity);
    const unitCost = Number(form.unitCost);
    if (!form.name.trim() || !quantity || !unitCost) return;
    setItems((current) => [{
      id: crypto.randomUUID(), name: form.name.trim(), unit: form.unit, quantity, unitCost,
      purchasedOn: form.purchasedOn, supplier: form.supplier.trim() || "Chưa ghi nhà cung cấp", receipt,
    }, ...current]);
    setForm({ ...emptyForm, purchasedOn: new Date().toISOString().slice(0, 10) });
    setReceipt(undefined);
    setShowForm(false);
  }

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
  }

  return (
    <main>
      <section className="hero">
        <div className="eyebrow">NHA COFFEE & TEA</div>
        <div className="hero-row"><div><h1>Kho nguyên liệu</h1><p>Ghi lại từng lần nhập, không bỏ sót hóa đơn.</p></div><span className="live-dot">Đang dùng</span></div>
        <div className="metric"><span>Giá trị kho đã ghi nhận</span><strong>{formatMoney(totalValue)}</strong><small>{items.length} lần nhập hàng</small></div>
      </section>

      <section className="content">
        <div className="section-head"><div><h2>Nguyên vật liệu</h2><p>{items.length ? "Theo từng lần nhập hàng" : "Bắt đầu bằng lần nhập đầu tiên"}</p></div><button className="add-button" onClick={() => setShowForm(true)} aria-label="Thêm nguyên vật liệu">+</button></div>
        <label className="search"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Tìm nguyên liệu" /></label>

        {!loaded ? <p className="empty">Đang tải kho...</p> : filtered.length === 0 ? <div className="empty"><b>{items.length ? "Không tìm thấy nguyên liệu" : "Kho đang trống"}</b><span>{items.length ? "Thử một từ khóa khác." : "Nhấn dấu + để ghi nhận lần mua nguyên liệu đầu tiên."}</span></div> : <div className="inventory-list">
          {filtered.map((item) => <article className="inventory-card" key={item.id}>
            <div className="item-top"><div><h3>{item.name}</h3><p>{formatDate(item.purchasedOn)} · {item.supplier}</p></div><button className="delete-button" onClick={() => removeItem(item.id)}>Xóa</button></div>
            <div className="item-data"><div><span>Số lượng</span><strong>{item.quantity.toLocaleString("vi-VN")} {item.unit}</strong></div><div><span>Đơn giá</span><strong>{formatMoney(item.unitCost)}</strong></div><div><span>Thành tiền</span><strong>{formatMoney(item.quantity * item.unitCost)}</strong></div></div>
            {item.receipt && <a className="receipt" href={item.receipt.dataUrl} target="_blank" rel="noreferrer">▣ Hóa đơn: {item.receipt.name}</a>}
          </article>)}
        </div>}
      </section>

      {showForm && <div className="sheet-backdrop" role="presentation" onMouseDown={() => setShowForm(false)}><form className="sheet" onSubmit={saveIngredient} onMouseDown={(event) => event.stopPropagation()}>
        <div className="sheet-handle" /><div className="sheet-title"><div><p>NHẬP KHO</p><h2>Thêm nguyên liệu</h2></div><button type="button" className="close" onClick={() => setShowForm(false)}>×</button></div>
        <label>Tên nguyên liệu<input required autoFocus value={form.name} onChange={(event) => updateForm("name", event.target.value)} placeholder="Ví dụ: Trà lài" /></label>
        <div className="form-row"><label>Số lượng<input required min="0" step="0.01" inputMode="decimal" value={form.quantity} onChange={(event) => updateForm("quantity", event.target.value)} placeholder="0" /></label><label>Đơn vị<select value={form.unit} onChange={(event) => updateForm("unit", event.target.value)}><option>g</option><option>kg</option><option>ml</option><option>lít</option><option>chai</option><option>gói</option><option>hộp</option></select></label></div>
        <label>Đơn giá<input required min="0" inputMode="numeric" value={form.unitCost} onChange={(event) => updateForm("unitCost", event.target.value)} placeholder="Giá của một đơn vị" /></label>
        <div className="form-row"><label>Ngày mua<input required type="date" value={form.purchasedOn} onChange={(event) => updateForm("purchasedOn", event.target.value)} /></label><label>Nhà cung cấp<input value={form.supplier} onChange={(event) => updateForm("supplier", event.target.value)} placeholder="Tên nơi mua" /></label></div>
        <label className="upload">Đính kèm hóa đơn<input type="file" accept="image/*,.pdf" onChange={attachReceipt} /><span>{receipt ? `Đã chọn: ${receipt.name}` : "Chọn ảnh hoặc PDF hóa đơn"}</span></label>
        <button className="save-button" type="submit">Lưu lần nhập kho</button>
      </form></div>}
    </main>
  );
}

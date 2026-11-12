"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import shell from "./finance.module.css";
import table from "./revenue-overview.module.css";
import styles from "./pnl-statement.module.css";
import { amountText, bucketEnd, bucketKey, bucketLabel, bucketRange, dayLabel, fullDate, percentText, type Grain } from "./pnl-statement";

// Báo cáo tài chính → Tài sản (Long, 12/11/2026): the same layout as Kết quả
// kinh doanh — months (or quarters / years) across, + / − down to N1 / N2 /
// kho → nhóm → từng lô hoặc tài sản, the last row opens it. Two sections, each
// a roll-forward that adds up in every column:
//   I. Hàng tồn kho NVL: tồn đầu kỳ + nhập ± chuyển kho − xuất dùng − hao hụt
//      ± chênh lệch sổ kho = tồn cuối kỳ (tồn kho was its own tab until then);
//   II. Tài sản cố định & setup: đầu kỳ + mua mới − khấu hao = cuối kỳ;
// then Tổng tài sản cuối kỳ = I + II.
// Pure presentation: finance-module.tsx hands over every asset (nhóm Đầu tư)
// with its month-by-month depreciation from `depreciationForAsset`, and the
// kho as lots, their value per kho at each month end and what moved it.

export type AssetRecord = {
  id: string; name: string; group: string; storeId: string; cost: number; ownedOn: string;
  usefulLifeMonths?: number; note?: string;
  /// Depreciation booked in each month ("YYYY-MM" → đồng); missing = 0.
  depreciation: Record<string, number>;
};
export type AssetStore = { id: string; name: string; color: string };
/// A lot of NVL. `ownerId` is the lot whose unit a return lot holds the rest
/// of (itself otherwise): chênh lệch is added up on the owner, where it nets.
export type StockLot = { id: string; name: string; group: string; code?: string; unit?: string; quantity: number; unitCost: number; purchasedOn: string; storeName: string; ownerId: string; hint?: string };
/// What changed a lot's value in one kho on a day, signed as its effect on the
/// stock: + nhập, ± chuyển kho, − xuất dùng / hao hụt (the P&L's amounts).
export type StockMove = { date: string; kind: "purchase" | "transfer" | "issued" | "waste"; storeId: string; lotId: string; amount: number; note?: string };
/// A lot's value in one kho at the end of a month ("YYYY-MM").
export type StockBalance = { month: string; storeId: string; lotId: string; amount: number };
export type StockBook = { lots: StockLot[]; moves: StockMove[]; balances: StockBalance[] };

type StockMeasure = "s-open" | "s-purchase" | "s-transfer" | "s-issued" | "s-waste" | "s-gap" | "s-close";
type FixedMeasure = "f-open" | "f-added" | "f-dep" | "f-close" | "f-cost" | "f-acc";
type How = "first" | "sum" | "last";
const STOCK_ROWS: Array<{ key: StockMeasure; label: string; tone?: string; how: How; optional?: boolean }> = [
  { key: "s-open", label: "Tồn kho đầu kỳ", tone: "lead", how: "first" },
  { key: "s-purchase", label: "Nhập kho", how: "sum" },
  { key: "s-transfer", label: "Chuyển kho giữa các kho", how: "sum", optional: true },
  { key: "s-issued", label: "Xuất dùng (vào giá vốn)", how: "sum" },
  { key: "s-waste", label: "Hao hụt", how: "sum" },
  { key: "s-gap", label: "Chênh lệch sổ kho (xem lô)", how: "sum", optional: true },
  { key: "s-close", label: "Tồn kho cuối kỳ", tone: "subtotal", how: "last" },
];
const FIXED_ROWS: Array<{ key: FixedMeasure; label: string; tone?: string; how: How }> = [
  { key: "f-open", label: "Giá trị còn lại đầu kỳ", tone: "lead", how: "first" },
  { key: "f-added", label: "Mua mới", how: "sum" },
  { key: "f-dep", label: "Khấu hao", how: "sum" },
  { key: "f-close", label: "Giá trị còn lại cuối kỳ", tone: "subtotal", how: "last" },
  { key: "f-cost", label: "Nguyên giá cuối kỳ", tone: "note", how: "last" },
  { key: "f-acc", label: "Khấu hao lũy kế cuối kỳ", tone: "note", how: "last" },
];
const STOCK_FLOW: Partial<Record<StockMeasure, StockMove["kind"]>> = { "s-purchase": "purchase", "s-transfer": "transfer", "s-issued": "issued", "s-waste": "waste" };
/// Standard view: what each kho / outlet holds at the end of the kỳ; the
/// movements stay closed until + opens them.
const DEFAULT_OPEN = ["s-close", "f-close", "total"];

const monthOf = (date: string) => date.slice(0, 7);
const previousMonth = (month: string) => { const [year, value] = month.split("-").map(Number); return value === 1 ? `${year - 1}-12` : `${year}-${String(value - 1).padStart(2, "0")}`; };
const firstMonthOf = (key: string, grain: Grain) => grain === "year" ? `${key}-01` : grain === "quarter" ? `${key.slice(0, 4)}-${String(Number(key.slice(6)) * 3 - 2).padStart(2, "0")}` : key;
const sumOf = (values: number[]) => values.reduce((sum, item) => sum + item, 0);
const cumulativeOf = (values: number[], how: How) => how === "first" ? values[0] : how === "last" ? values[values.length - 1] : sumOf(values);
const addInto = (target: number[], values: number[]) => { values.forEach((amount, position) => { target[position] += amount; }); return target; };
const nonZero = (values: number[]) => values.some((amount) => Math.abs(amount) >= 0.5);

/// One leaf of a line: a lot in a kho, or an asset; store and group rows add them up.
type Leaf = { key: string; storeId: string; group: string; label: string; values: number[]; open: Detail };
type Detail =
  | { kind: "asset"; title: string; path: string; ids: string[] }
  | { kind: "lot"; title: string; path: string; lotId: string; storeId: string; measure: StockMeasure };
type Row = { key: string; depth: number; label: ReactNode; values: number[]; cumulative: number; percent?: number; tone?: string };

export function AssetStatement({ assets, stock, stores, firstDate, today, footer, onOpenExpense, onOpenLot }: {
  assets: AssetRecord[]; stock?: StockBook; stores: AssetStore[]; firstDate?: string; today: string; footer?: ReactNode;
  onOpenExpense?: (id: string) => void; onOpenLot?: (id: string) => void;
}) {
  const [grain, setGrain] = useState<Grain>("month");
  const [open, setOpen] = useState<Set<string>>(() => new Set(DEFAULT_OPEN));
  const [detail, setDetail] = useState<Detail>();
  const first = firstDate || [...assets.map((asset) => asset.ownedOn), ...(stock?.lots || []).map((lot) => lot.purchasedOn)].sort()[0];
  const years = useMemo(() => {
    if (!first) return [];
    const list: string[] = [];
    for (let year = Number(first.slice(0, 4)); year <= Number(today.slice(0, 4)); year += 1) list.push(String(year));
    return list;
  }, [first, today]);
  const [yearChoice, setYearChoice] = useState<string>();
  const year = yearChoice && years.includes(yearChoice) ? yearChoice : years[years.length - 1];
  const toggle = (key: string) => setOpen((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  useEffect(() => {
    if (!detail) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setDetail(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [detail]);

  const lotsById = useMemo(() => new Map((stock?.lots || []).map((lot) => [lot.id, lot])), [stock]);

  /// Every leaf of every line, per column. Store / group rows are their sums.
  const book = useMemo(() => {
    if (!year || !first || (!assets.length && !stock?.lots.length)) return undefined;
    const columns = grain === "year"
      ? bucketRange(first, today, "year")
      : bucketRange(first.slice(0, 4) === year ? first : `${year}-01-01`, today.slice(0, 4) === year ? today : `${year}-12-31`, grain);
    const width = columns.length;
    const spans = columns.map((key) => ({ startMonth: firstMonthOf(key, grain), end: bucketEnd(key, grain) }));
    const storeName = (id: string) => id === "shared" ? "Dùng chung (Toàn chuỗi)" : stores.find((store) => store.id === id)?.name || "Kho khác";
    const lines = new Map<string, Leaf[]>();

    // I. Hàng tồn kho — balances at month ends, moves inside each column.
    if (stock?.lots.length) {
      const balanceAt = new Map<string, Map<string, number>>();
      for (const entry of stock.balances) {
        const cell = balanceAt.get(entry.month) || new Map<string, number>();
        const key = `${entry.storeId}|${entry.lotId}`;
        cell.set(key, (cell.get(key) || 0) + entry.amount);
        balanceAt.set(entry.month, cell);
      }
      const series = new Map<StockMeasure, Map<string, number[]>>(STOCK_ROWS.map((row) => [row.key, new Map()]));
      const put = (measure: StockMeasure, key: string, position: number, amount: number) => {
        if (Math.abs(amount) < 0.005) return;
        const map = series.get(measure)!;
        const values = map.get(key) || Array(width).fill(0);
        values[position] += amount;
        map.set(key, values);
      };
      spans.forEach(({ startMonth, end }, position) => {
        const opening = balanceAt.get(previousMonth(startMonth)) || new Map<string, number>();
        const closing = balanceAt.get(monthOf(end)) || new Map<string, number>();
        const gap = new Map<string, number>();
        const ownerKey = (key: string) => { const [storeId, lotId] = key.split("|"); return `${storeId}|${lotsById.get(lotId)?.ownerId || lotId}`; };
        const addGap = (key: string, amount: number) => { const owner = ownerKey(key); gap.set(owner, (gap.get(owner) || 0) + amount); };
        for (const [key, amount] of opening) { put("s-open", key, position, amount); addGap(key, -amount); }
        for (const [key, amount] of closing) { put("s-close", key, position, amount); addGap(key, amount); }
        for (const move of stock.moves) {
          if (move.date < `${startMonth}-01` || move.date > end) continue;
          const key = `${move.storeId}|${move.lotId}`;
          put(move.kind === "purchase" ? "s-purchase" : move.kind === "transfer" ? "s-transfer" : move.kind === "issued" ? "s-issued" : "s-waste", key, position, move.amount);
          addGap(key, -move.amount);
        }
        for (const [key, amount] of gap) if (Math.abs(amount) >= 0.5) put("s-gap", key, position, amount);
      });
      for (const row of STOCK_ROWS) {
        lines.set(row.key, [...series.get(row.key)!].map(([key, values]) => {
          const [storeId, lotId] = key.split("|");
          const lot = lotsById.get(lotId);
          const label = `${lot?.name || "Lô"} · ${lot?.code || "không mã phiếu"}`;
          return { key, storeId, group: lot?.group || "KHÁC", label, values, open: { kind: "lot" as const, title: label, path: `${row.label} · ${storeName(storeId)} · ${lot?.group || "KHÁC"}`, lotId, storeId, measure: row.key } };
        }));
      }
    }

    // II. Tài sản cố định & setup — the asset's own depreciation schedule.
    const accumulatedThrough = (asset: AssetRecord, month: string) => Object.entries(asset.depreciation).reduce((sum, [entryMonth, amount]) => entryMonth <= month ? sum + amount : sum, 0);
    const fixedValue = (asset: AssetRecord, measure: FixedMeasure, position: number) => {
      const { startMonth, end } = spans[position];
      const endMonth = monthOf(end);
      const ownedBy = asset.ownedOn <= end;
      switch (measure) {
        case "f-open": return asset.ownedOn < `${startMonth}-01` ? asset.cost - accumulatedThrough(asset, previousMonth(startMonth)) : 0;
        case "f-added": return asset.ownedOn >= `${startMonth}-01` && ownedBy ? asset.cost : 0;
        case "f-dep": return -(accumulatedThrough(asset, endMonth) - accumulatedThrough(asset, previousMonth(startMonth)));
        case "f-close": return ownedBy ? asset.cost - accumulatedThrough(asset, endMonth) : 0;
        case "f-cost": return ownedBy ? asset.cost : 0;
        case "f-acc": return ownedBy ? -accumulatedThrough(asset, endMonth) : 0;
      }
    };
    if (assets.length) for (const row of FIXED_ROWS) {
      lines.set(row.key, assets.map((asset) => {
        const label = `${asset.name} · ${fullDate(asset.ownedOn)}`;
        return { key: asset.id, storeId: asset.storeId, group: asset.group, label, values: columns.map((_, position) => fixedValue(asset, row.key, position)), open: { kind: "asset" as const, title: label, path: `${row.label} · ${storeName(asset.storeId)} · ${asset.group}`, ids: [asset.id] } };
      }));
    }
    const lastMonth = monthOf(spans[spans.length - 1].end);
    return { columns, lines, storeName, accumulatedThrough, lastMonth, partial: columns.findIndex((key) => key === bucketKey(today, grain) && today < bucketEnd(key, grain)) };
  }, [assets, stock, stores, grain, year, first, today, lotsById]);

  const model = useMemo(() => {
    if (!book) return undefined;
    const width = book.columns.length;
    const totalOf = (leaves: Leaf[]) => leaves.reduce((sum, leaf) => addInto(sum, leaf.values), Array(width).fill(0) as number[]);
    const stockClose = book.lines.get("s-close") || [];
    const fixedClose = book.lines.get("f-close") || [];
    const totalAssets = totalOf([...stockClose, ...fixedClose]);
    const totalClosing = totalAssets[width - 1];
    const ids = [...stores.map((store) => store.id), "shared"];
    const storeOrder = (leaves: Leaf[]) => [...new Set(leaves.map((leaf) => leaf.storeId))].sort((left, right) => (ids.indexOf(left) + 1 || 99) - (ids.indexOf(right) + 1 || 99));
    const storeColor = (id: string) => stores.find((store) => store.id === id)?.color || "#8a958c";
    const share = (amount: number, measure: string) => (measure === "s-close" || measure === "f-close" || measure === "total") && totalClosing && Math.abs(amount) >= 0.5 ? amount / totalClosing * 100 : undefined;
    const isOpen = (key: string) => open.has(key);
    const label = (key: string, text: string, mode: "toggle" | "detail" | "plain", target?: Detail, color?: string) => {
      const swatch = color ? <b style={{ background: color }} /> : null;
      if (mode === "toggle") return <button type="button" className={styles.toggle} aria-expanded={isOpen(key)} onClick={() => toggle(key)}><i aria-hidden="true">{isOpen(key) ? "−" : "+"}</i>{swatch}{text}</button>;
      if (mode === "detail" && target) return <button type="button" className={styles.leafButton} title="Xem chi tiết" onClick={() => setDetail(target)}>{swatch}<span>{text}</span><em aria-hidden="true">›</em></button>;
      return <span className={styles.leaf}>{swatch}{text}</span>;
    };
    const rows: Row[] = [];
    const pushLine = (measure: string, text: string, tone: string | undefined, how: How, leaves: Leaf[]) => {
      const values = totalOf(leaves);
      const cumulative = cumulativeOf(values, how);
      rows.push({ key: measure, depth: 0, values, cumulative, percent: share(cumulative, measure), tone, label: label(measure, text, leaves.length ? "toggle" : "plain") });
      if (!isOpen(measure)) return;
      for (const storeId of storeOrder(leaves)) {
        const inStore = leaves.filter((leaf) => leaf.storeId === storeId);
        const storeValues = totalOf(inStore);
        if (!nonZero(storeValues)) continue;
        const storeKey = `${measure}|${storeId}`;
        rows.push({ key: storeKey, depth: 1, values: storeValues, cumulative: cumulativeOf(storeValues, how), percent: share(cumulativeOf(storeValues, how), measure), tone: "store", label: label(storeKey, book.storeName(storeId), "toggle", undefined, storeColor(storeId)) });
        if (!isOpen(storeKey)) continue;
        const groups = [...new Set(inStore.map((leaf) => leaf.group))]
          .map((group) => ({ group, list: inStore.filter((leaf) => leaf.group === group) }))
          .map((entry) => ({ ...entry, values: totalOf(entry.list) }))
          .filter((entry) => nonZero(entry.values))
          .sort((left, right) => Math.abs(cumulativeOf(right.values, how)) - Math.abs(cumulativeOf(left.values, how)));
        for (const { group, list, values: groupValues } of groups) {
          const groupKey = `${storeKey}|${group}`;
          rows.push({ key: groupKey, depth: 2, values: groupValues, cumulative: cumulativeOf(groupValues, how), percent: share(cumulativeOf(groupValues, how), measure), tone: "group", label: label(groupKey, group, "toggle") });
          if (!isOpen(groupKey)) continue;
          const items = list.filter((leaf) => nonZero(leaf.values)).sort((left, right) => Math.abs(cumulativeOf(right.values, how)) - Math.abs(cumulativeOf(left.values, how)));
          for (const leaf of items) rows.push({ key: `${groupKey}|${leaf.key}`, depth: 3, values: leaf.values, cumulative: cumulativeOf(leaf.values, how), tone: "item", label: label(`${groupKey}|${leaf.key}`, leaf.label, "detail", leaf.open) });
        }
      }
    };
    const blank = Array(width).fill(undefined) as Array<number | undefined>;
    if (book.lines.has("s-close")) {
      rows.push({ key: "section-stock", depth: 0, values: blank as number[], cumulative: NaN, tone: "section", label: "I. Hàng tồn kho NVL" });
      for (const def of STOCK_ROWS) {
        const leaves = book.lines.get(def.key) || [];
        if (def.optional && !leaves.some((leaf) => nonZero(leaf.values))) continue;
        pushLine(def.key, def.label, def.tone, def.how, leaves);
      }
    }
    if (book.lines.has("f-close")) {
      rows.push({ key: "section-fixed", depth: 0, values: blank as number[], cumulative: NaN, tone: "section", label: "II. Tài sản cố định & setup" });
      for (const def of FIXED_ROWS) pushLine(def.key, def.label, def.tone, def.how, book.lines.get(def.key) || []);
      const cost = totalOf(book.lines.get("f-cost") || []);
      const close = totalOf(fixedClose);
      const depreciated = close.map((amount, position) => cost[position] ? (cost[position] - amount) / cost[position] * 100 : undefined);
      rows.push({ key: "f-share", depth: 0, values: depreciated as number[], cumulative: depreciated[width - 1] ?? NaN, tone: "note", label: "% nguyên giá đã khấu hao" });
    }
    // Tổng tài sản → each kho / outlet → its tồn kho and its tài sản cố định.
    rows.push({ key: "total", depth: 0, values: totalAssets, cumulative: totalClosing, percent: share(totalClosing, "total"), tone: "grand", label: label("total", "TỔNG TÀI SẢN CUỐI KỲ (I + II)", "toggle") });
    if (isOpen("total")) for (const storeId of storeOrder([...stockClose, ...fixedClose])) {
      const parts = [
        { name: "Hàng tồn kho NVL", values: totalOf(stockClose.filter((leaf) => leaf.storeId === storeId)) },
        { name: "Tài sản cố định & setup", values: totalOf(fixedClose.filter((leaf) => leaf.storeId === storeId)) },
      ].filter((part) => nonZero(part.values));
      if (!parts.length) continue;
      const storeKey = `total|${storeId}`;
      const storeValues = parts.reduce((sum, part) => addInto(sum, part.values), Array(width).fill(0) as number[]);
      rows.push({ key: storeKey, depth: 1, values: storeValues, cumulative: storeValues[width - 1], percent: share(storeValues[width - 1], "total"), tone: "store", label: label(storeKey, book.storeName(storeId), "toggle", undefined, storeColor(storeId)) });
      if (isOpen(storeKey)) for (const part of parts) rows.push({ key: `${storeKey}|${part.name}`, depth: 2, values: part.values, cumulative: part.values[width - 1], percent: share(part.values[width - 1], "total"), tone: "group", label: label(`${storeKey}|${part.name}`, part.name, "plain") });
    }
    return { rows, totalClosing, stockClosing: totalOf(stockClose)[width - 1], fixedClosing: totalOf(fixedClose)[width - 1] };
  }, [book, stores, open]);

  const detailAssets = detail?.kind === "asset" ? assets.filter((asset) => detail.ids.includes(asset.id)) : [];
  /// A lot's popup: the lot, then what this row holds of it — each move inside
  /// the columns on screen, or the value per column for tồn / chênh lệch.
  const lotDetail = useMemo(() => {
    if (detail?.kind !== "lot" || !book || !stock) return undefined;
    const lot = lotsById.get(detail.lotId);
    const kind = STOCK_FLOW[detail.measure];
    const from = `${firstMonthOf(book.columns[0], grain)}-01`;
    const to = bucketEnd(book.columns[book.columns.length - 1], grain);
    if (kind) {
      const list = stock.moves.filter((move) => move.kind === kind && move.lotId === detail.lotId && move.storeId === detail.storeId && move.date >= from && move.date <= to).sort((left, right) => right.date.localeCompare(left.date));
      const rows = list.map((move) => ({ when: fullDate(move.date), note: move.note || "", amount: move.amount }));
      return { lot, rows, total: sumOf(rows.map((row) => row.amount)), totalNote: "" };
    }
    const leaf = book.lines.get(detail.measure)?.find((entry) => entry.key === `${detail.storeId}|${detail.lotId}`);
    const prefix = detail.measure === "s-open" ? "Đầu" : detail.measure === "s-close" ? "Cuối" : "Chênh lệch";
    const remaining = (amount: number) => lot?.unitCost ? `còn ${(Math.round(amount / lot.unitCost * 100) / 100).toLocaleString("vi-VN")} ${lot.unit || ""} × ${amountText(lot.unitCost)}` : "";
    const rows = book.columns.map((key, position) => ({ when: `${prefix} ${bucketLabel(key, grain)}`, note: detail.measure === "s-gap" ? "" : remaining(leaf?.values[position] || 0), amount: leaf?.values[position] || 0 })).filter((row) => Math.abs(row.amount) >= 0.5).reverse();
    // Tồn: the newest column on screen; chênh lệch: added up over the columns.
    return { lot, rows, total: detail.measure === "s-gap" ? sumOf(rows.map((row) => row.amount)) : rows[0]?.amount || 0, totalNote: detail.measure === "s-gap" ? "" : rows[0]?.when || "" };
  }, [detail, book, stock, lotsById, grain]);

  return <article className={`${shell.revenuePanel} ${table.statementPanel}`}>
    <div className={table.trendHead}>
      <div className={shell.revenuePanelTitle}><div><span>TÀI SẢN THEO {grain === "month" ? "THÁNG" : grain === "quarter" ? "QUÝ" : "NĂM"} · TOÀN CHUỖI{grain !== "year" && year ? ` · ${year}` : ""}</span>{model && <strong>Tổng tài sản {amountText(model.totalClosing)} ₫ · tồn kho {amountText(model.stockClosing)} ₫ · tài sản cố định {amountText(model.fixedClosing)} ₫</strong>}</div></div>
      <div className={table.statementControls}>
        {grain !== "year" && years.length > 1 && <select aria-label="Năm" value={year} onChange={(event) => setYearChoice(event.target.value)}>{years.map((option) => <option key={option}>{option}</option>)}</select>}
        <div className={table.grain} role="group" aria-label="Cột theo">
          {([["month", "Tháng"], ["quarter", "Quý"], ["year", "Năm"]] as const).map(([value, text]) => <button type="button" key={value} aria-pressed={grain === value} className={grain === value ? table.grainOn : undefined} onClick={() => setGrain(value)}>{text}</button>)}
        </div>
      </div>
    </div>
    <p className={styles.legend}>Mỗi phần cộng dồn trong từng cột: đầu kỳ + tăng − giảm = cuối kỳ. Số âm trong ngoặc. Bấm <b>+</b> để mở ra Nhà 1, Nhà 2, kho, nhóm và từng lô / tài sản; bấm dòng cuối (có dấu <b>›</b>) để xem chi tiết.</p>
    {!book || !model ? <div className={shell.chartEmpty}>Chưa có tài sản hay tồn kho nào.</div> : <div className={table.statementWrap}><table className={`${table.statement} ${styles.pnl}`}>
      <thead><tr><th>VND</th>{book.columns.map((key, position) => <th key={key} className={position === book.partial ? table.running : undefined}>{bucketLabel(key, grain)}{position === book.partial ? "*" : ""}{position === book.partial ? <small>tới {dayLabel(today)}</small> : null}</th>)}<th>Cả kỳ</th><th>% tổng TS</th></tr></thead>
      <tbody>
        {model.rows.map((row) => <tr key={row.key} className={`${styles[`depth${row.depth}`] || ""} ${row.tone ? styles[row.tone] || "" : ""}`}>
          <td>{row.label}</td>
          {row.values.map((amount, position) => <td key={book.columns[position]}>{row.tone === "section" ? "" : row.key === "f-share" ? amount === undefined ? "–" : percentText(amount) : amountText(amount)}</td>)}
          <td className={table.cumulative}>{row.tone === "section" ? "" : row.key === "f-share" ? percentText(row.cumulative) : amountText(row.cumulative)}</td>
          <td className={styles.percent}>{percentText(row.percent)}</td>
        </tr>)}
      </tbody>
    </table></div>}
    {footer}
    {detail && book && <div className={shell.backdrop} role="presentation" onMouseDown={() => setDetail(undefined)}>
      <div className={`${shell.sheet} ${styles.detailSheet}`} role="dialog" aria-label={`Chi tiết ${detail.title}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className={shell.sheetTitle}><div><span>{detail.path}</span><h2>{detail.title}</h2></div><button type="button" onClick={() => setDetail(undefined)} aria-label="Đóng">×</button></div>
        {detail.kind === "asset" && <div className={styles.detailList}>
          {detailAssets.map((asset) => {
            const accumulated = book.accumulatedThrough(asset, book.lastMonth);
            const monthly = asset.usefulLifeMonths ? Object.values(asset.depreciation).find((amount) => amount > 0) || 0 : 0;
            return <div className={styles.assetCard} key={asset.id}>
              <div><span>Nguyên giá</span><b>{amountText(asset.cost)}</b></div>
              <div><span>Bắt đầu dùng</span><b>{fullDate(asset.ownedOn)}</b></div>
              <div><span>Khấu hao</span><b>{asset.usefulLifeMonths ? `${asset.usefulLifeMonths} tháng · ${amountText(monthly)}/tháng` : "Không khấu hao"}</b></div>
              <div><span>Đã khấu hao tới cuối kỳ đang xem</span><b>{amountText(accumulated)}</b></div>
              <div><span>Giá trị còn lại</span><b>{amountText(asset.cost - accumulated)}</b></div>
              {asset.note && <p>{asset.note}</p>}
              {onOpenExpense && <button type="button" onClick={() => onOpenExpense(asset.id)}>Mở phiếu</button>}
            </div>;
          })}
        </div>}
        {detail.kind === "lot" && lotDetail && <>
          {lotDetail.lot && <div className={`${styles.detailList} ${styles.lotCard}`}><div className={styles.assetCard}>
            <div><span>Mã phiếu</span><b>{lotDetail.lot.code || "không mã phiếu"}</b></div>
            <div><span>Nhóm</span><b>{lotDetail.lot.group}</b></div>
            <div><span>Ngày nhập</span><b>{fullDate(lotDetail.lot.purchasedOn)}</b></div>
            <div><span>Lô ghi</span><b>{amountText(lotDetail.lot.quantity)} {lotDetail.lot.unit} × {amountText(lotDetail.lot.unitCost)}</b></div>
            <div><span>Đang ở</span><b>{lotDetail.lot.storeName}</b></div>
            {detail.measure === "s-gap" && lotDetail.lot.hint && <p>{lotDetail.lot.hint}</p>}
            {onOpenLot && <button type="button" onClick={() => onOpenLot(lotDetail.lot!.id)}>Mở lô</button>}
          </div></div>}
          <p className={styles.detailTotal}><b>{amountText(lotDetail.total)} ₫</b><small>{[lotDetail.totalNote, `${lotDetail.rows.length.toLocaleString("vi-VN")} dòng · theo các cột đang xem (${bucketLabel(book.columns[0], grain)} → ${bucketLabel(book.columns[book.columns.length - 1], grain)})`].filter(Boolean).join(" · ")}</small></p>
          <div className={styles.detailList}>
            {lotDetail.rows.map((row, position) => <div className={styles.detailRow} key={`${row.when}-${position}`}>
              <span>{row.when}</span>
              <span>{row.note}</span>
              <b>{amountText(row.amount)}</b>
              <i />
            </div>)}
          </div>
        </>}
      </div>
    </div>}
  </article>;
}

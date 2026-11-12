"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import shell from "./finance.module.css";
import table from "./revenue-overview.module.css";
import styles from "./pnl-statement.module.css";

// Báo cáo tài chính → Kết quả kinh doanh theo tháng (Long, 12/11/2026): the P&L
// as Long keeps it — months (or quarters / years) across, Lũy kế and % doanh
// thu at the end, negatives in brackets. Doanh thu, 2. Giá vốn, Lợi nhuận gộp,
// 3. Chi phí hoạt động, EBITDA, Khấu hao and Lãi (lỗ) are the visible rows; the
// lines that make up 2 and 3 sit INSIDE them (+ / −), each line opens to the
// outlets (N1, N2, Dùng chung), then its groups and items. The last row of a
// branch opens a popup with every entry behind it (the lot, the expense…).
// Pure presentation: finance-module.tsx turns every đồng into a dated entry on
// one line, one outlet and one group (`pnlLedger`); this file only adds up.

export type PnlLineKey = "revenue" | "cogsIssued" | "cogsWaste" | "cogsRetail" | "rent" | "operating" | "platform" | "ads" | "salesOther" | "tax" | "fixedOther" | "depreciation";
/// What a popup row can open: an expense in Ghi nhận chi phí, or a lot in Kho NVL.
export type PnlRef = { kind: "expense" | "lot"; id: string };
/// `amount` is positive for revenue and for a cost alike; the line gives the sign.
/// `storeId` is an outlet id or "shared" (Toàn chuỗi costs, kho that does not sell).
/// `note` and `ref` only feed the detail popup.
export type PnlEntry = { date: string; line: PnlLineKey; storeId: string; group: string; item?: string; amount: number; note?: string; ref?: PnlRef };
export type PnlStore = { id: string; name: string; color: string };
/// One invoice whose items all have a recipe: its revenue and its recipe cost
/// (Product Master). Used only as the WEIGHT that splits an outlet's real cost
/// of goods between Online and Offline; the real cost still comes from the kho.
export type PnlChannelCost = { date: string; storeId: string; channel: "online" | "offline"; revenue: number; cost: number };
export type Grain = "month" | "quarter" | "year";
type Totals = Record<PnlLineKey, number>;

const COST_LINES: PnlLineKey[] = ["cogsIssued", "cogsWaste", "cogsRetail", "rent", "operating", "platform", "ads", "salesOther", "tax", "fixedOther", "depreciation"];
const LINES: PnlLineKey[] = ["revenue", ...COST_LINES];
const zero = (): Totals => Object.fromEntries(LINES.map((line) => [line, 0])) as Totals;
const cogsOf = (t: Totals) => t.cogsIssued + t.cogsWaste + t.cogsRetail;
const opexOf = (t: Totals) => t.rent + t.operating + t.platform + t.ads + t.salesOther + t.tax + t.fixedOther;
const grossOf = (t: Totals) => t.revenue - cogsOf(t);
const ebitdaOf = (t: Totals) => grossOf(t) - opexOf(t);
const profitOf = (t: Totals) => ebitdaOf(t) - t.depreciation;

const LINE_LABELS: Record<PnlLineKey, string> = {
  revenue: "1. Doanh thu bán hàng thuần",
  cogsIssued: "NVL xuất dùng (kho)",
  cogsWaste: "Hao hụt NVL",
  cogsRetail: "NVL mua lẻ ngoài kho",
  rent: "Thuê mặt bằng",
  operating: "Nhân sự & vận hành (lương, điện, nước…)",
  platform: "Phí & quảng cáo sàn giao hàng",
  ads: "Quảng cáo Facebook",
  salesOther: "Chi phí bán hàng khác",
  tax: "Thuế & lệ phí",
  fixedOther: "Chi phí cố định khác",
  depreciation: "Khấu hao tài sản & setup",
};
type RowDef =
  | { kind: "line"; line: PnlLineKey }
  | { kind: "total"; key: string; label: string; value: (t: Totals) => number; tone: "subtotal" | "band" | "grand"; lines?: PnlLineKey[]; byChannel?: boolean };
/// The visible skeleton. A total with `lines` opens to those lines; any other
/// total opens to the outlets (Lợi nhuận gộp further to Online / Offline).
const ROWS: RowDef[] = [
  { kind: "line", line: "revenue" },
  { kind: "total", key: "cogs", label: "2. Giá vốn hàng bán", value: (t) => -cogsOf(t), tone: "subtotal", lines: ["cogsIssued", "cogsWaste", "cogsRetail"] },
  { kind: "total", key: "gross", label: "Lợi nhuận gộp", value: grossOf, tone: "band", byChannel: true },
  { kind: "total", key: "opex", label: "3. Chi phí hoạt động", value: (t) => -opexOf(t), tone: "subtotal", lines: ["rent", "operating", "platform", "ads", "salesOther", "tax", "fixedOther"] },
  { kind: "total", key: "ebitda", label: "EBITDA (trước khấu hao)", value: ebitdaOf, tone: "band" },
  { kind: "line", line: "depreciation" },
  { kind: "total", key: "profit", label: "LÃI (LỖ) HOẠT ĐỘNG", value: profitOf, tone: "grand" },
];

const DEFAULT_OPEN = ["revenue", "cogs", "gross", "opex", "ebitda", "depreciation"];

export function bucketKey(date: string, grain: Grain) {
  const year = date.slice(0, 4);
  if (grain === "year") return year;
  return grain === "quarter" ? `${year}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}` : date.slice(0, 7);
}
export function bucketLabel(key: string, grain: Grain) {
  if (grain === "year") return key;
  return grain === "quarter" ? key.slice(5) : `T${Number(key.slice(5, 7))}`;
}
export function bucketEnd(key: string, grain: Grain) {
  const year = Number(key.slice(0, 4));
  const lastMonth = grain === "year" ? 12 : grain === "quarter" ? Number(key.slice(6)) * 3 : Number(key.slice(5, 7));
  return `${year}-${String(lastMonth).padStart(2, "0")}-${String(new Date(Date.UTC(year, lastMonth, 0)).getUTCDate()).padStart(2, "0")}`;
}
export function bucketRange(first: string, last: string, grain: Grain) {
  const keys: string[] = [];
  let year = Number(first.slice(0, 4));
  let month = grain === "year" ? 1 : Number(first.slice(5, 7));
  if (grain === "quarter") month = (Math.ceil(month / 3) - 1) * 3 + 1;
  const step = grain === "month" ? 1 : grain === "quarter" ? 3 : 12;
  const end = bucketKey(last, grain);
  for (let guard = 0; guard < 600; guard += 1) {
    const key = bucketKey(`${year}-${String(month).padStart(2, "0")}-01`, grain);
    keys.push(key);
    if (key >= end) break;
    month += step;
    while (month > 12) { month -= 12; year += 1; }
  }
  return keys;
}
export const amountText = (value: number | undefined) => value === undefined ? "–" : Math.abs(value) < 0.5 ? "–" : value < 0 ? `(${Math.round(-value).toLocaleString("vi-VN")})` : Math.round(value).toLocaleString("vi-VN");
export const percentText = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? "" : `${value < 0 ? "(" : ""}${Math.abs(value).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%${value < 0 ? ")" : ""}`;
export const dayLabel = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
export const fullDate = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

type Row = { key: string; depth: number; label: ReactNode; values: number[]; cumulative: number; percent?: number; tone?: string };
type Detail = { key: string; title: string; path: string; sign: 1 | -1 };

export function PnlStatement({ entries, stores, channelCost = [], firstDate, latestDate, today, footer, onOpenExpense, onOpenLot }: {
  entries: PnlEntry[]; stores: PnlStore[]; channelCost?: PnlChannelCost[]; firstDate?: string; latestDate?: string; today: string; footer?: ReactNode;
  onOpenExpense?: (id: string, date: string) => void; onOpenLot?: (id: string) => void;
}) {
  const [grain, setGrain] = useState<Grain>("month");
  // The standard view Long set (12/11/2026): every section open one level —
  // Doanh thu / LN gộp / EBITDA / Khấu hao by outlet, Giá vốn and Chi phí hoạt
  // động by line — and LÃI (LỖ) closed. Deeper levels stay closed.
  const [open, setOpen] = useState<Set<string>>(() => new Set(DEFAULT_OPEN));
  const [detail, setDetail] = useState<Detail>();
  const years = useMemo(() => {
    const first = firstDate || entries.map((entry) => entry.date).sort()[0];
    if (!first) return [];
    const list: string[] = [];
    for (let year = Number(first.slice(0, 4)); year <= Number((latestDate && latestDate > today ? latestDate : today).slice(0, 4)); year += 1) list.push(String(year));
    return list;
  }, [entries, firstDate, latestDate, today]);
  const [yearChoice, setYearChoice] = useState<string>();
  const year = yearChoice && years.includes(yearChoice) ? yearChoice : years[years.length - 1];
  const toggle = (key: string) => setOpen((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  useEffect(() => {
    if (!detail) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setDetail(undefined); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [detail]);

  const model = useMemo(() => {
    if (!year) return undefined;
    const first = firstDate || entries.map((entry) => entry.date).sort()[0];
    const last = latestDate && latestDate > today ? latestDate : today;
    const columns = grain === "year"
      ? bucketRange(first, last, "year")
      : bucketRange(first.slice(0, 4) === year ? first : `${year}-01-01`, last.slice(0, 4) === year ? last : `${year}-12-31`, grain);
    const index = new Map(columns.map((key, position) => [key, position]));
    const width = columns.length;
    const startOfFirst = grain === "year" ? `${columns[0]}-01-01` : grain === "quarter" ? `${columns[0].slice(0, 4)}-${String(Number(columns[0].slice(6)) * 3 - 2).padStart(2, "0")}-01` : `${columns[0]}-01`;
    // Totals per outlet per column, plus group and item sums per line, plus the
    // entries behind every row for the detail popup.
    const byStore = new Map<string, Totals[]>();
    const groups = new Map<string, number[]>();
    const items = new Map<string, number[]>();
    const groupKeys = new Map<string, Set<string>>();
    const itemKeys = new Map<string, Set<string>>();
    const behind = new Map<string, PnlEntry[]>();
    let before = zero();
    const cell = (bag: Map<string, number[]>, key: string) => { let row = bag.get(key); if (!row) { row = new Array(width).fill(0); bag.set(key, row); } return row; };
    const keep = (key: string, entry: PnlEntry) => { const list = behind.get(key); if (list) list.push(entry); else behind.set(key, [entry]); };
    for (const entry of entries) {
      const position = index.get(bucketKey(entry.date, grain));
      if (position === undefined) {
        if (entry.date < startOfFirst) before = { ...before, [entry.line]: before[entry.line] + entry.amount };
        continue;
      }
      let totals = byStore.get(entry.storeId);
      if (!totals) { totals = Array.from({ length: width }, zero); byStore.set(entry.storeId, totals); }
      totals[position][entry.line] += entry.amount;
      const storeKey = `${entry.line}|${entry.storeId}`;
      const groupKey = `${storeKey}|${entry.group}`;
      cell(groups, groupKey)[position] += entry.amount;
      const known = groupKeys.get(storeKey) || new Set<string>();
      known.add(entry.group); groupKeys.set(storeKey, known);
      keep(storeKey, entry);
      keep(groupKey, entry);
      if (entry.item && entry.item !== entry.group) {
        cell(items, `${groupKey}|${entry.item}`)[position] += entry.amount;
        const names = itemKeys.get(groupKey) || new Set<string>();
        names.add(entry.item); itemKeys.set(groupKey, names);
        keep(`${groupKey}|${entry.item}`, entry);
      }
    }
    const storeOrder = [...stores.map((store) => store.id), "shared"].filter((id) => byStore.has(id));
    const chain = Array.from({ length: width }, (_, position) => {
      const sum = zero();
      for (const totals of byStore.values()) for (const line of LINES) sum[line] += totals[position][line];
      return sum;
    });
    const sumRow = (values: number[]) => values.reduce((acc, value) => acc + value, 0);
    const blank = () => new Array(width).fill(0);
    const revenueTotal = sumRow(chain.map((t) => t.revenue));
    const percentOf = (cumulative: number, cost: boolean) => revenueTotal ? (cost ? Math.abs(cumulative) : cumulative) / revenueTotal * 100 : undefined;
    const storeName = (id: string, line?: PnlLineKey) => id === "shared" ? (line === "revenue" ? "Chưa tách theo nhà" : "Dùng chung (Toàn chuỗi)") : stores.find((store) => store.id === id)?.name || id;
    const storeColor = (id: string) => stores.find((store) => store.id === id)?.color || "#8a958c";
    /// A row that opens (+ / −), a leaf that opens the popup, or plain text.
    const label = (key: string, text: string, mode: "toggle" | "detail" | "plain", color?: string, path = text, sign: 1 | -1 = -1) => {
      const swatch = color ? <b style={{ background: color }} /> : null;
      if (mode === "toggle") return <button type="button" className={styles.toggle} aria-expanded={open.has(key)} onClick={() => toggle(key)}><i aria-hidden="true">{open.has(key) ? "−" : "+"}</i>{swatch}{text}</button>;
      if (mode === "detail") return <button type="button" className={styles.leafButton} title="Xem chi tiết" onClick={() => setDetail({ key, title: text, path, sign })}>{swatch}<span>{text}</span><em aria-hidden="true">›</em></button>;
      return <span className={styles.leaf}>{swatch}{text}</span>;
    };

    // Lợi nhuận gộp by channel: channel revenue minus the outlet's REAL cost of
    // goods split in proportion to what each channel's sales cost by recipe. A
    // channel without priced invoices borrows the outlet's overall recipe rate;
    // with no recipe at all the split follows revenue. Cost in a column with no
    // revenue stays unassigned.
    const weights = new Map<string, { revenue: number[]; cost: number[] }>();
    for (const entry of channelCost) {
      const position = index.get(bucketKey(entry.date, grain));
      if (position === undefined) continue;
      const key = `${entry.storeId}|${entry.channel}`;
      const bag = weights.get(key) || { revenue: blank(), cost: blank() };
      bag.revenue[position] += entry.revenue;
      bag.cost[position] += entry.cost;
      weights.set(key, bag);
    }
    const grossByChannel = (storeId: string) => {
      const totals = byStore.get(storeId)!;
      const online = groups.get(`revenue|${storeId}|Online`) || blank();
      const offline = groups.get(`revenue|${storeId}|Offline · tại quầy`) || blank();
      const on = weights.get(`${storeId}|online`), off = weights.get(`${storeId}|offline`);
      const result = { online: blank(), offline: blank(), unassigned: blank() };
      for (let position = 0; position < width; position += 1) {
        const cogs = cogsOf(totals[position]);
        const rate = (bag?: { revenue: number[]; cost: number[] }) => bag && bag.revenue[position] > 0 ? bag.cost[position] / bag.revenue[position] : undefined;
        const coveredRevenue = (on?.revenue[position] || 0) + (off?.revenue[position] || 0);
        const overall = coveredRevenue > 0 ? ((on?.cost[position] || 0) + (off?.cost[position] || 0)) / coveredRevenue : 1;
        const estimateOnline = online[position] * (rate(on) ?? overall);
        const estimateOffline = offline[position] * (rate(off) ?? overall);
        const estimate = estimateOnline + estimateOffline;
        if (estimate <= 0) { result.unassigned[position] = -cogs; result.online[position] = online[position]; result.offline[position] = offline[position]; continue; }
        result.online[position] = online[position] - cogs * estimateOnline / estimate;
        result.offline[position] = offline[position] - cogs * estimateOffline / estimate;
      }
      return result;
    };

    const rows: Row[] = [];
    /// One P&L line and, when open, its outlets → groups → items. The last
    /// level of every branch opens the popup.
    const pushLine = (line: PnlLineKey, depth: number) => {
      const sign = line === "revenue" ? 1 : -1;
      const values = chain.map((t) => sign * t[line]);
      if (line === "fixedOther" && values.every((value) => Math.abs(value) < 0.5)) return;
      const cumulative = sumRow(values);
      const stake = storeOrder.filter((id) => byStore.get(id)!.some((t) => Math.abs(t[line]) >= 0.5));
      rows.push({ key: line, depth, values, cumulative, percent: line === "revenue" ? undefined : percentOf(cumulative, true), tone: depth === 0 ? "lead" : undefined, label: label(line, LINE_LABELS[line], stake.length ? "toggle" : "plain") });
      if (!open.has(line)) return;
      for (const storeId of stake) {
        const storeKey = `${line}|${storeId}`;
        const storeValues = byStore.get(storeId)!.map((t) => sign * t[line]);
        const groupList = [...(groupKeys.get(storeKey) || [])].map((group) => ({ group, values: (groups.get(`${storeKey}|${group}`) || blank()).map((value) => sign * value) }))
          .filter((entry) => entry.values.some((value) => Math.abs(value) >= 0.5))
          .sort((left, right) => Math.abs(sumRow(right.values)) - Math.abs(sumRow(left.values)));
        const storePath = `${LINE_LABELS[line]} · ${storeName(storeId, line)}`;
        rows.push({ key: storeKey, depth: depth + 1, values: storeValues, cumulative: sumRow(storeValues), percent: line === "revenue" ? percentOf(sumRow(storeValues), false) : percentOf(sumRow(storeValues), true), tone: "store", label: label(storeKey, storeName(storeId, line), groupList.length ? "toggle" : "detail", storeColor(storeId), storePath, sign) });
        if (!open.has(storeKey)) continue;
        for (const { group, values: groupValues } of groupList) {
          const groupKey = `${storeKey}|${group}`;
          const itemList = [...(itemKeys.get(groupKey) || [])].map((item) => ({ item, values: (items.get(`${groupKey}|${item}`) || blank()).map((value) => sign * value) }))
            .filter((entry) => entry.values.some((value) => Math.abs(value) >= 0.5))
            .sort((left, right) => Math.abs(sumRow(right.values)) - Math.abs(sumRow(left.values)));
          const groupPath = `${storePath} · ${group}`;
          rows.push({ key: groupKey, depth: depth + 2, values: groupValues, cumulative: sumRow(groupValues), tone: "group", label: label(groupKey, group, itemList.length ? "toggle" : "detail", undefined, groupPath, sign) });
          if (!open.has(groupKey)) continue;
          for (const { item, values: itemValues } of itemList) rows.push({ key: `${groupKey}|${item}`, depth: depth + 3, values: itemValues, cumulative: sumRow(itemValues), tone: "item", label: label(`${groupKey}|${item}`, item, "detail", undefined, `${groupPath} · ${item}`, sign) });
        }
      }
    };
    for (const def of ROWS) {
      if (def.kind === "line") { pushLine(def.line, 0); continue; }
      const values = chain.map(def.value);
      const cumulative = sumRow(values);
      const canOpen = def.lines ? true : storeOrder.length > 0;
      rows.push({ key: def.key, depth: 0, values, cumulative, percent: percentOf(cumulative, def.tone === "subtotal"), tone: def.tone, label: label(def.key, def.label, canOpen ? "toggle" : "plain") });
      if (!open.has(def.key)) continue;
      if (def.lines) { for (const line of def.lines) pushLine(line, 1); continue; }
      for (const storeId of storeOrder) {
        const storeKey = `${def.key}|${storeId}`;
        const storeValues = byStore.get(storeId)!.map(def.value);
        if (storeValues.every((value) => Math.abs(value) < 0.5)) continue;
        const children: Array<{ label: string; values: number[] }> = [];
        if (def.byChannel && storeId !== "shared") {
          const split = grossByChannel(storeId);
          // The % DT column says what share of revenue each channel's gross profit is.
          children.push({ label: "Online", values: split.online });
          children.push({ label: "Offline · tại quầy", values: split.offline });
          children.push({ label: "Giá vốn chưa có doanh thu đi kèm", values: split.unassigned });
        }
        const shown = children.filter((child) => child.values.some((value) => Math.abs(value) >= 0.5));
        rows.push({ key: storeKey, depth: 1, values: storeValues, cumulative: sumRow(storeValues), percent: percentOf(sumRow(storeValues), def.tone === "subtotal"), tone: "store", label: label(storeKey, storeName(storeId), shown.length ? "toggle" : "plain", storeColor(storeId)) });
        if (!open.has(storeKey)) continue;
        for (const child of shown) rows.push({ key: `${storeKey}|${child.label}`, depth: 2, values: child.values, cumulative: sumRow(child.values), percent: percentOf(sumRow(child.values), false), tone: "group", label: label(`${storeKey}|${child.label}`, child.label, "plain") });
      }
    }
    // Lãi (lỗ) lũy kế runs from the first day of the shop, not from the first column.
    let running = profitOf(before);
    const cumulativeProfit = chain.map((t) => (running += profitOf(t)));
    const gross = chain.map(grossOf);
    const partial = latestDate ? columns.findIndex((key) => key === bucketKey(latestDate, grain) && latestDate < bucketEnd(key, grain)) : -1;
    return { columns, rows, behind, cumulativeProfit, grossMargin: chain.map((t, position) => t.revenue ? gross[position] / t.revenue * 100 : undefined), totalMargin: revenueTotal ? sumRow(gross) / revenueTotal * 100 : undefined, partial, totalProfit: sumRow(chain.map(profitOf)), revenueTotal };
  }, [entries, stores, channelCost, grain, year, firstDate, latestDate, today, open]);

  /// The popup: every entry behind a leaf, newest first. Entries that point at
  /// an expense or a lot are listed one by one with a button that opens it;
  /// the rest (invoices, sàn days) are added up per day.
  const detailRows = useMemo(() => {
    if (!detail || !model) return undefined;
    const list = model.behind.get(detail.key) || [];
    const rows = new Map<string, { date: string; note: string; amount: number; count: number; ref?: PnlRef }>();
    for (const entry of list) {
      const key = entry.ref ? `${entry.ref.kind}|${entry.ref.id}|${entry.date}|${entry.note || ""}` : `${entry.date}|${entry.note || ""}`;
      const row = rows.get(key) || { date: entry.date, note: entry.note || "", amount: 0, count: 0, ref: entry.ref };
      row.amount += entry.amount;
      row.count += 1;
      rows.set(key, row);
    }
    const sorted = [...rows.values()].sort((left, right) => right.date.localeCompare(left.date) || Math.abs(right.amount) - Math.abs(left.amount));
    return { rows: sorted, total: sorted.reduce((sum, row) => sum + row.amount, 0) };
  }, [detail, model]);

  return <article className={`${shell.revenuePanel} ${table.statementPanel}`}>
    <div className={table.trendHead}>
      <div className={shell.revenuePanelTitle}><div><span>KẾT QUẢ KINH DOANH THEO {grain === "month" ? "THÁNG" : grain === "quarter" ? "QUÝ" : "NĂM"} · TOÀN CHUỖI{grain !== "year" && year ? ` · ${year}` : ""}</span>{model && <strong>Doanh thu {amountText(model.revenueTotal)} ₫ · lãi (lỗ) hoạt động {amountText(model.totalProfit)} ₫</strong>}</div></div>
      <div className={table.statementControls}>
        {grain !== "year" && years.length > 1 && <select aria-label="Năm" value={year} onChange={(event) => setYearChoice(event.target.value)}>{years.map((option) => <option key={option}>{option}</option>)}</select>}
        <div className={table.grain} role="group" aria-label="Cột theo">
          {([["month", "Tháng"], ["quarter", "Quý"], ["year", "Năm"]] as const).map(([value, text]) => <button type="button" key={value} aria-pressed={grain === value} className={grain === value ? table.grainOn : undefined} onClick={() => setGrain(value)}>{text}</button>)}
        </div>
      </div>
    </div>
    <p className={styles.legend}>Doanh thu → giá vốn → chi phí hoạt động → lãi lỗ. Số âm trong ngoặc. Bấm <b>+</b> để mở một dòng ra Nhà 1, Nhà 2, Dùng chung và từng khoản; bấm vào dòng cuối (có dấu <b>›</b>) để xem chi tiết.</p>
    {!model ? <div className={shell.chartEmpty}>Chưa có dữ liệu.</div> : <div className={table.statementWrap}><table className={`${table.statement} ${styles.pnl}`}>
      <thead><tr><th>VND</th>{model.columns.map((key, position) => <th key={key} className={position === model.partial ? table.running : undefined}>{bucketLabel(key, grain)}{position === model.partial ? "*" : ""}{position === model.partial && latestDate ? <small>tới {dayLabel(latestDate)}</small> : null}</th>)}<th>Lũy kế</th><th>% DT</th></tr></thead>
      <tbody>
        {model.rows.map((row) => <tr key={row.key} className={`${styles[`depth${row.depth}`] || ""} ${row.tone ? styles[row.tone] || "" : ""}`}>
          <td>{row.label}</td>
          {row.values.map((value, position) => <td key={model.columns[position]}>{amountText(value)}</td>)}
          <td className={table.cumulative}>{amountText(row.cumulative)}</td>
          <td className={styles.percent}>{percentText(row.percent)}</td>
        </tr>)}
        <tr className={styles.note}><td>Lãi (lỗ) lũy kế</td>{model.cumulativeProfit.map((value, position) => <td key={model.columns[position]}>{amountText(value)}</td>)}<td /><td /></tr>
        <tr className={styles.note}><td>Biên lợi nhuận gộp</td>{model.grossMargin.map((value, position) => <td key={model.columns[position]}>{value === undefined ? "–" : percentText(value)}</td>)}<td className={table.cumulative}>{percentText(model.totalMargin)}</td><td /></tr>
      </tbody>
    </table></div>}
    {footer}
    {detail && detailRows && <div className={shell.backdrop} role="presentation" onMouseDown={() => setDetail(undefined)}>
      <div className={`${shell.sheet} ${styles.detailSheet}`} role="dialog" aria-label={`Chi tiết ${detail.title}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className={shell.sheetTitle}><div><span>{detail.path}</span><h2>{detail.title}</h2></div><button type="button" onClick={() => setDetail(undefined)} aria-label="Đóng">×</button></div>
        <p className={styles.detailTotal}><b>{amountText(detail.sign * detailRows.total)} ₫</b><small>{detailRows.rows.length.toLocaleString("vi-VN")} dòng · theo các cột đang xem ({model?.columns.length ? `${bucketLabel(model.columns[0], grain)} → ${bucketLabel(model.columns[model.columns.length - 1], grain)}` : ""})</small></p>
        <div className={styles.detailList}>
          {detailRows.rows.map((row, position) => <div className={styles.detailRow} key={`${row.date}-${position}`}>
            <span>{fullDate(row.date)}</span>
            <span>{[row.note, row.count > 1 ? `${row.count.toLocaleString("vi-VN")} ${row.ref?.kind === "lot" ? "lần" : row.ref ? "kỳ" : "hoá đơn"}` : ""].filter(Boolean).join(" · ")}</span>
            <b>{amountText(detail.sign * row.amount)}</b>
            {row.ref?.kind === "expense" && onOpenExpense ? <button type="button" onClick={() => onOpenExpense(row.ref!.id, row.date)}>Mở phiếu</button>
              : row.ref?.kind === "lot" && onOpenLot ? <button type="button" onClick={() => onOpenLot(row.ref!.id)}>Mở lô</button>
              : <i />}
          </div>)}
        </div>
      </div>
    </div>}
  </article>;
}

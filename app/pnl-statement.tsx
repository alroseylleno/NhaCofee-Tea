"use client";

import { useMemo, useState, type ReactNode } from "react";
import shell from "./finance.module.css";
import table from "./revenue-overview.module.css";
import styles from "./pnl-statement.module.css";

// Báo cáo tài chính → Kết quả kinh doanh theo tháng (Long, 12/11/2026): the P&L
// as Long keeps it — months (or quarters / years) across, Lũy kế and % doanh
// thu at the end, negatives in brackets. Every line opens (+ / −) to the
// outlets (N1, N2, Dùng chung), then to the groups and items that make it up.
// Pure presentation: finance-module.tsx turns every đồng into a dated entry on
// one line, one outlet and one group (`pnlLedger`); this file only adds up.

export type PnlLineKey = "revenue" | "cogsIssued" | "cogsWaste" | "cogsRetail" | "rent" | "operating" | "platform" | "ads" | "salesOther" | "tax" | "fixedOther" | "depreciation";
/// `amount` is positive for revenue and for a cost alike; the line gives the sign.
/// `storeId` is an outlet id or "shared" (Toàn chuỗi costs, kho that does not sell).
export type PnlEntry = { date: string; line: PnlLineKey; storeId: string; group: string; item?: string; amount: number };
export type PnlStore = { id: string; name: string; color: string };
/// One invoice whose items all have a recipe: its revenue and its recipe cost
/// (Product Master). Used only as the WEIGHT that splits an outlet's real cost
/// of goods between Online and Offline; the real cost still comes from the kho.
export type PnlChannelCost = { date: string; storeId: string; channel: "online" | "offline"; revenue: number; cost: number };
type Grain = "month" | "quarter" | "year";
type Totals = Record<PnlLineKey, number>;

const COST_LINES: PnlLineKey[] = ["cogsIssued", "cogsWaste", "cogsRetail", "rent", "operating", "platform", "ads", "salesOther", "tax", "fixedOther", "depreciation"];
const LINES: PnlLineKey[] = ["revenue", ...COST_LINES];
const zero = (): Totals => Object.fromEntries(LINES.map((line) => [line, 0])) as Totals;
const cogsOf = (t: Totals) => t.cogsIssued + t.cogsWaste + t.cogsRetail;
const opexOf = (t: Totals) => t.rent + t.operating + t.platform + t.ads + t.salesOther + t.tax + t.fixedOther;
const grossOf = (t: Totals) => t.revenue - cogsOf(t);
const ebitdaOf = (t: Totals) => grossOf(t) - opexOf(t);
const profitOf = (t: Totals) => ebitdaOf(t) - t.depreciation;

type RowDef =
  | { kind: "line"; line: PnlLineKey; label: string; level: 0 | 1; hideIfEmpty?: boolean }
  | { kind: "total"; key: string; label: string; value: (t: Totals) => number; tone: "subtotal" | "band" | "grand"; parts?: Array<{ label: string; value: (t: Totals) => number }>; byChannel?: boolean };
const ROWS: RowDef[] = [
  { kind: "line", line: "revenue", label: "1. Doanh thu bán hàng thuần", level: 0 },
  { kind: "line", line: "cogsIssued", label: "NVL xuất dùng (kho)", level: 1 },
  { kind: "line", line: "cogsWaste", label: "Hao hụt NVL", level: 1 },
  { kind: "line", line: "cogsRetail", label: "NVL mua lẻ ngoài kho", level: 1 },
  { kind: "total", key: "cogs", label: "2. Giá vốn hàng bán", value: (t) => -cogsOf(t), tone: "subtotal", parts: [
    { label: "NVL xuất dùng (kho)", value: (t) => -t.cogsIssued }, { label: "Hao hụt NVL", value: (t) => -t.cogsWaste }, { label: "NVL mua lẻ ngoài kho", value: (t) => -t.cogsRetail },
  ] },
  { kind: "total", key: "gross", label: "Lợi nhuận gộp", value: grossOf, tone: "band", byChannel: true },
  { kind: "line", line: "rent", label: "Thuê mặt bằng", level: 1 },
  { kind: "line", line: "operating", label: "Nhân sự & vận hành (lương, điện, nước…)", level: 1 },
  { kind: "line", line: "platform", label: "Phí & quảng cáo sàn giao hàng", level: 1 },
  { kind: "line", line: "ads", label: "Quảng cáo Facebook", level: 1 },
  { kind: "line", line: "salesOther", label: "Chi phí bán hàng khác", level: 1 },
  { kind: "line", line: "tax", label: "Thuế & lệ phí", level: 1 },
  { kind: "line", line: "fixedOther", label: "Chi phí cố định khác", level: 1, hideIfEmpty: true },
  { kind: "total", key: "opex", label: "3. Chi phí hoạt động", value: (t) => -opexOf(t), tone: "subtotal", parts: [
    { label: "Thuê mặt bằng", value: (t) => -t.rent }, { label: "Nhân sự & vận hành (lương, điện, nước…)", value: (t) => -t.operating },
    { label: "Phí & quảng cáo sàn giao hàng", value: (t) => -t.platform }, { label: "Quảng cáo Facebook", value: (t) => -t.ads },
    { label: "Chi phí bán hàng khác", value: (t) => -t.salesOther }, { label: "Thuế & lệ phí", value: (t) => -t.tax }, { label: "Chi phí cố định khác", value: (t) => -t.fixedOther },
  ] },
  { kind: "total", key: "ebitda", label: "EBITDA (trước khấu hao)", value: ebitdaOf, tone: "band", parts: [
    { label: "Lợi nhuận gộp", value: grossOf }, { label: "Chi phí hoạt động", value: (t) => -opexOf(t) },
  ] },
  { kind: "line", line: "depreciation", label: "Khấu hao tài sản & setup", level: 1 },
  { kind: "total", key: "profit", label: "LÃI (LỖ) HOẠT ĐỘNG", value: profitOf, tone: "grand", parts: [
    { label: "EBITDA", value: ebitdaOf }, { label: "Khấu hao tài sản & setup", value: (t) => -t.depreciation },
  ] },
];

function bucketKey(date: string, grain: Grain) {
  const year = date.slice(0, 4);
  if (grain === "year") return year;
  return grain === "quarter" ? `${year}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}` : date.slice(0, 7);
}
function bucketLabel(key: string, grain: Grain) {
  if (grain === "year") return key;
  return grain === "quarter" ? key.slice(5) : `T${Number(key.slice(5, 7))}`;
}
function bucketEnd(key: string, grain: Grain) {
  const year = Number(key.slice(0, 4));
  const lastMonth = grain === "year" ? 12 : grain === "quarter" ? Number(key.slice(6)) * 3 : Number(key.slice(5, 7));
  return `${year}-${String(lastMonth).padStart(2, "0")}-${String(new Date(Date.UTC(year, lastMonth, 0)).getUTCDate()).padStart(2, "0")}`;
}
function bucketRange(first: string, last: string, grain: Grain) {
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
const amountText = (value: number | undefined) => value === undefined ? "–" : Math.abs(value) < 0.5 ? "–" : value < 0 ? `(${Math.round(-value).toLocaleString("vi-VN")})` : Math.round(value).toLocaleString("vi-VN");
const percentText = (value: number | undefined) => value === undefined || !Number.isFinite(value) ? "" : `${value < 0 ? "(" : ""}${Math.abs(value).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%${value < 0 ? ")" : ""}`;
const dayLabel = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

type Row = { key: string; depth: number; label: ReactNode; values: number[]; cumulative: number; percent?: number; tone?: string; toggle?: boolean; open?: boolean };

export function PnlStatement({ entries, stores, channelCost = [], firstDate, latestDate, today, footer }: { entries: PnlEntry[]; stores: PnlStore[]; channelCost?: PnlChannelCost[]; firstDate?: string; latestDate?: string; today: string; footer?: ReactNode }) {
  const [grain, setGrain] = useState<Grain>("month");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
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
    // Totals per outlet per column, plus group and item sums per line.
    const byStore = new Map<string, Totals[]>();
    const groups = new Map<string, number[]>();
    const items = new Map<string, number[]>();
    const groupKeys = new Map<string, Set<string>>();
    const itemKeys = new Map<string, Set<string>>();
    let before = zero();
    const cell = (bag: Map<string, number[]>, key: string) => { let row = bag.get(key); if (!row) { row = new Array(width).fill(0); bag.set(key, row); } return row; };
    for (const entry of entries) {
      const position = index.get(bucketKey(entry.date, grain));
      if (position === undefined) {
        if (entry.date < startOfFirst) before = { ...before, [entry.line]: before[entry.line] + entry.amount };
        continue;
      }
      let totals = byStore.get(entry.storeId);
      if (!totals) { totals = Array.from({ length: width }, zero); byStore.set(entry.storeId, totals); }
      totals[position][entry.line] += entry.amount;
      const groupKey = `${entry.line}|${entry.storeId}|${entry.group}`;
      cell(groups, groupKey)[position] += entry.amount;
      const known = groupKeys.get(`${entry.line}|${entry.storeId}`) || new Set<string>();
      known.add(entry.group); groupKeys.set(`${entry.line}|${entry.storeId}`, known);
      if (entry.item && entry.item !== entry.group) {
        cell(items, `${groupKey}|${entry.item}`)[position] += entry.amount;
        const names = itemKeys.get(groupKey) || new Set<string>();
        names.add(entry.item); itemKeys.set(groupKey, names);
      }
    }
    const storeOrder = [...stores.map((store) => store.id), "shared"].filter((id) => byStore.has(id));
    const chain = Array.from({ length: width }, (_, position) => {
      const sum = zero();
      for (const totals of byStore.values()) for (const line of LINES) sum[line] += totals[position][line];
      return sum;
    });
    const sumRow = (values: number[]) => values.reduce((acc, value) => acc + value, 0);
    // Recipe cost and revenue of fully priced invoices, per outlet × channel × column.
    const weights = new Map<string, { revenue: number[]; cost: number[] }>();
    for (const entry of channelCost) {
      const position = index.get(bucketKey(entry.date, grain));
      if (position === undefined) continue;
      const key = `${entry.storeId}|${entry.channel}`;
      const bag = weights.get(key) || { revenue: new Array(width).fill(0), cost: new Array(width).fill(0) };
      bag.revenue[position] += entry.revenue;
      bag.cost[position] += entry.cost;
      weights.set(key, bag);
    }
    /// An outlet's gross profit by channel: channel revenue minus the outlet's
    /// REAL cost of goods (kho + hao hụt + mua lẻ) split in proportion to what
    /// each channel's sales cost by recipe. A channel without priced invoices
    /// borrows the outlet's overall recipe rate; with no recipe at all the split
    /// follows revenue. Cost in a column with no revenue stays unassigned.
    const grossByChannel = (storeId: string) => {
      const totals = byStore.get(storeId)!;
      const revenueOf = (group: string) => groups.get(`revenue|${storeId}|${group}`) || new Array(width).fill(0);
      const online = revenueOf("Online");
      const offline = revenueOf("Offline · tại quầy");
      const on = weights.get(`${storeId}|online`), off = weights.get(`${storeId}|offline`);
      const result = { online: new Array(width).fill(0), offline: new Array(width).fill(0), unassigned: new Array(width).fill(0) };
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
      return { ...result, revenueOnline: online, revenueOffline: offline };
    };
    const revenueTotal = sumRow(chain.map((t) => t.revenue));
    const percentOf = (cumulative: number, cost: boolean) => revenueTotal ? (cost ? Math.abs(cumulative) : cumulative) / revenueTotal * 100 : undefined;
    const storeName = (id: string, line?: PnlLineKey) => id === "shared" ? (line === "revenue" ? "Chưa tách theo nhà" : "Dùng chung (Toàn chuỗi)") : stores.find((store) => store.id === id)?.name || id;
    const storeColor = (id: string) => stores.find((store) => store.id === id)?.color || "#8a958c";
    const label = (key: string, text: ReactNode, canOpen: boolean, color?: string) => canOpen
      ? <button type="button" className={styles.toggle} aria-expanded={open.has(key)} onClick={() => toggle(key)}><i aria-hidden="true">{open.has(key) ? "−" : "+"}</i>{color && <b style={{ background: color }} />}{text}</button>
      : <span className={styles.leaf}>{color && <b style={{ background: color }} />}{text}</span>;
    const rows: Row[] = [];
    for (const def of ROWS) {
      if (def.kind === "line") {
        const sign = def.line === "revenue" ? 1 : -1;
        const values = chain.map((t) => sign * t[def.line]);
        if (def.hideIfEmpty && values.every((value) => Math.abs(value) < 0.5)) continue;
        const cumulative = sumRow(values);
        const stake = storeOrder.filter((id) => byStore.get(id)!.some((t) => Math.abs(t[def.line]) >= 0.5));
        rows.push({ key: def.line, depth: def.level, values, cumulative, percent: def.line === "revenue" ? undefined : percentOf(cumulative, true), tone: def.level === 0 ? "lead" : undefined, label: label(def.line, def.label, stake.length > 0) });
        if (!open.has(def.line)) continue;
        for (const storeId of stake) {
          const storeKey = `${def.line}|${storeId}`;
          const storeValues = byStore.get(storeId)!.map((t) => sign * t[def.line]);
          const groupList = [...(groupKeys.get(storeKey) || [])].map((group) => ({ group, values: (groups.get(`${storeKey}|${group}`) || new Array(width).fill(0)).map((value) => sign * value) }))
            .filter((entry) => entry.values.some((value) => Math.abs(value) >= 0.5))
            .sort((left, right) => Math.abs(sumRow(right.values)) - Math.abs(sumRow(left.values)));
          rows.push({ key: storeKey, depth: def.level + 1, values: storeValues, cumulative: sumRow(storeValues), percent: def.line === "revenue" ? percentOf(sumRow(storeValues), false) : percentOf(sumRow(storeValues), true), tone: "store", label: label(storeKey, storeName(storeId, def.line), groupList.length > 0, storeColor(storeId)) });
          if (!open.has(storeKey)) continue;
          for (const { group, values: groupValues } of groupList) {
            const groupKey = `${storeKey}|${group}`;
            const itemList = [...(itemKeys.get(groupKey) || [])].map((item) => ({ item, values: (items.get(`${groupKey}|${item}`) || new Array(width).fill(0)).map((value) => sign * value) }))
              .filter((entry) => entry.values.some((value) => Math.abs(value) >= 0.5))
              .sort((left, right) => Math.abs(sumRow(right.values)) - Math.abs(sumRow(left.values)));
            rows.push({ key: groupKey, depth: def.level + 2, values: groupValues, cumulative: sumRow(groupValues), tone: "group", label: label(groupKey, group, itemList.length > 0) });
            if (!open.has(groupKey)) continue;
            for (const { item, values: itemValues } of itemList) rows.push({ key: `${groupKey}|${item}`, depth: def.level + 3, values: itemValues, cumulative: sumRow(itemValues), tone: "item", label: label(`${groupKey}|${item}`, item, false) });
          }
        }
      } else {
        const values = chain.map(def.value);
        const cumulative = sumRow(values);
        rows.push({ key: def.key, depth: 0, values, cumulative, percent: percentOf(cumulative, def.tone === "subtotal"), tone: def.tone, label: label(def.key, def.label, storeOrder.length > 0) });
        if (!open.has(def.key)) continue;
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
          } else if (def.parts) {
            for (const part of def.parts) children.push({ label: part.label, values: byStore.get(storeId)!.map(part.value) });
          }
          const shown = children.filter((child) => child.values.some((value) => Math.abs(value) >= 0.5));
          rows.push({ key: storeKey, depth: 1, values: storeValues, cumulative: sumRow(storeValues), percent: percentOf(sumRow(storeValues), def.tone === "subtotal"), tone: "store", label: label(storeKey, storeName(storeId), shown.length > 0, storeColor(storeId)) });
          if (!open.has(storeKey)) continue;
          for (const child of shown) rows.push({ key: `${storeKey}|${child.label}`, depth: 2, values: child.values, cumulative: sumRow(child.values), percent: percentOf(sumRow(child.values), def.tone === "subtotal"), tone: "group", label: label(`${storeKey}|${child.label}`, child.label, false) });
        }
      }
    }
    // Lãi (lỗ) lũy kế runs from the first day of the shop, not from the first column.
    let running = profitOf(before);
    const cumulativeProfit = chain.map((t) => (running += profitOf(t)));
    const gross = chain.map(grossOf);
    const partial = latestDate ? columns.findIndex((key) => key === bucketKey(latestDate, grain) && latestDate < bucketEnd(key, grain)) : -1;
    return { columns, rows, cumulativeProfit, grossMargin: chain.map((t, position) => t.revenue ? gross[position] / t.revenue * 100 : undefined), totalMargin: revenueTotal ? sumRow(gross) / revenueTotal * 100 : undefined, partial, totalProfit: sumRow(chain.map(profitOf)), revenueTotal };
  }, [entries, stores, channelCost, grain, year, firstDate, latestDate, today, open]);

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
    <p className={styles.legend}>Doanh thu → giá vốn → chi phí hoạt động → lãi lỗ. Số âm trong ngoặc. Bấm <b>+</b> ở một dòng để xem Nhà 1, Nhà 2, Dùng chung và từng khoản tạo nên con số đó.</p>
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
  </article>;
}

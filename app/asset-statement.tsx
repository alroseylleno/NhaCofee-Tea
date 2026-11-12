"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import shell from "./finance.module.css";
import table from "./revenue-overview.module.css";
import styles from "./pnl-statement.module.css";
import { amountText, bucketEnd, bucketKey, bucketLabel, bucketRange, dayLabel, fullDate, percentText, type Grain } from "./pnl-statement";

// Báo cáo tài chính → Tài sản & khấu hao (Long, 12/11/2026): the same layout as
// Kết quả kinh doanh — months (or quarters / years) across, + / − down to N1 /
// N2 / Dùng chung → nhóm → từng tài sản, the last row opens the asset. A column
// reads Giá trị còn lại đầu kỳ + Mua mới − Khấu hao = Giá trị còn lại cuối kỳ.
// Pure presentation: finance-module.tsx hands over every asset (nhóm Đầu tư)
// with its month-by-month depreciation from `depreciationForAsset`.

export type AssetRecord = {
  id: string; name: string; group: string; storeId: string; cost: number; ownedOn: string;
  usefulLifeMonths?: number; note?: string;
  /// Depreciation booked in each month ("YYYY-MM" → đồng); missing = 0.
  depreciation: Record<string, number>;
};
export type AssetStore = { id: string; name: string; color: string };

type Measure = "opening" | "added" | "depreciation" | "closing" | "cost" | "accumulated";
const ROWS: Array<{ key: Measure; label: string; tone?: "lead" | "band" | "grand" | "memo"; cumulative: "first" | "sum" | "last" }> = [
  { key: "opening", label: "A. Giá trị còn lại đầu kỳ", tone: "lead", cumulative: "first" },
  { key: "added", label: "B. Mua mới trong kỳ", cumulative: "sum" },
  { key: "depreciation", label: "C. Khấu hao trong kỳ", cumulative: "sum" },
  { key: "closing", label: "D. Giá trị còn lại cuối kỳ (A + B − C)", tone: "grand", cumulative: "last" },
  { key: "cost", label: "Nguyên giá cuối kỳ", tone: "memo", cumulative: "last" },
  { key: "accumulated", label: "Khấu hao lũy kế cuối kỳ", tone: "memo", cumulative: "last" },
];
/// Standard view, like the P&L: the four movement rows open one level (by
/// outlet); the memo rows closed.
const DEFAULT_OPEN = ["opening", "added", "depreciation", "closing"];

const monthOf = (date: string) => date.slice(0, 7);
const previousMonth = (month: string) => { const [year, value] = month.split("-").map(Number); return value === 1 ? `${year - 1}-12` : `${year}-${String(value - 1).padStart(2, "0")}`; };
const firstMonthOf = (key: string, grain: Grain) => grain === "year" ? `${key}-01` : grain === "quarter" ? `${key.slice(0, 4)}-${String(Number(key.slice(6)) * 3 - 2).padStart(2, "0")}` : key;

export function AssetStatement({ assets, stores, firstDate, today, footer, onOpenExpense }: {
  assets: AssetRecord[]; stores: AssetStore[]; firstDate?: string; today: string; footer?: ReactNode; onOpenExpense?: (id: string) => void;
}) {
  const [grain, setGrain] = useState<Grain>("month");
  const [open, setOpen] = useState<Set<string>>(() => new Set(DEFAULT_OPEN));
  const [detail, setDetail] = useState<{ key: string; title: string; path: string; ids: string[]; measure: Measure }>();
  const years = useMemo(() => {
    const first = firstDate || assets.map((asset) => asset.ownedOn).sort()[0];
    if (!first) return [];
    const list: string[] = [];
    for (let year = Number(first.slice(0, 4)); year <= Number(today.slice(0, 4)); year += 1) list.push(String(year));
    return list;
  }, [assets, firstDate, today]);
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
    if (!year || !assets.length) return undefined;
    const first = firstDate || assets.map((asset) => asset.ownedOn).sort()[0];
    const columns = grain === "year"
      ? bucketRange(first, today, "year")
      : bucketRange(first.slice(0, 4) === year ? first : `${year}-01-01`, today.slice(0, 4) === year ? today : `${year}-12-31`, grain);
    const width = columns.length;
    // Accumulated depreciation of an asset through a month, cached per asset.
    const accumulatedThrough = (asset: AssetRecord, month: string) => Object.entries(asset.depreciation).reduce((sum, [entryMonth, amount]) => entryMonth <= month ? sum + amount : sum, 0);
    const value = (asset: AssetRecord, measure: Measure, position: number) => {
      const key = columns[position];
      const startMonth = firstMonthOf(key, grain);
      const endDate = bucketEnd(key, grain);
      const endMonth = monthOf(endDate);
      const ownedBy = (date: string) => asset.ownedOn <= date;
      switch (measure) {
        case "opening": return asset.ownedOn < `${startMonth}-01` ? asset.cost - accumulatedThrough(asset, previousMonth(startMonth)) : 0;
        case "added": return asset.ownedOn >= `${startMonth}-01` && asset.ownedOn <= endDate ? asset.cost : 0;
        case "depreciation": return -(accumulatedThrough(asset, endMonth) - accumulatedThrough(asset, previousMonth(startMonth)));
        case "closing": return ownedBy(endDate) ? asset.cost - accumulatedThrough(asset, endMonth) : 0;
        case "cost": return ownedBy(endDate) ? asset.cost : 0;
        case "accumulated": return ownedBy(endDate) ? -accumulatedThrough(asset, endMonth) : 0;
      }
    };
    const rowValues = (list: AssetRecord[], measure: Measure) => columns.map((_, position) => list.reduce((sum, asset) => sum + value(asset, measure, position), 0));
    const cumulativeOf = (values: number[], how: "first" | "sum" | "last") => how === "first" ? values[0] : how === "last" ? values[values.length - 1] : values.reduce((sum, item) => sum + item, 0);
    const storeOrder = [...stores.map((store) => store.id), "shared"].filter((id) => assets.some((asset) => asset.storeId === id));
    const storeName = (id: string) => id === "shared" ? "Dùng chung (Toàn chuỗi)" : stores.find((store) => store.id === id)?.name || id;
    const storeColor = (id: string) => stores.find((store) => store.id === id)?.color || "#8a958c";
    const totalClosing = cumulativeOf(rowValues(assets, "closing"), "last");
    /// % còn lại: an outlet's / group's share of the remaining value — only on D and its children.
    const share = (amount: number, measure: Measure) => measure === "closing" && totalClosing ? amount / totalClosing * 100 : undefined;
    const label = (key: string, text: string, mode: "toggle" | "detail" | "plain", ids: string[], measure: Measure, color?: string, path = text) => {
      const swatch = color ? <b style={{ background: color }} /> : null;
      if (mode === "toggle") return <button type="button" className={styles.toggle} aria-expanded={open.has(key)} onClick={() => toggle(key)}><i aria-hidden="true">{open.has(key) ? "−" : "+"}</i>{swatch}{text}</button>;
      if (mode === "detail") return <button type="button" className={styles.leafButton} title="Xem chi tiết" onClick={() => setDetail({ key, title: text, path, ids, measure })}>{swatch}<span>{text}</span><em aria-hidden="true">›</em></button>;
      return <span className={styles.leaf}>{swatch}{text}</span>;
    };
    const nonZero = (values: number[]) => values.some((amount) => Math.abs(amount) >= 0.5);
    const rows: Array<{ key: string; depth: number; label: ReactNode; values: number[]; cumulative: number; percent?: number; tone?: string }> = [];
    for (const def of ROWS) {
      const values = rowValues(assets, def.key);
      const cumulative = cumulativeOf(values, def.cumulative);
      rows.push({ key: def.key, depth: 0, values, cumulative, percent: share(cumulative, def.key), tone: def.tone === "memo" ? "note" : def.tone === "grand" ? "grand" : def.tone === "lead" ? "lead" : undefined, label: label(def.key, def.label, "toggle", assets.map((asset) => asset.id), def.key) });
      if (!open.has(def.key)) continue;
      for (const storeId of storeOrder) {
        const inStore = assets.filter((asset) => asset.storeId === storeId);
        const storeValues = rowValues(inStore, def.key);
        if (!nonZero(storeValues)) continue;
        const storeKey = `${def.key}|${storeId}`;
        rows.push({ key: storeKey, depth: 1, values: storeValues, cumulative: cumulativeOf(storeValues, def.cumulative), percent: share(cumulativeOf(storeValues, def.cumulative), def.key), tone: "store", label: label(storeKey, storeName(storeId), "toggle", inStore.map((asset) => asset.id), def.key, storeColor(storeId)) });
        if (!open.has(storeKey)) continue;
        const groups = [...new Set(inStore.map((asset) => asset.group))]
          .map((group) => ({ group, list: inStore.filter((asset) => asset.group === group) }))
          .map((entry) => ({ ...entry, values: rowValues(entry.list, def.key) }))
          .filter((entry) => nonZero(entry.values))
          .sort((left, right) => Math.abs(cumulativeOf(right.values, def.cumulative)) - Math.abs(cumulativeOf(left.values, def.cumulative)));
        for (const { group, list, values: groupValues } of groups) {
          const groupKey = `${storeKey}|${group}`;
          rows.push({ key: groupKey, depth: 2, values: groupValues, cumulative: cumulativeOf(groupValues, def.cumulative), percent: share(cumulativeOf(groupValues, def.cumulative), def.key), tone: "group", label: label(groupKey, group, "toggle", list.map((asset) => asset.id), def.key) });
          if (!open.has(groupKey)) continue;
          const items = list.map((asset) => ({ asset, values: rowValues([asset], def.key) })).filter((entry) => nonZero(entry.values))
            .sort((left, right) => Math.abs(cumulativeOf(right.values, def.cumulative)) - Math.abs(cumulativeOf(left.values, def.cumulative)));
          for (const { asset, values: itemValues } of items) {
            const text = `${asset.name} · ${fullDate(asset.ownedOn)}`;
            rows.push({ key: `${groupKey}|${asset.id}`, depth: 3, values: itemValues, cumulative: cumulativeOf(itemValues, def.cumulative), tone: "item", label: label(`${groupKey}|${asset.id}`, text, "detail", [asset.id], def.key, undefined, `${def.label} · ${storeName(storeId)} · ${group}`) });
          }
        }
      }
    }
    const closing = rowValues(assets, "closing");
    const cost = rowValues(assets, "cost");
    const depreciatedShare = closing.map((amount, position) => cost[position] ? (cost[position] - amount) / cost[position] * 100 : undefined);
    const lastMonth = monthOf(bucketEnd(columns[columns.length - 1], grain));
    return { columns, rows, depreciatedShare, totalClosing, totalCost: cost[cost.length - 1], lastMonth, accumulatedThrough, partial: columns.findIndex((key) => key === bucketKey(today, grain) && today < bucketEnd(key, grain)) };
  }, [assets, stores, grain, year, firstDate, today, open]);

  const detailAssets = detail && model ? assets.filter((asset) => detail.ids.includes(asset.id)) : [];

  return <article className={`${shell.revenuePanel} ${table.statementPanel}`}>
    <div className={table.trendHead}>
      <div className={shell.revenuePanelTitle}><div><span>TÀI SẢN &amp; KHẤU HAO THEO {grain === "month" ? "THÁNG" : grain === "quarter" ? "QUÝ" : "NĂM"} · TOÀN CHUỖI{grain !== "year" && year ? ` · ${year}` : ""}</span>{model && <strong>Giá trị còn lại {amountText(model.totalClosing)} ₫ · nguyên giá {amountText(model.totalCost)} ₫</strong>}</div></div>
      <div className={table.statementControls}>
        {grain !== "year" && years.length > 1 && <select aria-label="Năm" value={year} onChange={(event) => setYearChoice(event.target.value)}>{years.map((option) => <option key={option}>{option}</option>)}</select>}
        <div className={table.grain} role="group" aria-label="Cột theo">
          {([["month", "Tháng"], ["quarter", "Quý"], ["year", "Năm"]] as const).map(([value, text]) => <button type="button" key={value} aria-pressed={grain === value} className={grain === value ? table.grainOn : undefined} onClick={() => setGrain(value)}>{text}</button>)}
        </div>
      </div>
    </div>
    <p className={styles.legend}>Giá trị còn lại đầu kỳ + mua mới − khấu hao = giá trị còn lại cuối kỳ. Số âm trong ngoặc. Bấm <b>+</b> để mở ra Nhà 1, Nhà 2, Dùng chung, nhóm và từng tài sản; bấm tài sản (có dấu <b>›</b>) để xem chi tiết.</p>
    {!model ? <div className={shell.chartEmpty}>Chưa có tài sản nào. Ghi nhận ở Ghi nhận chi phí → Đầu tư ban đầu.</div> : <div className={table.statementWrap}><table className={`${table.statement} ${styles.pnl}`}>
      <thead><tr><th>VND</th>{model.columns.map((key, position) => <th key={key} className={position === model.partial ? table.running : undefined}>{bucketLabel(key, grain)}{position === model.partial ? "*" : ""}{position === model.partial ? <small>tới {dayLabel(today)}</small> : null}</th>)}<th>Cả kỳ</th><th>% GT còn lại</th></tr></thead>
      <tbody>
        {model.rows.map((row) => <tr key={row.key} className={`${styles[`depth${row.depth}`] || ""} ${row.tone ? styles[row.tone] || "" : ""}`}>
          <td>{row.label}</td>
          {row.values.map((amount, position) => <td key={model.columns[position]}>{amountText(amount)}</td>)}
          <td className={table.cumulative}>{amountText(row.cumulative)}</td>
          <td className={styles.percent}>{percentText(row.percent)}</td>
        </tr>)}
        <tr className={styles.note}><td>% nguyên giá đã khấu hao</td>{model.depreciatedShare.map((amount, position) => <td key={model.columns[position]}>{amount === undefined ? "–" : percentText(amount)}</td>)}<td className={table.cumulative}>{percentText(model.depreciatedShare[model.depreciatedShare.length - 1])}</td><td /></tr>
      </tbody>
    </table></div>}
    {footer}
    {detail && model && <div className={shell.backdrop} role="presentation" onMouseDown={() => setDetail(undefined)}>
      <div className={`${shell.sheet} ${styles.detailSheet}`} role="dialog" aria-label={`Chi tiết ${detail.title}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className={shell.sheetTitle}><div><span>{detail.path}</span><h2>{detail.title}</h2></div><button type="button" onClick={() => setDetail(undefined)} aria-label="Đóng">×</button></div>
        <div className={styles.detailList}>
          {detailAssets.map((asset) => {
            const accumulated = model.accumulatedThrough(asset, model.lastMonth);
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
        </div>
      </div>
    </div>}
  </article>;
}

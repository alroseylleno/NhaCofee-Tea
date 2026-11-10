"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import shell from "./finance.module.css";
import styles from "./revenue-overview.module.css";

// Doanh thu → Tổng quan (statement + trend charts) and the trend charts of
// Nền tảng. Pure presentation: finance-module.tsx decides which outlet and
// channel every đồng belongs to and hands over dated entries; this file only
// buckets them by month / quarter / year and draws them.

export type TrendGrain = "month" | "quarter" | "year";
export type LedgerChannel = "quay" | "website" | "grab" | "shopee" | "greensm" | "befood" | "gofood" | "other" | "unsplit";
/// One dated amount. An invoice carries `revenue` (and `received` when the money
/// lands at once — counter, Website); a sàn report carries `received` (payout −
/// the day's ads) and `ads`; a sàn invoice with no report for its day carries
/// `pending` = its revenue, because what the sàn will pay is not known yet.
export type LedgerEntry = { date: string; storeId: string; channel: LedgerChannel; revenue?: number; received?: number; ads?: number; pending?: number };
export type StatementStore = { id: string; name: string; openedOn?: string; color: string };
export type TrendSeries = { key: string; name: string; color: string; entries: Array<{ date: string; value: number }>; from?: string };

const SAN_CHANNELS: LedgerChannel[] = ["grab", "shopee", "greensm", "befood", "gofood", "other"];
const CHANNEL_LABELS: Record<LedgerChannel, string> = { quay: "Offline · tại quầy", website: "Website", grab: "GrabFood", shopee: "ShopeeFood", greensm: "GreenSM", befood: "beFood", gofood: "GoFood", other: "Sàn khác", unsplit: "Chưa tách được" };
const ONLINE_ORDER: LedgerChannel[] = ["grab", "shopee", "greensm", "befood", "gofood", "other", "website"];
const isSan = (channel: LedgerChannel) => SAN_CHANNELS.includes(channel);

const number = (value: number) => Math.round(value).toLocaleString("vi-VN");
function short(value: number) {
  const abs = Math.abs(value);
  const text = abs >= 1e6 ? `${(abs / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} tr` : abs >= 1e3 ? `${Math.round(abs / 1e3)}k` : String(Math.round(abs));
  return value < 0 ? `−${text}` : text;
}
function dayLabel(date: string) { return `${date.slice(8, 10)}/${date.slice(5, 7)}`; }

/// Bucket key of a day: "2026-07", "2026-Q3" or "2026".
export function grainKey(date: string, grain: TrendGrain) {
  const year = date.slice(0, 4);
  if (grain === "year") return year;
  const month = Number(date.slice(5, 7));
  return grain === "quarter" ? `${year}-Q${Math.ceil(month / 3)}` : date.slice(0, 7);
}
function grainLabel(key: string, grain: TrendGrain, withYear: boolean) {
  if (grain === "year") return key;
  const year = key.slice(2, 4);
  if (grain === "quarter") return withYear ? `${key.slice(5)}/${year}` : key.slice(5);
  return withYear ? `T${Number(key.slice(5, 7))}/${year}` : `T${Number(key.slice(5, 7))}`;
}
function grainEnd(key: string, grain: TrendGrain) {
  const year = Number(key.slice(0, 4));
  const lastMonth = grain === "year" ? 12 : grain === "quarter" ? Number(key.slice(6)) * 3 : Number(key.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, lastMonth, 0)).getUTCDate();
  return `${year}-${String(lastMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}
/// Every bucket from the one holding `first` to the one holding `last`, in order.
function grainRange(first: string, last: string, grain: TrendGrain) {
  const keys: string[] = [];
  let year = Number(first.slice(0, 4));
  let month = grain === "year" ? 1 : Number(first.slice(5, 7));
  if (grain === "quarter") month = (Math.ceil(month / 3) - 1) * 3 + 1;
  const step = grain === "month" ? 1 : grain === "quarter" ? 3 : 12;
  const end = grainKey(last, grain);
  for (let guard = 0; guard < 600; guard += 1) {
    const key = grainKey(`${year}-${String(month).padStart(2, "0")}-01`, grain);
    keys.push(key);
    if (key === end) break;
    month += step;
    while (month > 12) { month -= 12; year += 1; }
  }
  return keys;
}

export function GrainToggle({ value, onChange, label = "Gom theo" }: { value: TrendGrain; onChange: (grain: TrendGrain) => void; label?: string }) {
  return <div className={styles.grain} role="group" aria-label={label}>
    {([["month", "Tháng"], ["quarter", "Quý"], ["year", "Năm"]] as const).map(([grain, text]) => (
      <button type="button" key={grain} aria-pressed={value === grain} className={value === grain ? styles.grainOn : undefined} onClick={() => onChange(grain)}>{text}</button>
    ))}
  </div>;
}

/// Line chart over time with its own Tháng / Quý / Năm control. The bucket that
/// holds `latestDate` but ends after it is still running: its segment is dashed
/// and its label carries a star, so eight days of November never read as a crash.
export function TrendChart({ title, headline, note, series, latestDate, empty, footer }: { title: string; headline?: string; note?: string; series: TrendSeries[]; latestDate?: string; empty?: string; footer?: ReactNode }) {
  const [grain, setGrain] = useState<TrendGrain>("month");
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const [hover, setHover] = useState<number>();
  const [width, setWidth] = useState(640);
  const plotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = plotRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => {
    const dates = series.flatMap((line) => line.entries.filter((entry) => entry.value).map((entry) => entry.date)).sort();
    if (!dates.length) return undefined;
    const last = latestDate && latestDate > dates[dates.length - 1] ? latestDate : dates[dates.length - 1];
    const keys = grainRange(dates[0], last, grain);
    const multiYear = keys[0].slice(0, 4) !== keys[keys.length - 1].slice(0, 4);
    const partialIndex = latestDate && latestDate < grainEnd(keys[keys.length - 1], grain) ? keys.length - 1 : -1;
    const lines = series.map((line) => {
      const sums = new Map<string, number>();
      for (const entry of line.entries) sums.set(grainKey(entry.date, grain), (sums.get(grainKey(entry.date, grain)) || 0) + entry.value);
      const firstKey = line.from ? grainKey(line.from, grain) : undefined;
      return { ...line, values: keys.map((key) => firstKey && key < firstKey ? undefined : sums.get(key) || 0) };
    });
    return { keys, labels: keys.map((key) => grainLabel(key, grain, multiYear)), partialIndex, lines };
  }, [series, grain, latestDate]);

  const visible = model ? model.lines.filter((line) => !hidden[line.key]) : [];
  const toggleLine = (key: string) => {
    if (!hidden[key] && visible.length <= 1) return; // always keep one line
    setHidden((current) => ({ ...current, [key]: !current[key] }));
  };

  const height = 220;
  const pad = { left: 46, right: 14, top: 22, bottom: 28 };
  const values = visible.flatMap((line) => line.values.filter((value): value is number => value !== undefined));
  const rawMax = Math.max(0, ...values);
  const rawMin = Math.min(0, ...values);
  // Four equal steps, each a round number, so every tick label is exact.
  const niceStep = (value: number) => { if (value <= 0) return 0; const unit = 10 ** Math.floor(Math.log10(value)); return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * unit >= value) || 10) * unit; };
  const step = niceStep(Math.max(rawMax, -rawMin) / 4) || 250_000;
  const max = Math.max(step, Math.ceil(rawMax / step) * step);
  const min = rawMin < 0 ? Math.floor(rawMin / step) * step : 0;
  const count = model?.keys.length || 0;
  const x = (index: number) => count <= 1 ? (pad.left + width - pad.right) / 2 : pad.left + index * (width - pad.left - pad.right) / (count - 1);
  const y = (value: number) => pad.top + (1 - (value - min) / (max - min)) * (height - pad.top - pad.bottom);
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => max - index * step);
  const path = (points: Array<{ index: number; value: number }>) => points.map((point, order) => `${order ? "L" : "M"}${x(point.index).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
  const placedLabels: number[] = [];

  return <article className={`${shell.revenuePanel} ${styles.trendPanel}`}>
    <div className={styles.trendHead}>
      <div className={shell.revenuePanelTitle}><div><span>{title}</span>{headline && <strong>{headline}</strong>}</div></div>
      <GrainToggle value={grain} onChange={(next) => { setGrain(next); setHover(undefined); }} />
    </div>
    {model && <div className={styles.legend} role="group" aria-label="Ẩn / hiện đường">
      {model.lines.map((line) => <button type="button" key={line.key} aria-pressed={!hidden[line.key]} className={hidden[line.key] ? styles.legendOff : undefined} onClick={() => toggleLine(line.key)}><i style={{ background: line.color }} />{line.name}</button>)}
      {note && <small>{note}</small>}
    </div>}
    <div className={styles.plot} ref={plotRef} onMouseLeave={() => setHover(undefined)}>
      {!model ? <div className={shell.chartEmpty}>{empty || "Chưa có dữ liệu."}</div> : <>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
          {ticks.map((tick) => <g key={tick}>
            <line className={tick === 0 ? styles.zero : styles.gridLine} x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} />
            <text className={styles.axisText} x={pad.left - 7} y={y(tick) + 3} textAnchor="end">{short(tick)}</text>
          </g>)}
          {model.labels.map((label, index) => <text key={model.keys[index]} className={styles.axisLabel} x={x(index)} y={height - 8} textAnchor="middle">{label}{index === model.partialIndex ? "*" : ""}</text>)}
          {hover !== undefined && <line className={styles.cross} x1={x(hover)} x2={x(hover)} y1={pad.top} y2={height - pad.bottom} />}
          {visible.map((line) => {
            const points = line.values.map((value, index) => value === undefined ? undefined : { index, value }).filter((point): point is { index: number; value: number } => Boolean(point));
            const solid = points.filter((point) => point.index !== model.partialIndex);
            const tail = model.partialIndex >= 0 && points.length > 1 && points[points.length - 1].index === model.partialIndex ? points.slice(-2) : [];
            const anchor = solid[solid.length - 1] || points[points.length - 1];
            let labelY = anchor ? y(anchor.value) - 9 : 0;
            for (const taken of placedLabels) if (Math.abs(taken - labelY) < 13) labelY = taken + (labelY <= taken ? -13 : 13);
            labelY = Math.max(pad.top - 8, Math.min(height - pad.bottom - 4, labelY));
            placedLabels.push(labelY);
            return <g key={line.key}>
              {solid.length > 1 && <path className={styles.line} d={path(solid)} style={{ stroke: line.color }} />}
              {tail.length === 2 && <path className={`${styles.line} ${styles.lineRunning}`} d={path(tail)} style={{ stroke: line.color }} />}
              {points.map((point) => <circle key={point.index} className={styles.dot} cx={x(point.index)} cy={y(point.value)} r={hover === point.index ? 5 : 3.5} style={{ fill: line.color }} />)}
              {anchor && <text className={styles.endLabel} x={x(anchor.index) + (count <= 1 || anchor.index === 0 ? 9 : -6)} y={labelY} textAnchor={count <= 1 || anchor.index === 0 ? "start" : "end"} style={{ fill: line.color }}>{line.name} {short(anchor.value)}</text>}
            </g>;
          })}
          {model.keys.map((key, index) => {
            const half = count <= 1 ? (width - pad.left - pad.right) / 2 : (width - pad.left - pad.right) / (count - 1) / 2;
            return <rect key={key} className={styles.hit} x={x(index) - half} y={0} width={half * 2} height={height} onMouseEnter={() => setHover(index)} onClick={() => setHover(index)} />;
          })}
        </svg>
        {hover !== undefined && <div className={styles.tooltip} style={{ left: `${Math.min(80, Math.max(20, x(hover) / width * 100))}%` }}>
          <b>{model.labels[hover]}</b>
          {model.lines.map((line) => <div key={line.key}><span><i style={{ background: line.color }} />{line.name}</span><em>{line.values[hover] === undefined ? "chưa mở" : `${number(line.values[hover]!)} ₫`}</em></div>)}
          {hover === model.partialIndex && latestDate && <small>Kỳ đang chạy · dữ liệu tới {dayLabel(latestDate)}</small>}
        </div>}
      </>}
    </div>
    {footer}
  </article>;
}

type StatementRow = { key: string; level: 0 | 1 | 2 | 3; label: ReactNode; values: Array<number | undefined>; tone?: "section" | "ratio"; percent?: boolean };

/// The revenue statement Long asked for (same shape as the P&L by month):
/// 1. Doanh thu thuần · 2. Tiền thực nhận · 3. what sits between them, each
/// split Nhà → Offline / Online → kênh. Columns are months, quarters or years,
/// plus Lũy kế. Section 1 always adds up to the P&L's Doanh thu thuần: whatever
/// the invoice file does not cover lands in "Chưa tách được", never dropped.
export function RevenueStatement({ entries, stores, firstDate, latestDate, today }: { entries: LedgerEntry[]; stores: StatementStore[]; firstDate?: string; latestDate?: string; today: string }) {
  const [grain, setGrain] = useState<TrendGrain>("month");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const years = useMemo(() => {
    const first = firstDate || entries.map((entry) => entry.date).sort()[0];
    if (!first) return [];
    const last = (latestDate || today).slice(0, 4);
    const list: string[] = [];
    for (let year = Number(first.slice(0, 4)); year <= Number(last); year += 1) list.push(String(year));
    return list;
  }, [entries, firstDate, latestDate, today]);
  const [yearChoice, setYearChoice] = useState<string>();
  const year = yearChoice && years.includes(yearChoice) ? yearChoice : years[years.length - 1];

  const table = useMemo(() => {
    if (!year) return undefined;
    const first = firstDate || entries.map((entry) => entry.date).sort()[0];
    const last = latestDate && latestDate > today ? latestDate : today;
    const columns = grain === "year"
      ? grainRange(first, last, "year")
      : grainRange(first.slice(0, 4) === year ? first : `${year}-01-01`, last.slice(0, 4) === year ? last : `${year}-12-31`, grain);
    const index = new Map(columns.map((key, position) => [key, position]));
    const blank = () => columns.map(() => 0);
    const cell = (bag: Map<string, number[]>, key: string) => { let row = bag.get(key); if (!row) { row = blank(); bag.set(key, row); } return row; };
    const revenue = new Map<string, number[]>();
    const received = new Map<string, number[]>();
    const totals = { revenue: blank(), received: blank(), san: blank(), sanReceived: blank(), ads: blank(), pending: blank(), unsplit: blank(), online: blank() };
    for (const entry of entries) {
      const position = index.get(grainKey(entry.date, grain));
      if (position === undefined) continue;
      const add = (row: number[], value = 0) => { row[position] += value; };
      if (entry.channel === "unsplit") { add(totals.unsplit, entry.revenue); add(totals.revenue, entry.revenue); continue; }
      add(cell(revenue, `${entry.storeId}|${entry.channel}`), entry.revenue);
      add(cell(received, `${entry.storeId}|${entry.channel}`), entry.received);
      add(totals.revenue, entry.revenue);
      add(totals.received, entry.received);
      if (entry.channel !== "quay") add(totals.online, entry.revenue);
      if (isSan(entry.channel)) { add(totals.san, entry.revenue); add(totals.sanReceived, entry.received); }
      add(totals.ads, entry.ads);
      add(totals.pending, entry.pending);
    }
    // Days before an outlet opened read "–", not 0.
    const openMask = (store: StatementStore, row: number[]) => row.map((value, position) => store.openedOn && grainEnd(columns[position], grain) < store.openedOn ? undefined : value);
    const sumRows = (bag: Map<string, number[]>, storeId: string, channels: LedgerChannel[]) => channels.reduce((acc, channel) => { const row = bag.get(`${storeId}|${channel}`); return row ? acc.map((value, position) => value + row[position]) : acc; }, blank());
    const rows: StatementRow[] = [];
    const section = (code: "d" | "r", title: string, bag: Map<string, number[]>, total: number[]) => {
      rows.push({ key: `${code}-total`, level: 0, label: title, values: total, tone: code === "r" ? "section" : undefined });
      for (const store of stores) {
        const online = sumRows(bag, store.id, ONLINE_ORDER);
        const offline = sumRows(bag, store.id, ["quay"]);
        const storeTotal = online.map((value, position) => value + offline[position]);
        const rowKey = `${code}-${store.id}`;
        const open = !collapsed[rowKey];
        rows.push({ key: rowKey, level: 1, values: openMask(store, storeTotal), label: <button type="button" className={styles.rowToggle} aria-expanded={open} onClick={() => setCollapsed((current) => ({ ...current, [rowKey]: open }))}><i>{open ? "▾" : "▸"}</i><b style={{ background: store.color }} />{store.name}</button> });
        if (!open) continue;
        rows.push({ key: `${rowKey}-quay`, level: 2, label: CHANNEL_LABELS.quay, values: openMask(store, offline) });
        rows.push({ key: `${rowKey}-online`, level: 2, label: "Online", values: openMask(store, online) });
        for (const channel of ONLINE_ORDER) {
          const row = bag.get(`${store.id}|${channel}`);
          if (!row || !row.some((value) => Math.abs(value) >= 1)) continue;
          rows.push({ key: `${rowKey}-${channel}`, level: 3, label: `${CHANNEL_LABELS[channel]}${code === "r" && isSan(channel) ? " · sau quảng cáo" : ""}`, values: openMask(store, row) });
        }
      }
    };
    section("d", "1. Doanh thu bán hàng thuần", revenue, totals.revenue);
    if (totals.unsplit.some((value) => Math.abs(value) >= 1)) rows.push({ key: "d-unsplit", level: 2, label: "Chưa tách được (file hoá đơn chưa phủ kỳ này)", values: totals.unsplit });
    section("r", "2. Tiền thực nhận", received, totals.received);
    const fees = totals.san.map((value, position) => value - totals.pending[position] - totals.sanReceived[position] - totals.ads[position]);
    rows.push({ key: "gap", level: 0, tone: "section", label: "3. Sàn giữ lại (1 − 2)", values: totals.revenue.map((value, position) => value - totals.received[position]) });
    rows.push({ key: "gap-fees", level: 2, label: "Phí & thuế sàn", values: fees });
    rows.push({ key: "gap-ads", level: 2, label: "Quảng cáo sàn", values: totals.ads });
    if (totals.pending.some((value) => value >= 1)) rows.push({ key: "gap-pending", level: 2, label: "Chờ báo cáo sàn (tạm — báo cáo về thì chuyển lên dòng 2 và phí)", values: totals.pending });
    if (totals.unsplit.some((value) => Math.abs(value) >= 1)) rows.push({ key: "gap-unsplit", level: 2, label: "Chưa tách được", values: totals.unsplit });
    const ratio = (top: number[], bottom: number[]) => top.map((value, position) => bottom[position] ? value / bottom[position] * 100 : undefined);
    const sum = (row: number[]) => row.reduce((acc, value) => acc + value, 0);
    rows.push({ key: "pct-received", level: 2, tone: "ratio", percent: true, label: "% về túi (2 ÷ 1)", values: [...ratio(totals.received, totals.revenue), sum(totals.revenue) ? sum(totals.received) / sum(totals.revenue) * 100 : undefined] });
    rows.push({ key: "pct-online", level: 2, tone: "ratio", percent: true, label: "% Online trong doanh thu", values: [...ratio(totals.online, totals.revenue), sum(totals.revenue) ? sum(totals.online) / sum(totals.revenue) * 100 : undefined] });
    const partial = latestDate ? columns.findIndex((key) => key === grainKey(latestDate, grain) && latestDate < grainEnd(key, grain)) : -1;
    return { columns, labels: columns.map((key) => grainLabel(key, grain, false)), rows, partial, grand: { revenue: sum(totals.revenue), received: sum(totals.received) } };
  }, [entries, stores, grain, year, firstDate, latestDate, today, collapsed]);

  const format = (value: number | undefined, percent?: boolean) => value === undefined ? "–" : percent ? `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%` : Math.abs(value) < 1 ? "–" : number(value);
  const cumulative = (row: StatementRow) => {
    if (row.percent) return row.values[row.values.length - 1];
    const present = row.values.filter((value): value is number => value !== undefined);
    return present.length ? present.reduce((acc, value) => acc + value, 0) : undefined;
  };

  return <article className={`${shell.revenuePanel} ${styles.statementPanel}`}>
    <div className={styles.trendHead}>
      <div className={shell.revenuePanelTitle}><div><span>DOANH THU &amp; TIỀN THỰC NHẬN · TOÀN CHUỖI{grain !== "year" && year ? ` · ${year}` : ""}</span>{table && <strong>{number(table.grand.revenue)} ₫ doanh thu · {number(table.grand.received)} ₫ về túi</strong>}</div></div>
      <div className={styles.statementControls}>
        {grain !== "year" && years.length > 1 && <select aria-label="Năm" value={year} onChange={(event) => setYearChoice(event.target.value)}>{years.map((option) => <option key={option}>{option}</option>)}</select>}
        <GrainToggle value={grain} onChange={setGrain} label="Cột theo" />
      </div>
    </div>
    {!table ? <div className={shell.chartEmpty}>Chưa có doanh thu. Nạp bộ file SAPO ở Import Center.</div> : <div className={styles.statementWrap}><table className={styles.statement}>
      <thead><tr><th>VND</th>{table.labels.map((label, position) => <th key={table.columns[position]} className={position === table.partial ? styles.running : undefined}>{label}{position === table.partial ? "*" : ""}{position === table.partial && latestDate ? <small>tới {dayLabel(latestDate)}</small> : null}</th>)}<th>Lũy kế</th></tr></thead>
      <tbody>{table.rows.map((row) => <tr key={row.key} className={`${styles[`level${row.level}`]} ${row.tone === "section" ? styles.sectionRow : ""} ${row.tone === "ratio" ? styles.ratioRow : ""}`}>
        <td>{row.label}</td>
        {table.columns.map((key, position) => { const value = row.values[position]; return <td key={key} className={value !== undefined && value < -0.5 && !row.percent ? styles.negative : undefined}>{format(value, row.percent)}</td>; })}
        <td className={styles.cumulative}>{format(cumulative(row), row.percent)}</td>
      </tr>)}</tbody>
    </table></div>}
    <p className={shell.metricDisclaimer}>Cả hai nhà, không theo chip chi nhánh hay bộ lọc kỳ trên đầu trang. <b>Doanh thu</b> = tổng tiền thanh toán từng hoá đơn SAPO (bỏ đơn huỷ), tính theo ngày thanh toán, cộng đơn sàn chưa vào SAPO lấy thẳng từ báo cáo sàn. <b>Thực nhận</b>: tại quầy và Website bằng doanh thu; sàn là Tổng thu nhập trong báo cáo quyết toán mỗi ngày (tiền sàn chuyển trừ quảng cáo ngày). Ngày có đơn sàn mà chưa có báo cáo thì đơn đó nằm ở dòng Chờ báo cáo sàn. Kỳ có * là kỳ đang chạy.</p>
  </article>;
}

/// Store badge for a row in a mixed list ("N1", "N2"): the "N<k>" prefix of
/// the outlet's name, else its first word.
export function storeShortName(name: string) {
  return name.normalize("NFC").match(/^\s*(N\s*\d+)/i)?.[1].replace(/\s+/g, "").toUpperCase() || name.split(/\s+/)[0];
}

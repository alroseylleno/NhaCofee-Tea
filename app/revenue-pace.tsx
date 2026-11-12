"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import shell from "./finance.module.css";
import styles from "./revenue-pace.module.css";

// Doanh thu → Tổng quan, top (Long, 12/11/2026): how this month is pacing.
// 1. Run-rate: how much of last month's revenue this month has reached, where
//    it should be by today, and where today's pace lands at month end.
// 2. Target: the average a day must bring to reach the month's target, what
//    the remaining days now need, and a day-by-day line of actual vs that
//    average with the gap of every day (or cumulative vs the target path).
// Toàn chuỗi. Revenue = the same daily ledger as the statement below.

const money = (value: number) => `${Math.round(value).toLocaleString("vi-VN")} ₫`;
const signed = (value: number) => `${value >= 0 ? "+" : "−"}${Math.round(Math.abs(value)).toLocaleString("vi-VN")} ₫`;
const percent = (value: number) => `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`;
const short = (value: number) => Math.abs(value) >= 1e6 ? `${(value / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} tr` : `${Math.round(value / 1e3)}k`;
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const previousMonth = (month: string) => { const [year, value] = month.split("-").map(Number); return value === 1 ? `${year - 1}-12` : `${year}-${String(value - 1).padStart(2, "0")}`; };
const monthName = (month: string) => `T${Number(month.slice(5, 7))}/${month.slice(0, 4)}`;

export function RevenuePace({ daily, latestDate, today, targetAmount, growthPercent, onTargetAmount, onGrowthPercent }: {
  daily: Array<{ date: string; revenue: number }>; latestDate?: string; today: string;
  targetAmount: number; growthPercent: number; onTargetAmount: (amount: number) => void; onGrowthPercent: (value: number) => void;
}) {
  const [mode, setMode] = useState<"day" | "cumulative">("day");
  const [hover, setHover] = useState<number>();
  const [width, setWidth] = useState(720);
  const plotRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = plotRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => {
    const month = today.slice(0, 7);
    const days = daysIn(month);
    const byDay = new Map<string, number>();
    for (const entry of daily) byDay.set(entry.date, (byDay.get(entry.date) || 0) + entry.revenue);
    const sumMonth = (key: string) => [...byDay.entries()].reduce((sum, [date, revenue]) => date.startsWith(key) ? sum + revenue : sum, 0);
    const last = previousMonth(month);
    const lastTotal = sumMonth(last);
    // Days count as done up to the newest day with revenue in this month; SAPO
    // lands a day late, so "today" alone would read as a zero day.
    const through = latestDate && latestDate.startsWith(month) ? Number(latestDate.slice(8, 10)) : 0;
    const values = Array.from({ length: days }, (_, index) => byDay.get(`${month}-${String(index + 1).padStart(2, "0")}`) || 0);
    const done = values.slice(0, through).reduce((sum, value) => sum + value, 0);
    const remainingDays = days - through;
    const target = targetAmount > 0 ? targetAmount : lastTotal * (1 + growthPercent / 100);
    const perDay = target / days;
    const projected = through ? done / through * days : 0;
    let running = 0;
    const cumulative = values.map((value, index) => index < through ? (running += value) : undefined);
    return { month, last, days, lastTotal, through, values, done, remainingDays, target, perDay, projected, cumulative, reachedDays: values.slice(0, through).filter((value) => value >= perDay).length };
  }, [daily, latestDate, today, targetAmount, growthPercent]);

  const { month, last, days, lastTotal, through, done, remainingDays, target, perDay, projected } = model;
  const ofLast = lastTotal ? done / lastTotal * 100 : 0;
  const timeShare = through / days * 100;
  const projectedOfLast = lastTotal ? projected / lastTotal * 100 : 0;
  const needToMatch = Math.max(0, lastTotal - done);
  const needTarget = Math.max(0, target - done);

  // Chart: day mode = each day's revenue vs the target average; cumulative mode
  // = running total vs the straight target path.
  const height = 220;
  const pad = { left: 46, right: 14, top: 18, bottom: 26 };
  const actual = mode === "day" ? model.values.map((value, index) => index < through ? value : undefined) : model.cumulative;
  const goal = model.values.map((_, index) => mode === "day" ? perDay : perDay * (index + 1));
  const peak = Math.max(1, ...goal, ...actual.filter((value): value is number => value !== undefined));
  const step = (() => { const raw = peak / 4; const unit = 10 ** Math.floor(Math.log10(raw)); return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * unit >= raw) || 10) * unit; })();
  const max = Math.ceil(peak / step) * step;
  const x = (index: number) => pad.left + index * (width - pad.left - pad.right) / Math.max(1, days - 1);
  const y = (value: number) => pad.top + (1 - value / max) * (height - pad.top - pad.bottom);
  const actualPoints = actual.map((value, index) => value === undefined ? undefined : { index, value }).filter((point): point is { index: number; value: number } => Boolean(point));
  const path = (points: Array<{ index: number; value: number }>) => points.map((point, order) => `${order ? "L" : "M"}${x(point.index).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
  const hovered = hover !== undefined && hover < through ? hover : undefined;

  return <div className={styles.pace}>
    <article className={`${shell.revenuePanel} ${styles.card}`}>
      <div className={shell.revenuePanelTitle}><div><span>TIẾN ĐỘ SO VỚI THÁNG TRƯỚC · {monthName(month)}</span><strong>{percent(ofLast)} doanh thu {monthName(last)}</strong></div><small>{through ? `dữ liệu tới ${String(through).padStart(2, "0")}/${month.slice(5, 7)}` : "chưa có doanh thu tháng này"}</small></div>
      <div className={styles.runBar} role="img" aria-label={`Đã đạt ${percent(ofLast)} doanh thu tháng trước; thời gian đã qua ${percent(timeShare)}; theo nhịp hiện tại cuối tháng đạt ${percent(projectedOfLast)}`}>
        <i className={styles.runProjected} style={{ width: `${Math.min(100, projectedOfLast)}%` }} />
        <i className={styles.runDone} style={{ width: `${Math.min(100, ofLast)}%` }} />
        <b className={styles.runTime} style={{ left: `${Math.min(100, timeShare)}%` }} />
      </div>
      <div className={styles.runLegend}>
        <span><i className={styles.dotDone} />Đã đạt {money(done)}</span>
        <span><i className={styles.dotTime} />Thời gian đã qua {percent(timeShare)} ({through}/{days} ngày)</span>
        <span><i className={styles.dotProjected} />Theo nhịp này cuối tháng ≈ {money(projected)} · {percent(projectedOfLast)}</span>
      </div>
      <p className={styles.runNote}>{lastTotal ? needToMatch > 0
        ? <>Để bằng {monthName(last)} ({money(lastTotal)}) còn thiếu <b>{money(needToMatch)}</b>{remainingDays ? <> · cần trung bình <b>{money(needToMatch / remainingDays)}/ngày</b> trong {remainingDays} ngày còn lại</> : null}. {ofLast >= timeShare ? "Đang đi nhanh hơn nhịp tháng trước." : "Đang chậm hơn nhịp tháng trước."}</>
        : <>Đã vượt doanh thu {monthName(last)} ({money(lastTotal)}).</>
        : `Chưa có doanh thu ${monthName(last)} để so.`}</p>
    </article>
    <article className={`${shell.revenuePanel} ${styles.card}`}>
      <div className={shell.revenuePanelTitle}><div><span>MỤC TIÊU {monthName(month)}</span><strong>{money(target)}</strong></div><small>{targetAmount > 0 ? "nhập trực tiếp" : `${monthName(last)} + ${percent(growthPercent)}`}</small></div>
      <div className={styles.targetStats}>
        <div><span>Trung bình cần mỗi ngày</span><b>{money(perDay)}</b><small>{money(target)} ÷ {days} ngày</small></div>
        <div><span>Đã đạt</span><b>{money(done)}</b><small>{target ? percent(done / target * 100) : "–"} mục tiêu · {model.reachedDays}/{through} ngày đạt</small></div>
        <div className={needTarget > 0 && remainingDays && needTarget / remainingDays > perDay ? styles.behind : undefined}><span>Các ngày còn lại cần</span><b>{remainingDays ? `${money(needTarget / remainingDays)}/ngày` : needTarget > 0 ? "hết ngày" : "đã đạt"}</b><small>{needTarget > 0 ? `còn thiếu ${money(needTarget)} · ${remainingDays} ngày` : `vượt ${money(done - target)}`}</small></div>
      </div>
      <div className={styles.targetInputs}>
        <label>Mục tiêu tháng (₫)<input inputMode="numeric" placeholder="Để trống = tự tính" value={targetAmount ? targetAmount.toLocaleString("vi-VN") : ""} onChange={(event) => onTargetAmount(Number(event.target.value.replace(/\D/g, "")) || 0)} /></label>
        <label>Hoặc tăng trưởng so với {monthName(last)} (%)<input type="number" min={0} step={1} value={growthPercent} onChange={(event) => { onGrowthPercent(Math.max(0, Number(event.target.value) || 0)); onTargetAmount(0); }} /></label>
      </div>
    </article>
    <article className={`${shell.revenuePanel} ${styles.chartCard}`}>
      <div className={styles.chartHead}>
        <div className={shell.revenuePanelTitle}><div><span>DOANH THU MỖI NGÀY SO VỚI MỤC TIÊU · {monthName(month)}</span><strong>{through ? `${model.reachedDays}/${through} ngày đạt · lũy kế ${signed(done - perDay * through)} so với nhịp mục tiêu` : "Chưa có doanh thu tháng này"}</strong></div></div>
        <div className={styles.toggle} role="group" aria-label="Kiểu xem">
          {([["day", "Theo ngày"], ["cumulative", "Cộng dồn"]] as const).map(([value, text]) => <button type="button" key={value} aria-pressed={mode === value} className={mode === value ? styles.on : undefined} onClick={() => setMode(value)}>{text}</button>)}
        </div>
      </div>
      <div className={styles.legend}><span><i className={styles.lineActual} />Thực tế</span><span><i className={styles.lineGoal} />{mode === "day" ? `Mục tiêu ${money(perDay)}/ngày` : "Đường mục tiêu cộng dồn"}</span><span><i className={styles.dotOk} />đạt</span><span><i className={styles.dotMiss} />chưa đạt</span></div>
      <div className={styles.plot} ref={plotRef} onMouseLeave={() => setHover(undefined)}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Doanh thu mỗi ngày so với mục tiêu">
          {[0, 1, 2, 3, 4].map((tick) => { const value = max - tick * step; return value < 0 ? null : <g key={tick}><line className={styles.grid} x1={pad.left} x2={width - pad.right} y1={y(value)} y2={y(value)} /><text className={styles.axis} x={pad.left - 6} y={y(value) + 3} textAnchor="end">{value ? short(value) : "0"}</text></g>; })}
          {model.values.map((_, index) => (index === 0 || (index + 1) % 5 === 0 || index === days - 1) && <text key={index} className={styles.axisDay} x={x(index)} y={height - 8} textAnchor="middle">{index + 1}</text>)}
          <path className={styles.goal} d={path(goal.map((value, index) => ({ index, value })))} />
          {hovered !== undefined && <line className={styles.cross} x1={x(hovered)} x2={x(hovered)} y1={pad.top} y2={height - pad.bottom} />}
          {actualPoints.length > 1 && <path className={styles.actual} d={path(actualPoints)} />}
          {actualPoints.map((point) => <circle key={point.index} className={point.value >= goal[point.index] ? styles.ok : styles.miss} cx={x(point.index)} cy={y(point.value)} r={hovered === point.index ? 5 : 3.5} />)}
          {model.values.map((_, index) => <rect key={index} className={styles.hit} x={x(index) - (width - pad.left - pad.right) / Math.max(1, days - 1) / 2} y={0} width={(width - pad.left - pad.right) / Math.max(1, days - 1)} height={height} onMouseEnter={() => setHover(index)} onClick={() => setHover(index)} />)}
        </svg>
        {hovered !== undefined && <div className={styles.tooltip} style={{ left: `${Math.min(80, Math.max(20, x(hovered) / width * 100))}%` }}>
          <b>Ngày {hovered + 1}/{month.slice(5, 7)}</b>
          <div><span>Thực tế</span><em>{money(model.values[hovered])}</em></div>
          <div><span>Mục tiêu ngày</span><em>{money(perDay)}</em></div>
          <div className={model.values[hovered] >= perDay ? styles.gapOk : styles.gapMiss}><span>Gap ngày</span><em>{signed(model.values[hovered] - perDay)}</em></div>
          <div><span>Lũy kế / nhịp mục tiêu</span><em>{money(model.cumulative[hovered] || 0)} / {money(perDay * (hovered + 1))}</em></div>
          <div className={(model.cumulative[hovered] || 0) >= perDay * (hovered + 1) ? styles.gapOk : styles.gapMiss}><span>Gap lũy kế</span><em>{signed((model.cumulative[hovered] || 0) - perDay * (hovered + 1))}</em></div>
        </div>}
      </div>
      <p className={shell.metricDisclaimer}>Toàn chuỗi, doanh thu thuần theo ngày thanh toán (cùng nguồn với bảng bên dưới). Mục tiêu ngày = mục tiêu tháng chia đều cho {days} ngày; ngày có dấu xanh là đạt, đỏ là chưa đạt. Mục tiêu lưu trên máy này.</p>
    </article>
  </div>;
}

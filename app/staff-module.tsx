"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { CloudStore } from "@/lib/inventory-store";
import { defaultOutletId, outletsOf, outletsOpenOn } from "@/lib/store-scope";
import {
  DEFAULT_REASON_POINTS, FULL_SCORE, addDays, averageScore, cleanName, closedFor, countsForScore, formatHours, formatMinutes, isMonthClosed,
  isOvernight, lastShiftOf, localToday, monthBounds, monthLabel, monthOf, nameKey, payrollLines, rememberedRates, shiftMinutes, shiftPay,
  shiftProblems, shiftScore, summarize, violationCount,
  type PayrollClosing, type ShiftViolation, type StaffMember, type StaffShift, type StaffState, type ViolationReason,
} from "@/lib/staff";
import {
  StaffNotReadyError, closePayroll, deleteShift, loadPayrollExpenses, loadSalaryExpenses, loadStaff, reopenPayroll, saveShift, saveStaffMember, saveViolationReason,
  type SalaryExpense,
} from "@/lib/staff-store";
import { useUrlState } from "@/lib/use-url-state";
import styles from "./staff.module.css";

type PeriodMode = "month" | "quarter" | "year";
type ShiftDraft = {
  id: string; isNew: boolean; staffId: string; newName: string; storeId: string; workDate: string; absent: boolean;
  checkIn: string; checkOut: string; breakMinutes: string; rate: string; customRate: boolean; violations: ShiftViolation[]; note: string;
};
type CloseLineDraft = { staffId: string; bonus: string };

const SELECTED_STORE_KEY = "nha-ops-selected-store-v1";
const WEEKDAYS = ["T2", "T3", "T4", "T5", "T6", "T7", "CN"];
const WEEKDAY_NAMES = ["Chủ nhật", "Thứ hai", "Thứ ba", "Thứ tư", "Thứ năm", "Thứ sáu", "Thứ bảy"];
const MEMBER_COLORS = ["#1e4b3f", "#b0763a", "#4f64a0", "#9b4f7a", "#3f7f8c", "#8a6d1f", "#6b5ca5", "#a2483a"];

function money(value: number) { return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value || 0); }
function rateLabel(value: number) { return value.toLocaleString("vi-VN"); }
function amountInput(value: string) { const digits = value.replace(/\D/g, ""); return digits ? Number(digits).toLocaleString("en-US") : ""; }
function parseAmount(value: string) { return Number(value.replace(/\D/g, "")) || 0; }
function dateLabel(value: string) { const [year, month, day] = value.split("-"); return `${day}/${month}/${year}`; }
function parseDateLabel(value: string) {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return undefined;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return undefined;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}
function weekdayOf(date: string) { return new Date(`${date}T00:00:00Z`).getUTCDay(); }
function scoreText(value?: number) { return value === undefined ? "—" : value.toLocaleString("vi-VN", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); }
function newId() { return crypto.randomUUID(); }

/// Given names are the last word in Vietnamese ("Nguyễn Văn An" → "An"); two
/// people sharing it keep one more word.
function shortNames(members: StaffMember[]) {
  const words = new Map(members.map((member) => [member.id, member.name.split(" ")]));
  const result = new Map<string, string>();
  for (const member of members) {
    const own = words.get(member.id)!;
    let take = 1;
    while (take < own.length && members.some((other) => other.id !== member.id && words.get(other.id)!.slice(-take).join(" ") === own.slice(-take).join(" "))) take += 1;
    result.set(member.id, own.slice(-take).join(" "));
  }
  return result;
}

function DateField({ value, onChange, id }: { value: string; onChange: (value: string) => void; id: string }) {
  const [display, setDisplay] = useState(dateLabel(value));
  useEffect(() => setDisplay(dateLabel(value)), [value]);
  return <input id={id} inputMode="numeric" placeholder="dd/mm/yyyy" value={display} onChange={(event) => setDisplay(event.target.value)} onBlur={() => { const parsed = parseDateLabel(display); if (parsed) onChange(parsed); else setDisplay(dateLabel(value)); }} />;
}

export default function StaffModule({ uatMode, stores, onOpenFinance }: { uatMode: boolean; stores: CloudStore[]; onOpenFinance: () => void }) {
  const [data, setData] = useState<StaffState | undefined>();
  const [status, setStatus] = useState<"loading" | "ready" | "not-ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [periodMode, setPeriodMode] = useUrlState<PeriodMode>("cp", "month", ["month", "quarter", "year"]);
  const today = localToday();
  const [month, setMonth] = useState(monthOf(today));
  const [quarter, setQuarter] = useState(Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1);
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [scope, setScope] = useState("");
  const [selectedDay, setSelectedDay] = useState<string | undefined>();
  const [draft, setDraft] = useState<ShiftDraft | undefined>();
  const [newReason, setNewReason] = useState<{ label: string; points: string } | undefined>();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [notice, setNotice] = useState<{ text: string; finance?: boolean } | undefined>();
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeLines, setCloseLines] = useState<CloseLineDraft[]>([]);
  const [closeDate, setCloseDate] = useState("");
  const [closeEarlyOk, setCloseEarlyOk] = useState(false);
  const [salaryRows, setSalaryRows] = useState<SalaryExpense[] | undefined>();
  const [reopenOpen, setReopenOpen] = useState(false);
  const [paidPayroll, setPaidPayroll] = useState<SalaryExpense[] | undefined>();
  const [membersOpen, setMembersOpen] = useState(false);

  async function reload() {
    try {
      const next = await loadStaff(uatMode);
      setData(next);
      setStatus("ready");
    } catch (error) {
      if (error instanceof StaffNotReadyError) { setStatus("not-ready"); return; }
      setLoadError(error instanceof Error ? error.message : "Không tải được dữ liệu chấm công.");
      setStatus("error");
    }
  }
  useEffect(() => { void reload(); }, [uatMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const outlets = useMemo(() => outletsOf(stores), [stores]);
  const multiOutlet = outlets.length > 1;
  useEffect(() => {
    if (scope) return;
    let device = "";
    try { device = window.localStorage.getItem(SELECTED_STORE_KEY) || ""; } catch { /* storage blocked */ }
    setScope(outlets.some((store) => store.id === device) ? device : defaultOutletId(stores) || "");
  }, [outlets, stores, scope]);
  // A store list loaded after the first render can drop the chosen id.
  const storeScope = scope === "all" && multiOutlet ? "all" : outlets.some((store) => store.id === scope) ? scope : defaultOutletId(stores) || outlets[0]?.id || "";
  const storeName = (id: string) => stores.find((store) => store.id === id)?.name || "Điểm bán chưa rõ";
  const storeShort = (id: string) => { const index = outlets.findIndex((store) => store.id === id); return index >= 0 ? `N${index + 1}` : storeName(id); };

  const members = useMemo(() => [...(data?.members || [])].sort((left, right) => left.name.localeCompare(right.name, "vi")), [data]);
  const memberById = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const memberName = (id: string) => memberById.get(id)?.name || "Nhân viên đã xoá";
  const shorts = useMemo(() => shortNames(members), [members]);
  const colorOf = (id: string) => MEMBER_COLORS[Math.max(0, members.findIndex((member) => member.id === id)) % MEMBER_COLORS.length];

  const months = useMemo(() => {
    if (periodMode === "month") return [month];
    const first = periodMode === "quarter" ? (quarter - 1) * 3 + 1 : 1;
    const count = periodMode === "quarter" ? 3 : 12;
    return Array.from({ length: count }, (_, index) => `${year}-${String(first + index).padStart(2, "0")}`);
  }, [periodMode, month, quarter, year]);
  const range = { start: monthBounds(months[0]).start, end: monthBounds(months[months.length - 1]).end };
  const periodLabel = periodMode === "month" ? `Tháng ${monthLabel(month)}` : periodMode === "quarter" ? `Quý ${quarter}/${year}` : `Năm ${year}`;
  const inScope = (shift: StaffShift) => storeScope === "all" || shift.storeId === storeScope;
  const periodShifts = useMemo(() => (data?.shifts || []).filter((shift) => shift.workDate >= range.start && shift.workDate <= range.end && inScope(shift)), [data, range.start, range.end, storeScope]); // eslint-disable-line react-hooks/exhaustive-deps
  const periodClosings = useMemo(() => (data?.closings || []).filter((closing) => months.includes(closing.month) && (storeScope === "all" || closing.storeId === storeScope)), [data, months, storeScope]);
  const summaries = useMemo(() => summarize(periodShifts, periodClosings), [periodShifts, periodClosings]);
  const totals = useMemo(() => {
    let minutes = 0, shifts = 0, violations = 0, scoreSum = 0, scoreCount = 0, amount = 0;
    for (const entry of summaries.values()) { minutes += entry.minutes; shifts += entry.shiftCount; violations += entry.violations; scoreSum += entry.scoreSum; scoreCount += entry.scoreCount; amount += entry.amount; }
    return { minutes, shifts, violations, score: scoreCount ? scoreSum / scoreCount : undefined, amount };
  }, [summaries]);
  const reasonTally = useMemo(() => {
    const tally = new Map<string, number>();
    for (const shift of periodShifts) for (const entry of shift.violations) tally.set(entry.label, (tally.get(entry.label) || 0) + entry.count);
    return [...tally].sort((left, right) => right[1] - left[1]);
  }, [periodShifts]);

  const scopeStores = storeScope === "all" ? outlets.map((store) => store.id) : [storeScope];
  const monthStatus = (value: string) => {
    const withShifts = scopeStores.filter((id) => (data?.shifts || []).some((shift) => shift.storeId === id && monthOf(shift.workDate) === value));
    const closed = withShifts.filter((id) => isMonthClosed(data?.closings || [], value, id));
    return { withShifts: withShifts.length, closed: closed.length };
  };
  const closedHere = storeScope !== "all" && isMonthClosed(data?.closings || [], month, storeScope);

  // ------------------------------------------------------------------ shifts

  function openDay(date: string) { setSelectedDay(date); setDraft(undefined); setFormError(""); setNewReason(undefined); }
  function shiftLocked(shift: Pick<StaffShift, "payrollClosingId" | "workDate" | "storeId">) { return Boolean(shift.payrollClosingId) || isMonthClosed(data?.closings || [], monthOf(shift.workDate), shift.storeId); }
  function dayStores(date: string) { const open = outletsOpenOn(stores, date); return open.length ? open : outlets; }

  function startShift(date: string, base?: StaffShift) {
    const storeId = base?.storeId || (storeScope !== "all" ? storeScope : dayStores(date)[0]?.id || "");
    setFormError(""); setNewReason(undefined);
    if (base) {
      const rates = rememberedRates(data!);
      setDraft({ id: base.id, isNew: false, staffId: base.staffId, newName: "", storeId, workDate: base.workDate, absent: base.absent, checkIn: base.checkIn || "", checkOut: base.checkOut || "", breakMinutes: String(base.breakMinutes || 0), rate: amountInput(String(base.hourlyRate)), customRate: !rates.includes(base.hourlyRate), violations: base.violations.map((entry) => ({ ...entry })), note: base.note || "" });
      return;
    }
    setDraft({ id: newId(), isNew: true, staffId: "", newName: "", storeId, workDate: date, absent: false, checkIn: "", checkOut: "", breakMinutes: "0", rate: "", customRate: false, violations: [], note: "" });
  }
  /// Picking a person fills in their usual hours, break and rate.
  function pickMember(staffId: string) {
    setDraft((current) => {
      if (!current) return current;
      const member = memberById.get(staffId);
      const last = lastShiftOf(data?.shifts || [], staffId, current.workDate);
      const rate = last?.hourlyRate || member?.defaultRate || 0;
      const rates = rememberedRates(data!);
      return { ...current, staffId, newName: "", storeId: current.isNew && member?.defaultStoreId && dayStores(current.workDate).some((store) => store.id === member.defaultStoreId) && storeScope === "all" ? member.defaultStoreId : current.storeId,
        ...(current.isNew ? { checkIn: last?.checkIn || current.checkIn, checkOut: last?.checkOut || current.checkOut, breakMinutes: String(last?.breakMinutes ?? current.breakMinutes), rate: rate ? amountInput(String(rate)) : current.rate, customRate: Boolean(rate) && !rates.includes(rate) } : {}) };
    });
  }
  function draftShift(current: ShiftDraft): StaffShift {
    const existing = current.newName ? members.find((member) => nameKey(member.name) === nameKey(current.newName)) : undefined;
    return {
      id: current.id, staffId: current.newName ? existing?.id || "__new" : current.staffId, storeId: current.storeId, workDate: current.workDate, absent: current.absent,
      checkIn: current.absent ? undefined : current.checkIn || undefined, checkOut: current.absent ? undefined : current.checkOut || undefined,
      breakMinutes: current.absent ? 0 : Math.max(0, Math.round(Number(current.breakMinutes) || 0)), hourlyRate: parseAmount(current.rate),
      violations: current.violations, note: current.note.trim() || undefined,
    };
  }
  const draftPreview = draft && data ? draftShift(draft) : undefined;
  const draftCheck = draftPreview && data ? shiftProblems({ ...draftPreview, staffId: draft!.newName.trim() || draft!.staffId ? draftPreview.staffId : "" }, data.shifts.filter((shift) => shift.staffId === draftPreview.staffId)) : undefined;

  function toggleReason(reason: ViolationReason, delta: 1 | -1) {
    setDraft((current) => {
      if (!current) return current;
      const found = current.violations.find((entry) => (entry.reasonId || entry.label) === (reason.id || reason.label));
      const count = (found?.count || 0) + delta;
      const others = current.violations.filter((entry) => entry !== found);
      return { ...current, violations: count > 0 ? [...others, { reasonId: reason.id, label: reason.label, points: found?.points ?? reason.points, count }] : others };
    });
  }

  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !data || saving) return;
    const shift = draftShift(draft);
    const name = cleanName(draft.newName);
    const check = shiftProblems({ ...shift, staffId: name || draft.staffId ? shift.staffId : "" }, data.shifts.filter((entry) => entry.staffId === shift.staffId));
    if (check.errors.length) { setFormError(check.errors[0]); return; }
    setSaving(true); setFormError("");
    try {
      let nextMembers = data.members;
      let staffId = shift.staffId;
      const existing = memberById.get(staffId);
      if (staffId === "__new") {
        const created = await saveStaffMember(uatMode, { id: newId(), name, defaultRate: shift.absent ? 0 : shift.hourlyRate, defaultStoreId: shift.storeId, status: "active" });
        nextMembers = [...nextMembers, created];
        staffId = created.id;
      } else if (existing && !shift.absent && (existing.defaultRate !== shift.hourlyRate || existing.defaultStoreId !== shift.storeId || existing.status !== "active")) {
        // "Tự nhớ": the next shift of this person starts from this rate and store.
        const updated = await saveStaffMember(uatMode, { ...existing, defaultRate: shift.hourlyRate, defaultStoreId: shift.storeId, status: "active" });
        nextMembers = nextMembers.map((member) => member.id === updated.id ? updated : member);
      }
      const saved = await saveShift(uatMode, { ...shift, staffId });
      setData({ ...data, members: nextMembers, shifts: [...data.shifts.filter((entry) => entry.id !== saved.id), saved] });
      setDraft(undefined);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Không lưu được ca.");
      if (isDuplicateName(error)) void reload();
    } finally {
      setSaving(false);
    }
  }
  function isDuplicateName(error: unknown) { return error instanceof Error && /tên này đã có/.test(error.message); }

  async function removeDraftShift() {
    if (!draft || !data || draft.isNew) return;
    const shift = data.shifts.find((entry) => entry.id === draft.id);
    if (!shift) return;
    setSaving(true); setFormError("");
    try {
      await deleteShift(uatMode, shift);
      setData({ ...data, shifts: data.shifts.filter((entry) => entry.id !== shift.id) });
      setDraft(undefined);
    } catch (error) { setFormError(error instanceof Error ? error.message : "Không xoá được ca."); }
    finally { setSaving(false); }
  }

  async function addReason() {
    if (!newReason || !data) return;
    const label = cleanName(newReason.label);
    if (!label) return;
    const points = Math.min(FULL_SCORE, Math.max(0, Number(newReason.points.replace(",", ".")) || 0));
    const known = data.reasons.find((reason) => nameKey(reason.label) === nameKey(label));
    try {
      const reason = known || await saveViolationReason(uatMode, { id: newId(), label, points });
      if (!known) setData({ ...data, reasons: [...data.reasons, reason] });
      toggleReason(reason, 1);
      setNewReason(undefined);
    } catch (error) { setFormError(error instanceof Error ? error.message : "Không lưu được lý do."); }
  }

  /// Copies the previous day's shifts (hours, break, rate; no violations) into
  /// an empty day — most days repeat the roster.
  async function copyPreviousDay(date: string) {
    if (!data || saving) return;
    const previous = data.shifts.filter((shift) => shift.workDate === addDays(date, -1) && !shift.absent && inScope(shift) && !isMonthClosed(data.closings, monthOf(date), shift.storeId));
    if (!previous.length) return;
    setSaving(true); setFormError("");
    const added: StaffShift[] = [];
    try {
      for (const shift of previous) added.push(await saveShift(uatMode, { ...shift, id: newId(), workDate: date, violations: [], note: undefined, payrollClosingId: undefined }));
    } catch (error) { setFormError(error instanceof Error ? error.message : "Không chép được ca."); }
    finally {
      setData((current) => current ? { ...current, shifts: [...current.shifts, ...added] } : current);
      setSaving(false);
    }
  }

  // ---------------------------------------------------------------- kết sổ

  const closeStore = storeScope;
  const lines = useMemo(() => data && closeStore !== "all" ? payrollLines(data, month, closeStore) : [], [data, month, closeStore]);
  const closeAmounts = lines.map((line) => line.baseAmount + parseAmount(closeLines.find((entry) => entry.staffId === line.staffId)?.bonus || ""));
  const closeTotal = closeAmounts.reduce((sum, value) => sum + value, 0);
  const monthEnd = monthBounds(month).end;
  const closingEarly = today < monthEnd;
  const manualSalary = (salaryRows || []).filter((row) => !row.payroll && (!row.storeId || row.storeId === closeStore));

  function openClose() {
    if (closeStore === "all") return;
    setCloseLines(lines.map((line) => ({ staffId: line.staffId, bonus: "" })));
    setCloseDate(monthEnd); setCloseEarlyOk(false); setFormError(""); setSalaryRows(undefined); setCloseOpen(true);
    loadSalaryExpenses(uatMode, month).then(setSalaryRows).catch(() => setSalaryRows([]));
  }
  async function confirmClose() {
    if (!data || saving || closeStore === "all") return;
    if (closingEarly && !closeEarlyOk) { setFormError("Tháng chưa hết: tích xác nhận kết sổ sớm trước."); return; }
    setSaving(true); setFormError("");
    try {
      const input = {
        month, storeId: closeStore, incurredOn: closeDate,
        lines: lines.map((line, index) => ({
          staffId: line.staffId, closingId: newId(), expenseId: newId(), bonus: parseAmount(closeLines.find((entry) => entry.staffId === line.staffId)?.bonus || ""), amount: closeAmounts[index],
          note: `Từ Chấm công: ${line.rates.map((rate) => `${formatMinutes(rate.minutes)} × ${rateLabel(rate.rate)}`).join(" + ") || "không có giờ làm"}${parseAmount(closeLines.find((entry) => entry.staffId === line.staffId)?.bonus || "") ? ` + thưởng ${rateLabel(parseAmount(closeLines.find((entry) => entry.staffId === line.staffId)!.bonus))}` : ""} · ${line.shiftCount} ca${line.violations ? ` · ${line.violations} vi phạm` : ""}`,
        })),
      };
      const booked = await closePayroll(uatMode, input, memberName);
      const rows = booked.filter((closing) => closing.expenseId).length;
      await reload();
      setCloseOpen(false);
      setNotice({ text: `Đã kết sổ ${storeName(closeStore)} · tháng ${monthLabel(month)}: ${rows} dòng chi phí, tổng ${money(closeTotal)}, ghi vào Tài chính › Chi phí vận hành › Lương nhân viên.`, finance: rows > 0 });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Kết sổ không thành công.");
    } finally { setSaving(false); }
  }

  const closedNow: PayrollClosing[] = data && closeStore !== "all" ? closedFor(data.closings, month, closeStore) : [];
  function openReopen() {
    setFormError(""); setPaidPayroll(undefined); setReopenOpen(true);
    loadPayrollExpenses(uatMode, closedNow.flatMap((closing) => closing.expenseId ? [closing.expenseId] : [])).then((rows) => setPaidPayroll(rows.filter((row) => row.paid))).catch(() => setPaidPayroll([]));
  }
  async function confirmReopen() {
    if (saving || closeStore === "all") return;
    setSaving(true); setFormError("");
    try {
      await reopenPayroll(uatMode, month, closeStore);
      await reload();
      setReopenOpen(false);
      setNotice({ text: `Đã mở lại sổ ${storeName(closeStore)} · tháng ${monthLabel(month)}. Các dòng lương cũ trong Tài chính chuyển sang "đã huỷ"; sửa ca xong thì kết sổ lại.` });
    } catch (error) { setFormError(error instanceof Error ? error.message : "Mở lại sổ không thành công."); }
    finally { setSaving(false); }
  }

  async function updateMember(member: StaffMember, change: Partial<StaffMember>) {
    if (!data) return;
    const next = { ...member, ...change, name: change.name !== undefined ? cleanName(change.name) : member.name };
    if (!next.name) return;
    if (members.some((other) => other.id !== member.id && nameKey(other.name) === nameKey(next.name))) { setFormError(`Đã có nhân viên tên "${next.name}".`); return; }
    try {
      const saved = await saveStaffMember(uatMode, next);
      setData({ ...data, members: data.members.map((entry) => entry.id === saved.id ? saved : entry) });
      setFormError("");
    } catch (error) { setFormError(error instanceof Error ? error.message : "Không lưu được nhân viên."); }
  }

  // ---------------------------------------------------------------- render

  const hero = <section className={styles.hero}>
    <span className={styles.eyebrow}>NHA COFFEE & TEA · CHẤM CÔNG{multiOutlet ? ` · ${storeScope === "all" ? "TOÀN CHUỖI" : storeName(storeScope).toLocaleUpperCase("vi")}` : ""}</span>
    <h1>Chấm công</h1>
    <p>Bấm vào ngày để ghi ca. Kết sổ cuối tháng đưa lương sang Tài chính › Chi phí vận hành › Lương nhân viên.</p>
  </section>;

  if (status === "not-ready") return <div className={styles.staff}>{hero}<div className={styles.body}><div className={styles.notReady}><b>Chấm công chưa bật trên Production</b><p>Đang chờ migration <code>20261111000100</code> (bảng nhân viên, ca làm, kết sổ). Tài chính và Kho NVL không bị ảnh hưởng.</p></div></div></div>;
  if (status === "error") return <div className={styles.staff}>{hero}<div className={styles.body}><div className={styles.notReady}><b>Không tải được dữ liệu chấm công</b><p>{loadError}</p><button type="button" className={styles.ghostButton} onClick={() => { setStatus("loading"); void reload(); }}>Thử lại</button></div></div></div>;
  if (status === "loading" || !data) return <div className={styles.staff}>{hero}<div className={styles.body}><p className={styles.muted}>Đang tải chấm công…</p></div></div>;

  const { start: monthStart, days } = monthBounds(month);
  const leading = (weekdayOf(monthStart) + 6) % 7;
  const daysOfMonth = Array.from({ length: days }, (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`);
  const dayShifts = (date: string) => data.shifts.filter((shift) => shift.workDate === date && inScope(shift)).sort((left, right) => (left.checkIn || "99").localeCompare(right.checkIn || "99"));
  const yearChoices = Array.from({ length: 4 }, (_, index) => Number(today.slice(0, 4)) - 2 + index);
  const monthChoices = Array.from({ length: 18 }, (_, index) => { const date = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 13 + index, 1)); return date.toISOString().slice(0, 7); }).reverse();
  const tableRows = [...summaries.values()].sort((left, right) => memberName(left.staffId).localeCompare(memberName(right.staffId), "vi"));

  return <div className={styles.staff}>
    {hero}
    {uatMode && <div className={styles.uatBanner}><b>UAT LOCAL</b> · Dữ liệu chấm công chỉ lưu trong trình duyệt này.</div>}
    <section className={styles.periodPanel}>
      <div className={styles.periodModes}>{(["month", "quarter", "year"] as PeriodMode[]).map((mode) => <button type="button" className={periodMode === mode ? styles.selected : ""} key={mode} onClick={() => setPeriodMode(mode)}>{mode === "month" ? "Tháng" : mode === "quarter" ? "Quý" : "Năm"}</button>)}</div>
      <div className={styles.periodPicker}>
        {periodMode === "month" ? <select aria-label="Tháng" value={month} onChange={(event) => setMonth(event.target.value)}>{(monthChoices.includes(month) ? monthChoices : [month, ...monthChoices]).map((value) => <option value={value} key={value}>Tháng {monthLabel(value)}</option>)}</select>
          : <><select aria-label="Năm" value={year} onChange={(event) => setYear(Number(event.target.value))}>{yearChoices.map((value) => <option key={value}>{value}</option>)}</select>{periodMode === "quarter" && <select aria-label="Quý" value={quarter} onChange={(event) => setQuarter(Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option value={value} key={value}>Quý {value}</option>)}</select>}</>}
      </div>
      {multiOutlet && <div className={styles.storeChips} role="tablist" aria-label="Điểm bán">{outlets.map((store, index) => <button type="button" role="tab" aria-selected={storeScope === store.id} className={storeScope === store.id ? styles.selected : ""} key={store.id} onClick={() => setScope(store.id)}>N{index + 1} · {store.name.replace(/^N\d+\s*-\s*/, "")}</button>)}<button type="button" role="tab" aria-selected={storeScope === "all"} className={storeScope === "all" ? styles.selected : ""} onClick={() => setScope("all")}>Toàn chuỗi</button></div>}
    </section>

    <div className={styles.body}>
      {notice && <div className={styles.notice}><span>{notice.text}</span><div>{notice.finance && <button type="button" className={styles.ghostButton} onClick={onOpenFinance}>Mở Tài chính</button>}<button type="button" aria-label="Đóng thông báo" className={styles.iconButton} onClick={() => setNotice(undefined)}>×</button></div></div>}

      <div className={styles.kpis}>
        <article><span>Tổng giờ</span><strong>{formatMinutes(totals.minutes)}</strong><small>{totals.shifts} ca · {periodLabel}</small></article>
        <article className={styles.kpiMain}><span>Phải trả</span><strong>{money(totals.amount)}</strong><small>{periodMode === "month" ? storeScope === "all" ? `${monthStatus(month).closed}/${monthStatus(month).withShifts} điểm bán đã kết sổ` : closedHere ? "đã kết sổ" : "tạm tính, chưa kết sổ" : `${months.filter((value) => { const state = monthStatus(value); return state.withShifts && state.closed === state.withShifts; }).length}/${months.filter((value) => monthStatus(value).withShifts).length} tháng đã kết sổ`}</small></article>
        <article><span>Vi phạm</span><strong>{totals.violations} lần</strong><small>{reasonTally.length ? reasonTally.slice(0, 3).map(([label, count]) => `${count} ${label.toLocaleLowerCase("vi")}`).join(" · ") : "không có"}</small></article>
        <article><span>Chuyên cần TB</span><strong>{scoreText(totals.score)}<em>/{FULL_SCORE}</em></strong><small>trung bình theo ca</small></article>
      </div>

      {periodMode === "month" ? <section className={styles.calendarBlock}>
        <div className={styles.blockHead}>
          <div><h2>Tháng {monthLabel(month)}</h2>{storeScope !== "all" && closedHere && <span className={styles.lockPill}>Đã kết sổ</span>}</div>
          <div className={styles.headActions}>
            <button type="button" className={styles.ghostButton} onClick={() => setMembersOpen(true)}>Nhân viên</button>
            {storeScope === "all" ? <span className={styles.hint}>Chọn một điểm bán để kết sổ</span> : closedHere ? <button type="button" className={styles.ghostButton} onClick={openReopen}>Mở lại sổ T{monthLabel(month)}</button> : <button type="button" className={styles.primary} disabled={!lines.length} onClick={openClose}>Kết sổ T{monthLabel(month)}</button>}
          </div>
        </div>
        <div className={styles.calendar}>
          {WEEKDAYS.map((label) => <div className={styles.weekday} key={label}>{label}</div>)}
          {Array.from({ length: leading }, (_, index) => <div className={styles.blank} key={`b${index}`} />)}
          {daysOfMonth.map((date) => {
            const list = dayShifts(date);
            const minutes = list.reduce((sum, shift) => sum + shiftMinutes(shift), 0);
            const locked = list.length > 0 && list.every((shift) => shiftLocked(shift));
            return <button type="button" key={date} className={`${styles.day} ${date === today ? styles.today : ""} ${date > today ? styles.future : ""}`} onClick={() => openDay(date)} aria-label={`Ngày ${dateLabel(date)}: ${list.length} ca`}>
              <span className={styles.dayHead}><b>{Number(date.slice(8))}</b>{minutes > 0 && <small>{formatHours(minutes)}</small>}{locked && <i className={styles.lockDot} title="Đã kết sổ" />}</span>
              {list.slice(0, 4).map((shift) => <span key={shift.id} className={`${styles.chip} ${shift.violations.length ? styles.chipViolation : ""} ${shift.absent ? styles.chipAbsent : ""}`}><i style={{ background: colorOf(shift.staffId) }} />{shorts.get(shift.staffId) || "?"}{storeScope === "all" && multiOutlet ? ` · ${storeShort(shift.storeId)}` : ""} {shift.absent ? "vắng" : formatHours(shiftMinutes(shift))}</span>)}
              {list.length > 4 && <span className={styles.more}>+{list.length - 4} ca</span>}
              <span className={styles.dots}>{list.map((shift) => <i key={shift.id} className={shift.violations.length ? styles.dotViolation : ""} style={{ background: colorOf(shift.staffId) }} />)}</span>
            </button>;
          })}
        </div>
        <div className={styles.legend}>{members.filter((member) => periodShifts.some((shift) => shift.staffId === member.id)).map((member) => <span key={member.id}><i style={{ background: colorOf(member.id) }} />{member.name}</span>)}<span><i className={styles.legendViolation} />Có vi phạm</span></div>
      </section> : <section className={styles.monthStrip}>
        {months.map((value) => {
          const shifts = (data.shifts || []).filter((shift) => monthOf(shift.workDate) === value && inScope(shift));
          const state = monthStatus(value);
          const amount = [...summarize(shifts, data.closings.filter((closing) => closing.month === value && (storeScope === "all" || closing.storeId === storeScope))).values()].reduce((sum, entry) => sum + entry.amount, 0);
          return <button type="button" key={value} className={styles.monthCard} onClick={() => { setMonth(value); setPeriodMode("month"); }}>
            <b>Tháng {monthLabel(value)}</b>
            <span>{formatMinutes(shifts.reduce((sum, shift) => sum + shiftMinutes(shift), 0))} · {shifts.filter((shift) => !shift.absent).length} ca</span>
            <strong>{money(amount)}</strong>
            <em className={state.withShifts && state.closed === state.withShifts ? styles.closedText : ""}>{!state.withShifts ? "Chưa có ca" : state.closed === state.withShifts ? "Đã kết sổ" : state.closed ? `${state.closed}/${state.withShifts} điểm đã kết sổ` : "Chưa kết sổ"}</em>
          </button>;
        })}
      </section>}

      <section className={styles.tableBlock}>
        <div className={styles.blockHead}><div><h2>Tổng hợp {periodLabel.toLocaleLowerCase("vi")}</h2></div></div>
        {tableRows.length ? <div className={styles.tableWrap}><table className={styles.table}>
          <thead><tr><th>Nhân viên</th><th className={styles.num}>Ca</th><th className={styles.num}>Tổng giờ</th><th className={styles.num}>Vi phạm</th><th className={styles.num}>Chuyên cần TB</th><th className={styles.num}>Phải trả</th><th>Sổ</th></tr></thead>
          <tbody>{tableRows.map((row) => {
            const average = averageScore(row);
            const personMonths = months.filter((value) => periodShifts.some((shift) => shift.staffId === row.staffId && monthOf(shift.workDate) === value));
            const closedMonths = personMonths.filter((value) => scopeStores.filter((id) => periodShifts.some((shift) => shift.staffId === row.staffId && shift.storeId === id && monthOf(shift.workDate) === value)).every((id) => (data.closings || []).some((closing) => closing.status === "closed" && closing.month === value && closing.storeId === id && closing.staffId === row.staffId)));
            return <tr key={row.staffId}>
              <td><span className={styles.who}><i style={{ background: colorOf(row.staffId) }} />{memberName(row.staffId)}</span></td>
              <td className={styles.num}>{row.shiftCount}{row.absences ? <small> +{row.absences} vắng</small> : null}</td>
              <td className={styles.num}>{formatMinutes(row.minutes)}</td>
              <td className={styles.num}>{row.violations}</td>
              <td className={styles.num}><span className={`${styles.score} ${average !== undefined && average < 9 ? styles.scoreLow : ""}`}>{scoreText(average)}</span></td>
              <td className={styles.num}><b>{money(row.amount)}</b></td>
              <td>{periodMode === "month" ? <span className={closedMonths.length ? styles.closedPill : styles.openPill}>{closedMonths.length ? "Đã kết sổ" : "Chưa kết sổ"}</span> : <span className={styles.openPill}>{closedMonths.length}/{personMonths.length} tháng</span>}</td>
            </tr>;
          })}</tbody>
          <tfoot><tr><td>Cộng</td><td className={styles.num}>{totals.shifts}</td><td className={styles.num}>{formatMinutes(totals.minutes)}</td><td className={styles.num}>{totals.violations}</td><td className={styles.num}>{scoreText(totals.score)}</td><td className={styles.num}>{money(totals.amount)}</td><td /></tr></tfoot>
        </table></div> : <p className={styles.empty}>{periodLabel} chưa có ca nào{storeScope !== "all" && multiOutlet ? ` ở ${storeName(storeScope)}` : ""}. Bấm vào một ngày trên lịch để ghi ca đầu tiên.</p>}
        <p className={styles.footnote}>Phải trả = giờ thực tế × đơn giá của từng ca, cộng thưởng khi kết sổ. Vi phạm chỉ trừ điểm chuyên cần (mỗi ca {FULL_SCORE} điểm), không trừ tiền.</p>
      </section>
    </div>

    {selectedDay && <div className={styles.backdrop} role="presentation" onMouseDown={() => !saving && setSelectedDay(undefined)}>
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label={`Ca ngày ${dateLabel(selectedDay)}`} onMouseDown={(event) => event.stopPropagation()}>
        <div className={styles.sheetHandle} />
        <div className={styles.sheetTitle}><div><span>{WEEKDAY_NAMES[weekdayOf(selectedDay)].toLocaleUpperCase("vi")}</span><h2>{dateLabel(selectedDay)}{storeScope !== "all" && multiOutlet ? ` · ${storeShort(storeScope)}` : ""}</h2></div><button type="button" aria-label="Đóng" disabled={saving} onClick={() => setSelectedDay(undefined)}>×</button></div>
        {(() => {
          const list = dayShifts(selectedDay);
          const previous = data.shifts.filter((shift) => shift.workDate === addDays(selectedDay, -1) && !shift.absent && inScope(shift));
          const allLocked = scopeStores.every((id) => isMonthClosed(data.closings, monthOf(selectedDay), id));
          return <>
            {list.length ? <div className={styles.shiftList}>{list.map((shift) => {
              const locked = shiftLocked(shift);
              return <button type="button" key={shift.id} className={`${styles.shiftRow} ${draft?.id === shift.id ? styles.shiftRowActive : ""}`} disabled={locked || saving} onClick={() => startShift(selectedDay, shift)} title={locked ? "Tháng đã kết sổ — Mở lại sổ để sửa" : "Sửa ca"}>
                <span className={styles.shiftMain}>
                  <span className={styles.who}><i style={{ background: colorOf(shift.staffId) }} />{memberName(shift.staffId)}{multiOutlet && storeScope === "all" ? <em>{storeShort(shift.storeId)}</em> : null}</span>
                  <span className={styles.shiftTimes}>{shift.absent ? "Vắng" : `${shift.checkIn}–${shift.checkOut}${isOvernight(shift) ? " (+1)" : ""}${shift.breakMinutes ? ` · nghỉ ${shift.breakMinutes}'` : ""}`} {shift.violations.map((entry) => <i key={entry.label} className={styles.violationTag}>{entry.label}{entry.count > 1 ? ` ×${entry.count}` : ""} −{entry.points * entry.count}</i>)}</span>
                </span>
                <b>{shift.absent ? "—" : money(shiftPay(shift))}</b>
                <small>{shift.absent ? `${countsForScore(shift) ? `${shiftScore(shift)}/${FULL_SCORE} điểm` : "nghỉ có báo"}` : `${formatMinutes(shiftMinutes(shift))} × ${rateLabel(shift.hourlyRate)} · ${shiftScore(shift)}/${FULL_SCORE}`}{locked ? " · đã kết sổ" : ""}</small>
              </button>;
            })}</div> : <p className={styles.muted}>Chưa có ca nào ngày này.</p>}
            {!draft && !allLocked && <div className={styles.sheetActions}>
              {!list.length && previous.length > 0 && <button type="button" className={styles.ghostButton} disabled={saving} onClick={() => void copyPreviousDay(selectedDay)}>Chép {previous.length} ca hôm trước</button>}
              <button type="button" className={styles.primary} disabled={saving} onClick={() => startShift(selectedDay)}>+ Thêm ca</button>
            </div>}
            {allLocked && !draft && <p className={styles.lockNote}>Tháng {monthLabel(monthOf(selectedDay))} đã kết sổ. Muốn thêm hoặc sửa ca: đóng khung này, bấm Mở lại sổ.</p>}
            {formError && !draft && <p className={styles.error} role="alert">{formError}</p>}
          </>;
        })()}

        {draft && <form className={styles.shiftForm} onSubmit={saveDraft}>
          <h3>{draft.isNew ? "Ca mới" : "Sửa ca"}</h3>
          <div className={styles.field}><span>Nhân viên</span>
            <div className={styles.choices}>
              {members.filter((member) => member.status === "active" || member.id === draft.staffId).map((member) => <button type="button" key={member.id} className={draft.staffId === member.id && !draft.newName ? styles.choiceOn : ""} onClick={() => pickMember(member.id)}>{member.name}</button>)}
              <button type="button" className={`${styles.choiceAdd} ${draft.newName !== "" || (!draft.staffId && !members.length) ? styles.choiceOn : ""}`} onClick={() => setDraft({ ...draft, staffId: "", newName: draft.newName || " " })}>+ Người mới</button>
            </div>
            {(draft.newName !== "" || (!members.length && !draft.staffId)) && <input id="staff-new-name" autoFocus placeholder="Tên nhân viên (nhập một lần, lần sau chỉ chọn)" value={draft.newName.trimStart()} onChange={(event) => setDraft({ ...draft, staffId: "", newName: event.target.value || " " })} />}
          </div>
          {dayStores(draft.workDate).length > 1 && <div className={styles.field}><span>Điểm bán</span><div className={styles.choices}>{dayStores(draft.workDate).map((store) => <button type="button" key={store.id} disabled={isMonthClosed(data.closings, monthOf(draft.workDate), store.id)} className={draft.storeId === store.id ? styles.choiceOn : ""} onClick={() => setDraft({ ...draft, storeId: store.id })}>{storeShort(store.id)} · {store.name.replace(/^N\d+\s*-\s*/, "")}</button>)}</div></div>}
          <label className={styles.toggle}><input type="checkbox" checked={draft.absent} onChange={(event) => setDraft({ ...draft, absent: event.target.checked })} />Vắng ngày này (không làm)</label>
          {!draft.absent && <>
            <div className={styles.timeRow}>
              <label>Giờ đến<input type="time" step={300} value={draft.checkIn} onChange={(event) => setDraft({ ...draft, checkIn: event.target.value })} required /></label>
              <label>Giờ về<input type="time" step={300} value={draft.checkOut} onChange={(event) => setDraft({ ...draft, checkOut: event.target.value })} required /></label>
              <label>Nghỉ giữa ca (phút)<input type="number" min={0} step={5} inputMode="numeric" value={draft.breakMinutes} onChange={(event) => setDraft({ ...draft, breakMinutes: event.target.value })} /></label>
            </div>
            <div className={styles.field}><span>Đơn giá / giờ</span>
              <div className={styles.choices}>
                {rememberedRates(data).map((rate) => <button type="button" key={rate} className={!draft.customRate && parseAmount(draft.rate) === rate ? styles.choiceOn : ""} onClick={() => setDraft({ ...draft, rate: amountInput(String(rate)), customRate: false })}>{rateLabel(rate)}</button>)}
                <button type="button" className={`${styles.choiceAdd} ${draft.customRate || !rememberedRates(data).length ? styles.choiceOn : ""}`} onClick={() => setDraft({ ...draft, customRate: true, rate: "" })}>+ Giá khác</button>
              </div>
              {(draft.customRate || !rememberedRates(data).length) && <input id="staff-rate" inputMode="numeric" placeholder="Ví dụ 25,000 (đồng / giờ)" value={draft.rate} onChange={(event) => setDraft({ ...draft, rate: amountInput(event.target.value) })} />}
            </div>
          </>}
          <div className={styles.field}><span>Vi phạm · chỉ trừ điểm chuyên cần</span>
            <div className={styles.choices}>
              {data.reasons.map((reason) => { const picked = draft.violations.find((entry) => (entry.reasonId || entry.label) === reason.id || entry.label === reason.label); return <span key={reason.id} className={`${styles.reasonChip} ${picked ? styles.reasonOn : ""}`}>
                <button type="button" onClick={() => toggleReason(reason, 1)}>{reason.label} −{reason.points}{picked && picked.count > 1 ? ` ×${picked.count}` : ""}</button>
                {picked && <button type="button" aria-label={`Bớt ${reason.label}`} className={styles.reasonMinus} onClick={() => toggleReason(reason, -1)}>−</button>}
              </span>; })}
              {!newReason && <button type="button" className={styles.choiceAdd} onClick={() => setNewReason({ label: "", points: String(DEFAULT_REASON_POINTS) })}>+ Lý do mới</button>}
            </div>
            {newReason && <div className={styles.newReason}><input id="staff-reason-label" autoFocus placeholder="Lý do (ví dụ: Không mặc đồng phục)" value={newReason.label} onChange={(event) => setNewReason({ ...newReason, label: event.target.value })} /><label>Trừ<input id="staff-reason-points" inputMode="decimal" value={newReason.points} onChange={(event) => setNewReason({ ...newReason, points: event.target.value })} />điểm</label><button type="button" className={styles.ghostButton} onClick={() => void addReason()}>Thêm</button><button type="button" className={styles.iconButton} aria-label="Bỏ lý do mới" onClick={() => setNewReason(undefined)}>×</button></div>}
          </div>
          <label className={styles.noteField}>Ghi chú<input id="staff-note" value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="Không bắt buộc" /></label>
          {draftPreview && <div className={styles.result}>
            {draftPreview.absent ? <b>Vắng · không tính tiền</b> : <b>{formatMinutes(Math.max(0, shiftMinutes(draftPreview)))} × {rateLabel(draftPreview.hourlyRate)} = {money(Math.max(0, shiftPay(draftPreview)))}</b>}
            <span>{countsForScore(draftPreview) ? `Chuyên cần ca này: ${shiftScore(draftPreview)}/${FULL_SCORE}${violationCount(draftPreview) ? ` (${violationCount(draftPreview)} vi phạm)` : ""}` : "Nghỉ có báo: không tính ca, không tính điểm"}</span>
          </div>}
          {draftCheck?.warnings.map((warning) => <p key={warning} className={styles.warning}>{warning}</p>)}
          {(formError || (draftCheck?.errors.length && (draft.checkIn || draft.checkOut || draft.absent) ? draftCheck.errors[0] : "")) && <p className={styles.error} role="alert">{formError || draftCheck!.errors[0]}</p>}
          <div className={styles.sheetActions}>
            {!draft.isNew && <button type="button" className={styles.dangerButton} disabled={saving} onClick={() => void removeDraftShift()}>Xoá ca</button>}
            <button type="button" className={styles.ghostButton} disabled={saving} onClick={() => { setDraft(undefined); setFormError(""); }}>Huỷ</button>
            <button type="submit" className={styles.primary} disabled={saving}>{saving ? "Đang lưu…" : "Lưu ca"}</button>
          </div>
        </form>}
      </div>
    </div>}

    {closeOpen && closeStore !== "all" && <div className={styles.backdrop} role="presentation" onMouseDown={() => !saving && setCloseOpen(false)}>
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Kết sổ lương" onMouseDown={(event) => event.stopPropagation()}>
        <div className={styles.sheetHandle} />
        <div className={styles.sheetTitle}><div><span>KẾT SỔ LƯƠNG</span><h2>Tháng {monthLabel(month)} · {storeName(closeStore)}</h2></div><button type="button" aria-label="Đóng" disabled={saving} onClick={() => setCloseOpen(false)}>×</button></div>
        <div className={styles.calc}>
          {lines.map((line, index) => <div key={line.staffId}>
            <span className={styles.who}><i style={{ background: colorOf(line.staffId) }} />{line.name}</span>
            <b className={styles.calcAmount}>{money(closeAmounts[index])}</b>
            <small>{line.rates.map((rate) => `${formatMinutes(rate.minutes)} × ${rateLabel(rate.rate)}`).join(" + ") || "không có giờ làm"} = {money(line.baseAmount)} · {line.shiftCount} ca{line.absences ? ` · ${line.absences} ngày vắng` : ""}{line.violations ? ` · ${line.violations} vi phạm (chỉ trừ điểm)` : ""}</small>
            <label className={styles.bonus}>Thưởng<input inputMode="numeric" placeholder="0" value={closeLines.find((entry) => entry.staffId === line.staffId)?.bonus || ""} onChange={(event) => setCloseLines((current) => current.map((entry) => entry.staffId === line.staffId ? { ...entry, bonus: amountInput(event.target.value) } : entry))} /></label>
          </div>)}
          <div className={styles.calcTotal}><span>Tổng chi phí lương</span><b className={styles.calcAmount}>{money(closeTotal)}</b><small>{formatMinutes(lines.reduce((sum, line) => sum + line.minutes, 0))} · {lines.reduce((sum, line) => sum + line.shiftCount, 0)} ca</small></div>
        </div>
        <div className={styles.path}><em>Sẽ ghi vào</em><span>Tài chính</span><em>›</em><span>Ghi nhận chi phí</span><em>›</em><span>Chi phí vận hành</span><em>›</em><span className={styles.pathEnd}>Lương nhân viên</span></div>
        <div className={styles.dateChoice}>
          <span>Ngày ghi nhận chi phí</span>
          <div className={styles.choices}>
            <button type="button" className={closeDate === monthEnd ? styles.choiceOn : ""} onClick={() => setCloseDate(monthEnd)}>{dateLabel(monthEnd)} · cuối tháng làm việc</button>
            <button type="button" className={closeDate === addDays(monthEnd, 5) ? styles.choiceOn : ""} onClick={() => setCloseDate(addDays(monthEnd, 5))}>{dateLabel(addDays(monthEnd, 5))} · ngày trả như trước</button>
            <DateField id="staff-close-date" value={closeDate} onChange={setCloseDate} />
          </div>
          <small>Ngày này quyết định lương nằm trong lợi nhuận tháng nào. {closeDate > monthEnd ? `Chọn ${dateLabel(closeDate)}: lương tháng ${monthLabel(month)} vào P&L tháng ${monthLabel(monthOf(closeDate))}, giống cách ghi tay lâu nay.` : `Chọn ${dateLabel(closeDate)}: lương tháng ${monthLabel(month)} vào P&L tháng ${monthLabel(month)}.`}</small>
        </div>
        <ol className={styles.steps}>
          <li><b>{closeAmounts.filter((amount) => amount > 0).length} dòng chi phí</b>, mỗi người 1 dòng, ghi cho {storeName(closeStore)}. Tên dòng: “Lương T{monthLabel(month)} · {lines[0]?.name || "…"}”.</li>
          <li><b>Trạng thái Chưa thanh toán.</b> Trả lương xong thì mở dòng đó trong Tài chính, chọn Đã thanh toán, ngày trả và ảnh chuyển khoản. Tiền vào Dòng tiền đúng ngày trả.</li>
          <li><b>Các ca tháng {monthLabel(month)} ở điểm bán này bị khoá.</b> Muốn sửa thì bấm Mở lại sổ: các dòng chi phí chuyển sang “đã huỷ” (không xoá), sửa ca xong kết sổ lại.</li>
        </ol>
        {salaryRows === undefined ? <p className={styles.muted}>Đang kiểm tra chi phí lương đã có trong Tài chính…</p> : manualSalary.length > 0 && <div className={styles.alert}><b>Tháng {monthLabel(month)} đã có {manualSalary.length} dòng lương nhập tay</b>{manualSalary.map((row) => <span key={row.id}>{row.name} · {dateLabel(row.incurredOn)} · {money(row.amount)}{row.storeId ? "" : " · Toàn chuỗi"}</span>)}<span>Nếu đó là lương tháng trước thì tháng {monthLabel(month)} sẽ có 2 tháng lương. Chọn ngày ghi nhận {dateLabel(addDays(monthEnd, 5))} để giữ cách ghi cũ.</span></div>}
        {closingEarly && <label className={`${styles.alert} ${styles.alertCheck}`}><b>Tháng {monthLabel(month)} chưa hết</b><span>Còn {dateLabel(today > monthStart ? addDays(today, 1) : monthStart)} → {dateLabel(monthEnd)} chưa chấm. Kết sổ bây giờ khoá cả tháng ở điểm bán này: ca của những ngày còn lại chỉ thêm được sau khi Mở lại sổ.</span><span className={styles.checkLine}><input type="checkbox" checked={closeEarlyOk} onChange={(event) => setCloseEarlyOk(event.target.checked)} />Vẫn kết sổ sớm (ví dụ nhân viên nghỉ việc giữa tháng)</span></label>}
        {formError && <p className={styles.error} role="alert">{formError}</p>}
        <div className={styles.sheetActions}>
          <button type="button" className={styles.ghostButton} disabled={saving} onClick={() => setCloseOpen(false)}>Huỷ</button>
          <button type="button" className={styles.primary} disabled={saving || !lines.length || (closingEarly && !closeEarlyOk)} onClick={() => void confirmClose()}>{saving ? "Đang kết sổ…" : `Kết sổ & ghi ${closeAmounts.filter((amount) => amount > 0).length} dòng chi phí`}</button>
        </div>
      </div>
    </div>}

    {reopenOpen && closeStore !== "all" && <div className={styles.backdrop} role="presentation" onMouseDown={() => !saving && setReopenOpen(false)}>
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Mở lại sổ" onMouseDown={(event) => event.stopPropagation()}>
        <div className={styles.sheetHandle} />
        <div className={styles.sheetTitle}><div><span>MỞ LẠI SỔ</span><h2>Tháng {monthLabel(month)} · {storeName(closeStore)}</h2></div><button type="button" aria-label="Đóng" disabled={saving} onClick={() => setReopenOpen(false)}>×</button></div>
        <ol className={styles.steps}>
          <li><b>{closedNow.filter((closing) => closing.expenseId).length} dòng lương</b> ({money(closedNow.reduce((sum, closing) => sum + closing.amount, 0))}) trong Tài chính chuyển sang “đã huỷ”: không còn trong P&L, nhưng vẫn giữ lại để tra.</li>
          <li>Các ca tháng {monthLabel(month)} ở điểm bán này mở khoá, sửa được.</li>
          <li>Sửa xong, bấm Kết sổ lại để tạo dòng lương mới.</li>
        </ol>
        {paidPayroll === undefined ? <p className={styles.muted}>Đang kiểm tra trạng thái thanh toán…</p> : paidPayroll.length > 0 && <div className={styles.alert}><b>{paidPayroll.length} dòng đã đánh dấu Đã thanh toán</b>{paidPayroll.map((row) => <span key={row.id}>{row.name} · {money(row.amount)}</span>)}<span>Sau khi kết sổ lại, nhớ đánh dấu Đã thanh toán (và gắn lại ảnh chuyển khoản) cho dòng mới.</span></div>}
        {formError && <p className={styles.error} role="alert">{formError}</p>}
        <div className={styles.sheetActions}>
          <button type="button" className={styles.ghostButton} disabled={saving} onClick={() => setReopenOpen(false)}>Huỷ</button>
          <button type="button" className={styles.dangerButton} disabled={saving} onClick={() => void confirmReopen()}>{saving ? "Đang mở lại…" : "Mở lại sổ"}</button>
        </div>
      </div>
    </div>}

    {membersOpen && <div className={styles.backdrop} role="presentation" onMouseDown={() => setMembersOpen(false)}>
      <div className={styles.sheet} role="dialog" aria-modal="true" aria-label="Nhân viên" onMouseDown={(event) => event.stopPropagation()}>
        <div className={styles.sheetHandle} />
        <div className={styles.sheetTitle}><div><span>DANH SÁCH</span><h2>Nhân viên</h2></div><button type="button" aria-label="Đóng" onClick={() => setMembersOpen(false)}>×</button></div>
        {members.length ? <div className={styles.memberList}>{members.map((member) => <div key={member.id} className={member.status === "inactive" ? styles.memberInactive : ""}>
          <input aria-label={`Tên ${member.name}`} defaultValue={member.name} onBlur={(event) => { if (cleanName(event.target.value) !== member.name) void updateMember(member, { name: event.target.value }); }} />
          <small>{member.defaultRate ? `${rateLabel(member.defaultRate)}/giờ` : "chưa có đơn giá"}</small>
          <button type="button" className={styles.ghostButton} onClick={() => void updateMember(member, { status: member.status === "active" ? "inactive" : "active" })}>{member.status === "active" ? "Đã nghỉ việc" : "Làm lại"}</button>
        </div>)}</div> : <p className={styles.muted}>Chưa có nhân viên. Tên được thêm khi ghi ca đầu tiên.</p>}
        <p className={styles.footnote}>Người “Đã nghỉ việc” không hiện trong danh sách chọn khi ghi ca mới; ca cũ vẫn giữ nguyên. Sửa tên ở đây đổi tên ở mọi ca, còn tên trên dòng lương đã kết sổ giữ nguyên.</p>
        {formError && <p className={styles.error} role="alert">{formError}</p>}
      </div>
    </div>}
  </div>;
}

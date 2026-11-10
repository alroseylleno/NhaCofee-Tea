// Chấm công: pure rules for shifts, pay and attendance score, shared by the UI,
// the UAT store and the tests. Production holds the same rules in SQL
// (migration 20261111000100): shift minutes are a generated column and
// close_staff_payroll recomputes pay from the shifts, so every rule here must
// match its SQL twin exactly.

export type StaffMember = { id: string; name: string; defaultRate: number; defaultStoreId?: string; status: "active" | "inactive" };
export type ViolationReason = { id: string; label: string; points: number };
/// Label and points are a snapshot: editing a reason later changes no past score.
export type ShiftViolation = { reasonId?: string; label: string; points: number; count: number };
export type StaffShift = {
  id: string; staffId: string; storeId: string; workDate: string;
  /// A day off recorded with its reason: no hours, no pay.
  absent: boolean; checkIn?: string; checkOut?: string; breakMinutes: number;
  /// The rate the shift was worked at, so a raise never rewrites a past month.
  hourlyRate: number; violations: ShiftViolation[]; note?: string;
  payrollClosingId?: string;
};
export type PayrollClosing = {
  id: string; month: string; storeId: string; staffId: string; shiftCount: number; minutes: number;
  baseAmount: number; bonus: number; amount: number; expenseId?: string; incurredOn: string;
  status: "closed" | "reopened"; closedAt: string; reopenedAt?: string;
};
export type StaffState = { members: StaffMember[]; reasons: ViolationReason[]; shifts: StaffShift[]; closings: PayrollClosing[] };

export const PAYROLL_SUBCATEGORY = "Lương nhân viên";
export const FULL_SCORE = 10;
export const DEFAULT_REASON_POINTS = 2;
export const SEED_REASONS: ViolationReason[] = [
  { id: "vi-pham-di-tre", label: "Đi trễ", points: 2 },
  { id: "vi-pham-ve-som", label: "Về sớm", points: 2 },
  { id: "vi-pham-vang-khong-bao", label: "Vắng không báo", points: 10 },
];

/// "Tự nhớ" compares names the way the database's unique index does
/// (lower(btrim(name))), after folding NFD to NFC — macOS and some keyboards
/// type Vietnamese decomposed.
export function cleanName(value: string) { return value.normalize("NFC").replace(/\s+/g, " ").trim(); }
export function nameKey(value: string) { return cleanName(value).toLocaleLowerCase("vi"); }

export function timeToMinutes(value?: string) {
  const match = value?.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return undefined;
  const hours = Number(match[1]), minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}

/// Check-out earlier than check-in = past midnight; the shift belongs to the
/// day it started. Same formula as the generated column staff_shifts.minutes.
export function isOvernight(shift: Pick<StaffShift, "absent" | "checkIn" | "checkOut">) {
  const start = timeToMinutes(shift.checkIn), end = timeToMinutes(shift.checkOut);
  return !shift.absent && start !== undefined && end !== undefined && end < start;
}
export function shiftMinutes(shift: Pick<StaffShift, "absent" | "checkIn" | "checkOut" | "breakMinutes">) {
  if (shift.absent) return 0;
  const start = timeToMinutes(shift.checkIn), end = timeToMinutes(shift.checkOut);
  if (start === undefined || end === undefined) return 0;
  return end - start + (end < start ? 1440 : 0) - (shift.breakMinutes || 0);
}

export function violationCount(shift: Pick<StaffShift, "violations">) { return shift.violations.reduce((sum, entry) => sum + entry.count, 0); }
/// 10 − every violation's points × times, never below 0.
export function shiftScore(shift: Pick<StaffShift, "violations">) {
  return Math.max(0, FULL_SCORE - shift.violations.reduce((sum, entry) => sum + entry.points * entry.count, 0));
}
/// A day off with no violation is a permitted absence: it is neither a shift
/// nor a score. A day off with a violation ("Vắng không báo") is scored.
export function countsForScore(shift: Pick<StaffShift, "absent" | "violations">) { return !shift.absent || shift.violations.length > 0; }

/// Pay of a set of shifts: Σ (minutes × rate) ÷ 60, rounded to the đồng once
/// for the whole set — what close_staff_payroll computes with round() on
/// numeric. Integer arithmetic (rates are whole đồng) so a .5 never drifts.
export function payOf(shifts: StaffShift[]) {
  const total = shifts.reduce((sum, shift) => sum + shiftMinutes(shift) * Math.round(shift.hourlyRate), 0);
  return Math.floor((total + 30) / 60);
}
export function shiftPay(shift: StaffShift) { return payOf([shift]); }

export function monthOf(date: string) { return date.slice(0, 7); }
export function monthBounds(month: string) {
  const [year, monthNumber] = month.split("-").map(Number);
  const days = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(days).padStart(2, "0")}`, days };
}
export function monthLabel(month: string) { return `${month.slice(5, 7)}/${month.slice(0, 4)}`; }
/// The browser's own calendar day (Vietnam), not UTC: at 02:00 in Saigon
/// toISOString() still says yesterday.
export function localToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
export function addDays(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function formatMinutes(minutes: number) {
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  return rest ? `${hours} giờ ${String(rest).padStart(2, "0")}` : `${hours} giờ`;
}
export function formatHours(minutes: number) { return `${(minutes / 60).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}h`; }

export type StaffSummary = { staffId: string; shiftCount: number; absences: number; minutes: number; violations: number; scoreSum: number; scoreCount: number; amount: number };
/// Per person over the given shifts. Pay is rounded per person × month × store,
/// the unit close_staff_payroll books, so a quarter is the sum of its months.
export function summarize(shifts: StaffShift[], closings: PayrollClosing[] = []) {
  const byPerson = new Map<string, StaffSummary>();
  const units = new Map<string, StaffShift[]>();
  for (const shift of shifts) {
    const entry = byPerson.get(shift.staffId) || { staffId: shift.staffId, shiftCount: 0, absences: 0, minutes: 0, violations: 0, scoreSum: 0, scoreCount: 0, amount: 0 };
    if (shift.absent) entry.absences += 1; else entry.shiftCount += 1;
    entry.minutes += shiftMinutes(shift);
    entry.violations += violationCount(shift);
    if (countsForScore(shift)) { entry.scoreSum += shiftScore(shift); entry.scoreCount += 1; }
    byPerson.set(shift.staffId, entry);
    const unit = `${shift.staffId}|${monthOf(shift.workDate)}|${shift.storeId}`;
    units.set(unit, [...(units.get(unit) || []), shift]);
  }
  for (const [unit, unitShifts] of units) {
    const entry = byPerson.get(unit.split("|")[0])!;
    entry.amount += payOf(unitShifts);
  }
  // A closed month adds what was booked on top of the shifts: the bonus.
  for (const closing of closings) {
    if (closing.status !== "closed") continue;
    const entry = byPerson.get(closing.staffId);
    if (entry) entry.amount += closing.bonus;
  }
  return byPerson;
}
export function averageScore(summary: Pick<StaffSummary, "scoreSum" | "scoreCount">) { return summary.scoreCount ? summary.scoreSum / summary.scoreCount : undefined; }

export type PayrollLine = { staffId: string; name: string; shiftCount: number; absences: number; minutes: number; violations: number; baseAmount: number; rates: Array<{ rate: number; minutes: number }> };
/// What Kết sổ will book for (month, store): one line per person with any
/// shift there that month — the set close_staff_payroll insists on.
export function payrollLines(state: Pick<StaffState, "members" | "shifts">, month: string, storeId: string): PayrollLine[] {
  const { start, end } = monthBounds(month);
  const inMonth = state.shifts.filter((shift) => shift.storeId === storeId && shift.workDate >= start && shift.workDate <= end);
  const people = [...new Set(inMonth.map((shift) => shift.staffId))];
  return people.map((staffId) => {
    const own = inMonth.filter((shift) => shift.staffId === staffId);
    const rates = new Map<number, number>();
    for (const shift of own) if (!shift.absent) rates.set(shift.hourlyRate, (rates.get(shift.hourlyRate) || 0) + shiftMinutes(shift));
    return {
      staffId,
      name: state.members.find((member) => member.id === staffId)?.name || "Nhân viên đã xoá",
      shiftCount: own.filter((shift) => !shift.absent).length,
      absences: own.filter((shift) => shift.absent).length,
      minutes: own.reduce((sum, shift) => sum + shiftMinutes(shift), 0),
      violations: own.reduce((sum, shift) => sum + violationCount(shift), 0),
      baseAmount: payOf(own),
      rates: [...rates].map(([rate, minutes]) => ({ rate, minutes })).sort((left, right) => right.minutes - left.minutes),
    };
  }).sort((left, right) => left.name.localeCompare(right.name, "vi"));
}

export function closedFor(closings: PayrollClosing[], month: string, storeId: string) {
  return closings.filter((closing) => closing.status === "closed" && closing.month === month && closing.storeId === storeId);
}
export function isMonthClosed(closings: PayrollClosing[], month: string, storeId: string) { return closedFor(closings, month, storeId).length > 0; }

/// The interval a shift occupies, in minutes from the start of its day.
function span(shift: StaffShift) {
  const start = timeToMinutes(shift.checkIn) ?? 0;
  return [start, start + shiftMinutes(shift) + (shift.breakMinutes || 0)] as const;
}
/// Blocking errors and warnings for a shift about to be saved. `others` are the
/// person's other shifts (any store); a shift that ran past midnight can
/// overlap the next morning's.
export function shiftProblems(shift: StaffShift, others: StaffShift[]) {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!shift.staffId) errors.push("Chọn hoặc nhập tên nhân viên.");
  if (!shift.storeId) errors.push("Chọn điểm bán.");
  if (!shift.absent) {
    const start = timeToMinutes(shift.checkIn), end = timeToMinutes(shift.checkOut);
    if (start === undefined || end === undefined) errors.push("Nhập đủ giờ đến và giờ về.");
    else if (start === end) errors.push("Giờ về trùng giờ đến.");
    else {
      const minutes = shiftMinutes(shift);
      if (minutes < 0) errors.push("Nghỉ giữa ca dài hơn cả ca.");
      else if (minutes > 12 * 60) warnings.push(`Ca dài ${formatMinutes(minutes)} — kiểm tra lại giờ về.`);
      if (isOvernight(shift)) warnings.push("Giờ về nhỏ hơn giờ đến: tính là ca qua đêm, kết thúc ngày hôm sau.");
    }
    if (!(shift.hourlyRate > 0)) errors.push("Nhập đơn giá / giờ.");
    if (!errors.length) {
      const [from, to] = span(shift);
      for (const other of others) {
        if (other.id === shift.id || other.absent) continue;
        const offset = other.workDate === shift.workDate ? 0 : other.workDate === addDays(shift.workDate, 1) ? 1440 : other.workDate === addDays(shift.workDate, -1) ? -1440 : undefined;
        if (offset === undefined) continue;
        const [otherFrom, otherTo] = span(other);
        if (from < otherTo + offset && otherFrom + offset < to) errors.push(`Trùng giờ với ca ${other.checkIn}–${other.checkOut} ngày ${other.workDate.slice(8, 10)}/${other.workDate.slice(5, 7)} của cùng người.`);
      }
    }
  } else if (!shift.violations.length) {
    warnings.push("Ngày vắng không có lý do vi phạm được tính là nghỉ có báo: không tính ca, không tính điểm.");
  }
  return { errors, warnings };
}

/// Rates already used, most used first — "nhập lần đầu, lần sau chỉ chọn".
export function rememberedRates(state: Pick<StaffState, "members" | "shifts">) {
  const counts = new Map<number, number>();
  for (const shift of state.shifts) if (shift.hourlyRate > 0) counts.set(shift.hourlyRate, (counts.get(shift.hourlyRate) || 0) + 1);
  for (const member of state.members) if (member.defaultRate > 0 && !counts.has(member.defaultRate)) counts.set(member.defaultRate, 0);
  return [...counts].sort((left, right) => left[0] - right[0]).map(([rate]) => rate);
}

/// The person's most recent shift, to prefill the next one with their usual
/// hours, break and rate.
export function lastShiftOf(shifts: StaffShift[], staffId: string, beforeDate?: string) {
  return shifts
    .filter((shift) => shift.staffId === staffId && !shift.absent && (!beforeDate || shift.workDate <= beforeDate))
    .sort((left, right) => right.workDate.localeCompare(left.workDate) || (right.checkIn || "").localeCompare(left.checkIn || ""))[0];
}

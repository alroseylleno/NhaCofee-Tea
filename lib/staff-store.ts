import { FINANCE_UAT_STORAGE_KEY, type FinanceExpenseRecord } from "./finance-store";
import { selectAll } from "./select-all";
import {
  PAYROLL_SUBCATEGORY, SEED_REASONS, isMonthClosed, monthBounds, monthLabel, monthOf, payrollLines,
  type PayrollClosing, type ShiftViolation, type StaffMember, type StaffShift, type StaffState, type ViolationReason,
} from "./staff";
import { supabase } from "./supabase";

// Chấm công persistence. Production: the staff_* tables and the two RPCs of
// migration 20261111000100. UAT: one browser-local key, with the RPC rules
// mirrored here so UAT behaves like Production (locks, recomputed totals,
// payroll rows in Finance's UAT book).

export const STAFF_UAT_STORAGE_KEY = "nha-ops-staff-uat-v1";

/// Production before migration 20261111000100: the module shows that it is
/// not switched on yet instead of failing.
export class StaffNotReadyError extends Error {}

export type PayrollCloseLine = { staffId: string; closingId: string; expenseId: string; bonus: number; amount: number; note?: string };
export type PayrollCloseInput = { month: string; storeId: string; incurredOn: string; lines: PayrollCloseLine[] };
/// Salary rows already in Finance for a month — the manual ones Long typed
/// before Chấm công existed, and payroll rows (to warn before reopening a paid one).
export type SalaryExpense = { id: string; name: string; amount: number; incurredOn: string; storeId?: string; payroll: boolean; paid: boolean };

function requireClient() {
  if (!supabase) throw new Error("Supabase chưa được cấu hình.");
  return supabase;
}
function missingSchema(error: { code?: string; message?: string } | null) {
  return Boolean(error && (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST202" || error.code === "42703" || /does not exist|schema cache|could not find/i.test(error.message || "")));
}
/// The guard triggers raise Vietnamese messages written for Long; show them as they are.
function failure(error: { code?: string; message?: string; details?: string | null } | null, context: string) {
  if (!error) return new Error(context);
  if (missingSchema(error)) return new StaffNotReadyError("Production chưa có bảng Chấm công (migration 20261111000100).");
  if (error.code === "P0001" || error.code === "22023") return new Error(error.message || context);
  if (error.code === "23505") return new Error(`${context}: tên này đã có — chọn trong danh sách thay vì nhập lại.`);
  return new Error(`${context}: ${[error.message, error.details].filter(Boolean).join(" · ")}${error.code ? ` [${error.code}]` : ""}`);
}

const numberValue = (value: unknown) => { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; };
const timeValue = (value: unknown) => typeof value === "string" && value ? value.slice(0, 5) : undefined;
function violationsFrom(value: unknown): ShiftViolation[] {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const item = entry as Partial<ShiftViolation> | null;
    if (!item || !item.label) return [];
    return [{ reasonId: item.reasonId ? String(item.reasonId) : undefined, label: String(item.label), points: numberValue(item.points), count: Math.max(1, Math.round(numberValue(item.count) || 1)) }];
  }) : [];
}

function memberFromRow(row: Record<string, unknown>): StaffMember {
  return { id: String(row.id), name: String(row.name), defaultRate: numberValue(row.default_rate), defaultStoreId: row.default_store_id ? String(row.default_store_id) : undefined, status: row.status === "inactive" ? "inactive" : "active" };
}
function reasonFromRow(row: Record<string, unknown>): ViolationReason {
  return { id: String(row.id), label: String(row.label), points: numberValue(row.points) };
}
function shiftFromRow(row: Record<string, unknown>): StaffShift {
  return {
    id: String(row.id), staffId: String(row.staff_id), storeId: String(row.store_id), workDate: String(row.work_date),
    absent: Boolean(row.absent), checkIn: timeValue(row.check_in), checkOut: timeValue(row.check_out),
    breakMinutes: numberValue(row.break_minutes), hourlyRate: numberValue(row.hourly_rate),
    violations: violationsFrom(row.violations), note: row.note ? String(row.note) : undefined,
    payrollClosingId: row.payroll_closing_id ? String(row.payroll_closing_id) : undefined,
  };
}
function closingFromRow(row: Record<string, unknown>): PayrollClosing {
  return {
    id: String(row.id), month: String(row.month), storeId: String(row.store_id), staffId: String(row.staff_id),
    shiftCount: numberValue(row.shift_count), minutes: numberValue(row.minutes), baseAmount: numberValue(row.base_amount),
    bonus: numberValue(row.bonus), amount: numberValue(row.amount), expenseId: row.expense_id ? String(row.expense_id) : undefined,
    incurredOn: String(row.incurred_on), status: row.status === "reopened" ? "reopened" : "closed",
    closedAt: String(row.closed_at), reopenedAt: row.reopened_at ? String(row.reopened_at) : undefined,
  };
}

// ---------------------------------------------------------------- UAT store

function emptyUatState(): StaffState { return { members: [], reasons: SEED_REASONS.map((reason) => ({ ...reason })), shifts: [], closings: [] }; }
function readUat(): StaffState {
  try {
    const stored = window.localStorage.getItem(STAFF_UAT_STORAGE_KEY);
    if (!stored) return emptyUatState();
    const value = JSON.parse(stored) as Partial<StaffState>;
    return {
      members: Array.isArray(value.members) ? value.members : [],
      reasons: Array.isArray(value.reasons) ? value.reasons : SEED_REASONS.map((reason) => ({ ...reason })),
      shifts: Array.isArray(value.shifts) ? value.shifts.map((shift) => ({ ...shift, violations: violationsFrom(shift.violations) })) : [],
      closings: Array.isArray(value.closings) ? value.closings : [],
    };
  } catch { return emptyUatState(); }
}
function writeUat(state: StaffState) { window.localStorage.setItem(STAFF_UAT_STORAGE_KEY, JSON.stringify(state)); }
type FinanceUatBook = { expenses?: FinanceExpenseRecord[] } & Record<string, unknown>;
function readFinanceUat(): FinanceUatBook | undefined {
  const stored = window.localStorage.getItem(FINANCE_UAT_STORAGE_KEY);
  if (!stored) return undefined;
  try { return JSON.parse(stored) as FinanceUatBook; } catch { return undefined; }
}
/// Mirrors the staff_shifts_lock_guard trigger.
function uatShiftGuard(state: StaffState, before: StaffShift | undefined, after: StaffShift | undefined) {
  if (before?.payrollClosingId) throw new Error(`Ca ngày ${before.workDate.split("-").reverse().join("/")} thuộc tháng đã kết sổ. Muốn sửa: Chấm công → Mở lại sổ tháng ${monthLabel(monthOf(before.workDate))}.`);
  if (after && isMonthClosed(state.closings, monthOf(after.workDate), after.storeId)) throw new Error(`Tháng ${monthLabel(monthOf(after.workDate))} của điểm bán này đã kết sổ — không thêm hay sửa ca được. Muốn sửa: Chấm công → Mở lại sổ.`);
}

// ------------------------------------------------------------------ public

export async function loadStaff(uat: boolean): Promise<StaffState> {
  if (uat) return readUat();
  const client = requireClient();
  const [members, reasons, shifts, closings] = await Promise.all([
    selectAll((from, to) => client.from("staff_members").select("*").order("name").order("id").range(from, to)),
    selectAll((from, to) => client.from("staff_violation_reasons").select("*").order("label").order("id").range(from, to)),
    selectAll((from, to) => client.from("staff_shifts").select("*").order("work_date").order("id").range(from, to)),
    selectAll((from, to) => client.from("staff_payroll_closings").select("*").order("closed_at").order("id").range(from, to)),
  ]);
  for (const [result, context] of [[members, "Không tải được nhân viên"], [reasons, "Không tải được lý do vi phạm"], [shifts, "Không tải được ca làm"], [closings, "Không tải được kết sổ"]] as const) {
    if (result.error) throw failure(result.error, context);
  }
  return {
    members: members.data!.map(memberFromRow),
    reasons: reasons.data!.map(reasonFromRow),
    shifts: shifts.data!.map(shiftFromRow),
    closings: closings.data!.map(closingFromRow),
  };
}

export async function saveStaffMember(uat: boolean, member: StaffMember): Promise<StaffMember> {
  if (uat) {
    const state = readUat();
    writeUat({ ...state, members: [...state.members.filter((entry) => entry.id !== member.id), member] });
    return member;
  }
  const { data, error } = await requireClient().from("staff_members").upsert({
    id: member.id, name: member.name, default_rate: member.defaultRate, default_store_id: member.defaultStoreId || null, status: member.status, updated_at: new Date().toISOString(),
  }, { onConflict: "id" }).select("*").single();
  if (error) throw failure(error, "Không lưu được nhân viên");
  return memberFromRow(data);
}

export async function saveViolationReason(uat: boolean, reason: ViolationReason): Promise<ViolationReason> {
  if (uat) {
    const state = readUat();
    writeUat({ ...state, reasons: [...state.reasons.filter((entry) => entry.id !== reason.id), reason] });
    return reason;
  }
  const { data, error } = await requireClient().from("staff_violation_reasons").upsert({ id: reason.id, label: reason.label, points: reason.points }, { onConflict: "id" }).select("*").single();
  if (error) throw failure(error, "Không lưu được lý do vi phạm");
  return reasonFromRow(data);
}

export async function saveShift(uat: boolean, shift: StaffShift): Promise<StaffShift> {
  if (uat) {
    const state = readUat();
    uatShiftGuard(state, state.shifts.find((entry) => entry.id === shift.id), shift);
    const saved = { ...shift, payrollClosingId: undefined };
    writeUat({ ...state, shifts: [...state.shifts.filter((entry) => entry.id !== shift.id), saved] });
    return saved;
  }
  // minutes is generated and payroll_closing_id belongs to Kết sổ: neither is sent.
  const { data, error } = await requireClient().from("staff_shifts").upsert({
    id: shift.id, staff_id: shift.staffId, store_id: shift.storeId, work_date: shift.workDate, absent: shift.absent,
    check_in: shift.absent ? null : shift.checkIn, check_out: shift.absent ? null : shift.checkOut,
    break_minutes: shift.absent ? 0 : shift.breakMinutes, hourly_rate: shift.hourlyRate,
    violations: shift.violations, note: shift.note || null,
  }, { onConflict: "id" }).select("*").single();
  if (error) throw failure(error, "Không lưu được ca");
  return shiftFromRow(data);
}

export async function deleteShift(uat: boolean, shift: StaffShift) {
  if (uat) {
    const state = readUat();
    uatShiftGuard(state, state.shifts.find((entry) => entry.id === shift.id), undefined);
    writeUat({ ...state, shifts: state.shifts.filter((entry) => entry.id !== shift.id) });
    return;
  }
  const { data, error } = await requireClient().from("staff_shifts").delete().eq("id", shift.id).select("id");
  if (error) throw failure(error, "Không xoá được ca");
  if (!data?.length) throw new Error("Supabase không xoá ca nào — có thể ca đã bị xoá ở máy khác. Tải lại trang.");
}

export async function loadSalaryExpenses(uat: boolean, month: string): Promise<SalaryExpense[]> {
  const { start, end } = monthBounds(month);
  const fromRecord = (expense: FinanceExpenseRecord): SalaryExpense => ({ id: expense.id, name: expense.name, amount: expense.amount, incurredOn: expense.incurredOn, storeId: expense.storeId, payroll: expense.source === "payroll", paid: expense.paymentStatus === "paid" });
  if (uat) {
    return (readFinanceUat()?.expenses || [])
      .filter((expense) => expense.status === "active" && expense.subcategory?.trim() === PAYROLL_SUBCATEGORY && expense.incurredOn >= start && expense.incurredOn <= end)
      .map(fromRecord);
  }
  const { data, error } = await requireClient().from("finance_expenses")
    .select("id,name,amount,incurred_on,store_id,source,payment_status,status,subcategory")
    .eq("subcategory", PAYROLL_SUBCATEGORY).eq("status", "active").gte("incurred_on", start).lte("incurred_on", end);
  if (error) throw failure(error, "Không đọc được chi phí lương trong Tài chính");
  return (data || []).map((row) => ({ id: String(row.id), name: String(row.name), amount: numberValue(row.amount), incurredOn: String(row.incurred_on), storeId: row.store_id ? String(row.store_id) : undefined, payroll: row.source === "payroll", paid: row.payment_status === "paid" }));
}

/// Payroll rows of a closed month, to warn before reopening one already paid.
export async function loadPayrollExpenses(uat: boolean, expenseIds: string[]): Promise<SalaryExpense[]> {
  if (!expenseIds.length) return [];
  if (uat) {
    return (readFinanceUat()?.expenses || []).filter((expense) => expenseIds.includes(expense.id)).map((expense) => ({ id: expense.id, name: expense.name, amount: expense.amount, incurredOn: expense.incurredOn, storeId: expense.storeId, payroll: true, paid: expense.paymentStatus === "paid" }));
  }
  const { data, error } = await requireClient().from("finance_expenses").select("id,name,amount,incurred_on,store_id,payment_status").in("id", expenseIds);
  if (error) throw failure(error, "Không đọc được dòng lương trong Tài chính");
  return (data || []).map((row) => ({ id: String(row.id), name: String(row.name), amount: numberValue(row.amount), incurredOn: String(row.incurred_on), storeId: row.store_id ? String(row.store_id) : undefined, payroll: true, paid: row.payment_status === "paid" }));
}

export async function closePayroll(uat: boolean, input: PayrollCloseInput, memberName: (staffId: string) => string): Promise<PayrollClosing[]> {
  if (!uat) {
    const { data, error } = await requireClient().rpc("close_staff_payroll", {
      p_month: input.month, p_store_id: input.storeId, p_incurred_on: input.incurredOn,
      p_lines: input.lines.map((line) => ({ staff_id: line.staffId, closing_id: line.closingId, expense_id: line.amount > 0 ? line.expenseId : "", bonus: line.bonus, amount: line.amount, note: line.note || "" })),
    });
    if (error) throw failure(error, "Kết sổ không thành công");
    return (data || []).map((row: Record<string, unknown>) => closingFromRow(row));
  }
  // UAT mirror of close_staff_payroll.
  const state = readUat();
  const book = readFinanceUat();
  if (!book) throw new Error("UAT chưa có sổ chi phí: mở Tài chính một lần (tạo sổ UAT), rồi quay lại kết sổ.");
  const { start } = monthBounds(input.month);
  if (input.incurredOn < start) throw new Error(`Ngày ghi nhận chi phí phải từ ${start.split("-").reverse().join("/")} trở đi.`);
  if (isMonthClosed(state.closings, input.month, input.storeId)) throw new Error(`Tháng ${monthLabel(input.month)} của điểm bán này đã kết sổ. Tải lại trang để thấy số mới nhất.`);
  const expected = payrollLines(state, input.month, input.storeId);
  if (!expected.length) throw new Error(`Tháng ${monthLabel(input.month)} chưa có ca nào ở điểm bán này.`);
  if (expected.length !== input.lines.length || expected.some((line) => !input.lines.some((entry) => entry.staffId === line.staffId))) throw new Error("Danh sách ca đã đổi ở máy khác (thêm hoặc bớt người). Tải lại trang rồi kết sổ lại.");
  const now = new Date().toISOString();
  const closings: PayrollClosing[] = [];
  const expenses: FinanceExpenseRecord[] = [];
  for (const line of input.lines) {
    const base = expected.find((entry) => entry.staffId === line.staffId)!;
    if (line.bonus < 0) throw new Error("Thưởng không được âm.");
    const total = base.baseAmount + line.bonus;
    if (total !== line.amount) throw new Error(`Số tiền của ${memberName(line.staffId)} đã đổi (máy này thấy ${line.amount}, dữ liệu ca cho ${total}). Tải lại trang rồi kết sổ lại.`);
    closings.push({ id: line.closingId, month: input.month, storeId: input.storeId, staffId: line.staffId, shiftCount: base.shiftCount, minutes: base.minutes, baseAmount: base.baseAmount, bonus: line.bonus, amount: total, expenseId: total > 0 ? line.expenseId : undefined, incurredOn: input.incurredOn, status: "closed", closedAt: now });
    if (total > 0) expenses.push({ id: line.expenseId, name: `Lương T${monthLabel(input.month)} · ${memberName(line.staffId)}`, category: "operating", subcategory: PAYROLL_SUBCATEGORY, amount: total, incurredOn: input.incurredOn, recurrence: "once", paymentStatus: "unpaid", vendor: memberName(line.staffId), note: line.note || undefined, status: "active", storeId: input.storeId, source: "payroll", sourceId: line.closingId });
  }
  const closingOf = new Map(closings.map((closing) => [closing.staffId, closing.id]));
  const { end } = monthBounds(input.month);
  writeUat({
    ...state,
    closings: [...state.closings, ...closings],
    shifts: state.shifts.map((shift) => shift.storeId === input.storeId && shift.workDate >= start && shift.workDate <= end && closingOf.has(shift.staffId) ? { ...shift, payrollClosingId: closingOf.get(shift.staffId) } : shift),
  });
  window.localStorage.setItem(FINANCE_UAT_STORAGE_KEY, JSON.stringify({ ...book, expenses: [...(book.expenses || []), ...expenses] }));
  return closings;
}

export async function reopenPayroll(uat: boolean, month: string, storeId: string) {
  if (!uat) {
    const { error } = await requireClient().rpc("reopen_staff_payroll", { p_month: month, p_store_id: storeId });
    if (error) throw failure(error, "Mở lại sổ không thành công");
    return;
  }
  const state = readUat();
  const closed = state.closings.filter((closing) => closing.status === "closed" && closing.month === month && closing.storeId === storeId);
  if (!closed.length) throw new Error("Tháng này chưa kết sổ — không có gì để mở lại.");
  const closedIds = new Set(closed.map((closing) => closing.id));
  const expenseIds = new Set(closed.flatMap((closing) => closing.expenseId ? [closing.expenseId] : []));
  const now = new Date().toISOString();
  writeUat({
    ...state,
    closings: state.closings.map((closing) => closedIds.has(closing.id) ? { ...closing, status: "reopened", reopenedAt: now } : closing),
    shifts: state.shifts.map((shift) => shift.payrollClosingId && closedIds.has(shift.payrollClosingId) ? { ...shift, payrollClosingId: undefined } : shift),
  });
  const book = readFinanceUat();
  if (book?.expenses) window.localStorage.setItem(FINANCE_UAT_STORAGE_KEY, JSON.stringify({ ...book, expenses: book.expenses.map((expense) => expenseIds.has(expense.id) ? { ...expense, status: "voided" } : expense) }));
}

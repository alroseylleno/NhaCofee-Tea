"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";
import styles from "./finance.module.css";

export type FinanceInventoryLot = {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  unitCost: number;
  purchasedOn: string;
  receiptCode?: string;
};

export type FinanceInventorySession = {
  id: string;
  sourceReceiptId: string;
  activatedAt: string;
  status: "active" | "used" | "wasted";
  closedAt?: string;
  reason: string;
};

type FinanceTab = "entry" | "report" | "dashboard";
type PeriodMode = "month" | "quarter" | "year";
type ExpenseCategory = "fixed" | "operating" | "sales" | "investment";
type Recurrence = "once" | "weekly" | "monthly" | "quarterly" | "yearly";
type PaymentStatus = "unpaid" | "partial" | "paid";
type ReportView = "pnl" | "cash" | "inventory" | "assets";

type ExpenseRecord = {
  id: string;
  name: string;
  category: ExpenseCategory;
  subcategory: string;
  amount: number;
  incurredOn: string;
  recurrence: Recurrence;
  paymentStatus: PaymentStatus;
  paymentDate?: string;
  invoiceCode?: string;
  vendor?: string;
  note?: string;
  usefulLifeMonths?: number;
  salvageValue?: number;
  inServiceOn?: string;
  status: "active" | "voided";
};

type RevenueRecord = {
  id: string;
  date: string;
  storeRevenue: number;
  appRevenue: number;
  discounts: number;
  platformFees: number;
  cashReceived: number;
  orders: number;
  cups: number;
  note?: string;
};

type FinanceState = {
  expenses: ExpenseRecord[];
  revenues: RevenueRecord[];
  monthlyRevenueTarget: number;
  monthlyCupTarget: number;
  closedPeriods: string[];
};

type ExpenseForm = {
  name: string;
  category: ExpenseCategory;
  subcategory: string;
  amount: string;
  incurredOn: string;
  recurrence: Recurrence;
  paymentStatus: PaymentStatus;
  paymentDate: string;
  invoiceCode: string;
  vendor: string;
  note: string;
  usefulLifeMonths: string;
  salvageValue: string;
  inServiceOn: string;
};

type RevenueForm = {
  date: string;
  storeRevenue: string;
  appRevenue: string;
  discounts: string;
  platformFees: string;
  cashReceived: string;
  orders: string;
  cups: string;
  note: string;
};

type PeriodBounds = { start: string; end: string; label: string; key: string };

const FINANCE_STORAGE_KEY = "nha-ops-finance-uat-v1";
const categoryLabels: Record<ExpenseCategory, string> = {
  fixed: "Chi phí cố định",
  operating: "Chi phí vận hành",
  sales: "Chi phí bán hàng",
  investment: "Đầu tư ban đầu",
};
const paymentLabels: Record<PaymentStatus, string> = { unpaid: "Chưa thanh toán", partial: "Thanh toán một phần", paid: "Đã thanh toán" };
const recurrenceLabels: Record<Recurrence, string> = { once: "Một lần", weekly: "Hàng tuần", monthly: "Hàng tháng", quarterly: "Hàng quý", yearly: "Hàng năm" };

function todayISO() { return new Date().toISOString().slice(0, 10); }
function monthKey(value: string) { return value.slice(0, 7); }
function money(value: number) { return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(value || 0); }
function compactMoney(value: number) { return new Intl.NumberFormat("vi-VN", { notation: "compact", maximumFractionDigits: 1 }).format(value || 0); }
function dateLabel(value: string) { const [year, month, day] = value.split("-"); return day && month && year ? `${day}/${month}/${year}` : value; }
function parseAmount(value: string) { return Number(value.replace(/\D/g, "")); }
function amountInput(value: string) { const digits = value.replace(/\D/g, ""); return digits ? Number(digits).toLocaleString("en-US") : ""; }
function dateAt(year: number, month: number, day: number) { return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }
function daysInMonth(year: number, month: number) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function addDaysISO(value: string, days: number) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function dateDiff(start: string, end: string) { return Math.max(0, Math.floor((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86_400_000)); }
function monthDiff(start: string, end: string) { const [sy, sm] = start.slice(0, 7).split("-").map(Number); const [ey, em] = end.slice(0, 7).split("-").map(Number); return (ey - sy) * 12 + em - sm; }
function inRange(value: string, bounds: PeriodBounds) { return value >= bounds.start && value <= bounds.end; }

function periodBounds(mode: PeriodMode, selectedMonth: string, quarter: number, year: number): PeriodBounds {
  if (mode === "month") {
    const [selectedYear, selectedMonthNumber] = selectedMonth.split("-").map(Number);
    return { start: dateAt(selectedYear, selectedMonthNumber, 1), end: dateAt(selectedYear, selectedMonthNumber, daysInMonth(selectedYear, selectedMonthNumber)), label: `Tháng ${selectedMonthNumber}/${selectedYear}`, key: selectedMonth };
  }
  if (mode === "quarter") {
    const startMonth = (quarter - 1) * 3 + 1;
    const endMonth = startMonth + 2;
    return { start: dateAt(year, startMonth, 1), end: dateAt(year, endMonth, daysInMonth(year, endMonth)), label: `Quý ${quarter}/${year}`, key: `${year}-Q${quarter}` };
  }
  return { start: dateAt(year, 1, 1), end: dateAt(year, 12, 31), label: `Năm ${year}`, key: String(year) };
}

function expenseFormDefaults(category: ExpenseCategory = "fixed"): ExpenseForm {
  const today = todayISO();
  return { name: "", category, subcategory: "", amount: "", incurredOn: today, recurrence: category === "fixed" ? "monthly" : "once", paymentStatus: "paid", paymentDate: today, invoiceCode: "", vendor: "", note: "", usefulLifeMonths: "36", salvageValue: "0", inServiceOn: today };
}

function revenueFormDefaults(): RevenueForm {
  return { date: todayISO(), storeRevenue: "", appRevenue: "", discounts: "", platformFees: "", cashReceived: "", orders: "", cups: "", note: "" };
}

function seedFinanceState(): FinanceState {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const maxDay = Math.min(today.getDate(), 24);
  const revenues: RevenueRecord[] = Array.from({ length: maxDay }, (_, index) => {
    const day = index + 1;
    const storeRevenue = 2_700_000 + (day % 5) * 170_000;
    const appRevenue = 1_100_000 + (day % 4) * 120_000;
    const discounts = day % 6 === 0 ? 240_000 : 90_000;
    const platformFees = Math.round(appRevenue * 0.21);
    const net = storeRevenue + appRevenue - discounts;
    return { id: `uat-revenue-${day}`, date: dateAt(year, month, day), storeRevenue, appRevenue, discounts, platformFees, cashReceived: net - platformFees, orders: 72 + (day % 7) * 5, cups: 91 + (day % 6) * 7, note: "Dữ liệu mẫu UAT" };
  });
  return {
    expenses: [
      { id: "uat-rent", name: "Tiền thuê mặt bằng", category: "fixed", subcategory: "Mặt bằng", amount: 15_000_000, incurredOn: dateAt(year, month, 1), recurrence: "monthly", paymentStatus: "paid", paymentDate: dateAt(year, month, 3), invoiceCode: "HD-THUE-UAT", vendor: "Chủ nhà", note: "Dữ liệu mẫu UAT", status: "active" },
      { id: "uat-internet", name: "Internet & phần mềm", category: "fixed", subcategory: "Hạ tầng", amount: 890_000, incurredOn: dateAt(year, month, 5), recurrence: "monthly", paymentStatus: "unpaid", invoiceCode: "HD-SOFT-UAT", note: "Dữ liệu mẫu UAT", status: "active" },
      { id: "uat-electric", name: "Điện, nước vận hành", category: "operating", subcategory: "Tiện ích", amount: 4_200_000, incurredOn: dateAt(year, month, 18), recurrence: "monthly", paymentStatus: "paid", paymentDate: dateAt(year, month, 20), invoiceCode: "HD-DIEN-UAT", note: "Dữ liệu mẫu UAT", status: "active" },
      { id: "uat-ads", name: "Quảng cáo Meta", category: "sales", subcategory: "Quảng cáo", amount: 6_500_000, incurredOn: dateAt(year, month, 8), recurrence: "once", paymentStatus: "paid", paymentDate: dateAt(year, month, 8), invoiceCode: "META-UAT", note: "Dữ liệu mẫu UAT", status: "active" },
      { id: "uat-machine", name: "Máy pha cà phê", category: "investment", subcategory: "Thiết bị pha chế", amount: 60_000_000, incurredOn: dateAt(year, Math.max(1, month - 3), 10), recurrence: "once", paymentStatus: "paid", paymentDate: dateAt(year, Math.max(1, month - 3), 10), invoiceCode: "CAPEX-UAT-01", usefulLifeMonths: 60, salvageValue: 0, inServiceOn: dateAt(year, Math.max(1, month - 3), 15), note: "Dữ liệu mẫu UAT", status: "active" },
      { id: "uat-fridge", name: "Tủ mát quầy bar", category: "investment", subcategory: "Thiết bị bảo quản", amount: 24_000_000, incurredOn: dateAt(year, Math.max(1, month - 2), 12), recurrence: "once", paymentStatus: "paid", paymentDate: dateAt(year, Math.max(1, month - 2), 12), invoiceCode: "CAPEX-UAT-02", usefulLifeMonths: 36, salvageValue: 0, inServiceOn: dateAt(year, Math.max(1, month - 2), 15), note: "Dữ liệu mẫu UAT", status: "active" },
    ],
    revenues,
    monthlyRevenueTarget: 160_000_000,
    monthlyCupTarget: 3_600,
    closedPeriods: [],
  };
}

function expenseOccurrences(expense: ExpenseRecord, bounds: PeriodBounds) {
  if (expense.status === "voided" || expense.category === "investment") return [] as string[];
  if (expense.recurrence === "once") return inRange(expense.incurredOn, bounds) ? [expense.incurredOn] : [];
  const dates: string[] = [];
  let cursor = expense.incurredOn;
  let guard = 0;
  while (cursor <= bounds.end && guard < 500) {
    if (cursor >= bounds.start) dates.push(cursor);
    if (expense.recurrence === "weekly") cursor = addDaysISO(cursor, 7);
    else {
      const months = expense.recurrence === "monthly" ? 1 : expense.recurrence === "quarterly" ? 3 : 12;
      const [year, month, day] = cursor.split("-").map(Number);
      const target = new Date(Date.UTC(year, month - 1 + months, 1));
      const targetYear = target.getUTCFullYear();
      const targetMonth = target.getUTCMonth() + 1;
      cursor = dateAt(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
    }
    guard += 1;
  }
  return dates;
}

function depreciationForAsset(asset: ExpenseRecord, bounds: PeriodBounds) {
  if (asset.category !== "investment" || asset.status === "voided" || !asset.inServiceOn || !asset.usefulLifeMonths) return 0;
  const monthly = Math.max(0, asset.amount - (asset.salvageValue || 0)) / asset.usefulLifeMonths;
  let cursor = `${asset.inServiceOn.slice(0, 7)}-01`;
  const endMonth = `${bounds.end.slice(0, 7)}-01`;
  let months = 0;
  while (cursor <= endMonth && months < asset.usefulLifeMonths) {
    if (cursor.slice(0, 7) >= bounds.start.slice(0, 7)) months += 1;
    const [year, month] = cursor.split("-").map(Number);
    const next = new Date(Date.UTC(year, month, 1));
    cursor = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  return monthly * months;
}

function MiniBars({ values, target }: { values: Array<{ label: string; value: number }>; target: number }) {
  const max = Math.max(target, ...values.map((entry) => entry.value), 1);
  return <div className={styles.miniBars}>{values.map((entry) => <div className={styles.barColumn} key={entry.label}><div className={styles.barTrack}><i style={{ height: `${Math.max(3, (entry.value / max) * 100)}%` }} /></div><span>{entry.label}</span></div>)}</div>;
}

export default function FinanceModule({ inventoryLots, inventorySessions, onOpenInventoryLot }: { inventoryLots: FinanceInventoryLot[]; inventorySessions: FinanceInventorySession[]; onOpenInventoryLot: (id: string) => void }) {
  const today = todayISO();
  const [state, setState] = useState<FinanceState>(seedFinanceState);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<FinanceTab>("entry");
  const [periodMode, setPeriodMode] = useState<PeriodMode>("month");
  const [selectedMonth, setSelectedMonth] = useState(today.slice(0, 7));
  const [selectedQuarter, setSelectedQuarter] = useState(Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1);
  const [selectedYear, setSelectedYear] = useState(Number(today.slice(0, 4)));
  const [expenseCategory, setExpenseCategory] = useState<ExpenseCategory>("fixed");
  const [reportView, setReportView] = useState<ReportView>("pnl");
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [showRevenueForm, setShowRevenueForm] = useState(false);
  const [editingExpenseId, setEditingExpenseId] = useState<string | undefined>();
  const [expenseForm, setExpenseForm] = useState<ExpenseForm>(expenseFormDefaults());
  const [revenueForm, setRevenueForm] = useState<RevenueForm>(revenueFormDefaults());

  useEffect(() => {
    const stored = window.localStorage.getItem(FINANCE_STORAGE_KEY);
    if (stored) {
      try { setState(JSON.parse(stored) as FinanceState); } catch { setState(seedFinanceState()); }
    }
    setLoaded(true);
  }, []);
  useEffect(() => { if (loaded) window.localStorage.setItem(FINANCE_STORAGE_KEY, JSON.stringify(state)); }, [state, loaded]);

  const bounds = useMemo(() => periodBounds(periodMode, selectedMonth, selectedQuarter, selectedYear), [periodMode, selectedMonth, selectedQuarter, selectedYear]);
  const currentPeriodClosed = periodMode === "month" && state.closedPeriods.includes(bounds.key);
  const activeExpenses = state.expenses.filter((expense) => expense.status === "active");
  const manualOccurrences = useMemo(() => activeExpenses.flatMap((expense) => expenseOccurrences(expense, bounds).map((date) => ({ expense, date, amount: expense.amount }))), [activeExpenses, bounds]);
  const periodRevenues = useMemo(() => state.revenues.filter((entry) => inRange(entry.date, bounds)), [state.revenues, bounds]);
  const inventoryEvents = useMemo(() => inventorySessions.flatMap((session) => {
    const lot = inventoryLots.find((entry) => entry.id === session.sourceReceiptId);
    if (!lot) return [];
    const events: Array<{ id: string; date: string; lot: FinanceInventoryLot; amount: number; kind: "cogs" | "waste"; reason: string }> = [];
    const activatedOn = session.activatedAt.slice(0, 10);
    if (inRange(activatedOn, bounds)) events.push({ id: `${session.id}-cogs`, date: activatedOn, lot, amount: lot.unitCost, kind: "cogs", reason: session.reason });
    const wastedOn = session.status === "wasted" ? session.closedAt?.slice(0, 10) : undefined;
    if (wastedOn && inRange(wastedOn, bounds)) events.push({ id: `${session.id}-waste`, date: wastedOn, lot, amount: lot.unitCost, kind: "waste", reason: session.reason });
    return events;
  }), [inventoryLots, inventorySessions, bounds]);
  const assetExpenses = activeExpenses.filter((expense) => expense.category === "investment");
  const depreciation = assetExpenses.reduce((sum, asset) => sum + depreciationForAsset(asset, bounds), 0);

  const grossRevenue = periodRevenues.reduce((sum, entry) => sum + entry.storeRevenue + entry.appRevenue, 0);
  const discounts = periodRevenues.reduce((sum, entry) => sum + entry.discounts, 0);
  const netRevenue = grossRevenue - discounts;
  const cups = periodRevenues.reduce((sum, entry) => sum + entry.cups, 0);
  const orders = periodRevenues.reduce((sum, entry) => sum + entry.orders, 0);
  const platformFees = periodRevenues.reduce((sum, entry) => sum + entry.platformFees, 0);
  const inventoryIssued = inventoryEvents.filter((entry) => entry.kind === "cogs").reduce((sum, entry) => sum + entry.amount, 0);
  const inventoryWaste = inventoryEvents.filter((entry) => entry.kind === "waste").reduce((sum, entry) => sum + entry.amount, 0);
  const inventoryCogs = inventoryIssued - inventoryWaste;
  const fixedCost = manualOccurrences.filter((entry) => entry.expense.category === "fixed").reduce((sum, entry) => sum + entry.amount, 0);
  const operatingCost = manualOccurrences.filter((entry) => entry.expense.category === "operating").reduce((sum, entry) => sum + entry.amount, 0);
  const salesManualCost = manualOccurrences.filter((entry) => entry.expense.category === "sales").reduce((sum, entry) => sum + entry.amount, 0);
  const salesCost = salesManualCost + platformFees;
  const grossProfit = netRevenue - inventoryCogs - inventoryWaste;
  const ebitda = grossProfit - fixedCost - operatingCost - salesCost;
  const operatingProfit = ebitda - depreciation;
  const totalPeriodExpense = inventoryCogs + inventoryWaste + fixedCost + operatingCost + salesCost + depreciation;
  const paidManual = manualOccurrences.filter((entry) => entry.expense.paymentStatus === "paid").reduce((sum, entry) => sum + entry.amount, 0);
  const unpaidManual = manualOccurrences.filter((entry) => entry.expense.paymentStatus !== "paid").reduce((sum, entry) => sum + entry.amount, 0);

  const inventoryPurchases = inventoryLots.filter((lot) => inRange(lot.purchasedOn, bounds)).reduce((sum, lot) => sum + lot.quantity * lot.unitCost, 0);
  const cashIn = periodRevenues.reduce((sum, entry) => sum + (entry.cashReceived || entry.storeRevenue + entry.appRevenue - entry.discounts - entry.platformFees), 0);
  const paidInvestments = assetExpenses.filter((asset) => asset.paymentStatus === "paid" && inRange(asset.paymentDate || asset.incurredOn, bounds)).reduce((sum, asset) => sum + asset.amount, 0);
  // Platform fees are already withheld from the recorded cash received.
  const cashOut = inventoryPurchases + paidManual + paidInvestments;
  const netCash = cashIn - cashOut;

  const openingInventory = inventoryLots.filter((lot) => lot.purchasedOn < bounds.start).reduce((sum, lot) => {
    const issuedBefore = inventorySessions.filter((session) => session.sourceReceiptId === lot.id && session.activatedAt.slice(0, 10) < bounds.start).length;
    return sum + Math.max(0, lot.quantity - issuedBefore) * lot.unitCost;
  }, 0);
  const closingInventory = inventoryLots.filter((lot) => lot.purchasedOn <= bounds.end).reduce((sum, lot) => {
    const issuedByEnd = inventorySessions.filter((session) => session.sourceReceiptId === lot.id && session.activatedAt.slice(0, 10) <= bounds.end).length;
    return sum + Math.max(0, lot.quantity - issuedByEnd) * lot.unitCost;
  }, 0);

  const periodMultiplier = periodMode === "month" ? 1 : periodMode === "quarter" ? 3 : 12;
  const revenueTarget = state.monthlyRevenueTarget * periodMultiplier;
  const cupTarget = state.monthlyCupTarget * periodMultiplier;
  const revenueRemaining = Math.max(0, revenueTarget - netRevenue);
  const cupRemaining = Math.max(0, cupTarget - cups);
  const totalDays = dateDiff(bounds.start, bounds.end) + 1;
  const asOf = today < bounds.start ? bounds.start : today > bounds.end ? bounds.end : today;
  const elapsedDays = today < bounds.start ? 0 : dateDiff(bounds.start, asOf) + 1;
  const remainingDays = Math.max(0, totalDays - elapsedDays);
  const currentRunRate = elapsedDays ? netRevenue / elapsedDays : 0;
  const requiredRunRate = remainingDays ? revenueRemaining / remainingDays : revenueRemaining;
  const requiredCupsPerDay = remainingDays ? Math.ceil(cupRemaining / remainingDays) : cupRemaining;
  const averageTicket = cups ? netRevenue / cups : 50_000;
  const targetProgress = revenueTarget ? Math.min(100, (netRevenue / revenueTarget) * 100) : 0;
  const grossMargin = netRevenue ? (grossProfit / netRevenue) * 100 : 0;

  const chartValues = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const entry of periodRevenues) {
      const key = periodMode === "month" ? entry.date.slice(8, 10) : entry.date.slice(0, 7);
      grouped.set(key, (grouped.get(key) || 0) + entry.storeRevenue + entry.appRevenue - entry.discounts);
    }
    return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, value]) => ({ label: periodMode === "month" ? String(Number(label)) : label.slice(5, 7), value }));
  }, [periodRevenues, periodMode]);

  const filteredManualExpenses = activeExpenses.filter((expense) => expense.category === expenseCategory && (expense.category === "investment" ? inRange(expense.incurredOn, bounds) || expense.incurredOn <= bounds.end : expenseOccurrences(expense, bounds).length > 0));
  const selectedInventoryEvents = expenseCategory === "operating" ? inventoryEvents : [];

  function openAddExpense(category: ExpenseCategory) {
    if (currentPeriodClosed) { window.alert("Kỳ này đã khóa sổ. Hãy mở lại kỳ hoặc tạo giao dịch ở tháng hiện tại."); return; }
    setEditingExpenseId(undefined);
    setExpenseForm(expenseFormDefaults(category));
    setShowExpenseForm(true);
  }

  function openEditExpense(expense: ExpenseRecord) {
    if (currentPeriodClosed) { window.alert("Kỳ này đã khóa sổ và không thể sửa trực tiếp."); return; }
    setEditingExpenseId(expense.id);
    setExpenseForm({ name: expense.name, category: expense.category, subcategory: expense.subcategory, amount: amountInput(String(expense.amount)), incurredOn: expense.incurredOn, recurrence: expense.recurrence, paymentStatus: expense.paymentStatus, paymentDate: expense.paymentDate || "", invoiceCode: expense.invoiceCode || "", vendor: expense.vendor || "", note: expense.note || "", usefulLifeMonths: String(expense.usefulLifeMonths || 36), salvageValue: amountInput(String(expense.salvageValue || 0)), inServiceOn: expense.inServiceOn || expense.incurredOn });
    setShowExpenseForm(true);
  }

  function saveExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = parseAmount(expenseForm.amount);
    if (!expenseForm.name.trim() || !amount) return;
    const record: ExpenseRecord = { id: editingExpenseId || crypto.randomUUID(), name: expenseForm.name.trim(), category: expenseForm.category, subcategory: expenseForm.subcategory.trim() || "Khác", amount, incurredOn: expenseForm.incurredOn, recurrence: expenseForm.category === "investment" ? "once" : expenseForm.recurrence, paymentStatus: expenseForm.paymentStatus, paymentDate: expenseForm.paymentStatus === "paid" ? expenseForm.paymentDate || expenseForm.incurredOn : undefined, invoiceCode: expenseForm.invoiceCode.trim() || undefined, vendor: expenseForm.vendor.trim() || undefined, note: expenseForm.note.trim() || undefined, usefulLifeMonths: expenseForm.category === "investment" ? Math.max(1, Number(expenseForm.usefulLifeMonths) || 36) : undefined, salvageValue: expenseForm.category === "investment" ? parseAmount(expenseForm.salvageValue) : undefined, inServiceOn: expenseForm.category === "investment" ? expenseForm.inServiceOn : undefined, status: "active" };
    setState((current) => ({ ...current, expenses: editingExpenseId ? current.expenses.map((entry) => entry.id === editingExpenseId ? record : entry) : [record, ...current.expenses] }));
    setExpenseCategory(record.category);
    setShowExpenseForm(false);
    setEditingExpenseId(undefined);
  }

  function voidExpense(expense: ExpenseRecord) {
    if (currentPeriodClosed) { window.alert("Kỳ này đã khóa sổ và không thể huỷ giao dịch."); return; }
    if (!window.confirm(`Huỷ giao dịch “${expense.name}”? Lịch sử UAT vẫn được giữ trong local storage.`)) return;
    setState((current) => ({ ...current, expenses: current.expenses.map((entry) => entry.id === expense.id ? { ...entry, status: "voided" } : entry) }));
  }

  function markPaid(expense: ExpenseRecord) {
    if (currentPeriodClosed) { window.alert("Kỳ này đã khóa sổ và không thể cập nhật thanh toán."); return; }
    setState((current) => ({ ...current, expenses: current.expenses.map((entry) => entry.id === expense.id ? { ...entry, paymentStatus: "paid", paymentDate: today } : entry) }));
  }

  function openRevenueEntry() {
    const existing = state.revenues.find((entry) => entry.date === today);
    setRevenueForm(existing ? { date: existing.date, storeRevenue: amountInput(String(existing.storeRevenue)), appRevenue: amountInput(String(existing.appRevenue)), discounts: amountInput(String(existing.discounts)), platformFees: amountInput(String(existing.platformFees)), cashReceived: amountInput(String(existing.cashReceived)), orders: String(existing.orders), cups: String(existing.cups), note: existing.note || "" } : revenueFormDefaults());
    setShowRevenueForm(true);
  }

  function saveRevenue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const record: RevenueRecord = { id: state.revenues.find((entry) => entry.date === revenueForm.date)?.id || crypto.randomUUID(), date: revenueForm.date, storeRevenue: parseAmount(revenueForm.storeRevenue), appRevenue: parseAmount(revenueForm.appRevenue), discounts: parseAmount(revenueForm.discounts), platformFees: parseAmount(revenueForm.platformFees), cashReceived: parseAmount(revenueForm.cashReceived), orders: Number(revenueForm.orders) || 0, cups: Number(revenueForm.cups) || 0, note: revenueForm.note.trim() || undefined };
    setState((current) => ({ ...current, revenues: current.revenues.some((entry) => entry.date === record.date) ? current.revenues.map((entry) => entry.date === record.date ? record : entry) : [record, ...current.revenues] }));
    setShowRevenueForm(false);
  }

  function togglePeriodClose() {
    if (periodMode !== "month") { window.alert("Khóa sổ được thực hiện theo từng tháng."); return; }
    const closing = !currentPeriodClosed;
    if (!window.confirm(closing ? `Khóa sổ ${bounds.label}? Các giao dịch thủ công trong kỳ sẽ không sửa trực tiếp được.` : `Mở lại ${bounds.label} để chỉnh sửa dữ liệu UAT?`)) return;
    setState((current) => ({ ...current, closedPeriods: closing ? [...new Set([...current.closedPeriods, bounds.key])] : current.closedPeriods.filter((key) => key !== bounds.key) }));
  }

  function resetUat() {
    if (!window.confirm("Nạp lại toàn bộ dữ liệu mẫu tài chính local? Các thay đổi UAT hiện tại sẽ mất.")) return;
    setState(seedFinanceState());
  }

  const pnlRows = [
    ["Doanh thu gộp", grossRevenue, "income"], ["Giảm giá / voucher", -discounts, "deduction"], ["Doanh thu thuần", netRevenue, "total"],
    ["NVL đã xuất dùng", -inventoryCogs, "cost"], ["Hao hụt NVL", -inventoryWaste, "cost"], ["Lợi nhuận gộp", grossProfit, "total"],
    ["Chi phí cố định", -fixedCost, "cost"], ["Chi phí vận hành", -operatingCost, "cost"], ["Chi phí bán hàng & nền tảng", -salesCost, "cost"], ["EBITDA", ebitda, "total"],
    ["Khấu hao", -depreciation, "cost"], ["Lợi nhuận hoạt động", operatingProfit, "grand"],
  ] as const;

  return <div className={styles.finance}>
    <header className={styles.financeHero}>
      <span className={styles.eyebrow}>NHA COFFEE & TEA · UAT LOCAL</span>
      <div className={styles.financeHeroRow}><div><h1>Chi phí & tài chính</h1><p>Theo dõi dòng tiền, giá vốn và sức khỏe vận hành trên cùng một màn hình.</p></div><div className={styles.logo}><Image src="/nha-coffee-logo-transparent.png" alt="Nhà Coffee & Tea" width={750} height={420} priority /></div></div>
      <div className={styles.heroMetric}><span>Lợi nhuận hoạt động · {bounds.label}</span><strong>{money(operatingProfit)}</strong><small>{netRevenue ? `${((operatingProfit / netRevenue) * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}% doanh thu thuần` : "Chưa có doanh thu trong kỳ"}</small></div>
    </header>

    <section className={styles.periodPanel}>
      <div className={styles.periodModes}>{(["month", "quarter", "year"] as PeriodMode[]).map((mode) => <button className={periodMode === mode ? styles.selected : ""} key={mode} onClick={() => setPeriodMode(mode)}>{mode === "month" ? "Tháng" : mode === "quarter" ? "Quý" : "Năm"}</button>)}</div>
      <div className={styles.periodPicker}>{periodMode === "month" ? <input type="month" value={selectedMonth} onChange={(event) => { setSelectedMonth(event.target.value); setSelectedYear(Number(event.target.value.slice(0, 4))); }} /> : <><select value={selectedYear} onChange={(event) => setSelectedYear(Number(event.target.value))}>{Array.from({ length: 5 }, (_, index) => new Date().getFullYear() - 2 + index).map((year) => <option key={year}>{year}</option>)}</select>{periodMode === "quarter" && <select value={selectedQuarter} onChange={(event) => setSelectedQuarter(Number(event.target.value))}><option value={1}>Quý 1</option><option value={2}>Quý 2</option><option value={3}>Quý 3</option><option value={4}>Quý 4</option></select>}</>}</div>
      <div className={styles.periodStatus}><b>{bounds.label}</b><span>{currentPeriodClosed ? "● Đã khóa sổ" : "● Đang mở"}</span></div>
    </section>

    <nav className={styles.financeTabs}><button className={tab === "entry" ? styles.active : ""} onClick={() => setTab("entry")}>Ghi nhận chi phí</button><button className={tab === "report" ? styles.active : ""} onClick={() => setTab("report")}>Báo cáo tài chính</button><button className={tab === "dashboard" ? styles.active : ""} onClick={() => setTab("dashboard")}>Dashboard</button></nav>

    {tab === "entry" && <section className={styles.content}>
      <div className={styles.summaryStrip}><div><span>Tổng chi phí kỳ</span><strong>{money(totalPeriodExpense)}</strong></div><div><span>Đã thanh toán</span><strong>{money(paidManual + inventoryPurchases + paidInvestments)}</strong></div><div><span>Chưa thanh toán</span><strong>{money(unpaidManual)}</strong></div><div><span>Từ Kho NVL</span><strong>{money(inventoryCogs + inventoryWaste)}</strong></div></div>
      <div className={styles.sectionHeader}><div><span>GIAO DỊCH TRONG KỲ</span><h2>Chi phí vận hành quán</h2></div><button onClick={() => openAddExpense(expenseCategory)}>+ Thêm chi phí</button></div>
      <div className={styles.categoryTabs}>{(Object.keys(categoryLabels) as ExpenseCategory[]).map((category) => <button key={category} className={expenseCategory === category ? styles.selected : ""} onClick={() => setExpenseCategory(category)}><span>{categoryLabels[category]}</span><b>{category === "operating" ? manualOccurrences.filter((entry) => entry.expense.category === category).length + inventoryEvents.length : category === "investment" ? assetExpenses.length : manualOccurrences.filter((entry) => entry.expense.category === category).length}</b></button>)}</div>
      <div className={styles.expenseList}>
        {selectedInventoryEvents.map((entry) => <article className={`${styles.expenseCard} ${entry.kind === "waste" ? styles.wasteCard : ""}`} key={entry.id}><div className={styles.expenseMain}><div className={styles.sourceIcon}>K</div><div><span className={styles.sourceLabel}>TỰ ĐỘNG TỪ KHO NVL</span><h3>{entry.lot.name} · 1 {entry.lot.unit}</h3><p>Phiếu {entry.lot.receiptCode || "chưa có mã"} · {entry.kind === "waste" ? "Báo hỏng" : "Active"} {dateLabel(entry.date)}</p></div></div><div className={styles.expenseValue}><strong>{money(entry.amount)}</strong><span>{entry.kind === "waste" ? "Tái phân loại hao hụt" : "NVL xuất dùng"}</span></div><button className={styles.sourceButton} onClick={() => onOpenInventoryLot(entry.lot.id)}>Xem lô nguồn →</button></article>)}
        {filteredManualExpenses.map((expense) => <article className={styles.expenseCard} key={expense.id}><div className={styles.expenseMain}><div className={styles.sourceIcon}>{expense.category === "fixed" ? "C" : expense.category === "operating" ? "V" : expense.category === "sales" ? "B" : "Đ"}</div><div><span className={styles.sourceLabel}>{categoryLabels[expense.category].toUpperCase()}</span><h3>{expense.name}</h3><p>{expense.subcategory} · {recurrenceLabels[expense.recurrence]} · {dateLabel(expense.incurredOn)}</p></div></div><div className={styles.expenseValue}><strong>{money(expense.amount)}</strong><span className={expense.paymentStatus === "paid" ? styles.paid : styles.unpaid}>{paymentLabels[expense.paymentStatus]}</span></div><div className={styles.cardActions}>{expense.paymentStatus !== "paid" && <button onClick={() => markPaid(expense)}>Đã trả</button>}<button onClick={() => openEditExpense(expense)}>Sửa</button><button onClick={() => voidExpense(expense)}>Huỷ</button></div></article>)}
        {!selectedInventoryEvents.length && !filteredManualExpenses.length && <div className={styles.empty}><b>Chưa có chi phí trong nhóm này</b><span>Nhấn “Thêm chi phí” để tạo giao dịch đầu tiên.</span></div>}
      </div>
      <div className={styles.uatTools}><span>Dữ liệu tài chính hiện chỉ lưu trong trình duyệt để UAT.</span><button onClick={resetUat}>Nạp lại dữ liệu mẫu</button></div>
    </section>}

    {tab === "report" && <section className={styles.content}>
      <div className={styles.reportHeader}><div><span>BÁO CÁO QUẢN TRỊ F&B</span><h2>{bounds.label}</h2></div><button className={currentPeriodClosed ? styles.reopenButton : styles.closePeriodButton} onClick={togglePeriodClose}>{currentPeriodClosed ? "Mở lại kỳ" : "Khóa sổ kỳ"}</button></div>
      <div className={styles.reportTabs}>{(["pnl", "cash", "inventory", "assets"] as ReportView[]).map((view) => <button className={reportView === view ? styles.selected : ""} key={view} onClick={() => setReportView(view)}>{view === "pnl" ? "P&L" : view === "cash" ? "Dòng tiền" : view === "inventory" ? "Tồn kho" : "Tài sản & khấu hao"}</button>)}</div>
      {reportView === "pnl" && <div className={styles.financialTable}>{pnlRows.map(([label, value, tone]) => <div className={`${styles.financialRow} ${styles[tone]}`} key={label}><span>{label}</span><strong>{money(value)}</strong><small>{netRevenue && label !== "Doanh thu gộp" && label !== "Giảm giá / voucher" ? `${(Math.abs(value) / netRevenue * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}% DT` : ""}</small></div>)}</div>}
      {reportView === "cash" && <div className={styles.reportGrid}><article className={styles.reportCard}><span>TIỀN VÀO</span><strong>{money(cashIn)}</strong><p>Tiền thực nhận từ bán hàng, đã trừ phí nền tảng.</p></article><article className={styles.reportCard}><span>TIỀN RA</span><strong>{money(cashOut)}</strong><p>NVL, chi phí đã trả và mua tài sản.</p></article><article className={`${styles.reportCard} ${netCash < 0 ? styles.negative : ""}`}><span>DÒNG TIỀN THUẦN</span><strong>{money(netCash)}</strong><p>{netCash >= 0 ? "Dòng tiền kỳ này đang dương." : "Chi ra đang lớn hơn tiền thực nhận."}</p></article><div className={styles.cashBreakdown}><div><span>Thu bán hàng sau phí nền tảng</span><b>{money(cashIn)}</b></div><div><span>Mua NVL</span><b>-{money(inventoryPurchases)}</b></div><div><span>Chi phí đã trả</span><b>-{money(paidManual)}</b></div><div><span>Mua tài sản</span><b>-{money(paidInvestments)}</b></div></div></div>}
      {reportView === "inventory" && <div className={styles.inventoryBridge}><div><span>Tồn đầu kỳ</span><strong>{money(openingInventory)}</strong></div><i>+</i><div><span>Nhập kho</span><strong>{money(inventoryPurchases)}</strong></div><i>−</i><div><span>Xuất dùng</span><strong>{money(inventoryIssued)}</strong></div><i>=</i><div className={styles.bridgeTotal}><span>Tồn cuối kỳ</span><strong>{money(closingInventory)}</strong></div><p>Hao hụt trong kỳ: <b>{money(inventoryWaste)}</b> · {inventoryEvents.filter((entry) => entry.kind === "waste").length} đơn vị (tái phân loại từ giá vốn, không ghi nhận chi phí hai lần)</p></div>}
      {reportView === "assets" && <div className={styles.assetList}>{assetExpenses.map((asset) => { const monthly = Math.max(0, asset.amount - (asset.salvageValue || 0)) / (asset.usefulLifeMonths || 1); const elapsed = Math.min(asset.usefulLifeMonths || 0, Math.max(0, monthDiff(asset.inServiceOn || asset.incurredOn, bounds.end) + 1)); const accumulated = monthly * elapsed; const remaining = Math.max(asset.salvageValue || 0, asset.amount - accumulated); return <article className={styles.assetCard} key={asset.id}><div><span>{asset.subcategory}</span><h3>{asset.name}</h3><p>Đưa vào sử dụng {dateLabel(asset.inServiceOn || asset.incurredOn)}</p></div><div><small>Nguyên giá</small><strong>{money(asset.amount)}</strong></div><div><small>Khấu hao/tháng</small><strong>{money(monthly)}</strong></div><div><small>Giá trị còn lại</small><strong>{money(remaining)}</strong></div><div className={styles.assetProgress}><i style={{ width: `${asset.amount ? Math.min(100, accumulated / asset.amount * 100) : 0}%` }} /></div><p>Đã khấu hao {elapsed}/{asset.usefulLifeMonths} tháng</p></article>; })}</div>}
    </section>}

    {tab === "dashboard" && <section className={`${styles.content} ${styles.dashboard}`}>
      <div className={styles.dashboardActions}><div><span>DASHBOARD ĐIỀU HÀNH</span><h2>Tiến độ {bounds.label.toLowerCase()}</h2></div><button onClick={openRevenueEntry}>+ Cập nhật hôm nay</button></div>
      <div className={styles.targetCard}><div><span>MỤC TIÊU DOANH THU</span><strong>{money(revenueTarget)}</strong><p>Đã đạt {money(netRevenue)} · còn thiếu {money(revenueRemaining)}</p></div><div className={styles.targetPercent}>{targetProgress.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%</div><div className={styles.progressTrack}><i style={{ width: `${targetProgress}%` }} /></div><div className={styles.targetInputs}><label>Mục tiêu tháng<input value={amountInput(String(state.monthlyRevenueTarget))} onChange={(event) => setState((current) => ({ ...current, monthlyRevenueTarget: parseAmount(event.target.value) }))} /></label><label>Mục tiêu ly<input type="number" value={state.monthlyCupTarget} onChange={(event) => setState((current) => ({ ...current, monthlyCupTarget: Number(event.target.value) || 0 }))} /></label></div></div>
      <div className={styles.kpiGrid}><article><span>Run rate hiện tại</span><strong>{money(currentRunRate)}</strong><small>mỗi ngày</small></article><article className={requiredRunRate > currentRunRate ? styles.attention : ""}><span>Run rate cần đạt</span><strong>{money(requiredRunRate)}</strong><small>{remainingDays} ngày còn lại</small></article><article><span>Ly đã bán</span><strong>{cups.toLocaleString("vi-VN")}</strong><small>{orders.toLocaleString("vi-VN")} đơn hàng</small></article><article className={styles.cupsNeeded}><span>Ly còn thiếu</span><strong>{cupRemaining.toLocaleString("vi-VN")}</strong><small>≈ {requiredCupsPerDay.toLocaleString("vi-VN")} ly/ngày</small></article></div>
      <div className={styles.chartGrid}><article className={styles.chartCard}><div><span>DOANH THU THEO {periodMode === "month" ? "NGÀY" : "THÁNG"}</span><strong>{money(netRevenue)}</strong></div><MiniBars values={chartValues} target={periodMode === "month" ? requiredRunRate : revenueTarget / Math.max(1, chartValues.length)} /></article><article className={styles.runRateCard}><span>RUN RATE</span><div className={styles.runRateCompare}><div><b>{compactMoney(currentRunRate)}</b><small>Hiện tại</small></div><div><b>{compactMoney(requiredRunRate)}</b><small>Cần đạt</small></div></div><div className={styles.runRateTrack}><i style={{ width: `${requiredRunRate ? Math.min(100, currentRunRate / requiredRunRate * 100) : 100}%` }} /></div><p>{currentRunRate >= requiredRunRate ? "Đang đi đúng hoặc vượt nhịp mục tiêu." : `Cần tăng thêm ${money(requiredRunRate - currentRunRate)} mỗi ngày.`}</p></article></div>
      <div className={styles.chartGrid}><article className={styles.costMixCard}><div><span>CƠ CẤU CHI PHÍ</span><strong>{money(totalPeriodExpense)}</strong></div><div className={styles.donut} style={{ background: `conic-gradient(#171916 0 ${totalPeriodExpense ? (inventoryCogs + inventoryWaste) / totalPeriodExpense * 100 : 0}%, #887a5d 0 ${totalPeriodExpense ? (inventoryCogs + inventoryWaste + fixedCost) / totalPeriodExpense * 100 : 0}%, #c9b896 0 ${totalPeriodExpense ? (inventoryCogs + inventoryWaste + fixedCost + operatingCost) / totalPeriodExpense * 100 : 0}%, #e9dfca 0 100%)` }}><i>{grossMargin.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%<small>gross margin</small></i></div><div className={styles.legend}><span><i className={styles.legendDark} />NVL {money(inventoryCogs + inventoryWaste)}</span><span><i className={styles.legendBrown} />Cố định {money(fixedCost)}</span><span><i className={styles.legendSand} />Vận hành {money(operatingCost)}</span><span><i className={styles.legendCream} />Bán hàng {money(salesCost)}</span></div></article><article className={styles.forecastCard}><span>DỰ BÁO CUỐI KỲ</span><strong>{money(netRevenue + currentRunRate * remainingDays)}</strong><p>Dựa trên run rate trung bình hiện tại.</p><div><span>Giá trị TB/ly</span><b>{money(averageTicket)}</b></div><div><span>EBITDA hiện tại</span><b className={ebitda < 0 ? styles.redText : ""}>{money(ebitda)}</b></div><div><span>Khấu hao kỳ</span><b>{money(depreciation)}</b></div><div><span>Tồn kho hiện tại</span><b>{money(closingInventory)}</b></div></article></div>
    </section>}

    {showExpenseForm && <div className={styles.backdrop} role="presentation" onMouseDown={() => setShowExpenseForm(false)}><form className={styles.sheet} onSubmit={saveExpense} onMouseDown={(event) => event.stopPropagation()}><div className={styles.sheetHandle} /><div className={styles.sheetTitle}><div><span>{editingExpenseId ? "CẬP NHẬT" : "GHI NHẬN"}</span><h2>{categoryLabels[expenseForm.category]}</h2></div><button type="button" onClick={() => setShowExpenseForm(false)}>×</button></div><label>Category<select value={expenseForm.category} onChange={(event) => setExpenseForm((current) => ({ ...current, category: event.target.value as ExpenseCategory, recurrence: event.target.value === "fixed" ? "monthly" : "once" }))}>{(Object.keys(categoryLabels) as ExpenseCategory[]).map((category) => <option value={category} key={category}>{categoryLabels[category]}</option>)}</select></label><label>Tên chi phí / tài sản<input autoFocus required value={expenseForm.name} onChange={(event) => setExpenseForm((current) => ({ ...current, name: event.target.value }))} placeholder="Ví dụ: Tiền thuê mặt bằng" /></label><div className={styles.formRow}><label>Subcategory<input value={expenseForm.subcategory} onChange={(event) => setExpenseForm((current) => ({ ...current, subcategory: event.target.value }))} placeholder="Ví dụ: Mặt bằng" /></label><label>Số tiền<input required inputMode="numeric" value={expenseForm.amount} onChange={(event) => setExpenseForm((current) => ({ ...current, amount: amountInput(event.target.value) }))} placeholder="15,000,000" /></label></div><div className={styles.formRow}><label>Ngày ghi nhận<input required type="date" value={expenseForm.incurredOn} onChange={(event) => setExpenseForm((current) => ({ ...current, incurredOn: event.target.value }))} /></label>{expenseForm.category !== "investment" && <label>Chu kỳ<select value={expenseForm.recurrence} onChange={(event) => setExpenseForm((current) => ({ ...current, recurrence: event.target.value as Recurrence }))}>{(Object.keys(recurrenceLabels) as Recurrence[]).map((recurrence) => <option value={recurrence} key={recurrence}>{recurrenceLabels[recurrence]}</option>)}</select></label>}</div>{expenseForm.category === "investment" && <><div className={styles.formRow}><label>Ngày sử dụng<input type="date" value={expenseForm.inServiceOn} onChange={(event) => setExpenseForm((current) => ({ ...current, inServiceOn: event.target.value }))} /></label><label>Khấu hao (tháng)<input min="1" type="number" value={expenseForm.usefulLifeMonths} onChange={(event) => setExpenseForm((current) => ({ ...current, usefulLifeMonths: event.target.value }))} /></label></div><label>Giá trị thu hồi<input inputMode="numeric" value={expenseForm.salvageValue} onChange={(event) => setExpenseForm((current) => ({ ...current, salvageValue: amountInput(event.target.value) }))} /></label></>}<div className={styles.formRow}><label>Thanh toán<select value={expenseForm.paymentStatus} onChange={(event) => setExpenseForm((current) => ({ ...current, paymentStatus: event.target.value as PaymentStatus }))}>{(Object.keys(paymentLabels) as PaymentStatus[]).map((status) => <option value={status} key={status}>{paymentLabels[status]}</option>)}</select></label>{expenseForm.paymentStatus === "paid" && <label>Ngày thanh toán<input type="date" value={expenseForm.paymentDate} onChange={(event) => setExpenseForm((current) => ({ ...current, paymentDate: event.target.value }))} /></label>}</div><div className={styles.formRow}><label>Mã hóa đơn<input value={expenseForm.invoiceCode} onChange={(event) => setExpenseForm((current) => ({ ...current, invoiceCode: event.target.value }))} /></label><label>Nhà cung cấp<input value={expenseForm.vendor} onChange={(event) => setExpenseForm((current) => ({ ...current, vendor: event.target.value }))} /></label></div><label>Note<textarea value={expenseForm.note} onChange={(event) => setExpenseForm((current) => ({ ...current, note: event.target.value }))} placeholder="Ghi chú nội bộ" /></label><button className={styles.primaryButton} type="submit">{editingExpenseId ? "Lưu thay đổi" : "Ghi nhận chi phí"}</button></form></div>}

    {showRevenueForm && <div className={styles.backdrop} role="presentation" onMouseDown={() => setShowRevenueForm(false)}><form className={styles.sheet} onSubmit={saveRevenue} onMouseDown={(event) => event.stopPropagation()}><div className={styles.sheetHandle} /><div className={styles.sheetTitle}><div><span>CẬP NHẬT HẰNG NGÀY</span><h2>Doanh thu & số ly</h2></div><button type="button" onClick={() => setShowRevenueForm(false)}>×</button></div><label>Ngày<input required type="date" value={revenueForm.date} onChange={(event) => setRevenueForm((current) => ({ ...current, date: event.target.value }))} /></label><div className={styles.formRow}><label>Doanh thu tại quán<input inputMode="numeric" value={revenueForm.storeRevenue} onChange={(event) => setRevenueForm((current) => ({ ...current, storeRevenue: amountInput(event.target.value) }))} /></label><label>Doanh thu app<input inputMode="numeric" value={revenueForm.appRevenue} onChange={(event) => setRevenueForm((current) => ({ ...current, appRevenue: amountInput(event.target.value) }))} /></label></div><div className={styles.formRow}><label>Voucher quán chịu<input inputMode="numeric" value={revenueForm.discounts} onChange={(event) => setRevenueForm((current) => ({ ...current, discounts: amountInput(event.target.value) }))} /></label><label>Phí nền tảng<input inputMode="numeric" value={revenueForm.platformFees} onChange={(event) => setRevenueForm((current) => ({ ...current, platformFees: amountInput(event.target.value) }))} /></label></div><div className={styles.formRow}><label>Số đơn<input min="0" type="number" value={revenueForm.orders} onChange={(event) => setRevenueForm((current) => ({ ...current, orders: event.target.value }))} /></label><label>Số ly<input min="0" type="number" value={revenueForm.cups} onChange={(event) => setRevenueForm((current) => ({ ...current, cups: event.target.value }))} /></label></div><label>Tiền thực nhận<input inputMode="numeric" value={revenueForm.cashReceived} onChange={(event) => setRevenueForm((current) => ({ ...current, cashReceived: amountInput(event.target.value) }))} /><small>Để trống sẽ lấy doanh thu thuần trừ phí nền tảng.</small></label><label>Note<textarea value={revenueForm.note} onChange={(event) => setRevenueForm((current) => ({ ...current, note: event.target.value }))} /></label><button className={styles.primaryButton} type="submit">Lưu cập nhật hôm nay</button></form></div>}
  </div>;
}

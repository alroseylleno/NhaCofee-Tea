"use client";

import Image from "next/image";
import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import {
  deleteFinanceGrabReconciliation,
  loadFinanceImports,
  replaceFinanceImportBundle,
  upsertFinanceExpenses,
  upsertFinanceGrabReconciliations,
  type FinanceExpenseRecord,
  type FinanceGrabReconciliationRecord,
  type FinanceImportMeta,
  type FinancePlatformOrderRecord,
  type FinanceProductRecord,
  type FinanceRevenueRecord,
  type FinanceServiceRecord,
} from "@/lib/finance-store";
import { isSupabaseConfigured } from "@/lib/supabase";
import styles from "./finance.module.css";

export type FinanceInventoryLot = {
  id: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  unitCost: number;
  purchasedOn: string;
  receiptCode?: string;
  internalReturn?: boolean;
  availableFrom?: string;
};

export type FinanceInventorySession = {
  id: string;
  sourceReceiptId: string;
  activatedAt: string;
  costRecognitionMonth?: string;
  status: "active" | "used" | "wasted";
  closedAt?: string;
  reason: string;
  recognizedCost?: number;
};

type FinanceTab = "entry" | "revenue" | "report" | "dashboard";
type PeriodMode = "month" | "quarter" | "year";
type ExpenseCategory = "fixed" | "operating" | "sales" | "investment";
type Recurrence = "once" | "weekly" | "monthly" | "quarterly" | "yearly";
type PaymentStatus = "unpaid" | "partial" | "paid";
type ReportView = "pnl" | "cash" | "inventory" | "assets";
type RevenueSubTab = "overview" | "products" | "platform";

type ExpenseRecord = FinanceExpenseRecord;
type PlatformOrderRecord = FinancePlatformOrderRecord;

type FinanceState = {
  expenses: ExpenseRecord[];
  revenues: FinanceRevenueRecord[];
  products: FinanceProductRecord[];
  services: FinanceServiceRecord[];
  platformOrders: PlatformOrderRecord[];
  imports: FinanceImportMeta[];
  importHistory: FinanceImportMeta[];
  productSnapshots: Array<{ meta: FinanceImportMeta; records: FinanceProductRecord[] }>;
  serviceSnapshots: Array<{ meta: FinanceImportMeta; records: FinanceServiceRecord[] }>;
  growthTargetPercent: number;
  revenueTargetAmount: number;
  closedPeriods: string[];
  grabReconciliations: GrabReconciliationRecord[];
};

type GrabReconciliationRecord = FinanceGrabReconciliationRecord;

type ExpenseForm = {
  name: string;
  category: ExpenseCategory;
  subcategory: string;
  subcategoryIsCustom: boolean;
  amount: string;
  incurredOn: string;
  recurrence: Recurrence;
  paymentStatus: PaymentStatus;
  paymentDate: string;
  invoiceCode: string;
  vendor: string;
  vendorIsCustom: boolean;
  note: string;
  usefulLifeMonths: string;
  salvageValue: string;
  inServiceOn: string;
};

type GrabReconciliationForm = {
  id?: string;
  platformOrderId: string;
  orderCode: string;
  orderDate: string;
  reportedAmount: string;
  receivedAmount: string;
  note: string;
};

type PeriodBounds = { start: string; end: string; label: string; key: string };
type PnlDetail = { label: string; amount: number; date?: string };
type PnlGroup = { label: string; details: PnlDetail[]; value: number };
type PnlRow = { label: string; value: number; tone: "income" | "deduction" | "cost" | "total" | "grand"; details: PnlDetail[]; groups?: PnlGroup[]; itemCount?: number };
type ImportMetaInput = Omit<FinanceImportMeta, "dataType" | "importedAt">;
type ParsedRevenueImport = { type: "revenue"; meta: ImportMetaInput; importMeta: FinanceImportMeta; records: FinanceRevenueRecord[]; latestDate: string };
type ParsedProductImport = { type: "products"; meta: ImportMetaInput; importMeta: FinanceImportMeta; records: FinanceProductRecord[] };
type ParsedServiceImport = { type: "service"; meta: ImportMetaInput; importMeta: FinanceImportMeta; records: FinanceServiceRecord[] };
type ParsedOrderImport = { type: "orders"; meta: ImportMetaInput; importMeta: FinanceImportMeta; records: PlatformOrderRecord[]; latestDate: string; periodStart: string; periodEnd: string };
type ParsedFinanceImport = ParsedRevenueImport | ParsedProductImport | ParsedServiceImport | ParsedOrderImport;

const FINANCE_STORAGE_KEY = "nha-ops-finance-v2";
const FINANCE_PROD_LEGACY_STORAGE_KEY = "nha-ops-finance-v1";
const FINANCE_EXPENSE_MIGRATION_KEY = "nha-ops-finance-expenses-migrated-v1";
const FINANCE_UAT_STORAGE_KEY = "nha-ops-finance-uat-v2";
const FINANCE_LEGACY_UAT_STORAGE_KEY = "nha-ops-finance-uat-v1";
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
function dateLabel(value: string) { const [year, month, day] = value.split("-"); return day && month && year ? `${day}/${month}/${year}` : value; }
function parseVietnameseDate(value: string) { const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); if (!match) return undefined; const [, day, month, year] = match; const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))); if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return undefined; return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`; }
function VietnameseDateInput({ value, onChange, required = false }: { value: string; onChange: (value: string) => void; required?: boolean }) {
  const [display, setDisplay] = useState(dateLabel(value));
  useEffect(() => setDisplay(dateLabel(value)), [value]);
  function commit() { if (!display.trim()) { onChange(""); return; } const parsed = parseVietnameseDate(display); if (parsed) { onChange(parsed); setDisplay(dateLabel(parsed)); } else setDisplay(dateLabel(value)); }
  return <input required={required} type="text" inputMode="numeric" value={display} onChange={(event) => setDisplay(event.target.value)} onBlur={commit} placeholder="dd/mm/yyyy" aria-label="Ngày theo định dạng dd/mm/yyyy" />;
}
function parseAmount(value: string) { return Number(value.replace(/\D/g, "")); }
function amountInput(value: string) { const digits = value.replace(/\D/g, ""); return digits ? Number(digits).toLocaleString("en-US") : ""; }
function dateAt(year: number, month: number, day: number) { return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }
function daysInMonth(year: number, month: number) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function addDaysISO(value: string, days: number) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function monthDiff(start: string, end: string) { const [sy, sm] = start.slice(0, 7).split("-").map(Number); const [ey, em] = end.slice(0, 7).split("-").map(Number); return (ey - sy) * 12 + em - sm; }
function selectableMonthOptions(startMonth: string, endMonth: string) {
  const [startYear, startMonthNumber] = startMonth.split("-").map(Number);
  const [endYear, endMonthNumber] = endMonth.split("-").map(Number);
  if (!startYear || !startMonthNumber || !endYear || !endMonthNumber) return [] as Array<{ value: string; label: string }>;
  const options: Array<{ value: string; label: string }> = [];
  let year = endYear;
  let month = endMonthNumber;
  while (year > startYear || (year === startYear && month >= startMonthNumber)) {
    options.push({ value: `${year}-${String(month).padStart(2, "0")}`, label: `Tháng ${String(month).padStart(2, "0")}/${year}` });
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  return options;
}
function inRange(value: string, bounds: PeriodBounds) { return value >= bounds.start && value <= bounds.end; }
function percent(value: number) { return `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`; }
function normalizedHeader(value: unknown) { return String(value ?? "").trim().toLocaleLowerCase("vi").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/\s+/g, " "); }
function platformSignal(value: unknown) { return normalizedHeader(value).replace(/[._-]+/g, " "); }
function isKnownPlatformSignal(value: unknown) {
  return /grab\s*food|grabfood|shopee\s*food|shopeefood|green\s*food|greenfood|(^|\s)xanh(\s|$)|website|be\s*food|gofood/.test(platformSignal(value));
}
function numericCell(value: unknown) { if (typeof value === "number") return Number.isFinite(value) ? value : 0; const parsed = Number(String(value ?? "").replace(/,/g, "").replace(/[^\d.-]/g, "")); return Number.isFinite(parsed) ? parsed : 0; }
function excelDateCell(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return dateAt(value.getFullYear(), value.getMonth() + 1, value.getDate());
  if (typeof value === "number" && Number.isFinite(value)) return new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000).toISOString().slice(0, 10);
  const text = String(value ?? "").trim();
  const vietnamese = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (vietnamese) return dateAt(Number(vietnamese[3]), Number(vietnamese[2]), Number(vietnamese[1]));
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return iso ? dateAt(Number(iso[1]), Number(iso[2]), Number(iso[3])) : undefined;
}

function excelDateTimeCell(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${dateAt(value.getFullYear(), value.getMonth() + 1, value.getDate())}T${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}:${String(value.getSeconds()).padStart(2, "0")}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = Math.round(value * 86_400_000);
    const date = new Date(Date.UTC(1899, 11, 30) + milliseconds);
    return `${dateAt(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())}T${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
  }
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return undefined;
  return `${dateAt(Number(match[3]), Number(match[2]), Number(match[1]))}T${String(match[4] || "0").padStart(2, "0")}:${match[5] || "00"}:${match[6] || "00"}`;
}

function firstColumn(headers: string[], names: string[]) { return names.map((name) => headers.indexOf(name)).find((index) => index >= 0) ?? -1; }
function firstText(row: unknown[], headers: string[], names: string[]) { const index = firstColumn(headers, names); return index >= 0 ? String(row[index] ?? "").trim() : ""; }
function firstNumber(row: unknown[], headers: string[], names: string[]) { const index = firstColumn(headers, names); return index >= 0 ? numericCell(row[index]) : 0; }
function firstDate(row: unknown[], headers: string[], names: string[]) { const index = firstColumn(headers, names); return index >= 0 ? excelDateCell(row[index]) : undefined; }

function parseExpenseRows(file: File, rows: unknown[][]): ExpenseRecord[] {
  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizedHeader);
    return headers.includes("ten chi phi / tai san") && headers.includes("so tien") && headers.includes("ngay ghi nhan");
  });
  if (headerRowIndex < 0) throw new Error(`${file.name}: không đúng template Ghi nhận chi phí.`);
  const headers = rows[headerRowIndex].map(normalizedHeader);
  const column = (name: string) => headers.indexOf(name);
  const text = (row: unknown[], name: string) => { const index = column(name); return index >= 0 ? String(row[index] ?? "").trim() : ""; };
  const categoryByLabel: Record<string, ExpenseCategory> = {
    fixed: "fixed", operating: "operating", sales: "sales", investment: "investment",
    "chi phi co dinh": "fixed", "chi phi van hanh": "operating", "chi phi ban hang": "sales", "dau tu ban dau": "investment",
  };
  const recurrenceByLabel: Record<string, Recurrence> = {
    once: "once", weekly: "weekly", monthly: "monthly", quarterly: "quarterly", yearly: "yearly",
    "mot lan": "once", "hang tuan": "weekly", "hang thang": "monthly", "hang quy": "quarterly", "hang nam": "yearly",
  };
  const paymentByLabel: Record<string, PaymentStatus> = {
    unpaid: "unpaid", partial: "partial", paid: "paid",
    "chua thanh toan": "unpaid", "thanh toan mot phan": "partial", "da thanh toan": "paid",
  };
  const statusByLabel: Record<string, ExpenseRecord["status"]> = { active: "active", voided: "voided", "dang hoat dong": "active", "da huy": "voided" };
  const records: ExpenseRecord[] = [];
  for (const [index, row] of rows.slice(headerRowIndex + 1).entries()) {
    const name = text(row, "ten chi phi / tai san");
    if (!name) continue;
    const amount = numericCell(row[column("so tien")]);
    const incurredOn = excelDateCell(row[column("ngay ghi nhan")]);
    if (!amount || !incurredOn) throw new Error(`${file.name}: dòng ${headerRowIndex + index + 2} thiếu số tiền hoặc ngày ghi nhận hợp lệ.`);
    const category = categoryByLabel[normalizedHeader(text(row, "category"))];
    if (!category) throw new Error(`${file.name}: dòng ${headerRowIndex + index + 2} có Category không hợp lệ.`);
    const recurrence = category === "investment" ? "once" : recurrenceByLabel[normalizedHeader(text(row, "chu ky"))] || "once";
    const paymentStatus = paymentByLabel[normalizedHeader(text(row, "thanh toan"))] || "unpaid";
    const usefulLifeMonths = numericCell(row[column("khau hao (thang)")]);
    const salvageValue = numericCell(row[column("gia tri thu hoi")]);
    records.push({
      id: text(row, "id (khong sua)") || crypto.randomUUID(),
      name,
      category,
      subcategory: text(row, "subcategory") || "Khác",
      amount,
      incurredOn,
      recurrence,
      paymentStatus,
      paymentDate: excelDateCell(row[column("ngay thanh toan")]),
      invoiceCode: text(row, "ma hoa don") || undefined,
      vendor: text(row, "nha cung cap") || undefined,
      note: text(row, "ghi chu") || undefined,
      usefulLifeMonths: category === "investment" ? Math.max(1, usefulLifeMonths || 36) : undefined,
      salvageValue: category === "investment" ? Math.max(0, salvageValue) : undefined,
      inServiceOn: category === "investment" ? excelDateCell(row[column("ngay su dung")]) || incurredOn : undefined,
      status: statusByLabel[normalizedHeader(text(row, "trang thai"))] || "active",
    });
  }
  if (!records.length) throw new Error(`${file.name}: không có dòng chi phí hợp lệ.`);
  return records;
}

function reportPeriod(text?: string) {
  const matches = [...String(text || "").matchAll(/(\d{1,2})\/(\d{1,2})\/(\d{4})/g)];
  if (matches.length < 2) return undefined;
  return {
    start: dateAt(Number(matches[0][3]), Number(matches[0][2]), Number(matches[0][1])),
    end: dateAt(Number(matches[1][3]), Number(matches[1][2]), Number(matches[1][1])),
  };
}

function financeTemplateType(rows: unknown[][]) {
  for (const row of rows) {
    const headers = row.map(normalizedHeader);
    if (headers.includes("ngay") && headers.includes("sl don hang") && headers.includes("doanh thu thuc")) return "revenue" as const;
    if (headers.includes("ten danh muc") && headers.includes("ma mat hang") && headers.includes("ten mat hang") && (headers.includes("tong tien") || headers.includes("tien hang"))) return "products" as const;
    if ((headers.includes("loai don hang") || headers.includes("ten") || headers.includes("phuong thuc thanh toan")) && headers.includes("sl don hang") && headers.includes("so don huy") && (headers.includes("tien thu duoc") || headers.includes("doanh thu gom thue") || headers.includes("doanh thu"))) return "service" as const;
    const hasOrderCode = firstColumn(headers, ["ma don hang", "ma don", "ma hoa don", "so hoa don", "order code", "order id"]) >= 0;
    const hasDate = firstColumn(headers, ["ngay", "ngay tao", "ngay dat hang", "thoi gian tao", "thoi gian dat hang", "thoi gian tao don"]) >= 0;
    const hasAmount = firstColumn(headers, ["doanh thu thuc", "tien thu duoc", "tong tien", "thanh tien", "khach phai tra", "gia tri don hang", "tong tien thanh toan (1 + 2 + 3 - 4 + 5)"]) >= 0;
    if (hasOrderCode && hasDate && hasAmount) return "orders" as const;
  }
  return undefined;
}

function parseRevenueRows(file: File, rows: unknown[][]): ParsedRevenueImport {
  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizedHeader);
    return headers.includes("ngay") && headers.includes("sl don hang") && headers.includes("doanh thu thuc");
  });
  if (headerRowIndex < 0) throw new Error(`${file.name}: không tìm thấy bảng Doanh thu tổng quan.`);
  const headers = rows[headerRowIndex].map(normalizedHeader);
  const column = (name: string) => headers.indexOf(name);
  const requiredColumns = ["ngay", "sl don hang", "so luong hang", "doanh thu thuc"];
  if (requiredColumns.some((name) => column(name) < 0)) throw new Error(`${file.name}: thiếu cột bắt buộc của báo cáo doanh thu.`);
  const periodText = rows.slice(0, headerRowIndex).flat().map((value) => String(value ?? "").trim()).find((value) => value.startsWith("Từ ngày"));
  const importedAt = new Date().toISOString();
  const records: FinanceRevenueRecord[] = [];
  const read = (row: unknown[], name: string) => { const index = column(name); return index >= 0 ? numericCell(row[index]) : 0; };
  for (const row of rows.slice(headerRowIndex + 1)) {
    if (normalizedHeader(row[0]) === "tong") break;
    const date = excelDateCell(row[column("ngay")]);
    if (!date) continue;
    const totalOrders = read(row, "sl don hang");
    const cancelledOrdersForDay = read(row, "so don huy");
    const actualRevenue = read(row, "doanh thu thuc");
    const partnerFee = read(row, "phi tra doi tac");
    const platformTaxCollected = read(row, "tien thue san thu ho");
    const serviceFeeBeforeTax = read(row, "phi dich vu truoc thue");
    const deliveryFee = read(row, "phi giao hang");
    const totalPlatformFees = partnerFee + platformTaxCollected + serviceFeeBeforeTax + deliveryFee;
    records.push({
      id: `excel-revenue-${date}`,
      date,
      storeRevenue: actualRevenue,
      appRevenue: 0,
      discounts: 0,
      platformFees: totalPlatformFees,
      cashReceived: Math.max(0, actualRevenue - totalPlatformFees),
      orders: Math.max(0, totalOrders - cancelledOrdersForDay),
      cups: read(row, "so luong hang"),
      note: `Import từ ${file.name}`,
      source: "excel",
      importedAt,
      importFileName: file.name,
      importPeriod: periodText,
      reported: {
        totalOrders,
        cancelledOrders: cancelledOrdersForDay,
        itemQuantity: read(row, "so luong hang"),
        averageItemsPerOrder: read(row, "so luong hang tb"),
        averageOrderValue: read(row, "trung binh/don hang"),
        goodsAmount: read(row, "tien hang"),
        cancelledAmount: read(row, "tien huy"),
        returnedAmount: read(row, "tien tra lai"),
        discountAmount: read(row, "giam gia"),
        taxAmount: read(row, "thue"),
        serviceFeeBeforeTax,
        deliveryFee,
        partnerFee,
        platformTaxCollected,
        tips: read(row, "tien tip"),
        customerDebt: read(row, "cong no kh"),
        actualRevenue,
        sales: read(row, "doanh so"),
      },
    });
  }
  if (!records.length) throw new Error(`${file.name}: không có dòng doanh thu hợp lệ.`);
  const orderedDates = records.map((record) => record.date).sort();
  const latestDate = orderedDates[orderedDates.length - 1];
  const parsedPeriod = reportPeriod(periodText) || { start: orderedDates[0], end: latestDate };
  const meta = { fileName: file.name, periodStart: parsedPeriod.start, periodEnd: parsedPeriod.end, rowCount: records.length };
  return { type: "revenue", meta, importMeta: { dataType: "revenue", ...meta, importedAt }, records: records.sort((a, b) => b.date.localeCompare(a.date)), latestDate };
}

function parseProductRows(file: File, rows: unknown[][]): ParsedProductImport {
  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizedHeader);
    return headers.includes("ten danh muc") && headers.includes("ma mat hang") && headers.includes("ten mat hang") && (headers.includes("tong tien") || headers.includes("tien hang"));
  });
  if (headerRowIndex < 0) throw new Error(`${file.name}: không tìm thấy bảng Báo cáo mặt hàng.`);
  const headers = rows[headerRowIndex].map(normalizedHeader);
  const column = (name: string) => headers.indexOf(name);
  const requiredColumns = ["ten danh muc", "ma mat hang", "ten mat hang", "so luong", "tien hang"];
  if (requiredColumns.some((name) => column(name) < 0)) throw new Error(`${file.name}: thiếu cột bắt buộc của báo cáo mặt hàng.`);
  const periodText = rows.slice(0, headerRowIndex).flat().map((value) => String(value ?? "").trim()).find((value) => value.startsWith("Từ ngày"));
  const parsedPeriod = reportPeriod(periodText);
  if (!parsedPeriod) throw new Error(`${file.name}: không đọc được khoảng thời gian báo cáo.`);
  const read = (row: unknown[], name: string) => { const index = column(name); return index >= 0 ? numericCell(row[index]) : 0; };
  const readText = (row: unknown[], name: string) => { const index = column(name); return index >= 0 ? String(row[index] ?? "").trim() : ""; };
  const records: FinanceProductRecord[] = [];
  for (const [index, row] of rows.slice(headerRowIndex + 1).entries()) {
    if (normalizedHeader(row[0]) === "tong") break;
    const name = readText(row, "ten mat hang");
    if (!name) continue;
    const sourceRow = headerRowIndex + index + 2;
    const sku = readText(row, "ma mat hang") || `ROW-${sourceRow}`;
    const goodsAmount = read(row, "tien hang");
    const discountAmount = read(row, "tong giam gia");
    const amountAfterDiscount = headers.includes("tien sau giam gia") ? read(row, "tien sau giam gia") : Math.max(0, goodsAmount - discountAmount);
    const totalAmount = headers.includes("tong tien") ? read(row, "tong tien") : amountAfterDiscount;
    records.push({
      id: `excel-product-${sourceRow}-${sku}`,
      sourceRow,
      category: readText(row, "ten danh muc") || "Khác",
      sku,
      name,
      variant: "",
      sellingPrice: read(row, "gia mat hang"),
      unit: readText(row, "ten don vi"),
      quantity: read(row, "so luong"),
      weight: read(row, "trong luong"),
      usageTime: readText(row, "thoi gian su dung"),
      quantityRatio: read(row, "ti le so luong"),
      goodsAmount: read(row, "tien hang"),
      goodsRatio: read(row, "ti le tien hang"),
      discountAmount,
      amountAfterDiscount,
      taxAmount: read(row, "thue"),
      totalAmount,
    });
  }
  if (!records.length) throw new Error(`${file.name}: không có mặt hàng hợp lệ.`);
  const importedAt = new Date().toISOString();
  const meta = { fileName: file.name, periodStart: parsedPeriod.start, periodEnd: parsedPeriod.end, rowCount: records.length };
  return { type: "products", meta, importMeta: { dataType: "products", ...meta, importedAt }, records };
}

function parseServiceRows(file: File, rows: unknown[][]): ParsedServiceImport {
  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizedHeader);
    return (headers.includes("loai don hang") || headers.includes("ten") || headers.includes("phuong thuc thanh toan")) && headers.includes("sl don hang") && headers.includes("so don huy") && (headers.includes("tien thu duoc") || headers.includes("doanh thu gom thue") || headers.includes("doanh thu"));
  });
  if (headerRowIndex < 0) throw new Error(`${file.name}: không tìm thấy bảng Hình thức phục vụ.`);
  const headers = rows[headerRowIndex].map(normalizedHeader);
  const column = (name: string) => headers.indexOf(name);
  const periodText = rows.slice(0, headerRowIndex).flat().map((value) => String(value ?? "").trim()).find((value) => value.startsWith("Từ ngày"));
  const parsedPeriod = reportPeriod(periodText);
  if (!parsedPeriod) throw new Error(`${file.name}: không đọc được khoảng thời gian báo cáo.`);
  const records: FinanceServiceRecord[] = [];
  for (const [index, row] of rows.slice(headerRowIndex + 1).entries()) {
    if (normalizedHeader(row[0]) === "tong") break;
    const serviceName = firstText(row, headers, ["loai don hang", "phuong thuc thanh toan", "ten"]);
    if (!serviceName) continue;
    const sourceRow = headerRowIndex + index + 2;
    records.push({
      id: `excel-service-${sourceRow}-${normalizedHeader(serviceName).replace(/\s+/g, "-")}`,
      sourceRow,
      serviceName,
      totalOrders: firstNumber(row, headers, ["sl don hang"]),
      cancelledOrders: firstNumber(row, headers, ["so don huy"]),
      revenue: firstNumber(row, headers, ["tien thu duoc", "doanh thu gom thue", "doanh thu"]),
    });
  }
  if (!records.length) throw new Error(`${file.name}: không có hình thức phục vụ hợp lệ.`);
  const importedAt = new Date().toISOString();
  const meta = { fileName: file.name, periodStart: parsedPeriod.start, periodEnd: parsedPeriod.end, rowCount: records.length };
  return { type: "service", meta, importMeta: { dataType: "service", ...meta, importedAt }, records };
}

function parsePlatformOrderRows(file: File, rows: unknown[][]): ParsedOrderImport {
  const headerRowIndex = rows.findIndex((row) => {
    const headers = row.map(normalizedHeader);
    return firstColumn(headers, ["ma don hang", "ma don", "ma hoa don", "so hoa don", "order code", "order id"]) >= 0
      && firstColumn(headers, ["ngay", "ngay tao", "ngay dat hang", "thoi gian tao", "thoi gian dat hang", "thoi gian tao don"]) >= 0
      && firstColumn(headers, ["doanh thu thuc", "tien thu duoc", "tong tien", "thanh tien", "khach phai tra", "gia tri don hang", "tong tien thanh toan (1 + 2 + 3 - 4 + 5)"]) >= 0;
  });
  if (headerRowIndex < 0) throw new Error(`${file.name}: không tìm thấy bảng chi tiết đơn hàng.`);
  const headers = rows[headerRowIndex].map(normalizedHeader);
  const periodText = rows.slice(0, headerRowIndex).flat().map((value) => String(value ?? "").trim()).find((value) => value.startsWith("Từ ngày"));
  const importedAt = new Date().toISOString();
  const records: PlatformOrderRecord[] = [];
  for (const [index, row] of rows.slice(headerRowIndex + 1).entries()) {
    if (normalizedHeader(row[0]) === "tong") break;
    const orderCode = firstText(row, headers, ["ma don hang", "ma don", "ma hoa don", "so hoa don", "order code", "order id"]);
    const orderCreatedAt = excelDateTimeCell(row[firstColumn(headers, ["thoi gian tao don", "thoi gian tao", "ngay tao", "ngay dat hang", "thoi gian dat hang", "ngay"])]);
    const orderDate = orderCreatedAt?.slice(0, 10) || firstDate(row, headers, ["ngay", "ngay tao", "ngay dat hang", "thoi gian tao", "thoi gian dat hang", "thoi gian tao don"]);
    if (!orderCode || !orderDate) continue;
    const channelName = firstText(row, headers, ["nguon don", "kenh ban", "kenh", "nen tang", "platform", "loai don hang", "hinh thuc phuc vu"]) || "Không rõ kênh";
    const paymentMethod = firstText(row, headers, ["phuong thuc tt", "phuong thuc thanh toan", "thanh toan"]);
    const serviceType = firstText(row, headers, ["loai hinh phuc vu", "hinh thuc phuc vu", "loai don hang"]);
    const deliveryPartner = firstText(row, headers, ["doi tac giao hang", "doi tac", "don vi giao hang"]);
    const channelKey = normalizedHeader(channelName);
    const orderPlatformSignal = `${channelName} ${paymentMethod} ${serviceType} ${deliveryPartner}`;
    // Keep every external channel in the platform list, including SAPO's aliases
    // such as Xanh/Green Food and ShopeeFood.
    const isPlatformOrder = (channelKey !== "tai nha hang" && channelKey !== "khong ro kenh") || isKnownPlatformSignal(orderPlatformSignal);
    if (!isPlatformOrder) continue;
    const status = firstText(row, headers, ["trang thai", "trang thai don hang", "tinh trang"]);
    const reportedAmount = firstNumber(row, headers, ["doanh thu thuc", "tien thu duoc", "tong tien thanh toan (1 + 2 + 3 - 4 + 5)", "tong tien", "thanh tien", "khach phai tra", "gia tri don hang"]);
    const sourceRow = headerRowIndex + index + 2;
    records.push({
      id: `excel-order-${orderDate}-${normalizedHeader(orderCode).replace(/[^a-z0-9]+/g, "-") || sourceRow}`,
      orderCode,
      orderDate,
      channelName,
      reportedAmount,
      orderCreatedAt,
      paidAt: excelDateTimeCell(row[firstColumn(headers, ["thoi gian thanh toan", "ngay thanh toan"])]),
      goodsAmount: firstNumber(row, headers, ["tong tien hang (1)", "tong tien hang", "tien hang"]),
      discountAmount: firstNumber(row, headers, ["tong giam gia (4)", "tong giam gia", "giam gia"]),
      serviceFee: firstNumber(row, headers, ["phi dich vu (3)", "phi dich vu"]),
      deliveryFee: firstNumber(row, headers, ["phi gh thu khach (5)", "phi gh thu khach", "phi giao hang"]),
      tipAmount: firstNumber(row, headers, ["tien tip", "tip"]),
      refundAmount: firstNumber(row, headers, ["hoan tien don", "tien hoan"]),
      paymentMethod: paymentMethod || undefined,
      serviceType: serviceType || undefined,
      deliveryPartner: deliveryPartner || undefined,
      status: status || undefined,
      sourceFileName: file.name,
      importedAt,
    });
  }
  if (!records.length) throw new Error(`${file.name}: có chi tiết đơn hàng nhưng không tìm thấy đơn nền tảng hợp lệ.`);
  const orderedDates = records.map((record) => record.orderDate).sort();
  const parsedPeriod = reportPeriod(periodText) || { start: orderedDates[0], end: orderedDates[orderedDates.length - 1] };
  const meta = { fileName: file.name, periodStart: parsedPeriod.start, periodEnd: parsedPeriod.end, rowCount: records.length };
  return { type: "orders", meta, importMeta: { dataType: "orders", ...meta, importedAt }, records, latestDate: orderedDates[orderedDates.length - 1], periodStart: parsedPeriod.start, periodEnd: parsedPeriod.end };
}

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

function previousPeriodBounds(bounds: PeriodBounds, mode: PeriodMode): PeriodBounds {
  const months = mode === "month" ? 1 : mode === "quarter" ? 3 : 12;
  const currentStart = new Date(`${bounds.start}T00:00:00Z`);
  const previousStart = new Date(Date.UTC(currentStart.getUTCFullYear(), currentStart.getUTCMonth() - months, 1));
  const previousEnd = new Date(currentStart.getTime() - 86_400_000);
  const start = previousStart.toISOString().slice(0, 10);
  const end = previousEnd.toISOString().slice(0, 10);
  return { start, end, label: `${dateLabel(start)} - ${dateLabel(end)}`, key: `${start}:${end}` };
}

function expenseFormDefaults(category: ExpenseCategory = "fixed"): ExpenseForm {
  const today = todayISO();
  return { name: "", category, subcategory: "", subcategoryIsCustom: false, amount: "", incurredOn: today, recurrence: category === "fixed" ? "monthly" : "once", paymentStatus: "paid", paymentDate: today, invoiceCode: "", vendor: "", vendorIsCustom: false, note: "", usefulLifeMonths: "36", salvageValue: "0", inServiceOn: today };
}

function grabReconciliationFormDefaults(): GrabReconciliationForm {
  return { platformOrderId: "", orderCode: "", orderDate: todayISO(), reportedAmount: "", receivedAmount: "", note: "" };
}

function emptyFinanceState(): FinanceState {
  return { expenses: [], revenues: [], products: [], services: [], platformOrders: [], imports: [], importHistory: [], productSnapshots: [], serviceSnapshots: [], growthTargetPercent: 10, revenueTargetAmount: 0, closedPeriods: [], grabReconciliations: [] };
}

function normalizeFinanceState(value: unknown, uatMode: boolean): FinanceState {
  if (!value || typeof value !== "object") return uatMode ? seedFinanceState() : emptyFinanceState();
  const stored = value as Partial<FinanceState>;
  const expenses = Array.isArray(stored.expenses) ? stored.expenses : [];
  const revenues = Array.isArray(stored.revenues) ? stored.revenues : [];
  const products = Array.isArray(stored.products) ? stored.products.map((product) => {
    const legacyVariantPrice = product.variant && /^[\d.,\s]+$/.test(product.variant) ? Number(product.variant.replace(/\D/g, "")) || 0 : 0;
    const sellingPrice = Number(product.sellingPrice) || legacyVariantPrice || (product.quantity ? Number(product.totalAmount) / Number(product.quantity) : 0);
    return { ...product, variant: legacyVariantPrice ? "" : product.variant, sellingPrice: Math.max(0, Math.round(sellingPrice)) };
  }) : [];
  const services = Array.isArray(stored.services) ? stored.services : [];
  const platformOrders = Array.isArray(stored.platformOrders) ? stored.platformOrders.map((entry) => ({
    id: String(entry.id || crypto.randomUUID()),
    orderCode: String(entry.orderCode || "").trim(),
    orderDate: String(entry.orderDate || todayISO()),
    channelName: String(entry.channelName || "Không rõ kênh"),
    reportedAmount: Math.max(0, Number(entry.reportedAmount) || 0),
    orderCreatedAt: entry.orderCreatedAt ? String(entry.orderCreatedAt) : undefined,
    paidAt: entry.paidAt ? String(entry.paidAt) : undefined,
    goodsAmount: Math.max(0, Number(entry.goodsAmount) || 0),
    discountAmount: Math.max(0, Number(entry.discountAmount) || 0),
    serviceFee: Math.max(0, Number(entry.serviceFee) || 0),
    deliveryFee: Math.max(0, Number(entry.deliveryFee) || 0),
    tipAmount: Math.max(0, Number(entry.tipAmount) || 0),
    refundAmount: Math.max(0, Number(entry.refundAmount) || 0),
    paymentMethod: entry.paymentMethod ? String(entry.paymentMethod) : undefined,
    serviceType: entry.serviceType ? String(entry.serviceType) : undefined,
    deliveryPartner: entry.deliveryPartner ? String(entry.deliveryPartner) : undefined,
    status: entry.status ? String(entry.status) : undefined,
    sourceFileName: entry.sourceFileName ? String(entry.sourceFileName) : undefined,
    importedAt: entry.importedAt ? String(entry.importedAt) : undefined,
  })) : [];
  const imports = Array.isArray(stored.imports) ? stored.imports : [];
  const importHistory = Array.isArray(stored.importHistory) ? stored.importHistory : imports;
  const productSnapshots = Array.isArray(stored.productSnapshots) ? stored.productSnapshots : [];
  const serviceSnapshots = Array.isArray(stored.serviceSnapshots) ? stored.serviceSnapshots : [];
  const grabReconciliations = Array.isArray(stored.grabReconciliations) ? stored.grabReconciliations.map((entry) => {
    const legacyEntry = entry as GrabReconciliationRecord & { date?: string };
    return {
    id: String(entry.id || crypto.randomUUID()),
    platformOrderId: entry.platformOrderId ? String(entry.platformOrderId) : undefined,
    orderCode: String(entry.orderCode || "").trim(),
    orderDate: String(entry.orderDate || legacyEntry.date || todayISO()),
    reportedAmount: Math.max(0, Number(entry.reportedAmount) || 0),
    receivedAmount: Math.max(0, Number(entry.receivedAmount) || 0),
    note: entry.note ? String(entry.note) : undefined,
  }}) : [];
  const isUatSample = (record: ExpenseRecord | FinanceRevenueRecord) => record.id.startsWith("uat-") || record.note?.includes("Dữ liệu mẫu UAT");
  return {
    expenses: uatMode ? expenses : expenses.filter((record) => !isUatSample(record)),
    revenues: uatMode ? revenues : revenues.filter((record) => !isUatSample(record)),
    products,
    services,
    platformOrders,
    imports,
    importHistory,
    productSnapshots,
    serviceSnapshots,
    growthTargetPercent: Number.isFinite(Number(stored.growthTargetPercent)) ? Number(stored.growthTargetPercent) : 10,
    revenueTargetAmount: Number.isFinite(Number(stored.revenueTargetAmount)) ? Math.max(0, Number(stored.revenueTargetAmount)) : 0,
    closedPeriods: Array.isArray(stored.closedPeriods) ? stored.closedPeriods : [],
    grabReconciliations,
  };
}

function seedFinanceState(): FinanceState {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const maxDay = Math.min(today.getDate(), 24);
  const makeRevenues = (seedYear: number, seedMonth: number, days: number, prefix: string, scale: number): FinanceRevenueRecord[] => Array.from({ length: days }, (_, index) => {
    const day = index + 1;
    const storeRevenue = Math.round((2_700_000 + (day % 5) * 170_000) * scale);
    const appRevenue = Math.round((1_100_000 + (day % 4) * 120_000) * scale);
    const discounts = day % 6 === 0 ? 240_000 : 90_000;
    const platformFees = Math.round(appRevenue * 0.21);
    const net = storeRevenue + appRevenue - discounts;
    return { id: `${prefix}-${day}`, date: dateAt(seedYear, seedMonth, day), storeRevenue, appRevenue, discounts, platformFees, cashReceived: net - platformFees, orders: Math.round((72 + (day % 7) * 5) * scale), cups: Math.round((91 + (day % 6) * 7) * scale), note: "Dữ liệu mẫu UAT" };
  });
  const previousMonth = new Date(Date.UTC(year, month - 2, 1));
  const previousYear = previousMonth.getUTCFullYear();
  const previousMonthNumber = previousMonth.getUTCMonth() + 1;
  const revenues = [
    ...makeRevenues(year, month, maxDay, "uat-revenue-current", 1),
    ...makeRevenues(previousYear, previousMonthNumber, Math.min(24, daysInMonth(previousYear, previousMonthNumber)), "uat-revenue-previous", 0.9),
  ];
  const platformOrders: PlatformOrderRecord[] = Array.from({ length: Math.min(6, maxDay) }, (_, index) => {
    const day = index + 1;
    const orderDate = dateAt(year, month, day);
    return {
      id: `uat-grab-order-${orderDate}-${day}`,
      orderCode: `GRAB-UAT-${String(day).padStart(3, "0")}`,
      orderDate,
      channelName: "Grab Food",
      reportedAmount: 185_000 + day * 12_000,
      orderCreatedAt: `${orderDate}T${String(10 + day).padStart(2, "0")}:15:00`,
      paidAt: `${orderDate}T${String(10 + day).padStart(2, "0")}:28:00`,
      goodsAmount: 205_000 + day * 12_000,
      discountAmount: 20_000,
      serviceFee: 0,
      deliveryFee: 0,
      tipAmount: 0,
      refundAmount: 0,
      paymentMethod: "GrabFood",
      serviceType: "Kênh bán hàng",
      deliveryPartner: "Grab Food",
      status: "Hoàn thành",
      sourceFileName: "Dữ liệu mẫu UAT",
      importedAt: new Date().toISOString(),
    };
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
    products: [],
    services: [],
    platformOrders,
    imports: [],
    importHistory: [],
    productSnapshots: [],
    serviceSnapshots: [],
    growthTargetPercent: 12,
    revenueTargetAmount: 0,
    closedPeriods: [],
    grabReconciliations: [],
  };
}

function expenseOccurrences(expense: ExpenseRecord, bounds: PeriodBounds) {
  if (expense.status === "voided" || expense.category === "investment") return [] as string[];
  if (expense.recurrence === "once") return inRange(expense.incurredOn, bounds) ? [expense.incurredOn] : [];
  const dates: string[] = [];
  // Recurring expenses become due on the selected payment day, not creation day.
  let cursor = expense.paymentDate || expense.incurredOn;
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

export default function FinanceModule({ inventoryLots, inventorySessions, onOpenInventoryLot, uatMode }: { inventoryLots: FinanceInventoryLot[]; inventorySessions: FinanceInventorySession[]; onOpenInventoryLot: (id: string) => void; uatMode: boolean }) {
  const today = todayISO();
  const storageKey = uatMode ? FINANCE_UAT_STORAGE_KEY : FINANCE_STORAGE_KEY;
  const [state, setState] = useState<FinanceState>(() => uatMode ? seedFinanceState() : emptyFinanceState());
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<FinanceTab>("entry");
  const [periodMode, setPeriodMode] = useState<PeriodMode>("month");
  const [selectedMonth, setSelectedMonth] = useState(today.slice(0, 7));
  const [selectedQuarter, setSelectedQuarter] = useState(Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1);
  const [selectedYear, setSelectedYear] = useState(Number(today.slice(0, 4)));
  const [expenseCategory, setExpenseCategory] = useState<ExpenseCategory>("fixed");
  const [reportView, setReportView] = useState<ReportView>("pnl");
  const [revenueSubTab, setRevenueSubTab] = useState<RevenueSubTab>("overview");
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [savingExpense, setSavingExpense] = useState(false);
  const [importingExpenses, setImportingExpenses] = useState(false);
  const [expenseImportNotice, setExpenseImportNotice] = useState<string | undefined>();
  const [importingFinance, setImportingFinance] = useState(false);
  const [savingGrabReconciliation, setSavingGrabReconciliation] = useState(false);
  const [showGrabReconciliationModal, setShowGrabReconciliationModal] = useState(false);
  const [financeImportNotice, setFinanceImportNotice] = useState<string | undefined>();
  const [financeSyncError, setFinanceSyncError] = useState<string | undefined>();
  const [editingExpenseId, setEditingExpenseId] = useState<string | undefined>();
  const [expenseForm, setExpenseForm] = useState<ExpenseForm>(expenseFormDefaults());
  const [grabForm, setGrabForm] = useState<GrabReconciliationForm>(grabReconciliationFormDefaults());

  useEffect(() => {
    let cancelled = false;
    async function loadState() {
      if (!uatMode) {
        // One-time Production reset: old manual expenses were browser-local and
        // could survive a database cleanup or leak in through the legacy UAT fallback.
        window.localStorage.removeItem(FINANCE_PROD_LEGACY_STORAGE_KEY);
        window.localStorage.removeItem(FINANCE_LEGACY_UAT_STORAGE_KEY);
      }
      const stored = window.localStorage.getItem(storageKey) || (uatMode ? window.localStorage.getItem(FINANCE_LEGACY_UAT_STORAGE_KEY) : null);
      let nextState = uatMode ? seedFinanceState() : emptyFinanceState();
      if (stored) {
        try { nextState = normalizeFinanceState(JSON.parse(stored), uatMode); } catch { nextState = uatMode ? seedFinanceState() : emptyFinanceState(); }
      }
      if (!uatMode && isSupabaseConfigured) {
        try {
          let cloud = await loadFinanceImports();
          const shouldMigrateLocalExpenses = window.localStorage.getItem(FINANCE_EXPENSE_MIGRATION_KEY) !== "done";
          if (shouldMigrateLocalExpenses && nextState.expenses.length) {
            // Preserve old browser-only Production records without overwriting
            // a newer cloud copy that already has the same ID.
            await upsertFinanceExpenses(nextState.expenses, true);
            cloud = await loadFinanceImports();
          }
          window.localStorage.setItem(FINANCE_EXPENSE_MIGRATION_KEY, "done");
          nextState = { ...nextState, expenses: cloud.expenses, revenues: cloud.revenues, products: cloud.products, services: cloud.services, platformOrders: cloud.platformOrders, grabReconciliations: cloud.grabReconciliations, imports: cloud.imports };
        } catch (error) {
          setFinanceSyncError(error instanceof Error ? error.message : "Không thể tải dữ liệu tài chính từ Supabase.");
        }
      }
      if (!cancelled) {
        setState(nextState);
        setLoaded(true);
      }
    }
    loadState();
    return () => { cancelled = true; };
  }, [storageKey, uatMode]);
  useEffect(() => { if (loaded) window.localStorage.setItem(storageKey, JSON.stringify(state)); }, [state, loaded, storageKey]);

  const bounds = useMemo(() => periodBounds(periodMode, selectedMonth, selectedQuarter, selectedYear), [periodMode, selectedMonth, selectedQuarter, selectedYear]);
  const selectableMonths = useMemo(() => {
    const currentMonth = today.slice(0, 7);
    const defaultStart = `${Number(currentMonth.slice(0, 4)) - 2}-01`;
    const knownMonths = [
      ...state.expenses.map((expense) => monthKey(expense.incurredOn)),
      ...state.revenues.map((revenue) => monthKey(revenue.date)),
      ...state.platformOrders.map((entry) => monthKey(entry.orderDate)),
      ...state.grabReconciliations.map((entry) => monthKey(entry.orderDate)),
      ...inventoryLots.map((lot) => monthKey(lot.purchasedOn)),
      ...inventorySessions.map((session) => session.costRecognitionMonth || monthKey(session.activatedAt)),
    ].filter((month) => /^\d{4}-\d{2}$/.test(month) && month <= currentMonth);
    return selectableMonthOptions([defaultStart, ...knownMonths].sort()[0], currentMonth);
  }, [inventoryLots, inventorySessions, state.expenses, state.grabReconciliations, state.platformOrders, state.revenues, today]);
  const previousBounds = useMemo(() => previousPeriodBounds(bounds, periodMode), [bounds, periodMode]);
  const currentPeriodClosed = periodMode === "month" && state.closedPeriods.includes(bounds.key);
  const activeExpenses = state.expenses.filter((expense) => expense.status === "active");
  const vendors = useMemo(() => [...new Set(activeExpenses.map((expense) => expense.vendor?.trim()).filter((vendor): vendor is string => Boolean(vendor)))].sort((a, b) => a.localeCompare(b, "vi")), [activeExpenses]);
  const subcategories = useMemo(() => [...new Set(activeExpenses.map((expense) => expense.subcategory.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "vi")), [activeExpenses]);
  const manualOccurrences = useMemo(() => activeExpenses.flatMap((expense) => expenseOccurrences(expense, bounds).map((date) => ({ expense, date, amount: expense.amount }))), [activeExpenses, bounds]);
  const periodRevenues = useMemo(() => state.revenues.filter((entry) => inRange(entry.date, bounds)), [state.revenues, bounds]);
  const previousPeriodRevenues = useMemo(() => state.revenues.filter((entry) => inRange(entry.date, previousBounds)), [state.revenues, previousBounds]);
  const revenueImport = state.imports.find((entry) => entry.dataType === "revenue");
  const productsImport = state.imports.find((entry) => entry.dataType === "products");
  const serviceImport = state.imports.find((entry) => entry.dataType === "service");
  const ordersImport = state.imports.find((entry) => entry.dataType === "orders");
  const importOverlapsBounds = (entry: FinanceImportMeta | undefined) => Boolean(entry && entry.periodStart <= bounds.end && entry.periodEnd >= bounds.start);
  // Product/service imports are period aggregates; retain them whenever their period overlaps the selected view.
  const periodProducts = importOverlapsBounds(productsImport) ? state.products : [];
  const periodServices = importOverlapsBounds(serviceImport) ? state.services : [];
  // Revenue is stored by day, so every finance view can use the same selected period.
  const revenueDataset = periodRevenues;
  const periodPlatformOrders = useMemo(() => state.platformOrders.filter((entry) => inRange(entry.orderDate, bounds)), [state.platformOrders, bounds]);
  const grabOrderOptions = useMemo(() => periodPlatformOrders.filter((entry) => normalizedHeader(`${entry.channelName} ${entry.paymentMethod || ""} ${entry.deliveryPartner || ""}`).includes("grab") && !/huy|cancel/.test(normalizedHeader(entry.status))).sort((a, b) => b.orderDate.localeCompare(a.orderDate) || a.orderCode.localeCompare(b.orderCode, "vi")), [periodPlatformOrders]);
  const grabReconciliationRows = useMemo(() => state.grabReconciliations.filter((entry) => inRange(entry.orderDate, bounds)).sort((a, b) => b.orderDate.localeCompare(a.orderDate) || a.orderCode.localeCompare(b.orderCode, "vi")), [state.grabReconciliations, bounds]);
  const reconciledGrabOrderCodes = new Set(grabReconciliationRows.map((entry) => entry.platformOrderId || `${entry.orderDate}:${entry.orderCode.toLocaleLowerCase("vi")}`));
  const unreconciledGrabOrders = grabOrderOptions.filter((order) => !reconciledGrabOrderCodes.has(order.id) && !reconciledGrabOrderCodes.has(`${order.orderDate}:${order.orderCode.toLocaleLowerCase("vi")}`));
  const selectedGrabOrder = grabForm.platformOrderId ? state.platformOrders.find((order) => order.id === grabForm.platformOrderId) : undefined;
  const platformOrderList = useMemo(() => [...periodPlatformOrders].sort((a, b) => b.orderDate.localeCompare(a.orderDate) || a.orderCode.localeCompare(b.orderCode, "vi")), [periodPlatformOrders]);

  function selectRevenueSubTab(nextTab: RevenueSubTab) {
    if (nextTab === "platform" && !periodPlatformOrders.length && state.platformOrders.length) {
      const latestOrderMonth = [...state.platformOrders].sort((left, right) => right.orderDate.localeCompare(left.orderDate))[0].orderDate.slice(0, 7);
      setPeriodMode("month");
      setSelectedMonth(latestOrderMonth);
      setSelectedYear(Number(latestOrderMonth.slice(0, 4)));
    }
    setRevenueSubTab(nextTab);
  }

  function isGrabPlatformOrder(order: PlatformOrderRecord) {
    return /grab\s*food|grabfood/.test(platformSignal(`${order.channelName} ${order.paymentMethod || ""} ${order.deliveryPartner || ""}`));
  }

  function reconciliationForPlatformOrder(order: PlatformOrderRecord) {
    return state.grabReconciliations.find((entry) => entry.platformOrderId === order.id || (entry.orderDate === order.orderDate && entry.orderCode.toLocaleLowerCase("vi") === order.orderCode.toLocaleLowerCase("vi")));
  }
  const grabReportedTotal = grabReconciliationRows.reduce((sum, entry) => sum + entry.reportedAmount, 0);
  const grabReceivedTotal = grabReconciliationRows.reduce((sum, entry) => sum + entry.receivedAmount, 0);
  const grabDifference = grabReceivedTotal - grabReportedTotal;
  const grabCoverageRate = grabOrderOptions.length ? Math.min(100, grabReconciliationRows.length / grabOrderOptions.length * 100) : 0;
  const grabUnreconciledOrders = Math.max(0, grabOrderOptions.length - grabReconciliationRows.length);
  const inventoryEvents = useMemo(() => inventorySessions.flatMap((session) => {
    const lot = inventoryLots.find((entry) => entry.id === session.sourceReceiptId);
    if (!lot) return [];
    const events: Array<{ id: string; date: string; lot: FinanceInventoryLot; amount: number; kind: "cogs" | "waste"; reason: string }> = [];
    const activatedOn = session.costRecognitionMonth ? `${session.costRecognitionMonth}-01` : session.activatedAt.slice(0, 10);
    if (inRange(activatedOn, bounds)) events.push({ id: `${session.id}-cogs`, date: activatedOn, lot, amount: session.recognizedCost ?? lot.unitCost, kind: "cogs", reason: session.reason });
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
  const platformFees = periodRevenues.reduce((sum, entry) => sum + entry.platformFees, 0);
  const datasetRevenue = revenueDataset.reduce((sum, entry) => sum + entry.storeRevenue + entry.appRevenue - entry.discounts, 0);
  const datasetItems = revenueDataset.reduce((sum, entry) => sum + entry.cups, 0);
  const reportedGoodsAmount = revenueDataset.reduce((sum, entry) => sum + (entry.reported?.goodsAmount ?? entry.storeRevenue + entry.appRevenue + entry.discounts), 0);
  const reportedDiscountAmount = revenueDataset.reduce((sum, entry) => sum + (entry.reported?.discountAmount ?? entry.discounts), 0);
  const reportedCancelledAmount = revenueDataset.reduce((sum, entry) => sum + (entry.reported?.cancelledAmount || 0), 0);
  const reportedReturnedAmount = revenueDataset.reduce((sum, entry) => sum + (entry.reported?.returnedAmount || 0), 0);
  const reportedPartnerCommission = revenueDataset.reduce((sum, entry) => sum + (entry.reported?.partnerFee || 0), 0);
  const reportedPlatformTax = revenueDataset.reduce((sum, entry) => sum + (entry.reported?.platformTaxCollected || 0), 0);
  const reportedServiceFees = revenueDataset.reduce((sum, entry) => sum + (entry.reported?.serviceFeeBeforeTax || 0), 0);
  const reportedDeliveryFees = revenueDataset.reduce((sum, entry) => sum + (entry.reported?.deliveryFee || 0), 0);
  const reportedPartnerFees = revenueDataset.reduce((sum, entry) => sum + (entry.reported ? entry.reported.partnerFee + entry.reported.platformTaxCollected + entry.reported.serviceFeeBeforeTax + entry.reported.deliveryFee : entry.platformFees), 0);
  const totalReportedOrders = revenueDataset.reduce((sum, entry) => sum + (entry.reported?.totalOrders ?? entry.orders), 0);
  const cancelledOrders = revenueDataset.reduce((sum, entry) => sum + (entry.reported?.cancelledOrders || 0), 0);
  const successfulOrders = revenueDataset.reduce((sum, entry) => sum + entry.orders, 0);
  const importedRevenueRows = revenueDataset.filter((entry) => entry.source === "excel");
  const previousNetRevenue = previousPeriodRevenues.reduce((sum, entry) => sum + entry.storeRevenue + entry.appRevenue - entry.discounts, 0);
  const previousCups = previousPeriodRevenues.reduce((sum, entry) => sum + entry.cups, 0);
  const currentAveragePerCup = cups ? netRevenue / cups : 0;
  const averagePerOrder = successfulOrders ? datasetRevenue / successfulOrders : 0;
  const averageItemsPerOrder = totalReportedOrders ? datasetItems / totalReportedOrders : 0;
  const averagePerItem = datasetItems ? datasetRevenue / datasetItems : 0;
  const cancellationRate = totalReportedOrders ? cancelledOrders / totalReportedOrders * 100 : 0;
  const discountRate = reportedGoodsAmount ? reportedDiscountAmount / reportedGoodsAmount * 100 : 0;
  const baselineAveragePerCup = previousCups ? previousNetRevenue / previousCups : currentAveragePerCup;
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

  const inventoryPurchases = inventoryLots.filter((lot) => !lot.internalReturn && inRange(lot.purchasedOn, bounds)).reduce((sum, lot) => sum + lot.quantity * lot.unitCost, 0);
  const cashIn = periodRevenues.reduce((sum, entry) => sum + (entry.cashReceived || entry.storeRevenue + entry.appRevenue - entry.discounts - entry.platformFees), 0);
  const paidInvestments = assetExpenses.filter((asset) => asset.paymentStatus === "paid" && inRange(asset.paymentDate || asset.incurredOn, bounds)).reduce((sum, asset) => sum + asset.amount, 0);
  // Platform fees are already withheld from the recorded cash received.
  const cashOut = inventoryPurchases + paidManual + paidInvestments;
  const netCash = cashIn - cashOut;

  const openingInventory = inventoryLots.filter((lot) => (lot.availableFrom || lot.purchasedOn) < bounds.start).reduce((sum, lot) => {
    const issuedBefore = inventorySessions.filter((session) => session.sourceReceiptId === lot.id && (session.costRecognitionMonth ? `${session.costRecognitionMonth}-01` : session.activatedAt.slice(0, 10)) < bounds.start).length;
    return sum + Math.max(0, lot.quantity - issuedBefore) * lot.unitCost;
  }, 0);
  const closingInventory = inventoryLots.filter((lot) => (lot.availableFrom || lot.purchasedOn) <= bounds.end).reduce((sum, lot) => {
    const issuedByEnd = inventorySessions.filter((session) => session.sourceReceiptId === lot.id && (session.costRecognitionMonth ? `${session.costRecognitionMonth}-01` : session.activatedAt.slice(0, 10)) <= bounds.end).length;
    return sum + Math.max(0, lot.quantity - issuedByEnd) * lot.unitCost;
  }, 0);

  const growthTargetPercent = Math.max(0, state.growthTargetPercent || 0);
  const autoRevenueTarget = previousNetRevenue * (1 + growthTargetPercent / 100);
  const revenueTarget = Math.max(0, state.revenueTargetAmount || autoRevenueTarget);
  const targetGrowthRate = previousNetRevenue ? (revenueTarget / previousNetRevenue - 1) * 100 : 0;
  const cupTarget = baselineAveragePerCup ? Math.ceil(revenueTarget / baselineAveragePerCup) : 0;
  const revenueRemaining = Math.max(0, revenueTarget - netRevenue);
  const targetProgress = revenueTarget ? Math.min(100, (netRevenue / revenueTarget) * 100) : 0;
  const grossMargin = netRevenue ? (grossProfit / netRevenue) * 100 : 0;

  const productQuantity = periodProducts.reduce((sum, entry) => sum + entry.quantity, 0);
  const productGoodsAmount = periodProducts.reduce((sum, entry) => sum + entry.goodsAmount, 0);
  const productDiscountAmount = periodProducts.reduce((sum, entry) => sum + entry.discountAmount, 0);
  const productNetAmount = periodProducts.reduce((sum, entry) => sum + entry.totalAmount, 0);
  const productDiscountRate = productGoodsAmount ? productDiscountAmount / productGoodsAmount * 100 : 0;
  const averageProductValue = productQuantity ? productNetAmount / productQuantity : 0;
  const categoryPerformance = useMemo(() => {
    const grouped = new Map<string, { quantity: number; revenue: number; discount: number; skuCount: number }>();
    for (const product of periodProducts) {
      const current = grouped.get(product.category) || { quantity: 0, revenue: 0, discount: 0, skuCount: 0 };
      current.quantity += product.quantity;
      current.revenue += product.totalAmount;
      current.discount += product.discountAmount;
      current.skuCount += 1;
      grouped.set(product.category, current);
    }
    return [...grouped.entries()].map(([name, values]) => ({ name, ...values })).sort((a, b) => b.revenue - a.revenue);
  }, [periodProducts]);
  const topProducts = useMemo(() => [...periodProducts].sort((a, b) => b.totalAmount - a.totalAmount).slice(0, 8), [periodProducts]);
  const highDiscountProducts = useMemo(() => [...periodProducts].filter((entry) => entry.goodsAmount > 0 && entry.discountAmount > 0).sort((a, b) => b.discountAmount / b.goodsAmount - a.discountAmount / a.goodsAmount).slice(0, 6), [periodProducts]);
  const maxCategoryRevenue = Math.max(...categoryPerformance.map((entry) => entry.revenue), 1);
  const revenueProductGap = datasetRevenue - productNetAmount;
  const offlineServiceNames = new Set(["an tai ban", "mang di"]);
  const offlineServices = periodServices.filter((entry) => offlineServiceNames.has(normalizedHeader(entry.serviceName)));
  const deliveryServices = periodServices.filter((entry) => !offlineServiceNames.has(normalizedHeader(entry.serviceName)));
  const grabService = periodServices.find((entry) => normalizedHeader(entry.serviceName).includes("grab"));
  const serviceOrders = periodServices.reduce((sum, entry) => sum + entry.totalOrders, 0);
  const serviceCancelledOrders = periodServices.reduce((sum, entry) => sum + entry.cancelledOrders, 0);
  const serviceRevenue = periodServices.reduce((sum, entry) => sum + entry.revenue, 0);
  const offlineOrders = offlineServices.reduce((sum, entry) => sum + entry.totalOrders, 0);
  const offlineRevenue = offlineServices.reduce((sum, entry) => sum + entry.revenue, 0);
  const deliveryOrders = deliveryServices.reduce((sum, entry) => sum + entry.totalOrders, 0);
  const deliveryRevenue = deliveryServices.reduce((sum, entry) => sum + entry.revenue, 0);
  const offlineOrderShare = serviceOrders ? offlineOrders / serviceOrders * 100 : 0;
  const deliveryOrderShare = serviceOrders ? deliveryOrders / serviceOrders * 100 : 0;
  const offlineRevenueShare = serviceRevenue ? offlineRevenue / serviceRevenue * 100 : 0;
  const deliveryRevenueShare = serviceRevenue ? deliveryRevenue / serviceRevenue * 100 : 0;
  const maxServiceRevenue = Math.max(...periodServices.map((entry) => entry.revenue), 1);
  const serviceRevenueGap = serviceRevenue - datasetRevenue;
  const revenueAdjustments = [
    { label: "Tiền hủy", value: reportedCancelledAmount },
    { label: "Tiền trả lại", value: reportedReturnedAmount },
    { label: "Giảm giá", value: reportedDiscountAmount },
    { label: "Phí đối tác & sàn", value: reportedPartnerFees },
  ];
  const maxRevenueAdjustment = Math.max(...revenueAdjustments.map((entry) => entry.value), 1);
  const platformTakeBase = deliveryRevenue || datasetRevenue;
  const platformTakeRate = platformTakeBase ? reportedPartnerFees / platformTakeBase * 100 : 0;
  const partnerCommissionRate = reportedGoodsAmount ? reportedPartnerCommission / reportedGoodsAmount * 100 : 0;
  const revenueAfterPlatformFees = Math.max(0, platformTakeBase - reportedPartnerFees);
  const platformFeeDays = revenueDataset.filter((entry) => entry.reported ? entry.reported.partnerFee + entry.reported.platformTaxCollected + entry.reported.serviceFeeBeforeTax + entry.reported.deliveryFee > 0 : entry.platformFees > 0).length;
  const platformFeeComponents = [
    { label: "Phí trả đối tác", value: reportedPartnerCommission },
    { label: "Thuế sàn thu hộ", value: reportedPlatformTax },
    { label: "Phí dịch vụ", value: reportedServiceFees },
    { label: "Phí giao hàng", value: reportedDeliveryFees },
  ].filter((entry) => entry.value > 0);
  const maxPlatformFeeComponent = Math.max(...platformFeeComponents.map((entry) => entry.value), 1);
  const successfulPlatformOrders = periodPlatformOrders.filter((entry) => !/huy|cancel/.test(normalizedHeader(entry.status)));
  const platformOrderRevenue = successfulPlatformOrders.reduce((sum, entry) => sum + entry.reportedAmount, 0);
  const platformGoodsAmount = successfulPlatformOrders.reduce((sum, entry) => sum + entry.goodsAmount, 0);
  const platformDiscountAmount = successfulPlatformOrders.reduce((sum, entry) => sum + entry.discountAmount, 0);
  const platformCancelledOrders = periodPlatformOrders.length - successfulPlatformOrders.length;
  const platformAverageOrder = successfulPlatformOrders.length ? platformOrderRevenue / successfulPlatformOrders.length : 0;
  const platformDiscountRate = platformGoodsAmount ? platformDiscountAmount / platformGoodsAmount * 100 : 0;
  const channelPerformance = useMemo(() => {
    const grouped = new Map<string, { orders: number; successfulOrders: number; cancelledOrders: number; revenue: number; discount: number }>();
    for (const order of periodPlatformOrders) {
      const label = order.channelName.trim() || "Không rõ kênh";
      const current = grouped.get(label) || { orders: 0, successfulOrders: 0, cancelledOrders: 0, revenue: 0, discount: 0 };
      const cancelled = /huy|cancel/.test(normalizedHeader(order.status));
      current.orders += 1;
      current.cancelledOrders += cancelled ? 1 : 0;
      current.successfulOrders += cancelled ? 0 : 1;
      current.revenue += cancelled ? 0 : order.reportedAmount;
      current.discount += cancelled ? 0 : order.discountAmount;
      grouped.set(label, current);
    }
    return [...grouped.entries()].map(([name, values]) => ({ name, ...values, averageOrder: values.successfulOrders ? values.revenue / values.successfulOrders : 0 })).sort((left, right) => right.revenue - left.revenue);
  }, [periodPlatformOrders]);
  const maxPlatformChannelRevenue = Math.max(...channelPerformance.map((entry) => entry.revenue), 1);
  const platformDailyTrend = useMemo(() => {
    const grouped = new Map<string, { orders: number; revenue: number }>();
    for (const order of successfulPlatformOrders) {
      const current = grouped.get(order.orderDate) || { orders: 0, revenue: 0 };
      current.orders += 1;
      current.revenue += order.reportedAmount;
      grouped.set(order.orderDate, current);
    }
    return [...grouped.entries()].map(([date, values]) => ({ date, ...values })).sort((left, right) => left.date.localeCompare(right.date));
  }, [successfulPlatformOrders]);
  const maxPlatformDailyRevenue = Math.max(...platformDailyTrend.map((entry) => entry.revenue), 1);
  const grabSapoOrderTotal = grabOrderOptions.reduce((sum, entry) => sum + entry.reportedAmount, 0);
  const grabRetentionRate = grabReportedTotal ? grabReceivedTotal / grabReportedTotal * 100 : 0;

  const expenseCategorySections = (Object.keys(categoryLabels) as ExpenseCategory[]).map((category) => {
    const manualEntries = category === "investment"
      ? activeExpenses.filter((expense) => expense.category === category && expense.incurredOn <= bounds.end).map((expense) => ({ expense, date: expense.incurredOn, amount: expense.amount }))
      : manualOccurrences.filter(({ expense }) => expense.category === category);
    const manualGroups = new Map<string, typeof manualEntries>();
    for (const occurrence of manualEntries) {
      const key = occurrence.expense.subcategory || "Khác";
      manualGroups.set(key, [...(manualGroups.get(key) || []), occurrence]);
    }
    const categoryInventoryEvents = category === "operating" ? inventoryEvents : [];
    const inventoryCategoryGroups = new Map<string, typeof categoryInventoryEvents>();
    for (const inventoryEvent of categoryInventoryEvents) {
      const key = inventoryEvent.lot.category.trim() || "KHÁC";
      inventoryCategoryGroups.set(key, [...(inventoryCategoryGroups.get(key) || []), inventoryEvent]);
    }
    return {
      category,
      manualEntries,
      manualGroups: [...manualGroups.entries()].sort(([left], [right]) => left.localeCompare(right, "vi")),
      inventoryEvents: categoryInventoryEvents,
      inventoryCategoryGroups: [...inventoryCategoryGroups.entries()].sort(([left], [right]) => left.localeCompare(right, "vi")),
      count: manualEntries.length + categoryInventoryEvents.length,
    };
  });
  const selectedExpenseSection = expenseCategorySections.find((section) => section.category === expenseCategory)!;

  function openAddExpense(category: ExpenseCategory) {
    if (currentPeriodClosed) { window.alert("Kỳ này đã khóa sổ. Hãy mở lại kỳ hoặc tạo giao dịch ở tháng hiện tại."); return; }
    setEditingExpenseId(undefined);
    setExpenseForm(expenseFormDefaults(category));
    setShowExpenseForm(true);
  }

  function openEditExpense(expense: ExpenseRecord) {
    if (currentPeriodClosed) { window.alert("Kỳ này đã khóa sổ và không thể sửa trực tiếp."); return; }
    setEditingExpenseId(expense.id);
    setExpenseForm({ name: expense.name, category: expense.category, subcategory: expense.subcategory, subcategoryIsCustom: !subcategories.includes(expense.subcategory), amount: amountInput(String(expense.amount)), incurredOn: expense.incurredOn, recurrence: expense.recurrence, paymentStatus: expense.paymentStatus, paymentDate: expense.paymentDate || "", invoiceCode: expense.invoiceCode || "", vendor: expense.vendor || "", vendorIsCustom: Boolean(expense.vendor && !vendors.includes(expense.vendor)), note: expense.note || "", usefulLifeMonths: String(expense.usefulLifeMonths || 36), salvageValue: amountInput(String(expense.salvageValue || 0)), inServiceOn: expense.inServiceOn || expense.incurredOn });
    setShowExpenseForm(true);
  }

  async function persistExpense(record: ExpenseRecord) {
    let persistedRecord = record;
    if (!uatMode) {
      if (!isSupabaseConfigured) throw new Error("Production chưa cấu hình Supabase. Chi phí chưa được lưu.");
      const saved = await upsertFinanceExpenses([record]);
      const cloudRecord = saved.find((entry) => entry.id === record.id);
      if (!cloudRecord) throw new Error("Supabase không trả lại chi phí sau khi lưu. Giao dịch đã dừng để tránh chỉ lưu local.");
      persistedRecord = cloudRecord;
    }
    setState((current) => ({
      ...current,
      expenses: current.expenses.some((entry) => entry.id === persistedRecord.id)
        ? current.expenses.map((entry) => entry.id === persistedRecord.id ? persistedRecord : entry)
        : [persistedRecord, ...current.expenses],
    }));
  }

  async function saveExpense(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = parseAmount(expenseForm.amount);
    if (!expenseForm.name.trim() || !amount) return;
    const recurrence = expenseForm.category === "investment" ? "once" : expenseForm.recurrence;
    const paymentDate = expenseForm.paymentDate || expenseForm.incurredOn;
    const record: ExpenseRecord = { id: editingExpenseId || crypto.randomUUID(), name: expenseForm.name.trim(), category: expenseForm.category, subcategory: expenseForm.subcategory.trim() || "Khác", amount, incurredOn: expenseForm.incurredOn, recurrence, paymentStatus: expenseForm.paymentStatus, paymentDate: recurrence !== "once" || expenseForm.paymentStatus === "paid" ? paymentDate : undefined, invoiceCode: expenseForm.invoiceCode.trim() || undefined, vendor: expenseForm.vendor.trim() || undefined, note: expenseForm.note.trim() || undefined, usefulLifeMonths: expenseForm.category === "investment" ? Math.max(1, Number(expenseForm.usefulLifeMonths) || 36) : undefined, salvageValue: expenseForm.category === "investment" ? parseAmount(expenseForm.salvageValue) : undefined, inServiceOn: expenseForm.category === "investment" ? expenseForm.inServiceOn : undefined, status: "active" };
    setSavingExpense(true);
    setFinanceSyncError(undefined);
    try {
      await persistExpense(record);
      setExpenseCategory(record.category);
      setShowExpenseForm(false);
      setEditingExpenseId(undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Không thể lưu chi phí.";
      setFinanceSyncError(message);
      window.alert(message);
    } finally {
      setSavingExpense(false);
    }
  }

  async function voidExpense(expense: ExpenseRecord) {
    if (currentPeriodClosed) { window.alert("Kỳ này đã khóa sổ và không thể huỷ giao dịch."); return; }
    if (!window.confirm(`Huỷ giao dịch “${expense.name}”? Giao dịch sẽ được giữ lại trong lịch sử.`)) return;
    try { await persistExpense({ ...expense, status: "voided" }); }
    catch (error) { const message = error instanceof Error ? error.message : "Không thể huỷ giao dịch."; setFinanceSyncError(message); window.alert(message); }
  }

  async function markPaid(expense: ExpenseRecord) {
    if (currentPeriodClosed) { window.alert("Kỳ này đã khóa sổ và không thể cập nhật thanh toán."); return; }
    try { await persistExpense({ ...expense, paymentStatus: "paid", paymentDate: today }); }
    catch (error) { const message = error instanceof Error ? error.message : "Không thể cập nhật thanh toán."; setFinanceSyncError(message); window.alert(message); }
  }

  async function exportExpensesExcel() {
    const XLSX = await import("xlsx");
    const rows = [...state.expenses].sort((left, right) => right.incurredOn.localeCompare(left.incurredOn)).map((expense) => ({
      "ID (không sửa)": expense.id,
      "Trạng thái": expense.status === "active" ? "Đang hoạt động" : "Đã huỷ",
      "Category": categoryLabels[expense.category],
      "Subcategory": expense.subcategory,
      "Tên chi phí / tài sản": expense.name,
      "Số tiền": expense.amount,
      "Ngày ghi nhận": dateLabel(expense.incurredOn),
      "Chu kỳ": recurrenceLabels[expense.recurrence],
      "Thanh toán": paymentLabels[expense.paymentStatus],
      "Ngày thanh toán": expense.paymentDate ? dateLabel(expense.paymentDate) : "",
      "Mã hóa đơn": expense.invoiceCode || "",
      "Nhà cung cấp": expense.vendor || "",
      "Ghi chú": expense.note || "",
      "Khấu hao (tháng)": expense.usefulLifeMonths || "",
      "Giá trị thu hồi": expense.salvageValue ?? "",
      "Ngày sử dụng": expense.inServiceOn ? dateLabel(expense.inServiceOn) : "",
    }));
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet["!cols"] = [22, 16, 18, 20, 30, 15, 15, 14, 20, 18, 18, 24, 32, 18, 18, 16].map((wch) => ({ wch }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Ghi nhận chi phí");
    const guide = XLSX.utils.aoa_to_sheet([
      ["HƯỚNG DẪN IMPORT CHI PHÍ"],
      ["1", "Chỉ sửa dữ liệu trong sheet Ghi nhận chi phí."],
      ["2", "Giữ nguyên cột ID khi muốn cập nhật dòng cũ; để trống ID để tạo dòng mới."],
      ["3", "Category hợp lệ: Chi phí cố định, Chi phí vận hành, Chi phí bán hàng, Đầu tư ban đầu."],
      ["4", "Ngày dùng định dạng dd/mm/yyyy hoặc yyyy-mm-dd."],
      ["5", "Import là merge/upsert: không xóa các chi phí khác."],
    ]);
    guide["!cols"] = [{ wch: 8 }, { wch: 100 }];
    XLSX.utils.book_append_sheet(workbook, guide, "Hướng dẫn");
    XLSX.writeFile(workbook, `ghi-nhan-chi-phi-${today}.xlsx`);
  }

  async function importExpensesExcel(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name) || file.size > 10 * 1024 * 1024) { window.alert("Chỉ hỗ trợ file .xls/.xlsx tối đa 10 MB."); return; }
    setImportingExpenses(true);
    setExpenseImportNotice(undefined);
    setFinanceSyncError(undefined);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!sheet) throw new Error(`${file.name}: không tìm thấy sheet dữ liệu.`);
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
      const parsedRecords = parseExpenseRows(file, rows);
      const recordsById = new Map(parsedRecords.map((record) => [record.id, record]));
      const records = [...recordsById.values()];
      const duplicateCount = parsedRecords.length - records.length;
      if (!window.confirm(`Nhập ${records.length} dòng chi phí${duplicateCount ? ` (${duplicateCount} ID trùng trong file đã lấy dòng cuối)` : ""}? Dòng trùng ID trên hệ thống sẽ được cập nhật, dữ liệu khác được giữ nguyên.`)) return;
      if (!uatMode) {
        if (!isSupabaseConfigured) throw new Error("Production chưa cấu hình Supabase. Import đã dừng.");
        const saved = await upsertFinanceExpenses(records);
        if (saved.length !== records.length) throw new Error(`Supabase chỉ xác nhận ${saved.length}/${records.length} dòng. Import được coi là chưa hoàn tất.`);
        const cloud = await loadFinanceImports();
        const cloudIds = new Set(cloud.expenses.map((record) => record.id));
        const missingCount = records.filter((record) => !cloudIds.has(record.id)).length;
        if (missingCount) throw new Error(`Không đọc lại được ${missingCount} dòng chi phí từ Supabase sau import.`);
        setState((current) => ({ ...current, ...cloud }));
      } else {
        setState((current) => {
          const importedIds = new Set(records.map((record) => record.id));
          return { ...current, expenses: [...records, ...current.expenses.filter((record) => !importedIds.has(record.id))] };
        });
      }
      const latestDate = records.map((record) => record.incurredOn).sort().at(-1);
      if (latestDate) { setSelectedMonth(latestDate.slice(0, 7)); setSelectedYear(Number(latestDate.slice(0, 4))); }
      setExpenseImportNotice(`Đã nhập và kiểm tra lại ${records.length} dòng từ ${file.name}${duplicateCount ? `; đã gộp ${duplicateCount} ID trùng` : ""}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Không thể nhập file chi phí.";
      setFinanceSyncError(message);
      window.alert(message);
    } finally {
      setImportingExpenses(false);
    }
  }

  async function importFinanceExcel(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    if (files.length > 4) { window.alert("Bộ import SAPO hỗ trợ tối đa 4 file: Doanh thu, Mặt hàng, Phương thức/Hình thức và Danh sách hóa đơn."); return; }
    const invalidFile = files.find((file) => !/\.(xls|xlsx)$/i.test(file.name) || file.size > 10 * 1024 * 1024);
    if (invalidFile) { window.alert(`${invalidFile.name}: chỉ hỗ trợ Excel .xls/.xlsx và tối đa 10 MB mỗi file.`); return; }
    setImportingFinance(true);
    setFinanceImportNotice(undefined);
    try {
      const XLSX = await import("xlsx");
      const parsed: ParsedFinanceImport[] = [];
      for (const file of files) {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        if (!sheet) throw new Error(`${file.name}: không tìm thấy sheet dữ liệu.`);
        // Some SAPO exports declare a range starting below their real header.
        // Expand it from actual cell addresses before converting the worksheet.
        const cellAddresses = Object.keys(sheet).filter((address) => /^[A-Z]+\d+$/.test(address));
        if (cellAddresses.length) {
          const cells = cellAddresses.map((address) => XLSX.utils.decode_cell(address));
          sheet["!ref"] = XLSX.utils.encode_range({
            s: { r: 0, c: 0 },
            e: { r: Math.max(...cells.map((cell) => cell.r)), c: Math.max(...cells.map((cell) => cell.c)) },
          });
        }
        const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
        const templateType = financeTemplateType(rows);
        if (!templateType) throw new Error(`${file.name}: chưa nhận diện được template. Hệ thống hiện hỗ trợ Doanh thu tổng quan, Danh mục mặt hàng, Hình thức phục vụ và Danh sách hóa đơn.`);
        if (!uatMode && templateType === "orders") throw new Error("Danh sách hóa đơn nền tảng và đối soát GRAB hiện chỉ có ở UAT.");
        parsed.push(templateType === "revenue" ? parseRevenueRows(file, rows) : templateType === "products" ? parseProductRows(file, rows) : templateType === "service" ? parseServiceRows(file, rows) : parsePlatformOrderRows(file, rows));
      }
      const revenueImports = parsed.filter((entry): entry is ParsedRevenueImport => entry.type === "revenue");
      const productImports = parsed.filter((entry): entry is ParsedProductImport => entry.type === "products");
      const serviceImports = parsed.filter((entry): entry is ParsedServiceImport => entry.type === "service");
      const orderImports = parsed.filter((entry): entry is ParsedOrderImport => entry.type === "orders");
      const pickImport = <T extends { meta: FinanceImportMeta | ImportMetaInput }>(entries: T[]) => [...entries].sort((left, right) => right.meta.periodEnd.localeCompare(left.meta.periodEnd) || right.meta.rowCount - left.meta.rowCount)[0];
      const duplicateTypes = [revenueImports.length > 1 ? "Doanh thu" : "", productImports.length > 1 ? "Mặt hàng" : "", serviceImports.length > 1 ? "Phương thức/Hình thức" : "", orderImports.length > 1 ? "Danh sách hóa đơn" : ""].filter(Boolean);
      const replacing = [revenueImports.length && state.revenues.length ? "Doanh thu" : "", productImports.length && state.products.length ? "Mặt hàng" : "", serviceImports.length && state.services.length ? "Hình thức phục vụ" : "", orderImports.length && state.platformOrders.length ? "Danh sách hóa đơn nền tảng" : ""].filter(Boolean);
      if (replacing.length && !window.confirm(uatMode ? `Import mới sẽ thay dữ liệu ${replacing.join(" và ")} trong đúng kỳ báo cáo; các kỳ khác và lịch sử import vẫn được giữ. Tiếp tục?` : `Import mới sẽ thay toàn bộ dữ liệu ${replacing.join(" và ")} hiện tại. Tiếp tục?`)) return;
      const revenue = pickImport(revenueImports);
      const products = pickImport(productImports);
      const service = pickImport(serviceImports);
      const orders = pickImport(orderImports);
      let verifiedCloudState: Awaited<ReturnType<typeof loadFinanceImports>> | undefined;
      if (!uatMode) {
        if (!isSupabaseConfigured) throw new Error("Production chưa cấu hình Supabase. Import đã dừng để tránh chỉ lưu dữ liệu trên trình duyệt.");
        await replaceFinanceImportBundle({
          revenue: revenue ? { meta: revenue.meta, records: revenue.records } : undefined,
          products: products ? { meta: products.meta, records: products.records } : undefined,
          service: service ? { meta: service.meta, records: service.records } : undefined,
        });
        // Read after write so the success state always reflects the latest committed Supabase snapshot.
        verifiedCloudState = await loadFinanceImports();
      }
      setState((current) => {
        if (verifiedCloudState) return { ...current, ...verifiedCloudState };
        let imports = current.imports;
        if (revenue) imports = [...imports.filter((entry) => entry.dataType !== "revenue"), revenue.importMeta];
        if (products) imports = [...imports.filter((entry) => entry.dataType !== "products"), products.importMeta];
        if (service) imports = [...imports.filter((entry) => entry.dataType !== "service"), service.importMeta];
        if (orders) imports = [...imports.filter((entry) => entry.dataType !== "orders"), orders.importMeta];
        const overlap = (left: FinanceImportMeta, right: FinanceImportMeta) => left.periodStart <= right.periodEnd && left.periodEnd >= right.periodStart;
        const existingProductSnapshots = current.productSnapshots.length || !current.products.length || !current.imports.find((entry) => entry.dataType === "products") ? current.productSnapshots : [...current.productSnapshots, { meta: current.imports.find((entry) => entry.dataType === "products")!, records: current.products }];
        const existingServiceSnapshots = current.serviceSnapshots.length || !current.services.length || !current.imports.find((entry) => entry.dataType === "service") ? current.serviceSnapshots : [...current.serviceSnapshots, { meta: current.imports.find((entry) => entry.dataType === "service")!, records: current.services }];
        const revenues = revenue ? [...current.revenues.filter((entry) => entry.date < revenue.meta.periodStart || entry.date > revenue.meta.periodEnd), ...revenue.records].sort((a, b) => b.date.localeCompare(a.date)) : current.revenues;
        const productSnapshots = products ? [...existingProductSnapshots.filter((snapshot) => !overlap(snapshot.meta, products.importMeta)), { meta: products.importMeta, records: products.records }] : existingProductSnapshots;
        const serviceSnapshots = service ? [...existingServiceSnapshots.filter((snapshot) => !overlap(snapshot.meta, service.importMeta)), { meta: service.importMeta, records: service.records }] : existingServiceSnapshots;
        const platformOrders = orders ? [...orders.records, ...current.platformOrders.filter((entry) => entry.orderDate < orders.periodStart || entry.orderDate > orders.periodEnd)] : current.platformOrders;
        const importedBatches = [revenue?.importMeta, products?.importMeta, service?.importMeta, orders?.importMeta].filter((entry): entry is FinanceImportMeta => Boolean(entry));
        const nextState = { ...current, revenues, products: products?.records || current.products, services: service?.records || current.services, platformOrders, imports, importHistory: [...current.importHistory, ...importedBatches], productSnapshots, serviceSnapshots };
        // Persist the complete UAT bundle atomically. This prevents a refresh or
        // a pending state effect from restoring the pre-import empty order list.
        if (uatMode) window.localStorage.setItem(storageKey, JSON.stringify(nextState));
        return nextState;
      });
      if (revenue || orders) {
        const latestDate = orders?.latestDate || revenue?.latestDate;
        setPeriodMode("month");
        setSelectedMonth(latestDate!.slice(0, 7));
        setSelectedYear(Number(latestDate!.slice(0, 4)));
      }
      // When the invoice file is part of the bundle, land on the platform tab
      // so the imported channel dashboards and order list are immediately visible.
      setRevenueSubTab(uatMode && orders ? "platform" : revenue || service ? "overview" : "products");
      setFinanceSyncError(undefined);
      setFinanceImportNotice(`Đã tự nhận diện và map ${parsed.map((entry) => entry.type === "revenue" ? `Doanh thu (${entry.meta.rowCount} ngày)` : entry.type === "products" ? `Mặt hàng (${entry.meta.rowCount} SKU)` : entry.type === "service" ? `Phương thức/Hình thức (${entry.meta.rowCount} nhóm)` : `Danh sách hóa đơn nền tảng (${entry.records.length} đơn, ${entry.records.filter((record) => normalizedHeader(record.channelName).includes("grab")).length} Grab)`).join(" + ")}${duplicateTypes.length ? `; ưu tiên file có kỳ mới hơn trong nhóm trùng: ${duplicateTypes.join(", ")}` : ""}.`);
    } catch (error) {
      const objectMessage = error && typeof error === "object" && "message" in error ? String(error.message || "") : "";
      const message = error instanceof Error ? error.message : objectMessage || "Không thể phân tích các file Excel.";
      setFinanceSyncError(message);
      window.alert(message);
    } finally {
      setImportingFinance(false);
    }
  }

  function editGrabReconciliation(entry: GrabReconciliationRecord) {
    setGrabForm({
      id: entry.id,
      platformOrderId: entry.platformOrderId || state.platformOrders.find((order) => order.orderDate === entry.orderDate && order.orderCode.toLocaleLowerCase("vi") === entry.orderCode.toLocaleLowerCase("vi"))?.id || "",
      orderCode: entry.orderCode,
      orderDate: entry.orderDate,
      reportedAmount: amountInput(String(entry.reportedAmount)),
      receivedAmount: amountInput(String(entry.receivedAmount)),
      note: entry.note || "",
    });
    setShowGrabReconciliationModal(true);
  }

  function selectGrabOrder(orderId: string) {
    const order = state.platformOrders.find((entry) => entry.id === orderId);
    if (!order) return;
    const existing = state.grabReconciliations.find((entry) => entry.orderDate === order.orderDate && entry.orderCode.toLocaleLowerCase("vi") === order.orderCode.toLocaleLowerCase("vi"));
    setGrabForm({
      id: existing?.id,
      platformOrderId: order.id,
      orderCode: order.orderCode,
      orderDate: order.orderDate,
      reportedAmount: amountInput(String(order.reportedAmount)),
      receivedAmount: existing ? amountInput(String(existing.receivedAmount)) : "",
      note: existing?.note || "",
    });
  }

  function openPlatformReconciliation(order: PlatformOrderRecord) {
    if (!isGrabPlatformOrder(order)) return;
    selectGrabOrder(order.id);
    setShowGrabReconciliationModal(true);
  }

  async function persistGrabReconciliation(record: GrabReconciliationRecord) {
    let persistedRecord = record;
    if (!uatMode) {
      if (!isSupabaseConfigured) throw new Error("Production chưa cấu hình Supabase. Đối soát GRAB chưa được lưu.");
      const saved = await upsertFinanceGrabReconciliations([record]);
      const cloudRecord = saved.find((entry) => entry.id === record.id);
      if (!cloudRecord) throw new Error("Supabase không trả lại dòng đối soát GRAB sau khi lưu. Giao dịch đã dừng để tránh chỉ lưu local.");
      persistedRecord = cloudRecord;
    }
    setState((current) => ({
      ...current,
      grabReconciliations: current.grabReconciliations.some((entry) => entry.id === persistedRecord.id)
        ? current.grabReconciliations.map((entry) => entry.id === persistedRecord.id ? persistedRecord : entry)
        : [persistedRecord, ...current.grabReconciliations],
    }));
  }

  async function saveGrabReconciliation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const orderCode = grabForm.orderCode.trim();
    const reportedAmount = parseAmount(grabForm.reportedAmount);
    const receivedAmount = parseAmount(grabForm.receivedAmount);
    if (!grabForm.platformOrderId || !orderCode || !grabForm.orderDate || receivedAmount < 0 || reportedAmount < 0) {
      window.alert("Vui lòng chọn đơn Grab từ file SAPO và nhập số tiền thực nhận hợp lệ.");
      return;
    }
    const existingSameOrder = state.grabReconciliations.find((entry) => entry.orderCode.toLocaleLowerCase("vi") === orderCode.toLocaleLowerCase("vi") && entry.orderDate === grabForm.orderDate);
    const record: GrabReconciliationRecord = {
      id: grabForm.id || existingSameOrder?.id || `grab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      platformOrderId: grabForm.platformOrderId,
      orderCode,
      orderDate: grabForm.orderDate,
      reportedAmount,
      receivedAmount,
      note: grabForm.note.trim() || undefined,
    };
    setSavingGrabReconciliation(true);
    setFinanceSyncError(undefined);
    try {
      await persistGrabReconciliation(record);
      setGrabForm(grabReconciliationFormDefaults());
      setShowGrabReconciliationModal(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Không thể lưu đối soát GRAB.";
      setFinanceSyncError(message);
      window.alert(message);
    } finally {
      setSavingGrabReconciliation(false);
    }
  }

  async function deleteGrabReconciliation(id: string) {
    if (!window.confirm("Xoá dòng đối soát GRAB này?")) return;
    setFinanceSyncError(undefined);
    try {
      if (!uatMode) {
        if (!isSupabaseConfigured) throw new Error("Production chưa cấu hình Supabase. Không thể xoá đối soát GRAB.");
        await deleteFinanceGrabReconciliation(id);
      }
      setState((current) => ({ ...current, grabReconciliations: current.grabReconciliations.filter((entry) => entry.id !== id) }));
      if (grabForm.id === id) setGrabForm(grabReconciliationFormDefaults());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Không thể xoá đối soát GRAB.";
      setFinanceSyncError(message);
      window.alert(message);
    }
  }

  function togglePeriodClose() {
    if (periodMode !== "month") { window.alert("Khóa sổ được thực hiện theo từng tháng."); return; }
    const closing = !currentPeriodClosed;
    if (!window.confirm(closing ? `Khóa sổ ${bounds.label}? Các giao dịch thủ công trong kỳ sẽ không sửa trực tiếp được.` : `Mở lại ${bounds.label} để chỉnh sửa dữ liệu?`)) return;
    setState((current) => ({ ...current, closedPeriods: closing ? [...new Set([...current.closedPeriods, bounds.key])] : current.closedPeriods.filter((key) => key !== bounds.key) }));
  }

  function resetUat() {
    if (!window.confirm("Nạp lại toàn bộ dữ liệu mẫu tài chính local? Các thay đổi UAT hiện tại sẽ mất.")) return;
    setState(seedFinanceState());
  }

  const occurrenceDetails = (category: ExpenseCategory) => manualOccurrences.filter((entry) => entry.expense.category === category).map((entry) => ({ label: entry.expense.name, date: entry.date, amount: -entry.amount, subcategory: entry.expense.subcategory || "Khác" }));
  const occurrenceGroups = (category: ExpenseCategory) => {
    const groups = new Map<string, PnlDetail[]>();
    for (const detail of occurrenceDetails(category)) groups.set(detail.subcategory, [...(groups.get(detail.subcategory) || []), { label: detail.label, date: detail.date, amount: detail.amount }]);
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "vi")).map(([label, details]) => ({ label, details, value: details.reduce((sum, detail) => sum + detail.amount, 0) }));
  };
  const detailGroup = (label: string, details: PnlDetail[]): PnlGroup => ({ label, details, value: details.reduce((sum, detail) => sum + detail.amount, 0) });
  const nonEmptyGroups = (groups: PnlGroup[]) => groups.filter((group) => group.details.length > 0);
  const groupDetailsBy = <T,>(entries: T[], groupLabel: (entry: T) => string, detail: (entry: T) => PnlDetail) => {
    const groups = new Map<string, PnlDetail[]>();
    for (const entry of entries) {
      const label = groupLabel(entry) || "Khác";
      groups.set(label, [...(groups.get(label) || []), detail(entry)]);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right, "vi")).map(([label, details]) => detailGroup(label, details));
  };
  const inventoryEntries = (kind: "cogs" | "waste") => inventoryEvents.filter((entry) => entry.kind === kind);
  const inventoryDetails = (kind: "cogs" | "waste") => inventoryEntries(kind).map((entry) => ({ label: `${entry.lot.name} · ${entry.lot.receiptCode || "không mã phiếu"}`, date: entry.date, amount: -entry.amount }));
  const inventoryGroups = (kind: "cogs" | "waste") => groupDetailsBy(inventoryEntries(kind), (entry) => entry.lot.category.trim() || "KHÁC", (entry) => ({ label: `${entry.lot.name} · ${entry.lot.receiptCode || "không mã phiếu"}`, date: entry.date, amount: -entry.amount }));
  const revenueDetails = periodRevenues.map((entry) => ({ label: "Bán hàng", date: entry.date, amount: entry.storeRevenue + entry.appRevenue }));
  const discountDetails = periodRevenues.filter((entry) => entry.discounts).map((entry) => ({ label: "Giảm giá / voucher", date: entry.date, amount: -entry.discounts }));
  const platformDetails = periodRevenues.filter((entry) => entry.platformFees).map((entry) => ({ label: "Phí nền tảng", date: entry.date, amount: -entry.platformFees }));
  const pnlRows: PnlRow[] = [
    { label: "Doanh thu gộp", value: grossRevenue, tone: "income", details: revenueDetails, groups: [detailGroup("Bán hàng", revenueDetails)], itemCount: revenueDetails.length },
    { label: "Giảm giá / voucher", value: -discounts, tone: "deduction", details: discountDetails, groups: [detailGroup("Giảm giá / voucher", discountDetails)], itemCount: discountDetails.length },
    { label: "Doanh thu thuần", value: netRevenue, tone: "total", details: [{ label: "Doanh thu gộp", amount: grossRevenue }, { label: "Giảm giá / voucher", amount: -discounts }], groups: [detailGroup("Cấu thành doanh thu thuần", [{ label: "Doanh thu gộp", amount: grossRevenue }, { label: "Giảm giá / voucher", amount: -discounts }])], itemCount: 2 },
    { label: "NVL đã xuất dùng", value: -inventoryCogs, tone: "cost", details: inventoryDetails("cogs"), groups: inventoryGroups("cogs"), itemCount: inventoryDetails("cogs").length },
    { label: "Hao hụt NVL", value: -inventoryWaste, tone: "cost", details: inventoryDetails("waste"), groups: inventoryGroups("waste"), itemCount: inventoryDetails("waste").length },
    { label: "Lợi nhuận gộp", value: grossProfit, tone: "total", details: [{ label: "Doanh thu thuần", amount: netRevenue }, { label: "NVL đã xuất dùng", amount: -inventoryCogs }, { label: "Hao hụt NVL", amount: -inventoryWaste }], groups: [detailGroup("Cấu thành lợi nhuận gộp", [{ label: "Doanh thu thuần", amount: netRevenue }, { label: "NVL đã xuất dùng", amount: -inventoryCogs }, { label: "Hao hụt NVL", amount: -inventoryWaste }])], itemCount: 3 },
    { label: "Chi phí cố định", value: -fixedCost, tone: "cost", details: occurrenceDetails("fixed"), groups: occurrenceGroups("fixed"), itemCount: occurrenceDetails("fixed").length },
    { label: "Chi phí vận hành", value: -operatingCost, tone: "cost", details: occurrenceDetails("operating"), groups: occurrenceGroups("operating"), itemCount: occurrenceDetails("operating").length },
    { label: "Chi phí bán hàng & nền tảng", value: -salesCost, tone: "cost", details: [...occurrenceDetails("sales"), ...platformDetails], groups: [...occurrenceGroups("sales"), ...(platformDetails.length ? [{ label: "Phí nền tảng", details: platformDetails, value: platformDetails.reduce((sum, detail) => sum + detail.amount, 0) }] : [])], itemCount: occurrenceDetails("sales").length + platformDetails.length },
    { label: "EBITDA", value: ebitda, tone: "total", details: [{ label: "Lợi nhuận gộp", amount: grossProfit }, { label: "Chi phí cố định", amount: -fixedCost }, { label: "Chi phí vận hành", amount: -operatingCost }, { label: "Chi phí bán hàng & nền tảng", amount: -salesCost }], groups: [detailGroup("Cấu thành EBITDA", [{ label: "Lợi nhuận gộp", amount: grossProfit }, { label: "Chi phí cố định", amount: -fixedCost }, { label: "Chi phí vận hành", amount: -operatingCost }, { label: "Chi phí bán hàng & nền tảng", amount: -salesCost }])], itemCount: 4 },
    { label: "Khấu hao", value: -depreciation, tone: "cost", details: assetExpenses.map((asset) => ({ label: asset.name, date: bounds.end, amount: -depreciationForAsset(asset, bounds) })), groups: groupDetailsBy(assetExpenses, (asset) => asset.subcategory || "Khác", (asset) => ({ label: asset.name, date: bounds.end, amount: -depreciationForAsset(asset, bounds) })), itemCount: assetExpenses.length },
    { label: "Lợi nhuận hoạt động", value: operatingProfit, tone: "grand", details: [{ label: "EBITDA", amount: ebitda }, { label: "Khấu hao", amount: -depreciation }], groups: [detailGroup("Cấu thành lợi nhuận hoạt động", [{ label: "EBITDA", amount: ebitda }, { label: "Khấu hao", amount: -depreciation }])], itemCount: 2 },
  ];
  const cashInDetails: PnlDetail[] = periodRevenues.map((entry) => ({ label: "Thu bán hàng", date: entry.date, amount: entry.cashReceived || entry.storeRevenue + entry.appRevenue - entry.discounts - entry.platformFees }));
  const purchaseLots = inventoryLots.filter((lot) => !lot.internalReturn && inRange(lot.purchasedOn, bounds));
  const paidExpenseDetails: PnlDetail[] = manualOccurrences.filter((entry) => entry.expense.paymentStatus === "paid").map((entry) => ({ label: entry.expense.name, date: entry.date, amount: -entry.amount }));
  const paidAssetDetails: PnlDetail[] = assetExpenses.filter((asset) => asset.paymentStatus === "paid" && inRange(asset.paymentDate || asset.incurredOn, bounds)).map((asset) => ({ label: asset.name, date: asset.paymentDate || asset.incurredOn, amount: -asset.amount }));
  const purchaseDetails: PnlDetail[] = purchaseLots.map((lot) => ({ label: `${lot.name} · ${lot.receiptCode || "không mã phiếu"}`, date: lot.purchasedOn, amount: -(lot.quantity * lot.unitCost) }));
  const cashOutDetails = [...purchaseDetails, ...paidExpenseDetails, ...paidAssetDetails];
  const cashRows: PnlRow[] = [
    { label: "Tiền vào", value: cashIn, tone: "income", details: cashInDetails, groups: [detailGroup("Thu bán hàng", cashInDetails)], itemCount: cashInDetails.length },
    { label: "Tiền ra", value: -cashOut, tone: "cost", details: cashOutDetails, groups: nonEmptyGroups([detailGroup("Mua NVL", purchaseDetails), detailGroup("Chi phí đã trả", paidExpenseDetails), detailGroup("Mua tài sản", paidAssetDetails)]), itemCount: cashOutDetails.length },
    { label: "Dòng tiền thuần", value: netCash, tone: "grand", details: [{ label: "Tiền vào", amount: cashIn }, { label: "Tiền ra", amount: -cashOut }], groups: [detailGroup("Cấu thành dòng tiền", [{ label: "Tiền vào", amount: cashIn }, { label: "Tiền ra", amount: -cashOut }])], itemCount: 2 },
  ];
  const openingInventoryEntries = inventoryLots.filter((lot) => (lot.availableFrom || lot.purchasedOn) < bounds.start).map((lot) => {
    const issuedBefore = inventorySessions.filter((session) => session.sourceReceiptId === lot.id && (session.costRecognitionMonth ? `${session.costRecognitionMonth}-01` : session.activatedAt.slice(0, 10)) < bounds.start).length;
    return { lot, amount: Math.max(0, lot.quantity - issuedBefore) * lot.unitCost };
  }).filter((entry) => entry.amount > 0);
  const closingInventoryEntries = inventoryLots.filter((lot) => (lot.availableFrom || lot.purchasedOn) <= bounds.end).map((lot) => {
    const issuedByEnd = inventorySessions.filter((session) => session.sourceReceiptId === lot.id && (session.costRecognitionMonth ? `${session.costRecognitionMonth}-01` : session.activatedAt.slice(0, 10)) <= bounds.end).length;
    return { lot, amount: Math.max(0, lot.quantity - issuedByEnd) * lot.unitCost };
  }).filter((entry) => entry.amount > 0);
  const inventoryReportGroups = (entries: Array<{ lot: FinanceInventoryLot; amount: number }>, sign = 1) => groupDetailsBy(entries, (entry) => entry.lot.category || "KHÁC", (entry) => ({ label: `${entry.lot.name} · ${entry.lot.receiptCode || "không mã phiếu"}`, date: entry.lot.availableFrom || entry.lot.purchasedOn, amount: entry.amount * sign }));
  const inventoryRows: PnlRow[] = [
    { label: "Tồn đầu kỳ", value: openingInventory, tone: "total", details: [], groups: inventoryReportGroups(openingInventoryEntries), itemCount: openingInventoryEntries.length },
    { label: "Nhập kho", value: inventoryPurchases, tone: "income", details: purchaseDetails.map((detail) => ({ ...detail, amount: Math.abs(detail.amount) })), groups: inventoryReportGroups(purchaseLots.map((lot) => ({ lot, amount: lot.quantity * lot.unitCost }))), itemCount: purchaseLots.length },
    { label: "Xuất dùng", value: -inventoryIssued, tone: "cost", details: inventoryDetails("cogs"), groups: inventoryGroups("cogs"), itemCount: inventoryDetails("cogs").length },
    { label: "Hao hụt", value: -inventoryWaste, tone: "cost", details: inventoryDetails("waste"), groups: inventoryGroups("waste"), itemCount: inventoryDetails("waste").length },
    { label: "Tồn cuối kỳ", value: closingInventory, tone: "grand", details: [], groups: inventoryReportGroups(closingInventoryEntries), itemCount: closingInventoryEntries.length },
  ];
  const assetValueDetails: PnlDetail[] = assetExpenses.map((asset) => ({ label: asset.name, date: asset.inServiceOn || asset.incurredOn, amount: asset.amount }));
  const assetDepreciationDetails: PnlDetail[] = assetExpenses.map((asset) => ({ label: asset.name, date: bounds.end, amount: -depreciationForAsset(asset, bounds) }));
  const assetRows: PnlRow[] = [
    { label: "Tài sản đang quản lý", value: assetExpenses.reduce((sum, asset) => sum + asset.amount, 0), tone: "total", details: assetValueDetails, groups: groupDetailsBy(assetExpenses, (asset) => asset.subcategory || "Khác", (asset) => ({ label: asset.name, date: asset.inServiceOn || asset.incurredOn, amount: asset.amount })), itemCount: assetExpenses.length },
    { label: "Khấu hao trong kỳ", value: -depreciation, tone: "cost", details: assetDepreciationDetails, groups: groupDetailsBy(assetExpenses, (asset) => asset.subcategory || "Khác", (asset) => ({ label: asset.name, date: bounds.end, amount: -depreciationForAsset(asset, bounds) })), itemCount: assetExpenses.length },
  ];
  const pnlCostMix = [
    { label: "NVL", value: inventoryCogs + inventoryWaste },
    { label: "Cố định", value: fixedCost },
    { label: "Vận hành", value: operatingCost },
    { label: "Bán hàng", value: salesCost },
    { label: "Khấu hao", value: depreciation },
  ].filter((entry) => entry.value > 0);
  const maxPnlCost = Math.max(...pnlCostMix.map((entry) => entry.value), 1);
  const cashComponents = [
    { label: "Mua NVL", value: inventoryPurchases },
    { label: "Chi phí đã trả", value: paidManual },
    { label: "Mua tài sản", value: paidInvestments },
  ].filter((entry) => entry.value > 0);
  const maxCashComponent = Math.max(...cashComponents.map((entry) => entry.value), 1);
  const closingCategoryValues = [...closingInventoryEntries.reduce<Map<string, number>>((groups, entry) => groups.set(entry.lot.category || "KHÁC", (groups.get(entry.lot.category || "KHÁC") || 0) + entry.amount), new Map()).entries()].map(([label, value]) => ({ label, value })).sort((left, right) => right.value - left.value).slice(0, 6);
  const maxClosingCategory = Math.max(...closingCategoryValues.map((entry) => entry.value), 1);
  const assetOriginalValue = assetExpenses.reduce((sum, asset) => sum + asset.amount, 0);
  const assetRemainingValue = assetExpenses.reduce((sum, asset) => {
    const monthly = Math.max(0, asset.amount - (asset.salvageValue || 0)) / (asset.usefulLifeMonths || 1);
    const elapsed = Math.min(asset.usefulLifeMonths || 0, Math.max(0, monthDiff(asset.inServiceOn || asset.incurredOn, bounds.end) + 1));
    return sum + Math.max(asset.salvageValue || 0, asset.amount - monthly * elapsed);
  }, 0);
  const assetAccumulatedValue = Math.max(0, assetOriginalValue - assetRemainingValue);
  const assetCategoryValues = [...assetExpenses.reduce<Map<string, number>>((groups, asset) => groups.set(asset.subcategory || "Khác", (groups.get(asset.subcategory || "Khác") || 0) + asset.amount), new Map()).entries()].map(([label, value]) => ({ label, value })).sort((left, right) => right.value - left.value);
  const maxAssetCategory = Math.max(...assetCategoryValues.map((entry) => entry.value), 1);

  return <div className={styles.finance}>
    <header className={styles.financeHero}>
      <span className={styles.eyebrow}>NHA COFFEE & TEA{uatMode ? " · UAT LOCAL" : ""}</span>
      <div className={styles.financeHeroRow}><div><h1>Tài chính</h1><p>Theo dõi doanh thu, chi phí, dòng tiền và sức khỏe vận hành.</p></div><div className={styles.logo}><Image src="/nha-coffee-logo-transparent.png" alt="Nhà Coffee & Tea" width={750} height={420} priority /></div></div>
      <div className={styles.heroMetric}><span>{tab === "revenue" ? `Doanh thu thực · ${bounds.label}` : `Lợi nhuận hoạt động · ${bounds.label}`}</span><strong>{money(tab === "revenue" ? datasetRevenue : operatingProfit)}</strong><small>{tab === "revenue" ? revenueDataset.length ? `${revenueDataset.length.toLocaleString("vi-VN")} ngày có dữ liệu trong kỳ` : "Chưa có doanh thu trong kỳ" : netRevenue ? `${((operatingProfit / netRevenue) * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}% doanh thu thuần` : "Chưa có doanh thu trong kỳ"}</small></div>
    </header>

    <section className={styles.periodPanel}>
      <div className={styles.periodModes}>{(["month", "quarter", "year"] as PeriodMode[]).map((mode) => <button className={periodMode === mode ? styles.selected : ""} key={mode} onClick={() => setPeriodMode(mode)}>{mode === "month" ? "Tháng" : mode === "quarter" ? "Quý" : "Năm"}</button>)}</div>
      <div className={styles.periodPicker}>{periodMode === "month" ? <select value={selectedMonth} onChange={(event) => { setSelectedMonth(event.target.value); setSelectedYear(Number(event.target.value.slice(0, 4))); }}>{selectableMonths.map((month) => <option value={month.value} key={month.value}>{month.label}</option>)}</select> : <><select value={selectedYear} onChange={(event) => setSelectedYear(Number(event.target.value))}>{Array.from({ length: 5 }, (_, index) => new Date().getFullYear() - 2 + index).map((year) => <option key={year}>{year}</option>)}</select>{periodMode === "quarter" && <select value={selectedQuarter} onChange={(event) => setSelectedQuarter(Number(event.target.value))}><option value={1}>Quý 1</option><option value={2}>Quý 2</option><option value={3}>Quý 3</option><option value={4}>Quý 4</option></select>}</>}</div>
      <div className={styles.periodStatus}><b>{bounds.label}</b><span>{currentPeriodClosed ? "● Đã khóa sổ" : "● Đang mở"}</span></div>
    </section>

    <nav className={styles.financeTabs} aria-label="Điều hướng tài chính">
      <button className={tab === "entry" ? styles.active : ""} onClick={() => setTab("entry")}>Ghi nhận chi phí</button>
      <button className={tab === "revenue" ? styles.active : ""} onClick={() => setTab("revenue")}>Doanh thu</button>
      <button className={tab === "report" ? styles.active : ""} onClick={() => setTab("report")}>Báo cáo tài chính</button>
      <button className={tab === "dashboard" ? styles.active : ""} onClick={() => setTab("dashboard")}>Dashboard</button>
    </nav>

    {tab === "entry" && <section className={styles.content}>
      <div className={styles.summaryStrip}><div><span>Tổng chi phí kỳ</span><strong>{money(totalPeriodExpense)}</strong></div><div><span>Đã thanh toán</span><strong>{money(paidManual + inventoryPurchases + paidInvestments)}</strong></div><div><span>Chưa thanh toán</span><strong>{money(unpaidManual)}</strong></div><div><span>Từ Kho NVL</span><strong>{money(inventoryCogs + inventoryWaste)}</strong></div></div>
      <div className={styles.sectionHeader}><div><span>GIAO DỊCH TRONG KỲ</span><h2>Chi phí vận hành quán</h2></div><div className={styles.expenseHeaderActions}><label className={importingExpenses ? styles.importing : ""}><input type="file" accept=".xls,.xlsx" disabled={importingExpenses} onChange={importExpensesExcel} />{importingExpenses ? "Đang nhập…" : "Nhập Excel"}</label><button type="button" disabled={!state.expenses.length} onClick={() => void exportExpensesExcel()}>Xuất Excel</button><button className={styles.addExpenseButton} onClick={() => openAddExpense(expenseCategory)}>+ Thêm chi phí</button></div></div>
      {expenseImportNotice && <div className={styles.importHubSuccess}><b>Excel chi phí</b><span>{expenseImportNotice}</span></div>}
      {financeSyncError && <div className={styles.syncError}><b>Không thể đồng bộ dữ liệu</b><span>{financeSyncError}</span></div>}
      <div className={styles.categoryTabs}>{expenseCategorySections.map((section) => <button key={section.category} className={expenseCategory === section.category ? styles.selected : ""} onClick={() => setExpenseCategory(section.category)}><span>{categoryLabels[section.category]} ({section.count})</span><b>{section.count}</b></button>)}</div>
      <div className={styles.expenseList}>
        <details className={styles.expenseCategoryGroup} open>
          <summary><span>{categoryLabels[selectedExpenseSection.category]} <small>({selectedExpenseSection.count})</small></span><b>{selectedExpenseSection.count ? money([...selectedExpenseSection.manualEntries, ...selectedExpenseSection.inventoryEvents].reduce((sum, entry) => sum + entry.amount, 0)) : "-"}</b></summary>
          <div className={styles.expenseCategoryGroupBody}>
        {selectedExpenseSection.inventoryEvents.length > 0 && <details className={`${styles.expenseGroup} ${styles.inventorySourceGroup}`}>
          <summary><span>Từ Kho NVL <small>({selectedExpenseSection.inventoryEvents.length} khoản)</small></span><b>{money(selectedExpenseSection.inventoryEvents.reduce((sum, entry) => sum + entry.amount, 0))}</b></summary>
          <div className={styles.inventoryCategoryList}>{selectedExpenseSection.inventoryCategoryGroups.map(([inventoryCategory, entries]) => <details className={styles.inventoryCategoryGroup} key={inventoryCategory}>
            <summary><span>{inventoryCategory} <small>({entries.length} khoản)</small></span><b>{money(entries.reduce((sum, entry) => sum + entry.amount, 0))}</b></summary>
            <div className={styles.expenseGroupItems}>{entries.map((entry) => <button type="button" className={`${styles.compactExpenseCard} ${entry.kind === "waste" ? styles.wasteCard : ""}`} key={entry.id} onClick={() => onOpenInventoryLot(entry.lot.id)}><span>{entry.lot.name} · {entry.kind === "waste" ? "Hao hụt" : "Xuất dùng"} {dateLabel(entry.date)}</span><b>{money(entry.amount)}</b></button>)}</div>
          </details>)}</div>
        </details>}
        {selectedExpenseSection.manualGroups.map(([subcategory, entries]) => <details className={styles.expenseGroup} key={subcategory}><summary><span>{subcategory} <small>({entries.length} khoản)</small></span><b>{money(entries.reduce((sum, entry) => sum + entry.expense.amount, 0))}</b></summary><div className={styles.expenseGroupItems}>{entries.map(({ expense, date }) => <button type="button" className={styles.compactExpenseCard} key={`${expense.id}-${date}`} onClick={() => openEditExpense(expense)}><span>{expense.name} · {expense.recurrence === "once" ? dateLabel(date) : `TT ${dateLabel(date)}`}</span><b>{money(expense.amount)}</b></button>)}</div></details>)}
        {!selectedExpenseSection.count && <div className={styles.empty}><b>Chưa có chi phí trong nhóm này</b><span>Nhấn “Thêm chi phí” để tạo giao dịch đầu tiên.</span></div>}
          </div>
        </details>
      </div>
      {uatMode ? <div className={styles.uatTools}><span>Dữ liệu tài chính UAT chỉ lưu trong trình duyệt này; có thể chuyển máy qua file Excel.</span><button onClick={resetUat}>Nạp lại dữ liệu mẫu</button></div> : <div className={styles.cloudStatus}>✓ Ghi nhận chi phí đang đồng bộ Supabase giữa các thiết bị.</div>}
    </section>}

    {tab === "revenue" && <section className={`${styles.content} ${styles.revenueContent}`}>
      <div className={styles.revenueSubTabs}>
        <button type="button" className={revenueSubTab === "overview" ? styles.selected : ""} onClick={() => selectRevenueSubTab("overview")}><span>Tổng quan</span><small>{revenueImport?.rowCount || 0} ngày</small></button>
        <button type="button" className={revenueSubTab === "products" ? styles.selected : ""} onClick={() => selectRevenueSubTab("products")}><span>Mặt hàng</span><small>{productsImport?.rowCount || 0} SKU</small></button>
        {uatMode && <button type="button" className={revenueSubTab === "platform" ? styles.selected : ""} onClick={() => selectRevenueSubTab("platform")}><span>Nền tảng</span><small>{periodPlatformOrders.length || state.platformOrders.length} hóa đơn</small></button>}
      </div>

      <section className={styles.financeImportHub}>
        <div className={styles.importHubCopy}><span>IMPORT CENTER</span><h2>{uatMode ? "Bộ 4 file SAPO" : "Bộ 3 file SAPO"}</h2><p>{uatMode ? "Chọn cùng lúc Doanh thu tổng quan, Danh mục mặt hàng, Hình thức phục vụ và Danh sách hóa đơn. Hệ thống tự nhận diện từng file và map vào đúng dashboard." : "Chọn cùng lúc Doanh thu tổng quan, Danh mục mặt hàng và Hình thức phục vụ. Dữ liệu được map vào đúng dashboard."}</p></div>
        <label className={`${styles.importHubButton} ${importingFinance ? styles.importing : ""}`}><input type="file" accept=".xls,.xlsx" multiple disabled={importingFinance} onChange={importFinanceExcel} /><span>{importingFinance ? "Đang phân tích & đồng bộ…" : `⇧ Chọn ${uatMode ? "4" : "3"} file Excel cùng lúc`}</span><small>{uatMode ? "Doanh thu · Mặt hàng · Phương thức/Hình thức · Hóa đơn" : "Doanh thu · Mặt hàng · Phương thức/Hình thức"}</small></label>
        <div className={styles.importHubTypes}><span><i>DT</i>Doanh thu tổng quan</span><span><i>MH</i>Danh mục mặt hàng</span><span><i>PV</i>Hình thức phục vụ</span>{uatMode && <span><i>ĐH</i>Danh sách hóa đơn</span>}<b>{[revenueImport, productsImport, serviceImport, ...(uatMode ? [ordersImport] : [])].filter(Boolean).length}/{uatMode ? 4 : 3} loại đã có dữ liệu</b></div>
        {financeImportNotice && <div className={styles.importHubSuccess}><b>Import hoàn tất</b><span>{financeImportNotice}</span></div>}
      </section>

      {financeSyncError && <div className={styles.syncError}><b>Không thể import hoặc đồng bộ dữ liệu</b><span>{financeSyncError}</span></div>}

      {revenueSubTab === "overview" && <>
        <div className={styles.revenueHeader}>
          <div><span>DOANH THU TỔNG QUAN</span><h2>{bounds.label}</h2><p>Chỉ hiển thị doanh thu phát sinh trong kỳ đang lọc.</p></div>
        </div>
        {!revenueDataset.length && !periodServices.length ? <div className={styles.revenueEmpty}><div>DT</div><h3>Chưa có báo cáo doanh thu</h3><p>Chọn file tại Import Center phía trên. Hệ thống sẽ tự đưa báo cáo vào tab Tổng quan.</p></div> : <>
          <div className={styles.revenueKpis}>
            <article className={styles.primaryRevenueKpi}><span>DOANH THU THỰC</span><strong>{money(datasetRevenue)}</strong><small>{importedRevenueRows.length.toLocaleString("vi-VN")} dòng báo cáo</small></article>
            <article><span>Đơn thành công</span><strong>{successfulOrders.toLocaleString("vi-VN")}</strong><small>/ {totalReportedOrders.toLocaleString("vi-VN")} tổng đơn</small></article>
            <article><span>Số lượng hàng</span><strong>{datasetItems.toLocaleString("vi-VN")}</strong><small>{averageItemsPerOrder.toLocaleString("vi-VN", { maximumFractionDigits: 2 })} SP/đơn</small></article>
            <article><span>Trung bình/đơn</span><strong>{money(averagePerOrder)}</strong><small>trên đơn thành công</small></article>
            <article><span>Trung bình/sản phẩm</span><strong>{money(averagePerItem)}</strong><small>doanh thu thực / số lượng hàng</small></article>
            <article className={cancellationRate > 3 ? styles.warningKpi : ""}><span>Tỷ lệ hủy</span><strong>{percent(cancellationRate)}</strong><small>{cancelledOrders.toLocaleString("vi-VN")} đơn · {money(reportedCancelledAmount)}</small></article>
          </div>
          <div className={styles.revenueInsightGrid}>
            <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>GROSS-TO-NET</span><strong>{money(reportedGoodsAmount)} tiền hàng</strong></div><small>{percent(discountRate)} giảm giá</small></div><div className={styles.adjustmentList}>{revenueAdjustments.map((entry) => <div key={entry.label}><div><span>{entry.label}</span><b>-{money(entry.value)}</b></div><div className={styles.adjustmentTrack}><i style={{ width: `${entry.value / maxRevenueAdjustment * 100}%` }} /></div></div>)}<div className={styles.netRevenueRow}><span>Doanh thu thực</span><b>{money(datasetRevenue)}</b></div></div></article>
            <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>ĐỐI SOÁT HAI BÁO CÁO</span><strong>{periodProducts.length ? money(Math.abs(revenueProductGap)) : "Chờ file mặt hàng"}</strong></div><small>Chênh lệch</small></div>{periodProducts.length ? <div className={styles.reconciliation}><div><span>Doanh thu thực</span><b>{money(datasetRevenue)}</b><i style={{ width: "100%" }} /></div><div><span>Tổng tiền mặt hàng</span><b>{money(productNetAmount)}</b><i style={{ width: `${datasetRevenue ? Math.min(100, productNetAmount / datasetRevenue * 100) : 0}%` }} /></div><p>Chênh lệch có thể đến từ đơn hủy, phí hoặc cấu hình báo cáo Sapo. Dùng ô này để kiểm tra hai file cùng kỳ.</p></div> : <div className={styles.panelEmpty}>Import thêm Báo cáo mặt hàng để đối soát doanh thu và cơ cấu sản phẩm.</div>}</article>
          </div>
        </>}
      </>}

      {revenueSubTab === "products" && <>
        <div className={styles.revenueHeader}>
          <div><span>BÁO CÁO MẶT HÀNG</span><h2>{bounds.label}</h2><p>Hiển thị dữ liệu của file có kỳ báo cáo giao với bộ lọc đang chọn.</p></div>
        </div>
        {!periodProducts.length ? <div className={styles.revenueEmpty}><div>MH</div><h3>Chưa có báo cáo mặt hàng</h3><p>Chọn file tại Import Center phía trên. Hệ thống sẽ tự đưa báo cáo vào tab Mặt hàng.</p></div> : <>
          <div className={styles.productKpis}><article><span>TỔNG TIỀN MẶT HÀNG</span><strong>{money(productNetAmount)}</strong><small>sau giảm giá</small></article><article><span>SẢN PHẨM BÁN</span><strong>{productQuantity.toLocaleString("vi-VN")}</strong><small>{periodProducts.length} SKU</small></article><article><span>DANH MỤC</span><strong>{categoryPerformance.length}</strong><small>nhóm sản phẩm</small></article><article><span>GIẢM GIÁ</span><strong>{money(productDiscountAmount)}</strong><small>{percent(productDiscountRate)} tiền hàng</small></article><article><span>TB/SẢN PHẨM</span><strong>{money(averageProductValue)}</strong><small>sau giảm giá</small></article></div>
          <div className={styles.productVisualGrid}>
            <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>DOANH THU THEO DANH MỤC</span><strong>{categoryPerformance.length} danh mục</strong></div></div><div className={styles.categoryBars}>{categoryPerformance.map((entry) => <div key={entry.name}><div><span><b>{entry.name}</b><small>{entry.quantity.toLocaleString("vi-VN")} SP · {entry.skuCount} SKU</small></span><strong>{money(entry.revenue)}</strong></div><div><i style={{ width: `${entry.revenue / maxCategoryRevenue * 100}%` }} /></div></div>)}</div></article>
            <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>TOP MẶT HÀNG</span><strong>Theo tổng tiền</strong></div></div><div className={styles.topRevenueList}>{topProducts.map((entry, index) => <div key={entry.id}><i>{index + 1}</i><span><b>{entry.name} {entry.variant ? `· ${entry.variant}` : ""}</b><small>{entry.category} · {entry.quantity.toLocaleString("vi-VN")} SP</small></span><strong>{money(entry.totalAmount)}</strong></div>)}</div></article>
          </div>
          <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>MẶT HÀNG GIẢM GIÁ CAO</span><strong>Cần kiểm tra biên lợi nhuận</strong></div><small>% trên tiền hàng</small></div><div className={styles.discountProductList}>{highDiscountProducts.map((entry) => <div key={entry.id}><span><b>{entry.name} {entry.variant ? `· ${entry.variant}` : ""}</b><small>{entry.sku} · {money(entry.goodsAmount)} tiền hàng</small></span><strong>{percent(entry.goodsAmount ? entry.discountAmount / entry.goodsAmount * 100 : 0)}<small>{money(entry.discountAmount)}</small></strong></div>)}</div></article>
        </>}
      </>}

      {uatMode && revenueSubTab === "platform" && <>
        <div className={styles.revenueHeader}>
          <div><span>NỀN TẢNG & ĐỐI SOÁT</span><h2>{bounds.label}</h2><p>Danh sách lấy toàn bộ đơn Grab, Xanh/Green Food và Shopee từ SAPO; đối soát Grab chỉ cần chọn mã đơn và nhập tiền thực nhận.</p></div>
        </div>
        <div className={styles.revenueKpis}>
          <article className={styles.primaryRevenueKpi}><span>DOANH THU NỀN TẢNG · SAPO</span><strong>{money(platformOrderRevenue)}</strong><small>{successfulPlatformOrders.length.toLocaleString("vi-VN")} đơn thành công · {channelPerformance.length.toLocaleString("vi-VN")} kênh</small></article>
          <article><span>Trung bình/đơn</span><strong>{money(platformAverageOrder)}</strong><small>theo Danh sách hóa đơn</small></article>
          <article><span>Giảm giá nền tảng</span><strong>{money(platformDiscountAmount)}</strong><small>{percent(platformDiscountRate)} tiền hàng</small></article>
          <article><span>Đơn hủy</span><strong>{platformCancelledOrders.toLocaleString("vi-VN")}</strong><small>{periodPlatformOrders.length ? percent(platformCancelledOrders / periodPlatformOrders.length * 100) : "0%"} tổng đơn nền tảng</small></article>
          <article><span>Coverage Grab</span><strong>{grabOrderOptions.length ? percent(grabCoverageRate) : "-"}</strong><small>{grabUnreconciledOrders ? `còn ${grabUnreconciledOrders.toLocaleString("vi-VN")} đơn` : grabOrderOptions.length ? "đã đối soát đủ" : "chưa có hóa đơn Grab"}</small></article>
          <article className={grabDifference < 0 ? styles.warningKpi : ""}><span>Lệch thực nhận Grab</span><strong>{money(grabDifference)}</strong><small>{grabReconciliationRows.length ? `${percent(grabRetentionRate)} số SAPO đã đối soát` : "chưa nhập thực nhận"}</small></article>
        </div>
        <div className={styles.revenueInsightGrid}>
          <article className={styles.revenuePanel}>
            <div className={styles.revenuePanelTitle}><div><span>DOANH THU THEO NỀN TẢNG</span><strong>{channelPerformance.length ? `${channelPerformance.length} kênh bán` : "Chờ Danh sách hóa đơn"}</strong></div><small>Theo Nguồn đơn</small></div>
            {channelPerformance.length ? <div className={styles.categoryBars}>{channelPerformance.map((entry) => <div key={entry.name}><div><span><b>{entry.name}</b><small>{entry.successfulOrders.toLocaleString("vi-VN")} đơn · TB {money(entry.averageOrder)}{entry.cancelledOrders ? ` · ${entry.cancelledOrders} hủy` : ""}</small></span><strong>{money(entry.revenue)}</strong></div><div><i style={{ width: `${entry.revenue / maxPlatformChannelRevenue * 100}%` }} /></div></div>)}</div> : <div className={styles.panelEmpty}>Import file Danh sách hóa đơn trong bộ 4 file SAPO để xem cơ cấu GrabFood, Website, ShopeeFood và các kênh khác.</div>}
          </article>
          <article className={`${styles.revenuePanel} ${styles.platformTrendPanel}`}>
            <div className={styles.revenuePanelTitle}><div><span>NHỊP DOANH THU NỀN TẢNG</span><strong>{platformDailyTrend.length ? `${platformDailyTrend.length} ngày có đơn` : "Chờ Danh sách hóa đơn"}</strong></div><small>{money(platformOrderRevenue)}</small></div>
            {platformDailyTrend.length ? <div className={styles.miniBars}>{platformDailyTrend.map((entry) => <div className={styles.barColumn} key={entry.date} title={`${dateLabel(entry.date)} · ${entry.orders} đơn · ${money(entry.revenue)}`}><div className={styles.barTrack}><i style={{ height: `${Math.max(3, entry.revenue / maxPlatformDailyRevenue * 100)}%` }} /></div><span>{Number(entry.date.slice(8, 10))}</span></div>)}</div> : <div className={styles.panelEmpty}>Chưa có dữ liệu hóa đơn nền tảng trong kỳ đang chọn.</div>}
            <p className={styles.metricDisclaimer}>Mỗi cột là một ngày có đơn. Di chuột để xem số đơn và doanh thu SAPO của ngày đó.</p>
          </article>
        </div>
        <div className={styles.revenueInsightGrid}>
          <article className={`${styles.revenuePanel} ${styles.platformTakeCard}`}>
            <div className={styles.revenuePanelTitle}><div><span>PHÍ NỀN TẢNG / GIAO HÀNG</span><strong>{money(reportedPartnerFees)}</strong></div><small>{percent(platformTakeRate)} {deliveryRevenue ? "doanh thu giao hàng" : "doanh thu thực"}</small></div>
            <div className={styles.platformTakeBody}>
              <div className={styles.platformTakeRing} style={{ background: `conic-gradient(#e87d5c 0 ${Math.min(100, platformTakeRate)}%, #e8ede5 ${Math.min(100, platformTakeRate)}% 100%)` }}><i><strong>{percent(platformTakeRate)}</strong><small>bị giữ lại</small></i></div>
              <div className={styles.platformTakeStats}><div><span>{deliveryRevenue ? "DT giao hàng/nền tảng" : "DT thực làm mẫu số"}</span><b>{money(platformTakeBase)}</b></div><div><span>Doanh thu sau nhóm phí</span><b>{money(revenueAfterPlatformFees)}</b></div>{grabService && <div><span>Riêng Grab Food</span><b>{money(grabService.revenue)}</b></div>}<div><span>Ngày phát sinh phí</span><b>{revenueDataset.length ? `${platformFeeDays}/${revenueDataset.length}` : "-"}</b></div><div><span>Phí đối tác / tiền hàng</span><b>{percent(partnerCommissionRate)}</b></div></div>
            </div>
            <div className={styles.platformFeeList}>{platformFeeComponents.map((entry) => <div key={entry.label}><div><span>{entry.label}</span><b>{money(entry.value)}</b></div><div><i style={{ width: `${entry.value / maxPlatformFeeComponent * 100}%` }} /></div></div>)}</div>
            <p className={styles.metricDisclaimer}>{deliveryRevenue ? "Tỷ lệ phí dùng doanh thu của các hình thức giao hàng/nền tảng làm mẫu số." : "Chưa có file Hình thức phục vụ nên tạm dùng toàn bộ doanh thu thực làm mẫu số."} Các cột phí trong báo cáo Sapo đang gộp nhiều đối tác, vì vậy không quy toàn bộ phí cho riêng Grab.</p>
          </article>
          <article className={`${styles.revenuePanel} ${styles.channelMixCard}`}>
            <div className={styles.revenuePanelTitle}><div><span>PHÂN BỔ HÌNH THỨC PHỤC VỤ</span><strong>{serviceOrders ? `${serviceOrders.toLocaleString("vi-VN")} đơn` : "Chờ file phục vụ"}</strong></div><small>{serviceCancelledOrders ? `${serviceCancelledOrders.toLocaleString("vi-VN")} đơn hủy` : "Theo doanh thu & đơn"}</small></div>
            {periodServices.length ? <>
              <div className={styles.serviceSegmentBar} aria-label={`Offline ${percent(offlineOrderShare)}, giao hàng và nền tảng ${percent(deliveryOrderShare)}`}><i style={{ width: `${offlineOrderShare}%` }} /><b style={{ width: `${deliveryOrderShare}%` }} /></div>
              <div className={styles.serviceLegend}><span><i />Offline <b>{percent(offlineOrderShare)}</b></span><span><i />Giao hàng / nền tảng <b>{percent(deliveryOrderShare)}</b></span></div>
              <div className={styles.serviceSummary}>
                <div><span>OFFLINE</span><b>{offlineOrders.toLocaleString("vi-VN")} đơn</b><strong>{money(offlineRevenue)}</strong><small>{percent(offlineRevenueShare)} doanh thu</small></div>
                <div><span>GIAO HÀNG / NỀN TẢNG</span><b>{deliveryOrders.toLocaleString("vi-VN")} đơn</b><strong>{money(deliveryRevenue)}</strong><small>{percent(deliveryRevenueShare)} doanh thu</small></div>
              </div>
              <div className={styles.serviceModeList}>{periodServices.map((entry) => {
                const orderShare = serviceOrders ? entry.totalOrders / serviceOrders * 100 : 0;
                const isGrab = normalizedHeader(entry.serviceName).includes("grab");
                return <div className={isGrab ? styles.grabHighlight : ""} key={entry.id}><div><span><b>{entry.serviceName}</b><small>{entry.totalOrders.toLocaleString("vi-VN")} đơn · {percent(orderShare)} tổng đơn{entry.cancelledOrders ? ` · ${entry.cancelledOrders.toLocaleString("vi-VN")} hủy` : ""}</small></span><strong>{money(entry.revenue)}</strong></div><div className={styles.serviceModeTrack}><i style={{ width: `${entry.revenue / maxServiceRevenue * 100}%` }} /></div></div>;
              })}</div>
              <div className={`${styles.serviceReconciliation} ${revenueDataset.length && Math.abs(serviceRevenueGap) < 1 ? styles.reconciled : ""}`}><span>Đối soát với Doanh thu tổng quan</span><b>{!revenueDataset.length ? "Chờ file doanh thu" : Math.abs(serviceRevenueGap) < 1 ? "Khớp 100%" : `Lệch ${money(Math.abs(serviceRevenueGap))}`}</b></div>
            </> : <div className={styles.panelEmpty}>Import file Hình thức phục vụ tại Import Center để xem phân bổ thật giữa tại bàn, mang đi, Grab Food và các kênh giao hàng.</div>}
          </article>
        </div>
        <article className={`${styles.revenuePanel} ${styles.grabReconciliationPanel}`}>
          <div className={styles.revenuePanelTitle}><div><span>DANH SÁCH ĐƠN NỀN TẢNG</span><strong>Grab · Xanh/Green Food · Shopee</strong></div><small>{platformOrderList.length} đơn trong kỳ</small></div>
          <div className={styles.grabReconciliationSummary}><div><span>SAPO toàn bộ đơn nền tảng</span><b>{money(platformOrderRevenue)}</b></div><div><span>SAPO đơn Grab đã đối soát</span><b>{money(grabReportedTotal)}</b></div><div><span>Thực nhận Grab đã nhập</span><b>{money(grabReceivedTotal)}</b></div><div className={grabDifference < 0 ? styles.negativeSummary : ""}><span>Chênh lệch Grab</span><b>{money(grabDifference)}</b></div></div>
          <div className={styles.platformOrderList}>{platformOrderList.length ? platformOrderList.map((order) => {
            const reconciliation = reconciliationForPlatformOrder(order);
            const isGrab = isGrabPlatformOrder(order);
            return <div className={styles.platformOrderRow} key={order.id}>
              <div className={styles.platformOrderMain}><span className={styles.platformOrderChannel}>{order.channelName}</span><b>{order.orderCode}</b><small>{dateLabel(order.orderDate)} · SAPO {money(order.reportedAmount)}</small></div>
              <div className={styles.platformOrderStatus}>{isGrab ? <span className={reconciliation ? styles.reconciliationDone : styles.reconciliationPending}>{reconciliation ? "Đối soát done" : "Chưa đối soát"}</span> : <span className={styles.reconciliationNotApplicable}>Theo dõi</span>}</div>
              <div className={styles.platformOrderAction}>{isGrab && <button type="button" onClick={() => openPlatformReconciliation(order)}>{reconciliation ? "Xem / sửa" : "Đối soát"}</button>}</div>
            </div>;
          }) : <div className={styles.panelEmpty}>Chưa có danh sách đơn nền tảng trong kỳ này. Hãy import file Danh sách hóa đơn SAPO.</div>}</div>
        </article>
        {showGrabReconciliationModal && <div className={styles.backdrop} role="presentation" onMouseDown={() => !savingGrabReconciliation && setShowGrabReconciliationModal(false)}><form className={`${styles.sheet} ${styles.grabReconciliationSheet}`} onSubmit={(event) => void saveGrabReconciliation(event)} onMouseDown={(event) => event.stopPropagation()}><div className={styles.sheetHandle} /><div className={styles.sheetTitle}><div><span>ĐỐI SOÁT ĐƠN NỀN TẢNG</span><h2>{grabForm.id ? "Cập nhật thực nhận" : "Nhập tiền thực nhận"}</h2></div><button type="button" disabled={savingGrabReconciliation} onClick={() => setShowGrabReconciliationModal(false)}>×</button></div>{selectedGrabOrder ? <><div className={styles.grabOrderPreview}><div><span>Nền tảng</span><b>{selectedGrabOrder.channelName}</b></div><div><span>Mã đơn</span><b>{selectedGrabOrder.orderCode}</b></div><div><span>Ngày đơn</span><b>{dateLabel(selectedGrabOrder.orderDate)}</b></div><div><span>SAPO ghi nhận</span><b>{money(selectedGrabOrder.reportedAmount)}</b></div></div><label className={styles.modalField}>Tiền thực nhận<input autoFocus required inputMode="numeric" value={grabForm.receivedAmount} onChange={(event) => setGrabForm((current) => ({ ...current, receivedAmount: amountInput(event.target.value) }))} placeholder="Nhập số tiền thực nhận" /></label><label className={styles.modalField}>Ghi chú<input value={grabForm.note} onChange={(event) => setGrabForm((current) => ({ ...current, note: event.target.value }))} placeholder="Kỳ thanh toán, lý do lệch..." /></label><div className={styles.grabFormActions}><button type="button" disabled={savingGrabReconciliation} onClick={() => setShowGrabReconciliationModal(false)}>Hủy</button><button type="submit" disabled={savingGrabReconciliation}>{savingGrabReconciliation ? "Đang lưu..." : grabForm.id ? "Lưu thay đổi" : "Lưu đối soát"}</button></div></> : <div className={styles.panelEmpty}>Chọn một đơn nền tảng để bắt đầu đối soát.</div>}</form></div>}
      </>}
    </section>}

    {tab === "report" && <section className={styles.content}>
      <div className={styles.reportHeader}><div><span>BÁO CÁO QUẢN TRỊ F&B</span><h2>{bounds.label}</h2></div><button className={currentPeriodClosed ? styles.reopenButton : styles.closePeriodButton} onClick={togglePeriodClose}>{currentPeriodClosed ? "Mở lại kỳ" : "Khóa sổ kỳ"}</button></div>
      <div className={styles.reportTabs}>{(["pnl", "cash", "inventory", "assets"] as ReportView[]).map((view) => <button className={reportView === view ? styles.selected : ""} key={view} onClick={() => setReportView(view)}>{view === "pnl" ? "P&L" : view === "cash" ? "Dòng tiền" : view === "inventory" ? "Tồn kho" : "Tài sản & khấu hao"}</button>)}</div>
      {reportView === "pnl" && <section className={styles.reportVisualization}><div className={styles.reportVisualKpis}><article className={styles.visualPrimary}><span>DOANH THU THUẦN</span><strong>{money(netRevenue)}</strong><small>{revenueDetails.length} dòng doanh thu</small></article><article><span>LỢI NHUẬN GỘP</span><strong>{money(grossProfit)}</strong><small>{percent(grossMargin)} gross margin</small></article><article className={operatingProfit < 0 ? styles.visualRisk : ""}><span>LỢI NHUẬN HOẠT ĐỘNG</span><strong>{money(operatingProfit)}</strong><small>{netRevenue ? percent(operatingProfit / netRevenue * 100) : "-"} doanh thu</small></article></div><article className={styles.visualPanel}><div className={styles.visualPanelHead}><div><span>CƠ CẤU CHI PHÍ</span><h3>Chi phí đang tập trung ở đâu?</h3></div><b>{money(totalPeriodExpense)}</b></div><div className={styles.visualBars}>{pnlCostMix.map((entry) => <div key={entry.label}><div><span>{entry.label}</span><b>{money(entry.value)}</b></div><i><b style={{ width: `${entry.value / maxPnlCost * 100}%` }} /></i><small>{totalPeriodExpense ? percent(entry.value / totalPeriodExpense * 100) : "0%"} tổng chi phí</small></div>)}</div></article></section>}
      {reportView === "cash" && <section className={styles.reportVisualization}><div className={styles.reportVisualKpis}><article className={styles.visualPrimary}><span>TIỀN VÀO</span><strong>{money(cashIn)}</strong><small>{cashInDetails.length} dòng thu</small></article><article><span>TIỀN RA</span><strong>{money(cashOut)}</strong><small>{cashOutDetails.length} dòng chi</small></article><article className={netCash < 0 ? styles.visualRisk : ""}><span>DÒNG TIỀN THUẦN</span><strong>{money(netCash)}</strong><small>{cashIn ? percent(netCash / cashIn * 100) : "-"} tiền vào</small></article></div><article className={styles.visualPanel}><div className={styles.visualPanelHead}><div><span>TIỀN RA THEO NHÓM</span><h3>Dòng tiền đang đi vào đâu?</h3></div><b>{money(cashOut)}</b></div><div className={styles.visualBars}>{cashComponents.length ? cashComponents.map((entry) => <div key={entry.label}><div><span>{entry.label}</span><b>{money(entry.value)}</b></div><i><b style={{ width: `${entry.value / maxCashComponent * 100}%` }} /></i><small>{cashOut ? percent(entry.value / cashOut * 100) : "0%"} tiền ra</small></div>) : <p>Chưa có dòng tiền ra trong kỳ.</p>}</div></article></section>}
      {reportView === "inventory" && <section className={styles.reportVisualization}><div className={styles.reportVisualKpis}><article><span>TỒN ĐẦU KỲ</span><strong>{money(openingInventory)}</strong><small>{openingInventoryEntries.length} lô</small></article><article className={styles.visualPrimary}><span>TỒN CUỐI KỲ</span><strong>{money(closingInventory)}</strong><small>{closingInventoryEntries.length} lô còn giá trị</small></article><article><span>ĐÃ XUẤT / HAO HỤT</span><strong>{money(inventoryIssued)}</strong><small>Hao hụt {money(inventoryWaste)}</small></article></div><article className={styles.visualPanel}><div className={styles.visualPanelHead}><div><span>CƠ CẤU TỒN CUỐI KỲ</span><h3>Category giữ nhiều giá trị nhất</h3></div><b>{closingCategoryValues.length} category</b></div><div className={styles.visualBars}>{closingCategoryValues.length ? closingCategoryValues.map((entry) => <div key={entry.label}><div><span>{entry.label}</span><b>{money(entry.value)}</b></div><i><b style={{ width: `${entry.value / maxClosingCategory * 100}%` }} /></i><small>{closingInventory ? percent(entry.value / closingInventory * 100) : "0%"} tồn cuối kỳ</small></div>) : <p>Chưa có tồn kho cuối kỳ.</p>}</div></article></section>}
      {reportView === "assets" && <section className={styles.reportVisualization}><div className={styles.reportVisualKpis}><article className={styles.visualPrimary}><span>NGUYÊN GIÁ</span><strong>{money(assetOriginalValue)}</strong><small>{assetExpenses.length} tài sản</small></article><article><span>ĐÃ KHẤU HAO</span><strong>{money(assetAccumulatedValue)}</strong><small>{assetOriginalValue ? percent(assetAccumulatedValue / assetOriginalValue * 100) : "0%"} nguyên giá</small></article><article><span>GIÁ TRỊ CÒN LẠI</span><strong>{money(assetRemainingValue)}</strong><small>Khấu hao kỳ {money(depreciation)}</small></article></div><article className={styles.visualPanel}><div className={styles.visualPanelHead}><div><span>CƠ CẤU TÀI SẢN</span><h3>Nguyên giá theo nhóm tài sản</h3></div><b>{assetCategoryValues.length} nhóm</b></div><div className={styles.visualBars}>{assetCategoryValues.length ? assetCategoryValues.map((entry) => <div key={entry.label}><div><span>{entry.label}</span><b>{money(entry.value)}</b></div><i><b style={{ width: `${entry.value / maxAssetCategory * 100}%` }} /></i><small>{assetOriginalValue ? percent(entry.value / assetOriginalValue * 100) : "0%"} nguyên giá</small></div>) : <p>Chưa có tài sản trong kỳ.</p>}</div><div className={styles.assetValueTrack}><span>Giá trị còn lại</span><i><b style={{ width: `${assetOriginalValue ? assetRemainingValue / assetOriginalValue * 100 : 0}%` }} /></i><strong>{assetOriginalValue ? percent(assetRemainingValue / assetOriginalValue * 100) : "0%"}</strong></div></article></section>}
      {reportView === "pnl" && <FinancialAccordion rows={pnlRows} revenueBase={netRevenue} />}
      {reportView === "cash" && <FinancialAccordion rows={cashRows} />}
      {reportView === "inventory" && <FinancialAccordion rows={inventoryRows} />}
      {reportView === "assets" && <FinancialAccordion rows={assetRows} />}
    </section>}

    {tab === "dashboard" && <section className={`${styles.content} ${styles.dashboard}`}>
      <div className={styles.dashboardActions}><div><span>DASHBOARD ĐIỀU HÀNH</span><h2>Hiệu quả kinh doanh</h2></div><button onClick={() => { setTab("revenue"); setRevenueSubTab(!periodProducts.length ? "products" : "overview"); }}>Nhập dữ liệu Excel</button></div>
      <div className={styles.targetCard}><div><span>MỤC TIÊU DOANH THU</span><strong>{money(revenueTarget)}</strong><p>{state.revenueTargetAmount ? previousNetRevenue ? `Mục tiêu nhập trực tiếp · tương đương ${targetGrowthRate.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}% so với ${money(previousNetRevenue)} kỳ trước` : "Mục tiêu doanh thu nhập trực tiếp." : previousNetRevenue ? `Tự tính tăng ${growthTargetPercent.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}% từ ${money(previousNetRevenue)} kỳ trước` : "Nhập mục tiêu doanh thu để bắt đầu theo dõi."}</p></div><div className={styles.targetPercent}>{targetProgress.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%</div><div className={styles.progressTrack}><i style={{ width: `${targetProgress}%` }} /></div><div className={styles.targetInputs}><label>Mục tiêu doanh thu (₫)<input inputMode="numeric" placeholder="Ví dụ: 50,000,000" value={state.revenueTargetAmount ? amountInput(String(state.revenueTargetAmount)) : ""} onChange={(event) => setState((current) => ({ ...current, revenueTargetAmount: parseAmount(event.target.value) }))} /></label><label>Tăng trưởng tự tính (%)<input min="0" step="0.1" type="number" value={state.growthTargetPercent} onChange={(event) => setState((current) => ({ ...current, growthTargetPercent: Math.max(0, Number(event.target.value) || 0), revenueTargetAmount: 0 }))} /></label><div className={styles.targetAuto}><span>MỤC TIÊU LY TỰ TÍNH</span><strong>{cupTarget.toLocaleString("vi-VN")} ly</strong><small>≈ {money(baselineAveragePerCup)}/ly theo kỳ trước</small></div></div><p>Đã đạt {money(netRevenue)} · còn thiếu {money(revenueRemaining)}</p></div>
      <div className={styles.kpiGrid}><article className={styles.averageCup}><span>Trung bình/đơn</span><strong>{money(averagePerOrder)}</strong><small>{totalReportedOrders.toLocaleString("vi-VN")} đơn toàn báo cáo</small></article><article><span>Trung bình/sản phẩm</span><strong>{money(averageProductValue || averagePerItem)}</strong><small>sau giảm giá</small></article><article><span>Sản phẩm bán</span><strong>{(productQuantity || datasetItems).toLocaleString("vi-VN")}</strong><small>{periodProducts.length || importedRevenueRows.length} dòng dữ liệu</small></article><article className={cancellationRate > 3 ? styles.attention : ""}><span>Tỷ lệ hủy đơn</span><strong>{percent(cancellationRate)}</strong><small>{cancelledOrders.toLocaleString("vi-VN")} đơn hủy</small></article><article className={productDiscountRate > 15 ? styles.attention : ""}><span>Tỷ lệ giảm giá</span><strong>{percent(productDiscountRate || discountRate)}</strong><small>{money(productDiscountAmount || reportedDiscountAmount)}</small></article><article><span>Gross margin</span><strong>{percent(grossMargin)}</strong><small>{bounds.label}</small></article></div>

      <div className={styles.dashboardDataNote}><span>Doanh thu: <b>{revenueImport ? `${dateLabel(revenueImport.periodStart)} – ${dateLabel(revenueImport.periodEnd)}` : "chưa import"}</b></span><span>Mặt hàng: <b>{productsImport ? `${dateLabel(productsImport.periodStart)} – ${dateLabel(productsImport.periodEnd)}` : "chưa import"}</b></span><span>Phục vụ: <b>{serviceImport ? `${dateLabel(serviceImport.periodStart)} – ${dateLabel(serviceImport.periodEnd)}` : "chưa import"}</b></span><span>Hóa đơn: <b>{ordersImport ? `${dateLabel(ordersImport.periodStart)} – ${dateLabel(ordersImport.periodEnd)}` : "chưa import"}</b></span></div>

      <div className={styles.productVisualGrid}>
        <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>CƠ CẤU DOANH THU</span><strong>Theo danh mục</strong></div></div>{categoryPerformance.length ? <div className={styles.categoryBars}>{categoryPerformance.slice(0, 8).map((entry) => <div key={entry.name}><div><span><b>{entry.name}</b><small>{entry.quantity.toLocaleString("vi-VN")} sản phẩm</small></span><strong>{money(entry.revenue)}</strong></div><div><i style={{ width: `${entry.revenue / maxCategoryRevenue * 100}%` }} /></div></div>)}</div> : <div className={styles.panelEmpty}>Import Báo cáo mặt hàng để xem cơ cấu danh mục.</div>}</article>
        <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>TOP SẢN PHẨM</span><strong>Đóng góp doanh thu cao</strong></div></div>{topProducts.length ? <div className={styles.topRevenueList}>{topProducts.slice(0, 6).map((entry, index) => <div key={entry.id}><i>{index + 1}</i><span><b>{entry.name}</b><small>{entry.category} · {entry.quantity.toLocaleString("vi-VN")} SP</small></span><strong>{money(entry.totalAmount)}</strong></div>)}</div> : <div className={styles.panelEmpty}>Chưa có dữ liệu mặt hàng.</div>}</article>
      </div>

      <div className={styles.chartGrid}><article className={styles.costMixCard}><div><span>CƠ CẤU CHI PHÍ · {bounds.label.toUpperCase()}</span><strong>{money(totalPeriodExpense)}</strong></div><div className={styles.donut} style={{ background: `conic-gradient(#171916 0 ${totalPeriodExpense ? (inventoryCogs + inventoryWaste) / totalPeriodExpense * 100 : 0}%, #887a5d 0 ${totalPeriodExpense ? (inventoryCogs + inventoryWaste + fixedCost) / totalPeriodExpense * 100 : 0}%, #c9b896 0 ${totalPeriodExpense ? (inventoryCogs + inventoryWaste + fixedCost + operatingCost) / totalPeriodExpense * 100 : 0}%, #e9dfca 0 100%)` }}><i>{grossMargin.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%<small>gross margin</small></i></div><div className={styles.legend}><span><i className={styles.legendDark} />NVL {money(inventoryCogs + inventoryWaste)}</span><span><i className={styles.legendBrown} />Cố định {money(fixedCost)}</span><span><i className={styles.legendSand} />Vận hành {money(operatingCost)}</span><span><i className={styles.legendCream} />Bán hàng {money(salesCost)}</span></div></article><article className={styles.forecastCard}><span>ĐỐI SOÁT & SỨC KHỎE</span><strong>{periodProducts.length && revenueDataset.length ? money(Math.abs(revenueProductGap)) : "Chưa đủ dữ liệu"}</strong><p>Chênh lệch giữa Doanh thu thực và Tổng tiền mặt hàng.</p><div><span>Doanh thu thực</span><b>{money(datasetRevenue)}</b></div><div><span>Tổng tiền mặt hàng</span><b>{money(productNetAmount)}</b></div><div><span>EBITDA {bounds.label}</span><b className={ebitda < 0 ? styles.redText : ""}>{money(ebitda)}</b></div><div><span>Tồn kho hiện tại</span><b>{money(closingInventory)}</b></div></article></div>
    </section>}

    {showExpenseForm && <div className={styles.backdrop} role="presentation" onMouseDown={() => !savingExpense && setShowExpenseForm(false)}><form className={styles.sheet} onSubmit={saveExpense} onMouseDown={(event) => event.stopPropagation()}><div className={styles.sheetHandle} /><div className={styles.sheetTitle}><div><span>{editingExpenseId ? "CẬP NHẬT" : "GHI NHẬN"}</span><h2>{categoryLabels[expenseForm.category]}</h2></div><button disabled={savingExpense} type="button" onClick={() => setShowExpenseForm(false)}>×</button></div><label>Category<select value={expenseForm.category} onChange={(event) => setExpenseForm((current) => ({ ...current, category: event.target.value as ExpenseCategory, recurrence: event.target.value === "fixed" ? "monthly" : "once" }))}>{(Object.keys(categoryLabels) as ExpenseCategory[]).map((category) => <option value={category} key={category}>{categoryLabels[category]}</option>)}</select></label><label>Tên chi phí / tài sản<input autoFocus required value={expenseForm.name} onChange={(event) => setExpenseForm((current) => ({ ...current, name: event.target.value }))} placeholder="Ví dụ: Tiền thuê mặt bằng" /></label><div className={styles.formRow}><label>Subcategory<select required value={expenseForm.subcategoryIsCustom ? "__other" : expenseForm.subcategory} onChange={(event) => { const value = event.target.value; setExpenseForm((current) => ({ ...current, subcategoryIsCustom: value === "__other", subcategory: value === "__other" ? "" : value })); }}><option value="">Chọn subcategory</option>{subcategories.map((subcategory) => <option value={subcategory} key={subcategory}>{subcategory}</option>)}<option value="__other">Khác</option></select>{expenseForm.subcategoryIsCustom && <input required value={expenseForm.subcategory} onChange={(event) => setExpenseForm((current) => ({ ...current, subcategory: event.target.value }))} placeholder="Nhập subcategory mới" />}</label><label>Số tiền<input required inputMode="numeric" value={expenseForm.amount} onChange={(event) => setExpenseForm((current) => ({ ...current, amount: amountInput(event.target.value) }))} placeholder="15,000,000" /></label></div><div className={styles.formRow}><label>Ngày ghi nhận<VietnameseDateInput required value={expenseForm.incurredOn} onChange={(incurredOn) => setExpenseForm((current) => ({ ...current, incurredOn }))} /></label>{expenseForm.category !== "investment" && <label>Chu kỳ<select value={expenseForm.recurrence} onChange={(event) => setExpenseForm((current) => ({ ...current, recurrence: event.target.value as Recurrence }))}>{(Object.keys(recurrenceLabels) as Recurrence[]).map((recurrence) => <option value={recurrence} key={recurrence}>{recurrenceLabels[recurrence]}</option>)}</select></label>}</div>{expenseForm.category === "investment" && <><div className={styles.formRow}><label>Ngày sử dụng<VietnameseDateInput value={expenseForm.inServiceOn} onChange={(inServiceOn) => setExpenseForm((current) => ({ ...current, inServiceOn }))} /></label><label>Khấu hao (tháng)<input min="1" type="number" value={expenseForm.usefulLifeMonths} onChange={(event) => setExpenseForm((current) => ({ ...current, usefulLifeMonths: event.target.value }))} /></label></div><label>Giá trị thu hồi<input inputMode="numeric" value={expenseForm.salvageValue} onChange={(event) => setExpenseForm((current) => ({ ...current, salvageValue: amountInput(event.target.value) }))} /></label></>}<div className={styles.formRow}><label>Thanh toán<select value={expenseForm.paymentStatus} onChange={(event) => setExpenseForm((current) => ({ ...current, paymentStatus: event.target.value as PaymentStatus }))}>{(Object.keys(paymentLabels) as PaymentStatus[]).map((status) => <option value={status} key={status}>{paymentLabels[status]}</option>)}</select></label>{(expenseForm.paymentStatus === "paid" || expenseForm.recurrence !== "once") && <label>{expenseForm.recurrence === "once" ? "Ngày thanh toán" : "Ngày thanh toán theo chu kỳ"}<VietnameseDateInput required={expenseForm.recurrence !== "once"} value={expenseForm.paymentDate} onChange={(paymentDate) => setExpenseForm((current) => ({ ...current, paymentDate }))} /></label>}</div><div className={styles.formRow}><label>Mã hóa đơn<input value={expenseForm.invoiceCode} onChange={(event) => setExpenseForm((current) => ({ ...current, invoiceCode: event.target.value }))} /></label><label>Nhà cung cấp<select required value={expenseForm.vendorIsCustom ? "__other" : expenseForm.vendor} onChange={(event) => { const value = event.target.value; setExpenseForm((current) => ({ ...current, vendorIsCustom: value === "__other", vendor: value === "__other" ? "" : value })); }}><option value="">Chọn nhà cung cấp</option>{vendors.map((vendor) => <option value={vendor} key={vendor}>{vendor}</option>)}<option value="__other">Khác</option></select>{expenseForm.vendorIsCustom && <input required value={expenseForm.vendor} onChange={(event) => setExpenseForm((current) => ({ ...current, vendor: event.target.value }))} placeholder="Nhập nhà cung cấp mới" />}</label></div><label>Note<textarea value={expenseForm.note} onChange={(event) => setExpenseForm((current) => ({ ...current, note: event.target.value }))} placeholder="Ghi chú nội bộ" /></label><button disabled={savingExpense} className={styles.primaryButton} type="submit">{savingExpense ? "Đang lưu…" : editingExpenseId ? "Lưu thay đổi" : "Ghi nhận chi phí"}</button></form></div>}

  </div>;
}

function FinancialAccordion({ rows, revenueBase }: { rows: PnlRow[]; revenueBase?: number }) {
  return <div className={styles.financialTable}>{rows.map((row) => <details className={`${styles.financialDetail} ${styles[row.tone]}`} key={row.label}><summary className={styles.financialRow}><span>{row.label} ({row.itemCount ?? row.details.length})</span><strong>{money(row.value)}</strong><small>{revenueBase && row.label !== "Doanh thu gộp" && row.label !== "Giảm giá / voucher" ? `${(Math.abs(row.value) / revenueBase * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}% DT` : ""}</small><i aria-hidden="true">+</i></summary><div className={styles.financialBreakdown}>{row.groups?.length ? row.groups.map((group) => <details className={styles.financialSubgroup} key={group.label}><summary><span>{group.label} ({group.details.length})</span><b>{money(group.value)}</b><i aria-hidden="true">+</i></summary><div>{group.details.length ? group.details.map((detail, index) => <div key={`${detail.label}-${detail.date || index}`}><span>{detail.label}{detail.date ? ` · ${dateLabel(detail.date)}` : ""}</span><b>{money(detail.amount)}</b></div>) : <p>Chưa có dòng chi tiết.</p>}</div></details>) : <p>Chưa có giao dịch chi tiết trong kỳ này.</p>}</div></details>)}</div>;
}

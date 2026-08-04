"use client";

import Image from "next/image";
import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from "react";
import {
  loadFinanceImports,
  replaceFinanceImportBundle,
  type FinanceImportMeta,
  type FinanceProductRecord,
  type FinanceRevenueRecord,
  type FinanceServiceRecord,
} from "@/lib/finance-store";
import { isSupabaseConfigured } from "@/lib/supabase";
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

type FinanceTab = "entry" | "revenue" | "report" | "dashboard";
type PeriodMode = "month" | "quarter" | "year";
type ExpenseCategory = "fixed" | "operating" | "sales" | "investment";
type Recurrence = "once" | "weekly" | "monthly" | "quarterly" | "yearly";
type PaymentStatus = "unpaid" | "partial" | "paid";
type ReportView = "pnl" | "cash" | "inventory" | "assets";
type RevenueSubTab = "overview" | "products";

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

type FinanceState = {
  expenses: ExpenseRecord[];
  revenues: FinanceRevenueRecord[];
  products: FinanceProductRecord[];
  services: FinanceServiceRecord[];
  imports: FinanceImportMeta[];
  growthTargetPercent: number;
  revenueTargetAmount: number;
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

type PeriodBounds = { start: string; end: string; label: string; key: string };
type ImportMetaInput = Omit<FinanceImportMeta, "dataType" | "importedAt">;
type ParsedRevenueImport = { type: "revenue"; meta: ImportMetaInput; importMeta: FinanceImportMeta; records: FinanceRevenueRecord[]; latestDate: string };
type ParsedProductImport = { type: "products"; meta: ImportMetaInput; importMeta: FinanceImportMeta; records: FinanceProductRecord[] };
type ParsedServiceImport = { type: "service"; meta: ImportMetaInput; importMeta: FinanceImportMeta; records: FinanceServiceRecord[] };
type ParsedFinanceImport = ParsedRevenueImport | ParsedProductImport | ParsedServiceImport;

const FINANCE_STORAGE_KEY = "nha-ops-finance-v1";
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
function parseAmount(value: string) { return Number(value.replace(/\D/g, "")); }
function amountInput(value: string) { const digits = value.replace(/\D/g, ""); return digits ? Number(digits).toLocaleString("en-US") : ""; }
function dateAt(year: number, month: number, day: number) { return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`; }
function daysInMonth(year: number, month: number) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function addDaysISO(value: string, days: number) { const date = new Date(`${value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function monthDiff(start: string, end: string) { const [sy, sm] = start.slice(0, 7).split("-").map(Number); const [ey, em] = end.slice(0, 7).split("-").map(Number); return (ey - sy) * 12 + em - sm; }
function inRange(value: string, bounds: PeriodBounds) { return value >= bounds.start && value <= bounds.end; }
function percent(value: number) { return `${value.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%`; }
function normalizedHeader(value: unknown) { return String(value ?? "").trim().toLocaleLowerCase("vi").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/\s+/g, " "); }
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
    if (headers.includes("ten danh muc") && headers.includes("ma mat hang") && headers.includes("ten mat hang") && headers.includes("tong tien")) return "products" as const;
    if (headers.includes("loai don hang") && headers.includes("sl don hang") && headers.includes("so don huy") && headers.includes("tien thu duoc")) return "service" as const;
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
    return headers.includes("ten danh muc") && headers.includes("ma mat hang") && headers.includes("ten mat hang") && headers.includes("tong tien");
  });
  if (headerRowIndex < 0) throw new Error(`${file.name}: không tìm thấy bảng Báo cáo mặt hàng.`);
  const headers = rows[headerRowIndex].map(normalizedHeader);
  const column = (name: string) => headers.indexOf(name);
  const requiredColumns = ["ten danh muc", "ma mat hang", "ten mat hang", "so luong", "tien hang", "tong tien"];
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
    records.push({
      id: `excel-product-${sourceRow}-${sku}`,
      sourceRow,
      category: readText(row, "ten danh muc") || "Khác",
      sku,
      name,
      variant: readText(row, "gia mat hang"),
      unit: readText(row, "ten don vi"),
      quantity: read(row, "so luong"),
      weight: read(row, "trong luong"),
      usageTime: readText(row, "thoi gian su dung"),
      quantityRatio: read(row, "ti le so luong"),
      goodsAmount: read(row, "tien hang"),
      goodsRatio: read(row, "ti le tien hang"),
      discountAmount: read(row, "tong giam gia"),
      amountAfterDiscount: read(row, "tien sau giam gia"),
      taxAmount: read(row, "thue"),
      totalAmount: read(row, "tong tien"),
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
    return headers.includes("loai don hang") && headers.includes("sl don hang") && headers.includes("so don huy") && headers.includes("tien thu duoc");
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
    const serviceName = String(row[column("loai don hang")] ?? "").trim();
    if (!serviceName) continue;
    const sourceRow = headerRowIndex + index + 2;
    records.push({
      id: `excel-service-${sourceRow}-${normalizedHeader(serviceName).replace(/\s+/g, "-")}`,
      sourceRow,
      serviceName,
      totalOrders: numericCell(row[column("sl don hang")]),
      cancelledOrders: numericCell(row[column("so don huy")]),
      revenue: numericCell(row[column("tien thu duoc")]),
    });
  }
  if (!records.length) throw new Error(`${file.name}: không có hình thức phục vụ hợp lệ.`);
  const importedAt = new Date().toISOString();
  const meta = { fileName: file.name, periodStart: parsedPeriod.start, periodEnd: parsedPeriod.end, rowCount: records.length };
  return { type: "service", meta, importMeta: { dataType: "service", ...meta, importedAt }, records };
}

function importTimeLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("vi-VN", { dateStyle: "short", timeStyle: "short" });
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
  return { name: "", category, subcategory: "", amount: "", incurredOn: today, recurrence: category === "fixed" ? "monthly" : "once", paymentStatus: "paid", paymentDate: today, invoiceCode: "", vendor: "", note: "", usefulLifeMonths: "36", salvageValue: "0", inServiceOn: today };
}

function emptyFinanceState(): FinanceState {
  return { expenses: [], revenues: [], products: [], services: [], imports: [], growthTargetPercent: 10, revenueTargetAmount: 0, closedPeriods: [] };
}

function normalizeFinanceState(value: unknown, uatMode: boolean): FinanceState {
  if (!value || typeof value !== "object") return uatMode ? seedFinanceState() : emptyFinanceState();
  const stored = value as Partial<FinanceState>;
  const expenses = Array.isArray(stored.expenses) ? stored.expenses : [];
  const revenues = Array.isArray(stored.revenues) ? stored.revenues : [];
  const products = Array.isArray(stored.products) ? stored.products : [];
  const services = Array.isArray(stored.services) ? stored.services : [];
  const imports = Array.isArray(stored.imports) ? stored.imports : [];
  const isUatSample = (record: ExpenseRecord | FinanceRevenueRecord) => record.id.startsWith("uat-") || record.note?.includes("Dữ liệu mẫu UAT");
  return {
    expenses: uatMode ? expenses : expenses.filter((record) => !isUatSample(record)),
    revenues: uatMode ? revenues : revenues.filter((record) => !isUatSample(record)),
    products,
    services,
    imports,
    growthTargetPercent: Number.isFinite(Number(stored.growthTargetPercent)) ? Number(stored.growthTargetPercent) : 10,
    revenueTargetAmount: Number.isFinite(Number(stored.revenueTargetAmount)) ? Math.max(0, Number(stored.revenueTargetAmount)) : 0,
    closedPeriods: Array.isArray(stored.closedPeriods) ? stored.closedPeriods : [],
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
    imports: [],
    growthTargetPercent: 12,
    revenueTargetAmount: 0,
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
  const [importingFinance, setImportingFinance] = useState(false);
  const [financeImportNotice, setFinanceImportNotice] = useState<string | undefined>();
  const [financeSyncError, setFinanceSyncError] = useState<string | undefined>();
  const [editingExpenseId, setEditingExpenseId] = useState<string | undefined>();
  const [expenseForm, setExpenseForm] = useState<ExpenseForm>(expenseFormDefaults());

  useEffect(() => {
    let cancelled = false;
    async function loadState() {
      const stored = window.localStorage.getItem(storageKey) || (!uatMode ? window.localStorage.getItem(FINANCE_LEGACY_UAT_STORAGE_KEY) : null);
      let nextState = uatMode ? seedFinanceState() : emptyFinanceState();
      if (stored) {
        try { nextState = normalizeFinanceState(JSON.parse(stored), uatMode); } catch { nextState = uatMode ? seedFinanceState() : emptyFinanceState(); }
      }
      if (!uatMode && isSupabaseConfigured) {
        try {
          const cloud = await loadFinanceImports();
          nextState = { ...nextState, revenues: cloud.revenues, products: cloud.products, services: cloud.services, imports: cloud.imports };
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
  const previousBounds = useMemo(() => previousPeriodBounds(bounds, periodMode), [bounds, periodMode]);
  const currentPeriodClosed = periodMode === "month" && state.closedPeriods.includes(bounds.key);
  const activeExpenses = state.expenses.filter((expense) => expense.status === "active");
  const manualOccurrences = useMemo(() => activeExpenses.flatMap((expense) => expenseOccurrences(expense, bounds).map((date) => ({ expense, date, amount: expense.amount }))), [activeExpenses, bounds]);
  const periodRevenues = useMemo(() => state.revenues.filter((entry) => inRange(entry.date, bounds)), [state.revenues, bounds]);
  const previousPeriodRevenues = useMemo(() => state.revenues.filter((entry) => inRange(entry.date, previousBounds)), [state.revenues, previousBounds]);
  const revenueImport = state.imports.find((entry) => entry.dataType === "revenue");
  const productsImport = state.imports.find((entry) => entry.dataType === "products");
  const serviceImport = state.imports.find((entry) => entry.dataType === "service");
  const revenueDataset = revenueImport ? state.revenues.filter((entry) => entry.date >= revenueImport.periodStart && entry.date <= revenueImport.periodEnd) : periodRevenues;
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

  const growthTargetPercent = Math.max(0, state.growthTargetPercent || 0);
  const autoRevenueTarget = previousNetRevenue * (1 + growthTargetPercent / 100);
  const revenueTarget = Math.max(0, state.revenueTargetAmount || autoRevenueTarget);
  const targetGrowthRate = previousNetRevenue ? (revenueTarget / previousNetRevenue - 1) * 100 : 0;
  const cupTarget = baselineAveragePerCup ? Math.ceil(revenueTarget / baselineAveragePerCup) : 0;
  const revenueRemaining = Math.max(0, revenueTarget - netRevenue);
  const targetProgress = revenueTarget ? Math.min(100, (netRevenue / revenueTarget) * 100) : 0;
  const grossMargin = netRevenue ? (grossProfit / netRevenue) * 100 : 0;

  const productQuantity = state.products.reduce((sum, entry) => sum + entry.quantity, 0);
  const productGoodsAmount = state.products.reduce((sum, entry) => sum + entry.goodsAmount, 0);
  const productDiscountAmount = state.products.reduce((sum, entry) => sum + entry.discountAmount, 0);
  const productNetAmount = state.products.reduce((sum, entry) => sum + entry.totalAmount, 0);
  const productDiscountRate = productGoodsAmount ? productDiscountAmount / productGoodsAmount * 100 : 0;
  const averageProductValue = productQuantity ? productNetAmount / productQuantity : 0;
  const categoryPerformance = useMemo(() => {
    const grouped = new Map<string, { quantity: number; revenue: number; discount: number; skuCount: number }>();
    for (const product of state.products) {
      const current = grouped.get(product.category) || { quantity: 0, revenue: 0, discount: 0, skuCount: 0 };
      current.quantity += product.quantity;
      current.revenue += product.totalAmount;
      current.discount += product.discountAmount;
      current.skuCount += 1;
      grouped.set(product.category, current);
    }
    return [...grouped.entries()].map(([name, values]) => ({ name, ...values })).sort((a, b) => b.revenue - a.revenue);
  }, [state.products]);
  const topProducts = useMemo(() => [...state.products].sort((a, b) => b.totalAmount - a.totalAmount).slice(0, 8), [state.products]);
  const highDiscountProducts = useMemo(() => [...state.products].filter((entry) => entry.goodsAmount > 0 && entry.discountAmount > 0).sort((a, b) => b.discountAmount / b.goodsAmount - a.discountAmount / a.goodsAmount).slice(0, 6), [state.products]);
  const maxCategoryRevenue = Math.max(...categoryPerformance.map((entry) => entry.revenue), 1);
  const revenueProductGap = datasetRevenue - productNetAmount;
  const offlineServiceNames = new Set(["an tai ban", "mang di"]);
  const offlineServices = state.services.filter((entry) => offlineServiceNames.has(normalizedHeader(entry.serviceName)));
  const deliveryServices = state.services.filter((entry) => !offlineServiceNames.has(normalizedHeader(entry.serviceName)));
  const grabService = state.services.find((entry) => normalizedHeader(entry.serviceName).includes("grab"));
  const serviceOrders = state.services.reduce((sum, entry) => sum + entry.totalOrders, 0);
  const serviceCancelledOrders = state.services.reduce((sum, entry) => sum + entry.cancelledOrders, 0);
  const serviceRevenue = state.services.reduce((sum, entry) => sum + entry.revenue, 0);
  const offlineOrders = offlineServices.reduce((sum, entry) => sum + entry.totalOrders, 0);
  const offlineRevenue = offlineServices.reduce((sum, entry) => sum + entry.revenue, 0);
  const deliveryOrders = deliveryServices.reduce((sum, entry) => sum + entry.totalOrders, 0);
  const deliveryRevenue = deliveryServices.reduce((sum, entry) => sum + entry.revenue, 0);
  const offlineOrderShare = serviceOrders ? offlineOrders / serviceOrders * 100 : 0;
  const deliveryOrderShare = serviceOrders ? deliveryOrders / serviceOrders * 100 : 0;
  const offlineRevenueShare = serviceRevenue ? offlineRevenue / serviceRevenue * 100 : 0;
  const deliveryRevenueShare = serviceRevenue ? deliveryRevenue / serviceRevenue * 100 : 0;
  const maxServiceRevenue = Math.max(...state.services.map((entry) => entry.revenue), 1);
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
    if (!window.confirm(`Huỷ giao dịch “${expense.name}”? Giao dịch sẽ được giữ lại trong lịch sử.`)) return;
    setState((current) => ({ ...current, expenses: current.expenses.map((entry) => entry.id === expense.id ? { ...entry, status: "voided" } : entry) }));
  }

  function markPaid(expense: ExpenseRecord) {
    if (currentPeriodClosed) { window.alert("Kỳ này đã khóa sổ và không thể cập nhật thanh toán."); return; }
    setState((current) => ({ ...current, expenses: current.expenses.map((entry) => entry.id === expense.id ? { ...entry, paymentStatus: "paid", paymentDate: today } : entry) }));
  }

  async function importFinanceExcel(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    if (files.length > 8) { window.alert("Mỗi lần chỉ nên import tối đa 8 file Excel."); return; }
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
        const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
        const templateType = financeTemplateType(rows);
        if (!templateType) throw new Error(`${file.name}: chưa nhận diện được template. Hệ thống hiện hỗ trợ Doanh thu tổng quan, Mặt hàng và Hình thức phục vụ.`);
        parsed.push(templateType === "revenue" ? parseRevenueRows(file, rows) : templateType === "products" ? parseProductRows(file, rows) : parseServiceRows(file, rows));
      }
      const revenueImports = parsed.filter((entry): entry is ParsedRevenueImport => entry.type === "revenue");
      const productImports = parsed.filter((entry): entry is ParsedProductImport => entry.type === "products");
      const serviceImports = parsed.filter((entry): entry is ParsedServiceImport => entry.type === "service");
      if (revenueImports.length > 1 || productImports.length > 1 || serviceImports.length > 1) throw new Error("Mỗi lần chỉ chọn tối đa 1 file cho từng loại báo cáo để tránh ghi đè không rõ ràng.");
      const replacing = [revenueImports.length && state.revenues.length ? "Doanh thu" : "", productImports.length && state.products.length ? "Mặt hàng" : "", serviceImports.length && state.services.length ? "Hình thức phục vụ" : ""].filter(Boolean);
      if (replacing.length && !window.confirm(`Import mới sẽ thay toàn bộ dữ liệu ${replacing.join(" và ")} hiện tại. Tiếp tục?`)) return;
      const revenue = revenueImports[0];
      const products = productImports[0];
      const service = serviceImports[0];
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
        return { ...current, revenues: revenue?.records || current.revenues, products: products?.records || current.products, services: service?.records || current.services, imports };
      });
      if (revenue) {
        setPeriodMode("month");
        setSelectedMonth(revenue.latestDate.slice(0, 7));
        setSelectedYear(Number(revenue.latestDate.slice(0, 4)));
      }
      setRevenueSubTab(revenue || service ? "overview" : "products");
      setFinanceSyncError(undefined);
      setFinanceImportNotice(`Đã tự nhận diện và map ${parsed.map((entry) => entry.type === "revenue" ? `Doanh thu (${entry.meta.rowCount} ngày)` : entry.type === "products" ? `Mặt hàng (${entry.meta.rowCount} SKU)` : `Hình thức phục vụ (${entry.meta.rowCount} kênh)`).join(" + ")}.`);
    } catch (error) {
      const objectMessage = error && typeof error === "object" && "message" in error ? String(error.message || "") : "";
      const message = error instanceof Error ? error.message : objectMessage || "Không thể phân tích các file Excel.";
      setFinanceSyncError(message);
      window.alert(message);
    } finally {
      setImportingFinance(false);
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

  const pnlRows = [
    ["Doanh thu gộp", grossRevenue, "income"], ["Giảm giá / voucher", -discounts, "deduction"], ["Doanh thu thuần", netRevenue, "total"],
    ["NVL đã xuất dùng", -inventoryCogs, "cost"], ["Hao hụt NVL", -inventoryWaste, "cost"], ["Lợi nhuận gộp", grossProfit, "total"],
    ["Chi phí cố định", -fixedCost, "cost"], ["Chi phí vận hành", -operatingCost, "cost"], ["Chi phí bán hàng & nền tảng", -salesCost, "cost"], ["EBITDA", ebitda, "total"],
    ["Khấu hao", -depreciation, "cost"], ["Lợi nhuận hoạt động", operatingProfit, "grand"],
  ] as const;

  return <div className={styles.finance}>
    <header className={styles.financeHero}>
      <span className={styles.eyebrow}>NHA COFFEE & TEA{uatMode ? " · UAT LOCAL" : ""}</span>
      <div className={styles.financeHeroRow}><div><h1>Tài chính</h1><p>Theo dõi doanh thu, chi phí, dòng tiền và sức khỏe vận hành trên cùng một màn hình.</p></div><div className={styles.logo}><Image src="/nha-coffee-logo-transparent.png" alt="Nhà Coffee & Tea" width={750} height={420} priority /></div></div>
      <div className={styles.heroMetric}><span>{tab === "revenue" ? "Doanh thu thực · kỳ import" : `Lợi nhuận hoạt động · ${bounds.label}`}</span><strong>{money(tab === "revenue" ? datasetRevenue : operatingProfit)}</strong><small>{tab === "revenue" ? revenueImport ? `${dateLabel(revenueImport.periodStart)} – ${dateLabel(revenueImport.periodEnd)}` : "Chưa có file doanh thu" : netRevenue ? `${((operatingProfit / netRevenue) * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}% doanh thu thuần` : "Chưa có doanh thu trong kỳ"}</small></div>
    </header>

    {tab !== "revenue" && <section className={styles.periodPanel}>
      <div className={styles.periodModes}>{(["month", "quarter", "year"] as PeriodMode[]).map((mode) => <button className={periodMode === mode ? styles.selected : ""} key={mode} onClick={() => setPeriodMode(mode)}>{mode === "month" ? "Tháng" : mode === "quarter" ? "Quý" : "Năm"}</button>)}</div>
      <div className={styles.periodPicker}>{periodMode === "month" ? <input type="month" value={selectedMonth} onChange={(event) => { setSelectedMonth(event.target.value); setSelectedYear(Number(event.target.value.slice(0, 4))); }} /> : <><select value={selectedYear} onChange={(event) => setSelectedYear(Number(event.target.value))}>{Array.from({ length: 5 }, (_, index) => new Date().getFullYear() - 2 + index).map((year) => <option key={year}>{year}</option>)}</select>{periodMode === "quarter" && <select value={selectedQuarter} onChange={(event) => setSelectedQuarter(Number(event.target.value))}><option value={1}>Quý 1</option><option value={2}>Quý 2</option><option value={3}>Quý 3</option><option value={4}>Quý 4</option></select>}</>}</div>
      <div className={styles.periodStatus}><b>{bounds.label}</b><span>{currentPeriodClosed ? "● Đã khóa sổ" : "● Đang mở"}</span></div>
    </section>}

    <nav className={styles.financeTabs} aria-label="Điều hướng tài chính">
      <button className={tab === "entry" ? styles.active : ""} onClick={() => setTab("entry")}>Ghi nhận chi phí</button>
      <button className={tab === "revenue" ? styles.active : ""} onClick={() => setTab("revenue")}>Doanh thu</button>
      <button className={tab === "report" ? styles.active : ""} onClick={() => setTab("report")}>Báo cáo tài chính</button>
      <button className={tab === "dashboard" ? styles.active : ""} onClick={() => setTab("dashboard")}>Dashboard</button>
    </nav>

    {tab === "entry" && <section className={styles.content}>
      <div className={styles.summaryStrip}><div><span>Tổng chi phí kỳ</span><strong>{money(totalPeriodExpense)}</strong></div><div><span>Đã thanh toán</span><strong>{money(paidManual + inventoryPurchases + paidInvestments)}</strong></div><div><span>Chưa thanh toán</span><strong>{money(unpaidManual)}</strong></div><div><span>Từ Kho NVL</span><strong>{money(inventoryCogs + inventoryWaste)}</strong></div></div>
      <div className={styles.sectionHeader}><div><span>GIAO DỊCH TRONG KỲ</span><h2>Chi phí vận hành quán</h2></div><button onClick={() => openAddExpense(expenseCategory)}>+ Thêm chi phí</button></div>
      <div className={styles.categoryTabs}>{(Object.keys(categoryLabels) as ExpenseCategory[]).map((category) => <button key={category} className={expenseCategory === category ? styles.selected : ""} onClick={() => setExpenseCategory(category)}><span>{categoryLabels[category]}</span><b>{category === "operating" ? manualOccurrences.filter((entry) => entry.expense.category === category).length + inventoryEvents.length : category === "investment" ? assetExpenses.length : manualOccurrences.filter((entry) => entry.expense.category === category).length}</b></button>)}</div>
      <div className={styles.expenseList}>
        {selectedInventoryEvents.map((entry) => <article className={`${styles.expenseCard} ${entry.kind === "waste" ? styles.wasteCard : ""}`} key={entry.id}><div className={styles.expenseMain}><div className={styles.sourceIcon}>K</div><div><span className={styles.sourceLabel}>TỰ ĐỘNG TỪ KHO NVL</span><h3>{entry.lot.name} · 1 {entry.lot.unit}</h3><p>Phiếu {entry.lot.receiptCode || "chưa có mã"} · {entry.kind === "waste" ? "Báo hỏng" : "Active"} {dateLabel(entry.date)}</p></div></div><div className={styles.expenseValue}><strong>{money(entry.amount)}</strong><span>{entry.kind === "waste" ? "Tái phân loại hao hụt" : "NVL xuất dùng"}</span></div><button className={styles.sourceButton} onClick={() => onOpenInventoryLot(entry.lot.id)}>Xem lô nguồn →</button></article>)}
        {filteredManualExpenses.map((expense) => <article className={styles.expenseCard} key={expense.id}><div className={styles.expenseMain}><div className={styles.sourceIcon}>{expense.category === "fixed" ? "C" : expense.category === "operating" ? "V" : expense.category === "sales" ? "B" : "Đ"}</div><div><span className={styles.sourceLabel}>{categoryLabels[expense.category].toUpperCase()}</span><h3>{expense.name}</h3><p>{expense.subcategory} · {recurrenceLabels[expense.recurrence]} · {dateLabel(expense.incurredOn)}</p></div></div><div className={styles.expenseValue}><strong>{money(expense.amount)}</strong><span className={expense.paymentStatus === "paid" ? styles.paid : styles.unpaid}>{paymentLabels[expense.paymentStatus]}</span></div><div className={styles.cardActions}>{expense.paymentStatus !== "paid" && <button onClick={() => markPaid(expense)}>Đã trả</button>}<button onClick={() => openEditExpense(expense)}>Sửa</button><button onClick={() => voidExpense(expense)}>Huỷ</button></div></article>)}
        {!selectedInventoryEvents.length && !filteredManualExpenses.length && <div className={styles.empty}><b>Chưa có chi phí trong nhóm này</b><span>Nhấn “Thêm chi phí” để tạo giao dịch đầu tiên.</span></div>}
      </div>
      {uatMode && <div className={styles.uatTools}><span>Dữ liệu tài chính UAT chỉ lưu trong trình duyệt này.</span><button onClick={resetUat}>Nạp lại dữ liệu mẫu</button></div>}
    </section>}

    {tab === "revenue" && <section className={`${styles.content} ${styles.revenueContent}`}>
      <div className={styles.revenueSubTabs}>
        <button className={revenueSubTab === "overview" ? styles.selected : ""} onClick={() => setRevenueSubTab("overview")}><span>Tổng quan</span><small>{revenueImport?.rowCount || 0} ngày</small></button>
        <button className={revenueSubTab === "products" ? styles.selected : ""} onClick={() => setRevenueSubTab("products")}><span>Mặt hàng</span><small>{productsImport?.rowCount || 0} SKU</small></button>
      </div>

      <section className={styles.financeImportHub}>
        <div className={styles.importHubCopy}><span>IMPORT CENTER</span><h2>Một nơi cho tất cả file Excel</h2><p>Chọn cùng lúc file Doanh thu tổng quan, Mặt hàng và Hình thức phục vụ. Hệ thống tự đọc header, nhận diện template và map vào đúng dashboard.</p></div>
        <label className={`${styles.importHubButton} ${importingFinance ? styles.importing : ""}`}><input type="file" accept=".xls,.xlsx" multiple disabled={importingFinance} onChange={importFinanceExcel} /><span>{importingFinance ? "Đang phân tích & đồng bộ…" : "⇧ Chọn nhiều file Excel"}</span><small>.xls / .xlsx · tối đa 10 MB mỗi file</small></label>
        <div className={styles.importHubTypes}><span><i>DT</i>Doanh thu tổng quan</span><span><i>MH</i>Báo cáo mặt hàng</span><span><i>PV</i>Hình thức phục vụ</span><b>Tự nhận diện bằng header</b></div>
        {financeImportNotice && <div className={styles.importHubSuccess}><b>Import hoàn tất</b><span>{financeImportNotice}</span></div>}
      </section>

      {financeSyncError && <div className={styles.syncError}><b>Không thể import hoặc đồng bộ dữ liệu</b><span>{financeSyncError}</span></div>}

      {revenueSubTab === "overview" && <>
        <div className={styles.revenueHeader}>
          <div><span>DOANH THU TỔNG QUAN</span><h2>{revenueImport ? `${dateLabel(revenueImport.periodStart)} – ${dateLabel(revenueImport.periodEnd)}` : bounds.label}</h2><p>Import file Doanh thu tổng quan. Mỗi file mới sẽ thay toàn bộ bộ dữ liệu doanh thu cũ.</p></div>
        </div>
        {revenueImport && <div className={styles.datasetStatus}><div><span>FILE DOANH THU ĐANG DÙNG</span><b>{revenueImport.fileName}</b></div><div><span>DỮ LIỆU</span><b>{revenueImport.rowCount} ngày</b></div><div><span>CẬP NHẬT</span><b>{importTimeLabel(revenueImport.importedAt)}</b></div><i>{uatMode || !isSupabaseConfigured ? "Local UAT" : "Supabase synced"}</i></div>}
        {serviceImport && <div className={`${styles.datasetStatus} ${styles.serviceDatasetStatus}`}><div><span>FILE HÌNH THỨC PHỤC VỤ</span><b>{serviceImport.fileName}</b></div><div><span>DỮ LIỆU</span><b>{serviceImport.rowCount} kênh</b></div><div><span>KỲ BÁO CÁO</span><b>{dateLabel(serviceImport.periodStart)} – {dateLabel(serviceImport.periodEnd)}</b></div><i>{uatMode || !isSupabaseConfigured ? "Local UAT" : "Supabase synced"}</i></div>}
        {!revenueDataset.length && !state.services.length ? <div className={styles.revenueEmpty}><div>DT</div><h3>Chưa có báo cáo doanh thu</h3><p>Chọn file tại Import Center phía trên. Hệ thống sẽ tự đưa báo cáo vào tab Tổng quan.</p></div> : <>
          <div className={styles.revenueKpis}>
            <article className={styles.primaryRevenueKpi}><span>DOANH THU THỰC</span><strong>{money(datasetRevenue)}</strong><small>{importedRevenueRows.length.toLocaleString("vi-VN")} dòng báo cáo</small></article>
            <article><span>Đơn thành công</span><strong>{successfulOrders.toLocaleString("vi-VN")}</strong><small>/ {totalReportedOrders.toLocaleString("vi-VN")} tổng đơn</small></article>
            <article><span>Số lượng hàng</span><strong>{datasetItems.toLocaleString("vi-VN")}</strong><small>{averageItemsPerOrder.toLocaleString("vi-VN", { maximumFractionDigits: 2 })} SP/đơn</small></article>
            <article><span>Trung bình/đơn</span><strong>{money(averagePerOrder)}</strong><small>trên đơn thành công</small></article>
            <article><span>Trung bình/sản phẩm</span><strong>{money(averagePerItem)}</strong><small>doanh thu thực / số lượng hàng</small></article>
            <article className={cancellationRate > 3 ? styles.warningKpi : ""}><span>Tỷ lệ hủy</span><strong>{percent(cancellationRate)}</strong><small>{cancelledOrders.toLocaleString("vi-VN")} đơn · {money(reportedCancelledAmount)}</small></article>
          </div>
          <div className={styles.revenueInsightGrid}>
            <article className={`${styles.revenuePanel} ${styles.platformTakeCard}`}>
              <div className={styles.revenuePanelTitle}><div><span>PHÍ NỀN TẢNG / GIAO HÀNG</span><strong>{money(reportedPartnerFees)}</strong></div><small>{percent(platformTakeRate)} {deliveryRevenue ? "doanh thu giao hàng" : "doanh thu thực"}</small></div>
              <div className={styles.platformTakeBody}>
                <div className={styles.platformTakeRing} style={{ background: `conic-gradient(#e87d5c 0 ${Math.min(100, platformTakeRate)}%, #e8ede5 ${Math.min(100, platformTakeRate)}% 100%)` }}><i><strong>{percent(platformTakeRate)}</strong><small>bị giữ lại</small></i></div>
                <div className={styles.platformTakeStats}><div><span>{deliveryRevenue ? "DT giao hàng/nền tảng" : "DT thực làm mẫu số"}</span><b>{money(platformTakeBase)}</b></div><div><span>Doanh thu sau nhóm phí</span><b>{money(revenueAfterPlatformFees)}</b></div>{grabService && <div><span>Riêng Grab Food</span><b>{money(grabService.revenue)}</b></div>}<div><span>Ngày phát sinh phí</span><b>{revenueDataset.length ? `${platformFeeDays}/${revenueDataset.length}` : "—"}</b></div><div><span>Phí đối tác / tiền hàng</span><b>{percent(partnerCommissionRate)}</b></div></div>
              </div>
              <div className={styles.platformFeeList}>{platformFeeComponents.map((entry) => <div key={entry.label}><div><span>{entry.label}</span><b>{money(entry.value)}</b></div><div><i style={{ width: `${entry.value / maxPlatformFeeComponent * 100}%` }} /></div></div>)}</div>
              <p className={styles.metricDisclaimer}>{deliveryRevenue ? "Tỷ lệ phí dùng doanh thu của các hình thức giao hàng/nền tảng làm mẫu số." : "Chưa có file Hình thức phục vụ nên tạm dùng toàn bộ doanh thu thực làm mẫu số."} Các cột phí trong báo cáo Sapo đang gộp nhiều đối tác, vì vậy không quy toàn bộ phí cho riêng Grab.</p>
            </article>
            <article className={`${styles.revenuePanel} ${styles.channelMixCard}`}>
              <div className={styles.revenuePanelTitle}><div><span>PHÂN BỔ HÌNH THỨC PHỤC VỤ</span><strong>{serviceOrders ? `${serviceOrders.toLocaleString("vi-VN")} đơn` : "Chờ file phục vụ"}</strong></div><small>{serviceCancelledOrders ? `${serviceCancelledOrders.toLocaleString("vi-VN")} đơn hủy` : "Theo doanh thu & đơn"}</small></div>
              {state.services.length ? <>
                <div className={styles.serviceSegmentBar} aria-label={`Offline ${percent(offlineOrderShare)}, giao hàng và nền tảng ${percent(deliveryOrderShare)}`}><i style={{ width: `${offlineOrderShare}%` }} /><b style={{ width: `${deliveryOrderShare}%` }} /></div>
                <div className={styles.serviceLegend}><span><i />Offline <b>{percent(offlineOrderShare)}</b></span><span><i />Giao hàng / nền tảng <b>{percent(deliveryOrderShare)}</b></span></div>
                <div className={styles.serviceSummary}>
                  <div><span>OFFLINE</span><b>{offlineOrders.toLocaleString("vi-VN")} đơn</b><strong>{money(offlineRevenue)}</strong><small>{percent(offlineRevenueShare)} doanh thu</small></div>
                  <div><span>GIAO HÀNG / NỀN TẢNG</span><b>{deliveryOrders.toLocaleString("vi-VN")} đơn</b><strong>{money(deliveryRevenue)}</strong><small>{percent(deliveryRevenueShare)} doanh thu</small></div>
                </div>
                <div className={styles.serviceModeList}>{state.services.map((entry) => {
                  const orderShare = serviceOrders ? entry.totalOrders / serviceOrders * 100 : 0;
                  const isGrab = normalizedHeader(entry.serviceName).includes("grab");
                  return <div className={isGrab ? styles.grabHighlight : ""} key={entry.id}><div><span><b>{entry.serviceName}</b><small>{entry.totalOrders.toLocaleString("vi-VN")} đơn · {percent(orderShare)} tổng đơn{entry.cancelledOrders ? ` · ${entry.cancelledOrders.toLocaleString("vi-VN")} hủy` : ""}</small></span><strong>{money(entry.revenue)}</strong></div><div className={styles.serviceModeTrack}><i style={{ width: `${entry.revenue / maxServiceRevenue * 100}%` }} /></div></div>;
                })}</div>
                <div className={`${styles.serviceReconciliation} ${revenueDataset.length && Math.abs(serviceRevenueGap) < 1 ? styles.reconciled : ""}`}><span>Đối soát với Doanh thu tổng quan</span><b>{!revenueDataset.length ? "Chờ file doanh thu" : Math.abs(serviceRevenueGap) < 1 ? "Khớp 100%" : `Lệch ${money(Math.abs(serviceRevenueGap))}`}</b></div>
              </> : <div className={styles.panelEmpty}>Import file Hình thức phục vụ tại Import Center để xem phân bổ thật giữa tại bàn, mang đi, Grab Food và các kênh giao hàng.</div>}
            </article>
            <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>GROSS-TO-NET</span><strong>{money(reportedGoodsAmount)} tiền hàng</strong></div><small>{percent(discountRate)} giảm giá</small></div><div className={styles.adjustmentList}>{revenueAdjustments.map((entry) => <div key={entry.label}><div><span>{entry.label}</span><b>-{money(entry.value)}</b></div><div className={styles.adjustmentTrack}><i style={{ width: `${entry.value / maxRevenueAdjustment * 100}%` }} /></div></div>)}<div className={styles.netRevenueRow}><span>Doanh thu thực</span><b>{money(datasetRevenue)}</b></div></div></article>
            <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>ĐỐI SOÁT HAI BÁO CÁO</span><strong>{state.products.length ? money(Math.abs(revenueProductGap)) : "Chờ file mặt hàng"}</strong></div><small>Chênh lệch</small></div>{state.products.length ? <div className={styles.reconciliation}><div><span>Doanh thu thực</span><b>{money(datasetRevenue)}</b><i style={{ width: "100%" }} /></div><div><span>Tổng tiền mặt hàng</span><b>{money(productNetAmount)}</b><i style={{ width: `${datasetRevenue ? Math.min(100, productNetAmount / datasetRevenue * 100) : 0}%` }} /></div><p>Chênh lệch có thể đến từ đơn hủy, phí hoặc cấu hình báo cáo Sapo. Dùng ô này để kiểm tra hai file cùng kỳ.</p></div> : <div className={styles.panelEmpty}>Import thêm Báo cáo mặt hàng để đối soát doanh thu và cơ cấu sản phẩm.</div>}</article>
          </div>
        </>}
      </>}

      {revenueSubTab === "products" && <>
        <div className={styles.revenueHeader}>
          <div><span>BÁO CÁO MẶT HÀNG</span><h2>{productsImport ? `${dateLabel(productsImport.periodStart)} – ${dateLabel(productsImport.periodEnd)}` : "Cơ cấu sản phẩm"}</h2><p>Import file Danh mục mặt hàng. Mỗi file mới sẽ thay toàn bộ bộ dữ liệu mặt hàng cũ.</p></div>
        </div>
        {productsImport && <div className={styles.datasetStatus}><div><span>FILE ĐANG DÙNG</span><b>{productsImport.fileName}</b></div><div><span>DỮ LIỆU</span><b>{productsImport.rowCount} SKU</b></div><div><span>CẬP NHẬT</span><b>{importTimeLabel(productsImport.importedAt)}</b></div><i>{uatMode || !isSupabaseConfigured ? "Local UAT" : "Supabase synced"}</i></div>}
        {!state.products.length ? <div className={styles.revenueEmpty}><div>MH</div><h3>Chưa có báo cáo mặt hàng</h3><p>Chọn file tại Import Center phía trên. Hệ thống sẽ tự đưa báo cáo vào tab Mặt hàng.</p></div> : <>
          <div className={styles.productKpis}><article><span>TỔNG TIỀN MẶT HÀNG</span><strong>{money(productNetAmount)}</strong><small>sau giảm giá</small></article><article><span>SẢN PHẨM BÁN</span><strong>{productQuantity.toLocaleString("vi-VN")}</strong><small>{state.products.length} SKU</small></article><article><span>DANH MỤC</span><strong>{categoryPerformance.length}</strong><small>nhóm sản phẩm</small></article><article><span>GIẢM GIÁ</span><strong>{money(productDiscountAmount)}</strong><small>{percent(productDiscountRate)} tiền hàng</small></article><article><span>TB/SẢN PHẨM</span><strong>{money(averageProductValue)}</strong><small>sau giảm giá</small></article></div>
          <div className={styles.productVisualGrid}>
            <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>DOANH THU THEO DANH MỤC</span><strong>{categoryPerformance.length} danh mục</strong></div></div><div className={styles.categoryBars}>{categoryPerformance.map((entry) => <div key={entry.name}><div><span><b>{entry.name}</b><small>{entry.quantity.toLocaleString("vi-VN")} SP · {entry.skuCount} SKU</small></span><strong>{money(entry.revenue)}</strong></div><div><i style={{ width: `${entry.revenue / maxCategoryRevenue * 100}%` }} /></div></div>)}</div></article>
            <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>TOP MẶT HÀNG</span><strong>Theo tổng tiền</strong></div></div><div className={styles.topRevenueList}>{topProducts.map((entry, index) => <div key={entry.id}><i>{index + 1}</i><span><b>{entry.name} {entry.variant ? `· ${entry.variant}` : ""}</b><small>{entry.category} · {entry.quantity.toLocaleString("vi-VN")} SP</small></span><strong>{money(entry.totalAmount)}</strong></div>)}</div></article>
          </div>
          <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>MẶT HÀNG GIẢM GIÁ CAO</span><strong>Cần kiểm tra biên lợi nhuận</strong></div><small>% trên tiền hàng</small></div><div className={styles.discountProductList}>{highDiscountProducts.map((entry) => <div key={entry.id}><span><b>{entry.name} {entry.variant ? `· ${entry.variant}` : ""}</b><small>{entry.sku} · {money(entry.goodsAmount)} tiền hàng</small></span><strong>{percent(entry.goodsAmount ? entry.discountAmount / entry.goodsAmount * 100 : 0)}<small>{money(entry.discountAmount)}</small></strong></div>)}</div></article>
        </>}
      </>}
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
      <div className={styles.dashboardActions}><div><span>DASHBOARD ĐIỀU HÀNH</span><h2>Hiệu quả kinh doanh</h2></div><button onClick={() => { setTab("revenue"); setRevenueSubTab(!state.products.length ? "products" : "overview"); }}>Nhập dữ liệu Excel</button></div>
      <div className={styles.targetCard}><div><span>MỤC TIÊU DOANH THU</span><strong>{money(revenueTarget)}</strong><p>{state.revenueTargetAmount ? previousNetRevenue ? `Mục tiêu nhập trực tiếp · tương đương ${targetGrowthRate.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}% so với ${money(previousNetRevenue)} kỳ trước` : "Mục tiêu doanh thu nhập trực tiếp." : previousNetRevenue ? `Tự tính tăng ${growthTargetPercent.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}% từ ${money(previousNetRevenue)} kỳ trước` : "Nhập mục tiêu doanh thu để bắt đầu theo dõi."}</p></div><div className={styles.targetPercent}>{targetProgress.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%</div><div className={styles.progressTrack}><i style={{ width: `${targetProgress}%` }} /></div><div className={styles.targetInputs}><label>Mục tiêu doanh thu (₫)<input inputMode="numeric" placeholder="Ví dụ: 50,000,000" value={state.revenueTargetAmount ? amountInput(String(state.revenueTargetAmount)) : ""} onChange={(event) => setState((current) => ({ ...current, revenueTargetAmount: parseAmount(event.target.value) }))} /></label><label>Tăng trưởng tự tính (%)<input min="0" step="0.1" type="number" value={state.growthTargetPercent} onChange={(event) => setState((current) => ({ ...current, growthTargetPercent: Math.max(0, Number(event.target.value) || 0), revenueTargetAmount: 0 }))} /></label><div className={styles.targetAuto}><span>MỤC TIÊU LY TỰ TÍNH</span><strong>{cupTarget.toLocaleString("vi-VN")} ly</strong><small>≈ {money(baselineAveragePerCup)}/ly theo kỳ trước</small></div></div><p>Đã đạt {money(netRevenue)} · còn thiếu {money(revenueRemaining)}</p></div>
      <div className={styles.kpiGrid}><article className={styles.averageCup}><span>Trung bình/đơn</span><strong>{money(averagePerOrder)}</strong><small>{totalReportedOrders.toLocaleString("vi-VN")} đơn toàn báo cáo</small></article><article><span>Trung bình/sản phẩm</span><strong>{money(averageProductValue || averagePerItem)}</strong><small>sau giảm giá</small></article><article><span>Sản phẩm bán</span><strong>{(productQuantity || datasetItems).toLocaleString("vi-VN")}</strong><small>{state.products.length || importedRevenueRows.length} dòng dữ liệu</small></article><article className={cancellationRate > 3 ? styles.attention : ""}><span>Tỷ lệ hủy đơn</span><strong>{percent(cancellationRate)}</strong><small>{cancelledOrders.toLocaleString("vi-VN")} đơn hủy</small></article><article className={productDiscountRate > 15 ? styles.attention : ""}><span>Tỷ lệ giảm giá</span><strong>{percent(productDiscountRate || discountRate)}</strong><small>{money(productDiscountAmount || reportedDiscountAmount)}</small></article><article><span>Gross margin</span><strong>{percent(grossMargin)}</strong><small>{bounds.label}</small></article></div>

      <div className={styles.dashboardDataNote}><span>Doanh thu: <b>{revenueImport ? `${dateLabel(revenueImport.periodStart)} – ${dateLabel(revenueImport.periodEnd)}` : "chưa import"}</b></span><span>Mặt hàng: <b>{productsImport ? `${dateLabel(productsImport.periodStart)} – ${dateLabel(productsImport.periodEnd)}` : "chưa import"}</b></span><span>Phục vụ: <b>{serviceImport ? `${dateLabel(serviceImport.periodStart)} – ${dateLabel(serviceImport.periodEnd)}` : "chưa import"}</b></span></div>

      <div className={styles.productVisualGrid}>
        <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>CƠ CẤU DOANH THU</span><strong>Theo danh mục</strong></div></div>{categoryPerformance.length ? <div className={styles.categoryBars}>{categoryPerformance.slice(0, 8).map((entry) => <div key={entry.name}><div><span><b>{entry.name}</b><small>{entry.quantity.toLocaleString("vi-VN")} sản phẩm</small></span><strong>{money(entry.revenue)}</strong></div><div><i style={{ width: `${entry.revenue / maxCategoryRevenue * 100}%` }} /></div></div>)}</div> : <div className={styles.panelEmpty}>Import Báo cáo mặt hàng để xem cơ cấu danh mục.</div>}</article>
        <article className={styles.revenuePanel}><div className={styles.revenuePanelTitle}><div><span>TOP SẢN PHẨM</span><strong>Đóng góp doanh thu cao</strong></div></div>{topProducts.length ? <div className={styles.topRevenueList}>{topProducts.slice(0, 6).map((entry, index) => <div key={entry.id}><i>{index + 1}</i><span><b>{entry.name}</b><small>{entry.category} · {entry.quantity.toLocaleString("vi-VN")} SP</small></span><strong>{money(entry.totalAmount)}</strong></div>)}</div> : <div className={styles.panelEmpty}>Chưa có dữ liệu mặt hàng.</div>}</article>
      </div>

      <div className={styles.chartGrid}><article className={styles.costMixCard}><div><span>CƠ CẤU CHI PHÍ · {bounds.label.toUpperCase()}</span><strong>{money(totalPeriodExpense)}</strong></div><div className={styles.donut} style={{ background: `conic-gradient(#171916 0 ${totalPeriodExpense ? (inventoryCogs + inventoryWaste) / totalPeriodExpense * 100 : 0}%, #887a5d 0 ${totalPeriodExpense ? (inventoryCogs + inventoryWaste + fixedCost) / totalPeriodExpense * 100 : 0}%, #c9b896 0 ${totalPeriodExpense ? (inventoryCogs + inventoryWaste + fixedCost + operatingCost) / totalPeriodExpense * 100 : 0}%, #e9dfca 0 100%)` }}><i>{grossMargin.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%<small>gross margin</small></i></div><div className={styles.legend}><span><i className={styles.legendDark} />NVL {money(inventoryCogs + inventoryWaste)}</span><span><i className={styles.legendBrown} />Cố định {money(fixedCost)}</span><span><i className={styles.legendSand} />Vận hành {money(operatingCost)}</span><span><i className={styles.legendCream} />Bán hàng {money(salesCost)}</span></div></article><article className={styles.forecastCard}><span>ĐỐI SOÁT & SỨC KHỎE</span><strong>{state.products.length && revenueDataset.length ? money(Math.abs(revenueProductGap)) : "Chưa đủ dữ liệu"}</strong><p>Chênh lệch giữa Doanh thu thực và Tổng tiền mặt hàng.</p><div><span>Doanh thu thực</span><b>{money(datasetRevenue)}</b></div><div><span>Tổng tiền mặt hàng</span><b>{money(productNetAmount)}</b></div><div><span>EBITDA {bounds.label}</span><b className={ebitda < 0 ? styles.redText : ""}>{money(ebitda)}</b></div><div><span>Tồn kho hiện tại</span><b>{money(closingInventory)}</b></div></article></div>
    </section>}

    {showExpenseForm && <div className={styles.backdrop} role="presentation" onMouseDown={() => setShowExpenseForm(false)}><form className={styles.sheet} onSubmit={saveExpense} onMouseDown={(event) => event.stopPropagation()}><div className={styles.sheetHandle} /><div className={styles.sheetTitle}><div><span>{editingExpenseId ? "CẬP NHẬT" : "GHI NHẬN"}</span><h2>{categoryLabels[expenseForm.category]}</h2></div><button type="button" onClick={() => setShowExpenseForm(false)}>×</button></div><label>Category<select value={expenseForm.category} onChange={(event) => setExpenseForm((current) => ({ ...current, category: event.target.value as ExpenseCategory, recurrence: event.target.value === "fixed" ? "monthly" : "once" }))}>{(Object.keys(categoryLabels) as ExpenseCategory[]).map((category) => <option value={category} key={category}>{categoryLabels[category]}</option>)}</select></label><label>Tên chi phí / tài sản<input autoFocus required value={expenseForm.name} onChange={(event) => setExpenseForm((current) => ({ ...current, name: event.target.value }))} placeholder="Ví dụ: Tiền thuê mặt bằng" /></label><div className={styles.formRow}><label>Subcategory<input value={expenseForm.subcategory} onChange={(event) => setExpenseForm((current) => ({ ...current, subcategory: event.target.value }))} placeholder="Ví dụ: Mặt bằng" /></label><label>Số tiền<input required inputMode="numeric" value={expenseForm.amount} onChange={(event) => setExpenseForm((current) => ({ ...current, amount: amountInput(event.target.value) }))} placeholder="15,000,000" /></label></div><div className={styles.formRow}><label>Ngày ghi nhận<input required type="date" value={expenseForm.incurredOn} onChange={(event) => setExpenseForm((current) => ({ ...current, incurredOn: event.target.value }))} /></label>{expenseForm.category !== "investment" && <label>Chu kỳ<select value={expenseForm.recurrence} onChange={(event) => setExpenseForm((current) => ({ ...current, recurrence: event.target.value as Recurrence }))}>{(Object.keys(recurrenceLabels) as Recurrence[]).map((recurrence) => <option value={recurrence} key={recurrence}>{recurrenceLabels[recurrence]}</option>)}</select></label>}</div>{expenseForm.category === "investment" && <><div className={styles.formRow}><label>Ngày sử dụng<input type="date" value={expenseForm.inServiceOn} onChange={(event) => setExpenseForm((current) => ({ ...current, inServiceOn: event.target.value }))} /></label><label>Khấu hao (tháng)<input min="1" type="number" value={expenseForm.usefulLifeMonths} onChange={(event) => setExpenseForm((current) => ({ ...current, usefulLifeMonths: event.target.value }))} /></label></div><label>Giá trị thu hồi<input inputMode="numeric" value={expenseForm.salvageValue} onChange={(event) => setExpenseForm((current) => ({ ...current, salvageValue: amountInput(event.target.value) }))} /></label></>}<div className={styles.formRow}><label>Thanh toán<select value={expenseForm.paymentStatus} onChange={(event) => setExpenseForm((current) => ({ ...current, paymentStatus: event.target.value as PaymentStatus }))}>{(Object.keys(paymentLabels) as PaymentStatus[]).map((status) => <option value={status} key={status}>{paymentLabels[status]}</option>)}</select></label>{expenseForm.paymentStatus === "paid" && <label>Ngày thanh toán<input type="date" value={expenseForm.paymentDate} onChange={(event) => setExpenseForm((current) => ({ ...current, paymentDate: event.target.value }))} /></label>}</div><div className={styles.formRow}><label>Mã hóa đơn<input value={expenseForm.invoiceCode} onChange={(event) => setExpenseForm((current) => ({ ...current, invoiceCode: event.target.value }))} /></label><label>Nhà cung cấp<input value={expenseForm.vendor} onChange={(event) => setExpenseForm((current) => ({ ...current, vendor: event.target.value }))} /></label></div><label>Note<textarea value={expenseForm.note} onChange={(event) => setExpenseForm((current) => ({ ...current, note: event.target.value }))} placeholder="Ghi chú nội bộ" /></label><button className={styles.primaryButton} type="submit">{editingExpenseId ? "Lưu thay đổi" : "Ghi nhận chi phí"}</button></form></div>}

  </div>;
}

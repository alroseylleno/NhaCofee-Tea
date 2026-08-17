import { supabase } from "@/lib/supabase";

export type FinanceImportType = "revenue" | "products" | "service" | "orders";

export type FinanceImportMeta = {
  dataType: FinanceImportType;
  fileName: string;
  periodStart: string;
  periodEnd: string;
  rowCount: number;
  importedAt: string;
};

export type FinanceRevenueRecord = {
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
  source?: "manual" | "excel";
  importedAt?: string;
  importFileName?: string;
  importPeriod?: string;
  reported?: {
    totalOrders: number;
    cancelledOrders: number;
    itemQuantity: number;
    averageItemsPerOrder: number;
    averageOrderValue: number;
    goodsAmount: number;
    cancelledAmount: number;
    returnedAmount: number;
    discountAmount: number;
    taxAmount: number;
    serviceFeeBeforeTax: number;
    deliveryFee: number;
    partnerFee: number;
    platformTaxCollected: number;
    tips: number;
    customerDebt: number;
    actualRevenue: number;
    sales: number;
  };
};

export type FinanceProductRecord = {
  id: string;
  sourceRow: number;
  category: string;
  sku: string;
  name: string;
  variant: string;
  sellingPrice: number;
  unit: string;
  quantity: number;
  weight: number;
  usageTime: string;
  quantityRatio: number;
  goodsAmount: number;
  goodsRatio: number;
  discountAmount: number;
  amountAfterDiscount: number;
  taxAmount: number;
  totalAmount: number;
};

export type FinanceServiceRecord = {
  id: string;
  sourceRow: number;
  serviceName: string;
  totalOrders: number;
  cancelledOrders: number;
  revenue: number;
};

export type FinancePlatformOrderRecord = {
  id: string;
  orderCode: string;
  orderDate: string;
  channelName: string;
  reportedAmount: number;
  orderCreatedAt?: string;
  paidAt?: string;
  goodsAmount: number;
  discountAmount: number;
  serviceFee: number;
  deliveryFee: number;
  tipAmount: number;
  refundAmount: number;
  paymentMethod?: string;
  serviceType?: string;
  deliveryPartner?: string;
  status?: string;
  sourceFileName?: string;
  importedAt?: string;
};

export type FinanceGrabReconciliationRecord = {
  id: string;
  platformOrderId?: string;
  orderCode: string;
  orderDate: string;
  reportedAmount: number;
  receivedAmount: number;
  note?: string;
};

export type FinanceExpenseRecord = {
  id: string;
  name: string;
  category: "fixed" | "operating" | "sales" | "investment";
  subcategory: string;
  amount: number;
  incurredOn: string;
  recurrence: "once" | "weekly" | "monthly" | "quarterly" | "yearly";
  paymentStatus: "unpaid" | "partial" | "paid";
  paymentDate?: string;
  invoiceCode?: string;
  vendor?: string;
  note?: string;
  usefulLifeMonths?: number;
  salvageValue?: number;
  inServiceOn?: string;
  status: "active" | "voided";
};

export type FinanceCloudState = {
  expenses: FinanceExpenseRecord[];
  revenues: FinanceRevenueRecord[];
  products: FinanceProductRecord[];
  services: FinanceServiceRecord[];
  platformOrders: FinancePlatformOrderRecord[];
  grabReconciliations: FinanceGrabReconciliationRecord[];
  imports: FinanceImportMeta[];
};

function requireClient() {
  if (!supabase) throw new Error("Supabase chưa được cấu hình.");
  return supabase;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function expenseFromRow(row: Record<string, unknown>): FinanceExpenseRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    category: row.category as FinanceExpenseRecord["category"],
    subcategory: String(row.subcategory),
    amount: numberValue(row.amount),
    incurredOn: String(row.incurred_on),
    recurrence: row.recurrence as FinanceExpenseRecord["recurrence"],
    paymentStatus: row.payment_status as FinanceExpenseRecord["paymentStatus"],
    paymentDate: row.payment_date ? String(row.payment_date) : undefined,
    invoiceCode: row.invoice_code ? String(row.invoice_code) : undefined,
    vendor: row.vendor ? String(row.vendor) : undefined,
    note: row.note ? String(row.note) : undefined,
    usefulLifeMonths: row.useful_life_months === null || row.useful_life_months === undefined ? undefined : Number(row.useful_life_months),
    salvageValue: row.salvage_value === null || row.salvage_value === undefined ? undefined : numberValue(row.salvage_value),
    inServiceOn: row.in_service_on ? String(row.in_service_on) : undefined,
    status: row.status as FinanceExpenseRecord["status"],
  };
}

function grabReconciliationFromRow(row: Record<string, unknown>): FinanceGrabReconciliationRecord {
  return {
    id: String(row.id),
    platformOrderId: row.platform_order_id ? String(row.platform_order_id) : undefined,
    orderCode: String(row.order_code),
    orderDate: String(row.order_date),
    reportedAmount: numberValue(row.reported_amount),
    receivedAmount: numberValue(row.received_amount),
    note: row.note ? String(row.note) : undefined,
  };
}

function platformOrderFromRow(row: Record<string, unknown>): FinancePlatformOrderRecord {
  return {
    id: String(row.id),
    orderCode: String(row.order_code),
    orderDate: String(row.order_date),
    channelName: String(row.channel_name),
    reportedAmount: numberValue(row.reported_amount),
    orderCreatedAt: row.order_created_at ? String(row.order_created_at) : undefined,
    paidAt: row.paid_at ? String(row.paid_at) : undefined,
    goodsAmount: numberValue(row.goods_amount),
    discountAmount: numberValue(row.discount_amount),
    serviceFee: numberValue(row.service_fee),
    deliveryFee: numberValue(row.delivery_fee),
    tipAmount: numberValue(row.tip_amount),
    refundAmount: numberValue(row.refund_amount),
    paymentMethod: row.payment_method ? String(row.payment_method) : undefined,
    serviceType: row.service_type ? String(row.service_type) : undefined,
    deliveryPartner: row.delivery_partner ? String(row.delivery_partner) : undefined,
    status: row.status ? String(row.status) : undefined,
    sourceFileName: row.source_file_name ? String(row.source_file_name) : undefined,
    importedAt: row.imported_at ? String(row.imported_at) : undefined,
  };
}

function supabaseFailure(error: unknown, context: string) {
  const detail = error && typeof error === "object" ? error as { code?: string; message?: string; details?: string; hint?: string } : {};
  const rawMessage = [detail.message, detail.details, detail.hint].filter(Boolean).join(" · ");
  const migrationMissing = detail.code === "PGRST202" || detail.code === "42P01" || /schema cache|could not find the function|does not exist/i.test(rawMessage);
  if (migrationMissing) return new Error("Supabase Production chưa áp dụng migration Tài chính. Kiểm tra workflow Apply Supabase migrations trên GitHub Actions rồi thử import lại.");
  return new Error(`${context}${rawMessage ? `: ${rawMessage}` : " thất bại."}${detail.code ? ` [${detail.code}]` : ""}`);
}

export async function loadFinanceImports(): Promise<FinanceCloudState> {
  const client = requireClient();
  const [expensesResult, importsResult, revenueResult, productsResult, servicesResult] = await Promise.all([
    client.from("finance_expenses").select("*").order("incurred_on", { ascending: false }),
    client.from("finance_imports").select("*").order("imported_at", { ascending: false }),
    client.from("finance_revenue_rows").select("*").order("report_date", { ascending: false }),
    client.from("finance_product_rows").select("*").order("source_row", { ascending: true }),
    client.from("finance_service_rows").select("*").order("source_row", { ascending: true }),
  ]);
  if (expensesResult.error) throw supabaseFailure(expensesResult.error, "Không thể tải chi phí ghi nhận");
  if (importsResult.error) throw supabaseFailure(importsResult.error, "Không thể tải metadata import");
  if (revenueResult.error) throw supabaseFailure(revenueResult.error, "Không thể tải dữ liệu doanh thu");
  if (productsResult.error) throw supabaseFailure(productsResult.error, "Không thể tải dữ liệu mặt hàng");
  if (servicesResult.error) throw supabaseFailure(servicesResult.error, "Không thể tải dữ liệu hình thức phục vụ");

  const imports: FinanceImportMeta[] = (importsResult.data || []).map((row) => ({
    dataType: row.data_type,
    fileName: row.file_name,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    rowCount: Number(row.row_count),
    importedAt: row.imported_at,
  }));
  const importByType = new Map(imports.map((entry) => [entry.dataType, entry]));
  const revenueMeta = importByType.get("revenue");

  const expenses: FinanceExpenseRecord[] = (expensesResult.data || []).map((row) => expenseFromRow(row));

  const revenues: FinanceRevenueRecord[] = (revenueResult.data || []).map((row) => {
    const totalPlatformFees = numberValue(row.partner_fee) + numberValue(row.platform_tax_collected) + numberValue(row.service_fee_before_tax) + numberValue(row.delivery_fee);
    const actualRevenue = numberValue(row.actual_revenue);
    const totalOrders = numberValue(row.total_orders);
    const cancelledOrders = numberValue(row.cancelled_orders);
    return {
      id: row.id,
      date: row.report_date,
      storeRevenue: actualRevenue,
      appRevenue: 0,
      discounts: 0,
      platformFees: totalPlatformFees,
      cashReceived: Math.max(0, actualRevenue - totalPlatformFees),
      orders: Math.max(0, totalOrders - cancelledOrders),
      cups: numberValue(row.item_quantity),
      note: revenueMeta ? `Import từ ${revenueMeta.fileName}` : undefined,
      source: "excel",
      importedAt: revenueMeta?.importedAt,
      importFileName: revenueMeta?.fileName,
      importPeriod: revenueMeta ? `${revenueMeta.periodStart}:${revenueMeta.periodEnd}` : undefined,
      reported: {
        totalOrders,
        cancelledOrders,
        itemQuantity: numberValue(row.item_quantity),
        averageItemsPerOrder: numberValue(row.average_items_per_order),
        averageOrderValue: numberValue(row.average_order_value),
        goodsAmount: numberValue(row.goods_amount),
        cancelledAmount: numberValue(row.cancelled_amount),
        returnedAmount: numberValue(row.returned_amount),
        discountAmount: numberValue(row.discount_amount),
        taxAmount: numberValue(row.tax_amount),
        serviceFeeBeforeTax: numberValue(row.service_fee_before_tax),
        deliveryFee: numberValue(row.delivery_fee),
        partnerFee: numberValue(row.partner_fee),
        platformTaxCollected: numberValue(row.platform_tax_collected),
        tips: numberValue(row.tips),
        customerDebt: numberValue(row.customer_debt),
        actualRevenue,
        sales: numberValue(row.sales),
      },
    };
  });

  const products: FinanceProductRecord[] = (productsResult.data || []).map((row) => ({
    id: row.id,
    sourceRow: Number(row.source_row),
    category: row.category_name,
    sku: row.sku,
    name: row.product_name,
    variant: row.variant_name || "",
    sellingPrice: numberValue(row.selling_price),
    unit: row.unit_name || "",
    quantity: numberValue(row.quantity),
    weight: numberValue(row.weight),
    usageTime: row.usage_time || "",
    quantityRatio: numberValue(row.quantity_ratio),
    goodsAmount: numberValue(row.goods_amount),
    goodsRatio: numberValue(row.goods_ratio),
    discountAmount: numberValue(row.discount_amount),
    amountAfterDiscount: numberValue(row.amount_after_discount),
    taxAmount: numberValue(row.tax_amount),
    totalAmount: numberValue(row.total_amount),
  }));

  const services: FinanceServiceRecord[] = (servicesResult.data || []).map((row) => ({
    id: row.id,
    sourceRow: Number(row.source_row),
    serviceName: row.service_name,
    totalOrders: numberValue(row.total_orders),
    cancelledOrders: numberValue(row.cancelled_orders),
    revenue: numberValue(row.revenue),
  }));

  // Platform-order and GRAB reconciliation are UAT-only while their schema is
  // still under test. Production must not query experimental tables.
  return { expenses, revenues, products, services, platformOrders: [], grabReconciliations: [], imports };
}

function expenseRows(records: FinanceExpenseRecord[]) {
  return records.map((record) => ({
    id: record.id,
    name: record.name,
    category: record.category,
    subcategory: record.subcategory,
    amount: record.amount,
    incurred_on: record.incurredOn,
    recurrence: record.recurrence,
    payment_status: record.paymentStatus,
    payment_date: record.paymentDate || null,
    invoice_code: record.invoiceCode || null,
    vendor: record.vendor || null,
    note: record.note || null,
    useful_life_months: record.usefulLifeMonths ?? null,
    salvage_value: record.salvageValue ?? null,
    in_service_on: record.inServiceOn || null,
    status: record.status,
    updated_at: new Date().toISOString(),
  }));
}

export async function upsertFinanceExpenses(records: FinanceExpenseRecord[], ignoreExisting = false) {
  if (!records.length) return [];
  const { data, error } = await requireClient().from("finance_expenses").upsert(expenseRows(records), {
    onConflict: "id",
    ignoreDuplicates: ignoreExisting,
  }).select("*");
  if (error) throw supabaseFailure(error, "Không thể lưu chi phí ghi nhận");
  return (data || []).map((row) => expenseFromRow(row));
}

function grabReconciliationRows(records: FinanceGrabReconciliationRecord[]) {
  return records.map((record) => ({
    id: record.id,
    platform_order_id: record.platformOrderId || null,
    order_code: record.orderCode,
    order_date: record.orderDate,
    reported_amount: record.reportedAmount,
    received_amount: record.receivedAmount,
    note: record.note || null,
    updated_at: new Date().toISOString(),
  }));
}

export async function upsertFinanceGrabReconciliations(records: FinanceGrabReconciliationRecord[]) {
  if (!records.length) return [];
  const { data, error } = await requireClient().from("finance_grab_reconciliations").upsert(grabReconciliationRows(records), {
    onConflict: "id",
  }).select("*");
  if (error) throw supabaseFailure(error, "Không thể lưu đối soát GRAB");
  return (data || []).map((row) => grabReconciliationFromRow(row));
}

export async function deleteFinanceGrabReconciliation(id: string) {
  const { error } = await requireClient().from("finance_grab_reconciliations").delete().eq("id", id);
  if (error) throw supabaseFailure(error, "Không thể xoá đối soát GRAB");
}

function platformOrderRows(records: FinancePlatformOrderRecord[]) {
  return records.map((record) => ({
    id: record.id,
    order_code: record.orderCode,
    order_date: record.orderDate,
    channel_name: record.channelName,
    reported_amount: record.reportedAmount,
    order_created_at: record.orderCreatedAt || null,
    paid_at: record.paidAt || null,
    goods_amount: record.goodsAmount,
    discount_amount: record.discountAmount,
    service_fee: record.serviceFee,
    delivery_fee: record.deliveryFee,
    tip_amount: record.tipAmount,
    refund_amount: record.refundAmount,
    payment_method: record.paymentMethod || null,
    service_type: record.serviceType || null,
    delivery_partner: record.deliveryPartner || null,
    status: record.status || null,
    source_file_name: record.sourceFileName || null,
    imported_at: record.importedAt || new Date().toISOString(),
  }));
}

export async function upsertFinancePlatformOrders(records: FinancePlatformOrderRecord[]) {
  if (!records.length) return [];
  const { data, error } = await requireClient().from("finance_platform_order_rows").upsert(platformOrderRows(records), {
    onConflict: "id",
  }).select("*");
  if (error) throw supabaseFailure(error, "Không thể lưu chi tiết đơn nền tảng");
  return (data || []).map((row) => platformOrderFromRow(row));
}

export async function replaceFinancePlatformOrderImport(meta: Omit<FinanceImportMeta, "dataType" | "importedAt">, records: FinancePlatformOrderRecord[]) {
  const { error } = await requireClient().rpc("replace_finance_platform_order_import", {
    p_file_name: meta.fileName,
    p_period_start: meta.periodStart,
    p_period_end: meta.periodEnd,
    p_rows: platformOrderRows(records),
  });
  if (error) throw supabaseFailure(error, "Không thể lưu danh sách hóa đơn nền tảng");
}

function revenueRpcRows(records: FinanceRevenueRecord[]) {
  return records.map((record) => ({
    id: record.id,
    report_date: record.date,
    total_orders: record.reported?.totalOrders || 0,
    cancelled_orders: record.reported?.cancelledOrders || 0,
    item_quantity: record.reported?.itemQuantity || record.cups,
    average_items_per_order: record.reported?.averageItemsPerOrder || 0,
    average_order_value: record.reported?.averageOrderValue || 0,
    goods_amount: record.reported?.goodsAmount || 0,
    cancelled_amount: record.reported?.cancelledAmount || 0,
    returned_amount: record.reported?.returnedAmount || 0,
    discount_amount: record.reported?.discountAmount || 0,
    tax_amount: record.reported?.taxAmount || 0,
    service_fee_before_tax: record.reported?.serviceFeeBeforeTax || 0,
    delivery_fee: record.reported?.deliveryFee || 0,
    partner_fee: record.reported?.partnerFee || 0,
    platform_tax_collected: record.reported?.platformTaxCollected || 0,
    tips: record.reported?.tips || 0,
    customer_debt: record.reported?.customerDebt || 0,
    actual_revenue: record.reported?.actualRevenue ?? record.storeRevenue,
    sales: record.reported?.sales ?? record.storeRevenue,
  }));
}

function productRpcRows(records: FinanceProductRecord[]) {
  return records.map((record) => ({
    id: record.id,
    source_row: record.sourceRow,
    category_name: record.category,
    sku: record.sku,
    product_name: record.name,
    variant_name: record.variant,
    selling_price: record.sellingPrice,
    unit_name: record.unit,
    quantity: record.quantity,
    weight: record.weight,
    usage_time: record.usageTime,
    quantity_ratio: record.quantityRatio,
    goods_amount: record.goodsAmount,
    goods_ratio: record.goodsRatio,
    discount_amount: record.discountAmount,
    amount_after_discount: record.amountAfterDiscount,
    tax_amount: record.taxAmount,
    total_amount: record.totalAmount,
  }));
}

function serviceRpcRows(records: FinanceServiceRecord[]) {
  return records.map((record) => ({
    id: record.id,
    source_row: record.sourceRow,
    service_name: record.serviceName,
    total_orders: record.totalOrders,
    cancelled_orders: record.cancelledOrders,
    revenue: record.revenue,
  }));
}

export async function replaceFinanceRevenueImport(meta: Omit<FinanceImportMeta, "dataType" | "importedAt">, records: FinanceRevenueRecord[]) {
  const { error } = await requireClient().rpc("replace_finance_revenue_import", {
    p_file_name: meta.fileName,
    p_period_start: meta.periodStart,
    p_period_end: meta.periodEnd,
    p_rows: revenueRpcRows(records),
  });
  if (error) throw supabaseFailure(error, "Không thể lưu báo cáo doanh thu");
}

export async function replaceFinanceProductImport(meta: Omit<FinanceImportMeta, "dataType" | "importedAt">, records: FinanceProductRecord[]) {
  const { error } = await requireClient().rpc("replace_finance_product_import", {
    p_file_name: meta.fileName,
    p_period_start: meta.periodStart,
    p_period_end: meta.periodEnd,
    p_rows: productRpcRows(records),
  });
  if (error) throw supabaseFailure(error, "Không thể lưu báo cáo mặt hàng");
}

export async function replaceFinanceImportBundle(bundle: {
  revenue?: { meta: Omit<FinanceImportMeta, "dataType" | "importedAt">; records: FinanceRevenueRecord[] };
  products?: { meta: Omit<FinanceImportMeta, "dataType" | "importedAt">; records: FinanceProductRecord[] };
  service?: { meta: Omit<FinanceImportMeta, "dataType" | "importedAt">; records: FinanceServiceRecord[] };
}) {
  const { error } = await requireClient().rpc("replace_finance_import_bundle", {
    p_revenue_file_name: bundle.revenue?.meta.fileName ?? null,
    p_revenue_period_start: bundle.revenue?.meta.periodStart ?? null,
    p_revenue_period_end: bundle.revenue?.meta.periodEnd ?? null,
    p_revenue_rows: bundle.revenue ? revenueRpcRows(bundle.revenue.records) : null,
    p_products_file_name: bundle.products?.meta.fileName ?? null,
    p_products_period_start: bundle.products?.meta.periodStart ?? null,
    p_products_period_end: bundle.products?.meta.periodEnd ?? null,
    p_products_rows: bundle.products ? productRpcRows(bundle.products.records) : null,
    p_service_file_name: bundle.service?.meta.fileName ?? null,
    p_service_period_start: bundle.service?.meta.periodStart ?? null,
    p_service_period_end: bundle.service?.meta.periodEnd ?? null,
    p_service_rows: bundle.service ? serviceRpcRows(bundle.service.records) : null,
  });
  if (error) throw supabaseFailure(error, "Không thể lưu bộ file tài chính");
}

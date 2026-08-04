import { supabase } from "@/lib/supabase";

export type FinanceImportType = "revenue" | "products" | "service";

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

export type FinanceCloudState = {
  revenues: FinanceRevenueRecord[];
  products: FinanceProductRecord[];
  services: FinanceServiceRecord[];
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

export async function loadFinanceImports(): Promise<FinanceCloudState> {
  const client = requireClient();
  const [importsResult, revenueResult, productsResult, servicesResult] = await Promise.all([
    client.from("finance_imports").select("*").order("imported_at", { ascending: false }),
    client.from("finance_revenue_rows").select("*").order("report_date", { ascending: false }),
    client.from("finance_product_rows").select("*").order("source_row", { ascending: true }),
    client.from("finance_service_rows").select("*").order("source_row", { ascending: true }),
  ]);
  if (importsResult.error) throw importsResult.error;
  if (revenueResult.error) throw revenueResult.error;
  if (productsResult.error) throw productsResult.error;
  if (servicesResult.error) throw servicesResult.error;

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

  return { revenues, products, services, imports };
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
  if (error) throw error;
}

export async function replaceFinanceProductImport(meta: Omit<FinanceImportMeta, "dataType" | "importedAt">, records: FinanceProductRecord[]) {
  const { error } = await requireClient().rpc("replace_finance_product_import", {
    p_file_name: meta.fileName,
    p_period_start: meta.periodStart,
    p_period_end: meta.periodEnd,
    p_rows: productRpcRows(records),
  });
  if (error) throw error;
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
  if (error) throw error;
}

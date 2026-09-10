// Parser for GrabFood's "Báo cáo kinh doanh hàng ngày" PDF (daily merchant
// settlement report). The PDF is text-based; pdf.js gives us the text items in
// content-stream order, which reads as one long line per report section. All
// amounts are VND with "." as the thousands separator; deductions are negative.
//
// Two sections matter:
// - "Đơn hàng từ ứng dụng và web": one row per order with the full deduction
//   chain (Trị giá → KM người bán → chiết khấu Grab → thuế GTGT/TNCN → tài trợ
//   ship → Thu nhập). This is the ground truth for đối soát.
// - "Marketing": ad spend lines (Automatic Keywords, đồng tài trợ...) charged
//   at day level, not per order.

export type GrabReportOrder = {
  /// Delivery time as "HH:mm" 24h.
  time: string;
  /// Canonical short code, e.g. "GF-059". The PDF splits it as "GF- 059".
  code: string;
  paymentMethod: string;
  /// All magnitudes positive; signs are implied by the field meaning.
  orderValue: number;
  vat: number;
  storeServiceFee: number;
  merchantPromo: number;
  grabCommission: number;
  vatTax: number;
  incomeTax: number;
  shippingSupport: number;
  payout: number;
  /// True when the deduction chain reproduces the payout within rounding.
  balanced: boolean;
};

export type GrabReportMarketingLine = { time: string; description: string; fee: number; tax: number; total: number };

/// Which sàn produced a settlement report. Keys match `marketplaceKey` in the
/// finance module so a report only ever matches SAPO orders of its own channel.
export type SanPlatform = "grab" | "shopee" | "greensm";

export type ParsedGrabReport = {
  /// Absent means "grab" — the original producer of this shape.
  platform?: SanPlatform;
  /// ISO yyyy-mm-dd from the report header.
  reportDate: string;
  storeName?: string;
  orders: GrabReportOrder[];
  marketing: GrabReportMarketingLine[];
  totalOrderValue: number;
  totalPayout: number;
  /// Positive magnitude of the day's marketing spend (fee + tax).
  totalMarketing: number;
  /// totalPayout - totalMarketing, mirrors the report's "Tổng thu nhập".
  netIncome: number;
};

const NUMBER_TOKEN = "(?:-?\\d[\\d.]*|-)";

function parseAmount(token: string) {
  if (token === "-") return 0;
  const value = Number(token.replace(/\./g, ""));
  return Number.isFinite(value) ? value : 0;
}

function to24h(hour: number, minute: number, meridiem: string) {
  let h = hour % 12;
  if (meridiem.toUpperCase() === "PM") h += 12;
  return `${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function parseGrabReportText(rawText: string): ParsedGrabReport {
  const text = rawText.normalize("NFC").replace(/\s+/g, " ").trim();

  const dateMatch = text.match(/(\d{1,2})\s*tháng\s*(\d{1,2})\s*(\d{4})/);
  if (!dateMatch) throw new Error("Không tìm thấy ngày báo cáo trong PDF. File có đúng là Báo cáo kinh doanh hàng ngày của Grab?");
  const reportDate = `${dateMatch[3]}-${String(Number(dateMatch[2])).padStart(2, "0")}-${String(Number(dateMatch[1])).padStart(2, "0")}`;

  const storeMatch = text.match(/\+\d{9,}\s+(.+?)\s+Tóm tắt/);

  // Per-order rows: time, split short code, payment text, then exactly nine
  // amount tokens ("-" means not applicable → 0).
  const orderPattern = new RegExp(
    `(\\d{1,2}):(\\d{2})\\s*(AM|PM)\\s+([A-Z]{1,4})-?\\s*(\\d{2,6})\\s+(.*?)\\s+${`(${NUMBER_TOKEN})\\s+`.repeat(8)}(-?\\d[\\d.]*)`,
    "g",
  );
  const orders: GrabReportOrder[] = [];
  for (const match of text.matchAll(orderPattern)) {
    const [, hour, minute, meridiem, codeLetters, codeDigits, payment, ...amounts] = match;
    const signed = amounts.map(parseAmount);
    const [orderValue, vat, storeServiceFee, merchantPromo, grabCommission, vatTax, incomeTax, shippingSupport, payout] = signed;
    const balanced = Math.abs(orderValue + vat + storeServiceFee + merchantPromo + grabCommission + vatTax + incomeTax + shippingSupport - payout) <= 2;
    orders.push({
      time: to24h(Number(hour), Number(minute), meridiem),
      code: `${codeLetters}-${codeDigits}`,
      paymentMethod: payment.trim(),
      orderValue,
      vat,
      storeServiceFee: Math.abs(storeServiceFee),
      merchantPromo: Math.abs(merchantPromo),
      grabCommission: Math.abs(grabCommission),
      vatTax: Math.abs(vatTax),
      incomeTax: Math.abs(incomeTax),
      shippingSupport: Math.abs(shippingSupport),
      payout,
      balanced,
    });
  }

  // Marketing section sits between the "Marketing" header and the glossary.
  const marketing: GrabReportMarketingLine[] = [];
  const marketingStart = text.indexOf(" Marketing ");
  if (marketingStart >= 0) {
    const glossaryStart = text.indexOf("Hướng dẫn đọc hiểu", marketingStart);
    const section = text.slice(marketingStart, glossaryStart > marketingStart ? glossaryStart : undefined);
    // One chunk per "26 Th08, 9:18 PM" prefix; the description itself contains
    // dates and hyphens, so amounts are anchored to the END of each chunk.
    const chunks = section.split(/(?=\d{1,2}\s*Th\d{1,2},\s*\d{1,2}:\d{2}\s*(?:AM|PM))/).slice(1);
    for (let chunk of chunks) {
      chunk = chunk.replace(/\s*VND\s*-?[\d.]+\s*$/, "").trim();
      const prefix = chunk.match(/^\d{1,2}\s*Th\d{1,2},\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s+/);
      if (!prefix) continue;
      const rest = chunk.slice(prefix[0].length);
      const tail = rest.match(/(-?\d[\d.]*)\s+(-?\d[\d.]*)\s+(-?\d[\d.]*)\s*$/);
      if (!tail) continue;
      const description = rest.slice(0, tail.index).replace(/^-\s+/, "").trim();
      marketing.push({
        time: to24h(Number(prefix[1]), Number(prefix[2]), prefix[3]),
        description,
        fee: Math.abs(parseAmount(tail[1])),
        tax: Math.abs(parseAmount(tail[2])),
        total: Math.abs(parseAmount(tail[3])),
      });
    }
  }

  // A day Grab sold nothing still gets a report ("0 đơn hàng", every total 0).
  // That is a valid empty day, not a parse failure — throwing here made 17 real
  // reports look broken.


  const totalOrderValue = orders.reduce((sum, order) => sum + order.orderValue, 0);
  const totalPayout = orders.reduce((sum, order) => sum + order.payout, 0);
  const totalMarketing = marketing.reduce((sum, line) => sum + line.total, 0);
  return {
    reportDate,
    storeName: storeMatch?.[1],
    orders,
    marketing,
    totalOrderValue,
    totalPayout,
    totalMarketing,
    netIncome: totalPayout - totalMarketing,
  };
}

/// Browser-side text extraction. The worker file is a copy of the installed
/// pdfjs-dist build placed in public/pdf-worker/ — re-copy it whenever the
/// package version changes or pdf.js refuses to start.
export async function extractGrabPdfText(data: ArrayBuffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf-worker/pdf.worker.min.mjs";
  const loadingTask = pdfjs.getDocument({ data });
  const document = await loadingTask.promise;
  try {
    let text = "";
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      text += content.items.map((item) => ("str" in item ? item.str : "")).join(" ") + " ";
    }
    return text;
  } finally {
    await loadingTask.destroy();
  }
}

// ---------------------------------------------------------------------------
// ShopeeFood & GreenSM daily settlement reports, normalised into the exact
// ParsedGrabReport shape so the whole matching/đối soát pipeline is reused
// as-is. Both formats are per-order tables whose deduction chain reproduces
// the payout to the đồng, verified on real samples (24/08, 06/09, 08/09 Shopee;
// 11/08, 24/08, 27/08 GreenSM).

/// Minimal CSV reader: handles quoted fields ("262,000") and the UTF-8 BOM.
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const push = () => { row.push(field); field = ""; };
  const endRow = () => { push(); if (row.some((cell) => cell.trim() !== "")) rows.push(row); row = []; };
  const source = text.replace(/^\ufeff/, "");
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") push();
    else if (char === "\n") endRow();
    else if (char !== "\r") field += char;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

function vnAmount(cell: unknown) {
  const value = Number(String(cell ?? "").replace(/[,.]/g, "").replace(/[^\d-]/g, ""));
  return Number.isFinite(value) ? value : 0;
}

/// dd/mm/yyyy or dd-mm-yyyy (with optional time) → ISO date + "HH:mm".
function vnTimestamp(cell: unknown): { date: string; time: string } | undefined {
  const match = String(cell ?? "").match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!match) return undefined;
  const date = `${match[3]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  const time = match[4] ? `${String(Number(match[4])).padStart(2, "0")}:${match[5]}` : "00:00";
  return { date, time };
}

function headerIndex(header: string[], wanted: string) {
  const fold = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();
  return header.findIndex((cell) => fold(cell).includes(fold(wanted)));
}

function finishSanReport(platform: SanPlatform, reportDate: string, orders: GrabReportOrder[], storeName?: string): ParsedGrabReport {
  const totalOrderValue = orders.reduce((sum, order) => sum + order.orderValue, 0);
  const totalPayout = orders.reduce((sum, order) => sum + order.payout, 0);
  // Neither platform bills day-level marketing in these reports — Shopee's file
  // has no ads section at all and GreenSM charges cofund inside the order row.
  return { platform, reportDate, storeName, orders, marketing: [], totalOrderValue, totalPayout, totalMarketing: 0, netIncome: totalPayout };
}

/// ShopeeFood "Shopeefood_Income_Details_Merchant_DD-MM-YYYY.csv" (mailed daily
/// from no-reply@shopeefood.vn; days without orders come with no attachment).
/// Columns: Mã Đơn Hàng · Thời gian hoàn thành/huỷ đơn · Giá trị đơn hàng ·
/// Khuyến mại từ quán · Phí dịch vụ · Phí vận chuyển trả cho quán · Chiết khấu ·
/// Thuế khấu trừ · Thực thu.  Identity: Thực thu = Giá trị − KM quán − Phí DV −
/// Chiết khấu − Thuế + Phí VC trả cho quán.
export function parseShopeeIncomeCsv(rawText: string, fileName?: string): ParsedGrabReport {
  const rows = csvRows(rawText.normalize("NFC"));
  const headerRow = rows.findIndex((row) => headerIndex(row, "Mã Đơn Hàng") >= 0);
  if (headerRow < 0) throw new Error(`${fileName || "CSV"}: không thấy cột Mã Đơn Hàng — có đúng là file Income Details của ShopeeFood?`);
  const header = rows[headerRow];
  const col = {
    code: headerIndex(header, "Mã Đơn Hàng"),
    store: headerIndex(header, "Tên cửa hàng"),
    time: headerIndex(header, "Thời gian hoàn thành"),
    value: headerIndex(header, "Giá trị đơn hàng"),
    promo: headerIndex(header, "Khuyến mại từ quán"),
    serviceFee: headerIndex(header, "Phí dịch vụ"),
    shipToShop: headerIndex(header, "Phí vận chuyển trả cho quán"),
    commission: headerIndex(header, "Chiết khấu"),
    tax: headerIndex(header, "Thuế khấu trừ"),
    payout: headerIndex(header, "Thực thu"),
  };
  const orders: GrabReportOrder[] = [];
  let reportDate = (fileName?.match(/(\d{2})-(\d{2})-(\d{4})/) || []).slice(1).reverse().join("-");
  let storeName: string | undefined;
  for (const row of rows.slice(headerRow + 1)) {
    const code = String(row[col.code] || "").trim();
    if (!code) continue;
    const stamp = vnTimestamp(row[col.time]);
    if (stamp && !reportDate) reportDate = stamp.date;
    if (!storeName && col.store >= 0) storeName = String(row[col.store] || "").trim() || undefined;
    const orderValue = vnAmount(row[col.value]);
    const merchantPromo = vnAmount(row[col.promo]);
    const serviceFee = vnAmount(row[col.serviceFee]);
    const commission = vnAmount(row[col.commission]) + serviceFee;
    const tax = vnAmount(row[col.tax]);
    // Shopee PAYS the shop its shipping share, the mirror image of Grab's
    // ship-support deduction — a negative deduction keeps the shared identity
    // payout = value − promo − commission − taxes − shippingSupport intact.
    const shippingSupport = -vnAmount(row[col.shipToShop]);
    const payout = vnAmount(row[col.payout]);
    orders.push({
      time: stamp?.time || "00:00",
      code,
      paymentMethod: "",
      orderValue,
      vat: 0,
      storeServiceFee: serviceFee,
      merchantPromo,
      grabCommission: commission,
      vatTax: tax,
      incomeTax: 0,
      shippingSupport,
      payout,
      balanced: Math.abs(orderValue - merchantPromo - commission - tax - shippingSupport - payout) <= 1,
    });
  }
  if (!reportDate) throw new Error(`${fileName || "CSV"}: không xác định được ngày báo cáo.`);
  return finishSanReport("shopee", reportDate, orders, storeName);
}

/// GreenSM "Revenue_Report_<store>_YYYYMMDD.xlsx", sheet "Detail Transactions"
/// (mailed from no-reply@greensm.com only on days with revenue). Chain per row:
/// Doanh thu ròng = Giá trị − (mọi giảm giá phía quán: KM quán + giảm món +
/// cofund) rồi Thực thu = ròng − Chiết khấu − VAT − PIT. merchantPromo is
/// therefore derived as Giá trị − Doanh thu ròng so the shared identity holds.
/// Takes the sheet as row arrays so this module stays free of the XLSX import.
export function parseGreenRevenueRows(rows: unknown[][], fileName?: string): ParsedGrabReport {
  const headerRow = rows.findIndex((row) => Array.isArray(row) && headerIndex(row.map(String), "Mã Đơn Hàng") >= 0);
  if (headerRow < 0) throw new Error(`${fileName || "xlsx"}: không thấy cột Mã Đơn Hàng — có đúng là Revenue Report của GreenSM?`);
  const header = rows[headerRow].map((cell) => String(cell ?? ""));
  const col = {
    shortCode: headerIndex(header, "Mã Rút Gọn"),
    code: headerIndex(header, "Mã Đơn Hàng"),
    store: headerIndex(header, "Tên cửa hàng"),
    time: headerIndex(header, "Thời gian hoàn thành"),
    status: headerIndex(header, "Trạng thái"),
    value: headerIndex(header, "Giá trị đơn hàng"),
    net: headerIndex(header, "Doanh thu ròng"),
    commission: headerIndex(header, "Chiết khấu"),
    vat: headerIndex(header, "VAT"),
    pit: headerIndex(header, "PIT"),
    payout: headerIndex(header, "Thực thu"),
  };
  const orders: GrabReportOrder[] = [];
  let reportDate = (fileName?.match(/(\d{4})(\d{2})(\d{2})/) || []).slice(1).join("-");
  let storeName: string | undefined;
  for (const raw of rows.slice(headerRow + 1)) {
    const row = (raw || []).map((cell) => (cell == null ? "" : String(cell)));
    const fullCode = String(row[col.code] || "").trim();
    if (!fullCode) continue;
    const status = col.status >= 0 ? row[col.status].toLowerCase() : "completed";
    if (status && !status.includes("complete")) continue;
    const stamp = vnTimestamp(row[col.time]);
    if (stamp && !reportDate) reportDate = stamp.date;
    if (!storeName && col.store >= 0) storeName = row[col.store].trim() || undefined;
    const orderValue = vnAmount(row[col.value]);
    const net = vnAmount(row[col.net]);
    const commission = vnAmount(row[col.commission]);
    const vat = vnAmount(row[col.vat]);
    const pit = vnAmount(row[col.pit]);
    const payout = vnAmount(row[col.payout]);
    const shortCode = col.shortCode >= 0 ? row[col.shortCode].trim() : "";
    orders.push({
      time: stamp?.time || "00:00",
      code: shortCode ? `XS-${shortCode}` : fullCode,
      paymentMethod: "",
      orderValue,
      vat: 0,
      storeServiceFee: 0,
      merchantPromo: orderValue - net,
      grabCommission: commission,
      vatTax: vat,
      incomeTax: pit,
      shippingSupport: 0,
      payout,
      balanced: Math.abs(net - commission - vat - pit - payout) <= 1,
    });
  }
  if (!reportDate) throw new Error(`${fileName || "xlsx"}: không xác định được ngày báo cáo.`);
  return finishSanReport("greensm", reportDate, orders, storeName);
}

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

export type ParsedGrabReport = {
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

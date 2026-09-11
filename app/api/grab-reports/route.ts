import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { parseGrabReportText, parseGreenRevenueRows, parseShopeeIncomeCsv, type ParsedGrabReport } from "@/lib/grab-report";

// Local-only bridge: reads the settlement reports that `npm run grab:uat`
// drops into the per-sàn report folders — Grab daily PDFs, ShopeeFood income
// CSVs, GreenSM revenue xlsx — so the browser can ingest all of them in one
// "Quét thư mục local" without a file picker. The folders live on Long's
// machine, never on Vercel, so the route refuses to run in a production build.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPORT_ROOT = path.join(process.cwd(), "..", "..", "Report");
const DEFAULT_REPORT_DIR = path.join(REPORT_ROOT, "Grab Report");

function grabDirectory() {
  return process.env.GRAB_REPORT_DIR ? path.resolve(process.env.GRAB_REPORT_DIR) : DEFAULT_REPORT_DIR;
}

async function extractPdfText(data: Buffer) {
  // The legacy build is the one that runs outside a browser; the default entry
  // expects DOM globals and throws under the Node runtime.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true });
  const document = await loadingTask.promise;
  try {
    let text = "";
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      text += content.items.map((item: unknown) => (item && typeof item === "object" && "str" in item ? String((item as { str: unknown }).str) : "")).join(" ") + " ";
    }
    return text;
  } finally {
    await loadingTask.destroy();
  }
}

async function parseGreenXlsx(buffer: Buffer, fileName: string) {
  const XLSX = await import("xlsx");
  // SAPO/GreenSM streaming zips make SheetJS console.error "Bad uncompressed
  // size" per entry while parsing fine; keep the server log readable.
  const original = console.error;
  console.error = (...args: unknown[]) => { if (typeof args[0] === "string" && args[0].startsWith("Bad uncompressed size")) return; original(...args); };
  let workbook: ReturnType<typeof XLSX.read>;
  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } finally {
    console.error = original;
  }
  const sheetName = workbook.SheetNames.find((name) => /detail/i.test(name)) || workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error("Không tìm thấy sheet dữ liệu.");
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: null });
  return parseGreenRevenueRows(rows, fileName);
}

type SourceConfig = {
  dir: string;
  extension: string;
  parse: (buffer: Buffer, fileName: string) => Promise<ParsedGrabReport> | ParsedGrabReport;
};

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Chỉ dùng được khi chạy local/UAT." }, { status: 403 });
  }
  const sources: SourceConfig[] = [
    { dir: grabDirectory(), extension: ".pdf", parse: async (buffer) => parseGrabReportText(await extractPdfText(buffer)) },
    { dir: path.join(REPORT_ROOT, "Shopee Report"), extension: ".csv", parse: (buffer, fileName) => parseShopeeIncomeCsv(buffer.toString("utf8"), fileName) },
    { dir: path.join(REPORT_ROOT, "GreenSM Report"), extension: ".xlsx", parse: (buffer, fileName) => parseGreenXlsx(buffer, fileName) },
  ];

  const reports: (ParsedGrabReport & { fileName: string })[] = [];
  const failures: { fileName: string; message: string }[] = [];
  let anyDirectory = false;
  for (const source of sources) {
    let fileNames: string[];
    try {
      fileNames = (await readdir(source.dir)).filter((name) => name.toLowerCase().endsWith(source.extension)).sort();
      anyDirectory = true;
    } catch {
      // A sàn whose folder does not exist yet simply contributes nothing.
      continue;
    }
    for (const fileName of fileNames) {
      try {
        const buffer = await readFile(path.join(source.dir, fileName));
        reports.push({ ...(await source.parse(buffer, fileName)), fileName });
      } catch (error) {
        // One unreadable file must not hide the rest of the folders.
        failures.push({ fileName, message: error instanceof Error ? error.message : "Không đọc được file." });
      }
    }
  }
  if (!anyDirectory) {
    const directory = grabDirectory();
    return NextResponse.json({ directory, reports: [], failures: [], error: `Không mở được thư mục ${directory}. Chạy \`npm run grab:uat\` hoặc đặt biến GRAB_REPORT_DIR.` }, { status: 404 });
  }
  reports.sort((left, right) => left.reportDate.localeCompare(right.reportDate));
  return NextResponse.json({ directory: grabDirectory(), reports, failures });
}

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { parseGrabReportText, type ParsedGrabReport } from "@/lib/grab-report";

// Local-only bridge: reads the Grab daily PDFs that `npm run grab:fetch` drops
// into the report folder, so the browser can ingest them without a file picker.
// The folder lives on Long's machine, never on Vercel, so the route refuses to
// run in a production build.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_REPORT_DIR = path.join(process.cwd(), "..", "..", "Report", "Grab Report");

function reportDirectory() {
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

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Chỉ dùng được khi chạy local/UAT." }, { status: 403 });
  }
  const directory = reportDirectory();
  let fileNames: string[];
  try {
    fileNames = (await readdir(directory)).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
  } catch {
    return NextResponse.json({ directory, reports: [], failures: [], error: `Không mở được thư mục ${directory}. Chạy \`npm run grab:fetch\` hoặc đặt biến GRAB_REPORT_DIR.` }, { status: 404 });
  }

  const reports: (ParsedGrabReport & { fileName: string })[] = [];
  const failures: { fileName: string; message: string }[] = [];
  for (const fileName of fileNames) {
    try {
      const buffer = await readFile(path.join(directory, fileName));
      reports.push({ ...parseGrabReportText(await extractPdfText(buffer)), fileName });
    } catch (error) {
      // One unreadable PDF must not hide the rest of the folder.
      failures.push({ fileName, message: error instanceof Error ? error.message : "Không đọc được file." });
    }
  }
  reports.sort((left, right) => left.reportDate.localeCompare(right.reportDate));
  return NextResponse.json({ directory, reports, failures });
}

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

// Local-only sibling of /api/grab-reports: hands the browser the NEWEST file of
// each SAPO export kind so one press of "Quét thư mục local" can feed the whole
// three-file bundle through the exact same import path as a manual upload. The
// folders live on Long's machine, never on Vercel, hence the production refusal.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPORT_ROOT = path.join(process.cwd(), "..", "..", "Report");

// Canonical folders (one per export kind) with the Report root kept as a
// legacy fallback for files that predate the tidy-up.
const KINDS = [
  { key: "revenue", dirs: [path.join(REPORT_ROOT, "Doanh thu tổng quan"), REPORT_ROOT], pattern: /^doanh-thu-tong-quan.*\.xlsx?$/i },
  { key: "orders", dirs: [path.join(REPORT_ROOT, "Danh sách hoá đơn"), REPORT_ROOT], pattern: /^(danh_sach_hoa_don|danh-sach-hoa-don).*\.xlsx$/i },
  { key: "prices", dirs: [path.join(REPORT_ROOT, "Danh mục mặt hàng")], pattern: /^(danh_muc_mat_hang|danh-muc-mat-hang).*\.xlsx$/i },
];

async function newestMatch(dir: string, pattern: RegExp) {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => pattern.test(name));
  } catch {
    return undefined;
  }
  let best: { name: string; mtime: number } | undefined;
  for (const name of names) {
    try {
      const info = await stat(path.join(dir, name));
      if (!best || info.mtimeMs > best.mtime) best = { name, mtime: info.mtimeMs };
    } catch {
      // A file disappearing mid-scan is not an error worth failing over.
    }
  }
  return best;
}

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Chỉ dùng được khi chạy local/UAT." }, { status: 403 });
  }
  const files: { kind: string; name: string; base64: string; mtime: string }[] = [];
  const missing: string[] = [];
  for (const kind of KINDS) {
    let best: { dir: string; name: string; mtime: number } | undefined;
    for (const dir of kind.dirs) {
      const candidate = await newestMatch(dir, kind.pattern);
      if (candidate && (!best || candidate.mtime > best.mtime)) best = { dir, ...candidate };
    }
    if (!best) {
      missing.push(kind.key);
      continue;
    }
    const buffer = await readFile(path.join(best.dir, best.name));
    files.push({ kind: kind.key, name: best.name, base64: buffer.toString("base64"), mtime: new Date(best.mtime).toISOString() });
  }
  return NextResponse.json({ files, missing });
}

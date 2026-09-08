// Shared layout + naming for every Sapo file that lands on disk, so the export
// script, the mail fetcher and the one-off migration all agree. Layout:
//
//   Report/Doanh thu tổng quan/  doanh-thu-tong-quan_2026-01-01_den_2027-01-01.xls
//   Report/Danh sách hoá đơn/    danh-sach-hoa-don_2026-09-08_1730.xlsx
//   Report/Danh mục mặt hàng/    danh-muc-mat-hang_2026-09-08_1730.xlsx
//
// Revenue files are named by the PERIOD they cover (that is what you filter
// by); the other two are snapshots, so they are named by WHEN they were
// exported. Sapo's own names (unix timestamp + uuid) survive nowhere — the
// uuid tells a human nothing.

import path from "node:path";
import { readdir, stat, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT_ROOT = path.join(here, "..", "..", "..", "Report");

export const SAPO_DIRS = {
  revenue: path.join(REPORT_ROOT, "Doanh thu tổng quan"),
  orders: path.join(REPORT_ROOT, "Danh sách hoá đơn"),
  prices: path.join(REPORT_ROOT, "Danh mục mặt hàng"),
};
export { REPORT_ROOT };

/// Which kind is this file? Accepts both Sapo's raw names and our canonical
/// ones, so re-sweeping an already-tidied folder is a no-op.
export function sapoKindOf(name) {
  if (/^(doanh-thu-tong-quan)/i.test(name) && /\.xlsx?$/i.test(name)) return "revenue";
  if (/^(danh_sach_hoa_don|danh-sach-hoa-don)/i.test(name) && /\.xlsx$/i.test(name)) return "orders";
  if (/^(danh_muc_mat_hang|danh-muc-mat-hang)/i.test(name) && /\.xlsx$/i.test(name)) return "prices";
  return undefined;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function stampDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function stampDateTime(date) {
  return `${stampDate(date)}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

/// Canonical, human-datable filename. `when` is the export moment (mail date or
/// file mtime); revenue ignores it because the period in Sapo's own name is the
/// better identity.
export function sapoCanonicalName(kind, originalName, when = new Date()) {
  const extension = originalName.toLowerCase().endsWith(".xlsx") ? ".xlsx" : ".xls";
  if (kind === "revenue") {
    // doanh-thu-tong-quan-2026-01-01T00_00_00-2027-01-01T00_00_00.xls
    const range = originalName.match(/(\d{4}-\d{2}-\d{2})T[\d_]+-(\d{4}-\d{2}-\d{2})T/);
    if (range) return `doanh-thu-tong-quan_${range[1]}_den_${range[2]}${extension}`;
    return `doanh-thu-tong-quan_${stampDate(when)}${extension}`;
  }
  // Sapo embeds a unix-seconds export timestamp in invoice names — more precise
  // than the mail date, so prefer it when present.
  const unix = originalName.match(/_(\d{10})(?:_|\.)/);
  const moment = unix ? new Date(Number(unix[1]) * 1000) : when;
  const base = kind === "orders" ? "danh-sach-hoa-don" : "danh-muc-mat-hang";
  return `${base}_${stampDateTime(moment)}${extension}`;
}

/// Long's retention rule: each Sapo folder holds exactly ONE file — the latest.
/// Every ingest pass calls this, so history never piles up. The newest invoice
/// export always spans the whole period anyway, and the dated archive
/// subfolders under Report/ are never touched.
export async function pruneSapoFolders(log = console.log) {
  let removed = 0;
  for (const [kind, dir] of Object.entries(SAPO_DIRS)) {
    let names;
    try {
      names = (await readdir(dir)).filter((name) => sapoKindOf(name) === kind);
    } catch {
      continue;
    }
    if (names.length <= 1) continue;
    const dated = [];
    for (const name of names) {
      try {
        dated.push({ name, mtime: (await stat(path.join(dir, name))).mtimeMs });
      } catch {
        // Vanished mid-scan — nothing to prune.
      }
    }
    dated.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
    for (const stale of dated.slice(1)) {
      try {
        await unlink(path.join(dir, stale.name));
        removed++;
        log(`   ✂ xoá bản cũ: ${path.basename(dir)}/${stale.name}`);
      } catch {
        // A locked file survives until the next pass.
      }
    }
    if (dated[0]) log(`   ✓ giữ lại: ${path.basename(dir)}/${dated[0].name}`);
  }
  return removed;
}

#!/usr/bin/env node
// Tải dữ liệu thô Quản Lý Tiếp Thị của Grab Merchant về `Report/Grab RAW data/`,
// đúng hành trình Long bấm tay:
//
//   Chiến dịch  : 180 ngày gần nhất (*) → Tải về → Tải về → CSV + Bao gồm tất cả các cột có sẵn → Campaign/
//   Khuyến mãi  : 12 tháng qua → Áp dụng → Tải về → PNG (Tóm tắt chỉ số + Biểu đồ)      → promo/
//   Từ khoá     : 3 tháng qua  → Áp dụng → Tải về → CSV + Bao gồm tất cả các cột có sẵn → keyword/
//
// (*) Long bấm "12 tháng qua", nhưng "Bao gồm tất cả các cột" kéo theo cột Hàng
//     giờ và Grab khoá nút tải ("dữ liệu hàng giờ giới hạn trong 6 tháng"). Quảng
//     cáo của quán bắt đầu 08/07/2026 nên 180 ngày vẫn chứa toàn bộ lịch sử ads
//     tới đầu 01/2027; khoảng này đặt qua tham số `st`/`et` của chính trang Grab.
//
//   npm run grab:raw                 # chạy ngầm (headless)
//   npm run grab:raw -- --headed     # hiện cửa sổ để xem nó bấm, khi gỡ lỗi
//   npm run grab:raw -- --login      # lần đầu / khi phiên hết hạn: mở cửa sổ, chờ Long đăng nhập tay (OTP)
//
// Grab Merchant đăng nhập bằng OTP nên không thể tự điền mật khẩu như SAPO. Phiên
// được giữ trong profile trình duyệt riêng `.grab-state/grab-merchant-profile`
// (gitignored); hết hạn thì chạy lại với --login.

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
const STATE_DIR = path.join(projectRoot, ".grab-state");
const PROFILE_DIR = path.join(STATE_DIR, "grab-merchant-profile");
const RAW_DIR = path.join(projectRoot, "..", "..", "Report", "Grab RAW data");
const MERCHANT = "https://merchant.grab.com";
// Link Marketing có thể đổi ID nhà quảng cáo — đọc lại từ chính trang Marketing,
// ID này chỉ là phương án cuối.
const FALLBACK_ADVERTISER_ID = "547376854891398048";

const REPORTS = [
  { key: "campaigns", label: "Chiến dịch", folder: "Campaign", days: 180, format: "CSV", allColumns: true },
  { key: "promo", label: "Khuyến mãi", folder: "promo", range: "12 tháng qua", format: "PNG", checkboxes: ["Tóm tắt chỉ số", "Biểu đồ với chế độ xem hiện tại"] },
  { key: "keywords", label: "Từ khoá", folder: "keyword", range: "3 tháng qua", format: "CSV", allColumns: true },
];

const loginMode = process.argv.includes("--login");
// Headed Chromium on this profile dies mid-download on Grab's exports (context
// closed, `.crdownload` stub left behind); headless finishes the same steps.
const headless = !loginMode && !process.argv.includes("--headed");
const DATE_RANGE = /^\d{2}\/\d{2}\/\d{4} - \d{2}\/\d{2}\/\d{4}$/;

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

async function failStep(page, step, error) {
  const shot = path.join(STATE_DIR, `grab-raw-error-${step}.png`);
  try { await page.screenshot({ path: shot, fullPage: true }); } catch { /* page may be gone */ }
  console.error(`\nLỗi ở bước "${step}": ${error?.message || error}`);
  console.error(`URL lúc lỗi: ${page.url()}`);
  console.error(`Ảnh chụp màn hình: ${shot}`);
}

/// Logged in = the marketing portal opens instead of bouncing to the public
/// /vn-vn landing page.
async function resolveAdvertiser(page) {
  await page.goto(`${MERCHANT}/dashboard`, { waitUntil: "domcontentloaded" });
  if (loginMode) {
    console.log("Đăng nhập Grab Merchant trong cửa sổ trình duyệt (tối đa 10 phút)...");
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline && !/merchant\.grab\.com\/(dashboard|marketing|food|store)/.test(page.url())) await page.waitForTimeout(3000);
  }
  await page.waitForTimeout(6000);
  await page.goto(`${MERCHANT}/marketing`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 20 && !/advertisers\/\d+/.test(page.url()); i += 1) await page.waitForTimeout(1000);
  if (/\/vn-vn\/?$|login|auth/.test(page.url())) throw new Error("Chưa đăng nhập hoặc phiên đã hết hạn — chạy lại: npm run grab:raw -- --login");
  return page.url().match(/advertisers\/(\d+)/)?.[1] || FALLBACK_ADVERTISER_ID;
}

async function applyPreset(page, dateButton, before, range) {
  await dateButton.click();
  await page.getByText(range, { exact: true }).click();
  await page.getByRole("button", { name: "Áp dụng", exact: true }).click();
  // The label is the only on-screen proof the filter took; a stale label means
  // the download would silently carry the default 7-day window.
  await page.waitForFunction(([pattern, old]) => [...document.querySelectorAll("div")].some((el) => el.children.length === 0 && new RegExp(pattern).test(el.innerText.trim()) && el.innerText.trim() !== old), [DATE_RANGE.source, before], { timeout: 20_000 }).catch(() => {});
  const after = (await page.getByText(DATE_RANGE).first().innerText()).trim();
  if (after === before && range !== "7 ngày qua") throw new Error(`Bộ lọc "${range}" không áp dụng (vẫn ${before})`);
  return after;
}

async function exportReport(page, advertiserId, report) {
  const url = `${MERCHANT}/marketing/advertisers/${advertiserId}/reports/${report.key}`;
  if (report.days) {
    // Grab keys the range on Vietnam midnight in ms; `et` is the START of the last day.
    const DAY = 86_400_000;
    const endDay = Math.floor((Date.now() + 7 * 3_600_000) / DAY) * DAY - 7 * 3_600_000;
    await page.goto(`${url}?st=${endDay - (report.days - 1) * DAY}&et=${endDay}`, { waitUntil: "domcontentloaded" });
  } else {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }
  const dateButton = page.getByText(DATE_RANGE).first();
  await dateButton.waitFor({ timeout: 45_000 });
  const before = (await dateButton.innerText()).trim();
  const after = report.days ? before : await applyPreset(page, dateButton, before, report.range);
  await page.waitForTimeout(4000);


  await page.getByRole("button", { name: /Tải về/ }).first().click();
  const dialog = page.locator("div").filter({ has: page.getByText("Chọn định dạng", { exact: true }) }).filter({ has: page.getByText("Chọn tùy chọn", { exact: true }) }).last();
  await dialog.waitFor({ timeout: 15_000 });
  await dialog.getByText(report.format, { exact: true }).click();
  if (report.allColumns) await dialog.getByText("Bao gồm tất cả các cột có sẵn", { exact: true }).click();
  const limit = dialog.getByText(/giới hạn trong/);
  if (await limit.isVisible().catch(() => false)) throw new Error(`Grab khoá nút tải: ${(await limit.innerText()).trim()}`);
  for (const caption of report.checkboxes || []) {
    const box = dialog.locator("label").filter({ hasText: caption }).locator("input[type=checkbox]");
    if (!(await box.isChecked())) await dialog.getByText(caption, { exact: true }).click();
  }
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 120_000 }),
    dialog.getByRole("button", { name: "Tải về", exact: true }).click(),
  ]);

  const folder = path.join(RAW_DIR, report.folder);
  await mkdir(folder, { recursive: true });
  const range = after.replace(/\//g, "-").replace(/\s+/g, "");
  const target = path.join(folder, `${today()}_${report.key}_${range}${path.extname(download.suggestedFilename()) || (report.format === "PNG" ? ".png" : ".csv")}`);
  // CSV exports arrive as a presigned S3 link, and Chromium tears the whole
  // context down mid-download (a `.crdownload` stub is all that remains). The
  // link needs no cookies, so Node fetches it and the browser copy is dropped.
  if (download.url().startsWith("data:")) {
    // The PNG is rendered in the page and handed over as a data: URL.
    await writeFile(target, Buffer.from(download.url().slice(download.url().indexOf(",") + 1), "base64"));
  } else if (/^https?:/.test(download.url())) {
    const link = download.url();
    await download.cancel().catch(() => {});
    const response = await fetch(link);
    if (!response.ok) throw new Error(`Tải link S3 thất bại: HTTP ${response.status}`);
    await writeFile(target, Buffer.from(await response.arrayBuffer()));
  } else {
    await download.saveAs(target);
  }
  return { target, range: after };
}

/// One browser per report: a crashed download takes the whole context with it,
/// and must not cost the reports that come after it.
async function withBrowser(step, work) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, { headless, acceptDownloads: true, viewport: { width: 1440, height: 900 }, locale: "vi-VN" });
  const page = context.pages()[0] || await context.newPage();
  try {
    return await work(page);
  } catch (error) {
    await failStep(page, step, error);
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

await mkdir(STATE_DIR, { recursive: true });
let failed = false;
let advertiserId;
try {
  advertiserId = await withBrowser("dang-nhap", resolveAdvertiser);
} catch {
  process.exit(1);
}
// Chromium dies at random around Grab's downloads (seen on both the CSV and
// the PNG export), so each report gets three fresh browsers before it counts
// as failed.
for (const report of REPORTS) {
  let done = false;
  for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
    try {
      const { target, range } = await withBrowser(report.key, async (page) => {
        await page.goto(`${MERCHANT}/dashboard`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(5000);
        return exportReport(page, advertiserId, report);
      });
      console.log(`✓ ${report.label} (${range}) → ${path.relative(path.join(projectRoot, "..", ".."), target)}`);
      done = true;
    } catch {
      if (attempt < 3) console.error(`↻ ${report.label}: thử lại lần ${attempt + 1}`);
    }
  }
  if (!done) failed = true;
}
process.exit(failed ? 1 : 0);

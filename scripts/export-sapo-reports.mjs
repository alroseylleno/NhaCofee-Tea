#!/usr/bin/env node
// Drives Sapo's admin with a real browser and presses the three export buttons
// Long used to press by hand. Journeys, exactly as he described them:
//
//   1. /admin/reports-revenue : Doanh thu tổng quan → năm nay → Xem báo cáo →
//      Xuất báo cáo → the .xls downloads directly → saved into Report/
//   2. /admin/orders   : Xuất hoá đơn → file xuất theo danh sách mặt hàng →
//      tất cả hoá đơn → Xuất file → arrives by email (link, not attachment)
//   3. /admin/products : Xuất danh sách → tất cả mặt hàng → xuất danh sách
//      mặt hàng → arrives by email
//
// After 2–3, run `node scripts/fetch-sapo-reports.mjs --wait 300` (or just
// `npm run sapo:daily`) to harvest the emails into the local folders.
//
//   npm run sapo:export              # headless
//   npm run sapo:export -- --headed  # watch it click, for debugging selectors
//
// .env.local needs SAPO_EMAIL / SAPO_PASSWORD (npm run grab:setup asks for
// them). The logged-in session is kept in .grab-state/sapo-session.json so the
// password is only replayed when the session expires — Sapo has no OTP, so an
// expired session never blocks an unattended run.

import { chromium } from "playwright";
import { SAPO_DIRS, sapoCanonicalName, sapoKindOf } from "./sapo-files.mjs";
import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
const STATE_DIR = path.join(projectRoot, ".grab-state");
const SESSION_FILE = path.join(STATE_DIR, "sapo-session.json");
const REPORT_DIR = path.join(projectRoot, "..", "..", "Report");
const ADMIN = "https://fnb.mysapo.vn/admin";

async function loadEnvLocal() {
  try {
    const raw = await readFile(path.join(projectRoot, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // Real environment variables are an acceptable source too.
  }
}

const headed = process.argv.includes("--headed");

/// One screenshot per failed step; without it a selector drift in a headless
/// run is undebuggable.
async function failStep(page, step, error) {
  await mkdir(STATE_DIR, { recursive: true });
  const shot = path.join(STATE_DIR, `sapo-error-${step}.png`);
  try { await page.screenshot({ path: shot, fullPage: true }); } catch { /* page may be gone */ }
  console.error(`\nLỗi ở bước "${step}": ${error?.message || error}`);
  console.error(`URL lúc lỗi: ${page.url()}`);
  console.error(`Ảnh chụp màn hình: ${shot}`);
  console.error(`Chạy lại với --headed để nhìn trực tiếp: npm run sapo:export -- --headed`);
  process.exit(1);
}

/// Click helper that tries several ways to find a Vietnamese-labelled control,
/// because Sapo mixes buttons, links and spans for the same visual affordance.
async function clickLabel(page, labels, { timeout = 15_000 } = {}) {
  const list = Array.isArray(labels) ? labels : [labels];
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    for (const label of list) {
      for (const locator of [
        page.getByRole("button", { name: label }),
        page.getByRole("link", { name: label }),
        page.getByText(label, { exact: true }),
        page.getByText(label),
      ]) {
        try {
          const target = locator.first();
          if (await target.isVisible({ timeout: 400 })) {
            await target.click({ timeout: 2_000 });
            return label;
          }
        } catch (error) {
          lastError = error;
        }
      }
    }
    await page.waitForTimeout(300);
  }
  throw lastError || new Error(`Không tìm thấy nút nào trong: ${list.join(" / ")}`);
}

function inAdmin(url) {
  return /mysapo\.vn\/admin/i.test(url) && !/authorization\/login/i.test(url);
}

async function isLoggedIn(page) {
  await page.goto(`${ADMIN}/reports-revenue`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_500);
  return inAdmin(page.url());
}

/// SSO makes login a little dance, not one submit: fnb's login page only has a
/// "Đăng nhập ngay với Sapo SSO" button; the credential form lives on the SSO
/// domain; and after authenticating there, fnb can bounce BACK to its login
/// page where the SSO button must be pressed a second time — that click now
/// passes straight through and finally lands in /admin. So this walks a small
/// state machine until the admin shell appears, logging each transition.
async function login(page) {
  const email = process.env.SAPO_EMAIL;
  const password = process.env.SAPO_PASSWORD;
  if (!email || !password) {
    console.error("Thiếu SAPO_EMAIL / SAPO_PASSWORD trong .env.local. Chạy: npm run grab:setup");
    process.exit(1);
  }
  console.log("Phiên hết hạn — đăng nhập lại…");
  // Sapo's own frontend crashes on a 401 and renders NO error message, so the
  // form just sits there looking innocent. Watching the login POST directly is
  // the only honest signal of what the server actually said.
  let loginRejection = "";
  page.on("response", async (response) => {
    if (/accounts\.sapo\.vn\/login/.test(response.url()) && response.request().method() === "POST" && response.status() >= 400) {
      try {
        const body = JSON.parse(await response.text());
        loginRejection = body?.message || `HTTP ${response.status()}`;
      } catch {
        loginRejection = `HTTP ${response.status()}`;
      }
    }
  });
  let filledCredentials = false;
  let submitAttempts = 0;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (inAdmin(url)) {
      console.log("→ đã vào admin.");
      return;
    }
    const ssoButton = page.getByText("Đăng nhập ngay với Sapo SSO").first();
    if (await ssoButton.isVisible({ timeout: 1_000 }).catch(() => false)) {
      console.log(`→ bấm nút SSO${filledCredentials ? " (lần hai — đổi phiên SSO lấy phiên admin)" : ""}…`);
      await ssoButton.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
      continue;
    }
    const passwordBox = page.locator('input[type="password"]').first();
    if (await passwordBox.isVisible({ timeout: 1_000 }).catch(() => false)) {
      if (!filledCredentials) {
        console.log("→ điền email + mật khẩu trên trang SSO…");
        const emailBox = page.locator('input[type="email"], input[name*="mail" i], input[name*="user" i], input[name*="phone" i], input[type="text"], input[type="tel"]').first();
        await emailBox.fill(email);
        await passwordBox.fill(password);
        filledCredentials = true;
      }
      if (loginRejection) {
        throw new Error(`Sapo từ chối đăng nhập: "${loginRejection}". Nếu Long vẫn đăng nhập Sapo bằng Google/Facebook thì tài khoản CHƯA có mật khẩu Sapo riêng — đặt qua "Quên mật khẩu" trên accounts.sapo.vn rồi chạy npm run grab:setup lưu lại.`);
      }
      if (submitAttempts >= 2) {
        throw new Error("Đã bấm Đăng nhập 2 lần mà form vẫn còn và server không phản hồi lỗi — chạy --headed để nhìn trực tiếp.");
      }
      // Enter does not fire Sapo's JS-only submit button, so click it by name;
      // Enter stays as the fallback for form variants that do submit on it.
      submitAttempts++;
      console.log(`→ bấm nút Đăng nhập (lần ${submitAttempts})…`);
      const submitButton = page.getByRole("button", { name: /^Đăng nhập$/ }).first();
      if (await submitButton.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await submitButton.click().catch(() => {});
      } else {
        await passwordBox.press("Enter").catch(() => {});
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(3_000);
      continue;
    }
    // A store/tenant picker can appear between SSO and admin; pick the one
    // matching SAPO_STORE, else the first store card on offer.
    const storeHint = process.env.SAPO_STORE || "Hàn Hải Nguyên";
    const storeChoice = page.getByText(storeHint).first();
    if (await storeChoice.isVisible({ timeout: 1_000 }).catch(() => false)) {
      console.log(`→ chọn cửa hàng "${storeHint}"…`);
      await storeChoice.click().catch(() => {});
      await page.waitForTimeout(2_500);
      continue;
    }
    await page.waitForTimeout(1_000);
  }
  if (!(await isLoggedIn(page))) throw new Error("Sau 90s vẫn chưa vào được admin — xem screenshot để biết đang kẹt ở màn nào.");
  console.log("→ đã vào admin.");
}

async function exportRevenue(page) {
  console.log("\n[1/3] Doanh thu tổng quan…");
  await page.goto(`${ADMIN}/reports-revenue`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_500);
  // The report type may already default to "Doanh thu tổng quan"; select it
  // only when the option is visible so a pre-selected state does not fail.
  try { await clickLabel(page, "Doanh thu tổng quan", { timeout: 4_000 }); } catch { /* already selected */ }
  // The date filter is a picker that must be OPENED first. Its trigger shows
  // whatever range is active ("Hôm nay", "Tháng này", "dd/mm/yyyy - …"), so
  // try the known presets and a date-looking chip before giving up.
  let rangeSet = false;
  const openerLabels = ["Hôm nay", "Hôm qua", "7 ngày qua", "Tháng này", "Tháng trước", "Thời gian"];
  for (const opener of [...openerLabels, null]) {
    try {
      if (opener) await clickLabel(page, opener, { timeout: 2_000 });
      else {
        // Last resort: a chip that displays an explicit dd/mm/yyyy range.
        const chip = page.locator("text=/\\d{2}\\/\\d{2}\\/\\d{4}/").first();
        if (!(await chip.isVisible({ timeout: 1_500 }).catch(() => false))) continue;
        await chip.click();
      }
      await page.waitForTimeout(800);
      await clickLabel(page, ["Năm nay", "Năm này"], { timeout: 3_000 });
      rangeSet = true;
      break;
    } catch {
      // Try the next opener candidate.
    }
  }
  if (!rangeSet) {
    await page.screenshot({ path: path.join(STATE_DIR, "sapo-note-timefilter.png"), fullPage: true }).catch(() => {});
    console.log("   (chưa đổi được bộ lọc thời gian — dùng khoảng đang chọn; gửi .grab-state/sapo-note-timefilter.png để chỉnh selector)");
  } else {
    console.log("   ✓ chọn thời gian: Năm nay");
  }
  await clickLabel(page, ["Xem báo cáo"]);
  await page.waitForTimeout(3_000);
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await clickLabel(page, ["Xuất báo cáo", "Xuất Excel", "Xuất file"]);
  // A confirm pop-up repeats the same button; the export only fires on the
  // second press, inside the dialog.
  await page.waitForTimeout(1_200);
  try {
    const confirm = page.locator('[role="dialog"], .modal, [class*="modal" i], [class*="popup" i]').locator("text=/Xuất báo cáo|Xuất file|Xuất/").last();
    if (await confirm.isVisible({ timeout: 3_000 })) {
      console.log("   ✓ xác nhận trong pop-up");
      await confirm.click();
    }
  } catch {
    // No dialog appeared — some tenants export on the first press.
  }
  const download = await downloadPromise;
  await mkdir(SAPO_DIRS.revenue, { recursive: true });
  const suggested = download.suggestedFilename() || `doanh-thu-tong-quan-${Date.now()}.xls`;
  const named = sapoCanonicalName("revenue", suggested);
  await download.saveAs(path.join(SAPO_DIRS.revenue, named));
  console.log(`   ↓ đã lưu "Doanh thu tổng quan/${named}"`);
  return named;
}

/// Radio options in Sapo's export dialogs do not toggle when their caption text
/// is clicked, so target the radio role itself and VERIFY it ended up checked —
/// a silent miss here would quietly export "trang hiện tại" (50 rows) instead
/// of everything.
async function chooseRadio(page, variants) {
  for (const variant of variants) {
    // 1) The native input is CSS-hidden behind a styled dot, so force the
    //    check instead of waiting for visibility that never comes.
    const radio = page.getByRole("radio", { name: variant }).first();
    try {
      await radio.check({ timeout: 1_500, force: true });
      if (await radio.isChecked()) return variant;
    } catch {
      // Fall through to the caption click.
    }
    // 2) Clicking the caption text toggles these dialogs (verified on the
    //    invoice export); confirm through the DOM where possible.
    const caption = page.getByText(variant, { exact: true }).first();
    if (await caption.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await caption.click().catch(() => {});
      await page.waitForTimeout(400);
      const checked = await caption.evaluate((node) => {
        const row = node.closest("label, li, [class*='radio' i], div");
        const input = row?.querySelector('input[type="radio"]') || row?.parentElement?.querySelector('input[type="radio"]');
        return input ? input.checked : null;
      }).catch(() => null);
      // true = verified; null = unverifiable markup — accept the click.
      if (checked !== false) return variant;
    }
  }
  throw new Error(`Không chọn được radio: ${variants.join(" / ")}`);
}

async function exportInvoices(page) {
  console.log("\n[2/3] Danh sách hoá đơn (xuất theo mặt hàng → email)…");
  await page.goto(`${ADMIN}/orders`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_000);
  await clickLabel(page, ["Xuất hóa đơn", "Xuất hoá đơn"]);
  await page.waitForTimeout(1_200);
  await chooseRadio(page, ["File xuất theo danh sách mặt hàng", "theo danh sách mặt hàng"]);
  console.log("   ✓ kiểu file: theo danh sách mặt hàng");
  await chooseRadio(page, ["Tất cả hóa đơn", "Tất cả hoá đơn"]);
  console.log("   ✓ phạm vi: tất cả hóa đơn");
  await clickLabel(page, ["Xuất File", "Xuất file"]);
  await page.waitForTimeout(2_000);
  console.log("   ✉ đã yêu cầu — Sapo sẽ gửi link về email");
}

async function exportProducts(page) {
  console.log("\n[3/3] Danh sách mặt hàng (bảng giá → email)…");
  await page.goto(`${ADMIN}/products`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_000);
  await clickLabel(page, ["Xuất danh sách", "Xuất file", "Xuất"]);
  await page.waitForTimeout(1_200);
  // Same dialog family as the invoice export: pick scope via radio, confirm.
  await chooseRadio(page, ["Tất cả mặt hàng", "Tất cả"]).then(
    () => console.log("   ✓ phạm vi: tất cả mặt hàng"),
    () => console.log("   (không thấy radio phạm vi — dùng lựa chọn mặc định)"),
  );
  await clickLabel(page, ["Xuất danh sách mặt hàng", "Xuất File", "Xuất file", "Xuất"]);
  await page.waitForTimeout(2_000);
  console.log("   ✉ đã yêu cầu — Sapo sẽ gửi link về email");
}

/// Consolidation net: any Sapo export sitting in ~/Downloads — from a manual
/// browser run or a headed session where Long pressed the confirm himself —
/// gets moved into the managed folders so the app scan always finds it.
async function sweepDownloadsFolder() {
  const downloadsDir = path.join(process.env.HOME || "", "Downloads");
  let moved = 0;
  let names;
  try {
    names = await readdir(downloadsDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const kind = sapoKindOf(name);
    if (!kind) continue;
    const source = path.join(downloadsDir, name);
    let when = new Date();
    try { when = (await stat(source)).mtime; } catch { /* keep now */ }
    const canonical = sapoCanonicalName(kind, name, when);
    await mkdir(SAPO_DIRS[kind], { recursive: true });
    const target = path.join(SAPO_DIRS[kind], canonical);
    if (existsSync(target)) continue;
    try {
      await rename(source, target);
      moved++;
      console.log(`   ⇢ gom từ Downloads: ${name} → ${path.basename(SAPO_DIRS[kind])}/${canonical}`);
    } catch {
      // A file mid-download or locked is left for the next sweep.
    }
  }
  return moved;
}

async function main() {
  await loadEnvLocal();
  await mkdir(STATE_DIR, { recursive: true });
  console.log(`Bắt đầu export Sapo (${headed ? "có giao diện" : "chạy ngầm — theo dõi bằng chính các dòng log này"}).`);
  const sweptBefore = await sweepDownloadsFolder();
  if (sweptBefore) console.log(`Đã gom ${sweptBefore} file Sapo còn sót trong Downloads.`);
  console.log(`Kết quả kiểm tra ở: ${REPORT_DIR} (file Doanh thu tải thẳng; Hoá đơn + Mặt hàng về email, chạy tiếp fetch để vớt).`);
  // The system Google Chrome is driven directly (channel: "chrome"), so no
  // Playwright browser download is needed — the CDN kept timing out here.
  const browser = await chromium.launch({ headless: !headed, channel: "chrome" });
  const context = await browser.newContext({
    ...(existsSync(SESSION_FILE) ? { storageState: SESSION_FILE } : {}),
    locale: "vi-VN",
  });
  const page = await context.newPage();
  let step = "mo-trang";
  try {
    if (!(await isLoggedIn(page))) {
      step = "dang-nhap";
      await login(page);
    }
    await context.storageState({ path: SESSION_FILE });

    step = "doanh-thu-tong-quan";
    await exportRevenue(page);
    step = "hoa-don";
    await exportInvoices(page);
    step = "mat-hang";
    await exportProducts(page);

    await context.storageState({ path: SESSION_FILE });
    const sweptAfter = await sweepDownloadsFolder();
    if (sweptAfter) console.log(`Đã gom thêm ${sweptAfter} file từ Downloads về Report/.`);
    console.log("\nXong. Bước tiếp: node scripts/fetch-sapo-reports.mjs --wait 300 (hoặc npm run sapo:daily làm trọn gói).");
  } catch (error) {
    await failStep(page, step, error);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error("Lỗi:", error?.message || error);
  process.exit(1);
});

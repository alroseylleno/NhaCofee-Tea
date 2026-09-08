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
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

async function isLoggedIn(page) {
  await page.goto(`${ADMIN}/reports-revenue`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(1_500);
  const url = page.url();
  return !/login|signin|dang-nhap|accounts?\./i.test(url);
}

async function login(page) {
  const email = process.env.SAPO_EMAIL;
  const password = process.env.SAPO_PASSWORD;
  if (!email || !password) {
    console.error("Thiếu SAPO_EMAIL / SAPO_PASSWORD trong .env.local. Chạy: npm run grab:setup");
    process.exit(1);
  }
  console.log("Phiên hết hạn — đăng nhập lại…");
  // Sapo FnB's login page carries no form of its own: the "Chủ cửa hàng" tab
  // shows one button, "Đăng nhập ngay với Sapo SSO", and the real email +
  // password form lives on the SSO page it redirects to.
  try {
    const ssoButton = page.getByText("Đăng nhập ngay với Sapo SSO").first();
    if (await ssoButton.isVisible({ timeout: 5_000 })) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 45_000 }).catch(() => {}),
        ssoButton.click(),
      ]);
      await page.waitForTimeout(2_000);
    }
  } catch {
    // No SSO interstitial — some tenants land straight on the form.
  }
  const emailBox = page.locator('input[type="email"], input[name*="mail" i], input[name*="user" i], input[name*="phone" i], input[type="text"], input[type="tel"]').first();
  await emailBox.waitFor({ timeout: 20_000 });
  await emailBox.fill(email);
  const passwordBox = page.locator('input[type="password"]').first();
  await passwordBox.fill(password);
  await Promise.all([
    page.waitForLoadState("networkidle", { timeout: 45_000 }).catch(() => {}),
    passwordBox.press("Enter"),
  ]);
  await page.waitForTimeout(2_000);
  if (!(await isLoggedIn(page))) throw new Error("Đăng nhập không thành công — kiểm tra SAPO_EMAIL/SAPO_PASSWORD.");
  console.log("Đăng nhập OK, lưu phiên.");
}

async function exportRevenue(page) {
  console.log("\n[1/3] Doanh thu tổng quan…");
  await page.goto(`${ADMIN}/reports-revenue`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_000);
  // The report type may already default to "Doanh thu tổng quan"; select it
  // only when the option is visible so a pre-selected state does not fail.
  try { await clickLabel(page, "Doanh thu tổng quan", { timeout: 4_000 }); } catch { /* already selected */ }
  try {
    await clickLabel(page, ["Năm nay", "năm nay"], { timeout: 4_000 });
  } catch {
    // The range control might be a dropdown that needs opening first.
    try {
      await clickLabel(page, ["Thời gian", "Hôm nay", "7 ngày qua", "Tháng này"], { timeout: 4_000 });
      await clickLabel(page, ["Năm nay", "năm nay"], { timeout: 4_000 });
    } catch {
      console.log("   (không đổi được bộ lọc thời gian — dùng khoảng đang chọn sẵn)");
    }
  }
  await clickLabel(page, ["Xem báo cáo", "Xem báo cáo"]);
  await page.waitForTimeout(3_000);
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await clickLabel(page, ["Xuất báo cáo", "Xuất Excel", "Xuất file"]);
  const download = await downloadPromise;
  await mkdir(REPORT_DIR, { recursive: true });
  const suggested = download.suggestedFilename() || `doanh-thu-tong-quan-${Date.now()}.xls`;
  const target = path.join(REPORT_DIR, suggested);
  await download.saveAs(target);
  console.log(`   ↓ đã lưu ${suggested}`);
  return suggested;
}

async function exportInvoices(page) {
  console.log("\n[2/3] Danh sách hoá đơn (xuất theo mặt hàng → email)…");
  await page.goto(`${ADMIN}/orders`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_000);
  await clickLabel(page, ["Xuất hoá đơn", "Xuất hóa đơn", "Xuất file"]);
  await page.waitForTimeout(1_000);
  await clickLabel(page, ["theo danh sách mặt hàng", "danh sách mặt hàng"]);
  await clickLabel(page, ["Tất cả hoá đơn", "Tất cả hóa đơn", "Tất cả"]);
  await clickLabel(page, ["Xuất file", "Xuất hoá đơn", "Xuất hóa đơn", "Xuất"]);
  await page.waitForTimeout(2_000);
  console.log("   ✉ đã yêu cầu — Sapo sẽ gửi link về email");
}

async function exportProducts(page) {
  console.log("\n[3/3] Danh sách mặt hàng (bảng giá → email)…");
  await page.goto(`${ADMIN}/products`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_000);
  await clickLabel(page, ["Xuất danh sách", "Xuất file", "Xuất"]);
  await page.waitForTimeout(1_000);
  await clickLabel(page, ["Tất cả mặt hàng", "Tất cả"]);
  await clickLabel(page, ["Xuất danh sách mặt hàng", "Xuất file", "Xuất"]);
  await page.waitForTimeout(2_000);
  console.log("   ✉ đã yêu cầu — Sapo sẽ gửi link về email");
}

async function main() {
  await loadEnvLocal();
  await mkdir(STATE_DIR, { recursive: true });
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

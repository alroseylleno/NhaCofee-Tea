#!/usr/bin/env node
// Manual trigger: pull the daily settlement reports of every sàn out of Gmail —
// Grab (PDF), ShopeeFood (CSV), GreenSM (xlsx) — and drop them into their local
// report folders, ready for the app's "Quét thư mục local" button.
//
//   npm run grab:uat              # UAT: download → local folder → app ingests
//   npm run grab:uat -- --days 30 # wider sweep
//   npm run grab:uat -- --all     # every matching mail in the mailbox
//   npm run grab:prod             # Production: not enabled yet, see checkTarget()
//
// The two triggers differ only in destination. UAT lands the PDFs on disk and
// the browser folds them into localStorage; Production will parse and write
// straight to Supabase. Keeping them as separate commands means a routine UAT
// refresh can never touch production data by accident.
//
// Auth uses a Gmail App Password over IMAP (needs 2-step verification on the
// account). That avoids an OAuth consent screen and, unlike a Testing-mode
// OAuth client, never expires after 7 days. There is no IMAP toggle to switch
// on any more — Gmail made IMAP always-on, so the Forwarding/POP/IMAP screen
// only shows behaviour options and nothing there needs changing.
//
// Put these in .env.local (already git-ignored):
//   GRAB_MAIL_USER=you@gmail.com
//   GRAB_MAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx
//   GRAB_MAIL_FROM=no-reply@grab.com         # optional, this is the default
//   GRAB_MAIL_SUBJECT=Báo cáo doanh số       # optional, this is the default
//   GRAB_REPORT_DIR=/abs/path                # optional, defaults to ../../Report/Grab Report


import { ImapFlow } from "imapflow";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
const REPORT_ROOT = path.join(projectRoot, "..", "..", "Report");
const DEFAULT_REPORT_DIR = path.join(REPORT_ROOT, "Grab Report");

/// Grab sends the daily report as "Báo cáo doanh số" from no-reply@grab.com
/// with the PDF attached. All three must hold before a mail is downloaded.
const DEFAULT_FROM = "no-reply@grab.com";
const DEFAULT_SUBJECT = "Báo cáo doanh số";

/// One entry per sàn. Every platform follows the same contract: sender +
/// subject fragment (matched accent-insensitively in code, never in IMAP
/// SEARCH) + attachment extension → dropped into its own Report folder for the
/// app's folder scan. Shopee mails daily but attaches the CSV only on days
/// with orders (the "(Mart)" twin never has one); GreenSM mails only on days
/// with revenue. minBytes guards against tracking-pixel-sized junk without
/// rejecting Shopee's legitimately tiny one-order CSVs.
/// "ID cửa hàng" of a ShopeeFood income CSV (first data row), or "" when absent.
function shopeeStoreId(buffer) {
  const lines = buffer.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return "";
  const fold = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().trim();
  const column = lines[0].split(",").findIndex((cell) => fold(cell).includes("id cua hang"));
  return column >= 0 ? String(lines[1].split(",")[column] || "").trim() : "";
}

/// Which store a report file belongs to, read from inside the file: Shopee "ID
/// cửa hàng", GreenSM "ID cửa hàng" + "Tên cửa hàng", Grab's branch line
/// ("Nhà Coffee&Tea - Trương Phước Phan"). N2 is registered as a branch of N1's
/// owner account, so a file name alone may not tell the two apart.
async function reportIdentity(platformKey, buffer) {
  try {
    if (platformKey === "shopee") return shopeeStoreId(buffer);
    if (platformKey === "greensm") {
      const XLSX = await import("xlsx");
      const original = console.error;
      console.error = (...args) => { if (typeof args[0] === "string" && args[0].startsWith("Bad uncompressed size")) return; original(...args); };
      let workbook;
      try { workbook = XLSX.read(buffer, { type: "buffer" }); } finally { console.error = original; }
      const sheet = workbook.Sheets[workbook.SheetNames.find((name) => /detail/i.test(name)) || workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }).map((row) => row.map((cell) => String(cell)));
      const fold = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().trim();
      const headerRow = rows.findIndex((row) => row.some((cell) => fold(cell).includes("id cua hang")));
      if (headerRow < 0) return "";
      const idColumn = rows[headerRow].findIndex((cell) => fold(cell).includes("id cua hang"));
      const nameColumn = rows[headerRow].findIndex((cell) => fold(cell).includes("ten cua hang"));
      return [...new Set(rows.slice(headerRow + 1).filter((row) => row[idColumn]).map((row) => `${row[idColumn]} ${nameColumn >= 0 ? row[nameColumn] : ""}`.trim()))].sort().join(" + ");
    }
    if (platformKey === "grab") {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
      const document = await task.promise;
      try {
        const page = await document.getPage(1);
        const text = (await page.getTextContent()).items.map((item) => item.str || "").join(" ");
        return text.match(/\+\d{9,}\s+(.+?)\s+Tóm tắt/)?.[1]?.trim() || "";
      } finally { await task.destroy(); }
    }
  } catch { /* unreadable: treated as unknown, the file is then kept under a uid suffix */ }
  return "";
}

/// "Nhà Coffee&Tea - Trương Phước Phan" → "nha-coffee-tea-truong-phuoc-phan"
function identitySlug(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

const PLATFORMS = [
  {
    key: "grab",
    label: "Grab",
    from: () => process.env.GRAB_MAIL_FROM ?? DEFAULT_FROM,
    subject: () => process.env.GRAB_MAIL_SUBJECT ?? DEFAULT_SUBJECT,
    extensions: [".pdf"],
    dir: () => (process.env.GRAB_REPORT_DIR ? path.resolve(process.env.GRAB_REPORT_DIR) : DEFAULT_REPORT_DIR),
    minBytes: 1024,
  },
  {
    key: "shopee",
    label: "ShopeeFood",
    from: () => "no-reply@shopeefood.vn",
    subject: () => "Báo cáo doanh thu hàng ngày",
    extensions: [".csv"],
    dir: () => path.join(REPORT_ROOT, "Shopee Report"),
    minBytes: 100,
  },
  {
    key: "greensm",
    label: "GreenSM",
    from: () => "no-reply@greensm.com",
    subject: () => "Báo cáo doanh thu",
    extensions: [".xlsx"],
    dir: () => path.join(REPORT_ROOT, "GreenSM Report"),
    minBytes: 500,
  },
];

async function loadEnvLocal() {
  try {
    const raw = await readFile(path.join(projectRoot, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!match) continue;
      const value = match[2].replace(/^["']|["']$/g, "");
      if (!(match[1] in process.env)) process.env[match[1]] = value;
    }
  } catch {
    // No .env.local is fine when the values come from the real environment.
  }
}

function parseArgs(argv) {
  const args = { days: 7, all: false, target: "uat", open: true };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--all") args.all = true;
    else if (argv[index] === "--no-open") args.open = false;
    else if (argv[index] === "--days") args.days = Math.max(1, Number(argv[++index]) || 7);
    else if (argv[index] === "--target") args.target = String(argv[++index] || "uat").toLowerCase();
  }
  return args;
}

/// Production ingest is deliberately unbuilt: it needs a Supabase identity for
/// the script, the reconciliation migrations actually applied, and the platform
/// tab un-gated for production. Fail loudly rather than pretend.
function checkTarget(target) {
  if (target === "uat") return;
  if (target === "prod" || target === "production") {
    console.error("Trigger Production chưa bật. Cần xong 3 việc trước:");
    console.error("  Còn thiếu duy nhất: tài khoản Supabase riêng cho script (đặt GRAB_SUPABASE_EMAIL / GRAB_SUPABASE_PASSWORD).");
    console.error("  Schema và app Production đã sẵn sàng từ 2026-09-07.");
    console.error("\nTrong lúc đó dùng: npm run grab:uat");
    process.exit(1);
  }
  console.error(`--target không hợp lệ: "${target}". Chỉ nhận uat hoặc prod.`);
  process.exit(1);
}

/// Nudges the running UAT app so the freshly downloaded PDFs are picked up in
/// the same gesture. Opening the tab is what makes the app scan the folder.
async function openUatApp() {
  const url = process.env.GRAB_UAT_URL || "http://localhost:3001/";
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(String(response.status));
  } catch {
    console.log(`\nApp UAT chưa chạy ở ${url}. Mở terminal khác chạy \`npm run dev -- -p 3001\`, rồi vào Tài chính → Doanh thu → Nền tảng.`);
    return;
  }
  const { spawn } = await import("node:child_process");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(opener, [url], { detached: true, stdio: "ignore", shell: process.platform === "win32" }).unref();
  console.log(`\nĐã mở ${url} — vào Tài chính → Doanh thu → Nền tảng, app tự nạp báo cáo mới.`);
}

/// Diacritic-insensitive compare, so "Báo cáo doanh số" still matches if Grab
/// changes casing or the header arrives without accents.
function foldAccents(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();
}

/// Each sàn names its attachments distinctively (5-C8BGGY6BV2V3RE-20260826.pdf,
/// Shopeefood_Income_Details_Merchant_24-08-2026.csv, Revenue_Report_…xlsx).
/// Keep the original name so re-running the script is idempotent against the
/// folder, but strip any path separators a crafted filename might carry.
function safeFileName(name, fallback, extensions) {
  const base = path.basename(String(name || "")).replace(/[/\\]/g, "").trim();
  return extensions.some((extension) => base.toLowerCase().endsWith(extension)) ? base : fallback;
}

function collectAttachmentParts(node, extensions, found = []) {
  if (!node) return found;
  const disposition = String(node.disposition || "").toLowerCase();
  const type = String(node.type || "").toLowerCase();
  const name = String(node.dispositionParameters?.filename || node.parameters?.name || "");
  const wanted = extensions.some((extension) => name.toLowerCase().endsWith(extension))
    || (extensions.includes(".pdf") && type === "application/pdf");
  if (wanted && disposition !== "inline-body") found.push({ part: node.part, filename: name });
  for (const child of node.childNodes || []) collectAttachmentParts(child, extensions, found);
  return found;
}

async function main() {
  await loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  checkTarget(args.target);
  const user = process.env.GRAB_MAIL_USER;
  const pass = process.env.GRAB_MAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.error("Thiếu GRAB_MAIL_USER hoặc GRAB_MAIL_APP_PASSWORD trong .env.local.");
    console.error("Tạo App Password tại https://myaccount.google.com/apppasswords (cần bật xác minh 2 bước).");
    process.exit(1);
  }

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  console.log(`Kết nối ${user} …`);
  await client.connect();
  // "[Gmail]/All Mail" is localised (Vietnamese accounts show "Tất cả thư"), so
  // resolve it by its \All special-use flag and fall back to the inbox. Using
  // All Mail means an archived report is still found.
  let mailbox = "INBOX";
  try {
    for (const entry of await client.list()) {
      if (entry.specialUse === "\\All") { mailbox = entry.path; break; }
    }
  } catch {
    // Listing failures are not fatal; INBOX still works for unarchived mail.
  }
  console.log(`Hộp thư: ${mailbox}`);

  let saved = 0;
  let skipped = 0;
  const perPlatform = [];
  const lock = await client.getMailboxLock(mailbox);
  try {
    for (const platform of PLATFORMS) {
      const directory = platform.dir();
      await mkdir(directory, { recursive: true });
      const existing = new Set((await readdir(directory)).map((name) => name.toLowerCase()));
      const sender = platform.from();
      const wantedSubject = foldAccents(platform.subject());

      // Only ASCII criteria go to the server. Gmail's IMAP SEARCH needs a UTF-8
      // charset dance for Vietnamese subjects and quietly returns nothing when
      // it goes wrong, so the subject is matched here, accent-insensitively.
      const search = { from: sender };
      if (!args.all) {
        const since = new Date();
        since.setDate(since.getDate() - args.days);
        search.since = since;
      }
      console.log(`\n[${platform.label}] từ "${sender}" · tiêu đề chứa "${platform.subject()}" · ${args.all ? "toàn bộ hộp thư" : `${args.days} ngày gần nhất`}`);

      let matchedSender = 0;
      let subjectMismatch = 0;
      let scanned = 0;
      // imapflow holds the connection for the whole life of a fetch iterator, so
      // calling download() inside the loop deadlocks. Materialise the candidate
      // list first, release the iterator, then download.
      const candidates = [];
      for await (const message of client.fetch(search, { uid: true, envelope: true, bodyStructure: true })) {
        matchedSender++;
        if (wantedSubject && !foldAccents(message.envelope?.subject).includes(wantedSubject)) {
          subjectMismatch++;
          continue;
        }
        const parts = collectAttachmentParts(message.bodyStructure, platform.extensions);
        if (!parts.length) continue;
        scanned++;
        candidates.push({ uid: message.uid, subject: message.envelope?.subject || "", parts });
      }
      console.log(`  quét: ${matchedSender} email · ${subjectMismatch} sai tiêu đề · ${scanned} có file đính kèm`);

      let platformSaved = 0;
      for (const candidate of candidates) {
        for (const [index, attachment] of candidate.parts.entries()) {
          const fallback = `${platform.key}-${candidate.uid}-${index + 1}${platform.extensions[0]}`;
          let fileName = safeFileName(attachment.filename, fallback, platform.extensions);
          // Two stores can mail files of the same name for the same day
          // (Shopee never puts the merchant in the name; Grab/GreenSM may keep
          // the owner account's id for a new branch). On a name collision the
          // store inside each file decides: same store = already have it.
          const collides = existing.has(fileName.toLowerCase());
          const download = await client.download(String(candidate.uid), attachment.part, { uid: true });
          const chunks = [];
          for await (const chunk of download.content) chunks.push(chunk);
          const buffer = Buffer.concat(chunks);
          if (buffer.length < platform.minBytes) {
            console.warn(`  bỏ qua ${fileName} (chỉ ${buffer.length} bytes)`);
            continue;
          }
          if (collides) {
            const incomingStore = await reportIdentity(platform.key, buffer);
            const existingStore = await reportIdentity(platform.key, await readFile(path.join(directory, fileName)).catch(() => Buffer.alloc(0)));
            if (!incomingStore || incomingStore === existingStore) {
              skipped++;
              continue;
            }
            const extension = path.extname(fileName);
            fileName = `${fileName.slice(0, -extension.length)}_${platform.key === "shopee" ? incomingStore : identitySlug(incomingStore)}${extension}`;
            if (existing.has(fileName.toLowerCase())) {
              skipped++;
              continue;
            }
            console.log(`  (trùng tên file với quán khác: ${existingStore || "?"} ≠ ${incomingStore})`);
          }
          await writeFile(path.join(directory, fileName), buffer);
          existing.add(fileName.toLowerCase());
          saved++;
          platformSaved++;
          console.log(`  + ${fileName}  (${(buffer.length / 1024).toFixed(1)} KB)  ${candidate.subject}`);
        }
      }
      perPlatform.push({ label: platform.label, matchedSender, scanned, saved: platformSaved, directory });
      if (!matchedSender) console.log(`  (không có email nào từ "${sender}" trong khoảng quét — thử --days lớn hơn / --all)`);
    }
  } finally {
    lock.release();
    await client.logout();
  }

  console.log(`\nXong. Tải mới ${saved} · bỏ qua ${skipped} (đã có sẵn).`);
  for (const entry of perPlatform) console.log(`  ${entry.label.padEnd(10)} ${String(entry.saved).padStart(2)} file mới → ${entry.directory}`);
  if (saved && args.open) await openUatApp();
  else if (saved) console.log('Mở app UAT → Tài chính → Doanh thu → Nền tảng, bấm "Quét thư mục local".');
}

main().catch((error) => {
  // imapflow reports a failed LOGIN as a bare "Command failed", which tells the
  // reader nothing; translate the cases that actually happen.
  const message = String(error?.message || error);
  if (error?.authenticationFailed || /command failed|invalid credentials|authenticationfailed/i.test(message)) {
    console.error("Gmail từ chối đăng nhập.");
    console.error("- Mật khẩu phải là App Password 16 ký tự, không phải mật khẩu Gmail thường.");
    console.error("- Tài khoản phải bật xác minh 2 bước: https://myaccount.google.com/apppasswords");
    console.error("- Đúng hộp thư nhận báo cáo Grab chứ không phải tài khoản Google khác đang đăng nhập.");
    console.error("  (Không cần bật IMAP: Gmail đã bỏ nút đó, IMAP luôn bật sẵn.)");
  } else if (/enotfound|econnrefused|etimedout|network/i.test(message)) {
    console.error("Không kết nối được tới imap.gmail.com. Kiểm tra mạng.");
  } else {
    console.error("Lỗi:", message);
  }
  process.exit(1);
});

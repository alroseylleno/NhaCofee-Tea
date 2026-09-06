#!/usr/bin/env node
// Manual trigger: pull GrabFood's daily report PDFs out of Gmail and drop them
// into the local report folder, ready for the app's "Quét thư mục local" button.
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
const DEFAULT_REPORT_DIR = path.join(projectRoot, "..", "..", "Report", "Grab Report");

/// Grab sends the daily report as "Báo cáo doanh số" from no-reply@grab.com
/// with the PDF attached. All three must hold before a mail is downloaded.
const DEFAULT_FROM = "no-reply@grab.com";
const DEFAULT_SUBJECT = "Báo cáo doanh số";

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
    console.error("  1. Commit + apply 2 migration finance_grab_reconciliations và finance_platform_order_rows lên Supabase.");
    console.error("  2. Bỏ khoá tab Nền tảng cho Production (commit bd46caa đang chặn).");
    console.error("  3. Tạo tài khoản Supabase riêng cho script và đặt GRAB_SUPABASE_EMAIL / GRAB_SUPABASE_PASSWORD.");
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

/// Grab names its attachments like 5-C8BGGY6BV2V3RE-20260826.pdf. Keep the
/// original name so re-running the script is idempotent against the folder, but
/// strip any path separators a crafted filename might carry.
function safeFileName(name, fallback) {
  const base = path.basename(String(name || "")).replace(/[/\\]/g, "").trim();
  return base.toLowerCase().endsWith(".pdf") ? base : fallback;
}

function collectPdfParts(node, found = []) {
  if (!node) return found;
  const disposition = String(node.disposition || "").toLowerCase();
  const type = String(node.type || "").toLowerCase();
  const name = node.dispositionParameters?.filename || node.parameters?.name || "";
  if ((type === "application/pdf" || String(name).toLowerCase().endsWith(".pdf")) && disposition !== "inline-body") {
    found.push({ part: node.part, filename: name });
  }
  for (const child of node.childNodes || []) collectPdfParts(child, found);
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

  const directory = process.env.GRAB_REPORT_DIR ? path.resolve(process.env.GRAB_REPORT_DIR) : DEFAULT_REPORT_DIR;
  await mkdir(directory, { recursive: true });
  const existing = new Set((await readdir(directory)).map((name) => name.toLowerCase()));

  const sender = process.env.GRAB_MAIL_FROM ?? DEFAULT_FROM;
  const wantedSubject = foldAccents(process.env.GRAB_MAIL_SUBJECT ?? DEFAULT_SUBJECT);

  // Only ASCII criteria go to the server. Gmail's IMAP SEARCH needs a UTF-8
  // charset dance for "Báo cáo doanh số" and quietly returns nothing when it
  // goes wrong, so the subject is matched here instead, accent-insensitively.
  const search = {};
  if (sender) search.from = sender;
  if (!args.all) {
    const since = new Date();
    since.setDate(since.getDate() - args.days);
    search.since = since;
  }
  console.log(`Tìm: từ "${sender || "(bất kỳ)"}" · tiêu đề chứa "${process.env.GRAB_MAIL_SUBJECT ?? DEFAULT_SUBJECT}" · ${args.all ? "toàn bộ hộp thư" : `${args.days} ngày gần nhất`}`);

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  console.log(`Kết nối ${user} …`);
  await client.connect();
  let saved = 0;
  let skipped = 0;
  let scanned = 0;
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
  let matchedSender = 0;
  let subjectMismatch = 0;
  const lock = await client.getMailboxLock(mailbox);
  try {
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
      const pdfParts = collectPdfParts(message.bodyStructure);
      if (!pdfParts.length) continue;
      scanned++;
      candidates.push({ uid: message.uid, subject: message.envelope?.subject || "", pdfParts });
    }
    console.log(`Quét xong: ${matchedSender} email từ ${sender} · ${subjectMismatch} sai tiêu đề · ${scanned} có PDF.`);

    for (const candidate of candidates) {
      for (const [index, pdf] of candidate.pdfParts.entries()) {
        const fallback = `grab-${candidate.uid}-${index + 1}.pdf`;
        const fileName = safeFileName(pdf.filename, fallback);
        if (existing.has(fileName.toLowerCase())) {
          skipped++;
          continue;
        }
        const download = await client.download(String(candidate.uid), pdf.part, { uid: true });
        const chunks = [];
        for await (const chunk of download.content) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        // A Grab daily report is tens of KB; anything tiny is not a real report.
        if (buffer.length < 1024) {
          console.warn(`  bỏ qua ${fileName} (chỉ ${buffer.length} bytes)`);
          continue;
        }
        await writeFile(path.join(directory, fileName), buffer);
        existing.add(fileName.toLowerCase());
        saved++;
        console.log(`  + ${fileName}  (${(buffer.length / 1024).toFixed(0)} KB)  ${candidate.subject}`);
      }
    }
  } finally {
    lock.release();
    await client.logout();
  }

  console.log(`\nXong. ${matchedSender} email từ ${sender || "(bất kỳ)"} · ${subjectMismatch} sai tiêu đề · ${scanned} có PDF · tải mới ${saved} · bỏ qua ${skipped} (đã có sẵn).`);
  console.log(`Thư mục: ${directory}`);
  if (!matchedSender) {
    console.log(`\nKhông có email nào từ "${sender}". Kiểm tra lại địa chỉ gửi thật của Grab rồi đặt GRAB_MAIL_FROM trong .env.local, hoặc chạy với --days lớn hơn / --all.`);
  } else if (matchedSender && !scanned) {
    console.log(`\nCó email từ "${sender}" nhưng không cái nào vừa đúng tiêu đề vừa có PDF. Chỉnh GRAB_MAIL_SUBJECT trong .env.local cho khớp tiêu đề thật.`);
  }
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

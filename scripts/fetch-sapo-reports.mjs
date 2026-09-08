#!/usr/bin/env node
// Same shape as the Grab job, different channel. Sapo does not attach its
// exports: it emails a link to a public CDN file. So this reads the mail, pulls
// the URL out of the body, and downloads the workbook.
//
//   npm run sapo:uat                 # last 14 days
//   npm run sapo:uat -- --days 60
//   npm run sapo:uat -- --all
//   npm run sapo:prod                # not enabled yet
//
// Long still has to press Export inside Sapo — that is what generates the mail.
// Everything after that is automatic.
//
// Credentials are shared with the Grab job (npm run grab:setup):
//   GRAB_MAIL_USER / GRAB_MAIL_APP_PASSWORD

import { ImapFlow } from "imapflow";
import { SAPO_DIRS, sapoCanonicalName } from "./sapo-files.mjs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
const REPORT_ROOT = path.join(projectRoot, "..", "..", "Report");

const SENDER = "no-reply@sapo.vn";
/// Each export type lands in its own folder so the app can tell them apart, and
/// so a price book never overwrites an invoice list.
const KINDS = [
  { key: "orders", subject: "hóa đơn", dir: SAPO_DIRS.orders, match: /danh_sach_hoa_don[^"'\s]*\.xlsx/i },
  { key: "prices", subject: "mặt hàng", dir: SAPO_DIRS.prices, match: /danh_muc_mat_hang[^"'\s]*\.xlsx/i },
];

async function loadEnvLocal() {
  try {
    const raw = await readFile(path.join(projectRoot, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // Falling back to the real environment is fine.
  }
}

function parseArgs(argv) {
  const args = { days: 14, all: false, target: "uat", waitSeconds: 0 };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--all") args.all = true;
    else if (argv[index] === "--days") args.days = Math.max(1, Number(argv[++index]) || 14);
    else if (argv[index] === "--target") args.target = String(argv[++index] || "uat").toLowerCase();
    else if (argv[index] === "--wait") args.waitSeconds = Math.max(0, Number(argv[++index]) || 300);
  }
  return args;
}

function checkTarget(target) {
  if (target === "uat") return;
  if (target === "prod" || target === "production") {
    console.error("Trigger Production chưa bật cho SAPO. Cần xong 3 việc trước:");
    console.error("  Còn thiếu duy nhất: tài khoản Supabase riêng cho script (đặt GRAB_SUPABASE_EMAIL / GRAB_SUPABASE_PASSWORD).");
    console.error("  Schema và app Production đã sẵn sàng từ 2026-09-07.");
    console.error("\nTrong lúc đó dùng: npm run sapo:uat");
    process.exit(1);
  }
  console.error(`--target không hợp lệ: "${target}". Chỉ nhận uat hoặc prod.`);
  process.exit(1);
}

function foldAccents(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim();
}

/// Sapo sends quoted-printable HTML, so the download URL is split across lines
/// with trailing "=" soft breaks. Without undoing that the link is truncated.
function decodeQuotedPrintable(raw) {
  return raw.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function findDownloadUrl(body, pattern) {
  for (const url of body.match(/https?:\/\/[^\s"'<>\\)]+/g) || []) {
    if (pattern.test(url)) return url;
  }
  return undefined;
}

/// One complete mailbox pass. Returns which export kinds saved a NEW file, so
/// the --wait loop can stop the moment both emailed exports have landed.
async function fetchOnce(args, user, pass) {
  const savedKinds = new Set();
  const search = { from: SENDER };
  if (!args.all) {
    const since = new Date();
    since.setDate(since.getDate() - args.days);
    search.since = since;
  }
  const client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  let mailbox = "INBOX";
  try {
    for (const entry of await client.list()) {
      if (entry.specialUse === "\\All") { mailbox = entry.path; break; }
    }
  } catch {
    // INBOX is a fine fallback.
  }

  const lock = await client.getMailboxLock(mailbox);
  let saved = 0;
  let skipped = 0;
  try {
    // Materialise first: downloading inside a fetch iterator deadlocks imapflow.
    const candidates = [];
    for await (const message of client.fetch(search, { uid: true, envelope: true })) {
      const subject = message.envelope?.subject || "";
      const kind = KINDS.find((entry) => foldAccents(subject).includes(foldAccents(`xuất danh sách ${entry.subject}`)));
      if (kind) candidates.push({ uid: message.uid, subject, date: message.envelope?.date, kind });
    }
    // Newest first, so the freshest export of each type wins the filename race.
    candidates.sort((left, right) => Number(right.date || 0) - Number(left.date || 0));
    console.log(`Có ${candidates.length} email export của Sapo.`);

    for (const candidate of candidates) {
      const download = await client.download(String(candidate.uid), undefined, { uid: true });
      const chunks = [];
      for await (const chunk of download.content) chunks.push(chunk);
      const body = decodeQuotedPrintable(Buffer.concat(chunks).toString("utf8"));
      const url = findDownloadUrl(body, candidate.kind.match);
      if (!url) {
        console.warn(`  ! không tìm thấy link trong "${candidate.subject}"`);
        continue;
      }
      // Canonical, dated name instead of Sapo's uuid soup; the mail's own date
      // stamps snapshots that carry no timestamp in their name.
      const fileName = sapoCanonicalName(candidate.kind.key, path.basename(new URL(url).pathname), candidate.date ? new Date(candidate.date) : new Date());
      await mkdir(candidate.kind.dir, { recursive: true });
      const existing = new Set((await readdir(candidate.kind.dir)).map((name) => name.toLowerCase()));
      if (existing.has(fileName.toLowerCase())) {
        skipped++;
        continue;
      }
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`  ! tải hỏng ${fileName}: HTTP ${response.status}`);
        continue;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      // A Sapo export is tens of KB; anything tiny is an error page, not data.
      if (buffer.length < 2048) {
        console.warn(`  ! bỏ qua ${fileName} (chỉ ${buffer.length} bytes)`);
        continue;
      }
      await writeFile(path.join(candidate.kind.dir, fileName), buffer);
      saved++;
      savedKinds.add(candidate.kind.key);
      console.log(`  + [${candidate.kind.key}] ${fileName}  (${(buffer.length / 1024).toFixed(0)} KB)`);
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return { saved, skipped, savedKinds };
}

async function main() {
  await loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  checkTarget(args.target);
  const user = process.env.GRAB_MAIL_USER;
  const pass = process.env.GRAB_MAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.error("Thiếu GRAB_MAIL_USER / GRAB_MAIL_APP_PASSWORD. Chạy: npm run grab:setup");
    process.exit(1);
  }
  console.log(`Tìm: từ "${SENDER}" · ${args.all ? "toàn bộ hộp thư" : `${args.days} ngày gần nhất`}${args.waitSeconds ? ` · chờ tối đa ${args.waitSeconds}s cho mail export mới` : ""}`);

  let totalSaved = 0;
  let lastSkipped = 0;
  const wantedKinds = new Set(KINDS.map((kind) => kind.key));
  const gotKinds = new Set();
  const deadline = Date.now() + args.waitSeconds * 1_000;
  for (let attempt = 1; ; attempt++) {
    const result = await fetchOnce(args, user, pass);
    totalSaved += result.saved;
    lastSkipped = result.skipped;
    for (const kind of result.savedKinds) gotKinds.add(kind);
    const missing = [...wantedKinds].filter((kind) => !gotKinds.has(kind));
    if (!args.waitSeconds || missing.length === 0 || Date.now() >= deadline) {
      if (args.waitSeconds && missing.length) console.log(`Hết giờ chờ — chưa thấy mail mới cho: ${missing.join(", ")}.`);
      break;
    }
    console.log(`(lượt ${attempt}) còn thiếu ${missing.join(", ")} — chờ 30s rồi kiểm tra lại…`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }

  console.log(`\nXong. Tải mới ${totalSaved} · bỏ qua ${lastSkipped} (đã có sẵn).`);
  console.log(`Hoá đơn  → ${SAPO_DIRS.orders}`);
  console.log(`Bảng giá → ${SAPO_DIRS.prices}`);
  if (totalSaved) console.log('\nMở app → tab Nền tảng → bấm Quét thư mục local để nạp tự động.');
}

main().catch((error) => {
  const message = String(error?.message || error);
  if (error?.authenticationFailed || /command failed|invalid credentials/i.test(message)) {
    console.error("Gmail từ chối đăng nhập. Chạy lại: npm run grab:setup");
  } else {
    console.error("Lỗi:", message);
  }
  process.exit(1);
});

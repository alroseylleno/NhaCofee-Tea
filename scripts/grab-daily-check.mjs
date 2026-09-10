#!/usr/bin/env node
// Nightly đối soát nag. launchd fires this every 30 minutes between 22:00 and
// 23:30; it pulls any new Grab report, then puts a dialog on screen and keeps
// coming back until Long marks the day approved. Once approved it goes quiet
// for the rest of that day and resumes tomorrow.
//
//   npm run grab:check          # run one tick by hand
//   npm run grab:check -- --status
//   npm run grab:check -- --approve      # mark today done without the dialog
//   npm run grab:check -- --reset        # clear today's approval
//   npm run grab:check -- --open-app     # start the UAT server if needed and open it
//
// Everything here is UAT/local. Production stays behind `npm run grab:prod`.

import { spawn, spawnSync } from "node:child_process";
import { mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
// This loop is wired to UAT on purpose: it fetches with `--target uat` and opens
// the local UAT app. Pointing it at Production is a deliberate later change, not
// a config tweak — see `npm run grab:prod` for the preconditions.
const TARGET = "uat";
const APP_PORT = Number(process.env.GRAB_UAT_PORT || 3001);
const APP_URL = process.env.GRAB_UAT_URL || `http://localhost:${APP_PORT}/`;

const STATE_DIR = path.join(projectRoot, ".grab-state");
const STATE_FILE = path.join(STATE_DIR, "approvals.json");
const DEFAULT_REPORT_DIR = path.join(projectRoot, "..", "..", "Report", "Grab Report");

/// Local calendar date, not UTC — the nag window is 22:00–24:00 Vietnam time and
/// must stay keyed to the day Long is actually looking at.
function todayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeState(state) {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function reportDirectory() {
  return process.env.GRAB_REPORT_DIR ? path.resolve(process.env.GRAB_REPORT_DIR) : DEFAULT_REPORT_DIR;
}

/// One count per sàn folder, so the dialog reports all three pipelines.
async function countReports() {
  const folders = [
    { label: "Grab", dir: reportDirectory(), extension: ".pdf" },
    { label: "Shopee", dir: path.join(projectRoot, "..", "..", "Report", "Shopee Report"), extension: ".csv" },
    { label: "GreenSM", dir: path.join(projectRoot, "..", "..", "Report", "GreenSM Report"), extension: ".xlsx" },
  ];
  const counts = [];
  let total = 0;
  for (const folder of folders) {
    try {
      const count = (await readdir(folder.dir)).filter((name) => name.toLowerCase().endsWith(folder.extension)).length;
      counts.push(`${count} ${folder.label}`);
      total += count;
    } catch {
      counts.push(`0 ${folder.label}`);
    }
  }
  return { total, detail: counts.join(" · ") };
}

async function listReports() {
  try {
    return (await readdir(reportDirectory())).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
  } catch {
    return [];
  }
}

/// AppleScript string literals break on embedded quotes and backslashes.
function osaQuote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function notify(title, message) {
  spawnSync("/usr/bin/osascript", ["-e", `display notification ${osaQuote(message)} with title ${osaQuote(title)}`]);
}

/// Returns the button label, or "" when the dialog timed out. `giving up after`
/// matters: without it an unattended dialog would sit forever and every later
/// launchd tick would stack another one on the screen.
function askApproval(message, timeoutSeconds, buttons = ["Để sau", "Mở app", "Đã đối soát xong"], defaultButton = "Mở app") {
  const script = `display dialog ${osaQuote(message)} with title ${osaQuote("Đối soát sàn")} `
    + `buttons {${buttons.map((label) => osaQuote(label)).join(", ")}} `
    + `default button ${osaQuote(defaultButton)} giving up after ${timeoutSeconds}`;
  const result = spawnSync("/usr/bin/osascript", ["-e", script], { encoding: "utf8" });
  // Cancel/dismiss exits non-zero; treat it the same as "later".
  if (result.status !== 0) return "";
  const output = String(result.stdout || "");
  if (/gave up:true/.test(output)) return "";
  const match = output.match(/button returned:([^,\n]*)/);
  return match ? match[1].trim() : "";
}

/// Pull new PDFs first so the dialog can report a real count. Never opens the
/// browser window here — a visible browser flying open at 10pm is not a
/// reminder (the SAPO export runs headless for the same reason).
function fetchReports() {
  const result = spawnSync(process.execPath, [path.join(here, "fetch-grab-reports.mjs"), "--target", TARGET, "--no-open"], {
    cwd: projectRoot,
    encoding: "utf8",
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  const saved = output.match(/tải mới (\d+)/);
  return { ok: result.status === 0, downloaded: saved ? Number(saved[1]) : 0, output };
}

/// Presses SAPO's three export buttons and waits for the emailed files, so the
/// dialog pops with everything already on disk. Skipped when SAPO credentials
/// are absent or --skip-sapo is passed; a failure still nags — that is exactly
/// when Long needs to know.
function runSapoChain() {
  if (!process.env.SAPO_EMAIL || !process.env.SAPO_PASSWORD) return { ran: false, ok: false, note: "" };
  // 6 minutes: a warm run takes ~1-2, but a cold Chrome start plus an expired
  // Sapo session can exceed the old 3-minute box — the kill then left NO error
  // screenshot while the message pointed at one, which read as a mystery.
  const exported = spawnSync(process.execPath, [path.join(here, "export-sapo-reports.mjs")], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 6 * 60_000,
  });
  if (exported.status !== 0) {
    const note = exported.signal
      ? "Export SAPO bị dừng vì chạy quá 6 phút (máy chậm hoặc Sapo chậm) — bấm Thử lại thường là xong."
      : "Bấm export SAPO thất bại — xem .grab-state/sapo-error-*.png.";
    return { ran: true, ok: false, note };
  }
  const fetched = spawnSync(process.execPath, [path.join(here, "fetch-sapo-reports.mjs"), "--wait", "240"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 5 * 60_000,
  });
  const output = `${fetched.stdout || ""}${fetched.stderr || ""}`;
  const saved = output.match(/Tải mới (\d+)/);
  const count = saved ? Number(saved[1]) : 0;
  return { ran: true, ok: fetched.status === 0, note: fetched.status === 0 ? `SAPO: export + tải ${count} file mới.` : "Export SAPO xong nhưng chưa vớt được mail." };
}

async function appIsUp() {
  try {
    const response = await fetch(APP_URL, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

/// At 22:00 the dev server is almost never already running, so the reminder has
/// to be able to start it. Next is launched through the current node binary
/// rather than `npm`, because launchd hands the job a bare PATH with no nvm.
async function ensureAppRunning() {
  if (await appIsUp()) return true;
  const nextBin = path.join(projectRoot, "node_modules", "next", "dist", "bin", "next");
  const logPath = path.join(STATE_DIR, "dev-server.log");
  await mkdir(STATE_DIR, { recursive: true });
  const log = await open(logPath, "a");
  const child = spawn(process.execPath, [nextBin, "dev", "-p", String(APP_PORT)], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  child.unref();
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (await appIsUp()) {
      await log.close();
      return true;
    }
  }
  await log.close();
  return false;
}

async function openApp() {
  const started = await ensureAppRunning();
  if (!started) {
    notify("Đối soát Grab", `Không khởi động được app UAT ở cổng ${APP_PORT}. Xem .grab-state/dev-server.log`);
    console.log(`Không khởi động được app UAT ở ${APP_URL}.`);
    return;
  }
  spawn("/usr/bin/open", [APP_URL], { detached: true, stdio: "ignore" }).unref();
  console.log(`Đã mở ${APP_URL}`);
}

/// launchd hands this process a bare environment, so SAPO credentials must be
/// read from .env.local here — the child fetch scripts load it themselves, but
/// runSapoChain's guard runs in THIS process.
async function loadEnvLocal() {
  try {
    const raw = await readFile(path.join(projectRoot, ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // Missing .env.local just means the SAPO chain is skipped.
  }
}

async function main() {
  const argv = process.argv.slice(2);
  await loadEnvLocal();
  const key = todayKey();
  const state = await readState();

  if (argv.includes("--status")) {
    const entry = state[key];
    console.log(entry ? `${key}: DONE — approved lúc ${entry.approvedAt}` : `${key}: chưa approve`);
    console.log(`Báo cáo trong thư mục: ${(await listReports()).length}`);
    console.log(`State file: ${STATE_FILE}`);
    return;
  }
  if (argv.includes("--reset")) {
    delete state[key];
    await writeState(state);
    console.log(`Đã xoá approval của ${key}. Tối nay sẽ nhắc lại.`);
    return;
  }
  if (argv.includes("--open-app")) {
    await openApp();
    return;
  }
  if (argv.includes("--approve")) {
    state[key] = { approvedAt: new Date().toISOString(), via: "cli" };
    await writeState(state);
    console.log(`${key}: DONE.`);
    return;
  }

  if (state[key]) {
    console.log(`${key}: đã approve lúc ${state[key].approvedAt} — không nhắc nữa.`);
    return;
  }

  const isNag = argv.includes("--nag");

  /// One full pass of the nightly chain. Also the body of the "Thử lại"
  /// button, so a flaky night (slow Chrome, slow Sapo, dropped Gmail) can be
  /// re-run straight from the dialog instead of waiting for the next tick.
  const runChainOnce = async () => {
    const before = (await countReports()).total;
    // Press SAPO's export buttons and harvest the emails first, so the dialog
    // appears with every report already sitting on disk.
    const sapo = argv.includes("--skip-sapo") ? { ran: false, ok: true, note: "" } : runSapoChain();
    const fetched = fetchReports();
    const counted = await countReports();

    let headline;
    if (!fetched.ok) {
      // Still nag: a broken mail fetch is exactly when Long needs to know.
      headline = "Không tải được báo cáo mới từ Gmail (kiểm tra App Password trong .env.local).";
    } else if (fetched.downloaded > 0) {
      headline = `Vừa tải ${fetched.downloaded} báo cáo sàn mới.`;
    } else {
      headline = "Không có báo cáo sàn mới.";
    }
    if (sapo.ran || sapo.note) headline += ` ${sapo.note}`;

    const failed = !fetched.ok || (sapo.ran && !sapo.ok);
    const delta = counted.total - before;
    const message = `${failed ? "⚠ CÓ BƯỚC THẤT BẠI\n\n" : ""}${headline}\n\nThư mục: ${counted.detail}${delta > 0 ? ` (+${delta})` : ""}.\n\nĐối soát ngày ${key} xong chưa?`;
    console.log(message.replace(/\n+/g, " | "));
    return { message, total: counted.total, failed };
  };

  let outcome = await runChainOnce();
  if (!isNag) return;

  for (;;) {
    // macOS dialogs top out at three buttons, so on a failure "Thử lại"
    // takes the slot (and the default) that "Mở app" normally holds.
    const buttons = outcome.failed ? ["Để sau", "Thử lại", "Đã đối soát xong"] : ["Để sau", "Mở app", "Đã đối soát xong"];
    const choice = askApproval(outcome.message, Number(process.env.GRAB_DIALOG_TIMEOUT || 240), buttons, outcome.failed ? "Thử lại" : "Mở app");
    if (choice === "Đã đối soát xong") {
      state[key] = { approvedAt: new Date().toISOString(), via: "dialog", reports: outcome.total };
      await writeState(state);
      notify("Đối soát sàn", `Ngày ${key}: DONE. Không nhắc lại nữa.`);
      console.log(`${key}: DONE.`);
      return;
    }
    if (choice === "Thử lại") {
      notify("Đối soát sàn", "Đang chạy lại chuỗi export SAPO + tải mail…");
      console.log("Chọn: Thử lại — chạy lại chuỗi.");
      outcome = await runChainOnce();
      continue;
    }
    if (choice === "Mở app") await openApp();
    console.log(choice ? `Chọn: ${choice} — sẽ nhắc lại ở lượt sau.` : "Không trả lời — sẽ nhắc lại ở lượt sau.");
    return;
  }
}

main().catch((error) => {
  console.error("Lỗi:", error?.message || error);
  process.exit(1);
});

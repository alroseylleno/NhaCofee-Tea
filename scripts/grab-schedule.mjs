#!/usr/bin/env node
// Installs the nightly đối soát reminder as a macOS LaunchAgent.
//
//   npm run grab:schedule           # install / reinstall
//   npm run grab:schedule -- off    # remove
//   npm run grab:schedule -- status
//
// Fires every 30 minutes from 22:00 to 23:30 local time. The last slot is 23:30
// rather than 23:59 so a tick can never land after midnight and get filed under
// tomorrow's date. Each tick exits immediately once the day is approved.

import { spawnSync } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
const LABEL = "com.nhaops.grab-daily";
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const LOG_DIR = path.join(projectRoot, ".grab-state");

const START_HOUR = 22;
const END_HOUR = 23;
const STEP_MINUTES = 30;

function slots() {
  const entries = [];
  for (let hour = START_HOUR; hour <= END_HOUR; hour++) {
    for (let minute = 0; minute < 60; minute += STEP_MINUTES) entries.push({ hour, minute });
  }
  return entries;
}

function plistBody() {
  const calendar = slots()
    .map(({ hour, minute }) => `      <dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`)
    .join("\n");
  // launchd gets a bare PATH, and node lives under nvm here, so the interpreter
  // must be the absolute path this install was run with.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${process.execPath}</string>
      <string>${path.join(here, "grab-daily-check.mjs")}</string>
      <string>--nag</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>StartCalendarInterval</key>
    <array>
${calendar}
    </array>
    <key>StandardOutPath</key>
    <string>${path.join(LOG_DIR, "reminder.log")}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(LOG_DIR, "reminder.log")}</string>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`;
}

function launchctl(...args) {
  return spawnSync("/bin/launchctl", args, { encoding: "utf8" });
}

function guiTarget() {
  return `gui/${process.getuid()}`;
}

async function install() {
  await mkdir(path.dirname(PLIST), { recursive: true });
  await mkdir(LOG_DIR, { recursive: true });
  // bootout first so a reinstall picks up an edited schedule instead of silently
  // keeping the previously loaded definition.
  launchctl("bootout", `${guiTarget()}/${LABEL}`);
  await writeFile(PLIST, plistBody());
  const result = launchctl("bootstrap", guiTarget(), PLIST);
  if (result.status !== 0) {
    console.error("launchctl bootstrap thất bại:", (result.stderr || result.stdout || "").trim());
    process.exit(1);
  }
  const times = slots().map(({ hour, minute }) => `${hour}:${String(minute).padStart(2, "0")}`).join(", ");
  console.log(`Đã bật nhắc đối soát hàng đêm (${LABEL}).`);
  console.log(`Giờ nhắc: ${times}`);
  console.log(`Plist: ${PLIST}`);
  console.log(`Log:   ${path.join(LOG_DIR, "reminder.log")}`);
  console.log("\nMỗi lượt sẽ tự tải báo cáo Grab mới rồi hiện hộp thoại. Bấm \"Đã đối soát xong\" là dừng nhắc cho ngày đó.");
}

async function uninstall() {
  launchctl("bootout", `${guiTarget()}/${LABEL}`);
  try {
    await unlink(PLIST);
  } catch {
    // Already gone is a fine end state.
  }
  console.log(`Đã tắt nhắc đối soát hàng đêm (${LABEL}).`);
}

async function status() {
  const result = launchctl("print", `${guiTarget()}/${LABEL}`);
  if (result.status !== 0) {
    console.log(`${LABEL}: CHƯA cài. Chạy \`npm run grab:schedule\` để bật.`);
    return;
  }
  const state = (result.stdout.match(/state = (.+)/) || [])[1]?.trim() || "?";
  const runs = (result.stdout.match(/runs = (\d+)/) || [])[1] || "0";
  const lastExit = (result.stdout.match(/last exit code = (.+)/) || [])[1]?.trim();
  console.log(`${LABEL}: đã cài · state=${state} · đã chạy ${runs} lượt${lastExit && lastExit !== "(never exited)" ? ` · last exit=${lastExit}` : ""}`);
  console.log(`Giờ nhắc: ${slots().map(({ hour, minute }) => `${hour}:${String(minute).padStart(2, "0")}`).join(", ")}`);
  try {
    const log = await readFile(path.join(LOG_DIR, "reminder.log"), "utf8");
    const tail = log.trimEnd().split("\n").slice(-3);
    if (tail.length && tail[0]) console.log(`\nLog gần nhất:\n  ${tail.join("\n  ")}`);
  } catch {
    console.log("\nChưa có log — chưa chạy lượt nào.");
  }
}

const command = (process.argv[2] || "on").toLowerCase();
if (command === "off" || command === "uninstall") await uninstall();
else if (command === "status") await status();
else await install();

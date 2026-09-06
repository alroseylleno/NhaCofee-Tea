#!/usr/bin/env node
// Interactive credential setup, so nobody has to hunt for a hidden dotfile.
//
//   npm run grab:setup
//
// Writes GRAB_MAIL_USER and GRAB_MAIL_APP_PASSWORD into .env.local, replacing
// them if they already exist and leaving every other line untouched. The
// password is read with echo off, so it never lands in the terminal scrollback
// or in shell history the way an inline `echo ... >> .env.local` would.

import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(here, "..");
const ENV_FILE = path.join(projectRoot, ".env.local");

function ask(query, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Print the prompt normally, then swallow the echo of what gets typed.
    rl._writeToOutput = (chunk) => {
      if (rl.hidden) return;
      rl.output.write(chunk);
    };
    rl.question(query, (answer) => {
      if (hidden) rl.output.write("\n");
      rl.close();
      resolve(answer.trim());
    });
    rl.hidden = hidden;
  });
}

/// Replace the key in place when present, otherwise append it, so re-running
/// setup updates credentials instead of stacking duplicate lines.
function upsertEnv(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=.*$`, "m");
  if (pattern.test(contents)) return contents.replace(pattern, line);
  return `${contents.replace(/\s*$/, "")}\n${line}\n`;
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error("Lệnh này cần chạy trực tiếp trong Terminal (cần nhập tay).");
    process.exit(1);
  }

  let existing = "";
  try {
    existing = await readFile(ENV_FILE, "utf8");
  } catch {
    console.log("Chưa có .env.local — sẽ tạo mới.");
  }

  const currentUser = (existing.match(/^\s*GRAB_MAIL_USER\s*=\s*(.*)$/m) || [])[1]?.trim();
  console.log("\nNhập thông tin hộp thư nhận báo cáo Grab.\n");

  const user = (await ask(`Địa chỉ Gmail${currentUser ? ` [${currentUser}]` : ""}: `)) || currentUser || "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user)) {
    console.error(`\nĐịa chỉ không hợp lệ: "${user}"`);
    process.exit(1);
  }

  const rawPassword = await ask("App Password 16 ký tự (gõ/dán, màn hình sẽ không hiện gì): ", { hidden: true });
  // Google shows the password as "abcd efgh ijkl mnop"; pasting it verbatim is
  // the most common setup mistake, so normalise instead of rejecting.
  const password = rawPassword.replace(/\s+/g, "");
  if (!password) {
    console.error("\nChưa nhập gì cả.");
    process.exit(1);
  }
  if (password.length !== 16) {
    console.error(`\nApp Password phải đúng 16 ký tự, vừa nhận ${password.length}. Đây là mật khẩu Gmail thường à?`);
    process.exit(1);
  }

  let next = upsertEnv(existing, "GRAB_MAIL_USER", user);
  next = upsertEnv(next, "GRAB_MAIL_APP_PASSWORD", password);
  await writeFile(ENV_FILE, next);
  await chmod(ENV_FILE, 0o600);

  console.log(`\nĐã lưu vào ${ENV_FILE} (quyền 600, chỉ Long đọc được).`);
  console.log(`  GRAB_MAIL_USER=${user}`);
  console.log(`  GRAB_MAIL_APP_PASSWORD=${"*".repeat(16)}`);
  console.log("\nFile này đã nằm trong .gitignore, không lên GitHub.");
  console.log("\nBước tiếp: npm run grab:uat -- --days 30");
}

main().catch((error) => {
  console.error("Lỗi:", error?.message || error);
  process.exit(1);
});

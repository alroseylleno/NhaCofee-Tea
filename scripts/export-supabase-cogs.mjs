#!/usr/bin/env node
// Export toàn bộ dữ liệu Product Master / công thức / nguyên liệu từ Supabase Production
// để phân tích COGS offline. CHỈ ĐỌC — không ghi gì lên DB.
//
// Chạy:   node scripts/export-supabase-cogs.mjs
// Auth:   dùng GRAB_SUPABASE_EMAIL / GRAB_SUPABASE_PASSWORD trong .env.local nếu có,
//         nếu không sẽ hỏi email/password ngay trong terminal (password không hiện ký tự).
//         Đăng nhập bằng account Supabase thường (chịu RLS `authenticated`) — không cần service_role.
// Output: .grab-state/supabase-export/<bảng>.json  (+ _summary.json)
//         Thư mục .grab-state/ đã nằm trong .gitignore nên dump không bao giờ bị commit.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import readline from "node:readline";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, ".grab-state", "supabase-export");

const TABLES = [
  "stores",
  "ingredient_master",
  "product_master",
  "product_recipe_versions",
  "product_recipe_items",
  "product_catalog_exclusions",
  "finance_counter_prices",
];

function loadEnvLocal() {
  const env = {};
  try {
    for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {
    // .env.local không tồn tại — sẽ báo thiếu URL/key bên dưới
  }
  return env;
}

function ask(question, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (mask) {
      const write = rl._writeToOutput.bind(rl);
      rl._writeToOutput = (s) => write(s.includes(question) ? s : "*");
    }
    rl.question(question, (answer) => {
      rl.close();
      if (mask) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function signIn(url, apikey, email, password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Đăng nhập thất bại (${res.status}): ${body.error_description || body.msg || body.error || "không rõ lý do"}`);
  }
  return body.access_token;
}

async function fetchAllRows(url, apikey, token, table) {
  const PAGE = 1000;
  const rows = [];
  let order = "&order=id.asc";
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(`${url}/rest/v1/${table}?select=*${order}`, {
      headers: {
        apikey,
        Authorization: `Bearer ${token}`,
        Range: `${from}-${from + PAGE - 1}`,
        Prefer: "count=exact",
      },
    });
    if (res.status === 404) return { missing: true, rows: [] };
    if (!res.ok) {
      const text = await res.text();
      if (order && text.includes("42703")) {
        order = "";
        from -= PAGE;
        continue;
      }
      throw new Error(`${table}: HTTP ${res.status} — ${text}`);
    }
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return { missing: false, rows };
}

const env = { ...loadEnvLocal(), ...process.env };
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const apikey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !apikey) {
  console.error("Thiếu NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY trong .env.local");
  process.exit(1);
}

if ((!env.GRAB_SUPABASE_EMAIL || !env.GRAB_SUPABASE_PASSWORD) && !process.stdin.isTTY) {
  console.error("Thiếu GRAB_SUPABASE_EMAIL / GRAB_SUPABASE_PASSWORD (trong .env.local hoặc biến môi trường) và không có terminal để hỏi.");
  process.exit(1);
}
const email = env.GRAB_SUPABASE_EMAIL || (await ask("Email Supabase: "));
const password = env.GRAB_SUPABASE_PASSWORD || (await ask("Password Supabase: ", { mask: true }));

console.log(`Đăng nhập ${url} ...`);
let token;
try {
  token = await signIn(url, apikey, email, password);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log("Đăng nhập OK. Bắt đầu export (chỉ đọc)...\n");

mkdirSync(OUT_DIR, { recursive: true });
const summary = { exportedAt: new Date().toISOString(), url, tables: {} };

for (const table of TABLES) {
  try {
    const { missing, rows } = await fetchAllRows(url, apikey, token, table);
    if (missing) {
      console.log(`  ${table}: bảng không tồn tại — bỏ qua`);
      summary.tables[table] = "missing";
      continue;
    }
    writeFileSync(join(OUT_DIR, `${table}.json`), JSON.stringify(rows, null, 2));
    console.log(`  ${table}: ${rows.length} dòng`);
    summary.tables[table] = rows.length;
  } catch (err) {
    console.log(`  ${table}: LỖI — ${err.message}`);
    summary.tables[table] = `error: ${err.message}`;
  }
}

writeFileSync(join(OUT_DIR, "_summary.json"), JSON.stringify(summary, null, 2));
console.log(`\nXong. File nằm ở: ${OUT_DIR}`);
console.log("Gửi lại cho Claude dòng tổng kết phía trên là đủ — Claude sẽ tự đọc các file JSON.");

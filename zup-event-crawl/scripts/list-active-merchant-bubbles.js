#!/usr/bin/env node
"use strict";

const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { listImportedMerchants } = require("../lib/merchant-db");
const { BuzzAdminClient } = require("../lib/buzz-now-import");

const root = path.join(__dirname, "..");
const db = openDatabase(path.join(root, "data", "review.db"));
const buzzEnv = "prod";
const city = process.argv[2] || "北京";

function parseBuzzDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : null;
}

function isExpired(expiredAt) {
  const ts = parseBuzzDateTime(expiredAt);
  if (ts == null) return false;
  return ts <= Date.now();
}

async function main() {
  const merchants = listImportedMerchants(db, { buzz_env: buzzEnv }).filter((m) => {
    const c = String(m.city || "").trim() || "未分类";
    return c === city;
  });

  const withLocal = merchants.filter((m) => m.bubble_now_id);
  const client = new BuzzAdminClient({ buzz_env: buzzEnv });

  const active = [];
  const expired = [];
  const missing = [];
  const errors = [];

  for (const m of withLocal) {
    try {
      const now = await client.getNowById(m.bubble_now_id);
      if (!now) {
        missing.push(m);
        continue;
      }
      const row = {
        name: m.name,
        merchant_uid: m.merchant_uid,
        bubble_now_id: m.bubble_now_id,
        bubble_published_at: m.bubble_published_at || "",
        expired_at: now.expired_at || "",
        title: now.title || now.content || "",
        group_id: m.buzz_group_id || "",
        temp_group: /RC4T/i.test(m.buzz_group_id || ""),
      };
      if (isExpired(now.expired_at)) expired.push(row);
      else active.push(row);
    } catch (e) {
      errors.push({ name: m.name, bubble_now_id: m.bubble_now_id, error: e.message });
    }
  }

  active.sort((a, b) => String(a.bubble_published_at).localeCompare(String(b.bubble_published_at)));

  console.log(`\n=== ${city} · ${buzzEnv} · 未过期气泡明细 ===\n`);
  console.log(`入库商户 ${merchants.length} 家 · 本地有气泡记录 ${withLocal.length} 家`);
  console.log(`Buzz 仍在线（未过期）: ${active.length} 家`);
  console.log(`已过期（本地仍有记录）: ${expired.length} 家`);
  console.log(`Buzz 查不到: ${missing.length} 家 · API 失败: ${errors.length} 家\n`);

  active.forEach((r, i) => {
    console.log(`${i + 1}. ${r.name}`);
    console.log(`   发布时间: ${r.bubble_published_at || "—"}`);
    console.log(`   过期时间: ${r.expired_at || "—"}`);
    console.log(`   气泡ID: ${r.bubble_now_id}`);
    console.log(`   群ID: ${r.group_id}${r.temp_group ? " (临时群RC4T)" : ""}`);
    if (r.title) console.log(`   标题: ${String(r.title).slice(0, 60)}`);
    console.log("");
  });

  if (expired.length) {
    console.log(`--- 已过期但本地仍有记录 (${expired.length}) ---`);
    expired.slice(0, 5).forEach((r) => console.log(`  · ${r.name} (${r.expired_at})`));
    if (expired.length > 5) console.log(`  … 另有 ${expired.length - 5} 家`);
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

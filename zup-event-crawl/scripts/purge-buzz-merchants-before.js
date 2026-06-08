#!/usr/bin/env node
"use strict";

/**
 * 删除 Buzz 测试环境中 created_at 早于指定日期的商户。
 *
 * 用法:
 *   node scripts/purge-buzz-merchants-before.js [--before=2026-01-01] [--dry-run]
 */

const path = require("path");
const { BuzzAdminClient } = require("../lib/buzz-now-import");
const { openDatabase } = require("../lib/merchant-db");

function parseArgs(argv) {
  const options = {
    before: "2026-01-01",
    dryRun: false,
    delayMs: 300,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--before=")) options.before = arg.slice("--before=".length);
    else if (arg.startsWith("--delay-ms=")) options.delayMs = Number(arg.slice("--delay-ms=".length)) || 300;
    else if (arg === "--help" || arg === "-h") {
      console.log(`用法:
  node scripts/purge-buzz-merchants-before.js [--before=2026-01-01] [--dry-run] [--delay-ms=300]
`);
      process.exit(0);
    }
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listMerchantsBefore(client, cutoff) {
  const targets = [];
  let page = 1;
  let total = Infinity;
  while ((page - 1) * 100 < total) {
    const data = await client.postJSON("/merchants/list", { page, size: 100, keyword: "" });
    total = data?.pagination?.total || 0;
    for (const item of data?.list || []) {
      const created = new Date(item.created_at);
      if (!Number.isNaN(created.getTime()) && created < cutoff) {
        targets.push({
          merchant_id: item.merchant_id,
          name: item.name,
          created_at: item.created_at,
        });
      }
    }
    page += 1;
    if (!data?.list?.length) break;
  }
  return targets;
}

function clearLocalBuzzMerchantIds(db, merchantIds) {
  if (!merchantIds.length) return 0;
  const placeholders = merchantIds.map(() => "?").join(",");
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE merchants SET
      buzz_merchant_id = '',
      import_status = '',
      import_error = '',
      imported_at = NULL,
      buzz_group_id = '',
      bubble_now_id = '',
      bubble_published_at = NULL,
      updated_at = ?
    WHERE buzz_merchant_id IN (${placeholders})
  `).run(now, ...merchantIds);
  return result.changes;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cutoff = new Date(`${options.before}T00:00:00+08:00`);
  if (Number.isNaN(cutoff.getTime())) {
    throw new Error(`无效日期: ${options.before}`);
  }

  const client = new BuzzAdminClient();
  const targets = await listMerchantsBefore(client, cutoff);
  console.log(`Buzz 商户 created_at < ${options.before}：共 ${targets.length} 条`);

  if (!targets.length) return;

  if (options.dryRun) {
    for (const item of targets) {
      console.log(`[dry-run] ${item.created_at} ${item.merchant_id} ${item.name}`);
    }
    return;
  }

  let ok = 0;
  let fail = 0;
  const deletedIds = [];

  for (const item of targets) {
    try {
      await client.deleteJSON(`/merchants/${encodeURIComponent(item.merchant_id)}`);
      deletedIds.push(item.merchant_id);
      ok += 1;
      console.log(`✓ 已删 ${item.merchant_id} ${item.name}`);
    } catch (error) {
      fail += 1;
      console.error(`✗ 失败 ${item.merchant_id} ${item.name}: ${error.message}`);
    }
    if (options.delayMs > 0) await sleep(options.delayMs);
  }

  const dbPath = path.join(__dirname, "..", "data", "review.db");
  const db = openDatabase(dbPath);
  const localCleared = clearLocalBuzzMerchantIds(db, deletedIds);

  console.log(`完成：删除 ${ok} / 失败 ${fail}；本地库清除关联 ${localCleared} 条`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

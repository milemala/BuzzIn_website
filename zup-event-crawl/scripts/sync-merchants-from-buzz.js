#!/usr/bin/env node
"use strict";

/**
 * 从 Buzz 后台拉取商户，补全到审核台 review.db（默认正式环境）。
 * 同 POI 且 merchant_id 不同时，删除审核台本地旧记录后以正式商户为准写入。
 *
 * 用法:
 *   node scripts/sync-merchants-from-buzz.js [--env=prod] [--dry-run] [--status=1]
 */

const path = require("path");
const { openDatabase } = require("../lib/merchant-db");
const { syncMerchantsFromBuzz } = require("../lib/buzz-merchant-sync");

function parseArgs(argv) {
  const options = {
    env: "prod",
    dryRun: false,
    status: 1,
  };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--env=")) options.env = arg.slice("--env=".length);
    else if (arg.startsWith("--status=")) {
      const value = arg.slice("--status=".length);
      options.status = value === "" ? undefined : Number(value);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`用法:
  node scripts/sync-merchants-from-buzz.js [--env=prod] [--dry-run] [--status=1]

说明:
  从 Buzz 后台拉取商户写入审核台，并标记为已入库（不重复创建后台商户）。
  若正式商户与本地商户 POI 相同但 merchant_id 不同，会删除审核台本地旧记录。
`);
      process.exit(0);
    }
  }
  return options;
}

function printReport(report) {
  const prefix = report.dry_run ? "[dry-run] " : "";
  console.log(`${prefix}环境: ${report.buzz_env}`);
  console.log(`${prefix}拉取: ${report.fetched}  新增: ${report.created}  跳过: ${report.skipped}  删除: ${report.deleted}  失败: ${report.errors.length}`);

  if (report.deleted_items.length) {
    console.log("\n删除（POI 冲突）:");
    for (const item of report.deleted_items.slice(0, 20)) {
      console.log(`  - ${item.name} (${item.merchant_uid}) poi=${item.address_poi_id} → 正式 ${item.replaced_by_merchant_id}`);
    }
    if (report.deleted_items.length > 20) {
      console.log(`  ... 另有 ${report.deleted_items.length - 20} 条`);
    }
  }

  if (report.created_items.length) {
    console.log("\n新增:");
    for (const item of report.created_items.slice(0, 20)) {
      console.log(`  + ${item.name} (${item.merchant_id}) city=${item.city || "—"}`);
    }
    if (report.created_items.length > 20) {
      console.log(`  ... 另有 ${report.created_items.length - 20} 条`);
    }
  }

  if (report.errors.length) {
    console.log("\n失败:");
    for (const item of report.errors) {
      console.error(`  ✗ ${item.name} (${item.merchant_id}): ${item.error}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = path.join(__dirname, "..", "data", "review.db");
  const db = openDatabase(dbPath);
  const report = await syncMerchantsFromBuzz(db, {
    buzz_env: options.env,
    dry_run: options.dryRun,
    status: options.status,
  });
  printReport(report);
  if (report.errors.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

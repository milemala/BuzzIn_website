#!/usr/bin/env node
"use strict";

const path = require("path");
const { openDatabase } = require("../lib/merchant-db");
const { batchAutoPoi } = require("../lib/merchant-poi-batch");

const root = path.join(__dirname, "..");
const defaultDbPath = path.join(root, "data", "review.db");

function parseArgs(argv) {
  const options = {
    dbPath: defaultDbPath,
    approved: false,
    pending: false,
    refresh: false,
    city: "",
    limit: 500,
  };
  for (const arg of argv) {
    if (arg === "--approved") options.approved = true;
    else if (arg === "--pending") options.pending = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length);
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(`批量补全腾讯 POI（Top1）

  node scripts/batch-poi-merchants.js --approved     # 已通过、缺 POI 的商户
  node scripts/batch-poi-merchants.js --pending      # 待定、缺 POI 的商户
  node scripts/batch-poi-merchants.js                # 全部缺 POI 的商户

可选：--city=上海  --limit=200  --refresh  --db=path`);
      process.exit(0);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dbPath = path.isAbsolute(options.dbPath)
    ? options.dbPath
    : path.join(root, options.dbPath);
  const db = openDatabase(dbPath);

  const scope = options.approved
    ? "已通过"
    : options.pending
      ? "待定"
      : "全部";

  console.log(`批量 POI · ${scope} · ${dbPath}`);
  if (options.city) console.log(`城市筛选: ${options.city}`);
  if (options.refresh) console.log("模式: 强制重新查询（含已有 POI）");

  const report = await batchAutoPoi(db, {
    city: options.city,
    only_approved: options.approved,
    only_pending: options.pending && !options.approved,
    refresh: options.refresh,
    limit: options.limit,
  });

  console.log(`\n完成: ${report.ok} 成功 / ${report.fail} 失败 / 共 ${report.total} 家`);
  for (const row of report.results) {
    if (row.ok) {
      console.log(`  ✓ ${row.city || ""} ${row.name} → ${row.poi_title}`);
    } else {
      console.log(`  ✗ ${row.city || ""} ${row.name} — ${row.error}`);
    }
  }
}

main().catch((error) => {
  console.error(`批量 POI 失败: ${error.message}`);
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

const path = require("path");
const {
  applyDefaultImportPrepToActiveEvents,
  openDatabase,
  syncEventPoiCoordinates,
} = require("../lib/review-db");
const { batchEventAutoPoi } = require("../lib/event-poi-batch");

const root = path.join(__dirname, "..");
const dbPath = path.join(root, "data", "review.db");

function parseArgs(argv) {
  const options = {
    skipPoi: false,
    refresh: false,
    city: "",
    onlyApproved: false,
    limit: 500,
  };
  for (const arg of argv) {
    if (arg === "--skip-poi") options.skipPoi = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--approved") options.onlyApproved = true;
    else if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length);
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length)) || 500;
    else if (arg === "--help" || arg === "-h") {
      console.log(`用法:
  node scripts/batch-event-import-prep.js [选项]

为所有未过期活动写入默认入库字段（发布者 579362104、now_type=3），并批量搜索 POI Top1。

选项:
  --skip-poi      只写默认字段，不查 POI
  --refresh       已有 POI 也重新搜索覆盖
  --approved      仅处理人工已通过的活动
  --city=长沙     限定城市
  --limit=100     最多处理条数
`);
      process.exit(0);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = openDatabase(dbPath);

  const defaults = applyDefaultImportPrepToActiveEvents(db);
  console.log(`默认入库字段已写入 ${defaults.updated} 条未过期活动`);

  if (options.skipPoi) {
    console.log("已跳过 POI 搜索（--skip-poi）");
    return;
  }

  const report = await batchEventAutoPoi(db, {
    city: options.city,
    only_approved: options.onlyApproved,
    refresh: options.refresh,
    limit: options.limit,
  });

  const synced = syncEventPoiCoordinates(db);
  console.log(`POI 坐标同步：${synced.updated}/${synced.total} 条`);
  console.log(`POI: ${report.ok} 成功 / ${report.fail} 失败 / 共 ${report.total} 条`);
  for (const row of report.results) {
    if (row.ok) {
      console.log(`  ✓ ${row.city || ""} ${row.title} → ${row.poi_title} (${row.poi_id})`);
    } else {
      console.log(`  ✗ ${row.city || ""} ${row.title} — ${row.error}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

/**
 * 为未过期活动写入默认入库字段（发布者、now_type）。
 * POI 不在此脚本处理——必须由 Cursor Agent 匹配，见 docs/event-poi-agent-workflow.md
 */
const path = require("path");
const { applyDefaultImportPrepToActiveEvents, openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const dbPath = path.join(root, "data", "review.db");

function parseArgs(argv) {
  const options = { city: "" };
  for (const arg of argv) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log(`用法:
  node scripts/batch-event-import-prep.js

为所有未过期活动写入默认入库字段（发布者 854508330、now_type 按是否已开始默认 2/3）。

POI 请由 Cursor Agent 处理：
  export-events-for-poi.js → poi-search-cli.js → decisions.json → apply-event-poi-decisions.js
见 docs/event-poi-agent-workflow.md
`);
      process.exit(0);
    } else if (arg === "--skip-poi" || arg === "--refresh" || arg === "--approved") {
      console.warn(`[已忽略] ${arg}：本脚本不再包含 JS 自动 POI`);
    }
  }
  return options;
}

function main() {
  parseArgs(process.argv.slice(2));
  const db = openDatabase(dbPath);
  const defaults = applyDefaultImportPrepToActiveEvents(db);
  db.close();
  console.log(`默认入库字段已写入 ${defaults.updated} 条未过期活动`);
  console.log("POI 请由 Cursor Agent 匹配，见 docs/event-poi-agent-workflow.md");
}

main();

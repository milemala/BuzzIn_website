#!/usr/bin/env node
"use strict";

/**
 * 导出待 Agent 分类/挡下的活动，供 Cursor 大模型判断。
 *
 *   node scripts/export-events-for-classification.js --city=深圳
 *   node scripts/export-events-for-classification.js --city=上海 --source=xiaohongshu
 *   node scripts/export-events-for-classification.js --source=xiaohongshu --all-cities
 */
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const {
  exportAllPendingClassification,
  exportClassificationPending,
} = require("../lib/export-classification-pending");

const defaultDb = path.join(__dirname, "..", "data", "review.db");

function parseArgs(argv) {
  const options = {
    city: "",
    source: "douban",
    dbPath: defaultDb,
    refresh: false,
    allCities: false,
    limit: 2000,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length).trim() || "douban";
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--all-cities") options.allCities = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length)) || 2000;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  if (!options.city && !options.allCities) {
    throw new Error("请指定 --city=城市名 或 --all-cities");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  try {
    if (options.allCities) {
      const results = exportAllPendingClassification(db, {
        source: options.source,
        refresh: options.refresh,
        limit: options.limit,
      });
      const total = results.reduce((sum, item) => sum + item.count, 0);
      for (const item of results) {
        console.log(`已导出 ${item.count} 条 → ${item.outPath}`);
      }
      console.log(`合计 ${total} 条（${options.source} · ${results.length} 城）`);
      return;
    }

    const result = exportClassificationPending(db, {
      city: options.city,
      source: options.source,
      refresh: options.refresh,
      limit: options.limit,
    });
    console.log(`已导出 ${result.count} 条 → ${result.outPath}`);
  } finally {
    db.close();
  }
}

main();

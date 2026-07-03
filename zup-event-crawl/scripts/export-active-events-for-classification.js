#!/usr/bin/env node
"use strict";

/**
 * 导出全部未过期活动，供 Agent 重分类（含已 agent 分类过的，强制 refresh）。
 *
 *   node scripts/export-active-events-for-classification.js
 *   node scripts/export-active-events-for-classification.js --city=深圳 --source=douban
 */
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const {
  exportActiveClassificationPending,
  exportAllActiveClassification,
  listActiveClassificationGroups,
} = require("../lib/export-classification-pending");

const defaultDb = path.join(__dirname, "..", "data", "review.db");

function parseArgs(argv) {
  const options = {
    city: "",
    source: "",
    dbPath: defaultDb,
    allCities: true,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length).trim();
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (arg === "--all-cities") options.allCities = true;
  }
  if (options.city) options.allCities = false;
  return options;
}

function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  try {
    if (options.city) {
      const result = exportActiveClassificationPending(db, {
        city: options.city,
        source: options.source || "douban",
      });
      console.log(`已导出 ${result.count} 条未过期 → ${result.outPath}`);
      return;
    }

    const groups = listActiveClassificationGroups(db);
    const results = exportAllActiveClassification(db, {
      source: options.source,
      groups,
    });
    const total = results.reduce((sum, item) => sum + item.count, 0);
    for (const item of results) {
      console.log(`${item.city} · ${item.source} · ${item.count} 条 → ${item.outPath}`);
    }
    console.log(`\n合计 ${total} 条未过期 · ${results.length} 个城/来源`);
  } finally {
    db.close();
  }
}

main();

#!/usr/bin/env node
"use strict";

/**
 * 导出 POI 任务（按地址去重），供 Cursor Agent 处理。
 *
 *   node scripts/export-events-for-poi.js --city=深圳 --refresh --pending-only --new-import-only
 *   node scripts/export-events-for-poi.js --city=上海 --source=xiaohongshu --refresh --pending-only
 */
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { exportPoiPending } = require("../lib/export-poi-pending");

const defaultDb = path.join(__dirname, "..", "data", "review.db");

function parseArgs(argv) {
  const options = {
    city: "",
    source: "douban",
    dbPath: defaultDb,
    refresh: false,
    pendingOnly: false,
    doubtfulOnly: false,
    newImportOnly: false,
    limit: 2000,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length).trim() || "douban";
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--pending-only") options.pendingOnly = true;
    else if (arg === "--new-import-only") options.newImportOnly = true;
    else if (arg === "--doubtful-only") options.doubtfulOnly = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length)) || 2000;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (!arg.startsWith("--") && arg.endsWith(".db")) options.dbPath = arg;
  }
  if (!options.city) {
    throw new Error("请指定 --city=城市名");
  }
  if (options.pendingOnly && options.doubtfulOnly) {
    throw new Error("--pending-only 与 --doubtful-only 不能同时使用");
  }
  if (options.newImportOnly && !options.pendingOnly) {
    throw new Error("--new-import-only 须与 --pending-only 一起使用");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  try {
    const result = exportPoiPending(db, {
      city: options.city,
      source: options.source,
      dbPath: options.dbPath,
      refresh: options.refresh,
      pendingOnly: options.pendingOnly,
      doubtfulOnly: options.doubtfulOnly,
      newImportOnly: options.newImportOnly,
      limit: options.limit,
    });
    const modeLabel = options.doubtfulOnly
      ? "存疑复核"
      : (options.newImportOnly ? "本轮新入库未匹配 POI" : (options.pendingOnly ? "未匹配 POI" : "无 POI"));
    const cacheNote = result.cacheHits ? ` · 映射库命中 ${result.cacheHits} 组` : "";
    console.log(`已导出 [${modeLabel}] ${result.totalEvents} 条活动 · ${result.groupCount} 个地址组${cacheNote} → ${result.outPath}`);
  } finally {
    db.close();
  }
}

main();

#!/usr/bin/env node
"use strict";

/**
 * 将 data/scrape-cache/xhs/<城市>/<笔记ID>/events-extracted.json 入库审核台。
 *
 * - 有 poster：豆瓣同款 4:3 左图右文封面，image_original 保留裁切海报本地路径
 * - 无 poster：xhs-text-cover-compose 文字封面，image_original 保留原 slide（如有）
 * - 来源 source=xiaohongshu，不与豆瓣活动冲突（append-city 仅 upsert）
 * - 跳过 POI 匹配
 *
 * 用法:
 *   node scripts/import-xhs-events-to-review.js [review.db] [--city=上海] [--dry-run]
 */

const path = require("path");
const { importPayload, openDatabase } = require("../lib/review-db");
const { buildImportPayload, loadAllXhsReviewEvents } = require("../lib/xhs-review-import");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const city = args.find((arg) => arg.startsWith("--city="))?.split("=")[1] || null;
const dbPath = args.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

async function main() {
  console.log(`小红书活动入库 → ${path.resolve(dbPath)}${dryRun ? "（dry-run）" : ""}`);
  if (city) console.log(`仅城市：${city}`);

  const loadResult = await loadAllXhsReviewEvents(root, { city, dryRun, log: true });
  if (!loadResult.allEvents.length) {
    console.error("\n未找到可入库的小红书活动（需先有 events-extracted.json）");
    process.exit(2);
  }

  const payload = buildImportPayload(loadResult);
  console.log("\n汇总：");
  console.log(`  笔记 ${loadResult.totals.notes} 篇 · 活动 ${loadResult.totals.events} 条`);
  console.log(`  海报封面 ${loadResult.totals.poster} · 文字封面 ${loadResult.totals.text} · 封面失败 ${loadResult.totals.fail}`);
  for (const [name, info] of Object.entries(loadResult.byCity)) {
    console.log(`  ${name}: ${info.events.length} 条`);
  }

  if (dryRun) {
    console.log("\ndry-run 完成，未写入数据库。");
    return;
  }

  const db = openDatabase(dbPath);
  try {
    importPayload(db, payload, { mode: "append-city" });
  } finally {
    db.close();
  }

  console.log(`\n已入库 ${loadResult.allEvents.length} 条小红书活动（mode=append-city，未动 POI）`);
  console.log("审核台：npm start → http://127.0.0.1:8787/ （来源筛选选「小红书」）");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

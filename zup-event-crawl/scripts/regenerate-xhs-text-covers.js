#!/usr/bin/env node
"use strict";

/**
 * 批量重生成小红书「无海报 → 文字封面」活动的 4:3 封面（江城律动圆 + 随机底图 + 标题/CTA）。
 *
 * 范围：审核已通过、未过期、image_original 指向原 slide（/images/）而非裁切海报（/posters/）。
 *
 * 用法:
 *   node scripts/regenerate-xhs-text-covers.js
 *   node scripts/regenerate-xhs-text-covers.js --dry-run
 *   node scripts/regenerate-xhs-text-covers.js --city=上海
 */

const path = require("path");
const { batchRegenerateXhsTextCovers } = require("../lib/regenerate-xhs-text-covers-batch");
const { openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const cityArg = argv.find((arg) => arg.startsWith("--city="));
const city = cityArg ? cityArg.slice("--city=".length) : "";
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

async function main() {
  const db = openDatabase(dbPath);
  const report = await batchRegenerateXhsTextCovers(db, {
    city: city || undefined,
    dryRun,
    rootDir: root,
  });
  db.close();

  const label = city || "全部城市";
  if (dryRun) {
    console.log(`[dry-run] 将重生成 ${report.dry_run} 条${label}无海报文字封面（共匹配 ${report.total} 条）`);
  } else {
    console.log(`已重生成 ${report.ok} 条${label}无海报文字封面（共 ${report.total} 条，失败 ${report.fail}，无标题跳过 ${report.skip_no_title}）`);
    if (report.fail > 0) {
      for (const item of report.items.filter((i) => i.status === "fail")) {
        console.error(`  ✗ ${item.record.title}（${item.record.city}）: ${item.error}`);
      }
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

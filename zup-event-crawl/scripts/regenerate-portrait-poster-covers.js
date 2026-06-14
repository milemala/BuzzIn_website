#!/usr/bin/env node
"use strict";

/**
 * 批量重生成「竖图 ≤4:5」左右分屏海报封面（模糊底图 + 左海报 + 右标题/CTA）。
 *
 * 范围：审核已通过、未过期、有海报原图（非小红书无海报文字封面）、原图宽高比 ≤4:5。
 *
 * 用法:
 *   node scripts/regenerate-portrait-poster-covers.js
 *   node scripts/regenerate-portrait-poster-covers.js --dry-run
 *   node scripts/regenerate-portrait-poster-covers.js --city=上海
 */

const path = require("path");
const { batchRegeneratePortraitPosterCovers } = require("../lib/regenerate-portrait-poster-covers-batch");
const { openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const cityArg = argv.find((arg) => arg.startsWith("--city="));
const city = cityArg ? cityArg.slice("--city=".length) : "";
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

async function main() {
  const db = openDatabase(dbPath);
  const report = await batchRegeneratePortraitPosterCovers(db, {
    city: city || undefined,
    dryRun,
    rootDir: root,
  });
  db.close();

  const label = city || "全部城市";
  if (dryRun) {
    console.log(
      `[dry-run] ${label}：候选 ${report.candidates} 条，竖图待重生成 ${report.dry_run} 条`
      + `（跳过宽图 ${report.skip_landscape}、无原图 ${report.skip_no_source}、无标题 ${report.skip_no_title}）`,
    );
  } else {
    console.log(
      `已重生成 ${report.ok} 条${label}竖图分屏封面`
      + `（候选 ${report.candidates} 条，竖图 ${report.total} 条，跳过宽图 ${report.skip_landscape}，失败 ${report.fail}）`,
    );
    if (report.fail > 0) {
      for (const item of report.items.filter((entry) => entry.status === "fail")) {
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

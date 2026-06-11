#!/usr/bin/env node
"use strict";

/**
 * 按城市清单批量抓取小红书一周活动汇总，并串联 extract + 入库。
 *
 * 标准说明见 docs/xiaohongshu-review-workflow.md
 * 等价于：node scripts/run-xhs-weekly-pipeline.js --city=...
 *
 *   node scripts/batch-scrape-xhs-cities.js
 *   node scripts/batch-scrape-xhs-cities.js --city=北京,上海
 *   node scripts/batch-scrape-xhs-cities.js --skip-import
 */

const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const pipeline = path.join(__dirname, "run-xhs-weekly-pipeline.js");

function parseArgs(argv) {
  const forward = [];
  let cities = "";
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") forward.push(arg);
    else if (arg === "--skip-import") forward.push(arg);
    else if (arg.startsWith("--accounts=")) forward.push(arg);
    else if (arg.startsWith("--city=") || arg.startsWith("--cities=")) {
      cities = arg.includes("=") ? arg.split("=")[1] : "";
    }
  }
  if (cities) forward.unshift(`--city=${cities}`);
  return forward;
}

function main() {
  const args = parseArgs(process.argv);
  console.log("batch-scrape-xhs-cities → run-xhs-weekly-pipeline（见 docs/xiaohongshu-review-workflow.md）\n");
  const result = spawnSync(process.execPath, [pipeline, ...args], { stdio: "inherit", cwd: root });
  process.exit(result.status ?? 1);
}

main();

#!/usr/bin/env node
"use strict";

/**
 * 抓取某城豆瓣活动并导出 Agent POI 任务（不在此脚本内做 POI 判断）。
 *
 *   node scripts/prepare-city-poi-for-agent.js --city=成都
 *   node scripts/prepare-city-poi-for-agent.js --city=成都 --skip-scrape
 */
const { execSync } = require("child_process");
const path = require("path");
const { resolveDoubanCity } = require("../lib/douban-cities");

const root = path.join(__dirname, "..");

function parseArgs(argv) {
  const options = {
    city: "",
    limit: 500,
    maxPages: 10,
    mode: "append-city",
    dbPath: path.join(root, "data", "review.db"),
    skipScrape: false,
    pendingOnly: true,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg === "--skip-scrape") options.skipScrape = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length)) || 500;
    else if (arg.startsWith("--max-pages=")) options.maxPages = Number(arg.slice("--max-pages=".length)) || 10;
    else if (arg.startsWith("--mode=")) options.mode = arg.slice("--mode=".length).trim();
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (arg === "--all-review-status") options.pendingOnly = false;
  }
  if (!options.city) throw new Error("请指定 --city=城市名或 slug");
  const cityInfo = resolveDoubanCity(options.city);
  if (!cityInfo) throw new Error(`未知城市: ${options.city}`);
  options.cityName = cityInfo.name;
  options.citySlug = cityInfo.slug;
  return options;
}

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

function main() {
  const options = parseArgs(process.argv);

  if (!options.skipScrape) {
    run([
      "node scripts/scrape-douban-week-events.js",
      options.limit,
      options.dbPath,
      `--city=${options.citySlug}`,
      `--mode=${options.mode}`,
      `--max-pages=${options.maxPages}`,
    ].join(" "));
  }

  run(`node scripts/export-events-for-time.js --city=${options.cityName} --source=douban`);
  run(`node scripts/suggest-event-time-decisions.js --city=${options.cityName} --source=douban`);
  run(`node scripts/export-events-for-classification.js --city=${options.cityName} --refresh`);
  run(`node scripts/export-events-for-body.js --city=${options.cityName} --refresh`);

  const pendingFlag = options.pendingOnly ? " --pending-only" : "";
  run(`node scripts/export-events-for-poi.js --city=${options.cityName} --refresh${pendingFlag}`);

  const workbench = path.join(root, "data", "poi-agent-workbench", options.cityName);
  console.log("\n---");
  console.log("抓取与导出已完成。请在 Cursor 对话中由大模型继续：");
  console.log(`  1. 入库时间：读 ${path.join(workbench, "time-pending.json")}（或核对 time-decisions.json 草稿）`);
  console.log("     → 写/改 time-decisions.json → apply-event-time-decisions.js");
  console.log(`  2. 分类/挡下：读 ${path.join(workbench, "classification-pending.json")}`);
  console.log("     → 写 classification-decisions.json → apply-event-classification-decisions.js");
  console.log(`  3. 活动介绍：读 ${path.join(workbench, "body-pending.json")}`);
  console.log("     → 写 body-decisions.json（含参加方式）→ apply-event-body-decisions.js");
  console.log(`  4. POI：读 ${path.join(workbench, "pending.json")}`);
  console.log("     → poi-search-cli.js → decisions.json → apply-event-poi-decisions.js");
  console.log("详见 docs/event-time-agent.md、docs/event-classification-agent.md、docs/event-body-agent.md、docs/event-poi-agent-workflow.md");
}

main();

#!/usr/bin/env node
"use strict";

/**
 * 单城 Agent POI 全流程：导出待定 → 搜词计划 → 批量搜索 → 决策 → 写库
 *
 *   node scripts/run-city-agent-poi.js --city=上海
 */
const { execSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

function parseArgs(argv) {
  let city = "";
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) city = arg.slice("--city=".length).trim();
  }
  if (!city) throw new Error("请指定 --city=城市名");
  return { city };
}

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

function main() {
  const { city } = parseArgs(process.argv);
  run(`node scripts/export-events-for-poi.js --city=${city} --refresh --pending-only`);
  run(`node scripts/agent-poi-build-search-plan.js ${city}`);
  run(`node scripts/agent-poi-batch-search.js ${city}`);
  run(`node scripts/agent-poi-build-decisions.js ${city}`);
  run(`node scripts/apply-event-poi-decisions.js --city=${city}`);
}

main();

#!/usr/bin/env node
"use strict";

/**
 * 小红书一周活动 · 标准流水线（抓取 → Agent 读图后的 extract → 入库）
 *
 * 完整说明见 docs/xiaohongshu-review-workflow.md
 *
 * 用法:
 *   node scripts/run-xhs-weekly-pipeline.js --city=北京,上海
 *   node scripts/run-xhs-weekly-pipeline.js --skip-scrape --city=上海   # 仅 extract + 入库
 *   node scripts/run-xhs-weekly-pipeline.js --import-only              # 全部已提取笔记入库
 *   node scripts/run-xhs-weekly-pipeline.js --dry-run
 */

const fs = require("fs");
const path = require("path");
const { scrapeXhsProfileWeekly } = require("./scrape-xhs-profile-weekly");
const {
  WORKFLOW_DOC,
  importAllReadyNotes,
  processNoteDir,
  printAwaitingVisionHelp,
} = require("../lib/xhs-weekly-pipeline");

const root = path.join(__dirname, "..");
const defaultAccounts = path.join(root, "data", "xhs-city-accounts.json");

function parseArgs(argv) {
  const options = {
    accountsFile: defaultAccounts,
    cities: [],
    dbPath: path.join(root, "data", "review.db"),
    dryRun: false,
    skipScrape: false,
    skipImport: false,
    importOnly: false,
    skipExtract: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-scrape") options.skipScrape = true;
    else if (arg === "--skip-import") options.skipImport = true;
    else if (arg === "--import-only") {
      options.importOnly = true;
      options.skipScrape = true;
      options.skipExtract = true;
    }
    else if (arg === "--skip-extract") options.skipExtract = true;
    else if (arg.startsWith("--accounts=")) options.accountsFile = arg.slice("--accounts=".length);
    else if (arg.startsWith("--city=") || arg.startsWith("--cities=")) {
      const raw = arg.includes("=") ? arg.split("=")[1] : "";
      options.cities = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
    else if (!arg.startsWith("--") && arg.endsWith(".db")) options.dbPath = arg;
  }
  return options;
}

function loadAccounts(file, cities) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = (Array.isArray(data) ? data : data.accounts || []).filter((row) => row.city && row.profileUrl);
  if (!cities.length) return list;
  const set = new Set(cities);
  return list.filter((row) => set.has(row.city));
}

async function scrapeCity(row, options) {
  console.log(`\n======== 抓取 ${row.city} ========`);
  const out = await scrapeXhsProfileWeekly(row.profileUrl, {
    city: row.city,
    limit: row.limit || 10,
    skipExtract: true,
  });
  return out;
}

async function main() {
  const options = parseArgs(process.argv);
  console.log(`小红书标准流水线（说明：${WORKFLOW_DOC}）`);

  if (options.importOnly) {
    const results = await importAllReadyNotes(root, {
      city: options.cities[0] || null,
      dbPath: options.dbPath,
      dryRun: options.dryRun,
      log: true,
    });
    const imported = results.filter((r) => r.status === "imported").length;
    console.log(`\n入库完成：${imported} 篇笔记`);
    return;
  }

  const accounts = loadAccounts(options.accountsFile, options.cities);
  if (!accounts.length) {
    console.error("没有可处理的城市账号，请编辑 data/xhs-city-accounts.json");
    process.exit(1);
  }

  const summary = [];
  for (const row of accounts) {
    let noteDir = null;
    if (!options.skipScrape) {
      try {
        const scraped = await scrapeCity(row, options);
        noteDir = scraped.noteDir;
      } catch (error) {
        console.error(`[${row.city}] 抓取失败:`, error.message || error);
        summary.push({ city: row.city, status: "scrape_failed", error: error.message });
        continue;
      }
    } else {
      const cityDir = path.join(root, "data", "scrape-cache", "xhs", row.city);
      if (!fs.existsSync(cityDir)) {
        summary.push({ city: row.city, status: "no_cache", error: "无抓取目录" });
        continue;
      }
      const notes = fs.readdirSync(cityDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(cityDir, entry.name))
        .filter((dir) => fs.existsSync(path.join(dir, "weekly-summary.json")))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      noteDir = notes[0] || null;
      if (!noteDir) {
        summary.push({ city: row.city, status: "no_note", error: "无 weekly-summary.json" });
        continue;
      }
      console.log(`\n======== 处理 ${row.city} / ${path.basename(noteDir)} ========`);
    }

    const processed = await processNoteDir(noteDir, {
      rootDir: root,
      dbPath: options.dbPath,
      dryRun: options.dryRun,
      skipExtract: options.skipExtract,
      skipImport: options.skipImport,
      log: true,
    });
    summary.push({ city: row.city, ...processed });

    if (processed.status === "awaiting_vision") {
      printAwaitingVisionHelp(row.city, root);
    }
  }

  console.log("\n======== 流水线汇总 ========");
  for (const item of summary) {
    const extra = item.eventCount ? ` · ${item.eventCount} 条` : "";
    console.log(`  ${item.city}: ${item.status}${extra}${item.message ? ` — ${item.message}` : ""}`);
  }
  const imported = summary.filter((item) => item.imported).length;
  const waiting = summary.filter((item) => item.status === "awaiting_vision").length;
  if (imported) {
    console.log(`\n已入库 ${imported} 城；审核台 http://127.0.0.1:8787/ 来源选「小红书」`);
  }
  if (waiting) {
    console.log(`\n${waiting} 城等待 Agent 读图，完成后运行：`);
    console.log("  node scripts/run-xhs-weekly-pipeline.js --skip-scrape --city=<城市>");
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

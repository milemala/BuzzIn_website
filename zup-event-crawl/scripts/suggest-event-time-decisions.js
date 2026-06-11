#!/usr/bin/env node
"use strict";

/**
 * 根据 time_text 自动生成 time-decisions.json 草稿（Agent 可覆写低置信条目）。
 *
 *   node scripts/suggest-event-time-decisions.js --source=xiaohongshu --all-cities
 *   node scripts/suggest-event-time-decisions.js --city=成都 --source=douban
 */

const fs = require("fs");
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { suggestTimeDecision } = require("../lib/event-time-agent");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");
const workbenchRoot = path.join(root, "data", "poi-agent-workbench");

function parseArgs(argv) {
  const options = {
    city: "",
    source: "",
    allCities: false,
    dbPath: defaultDb,
    anchorDate: "2026-06-08",
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length).trim();
    else if (arg === "--all-cities") options.allCities = true;
    else if (arg.startsWith("--anchor-date=")) options.anchorDate = arg.slice("--anchor-date=".length).trim();
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  try {
    let sql = "SELECT event_uid, title, time_text, city, source, raw_detail_html FROM events WHERE 1=1";
    const params = [];
    if (options.city) {
      sql += " AND city = ?";
      params.push(options.city);
    }
    if (options.source) {
      sql += " AND source = ?";
      params.push(options.source);
    }
    sql += " ORDER BY city, event_uid";
    const rows = db.prepare(sql).all(...params);

    const decisions = [];
    const failed = [];
    for (const row of rows) {
      const suggestion = suggestTimeDecision(row, { anchorDate: new Date(options.anchorDate) });
      if (!suggestion.ok) {
        failed.push({ event_uid: row.event_uid, title: row.title, reason: suggestion.reason });
        continue;
      }
      decisions.push({
        event_uid: row.event_uid,
        start_at: suggestion.start_at,
        expired_at: suggestion.expired_at,
        reason: suggestion.reason,
        confidence: suggestion.confidence,
      });
    }

    const cityKey = options.city || (options.allCities ? "多城市" : "全部");
    const outDir = path.join(workbenchRoot, cityKey);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "time-decisions.json");
    fs.writeFileSync(outPath, `${JSON.stringify({
      city: cityKey,
      source: options.source || "all",
      generated_at: new Date().toISOString(),
      note: "可由 Agent 覆写低置信条目后 apply-event-time-decisions.js 入库",
      decisions,
      failed,
    }, null, 2)}\n`, "utf8");

    console.log(`已生成 ${decisions.length} 条决策 → ${outPath}`);
    if (failed.length) console.log(`未能自动解析 ${failed.length} 条（见 failed 数组）`);
  } finally {
    db.close();
  }
}

main();

#!/usr/bin/env node
"use strict";

/**
 * 对 review.db 中全部豆瓣活动跑 Agent 分类规则并入库。
 *
 *   node scripts/batch-classify-all-events.js
 *   node scripts/batch-classify-all-events.js --city=深圳
 *   node scripts/batch-classify-all-events.js --dry-run
 */
const fs = require("fs");
const path = require("path");
const { inferEventClassification } = require("../lib/event-classification");
const { applyEventClassification, openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const workbenchRoot = path.join(root, "data", "poi-agent-workbench");

function parseArgs(argv) {
  const options = { city: "", dbPath: path.join(root, "data", "review.db"), dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  const summary = { total: 0, suggested: 0, blocked: 0, fail: 0 };
  const decisionsByCity = new Map();

  try {
    let sql = `
      SELECT event_uid, city, title, location, fee, owner, time_text, body,
             douban_event_type, raw_detail_text, classification_source
      FROM events WHERE source = 'douban'
    `;
    const params = [];
    if (options.city) {
      sql += " AND city = ?";
      params.push(options.city);
    }
    sql += " ORDER BY city, source_position ASC, event_uid ASC";
    const rows = db.prepare(sql).all(...params);

    for (const row of rows) {
      summary.total += 1;
      const verdict = inferEventClassification(row);
      const decision = {
        event_uid: row.event_uid,
        suggested: verdict.suggested,
        category: verdict.category,
        reason: verdict.reason,
      };

      if (!decisionsByCity.has(row.city)) decisionsByCity.set(row.city, []);
      decisionsByCity.get(row.city).push(decision);

      if (verdict.suggested) summary.suggested += 1;
      else summary.blocked += 1;

      if (options.dryRun) {
        const flag = verdict.suggested ? "推荐" : "挡下";
        console.log(`${flag} · ${verdict.category} · ${row.title?.slice(0, 42)}`);
        continue;
      }

      try {
        applyEventClassification(db, row.event_uid, decision);
      } catch (error) {
        summary.fail += 1;
        console.warn(`✗ ${row.event_uid}: ${error.message}`);
      }
    }

    if (!options.dryRun) {
      for (const [city, decisions] of decisionsByCity.entries()) {
        const outDir = path.join(workbenchRoot, city);
        fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, "classification-decisions.json");
        fs.writeFileSync(outPath, `${JSON.stringify({
          city,
          decided_at: new Date().toISOString(),
          agent: "batch-infer-v2",
          decisions,
        }, null, 2)}\n`, "utf8");
      }
    }

    console.log(`\n完成: 共 ${summary.total} 条 · 推荐 ${summary.suggested} · 挡下 ${summary.blocked} · 失败 ${summary.fail}`);
  } finally {
    db.close();
  }
}

main();

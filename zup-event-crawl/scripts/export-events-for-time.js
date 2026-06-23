#!/usr/bin/env node
"use strict";

/**
 * 导出待 Agent 校正入库时间的活动。
 *
 *   node scripts/export-events-for-time.js --city=上海 --source=xiaohongshu
 *   node scripts/export-events-for-time.js --city=成都 --source=douban
 *   node scripts/export-events-for-time.js --source=xiaohongshu --all-cities
 */

const fs = require("fs");
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { resolveStartAt, resolveExpiredAt } = require("../lib/event-import-ready");
const { suggestTimeDecision, TIME_SOURCE_AGENT, TIME_SOURCE_MANUAL } = require("../lib/event-time-agent");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");
const workbenchRoot = path.join(root, "data", "poi-agent-workbench");

function parseArgs(argv) {
  const options = {
    city: "",
    source: "",
    allCities: false,
    dbPath: defaultDb,
    limit: 5000,
    pendingOnly: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length).trim();
    else if (arg === "--all-cities") options.allCities = true;
    else if (arg === "--pending-only") options.pendingOnly = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length)) || 5000;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  if (!options.city && !options.allCities) {
    throw new Error("请指定 --city=城市名 或 --all-cities");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  try {
    let sql = `
      SELECT event_uid, city, title, time_text, start_date, end_date, source, raw_detail_text, raw_detail_html
      FROM events
      WHERE 1 = 1
    `;
    const params = [];
    if (!options.allCities) {
      sql += " AND city = ?";
      params.push(options.city);
    }
    if (options.source) {
      sql += " AND source = ?";
      params.push(options.source);
    }
    if (options.pendingOnly) {
      sql += ` AND COALESCE(time_source, 'pending') NOT IN (?, ?)`;
      params.push(TIME_SOURCE_AGENT, TIME_SOURCE_MANUAL);
    }
    sql += " ORDER BY city, source_position ASC, event_uid ASC LIMIT ?";
    params.push(options.limit);

    const rows = db.prepare(sql).all(...params);
    const cityKey = options.allCities ? "多城市" : options.city;
    const outDir = path.join(workbenchRoot, cityKey);
    fs.mkdirSync(outDir, { recursive: true });

    const events = rows.map((row) => {
      const suggestion = suggestTimeDecision(row, { anchorDate: new Date("2026-06-08") });
      return {
        event_uid: row.event_uid,
        city: row.city,
        source: row.source,
        title: row.title,
        time_text: row.time_text || "",
        current_start_date: row.start_date || "",
        current_end_date: row.end_date || "",
        current_start_at: resolveStartAt(row),
        current_expired_at: resolveExpiredAt(row),
        detail_excerpt: String(row.raw_detail_text || "").slice(0, 400),
        suggestion: suggestion.ok ? {
          start_at: suggestion.start_at,
          expired_at: suggestion.expired_at,
          confidence: suggestion.confidence,
          reason: suggestion.reason,
        } : { error: suggestion.reason },
      };
    });

    const outPath = path.join(outDir, "time-pending.json");
    const payload = {
      city: cityKey,
      source: options.source || "all",
      exported_at: new Date().toISOString(),
      note: "由 Cursor Agent 根据 time_text / 豆瓣详情 HTML 填写 time-decisions.json。仅开始时刻时 expired_at 延至当天 23:59:59。见 docs/event-time-agent.md",
      events,
    };
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`已导出 ${rows.length} 条 → ${outPath}`);
  } finally {
    db.close();
  }
}

main();

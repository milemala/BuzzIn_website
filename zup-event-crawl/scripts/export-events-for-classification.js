#!/usr/bin/env node
"use strict";

/**
 * 导出待 Agent 分类/挡下的活动，供 Cursor 大模型判断。
 *
 *   node scripts/export-events-for-classification.js --city=深圳
 *   node scripts/export-events-for-classification.js --city=深圳 --refresh
 */
const fs = require("fs");
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { CLASSIFICATION_SOURCE_AGENT } = require("../lib/event-classification");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");
const workbenchRoot = path.join(root, "data", "poi-agent-workbench");

function parseArgs(argv) {
  const options = {
    city: "",
    dbPath: defaultDb,
    refresh: false,
    limit: 2000,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg === "--refresh") options.refresh = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length)) || 2000;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  if (!options.city) throw new Error("请指定 --city=城市名");
  return options;
}

function excerpt(text, max = 480) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  return raw.length <= max ? raw : `${raw.slice(0, max)}…`;
}

function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  try {
    let sql = `
      SELECT
        e.event_uid, e.city, e.title, e.location, e.fee, e.owner,
        e.time_text, e.body, e.douban_event_type, e.category, e.suggested,
        e.review_reason, e.classification_source, e.raw_detail_text
      FROM events e
      WHERE e.source = 'douban' AND e.city = ?
    `;
    const params = [options.city];
    if (!options.refresh) {
      sql += ` AND COALESCE(e.classification_source, 'pending') != ?`;
      params.push(CLASSIFICATION_SOURCE_AGENT);
    }
    sql += ` ORDER BY e.source_position ASC, e.event_uid ASC LIMIT ?`;
    params.push(options.limit);

    const rows = db.prepare(sql).all(...params);
    const outDir = path.join(workbenchRoot, options.city);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "classification-pending.json");
    const payload = {
      city: options.city,
      exported_at: new Date().toISOString(),
      note: "由 Cursor Agent 逐条判断 suggested（推荐/挡下）与 category。见 docs/event-classification-agent.md",
      events: rows.map((row) => ({
        event_uid: row.event_uid,
        title: row.title,
        location: row.location,
        fee: row.fee,
        owner: row.owner,
        time_text: row.time_text,
        douban_event_type: row.douban_event_type || "",
        body_excerpt: excerpt(row.body),
        detail_excerpt: excerpt(row.raw_detail_text, 800),
        current_category: row.category || "",
        current_suggested: Boolean(row.suggested),
        current_reason: row.review_reason || "",
      })),
    };
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`已导出 ${rows.length} 条 → ${outPath}`);
  } finally {
    db.close();
  }
}

main();

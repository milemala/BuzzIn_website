#!/usr/bin/env node
"use strict";

/**
 * 导出待 Agent 撰写活动介绍的条目。
 *
 *   node scripts/export-events-for-body.js --city=深圳
 *   node scripts/export-events-for-body.js --city=深圳 --refresh
 */
const fs = require("fs");
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { BODY_SOURCE_AGENT } = require("../lib/event-body-agent");

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

function excerpt(text, max = 3200) {
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
        e.time_text, e.body, e.category, e.suggested, e.review_reason,
        e.body_source, e.raw_detail_text, e.douban_event_type
      FROM events e
      WHERE e.source = 'douban' AND e.city = ?
    `;
    const params = [options.city];
    if (!options.refresh) {
      sql += ` AND COALESCE(e.body_source, 'pending') != ?`;
      params.push(BODY_SOURCE_AGENT);
    }
    sql += ` ORDER BY e.source_position ASC, e.event_uid ASC LIMIT ?`;
    params.push(options.limit);

    const rows = db.prepare(sql).all(...params);
    const outDir = path.join(workbenchRoot, options.city);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "body-pending.json");
    const payload = {
      city: options.city,
      exported_at: new Date().toISOString(),
      note: "由 Cursor Agent 逐条撰写完整 body（活动介绍 + 参加方式）。见 docs/event-body-agent.md",
      events: rows.map((row) => ({
        event_uid: row.event_uid,
        title: row.title,
        location: row.location,
        fee: row.fee,
        owner: row.owner,
        time_text: row.time_text,
        category: row.category || "",
        suggested: Boolean(row.suggested),
        douban_event_type: row.douban_event_type || "",
        detail_text: excerpt(row.raw_detail_text, 4000),
        current_body: String(row.body || "").trim(),
        current_body_source: row.body_source || "pending",
      })),
    };
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`已导出 ${rows.length} 条 → ${outPath}`);
  } finally {
    db.close();
  }
}

main();

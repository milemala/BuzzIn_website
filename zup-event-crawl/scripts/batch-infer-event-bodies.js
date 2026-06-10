#!/usr/bin/env node
"use strict";

/**
 * 对 body_source=pending 的活动用 JS 规则生成简介（备选路径）。
 *
 *   node scripts/batch-infer-event-bodies.js
 *   node scripts/batch-infer-event-bodies.js --city=深圳 --dry-run
 */
const path = require("path");
const { makeZupSummary } = require("../lib/douban-detail");
const {
  BODY_SOURCE_AGENT,
  BODY_SOURCE_JS_FALLBACK,
  BODY_SOURCE_PENDING,
} = require("../lib/event-body-agent");
const { isExpired } = require("../lib/event-import-ready");
const { openDatabase, rowToEvent } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const forceAll = argv.includes("--force");
const city = (argv.find((arg) => arg.startsWith("--city=")) || "").slice("--city=".length).trim();
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

const db = openDatabase(dbPath);
let sql = `
  SELECT * FROM events
  WHERE source = 'douban'
`;
const params = [];
if (city) {
  sql += " AND city = ?";
  params.push(city);
}
if (!forceAll) {
  sql += " AND COALESCE(body_source, ?) = ?";
  params.push(BODY_SOURCE_PENDING, BODY_SOURCE_PENDING);
}
sql += " ORDER BY city ASC, source_position ASC";

const rows = db.prepare(sql).all(...params);
const update = db.prepare(`
  UPDATE events
  SET body = @body,
      body_source = @body_source,
      updated_at = @updated_at
  WHERE event_uid = @event_uid
`);

const now = new Date().toISOString();
let updated = 0;
let skipped = 0;

for (const row of rows) {
  if (isExpired(row)) {
    skipped += 1;
    continue;
  }
  if (!forceAll && String(row.body_source || "") === BODY_SOURCE_AGENT) {
    skipped += 1;
    continue;
  }

  const event = rowToEvent(row);
  const intro = makeZupSummary(event);
  if (!intro) {
    skipped += 1;
    continue;
  }

  updated += 1;
  if (dryRun) {
    console.log(`[dry-run] ${event.title}`);
    console.log(`  ${intro.slice(0, 100)}…`);
    continue;
  }

  update.run({
    event_uid: row.event_uid,
    body: intro,
    body_source: BODY_SOURCE_JS_FALLBACK,
    updated_at: now,
  });
}

console.log(dryRun
  ? `Would infer ${updated} bodies (skipped ${skipped})`
  : `Inferred ${updated} bodies (skipped ${skipped}) in ${dbPath}`);

db.close();

#!/usr/bin/env node
"use strict";

const path = require("path");
const { rebuildDetailFields } = require("../lib/douban-detail");
const { isExpired } = require("../lib/event-import-ready");
const { openDatabase, rowToEvent } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const forceAll = argv.includes("--force");
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

const db = openDatabase(dbPath);
const rows = db.prepare("SELECT * FROM events").all();
const update = db.prepare(`
  UPDATE events
  SET body = @body,
      raw_detail_text = @raw_detail_text,
      updated_at = @updated_at
  WHERE event_uid = @event_uid
`);

const now = new Date().toISOString();
let updated = 0;
let skippedExpired = 0;

for (const row of rows) {
  if (isExpired(row)) {
    skippedExpired += 1;
    continue;
  }

  const event = rowToEvent(row);
  const needsRebuild = forceAll
    || !String(row.body || "").trim()
    || !String(row.raw_detail_text || "").trim()
    || /报名购票方式请查看活动原始链接|具体时间请咨询管理员|添加客服了解详情/.test(String(row.body || ""));

  if (!needsRebuild) continue;
  if (!event.rawDetailHtml && !event.rawDetailText) continue;

  const next = rebuildDetailFields(event);
  const sameBody = String(next.body || "").trim() === String(row.body || "").trim();
  const sameDetail = String(next.rawDetailText || "").trim() === String(row.raw_detail_text || "").trim();
  if (sameBody && sameDetail) continue;

  updated += 1;
  if (dryRun) {
    console.log(`[dry-run] ${event.title}`);
    console.log(`  body: ${String(next.body || "").slice(0, 120)}…`);
    continue;
  }

  update.run({
    event_uid: row.event_uid,
    body: next.body,
    raw_detail_text: next.rawDetailText,
    updated_at: now,
  });
}

console.log(dryRun
  ? `Would update ${updated} active events (skipped ${skippedExpired} expired)`
  : `Updated ${updated} active events (skipped ${skippedExpired} expired) in ${dbPath}`);

db.close();

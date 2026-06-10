#!/usr/bin/env node
"use strict";

/**
 * 从已存 raw_detail_html 重算：完整原文、活动简介、详情页时间。
 *
 *   node scripts/rebuild-event-bodies.js
 *   node scripts/rebuild-event-bodies.js --dry-run
 *   node scripts/rebuild-event-bodies.js --force
 */
const path = require("path");
const { rebuildEventDerivedFields } = require("../lib/douban-detail");
const { isExpired } = require("../lib/event-import-ready");
const { openDatabase, rowToEvent } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const forceAll = argv.includes("--force");
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

const db = openDatabase(dbPath);
const rows = db.prepare("SELECT * FROM events").all();
const jsFallback = argv.includes("--js-fallback");
const update = db.prepare(`
  UPDATE events
  SET body = @body,
      body_source = @body_source,
      raw_detail_text = @raw_detail_text,
      time_text = @time_text,
      start_date = @start_date,
      end_date = @end_date,
      updated_at = @updated_at
  WHERE event_uid = @event_uid
`);
const deleteEventDates = db.prepare("DELETE FROM event_dates WHERE event_uid = ?");
const insertEventDate = db.prepare("INSERT OR IGNORE INTO event_dates (event_uid, event_date) VALUES (?, ?)");

const now = new Date().toISOString();
let updated = 0;
let skippedExpired = 0;

function needsRebuild(row, event) {
  if (String(row.body_source || "") === "agent") return false;
  if (forceAll) return true;
  const bodyText = String(row.body || "");
  const rawText = String(row.raw_detail_text || "");
  const html = String(row.raw_detail_html || "");
  if (!html && !rawText) return false;

  return !bodyText.trim()
    || !rawText.trim()
    || /报名购票方式请查看活动原始链接|具体时间请咨询管理员|添加客服了解详情/.test(bodyText)
    || /\d+号厅.*观影/.test(bodyText)
    || String(row.time_text || "").includes("...")
    || (html.includes("calendar-str-item") && String(row.time_text || "").includes("..."));
}

for (const row of rows) {
  if (isExpired(row)) {
    skippedExpired += 1;
    continue;
  }

  const event = rowToEvent(row);
  if (!needsRebuild(row, event)) continue;
  if (!event.rawDetailHtml && !event.rawDetailText) continue;

  const next = rebuildEventDerivedFields(event);
  const sameBody = String(next.body || "").trim() === String(row.body || "").trim();
  const sameDetail = String(next.rawDetailText || "").trim() === String(row.raw_detail_text || "").trim();
  const sameTime = String(next.timeText || "").trim() === String(row.time_text || "").trim();
  if (sameBody && sameDetail && sameTime) continue;

  updated += 1;
  if (dryRun) {
    console.log(`[dry-run] ${event.title}`);
    console.log(`  time: ${String(next.timeText || "").slice(0, 80)}`);
    console.log(`  body: ${String(next.body || "").slice(0, 100)}…`);
    continue;
  }

  update.run({
    event_uid: row.event_uid,
    body: next.body,
    body_source: jsFallback ? "js_fallback" : (row.body_source || "pending"),
    raw_detail_text: next.rawDetailText,
    time_text: next.timeText,
    start_date: next.startDate,
    end_date: next.endDate,
    updated_at: now,
  });

  deleteEventDates.run(row.event_uid);
  for (const eventDate of next.eventDates || []) {
    insertEventDate.run(row.event_uid, eventDate);
  }
}

console.log(dryRun
  ? `Would update ${updated} active events (skipped ${skippedExpired} expired)`
  : `Updated ${updated} active events (skipped ${skippedExpired} expired) in ${dbPath}`);

db.close();

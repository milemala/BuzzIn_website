#!/usr/bin/env node
"use strict";

const path = require("path");
const { enrichEventBody, stripStaleParticipation } = require("../lib/event-participation");
const { isExpired } = require("../lib/event-import-ready");
const { openDatabase, rowToEvent } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

const db = openDatabase(dbPath);
const rows = db.prepare(`
  SELECT event_uid, body, fee, owner, title, raw_detail_text, raw_detail_html, end_date, start_date
  FROM events
`).all();
const update = db.prepare("UPDATE events SET body = @body, updated_at = @updated_at WHERE event_uid = @event_uid");

const now = new Date().toISOString();
let updated = 0;
let skippedExpired = 0;

for (const row of rows) {
  if (isExpired(row)) {
    skippedExpired += 1;
    continue;
  }

  const event = rowToEvent(row);
  const bodySource = String(event.body_source || "");
  if (bodySource === "agent" || bodySource === "xhs_source") continue;
  const cleaned = stripStaleParticipation(row.body);
  const nextBody = enrichEventBody({ ...event, body: cleaned });
  if (nextBody === String(row.body || "").trim()) continue;
  updated += 1;
  if (dryRun) {
    console.log(`[dry-run] ${event.title}`);
    console.log(`  + ${nextBody.split("\n").pop()}`);
    continue;
  }
  update.run({ event_uid: row.event_uid, body: nextBody, updated_at: now });
}

console.log(dryRun
  ? `Would update ${updated} / ${rows.length - skippedExpired} active events (skipped ${skippedExpired} expired)`
  : `Updated ${updated} / ${rows.length - skippedExpired} active events (skipped ${skippedExpired} expired) in ${dbPath}`);

db.close();

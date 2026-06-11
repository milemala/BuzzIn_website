#!/usr/bin/env node
"use strict";

/**
 * 将 events-extracted.json 的 highlights 写入 review.db 的 body（小红书专用，不走 Agent）。
 *
 *   node scripts/apply-xhs-event-bodies.js
 *   node scripts/apply-xhs-event-bodies.js --city=重庆
 *   node scripts/apply-xhs-event-bodies.js --dry-run
 */
const fs = require("fs");
const path = require("path");
const { BODY_SOURCE_XHS, buildXhsBodyFields, normalizeBodyText } = require("../lib/event-body-agent");
const { openDatabase } = require("../lib/review-db");
const { listXhsNoteDirs, xhsEventUid } = require("../lib/xhs-review-import");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");

function parseArgs(argv) {
  const options = {
    city: "",
    dbPath: defaultDb,
    dryRun: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv);
  const xhsRoot = path.join(root, "data", "scrape-cache", "xhs");
  const noteDirs = listXhsNoteDirs(xhsRoot, options.city || null);
  if (!noteDirs.length) {
    console.error("未找到 events-extracted.json");
    process.exit(2);
  }

  const db = openDatabase(options.dbPath);
  const update = db.prepare(`
    UPDATE events
    SET body = @body,
        body_source = @body_source,
        updated_at = @updated_at
    WHERE event_uid = @event_uid
      AND source = 'xiaohongshu'
  `);
  const now = new Date().toISOString();
  let ok = 0;
  let skip = 0;
  let missing = 0;

  try {
    for (const { city, noteDir } of noteDirs) {
      const extracted = JSON.parse(fs.readFileSync(path.join(noteDir, "events-extracted.json"), "utf8"));
      for (const event of extracted.events || []) {
        if (!event.name || event.needsVision) continue;
        const eventUid = xhsEventUid(extracted.noteId, event.index);
        const { body, body_source: bodySource } = buildXhsBodyFields(event);
        if (!normalizeBodyText(body)) {
          skip += 1;
          continue;
        }
        if (options.dryRun) {
          console.log(`[dry-run] ${city} · ${event.name} → ${String(body).slice(0, 48)}…`);
          ok += 1;
          continue;
        }
        const result = update.run({
          event_uid: eventUid,
          body,
          body_source: bodySource || BODY_SOURCE_XHS,
          updated_at: now,
        });
        if (result.changes) {
          ok += 1;
          console.log(`✓ ${event.name}`);
        } else {
          missing += 1;
          console.warn(`? 库中无此条: ${eventUid} ${event.name}`);
        }
      }
    }
    console.log(`完成: 写入 ${ok} · 无介绍跳过 ${skip} · 库中未找到 ${missing}`);
  } finally {
    db.close();
  }
}

main();

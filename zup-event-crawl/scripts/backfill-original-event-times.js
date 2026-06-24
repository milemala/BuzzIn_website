#!/usr/bin/env node
"use strict";

/**
 * 回填 original_start_date / original_end_date（不修改推送用 start_date / end_date）。
 *
 *   node scripts/backfill-original-event-times.js --dry-run
 *   node scripts/backfill-original-event-times.js
 *   node scripts/backfill-original-event-times.js --from-push   # 原始为空时，用当前推送时间留档
 */

const fs = require("fs");
const path = require("path");
const {
  openDatabase,
  getEventByUid,
  setOriginalEventTime,
} = require("../lib/review-db");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");
const workbench = path.join(root, "data", "poi-agent-workbench");
const shortenFile = path.join(root, "data", "shorten-expire-before-after.json");

function parseArgs(argv) {
  const options = { dbPath: defaultDb, dryRun: false, fromPush: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--from-push") options.fromPush = true;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  return options;
}

function loadDecisionMaps() {
  const startAt = {};
  const expiredAt = {};
  for (const city of fs.readdirSync(workbench)) {
    for (const file of ["time-decisions.json", "time-pending.json"]) {
      const fp = path.join(workbench, city, file);
      if (!fs.existsSync(fp)) continue;
      const data = JSON.parse(fs.readFileSync(fp, "utf8"));
      const items = file === "time-decisions.json" ? (data.decisions || []) : (data.events || []);
      for (const item of items) {
        const uid = String(item.event_uid || "").trim();
        if (!uid) continue;
        if (file === "time-decisions.json") {
          if (item.start_at) startAt[uid] = item.start_at;
          if (item.expired_at) expiredAt[uid] = item.expired_at;
        } else {
          const sug = item.suggestion || {};
          if (sug.start_at) startAt[uid] = startAt[uid] || sug.start_at;
          if (sug.expired_at) expiredAt[uid] = expiredAt[uid] || sug.expired_at;
        }
      }
    }
  }
  return { startAt, expiredAt };
}

function resolveOriginalPair(db, uid, maps, shortenEnd) {
  const event = getEventByUid(db, uid);
  if (!event) return null;
  const originalStart = String(maps.startAt[uid] || event.start_at || event.startDate || "").trim();
  const originalEnd = String(shortenEnd || maps.expiredAt[uid] || "").trim();
  if (!originalStart || !originalEnd) return null;
  return { originalStart, originalEnd, title: event.title };
}

function backfillFromPushTimes(db, options) {
  const rows = db.prepare(`
    SELECT event_uid, start_date, end_date
    FROM events
    WHERE trim(COALESCE(start_date, '')) != ''
      AND trim(COALESCE(end_date, '')) != ''
      AND (original_end_date IS NULL OR trim(original_end_date) = '')
  `).all();
  let updated = 0;
  for (const row of rows) {
    if (options.dryRun) {
      updated += 1;
      continue;
    }
    setOriginalEventTime(db, row.event_uid, row.start_date, row.end_date);
    updated += 1;
  }
  return updated;
}

function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);

  if (options.fromPush) {
    const updated = backfillFromPushTimes(db, options);
    console.log(`从当前推送时间留档：${updated} 条${options.dryRun ? "（dry-run）" : ""}`);
    return;
  }

  const maps = loadDecisionMaps();

  const targets = new Map();

  if (fs.existsSync(shortenFile)) {
    const shorten = JSON.parse(fs.readFileSync(shortenFile, "utf8"));
    for (const row of shorten.records || []) {
      const uid = String(row.uid || "").trim();
      if (!uid) continue;
      targets.set(uid, String(row.before || "").trim());
    }
  }

  const july5Rows = db.prepare(`
    SELECT event_uid FROM events WHERE end_date = '2026-07-05 23:59:59'
  `).all();
  for (const row of july5Rows) {
    if (!targets.has(row.event_uid)) {
      targets.set(row.event_uid, "");
    }
  }

  let updated = 0;
  let skipped = 0;
  const samples = [];

  for (const [uid, shortenEnd] of targets.entries()) {
    const pair = resolveOriginalPair(db, uid, maps, shortenEnd);
    if (!pair) {
      skipped += 1;
      continue;
    }
    const event = getEventByUid(db, uid);
    const curOrigStart = String(event.original_start_date || "").trim();
    const curOrigEnd = String(event.original_end_date || "").trim();
    if (curOrigStart === pair.originalStart && curOrigEnd === pair.originalEnd) {
      skipped += 1;
      continue;
    }
    if (options.dryRun) {
      if (samples.length < 8) {
        samples.push({
          uid,
          title: pair.title?.slice(0, 28),
          push: `${event.start_at || event.startDate} ~ ${event.expired_at || event.endDate}`,
          original: `${pair.originalStart} ~ ${pair.originalEnd}`,
        });
      }
      updated += 1;
      continue;
    }
    setOriginalEventTime(db, uid, pair.originalStart, pair.originalEnd);
    updated += 1;
  }

  console.log(`原始时间回填：${updated} 条${options.dryRun ? "（dry-run）" : ""}，跳过 ${skipped} 条`);
  if (samples.length) {
    console.log("示例：");
    for (const row of samples) {
      console.log(`  ${row.uid} ${row.title}`);
      console.log(`    推送保留: ${row.push}`);
      console.log(`    原始留档: ${row.original}`);
    }
  }

  const pushFilled = backfillFromPushTimes(db, options);
  console.log(`补充留档（原始为空 → 复制当前推送时间）：${pushFilled} 条${options.dryRun ? "（dry-run）" : ""}`);
}

main();

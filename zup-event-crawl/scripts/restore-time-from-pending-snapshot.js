#!/usr/bin/env node
"use strict";

/**
 * 用各城 time-pending.json（批量 apply 前导出）恢复被误覆盖的已审核活动时间。
 *
 *   node scripts/restore-time-from-pending-snapshot.js --dry-run
 *   node scripts/restore-time-from-pending-snapshot.js
 */

const fs = require("fs");
const path = require("path");
const { openDatabase, applyEventTime, getEventByUid, getReviewStatus } = require("../lib/review-db");
const { TIME_SOURCE_MANUAL } = require("../lib/event-time-agent");
const { resolveExpiredAt, resolveStartAt } = require("../lib/event-import-ready");
const { createClientForEnv, resolveBuzzEnv } = require("../lib/buzz-now-import");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");
const workbenchRoot = path.join(root, "data", "poi-agent-workbench");
const BATCH_DATE_PREFIX = "2026-06-23";

function parseArgs(argv) {
  const options = {
    dbPath: defaultDb,
    dryRun: false,
    syncBuzz: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-sync-buzz") options.syncBuzz = false;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  return options;
}

function norm(value) {
  return String(value || "").trim();
}

function listPendingSnapshots() {
  if (!fs.existsSync(workbenchRoot)) return [];
  return fs.readdirSync(workbenchRoot)
    .map((name) => path.join(workbenchRoot, name, "time-pending.json"))
    .filter((filePath) => fs.existsSync(filePath));
}

function collectRestoreCandidates(db) {
  const candidates = [];
  for (const filePath of listPendingSnapshots()) {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    for (const item of payload.events || []) {
      const eventUid = norm(item.event_uid);
      const beforeStart = norm(item.current_start_at || item.current_start_date);
      const beforeEnd = norm(item.current_expired_at || item.current_end_date);
      const suggestion = item.suggestion || {};
      const suggestedEnd = norm(suggestion.expired_at);
      const suggestedStart = norm(suggestion.start_at);
      if (!eventUid || !beforeEnd || !suggestedEnd) continue;
      if (beforeEnd === suggestedEnd && beforeStart === suggestedStart) continue;

      const event = getEventByUid(db, eventUid);
      if (!event) continue;
      const status = getReviewStatus(db, eventUid);
      if (status !== "approved") continue;
      if (!String(event.updated_at || "").startsWith(BATCH_DATE_PREFIX)) continue;

      const dbEnd = norm(resolveExpiredAt(event));
      const dbStart = norm(resolveStartAt(event));
      if (dbEnd !== suggestedEnd) continue;
      if (suggestedStart && dbStart !== suggestedStart) continue;

      candidates.push({
        eventUid,
        title: event.title,
        city: event.city,
        beforeStart,
        beforeEnd,
        afterStart: dbStart,
        afterEnd: dbEnd,
        buzz_now_id: norm(event.buzz_now_id),
      });
    }
  }
  const byUid = new Map();
  for (const row of candidates) byUid.set(row.eventUid, row);
  return [...byUid.values()];
}

async function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  const buzzEnv = resolveBuzzEnv({});
  const buzzClient = options.syncBuzz ? createClientForEnv({}) : null;

  try {
    const candidates = collectRestoreCandidates(db);
    console.log(`待恢复 ${candidates.length} 条已审核活动（${BATCH_DATE_PREFIX} 批量误覆盖）`);

    let restored = 0;
    let buzzSynced = 0;
    for (const row of candidates) {
      const label = `${row.eventUid} · ${row.title?.slice(0, 24) || ""}`;
      if (options.dryRun) {
        console.log(`[dry-run] ${label}`);
        console.log(`  ${row.afterEnd} → ${row.beforeEnd}`);
        restored += 1;
        continue;
      }

      applyEventTime(db, row.eventUid, {
        start_at: row.beforeStart,
        expired_at: row.beforeEnd,
      }, { timeSource: TIME_SOURCE_MANUAL, force: true });

      if (buzzClient && row.buzz_now_id) {
        try {
          await buzzClient.updateNow(row.buzz_now_id, { expired_at: row.beforeEnd });
          buzzSynced += 1;
        } catch (error) {
          console.warn(`  Buzz 同步失败 ${row.buzz_now_id}: ${error.message}`);
        }
      }

      restored += 1;
      console.log(`✓ ${label} → ${row.beforeEnd}`);
    }

    console.log(`完成: 恢复 ${restored} 条${options.syncBuzz ? ` · Buzz 同步 ${buzzSynced} 条` : ""}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

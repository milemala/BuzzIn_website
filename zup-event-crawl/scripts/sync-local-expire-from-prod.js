#!/usr/bin/env node
"use strict";

/**
 * 以正式环境 Buzz 上的 expired_at 为准，修正本地 review.db 与线上一致的过期时间。
 * 仅写本地，不调用 Buzz 更新（线上已是正确值）。
 *
 *   node scripts/sync-local-expire-from-prod.js --dry-run
 *   node scripts/sync-local-expire-from-prod.js
 */

const { openDatabase, applyEventTime, getEventByUid } = require("../lib/review-db");
const { TIME_SOURCE_MANUAL } = require("../lib/event-time-agent");
const { resolveExpiredAt, resolveStartAt } = require("../lib/event-import-ready");
const { createClientForEnv } = require("../lib/buzz-now-import");

const defaultDb = require("path").join(__dirname, "..", "data", "review.db");

function parseArgs(argv) {
  const options = { dbPath: defaultDb, dryRun: false, uid: "" };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (arg.startsWith("--uid=")) options.uid = arg.slice("--uid=".length).trim();
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  const client = createClientForEnv({ buzz_env: "prod" });

  let sql = `
    SELECT entity_uid, buzz_id
    FROM buzz_imports
    WHERE entity_kind = 'event' AND buzz_env = 'prod'
      AND import_status = 'imported' AND buzz_id != ''
  `;
  const params = [];
  if (options.uid) {
    sql += " AND entity_uid = ?";
    params.push(options.uid);
  }

  const rows = db.prepare(sql).all(...params);
  const fixes = [];
  let errors = 0;

  for (const row of rows) {
    const event = getEventByUid(db, row.entity_uid);
    if (!event) continue;
    const localExpired = String(resolveExpiredAt(event) || "").trim();
    const startAt = String(resolveStartAt(event) || "").trim();
    if (!startAt) continue;
    try {
      const now = await client.getNowById(row.buzz_id);
      const prodExpired = String(now?.expired_at || "").trim();
      if (!prodExpired || prodExpired === localExpired) continue;
      fixes.push({
        eventUid: row.entity_uid,
        title: event.title,
        localExpired,
        prodExpired,
        startAt,
      });
    } catch (error) {
      errors += 1;
      console.warn(`✗ ${row.entity_uid}: ${error.message}`);
    }
  }

  console.log(`正式/本地过期不一致: ${fixes.length} 条（查询失败 ${errors}）`);

  let updated = 0;
  for (const row of fixes) {
    const label = `${row.eventUid} · ${row.title?.slice(0, 24) || ""}`;
    if (options.dryRun) {
      console.log(`[dry-run] ${label}`);
      console.log(`  本地 ${row.localExpired} → 正式 ${row.prodExpired}`);
      updated += 1;
      continue;
    }
    applyEventTime(db, row.eventUid, {
      start_at: row.startAt,
      expired_at: row.prodExpired,
    }, { timeSource: TIME_SOURCE_MANUAL, force: true });
    updated += 1;
    console.log(`✓ ${label} → ${row.prodExpired}`);
  }

  console.log(`完成: 修正本地 ${updated} 条（未动正式环境）`);
  db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

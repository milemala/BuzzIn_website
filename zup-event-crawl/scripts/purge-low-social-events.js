#!/usr/bin/env node
"use strict";

/**
 * 从审核台清掉不结伴类型，并删除已同步到 Zup 的气泡。
 * 远程删除失败的活动留在审核台，方便下次再删。
 *
 *   node scripts/purge-low-social-events.js --dry-run
 *   node scripts/purge-low-social-events.js
 */

const fs = require("fs");
const path = require("path");
const { deleteEventFromBuzz } = require("../lib/buzz-now-import");
const { getComposedImagePath } = require("../lib/composed-image");
const { matchLowSocialEvent } = require("../lib/event-low-social-filter");
const { openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");

function parseArgs(argv) {
  const options = { dbPath: defaultDb, dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  return options;
}

function isUnexpired(row) {
  const day = String(row.end_date || row.start_date || "9999").trim() || "9999";
  const today = new Date();
  const local = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return day >= local;
}

function loadBuzzImports(db) {
  const rows = db.prepare(`
    SELECT buzz_env, entity_uid, buzz_id
    FROM buzz_imports
    WHERE entity_kind = 'event'
      AND trim(coalesce(buzz_id, '')) != ''
  `).all();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.entity_uid)) map.set(row.entity_uid, []);
    map.get(row.entity_uid).push(row);
  }
  return map;
}

function loadMatches(db) {
  const rows = db.prepare(`
    SELECT event_uid, city, title, source, start_date, end_date,
           substr(coalesce(body, ''), 1, 800) AS body,
           substr(coalesce(raw_detail_text, ''), 1, 800) AS raw_detail_text
    FROM events
  `).all();
  const buzzByUid = loadBuzzImports(db);
  const matches = [];
  for (const row of rows) {
    const hit = matchLowSocialEvent(row);
    if (!hit) continue;
    matches.push({
      ...row,
      tags: hit.tags,
      reason: hit.reason,
      unexpired: isUnexpired(row),
      buzz_imports: buzzByUid.get(row.event_uid) || [],
    });
  }
  return matches;
}

function buzzGone(message) {
  return /不存在|not found|已删除|404/i.test(String(message || ""));
}

function deleteLocalEvent(db, eventUid) {
  db.prepare("DELETE FROM event_dates WHERE event_uid = ?").run(eventUid);
  db.prepare("DELETE FROM review_decisions WHERE event_uid = ?").run(eventUid);
  db.prepare("DELETE FROM buzz_imports WHERE entity_kind = 'event' AND entity_uid = ?").run(eventUid);
  db.prepare("DELETE FROM events WHERE event_uid = ?").run(eventUid);
  const coverPath = getComposedImagePath(eventUid, root);
  if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
}

async function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  const matches = loadMatches(db);
  const unexpired = matches.filter((item) => item.unexpired).length;
  const withBuzz = matches.filter((item) => item.buzz_imports.length).length;

  console.log(`命中 ${matches.length} 条（未过期 ${unexpired}，已有气泡 ${withBuzz}）`);
  if (options.dryRun) {
    const byTag = new Map();
    for (const item of matches) {
      for (const tag of item.tags) byTag.set(tag, (byTag.get(tag) || 0) + 1);
    }
    for (const [tag, count] of [...byTag.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${tag} ${count}`);
    }
    db.close();
    return;
  }

  let localDeleted = 0;
  let buzzOk = 0;
  let buzzFail = 0;
  const failed = [];
  let processed = 0;

  for (const item of matches) {
    let remoteFailed = false;
    for (const imp of item.buzz_imports) {
      try {
        const result = await deleteEventFromBuzz(db, item.event_uid, { buzz_env: imp.buzz_env });
        if (result.ok) {
          buzzOk += 1;
        } else if (buzzGone(result.error)) {
          buzzOk += 1;
        } else {
          remoteFailed = true;
          buzzFail += 1;
          failed.push(`${item.city} ${item.title} · ${imp.buzz_env} ${result.error}`);
        }
      } catch (error) {
        if (buzzGone(error.message)) {
          buzzOk += 1;
        } else {
          remoteFailed = true;
          buzzFail += 1;
          failed.push(`${item.city} ${item.title} · ${imp.buzz_env} ${error.message}`);
        }
      }
    }
    if (!remoteFailed) {
      deleteLocalEvent(db, item.event_uid);
      localDeleted += 1;
    }
    processed += 1;
    if (processed % 100 === 0) {
      console.log(`已处理 ${processed} / ${matches.length}，审核台已删 ${localDeleted}，气泡成功 ${buzzOk}，失败 ${buzzFail}`);
    }
  }

  db.close();
  console.log(`审核台删除 ${localDeleted} 条 · 气泡删除成功 ${buzzOk} · 失败 ${buzzFail}`);
  if (failed.length) {
    console.log("以下活动因为气泡没删掉，审核台里还留着：");
    for (const line of failed) console.log(`  ${line}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

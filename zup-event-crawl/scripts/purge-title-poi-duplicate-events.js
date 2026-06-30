#!/usr/bin/env node
"use strict";

/**
 * 清理审核台中「同名 + 同 POI」重复活动：每组保留一条，删除其余。
 * 若重复条已推送 Buzz，先删后台气泡再删本地记录。
 *
 *   node scripts/purge-title-poi-duplicate-events.js --dry-run
 *   node scripts/purge-title-poi-duplicate-events.js
 */

const fs = require("fs");
const path = require("path");
const { deleteEventFromBuzz } = require("../lib/buzz-now-import");
const { getComposedImagePath } = require("../lib/composed-image");
const {
  eventTitlePoiDedupKey,
  compareEventsByEndDesc,
} = require("../lib/event-content-dedup");
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

function loadBuzzImports(db) {
  const rows = db.prepare(`
    SELECT buzz_env, entity_uid, buzz_id, import_status
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

function pickKeeper(items, buzzByUid) {
  return [...items].sort((a, b) => {
    const endCmp = compareEventsByEndDesc(b, a);
    if (endCmp !== 0) return endCmp;
    const aImp = (buzzByUid.get(a.event_uid) || []).length;
    const bImp = (buzzByUid.get(b.event_uid) || []).length;
    if (bImp !== aImp) return bImp - aImp;
    const aAp = a.review_status === "approved" ? 1 : 0;
    const bAp = b.review_status === "approved" ? 1 : 0;
    if (bAp !== aAp) return bAp - aAp;
    return String(a.event_uid).localeCompare(String(b.event_uid));
  })[0];
}

function buildDuplicatePlan(db) {
  const rows = db.prepare(`
    SELECT e.event_uid, e.city, e.title, e.location, e.location_poi_id, e.poi_title,
           e.end_date, e.start_date, e.source,
           COALESCE(r.status, 'pending') AS review_status
    FROM events e
    LEFT JOIN review_decisions r ON r.event_uid = e.event_uid
    WHERE trim(coalesce(e.location_poi_id, '')) != ''
      AND trim(coalesce(e.title, '')) != ''
  `).all();

  const buzzByUid = loadBuzzImports(db);
  const groups = new Map();
  for (const row of rows) {
    const key = eventTitlePoiDedupKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const plan = [];
  for (const [, items] of groups.entries()) {
    if (items.length < 2) continue;
    const keeper = pickKeeper(items, buzzByUid);
    for (const loser of items) {
      if (loser.event_uid === keeper.event_uid) continue;
      plan.push({
        city: keeper.city,
        title: keeper.title,
        poi_title: keeper.poi_title,
        keeper_uid: keeper.event_uid,
        loser_uid: loser.event_uid,
        buzz_imports: buzzByUid.get(loser.event_uid) || [],
      });
    }
  }
  return plan;
}

function deleteLocalEvent(db, eventUid, rootDir) {
  db.prepare("DELETE FROM event_dates WHERE event_uid = ?").run(eventUid);
  db.prepare("DELETE FROM review_decisions WHERE event_uid = ?").run(eventUid);
  db.prepare("DELETE FROM buzz_imports WHERE entity_kind = 'event' AND entity_uid = ?").run(eventUid);
  db.prepare("DELETE FROM events WHERE event_uid = ?").run(eventUid);
  const coverPath = getComposedImagePath(eventUid, rootDir);
  if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
}

async function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  const plan = buildDuplicatePlan(db);

  if (!plan.length) {
    console.log("未发现同名同 POI 重复活动。");
    db.close();
    return;
  }

  console.log(`发现 ${plan.length} 条待清理重复（${new Set(plan.map((p) => p.keeper_uid)).size} 组）`);
  if (options.dryRun) {
    for (const item of plan) {
      const buzzHint = item.buzz_imports.length
        ? ` · Buzz ${item.buzz_imports.map((b) => `${b.buzz_env}:${b.buzz_id}`).join(", ")}`
        : "";
      console.log(`[dry-run] 删 ${item.loser_uid} · 保留 ${item.keeper_uid} · ${item.title}${buzzHint}`);
    }
    db.close();
    return;
  }

  let buzzOk = 0;
  let buzzFail = 0;
  let localDeleted = 0;

  for (const item of plan) {
    console.log(`\n${item.title}`);
    console.log(`  保留: ${item.keeper_uid}`);
    console.log(`  删除: ${item.loser_uid}`);

    for (const imp of item.buzz_imports) {
      try {
        const result = await deleteEventFromBuzz(db, item.loser_uid, { buzz_env: imp.buzz_env });
        if (result.ok) {
          buzzOk += 1;
          console.log(`  ✓ Buzz ${imp.buzz_env} now_id=${imp.buzz_id}`);
        } else {
          buzzFail += 1;
          console.warn(`  ✗ Buzz ${imp.buzz_env}: ${result.error}`);
        }
      } catch (error) {
        buzzFail += 1;
        console.warn(`  ✗ Buzz ${imp.buzz_env}: ${error.message}`);
      }
    }

    deleteLocalEvent(db, item.loser_uid, root);
    localDeleted += 1;
    console.log("  ✓ 审核台记录已删除");
  }

  const remaining = buildDuplicatePlan(db).length;
  db.close();

  console.log(`\n完成：审核台删除 ${localDeleted} 条 · Buzz 成功 ${buzzOk} · Buzz 失败 ${buzzFail}`);
  console.log(`清理后剩余同名同 POI 重复：${remaining} 条`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

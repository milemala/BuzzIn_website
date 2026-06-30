#!/usr/bin/env node
"use strict";

/**
 * 从地址→POI 映射库为待定、无 POI 的活动直接写入 POI（不调用腾讯搜索）。
 * 仅活动；商户不走映射库。
 *
 *   node scripts/apply-poi-address-cache.js --city=成都
 *   node scripts/backfill-poi-address-cache.js
 */
const path = require("path");
const {
  openDatabase,
  applyEventPoiSelection,
  syncEventMerchantByPoi,
  getEventByUid,
} = require("../lib/review-db");
const {
  backfillPoiAddressCacheFromApproved,
  lookupPoiAddressCache,
  recordPoiAddressCacheHit,
  eventAddressText,
  cacheEntryToPoi,
} = require("../lib/poi-address-cache");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");

function parseArgs(argv) {
  const options = {
    city: "",
    dbPath: defaultDb,
    dryRun: false,
    backfill: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--backfill") options.backfill = true;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (arg === "--merchants-only" || arg === "--events-only") {
      console.warn("映射库仅用于活动，已忽略 --merchants-only / --events-only");
    }
  }
  return options;
}

async function applyEvents(db, options) {
  const today = new Date().toISOString().slice(0, 10);
  let sql = `
    SELECT e.*
    FROM events e
    LEFT JOIN review_decisions r ON r.event_uid = e.event_uid
    WHERE COALESCE(r.status, 'pending') = 'pending'
      AND (e.location_poi_id IS NULL OR trim(e.location_poi_id) = '')
      AND (e.end_date IS NULL OR trim(e.end_date) = '' OR e.end_date >= ?)
  `;
  const params = [today];
  if (options.city) {
    sql += " AND e.city = ?";
    params.push(options.city);
  }
  const rows = db.prepare(sql).all(...params);
  let hit = 0;
  let miss = 0;

  for (const row of rows) {
    const addressText = eventAddressText(row);
    const cached = lookupPoiAddressCache(db, { city: row.city, addressText });
    if (!cached) {
      miss += 1;
      continue;
    }
    const poi = cacheEntryToPoi(cached);
    if (!poi) {
      miss += 1;
      continue;
    }
    if (options.dryRun) {
      hit += 1;
      console.log(`[dry-run] ${row.title?.slice(0, 36)} → ${poi.title}`);
      continue;
    }
    const applyResult = applyEventPoiSelection(db, row.event_uid, poi, {
      candidates: [poi],
      matchSource: "cache",
      agentDoubtful: false,
      agentReason: `地址映射库命中：${cached.address_text}`,
      agentSearchKeyword: "poi-address-cache",
    });
    if (applyResult?.skipped) {
      miss += 1;
      console.log(`✗ 同名同POI重复 ${row.event_uid}（已有 ${applyResult.incumbent_uid}）`);
      continue;
    }
    await syncEventMerchantByPoi(db, row.event_uid);
    recordPoiAddressCacheHit(db, cached.cache_key);
    hit += 1;
    const event = getEventByUid(db, row.event_uid);
    console.log(`✓ ${event?.title?.slice(0, 40)} → ${poi.title}`);
  }

  return { hit, miss, total: rows.length };
}

async function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  try {
    if (options.backfill) {
      const filled = backfillPoiAddressCacheFromApproved(db);
      console.log(`映射库回填：活动 ${filled.events} · 合计 ${filled.total}`);
    }

    const eventSummary = await applyEvents(db, options);
    console.log(`活动：映射命中 ${eventSummary.hit} · 无映射 ${eventSummary.miss} · 共 ${eventSummary.total}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

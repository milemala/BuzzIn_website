#!/usr/bin/env node
"use strict";

/**
 * 导出待 POI 匹配的活动（按豆瓣 location 去重），供 Cursor Agent 处理。
 *
 *   node scripts/export-events-for-poi.js --city=深圳
 *   node scripts/export-events-for-poi.js --city=深圳 --refresh
 *   node scripts/export-events-for-poi.js --city=深圳 --refresh --pending-only
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");
const workbenchRoot = path.join(root, "data", "poi-agent-workbench");

function parseArgs(argv) {
  const options = {
    city: "",
    dbPath: defaultDb,
    refresh: false,
    pendingOnly: false,
    limit: 2000,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--pending-only") options.pendingOnly = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length)) || 2000;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (!arg.startsWith("--") && arg.endsWith(".db")) options.dbPath = arg;
  }
  if (!options.city) {
    throw new Error("请指定 --city=城市名");
  }
  return options;
}

function locationGroupKey(location, city) {
  const text = String(location || "").trim() || "(无地址)";
  const cityPrefix = String(city || "").trim();
  const normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha1").update(`${cityPrefix}|${normalized}`).digest("hex").slice(0, 12);
}

function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  try {
    let sql = `
      SELECT e.event_uid, e.city, e.title, e.location, e.location_poi_id
      FROM events e
      LEFT JOIN review_decisions r ON r.event_uid = e.event_uid
      WHERE e.source = 'douban' AND e.city = ?
    `;
    const params = [options.city];
    if (options.pendingOnly) {
      sql += " AND COALESCE(r.status, 'pending') = 'pending'";
    }
    if (!options.refresh) {
      sql += " AND (e.location_poi_id IS NULL OR trim(e.location_poi_id) = '')";
    }
    sql += " ORDER BY e.source_position ASC, e.event_uid ASC LIMIT ?";
    params.push(options.limit);

    const rows = db.prepare(sql).all(...params);
    const groupMap = new Map();

    for (const row of rows) {
      const groupId = locationGroupKey(row.location, row.city);
      if (!groupMap.has(groupId)) {
        groupMap.set(groupId, {
          group_id: groupId,
          location: String(row.location || "").trim(),
          sample_title: String(row.title || "").trim(),
          event_uids: [],
          event_count: 0,
        });
      }
      const group = groupMap.get(groupId);
      group.event_uids.push(row.event_uid);
      group.event_count += 1;
      if (!group.sample_title && row.title) group.sample_title = row.title;
    }

    const groups = [...groupMap.values()];
    const payload = {
      city: options.city,
      exported_at: new Date().toISOString(),
      db: options.dbPath,
      refresh: options.refresh,
      pending_only: options.pendingOnly,
      total_events: rows.length,
      group_count: groups.length,
      groups,
    };

    const outDir = path.join(workbenchRoot, options.city);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, "pending.json");
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`已导出 ${rows.length} 条活动 · ${groups.length} 个地址组 → ${outPath}`);
  } finally {
    db.close();
  }
}

main();

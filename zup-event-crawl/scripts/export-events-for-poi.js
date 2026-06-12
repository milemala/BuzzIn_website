#!/usr/bin/env node
"use strict";

/**
 * 导出 POI 任务（按地址去重），供 Cursor Agent 处理。
 *
 * 模式（二选一，与审核台筛选一致）：
 *   --pending-only   待定 + 无 POI + 未过期 → pending.json（未匹配 POI）
 *   --doubtful-only  待定 + 已有 POI + 存疑 + 未过期 → doubtful-pending.json（POI 存疑复核）
 *
 * Agent 定搜词 → poi-search-cli → 读候选手写 decisions.json → apply / merge-agent-poi-decisions
 *
 *   node scripts/export-events-for-poi.js --city=深圳 --refresh --pending-only
 *   node scripts/export-events-for-poi.js --city=上海 --source=xiaohongshu --refresh --doubtful-only
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
    source: "douban",
    dbPath: defaultDb,
    refresh: false,
    pendingOnly: false,
    doubtfulOnly: false,
    limit: 2000,
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length).trim() || "douban";
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--pending-only") options.pendingOnly = true;
    else if (arg === "--doubtful-only") options.doubtfulOnly = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length)) || 2000;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (!arg.startsWith("--") && arg.endsWith(".db")) options.dbPath = arg;
  }
  if (!options.city) {
    throw new Error("请指定 --city=城市名");
  }
  if (options.pendingOnly && options.doubtfulOnly) {
    throw new Error("--pending-only 与 --doubtful-only 不能同时使用");
  }
  return options;
}

function workbenchDir(city, source) {
  if (source === "xiaohongshu") {
    return path.join(workbenchRoot, `${city}-xhs`);
  }
  return path.join(workbenchRoot, city);
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
  const today = new Date().toISOString().slice(0, 10);
  try {
    let sql = `
      SELECT e.event_uid, e.city, e.title, e.location, e.location_poi_id,
        e.poi_title, e.poi_address, e.poi_agent_doubtful, e.poi_agent_reason
      FROM events e
      LEFT JOIN review_decisions r ON r.event_uid = e.event_uid
      WHERE e.source = ? AND e.city = ?
    `;
    const params = [options.source, options.city];

    if (options.pendingOnly) {
      sql += " AND COALESCE(r.status, 'pending') = 'pending'";
      sql += " AND (e.location_poi_id IS NULL OR trim(e.location_poi_id) = '')";
      sql += " AND (e.end_date IS NULL OR trim(e.end_date) = '' OR e.end_date >= ?)";
      params.push(today);
    } else if (options.doubtfulOnly) {
      sql += " AND COALESCE(r.status, 'pending') = 'pending'";
      sql += " AND e.poi_agent_doubtful = 1";
      sql += " AND (e.location_poi_id IS NOT NULL AND trim(e.location_poi_id) != '')";
      sql += " AND (e.end_date IS NULL OR trim(e.end_date) = '' OR e.end_date >= ?)";
      params.push(today);
    } else if (!options.refresh) {
      sql += " AND (e.location_poi_id IS NULL OR trim(e.location_poi_id) = '')";
    }

    sql += " ORDER BY e.source_position ASC, e.event_uid ASC LIMIT ?";
    params.push(options.limit);

    const rows = db.prepare(sql).all(...params);
    const groupMap = new Map();

    for (const row of rows) {
      const groupId = locationGroupKey(row.location, row.city);
      if (!groupMap.has(groupId)) {
        const base = {
          group_id: groupId,
          location: String(row.location || "").trim(),
          sample_title: String(row.title || "").trim(),
          event_uids: [],
          event_count: 0,
        };
        if (options.doubtfulOnly) {
          base.current_poi_id = String(row.location_poi_id || "").trim();
          base.current_poi_title = String(row.poi_title || "").trim();
          base.current_poi_address = String(row.poi_address || "").trim();
          base.poi_agent_reason = String(row.poi_agent_reason || "").trim();
        }
        groupMap.set(groupId, base);
      }
      const group = groupMap.get(groupId);
      group.event_uids.push(row.event_uid);
      group.event_count += 1;
      if (!group.sample_title && row.title) group.sample_title = row.title;
    }

    const groups = [...groupMap.values()];
    const exportMode = options.doubtfulOnly ? "doubtful" : (options.pendingOnly ? "unmatched" : "all_no_poi");
    const outName = options.doubtfulOnly ? "doubtful-pending.json" : "pending.json";

    const payload = {
      city: options.city,
      source: options.source,
      exported_at: new Date().toISOString(),
      db: options.dbPath,
      refresh: options.refresh,
      export_mode: exportMode,
      pending_only: options.pendingOnly,
      doubtful_only: options.doubtfulOnly,
      total_events: rows.length,
      group_count: groups.length,
      groups,
    };

    const outDir = workbenchDir(options.city, options.source);
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, outName);
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
    const modeLabel = options.doubtfulOnly ? "存疑复核" : (options.pendingOnly ? "未匹配 POI" : "无 POI");
    console.log(`已导出 [${modeLabel}] ${rows.length} 条活动 · ${groups.length} 个地址组 → ${outPath}`);
  } finally {
    db.close();
  }
}

main();

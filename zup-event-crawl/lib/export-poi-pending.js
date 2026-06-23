"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { lookupPoiAddressCache, cacheEntryToDecisionFields } = require("./poi-address-cache");
const { workbenchDir } = require("./export-classification-pending");
const { getLastImportNewUids } = require("./review-db");

function locationGroupKey(location, city) {
  const text = String(location || "").trim() || "(无地址)";
  const cityPrefix = String(city || "").trim();
  const normalized = text
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha1").update(`${cityPrefix}|${normalized}`).digest("hex").slice(0, 12);
}

function poiDecisionsPath(city, source = "douban") {
  return path.join(workbenchDir(city, source), "decisions.json");
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   city: string,
 *   source?: string,
 *   dbPath?: string,
 *   refresh?: boolean,
 *   pendingOnly?: boolean,
 *   doubtfulOnly?: boolean,
 *   newImportOnly?: boolean,
 *   limit?: number,
 * }} options
 */
function exportPoiPending(db, options) {
  const source = options.source || "douban";
  const city = String(options.city || "").trim();
  if (!city) throw new Error("请指定 city");

  const pendingOnly = Boolean(options.pendingOnly);
  const doubtfulOnly = Boolean(options.doubtfulOnly);
  const newImportOnly = Boolean(options.newImportOnly);
  const today = new Date().toISOString().slice(0, 10);

  if (newImportOnly && !pendingOnly) {
    throw new Error("--new-import-only 须与 --pending-only 一起使用");
  }

  const lastImportNewUids = newImportOnly ? getLastImportNewUids(db, city, source) : [];

  let sql = `
    SELECT e.event_uid, e.city, e.title, e.location, e.location_poi_id,
      e.poi_title, e.poi_address, e.poi_agent_doubtful, e.poi_agent_reason
    FROM events e
    LEFT JOIN review_decisions r ON r.event_uid = e.event_uid
    WHERE e.source = ? AND e.city = ?
  `;
  const params = [source, city];

  if (pendingOnly) {
    sql += " AND COALESCE(r.status, 'pending') = 'pending'";
    sql += " AND (e.location_poi_id IS NULL OR trim(e.location_poi_id) = '')";
    sql += " AND (e.end_date IS NULL OR trim(e.end_date) = '' OR e.end_date >= ?)";
    params.push(today);
  } else if (doubtfulOnly) {
    sql += " AND COALESCE(r.status, 'pending') = 'pending'";
    sql += " AND e.poi_agent_doubtful = 1";
    sql += " AND (e.location_poi_id IS NOT NULL AND trim(e.location_poi_id) != '')";
    sql += " AND (e.end_date IS NULL OR trim(e.end_date) = '' OR e.end_date >= ?)";
    params.push(today);
  } else if (!options.refresh) {
    sql += " AND (e.location_poi_id IS NULL OR trim(e.location_poi_id) = '')";
  }

  if (newImportOnly) {
    if (!lastImportNewUids.length) {
      sql += " AND 1 = 0";
    } else {
      sql += ` AND e.event_uid IN (${lastImportNewUids.map(() => "?").join(", ")})`;
      params.push(...lastImportNewUids);
    }
  }

  sql += " ORDER BY e.source_position ASC, e.event_uid ASC LIMIT ?";
  params.push(options.limit || 2000);

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
      if (doubtfulOnly) {
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
  let cacheHits = 0;
  if (pendingOnly) {
    for (const group of groups) {
      const cached = lookupPoiAddressCache(db, {
        city,
        addressText: group.location,
      });
      if (!cached) continue;
      const fields = cacheEntryToDecisionFields(cached);
      if (!fields) continue;
      group.cached_poi = fields;
      cacheHits += 1;
    }
  }

  const exportMode = doubtfulOnly ? "doubtful" : (newImportOnly ? "new_import_unmatched" : (pendingOnly ? "unmatched" : "all_no_poi"));
  const outName = doubtfulOnly ? "doubtful-pending.json" : "pending.json";
  const dbPath = options.dbPath || "";

  const payload = {
    city,
    source,
    exported_at: new Date().toISOString(),
    db: dbPath,
    refresh: Boolean(options.refresh),
    export_mode: exportMode,
    pending_only: pendingOnly,
    new_import_only: newImportOnly,
    last_import_new_uids: newImportOnly ? lastImportNewUids.length : undefined,
    doubtful_only: doubtfulOnly,
    total_events: rows.length,
    group_count: groups.length,
    cache_hit_groups: cacheHits,
    groups,
  };

  const outDir = workbenchDir(city, source);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, outName);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  return {
    outPath,
    outName,
    exportMode,
    city,
    source,
    totalEvents: rows.length,
    groupCount: groups.length,
    cacheHits,
  };
}

module.exports = {
  exportPoiPending,
  locationGroupKey,
  poiDecisionsPath,
};

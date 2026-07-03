"use strict";

const fs = require("fs");
const path = require("path");
const { CLASSIFICATION_SOURCE_AGENT } = require("./event-classification");
const { isExpired } = require("./event-import-ready");

const workbenchRoot = path.join(__dirname, "..", "data", "poi-agent-workbench");

function workbenchDir(city, source = "douban") {
  if (source === "xiaohongshu") {
    return path.join(workbenchRoot, `${city}-xhs`);
  }
  return path.join(workbenchRoot, city);
}

function excerpt(text, max = 480) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  return raw.length <= max ? raw : `${raw.slice(0, max)}…`;
}

function parseSlideCategory(rawDetailText) {
  const match = String(rawDetailText || "").match(/^分类[：:]\s*(.+)$/m);
  if (!match) return "";
  const value = match[1].trim();
  return value === "—" ? "" : value;
}

function listCitiesWithPendingClassification(db, source) {
  return db.prepare(`
    SELECT DISTINCT e.city
    FROM events e
    WHERE e.source = ?
      AND COALESCE(e.classification_source, 'pending') != ?
    ORDER BY e.city ASC
  `).all(source, CLASSIFICATION_SOURCE_AGENT)
    .map((row) => row.city)
    .filter(Boolean);
}

function listActiveClassificationGroups(db) {
  const rows = db.prepare(`
    SELECT city, source, end_date, start_date
    FROM events
    WHERE city IS NOT NULL AND city != ''
  `).all();
  const counts = new Map();
  for (const row of rows) {
    if (isExpired({ endDate: row.end_date, startDate: row.start_date })) continue;
    const key = `${row.city}\0${row.source || "douban"}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [city, source] = key.split("\0");
      return { city, source, count };
    })
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city, "zh-CN"));
}

function mapClassificationExportRow(row, source) {
  return {
    event_uid: row.event_uid,
    title: row.title,
    location: row.location,
    fee: row.fee,
    owner: row.owner,
    time_text: row.time_text,
    douban_event_type: row.douban_event_type || "",
    slide_category: source === "xiaohongshu" ? parseSlideCategory(row.raw_detail_text) : "",
    body_excerpt: excerpt(row.body),
    detail_excerpt: excerpt(row.raw_detail_text, 800),
    current_category: row.category || "",
    current_suggested: Boolean(row.suggested),
    current_reason: row.review_reason || "",
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   city: string,
 *   source?: string,
 *   refresh?: boolean,
 *   limit?: number,
 * }} options
 */
function exportClassificationPending(db, options) {
  const source = options.source || "douban";
  const city = String(options.city || "").trim();
  if (!city) {
    throw new Error("请指定 city");
  }

  let sql = `
    SELECT
      e.event_uid, e.city, e.title, e.location, e.fee, e.owner,
      e.time_text, e.body, e.douban_event_type, e.category, e.suggested,
      e.review_reason, e.classification_source, e.raw_detail_text, e.source
    FROM events e
    WHERE e.source = ? AND e.city = ?
  `;
  const params = [source, city];
  if (!options.refresh) {
    sql += ` AND COALESCE(e.classification_source, 'pending') != ?`;
    params.push(CLASSIFICATION_SOURCE_AGENT);
  }
  sql += ` ORDER BY e.source_position ASC, e.event_uid ASC LIMIT ?`;
  params.push(options.limit || 2000);

  const rows = db.prepare(sql).all(...params);
  const outDir = workbenchDir(city, source);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "classification-pending.json");
  const payload = {
    city,
    source,
    exported_at: new Date().toISOString(),
    note: "由 Cursor Agent 逐条判断 suggested（推荐/挡下）与 category。见 docs/event-classification-agent.md",
    events: rows.map((row) => mapClassificationExportRow(row, source)),
  };
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { outPath, count: rows.length, city, source };
}

/**
 * 导出某城某来源下全部未过期活动（强制重分类，含已 agent 分类的）。
 */
function exportActiveClassificationPending(db, options) {
  const source = options.source || "douban";
  const city = String(options.city || "").trim();
  if (!city) {
    throw new Error("请指定 city");
  }

  const sql = `
    SELECT
      e.event_uid, e.city, e.title, e.location, e.fee, e.owner,
      e.time_text, e.body, e.douban_event_type, e.category, e.suggested,
      e.review_reason, e.classification_source, e.raw_detail_text, e.source,
      e.end_date, e.start_date
    FROM events e
    WHERE e.source = ? AND e.city = ?
    ORDER BY e.source_position ASC, e.event_uid ASC
  `;
  const rows = db.prepare(sql).all(source, city)
    .filter((row) => !isExpired({ endDate: row.end_date, startDate: row.start_date }));

  const outDir = workbenchDir(city, source);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "classification-pending.json");
  const payload = {
    city,
    source,
    scope: "active_only",
    exported_at: new Date().toISOString(),
    note: "未过期活动全量重分类：Agent 读 title/body/location 判断 suggested + category",
    events: rows.map((row) => mapClassificationExportRow(row, source)),
  };
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return { outPath, count: rows.length, city, source };
}

function exportAllActiveClassification(db, options = {}) {
  const groups = options.groups?.length
    ? options.groups
    : listActiveClassificationGroups(db);
  const sourceFilter = options.source || "";
  const results = [];
  for (const group of groups) {
    if (sourceFilter && group.source !== sourceFilter) continue;
    results.push(exportActiveClassificationPending(db, {
      city: group.city,
      source: group.source,
    }));
  }
  return results;
}

function exportAllPendingClassification(db, options = {}) {
  const source = options.source || "douban";
  const cities = options.cities?.length
    ? options.cities
    : listCitiesWithPendingClassification(db, source);
  const results = [];
  for (const city of cities) {
    results.push(exportClassificationPending(db, {
      city,
      source,
      refresh: options.refresh,
      limit: options.limit,
    }));
  }
  return results;
}

function classificationDecisionsPath(city, source = "douban") {
  return path.join(workbenchDir(city, source), "classification-decisions.json");
}

module.exports = {
  classificationDecisionsPath,
  exportAllPendingClassification,
  exportAllActiveClassification,
  exportActiveClassificationPending,
  exportClassificationPending,
  listActiveClassificationGroups,
  listCitiesWithPendingClassification,
  workbenchDir,
};

"use strict";

function normalizeDedupText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 名称 + 地址 + 时间（同城）作为内容去重键 */
function eventContentDedupKey(event) {
  const city = normalizeDedupText(event.city);
  const title = normalizeDedupText(event.title);
  const location = normalizeDedupText(event.location);
  const timeText = normalizeDedupText(event.timeText ?? event.time_text ?? event.time);
  return `${city}\u0001${title}\u0001${location}\u0001${timeText}`;
}

function loadContentDedupKeys(db, options = {}) {
  const keys = new Set();
  if (!db) return keys;

  let sql = `
    SELECT city, title, location, time_text
    FROM events
    WHERE 1=1
  `;
  const params = [];
  if (options.city) {
    sql += " AND city = ?";
    params.push(options.city);
  }
  if (options.source) {
    sql += " AND source = ?";
    params.push(options.source);
  }

  const rows = db.prepare(sql).all(...params);
  for (const row of rows) {
    keys.add(eventContentDedupKey(row));
  }
  return keys;
}

function filterEventsByContentDedup(events, existingKeys, options = {}) {
  const seen = existingKeys instanceof Set ? new Set(existingKeys) : new Set(existingKeys || []);
  const kept = [];
  let skipped = 0;

  for (const event of events) {
    const key = eventContentDedupKey(event);
    if (seen.has(key)) {
      skipped += 1;
      if (options.log) {
        console.log(`Skip duplicate content: ${event.title || "(无标题)"}`);
      }
      continue;
    }
    seen.add(key);
    kept.push(event);
  }

  return { events: kept, skipped, seen };
}

module.exports = {
  eventContentDedupKey,
  filterEventsByContentDedup,
  loadContentDedupKeys,
  normalizeDedupText,
};

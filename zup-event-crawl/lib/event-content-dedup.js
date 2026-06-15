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

/** 同城 + 标题 + 地点（不含时间） */
function eventTitleLocationDedupKey(event) {
  const city = normalizeDedupText(event.city);
  const title = normalizeDedupText(event.title);
  const location = normalizeDedupText(event.location);
  if (!title || !location) return "";
  return `${city}\u0001${title}\u0001${location}`;
}

function eventEndSortKey(event) {
  const end = normalizeDedupText(event.endDate ?? event.end_date ?? "");
  const start = normalizeDedupText(event.startDate ?? event.start_date ?? "");
  return `${end || "0000-01-01"}\u0000${start || "0000-01-01"}`;
}

function eventTieBreakKey(event) {
  return String(
    event.event_uid
    || event.eventUid
    || event.id
    || event.source_id
    || "",
  );
}

/** 返回值 > 0 表示 a 的结束时间更晚（应保留 a） */
function compareEventsByEndDesc(a, b) {
  const keyA = `${eventEndSortKey(a)}\u0000${eventTieBreakKey(a)}`;
  const keyB = `${eventEndSortKey(b)}\u0000${eventTieBreakKey(b)}`;
  return keyA.localeCompare(keyB);
}

function isEventBetterByEnd(candidate, incumbent) {
  if (!incumbent) return true;
  return compareEventsByEndDesc(candidate, incumbent) > 0;
}

function pickEventWithLatestEnd(events) {
  if (!events?.length) return null;
  return [...events].sort((a, b) => compareEventsByEndDesc(b, a))[0];
}

function toTitleLocationIncumbent(event, city = "") {
  return {
    event_uid: event.event_uid || event.eventUid || null,
    city: event.city || city,
    title: event.title,
    location: event.location,
    start_date: event.startDate ?? event.start_date ?? null,
    end_date: event.endDate ?? event.end_date ?? null,
    id: event.id || event.source_id || null,
  };
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

function loadTitleLocationDedupIndex(db, options = {}) {
  const map = new Map();
  if (!db) return map;

  let sql = `
    SELECT event_uid, city, title, location, start_date, end_date, source, source_id
    FROM events
    WHERE trim(coalesce(title, '')) != ''
      AND trim(coalesce(location, '')) != ''
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
    const key = eventTitleLocationDedupKey(row);
    if (!key) continue;
    const prev = map.get(key);
    if (!prev || compareEventsByEndDesc(row, prev) > 0) {
      map.set(key, row);
    }
  }
  return map;
}

function collapseEventsByTitleLocation(events, city = "") {
  const winners = new Map();
  const noKey = [];
  for (const event of events) {
    const key = eventTitleLocationDedupKey({ ...event, city: event.city || city });
    if (!key) {
      noKey.push(event);
      continue;
    }
    const prev = winners.get(key);
    if (!prev || isEventBetterByEnd(event, prev)) {
      winners.set(key, event);
    }
  }
  return [...noKey, ...winners.values()];
}

function createTitleLocationDedupGate(initialIndex = new Map()) {
  const index = new Map(initialIndex);
  let skipped = 0;
  let replaced = 0;

  function decide(event, city = "") {
    const key = eventTitleLocationDedupKey({ ...event, city: event.city || city });
    if (!key) return { action: "import" };

    const incumbent = index.get(key);
    if (!incumbent) {
      index.set(key, toTitleLocationIncumbent(event, city));
      return { action: "import" };
    }

    if (isEventBetterByEnd(event, incumbent)) {
      const deleteUid = incumbent.event_uid || null;
      if (deleteUid) replaced += 1;
      index.set(key, toTitleLocationIncumbent(event, city));
      return { action: "import", deleteUid };
    }

    skipped += 1;
    return { action: "skip" };
  }

  return {
    decide,
    getStats: () => ({ skipped, replaced }),
    getIndex: () => index,
  };
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
  collapseEventsByTitleLocation,
  compareEventsByEndDesc,
  createTitleLocationDedupGate,
  eventContentDedupKey,
  eventTitleLocationDedupKey,
  filterEventsByContentDedup,
  isEventBetterByEnd,
  loadContentDedupKeys,
  loadTitleLocationDedupIndex,
  pickEventWithLatestEnd,
  toTitleLocationIncumbent,
  normalizeDedupText,
};

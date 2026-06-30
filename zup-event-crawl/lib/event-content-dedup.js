"use strict";

const { isExpired } = require("./event-import-ready");

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

/** 同城 + 标题 + POI（location_poi_id） */
function eventTitlePoiDedupKey(event) {
  const city = normalizeDedupText(event.city);
  const title = normalizeDedupText(event.title);
  const poiId = String(event.location_poi_id || event.locationPoiId || "").trim();
  if (!title || !poiId) return "";
  return `${city}\u0001${title}\u0001${poiId}`;
}

function isEventUnexpired(event) {
  return !isExpired(event);
}

function toTitlePoiIncumbent(event, city = "", poiId = "") {
  return {
    event_uid: event.event_uid || event.eventUid || null,
    id: event.id || event.source_id || null,
    city: event.city || city,
    title: event.title,
    location_poi_id: poiId || event.location_poi_id || "",
    end_date: event.endDate ?? event.end_date ?? null,
  };
}

function makePoiAddressCacheResolver(db) {
  const { lookupPoiAddressCache, eventAddressText } = require("./poi-address-cache");
  return (event, city = "") => {
    const direct = String(event.location_poi_id || event.locationPoiId || "").trim();
    if (direct) return direct;
    if (!db) return "";
    const cached = lookupPoiAddressCache(db, {
      city: event.city || city,
      addressText: eventAddressText(event),
    });
    return String(cached?.poi_id || "").trim();
  };
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

function loadTitlePoiUnexpiredIndex(db, options = {}) {
  const map = new Map();
  if (!db) return map;

  let sql = `
    SELECT event_uid, city, title, location_poi_id, start_date, end_date, source_id
    FROM events
    WHERE trim(coalesce(title, '')) != ''
      AND trim(coalesce(location_poi_id, '')) != ''
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
    if (!isEventUnexpired(row)) continue;
    const key = eventTitlePoiDedupKey(row);
    if (!key) continue;
    map.set(key, row);
  }
  return map;
}

function findTitlePoiUnexpiredConflict(db, eventUid, city, title, poiId) {
  if (!db || !poiId || !title) return null;
  const key = eventTitlePoiDedupKey({ city, title, location_poi_id: poiId });
  if (!key) return null;

  const rows = db.prepare(`
    SELECT event_uid, city, title, location_poi_id, start_date, end_date, source_id
    FROM events
    WHERE trim(coalesce(location_poi_id, '')) = ?
      AND trim(coalesce(city, '')) = ?
      AND event_uid != ?
  `).all(String(poiId).trim(), String(city || "").trim(), String(eventUid || ""));

  for (const row of rows) {
    if (eventTitlePoiDedupKey(row) !== key) continue;
    if (!isEventUnexpired(row)) continue;
    return row;
  }
  return null;
}

function createTitlePoiDedupGateFromDb(db, options = {}) {
  return createTitlePoiDedupGate(loadTitlePoiUnexpiredIndex(db, options), {
    resolvePoiId: makePoiAddressCacheResolver(db),
  });
}

function createTitlePoiDedupGate(initialIndex = new Map(), options = {}) {
  const index = new Map(initialIndex);
  let skipped = 0;
  const resolvePoiId = options.resolvePoiId || (() => "");

  function decide(event, city = "") {
    const eventCity = event.city || city;
    const poiId = resolvePoiId({ ...event, city: eventCity }, city);
    if (!poiId) return { action: "import" };

    const key = eventTitlePoiDedupKey({
      ...event,
      city: eventCity,
      location_poi_id: poiId,
    });
    if (!key) return { action: "import" };

    const incumbent = index.get(key);
    if (incumbent) {
      skipped += 1;
      return { action: "skip", poiId, incumbent };
    }
    return { action: "import", poiId };
  }

  function recordImported(event, city = "", poiId = "") {
    const eventCity = event.city || city;
    const resolvedPoiId = poiId || resolvePoiId({ ...event, city: eventCity }, city);
    if (!resolvedPoiId || !isEventUnexpired({ ...event, city: eventCity })) return;
    const key = eventTitlePoiDedupKey({
      ...event,
      city: eventCity,
      location_poi_id: resolvedPoiId,
    });
    if (!key) return;
    index.set(key, toTitlePoiIncumbent({ ...event, city: eventCity }, city, resolvedPoiId));
  }

  function releaseEvent(eventRef) {
    const ref = String(eventRef || "");
    if (!ref) return;
    for (const [key, incumbent] of index.entries()) {
      if (incumbent.event_uid === ref || incumbent.id === ref) {
        index.delete(key);
      }
    }
  }

  return {
    decide,
    recordImported,
    releaseEvent,
    getStats: () => ({ skipped }),
    getIndex: () => index,
  };
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
  createTitlePoiDedupGate,
  createTitlePoiDedupGateFromDb,
  eventContentDedupKey,
  eventTitleLocationDedupKey,
  eventTitlePoiDedupKey,
  filterEventsByContentDedup,
  findTitlePoiUnexpiredConflict,
  isEventBetterByEnd,
  isEventUnexpired,
  loadContentDedupKeys,
  loadTitleLocationDedupIndex,
  loadTitlePoiUnexpiredIndex,
  makePoiAddressCacheResolver,
  pickEventWithLatestEnd,
  toTitleLocationIncumbent,
  toTitlePoiIncumbent,
  normalizeDedupText,
};

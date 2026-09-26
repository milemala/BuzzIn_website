"use strict";

const { isExpired } = require("./event-import-ready");

function normalizeDedupText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 去营销词/标点后的标题，用于疑似同名判断 */
function fuzzyNormalizeEventTitle(title) {
  return String(title || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[【】\[\]()（）「」『』《》<>“”"'':：·•|｜！!？?…—\-–~～/\\、,.，。；;]/g, "")
    .replace(/\d{1,2}[./月]\d{1,2}(日)?/g, "")
    .replace(/20\d{2}年?/g, "")
    .replace(/(全国巡演|巡回|巡演|免费|限时|重磅|必看|必逛|打卡|攻略|合集|汇总|指南|收藏|马住|速码|冲就完了|冲|来袭|来啦|回归|上新|首开|首展|限定|别错过|不容错过|吐血整理|懒人收藏版)/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function extractTitleTokens(title) {
  const norm = fuzzyNormalizeEventTitle(title);
  const tokens = new Set();
  for (const match of norm.matchAll(/[\u4e00-\u9fa5]{2,}/gu)) tokens.add(match[0]);
  for (const match of norm.matchAll(/[a-z0-9]{2,}/gi)) tokens.add(match[0].toLowerCase());
  return [...tokens];
}

function titleTokenJaccard(a, b) {
  const left = new Set(extractTitleTokens(a));
  const right = new Set(extractTitleTokens(b));
  if (!left.size || !right.size) return 0;
  let inter = 0;
  for (const token of left) {
    if (right.has(token)) inter += 1;
  }
  const union = left.size + right.size - inter;
  return union ? inter / union : 0;
}

/** 疑似同一活动标题（非仅完全同名） */
function eventTitlesLikelySame(a, b) {
  const left = fuzzyNormalizeEventTitle(a);
  const right = fuzzyNormalizeEventTitle(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const minLen = Math.min(left.length, right.length);
  if (minLen >= 4 && (left.includes(right) || right.includes(left))) return true;
  return titleTokenJaccard(a, b) >= 0.72;
}

function findFuzzyIncumbentByTitlePoi(index, event, city = "", poiId = "") {
  const eventCity = normalizeDedupText(event.city || city);
  const title = event.title;
  const resolvedPoiId = String(poiId || "").trim();
  if (!title || !resolvedPoiId) return null;

  for (const incumbent of index.values()) {
    if (normalizeDedupText(incumbent.city) !== eventCity) continue;
    if (String(incumbent.location_poi_id || "").trim() !== resolvedPoiId) continue;
    if (!eventTitlesLikelySame(title, incumbent.title)) continue;
    if (isEventUnexpired(incumbent)) return incumbent;
  }
  return null;
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

/** 多个候选里取未过期、结束最晚的一条（用于标题+地点去重） */
function pickUnexpiredTitleLocationIncumbent(...candidates) {
  const unexpired = candidates.filter(Boolean).filter((row) => isEventUnexpired(row));
  return pickEventWithLatestEnd(unexpired);
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
    SELECT city, title, location, time_text, start_date, end_date
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
    if (!isEventUnexpired(row)) continue;
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
    if (!isEventUnexpired(row)) continue;
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
    const eventCity = event.city || city;
    const eventRow = { ...event, city: eventCity };
    const key = eventTitleLocationDedupKey(eventRow);
    if (!key) {
      noKey.push(event);
      continue;
    }
    const prev = winners.get(key);
    if (!prev) {
      winners.set(key, event);
      continue;
    }
    const prevRow = { ...prev, city: eventCity };
    const prevUnexpired = isEventUnexpired(prevRow);
    const curUnexpired = isEventUnexpired(eventRow);
    if (!prevUnexpired && curUnexpired) {
      winners.set(key, event);
    } else if (prevUnexpired && curUnexpired && isEventBetterByEnd(event, prev)) {
      winners.set(key, event);
    } else if (!prevUnexpired && !curUnexpired && isEventBetterByEnd(event, prev)) {
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

  for (const row of rows) {
    if (normalizeDedupText(row.city) !== normalizeDedupText(city)) continue;
    if (String(row.location_poi_id || "").trim() !== String(poiId).trim()) continue;
    if (!eventTitlesLikelySame(title, row.title)) continue;
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
    const eventRow = { ...event, city: eventCity };
    const poiId = resolvePoiId(eventRow, city);
    if (!poiId) return { action: "import" };

    const key = eventTitlePoiDedupKey({
      ...eventRow,
      location_poi_id: poiId,
    });
    if (!key) return { action: "import" };

    const incumbent = index.get(key) || findFuzzyIncumbentByTitlePoi(index, eventRow, eventCity, poiId);
    if (incumbent && isEventUnexpired(incumbent)) {
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
    const eventCity = event.city || city;
    const eventRow = { ...event, city: eventCity };
    const key = eventTitleLocationDedupKey(eventRow);
    if (!key) return { action: "import" };

    const incumbent = index.get(key);
    const incomingUnexpired = isEventUnexpired(eventRow);

    if (!incumbent || !isEventUnexpired(incumbent)) {
      if (incomingUnexpired) {
        index.set(key, toTitleLocationIncumbent(event, city));
      }
      return { action: "import" };
    }

    if (!incomingUnexpired) {
      skipped += 1;
      return { action: "skip" };
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
  eventTitlesLikelySame,
  filterEventsByContentDedup,
  findFuzzyIncumbentByTitlePoi,
  findTitlePoiUnexpiredConflict,
  fuzzyNormalizeEventTitle,
  isEventBetterByEnd,
  isEventUnexpired,
  loadContentDedupKeys,
  loadTitleLocationDedupIndex,
  loadTitlePoiUnexpiredIndex,
  makePoiAddressCacheResolver,
  pickEventWithLatestEnd,
  pickUnexpiredTitleLocationIncumbent,
  toTitleLocationIncumbent,
  toTitlePoiIncumbent,
  normalizeDedupText,
};

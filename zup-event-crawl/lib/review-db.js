"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  DEFAULT_NOW_TYPE,
  DEFAULT_PUBLISH_USER_ID,
  buildImportRecord,
  isExpired,
  isImportReady,
  normalizeNowType,
  resolveExpiredAt,
  resolvePoiCoordinates,
  resolveStartAt,
} = require("./event-import-ready");

const DEFAULT_NOTE = "本文件用于本地人工审核。保留原始抓取详情文本，body 为基于原文提炼的 Zup 活动简介。图片发布前需再次确认来源授权与平台规则。";
const VALID_REVIEW_STATUSES = new Set(["approved", "pending", "rejected"]);

const EVENT_IMPORT_COLUMNS = [
  ["publish_user_id", `TEXT NOT NULL DEFAULT '${DEFAULT_PUBLISH_USER_ID}'`],
  ["now_type", `INTEGER NOT NULL DEFAULT ${DEFAULT_NOW_TYPE}`],
  ["location_poi_id", "TEXT NOT NULL DEFAULT ''"],
  ["poi_title", "TEXT NOT NULL DEFAULT ''"],
  ["poi_address", "TEXT NOT NULL DEFAULT ''"],
  ["poi_candidates", "TEXT NOT NULL DEFAULT '[]'"],
  ["poi_updated_at", "TEXT"],
  ["poi_latitude", "REAL"],
  ["poi_longitude", "REAL"],
  ["now_merchant_id", "TEXT NOT NULL DEFAULT ''"],
  ["now_merchant_name", "TEXT NOT NULL DEFAULT ''"],
  ["buzz_now_id", "TEXT NOT NULL DEFAULT ''"],
  ["buzz_group_id", "TEXT NOT NULL DEFAULT ''"],
  ["import_status", "TEXT NOT NULL DEFAULT ''"],
  ["import_error", "TEXT NOT NULL DEFAULT ''"],
  ["imported_at", "TEXT"],
];

function parsePoiCandidates(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function migrateEventImportColumns(db) {
  const existing = new Set(
    db.prepare("PRAGMA table_info(events)").all().map((row) => row.name),
  );
  for (const [name, ddl] of EVENT_IMPORT_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${name} ${ddl}`);
    }
  }
}

function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  ensureSchema(db);
  ensureDefaultMeta(db);
  return db;
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      event_uid TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source TEXT NOT NULL,
      source_name TEXT,
      source_position INTEGER,
      source_url TEXT,
      source_list_page TEXT,
      city TEXT,
      district TEXT,
      title TEXT NOT NULL,
      category TEXT,
      start_date TEXT,
      end_date TEXT,
      time_text TEXT,
      location TEXT,
      latitude REAL,
      longitude REAL,
      image TEXT,
      fee TEXT,
      owner TEXT,
      counts TEXT,
      raw_detail_text TEXT,
      raw_detail_html TEXT,
      body TEXT,
      original_link TEXT,
      score INTEGER,
      suggested INTEGER NOT NULL DEFAULT 0,
      review_reason TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_city ON events(city);
    CREATE INDEX IF NOT EXISTS idx_events_source ON events(source);
    CREATE INDEX IF NOT EXISTS idx_events_source_position ON events(city, source_position);
    CREATE INDEX IF NOT EXISTS idx_events_start_date ON events(start_date);

    CREATE TABLE IF NOT EXISTS event_dates (
      event_uid TEXT NOT NULL,
      event_date TEXT NOT NULL,
      PRIMARY KEY (event_uid, event_date),
      FOREIGN KEY (event_uid) REFERENCES events(event_uid) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_event_dates_date ON event_dates(event_date);

    CREATE TABLE IF NOT EXISTS review_decisions (
      event_uid TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('approved', 'pending', 'rejected')),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (event_uid) REFERENCES events(event_uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS city_imports (
      city TEXT PRIMARY KEY,
      generated_at TEXT,
      source_page TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const columns = new Set(db.prepare("PRAGMA table_info(events)").all().map((column) => column.name));
  if (!columns.has("raw_detail_text")) {
    db.exec("ALTER TABLE events ADD COLUMN raw_detail_text TEXT");
  }
  if (!columns.has("raw_detail_html")) {
    db.exec("ALTER TABLE events ADD COLUMN raw_detail_html TEXT");
  }
  migrateEventImportColumns(db);
}

function rowToEvent(row) {
  return {
    eventUid: row.event_uid,
    event_uid: row.event_uid,
    id: row.source_id,
    source: row.source,
    sourceName: row.source_name,
    sourcePosition: row.source_position,
    sourceUrl: row.source_url,
    sourceListPage: row.source_list_page,
    city: row.city,
    district: row.district,
    title: row.title,
    category: row.category,
    startDate: row.start_date,
    endDate: row.end_date,
    timeText: row.time_text,
    location: row.location,
    latitude: row.latitude,
    longitude: row.longitude,
    poi_latitude: row.poi_latitude ?? null,
    poi_longitude: row.poi_longitude ?? null,
    image: row.image,
    fee: row.fee,
    owner: row.owner,
    counts: row.counts,
    rawDetailText: row.raw_detail_text,
    rawDetailHtml: row.raw_detail_html,
    body: row.body,
    originalLink: row.original_link,
    score: row.score,
    suggested: Boolean(row.suggested),
    reviewReason: row.review_reason,
    publish_user_id: row.publish_user_id || DEFAULT_PUBLISH_USER_ID,
    now_type: normalizeNowType(row.now_type),
    location_poi_id: row.location_poi_id || "",
    poi_title: row.poi_title || "",
    poi_address: row.poi_address || "",
    poi_candidates: parsePoiCandidates(row.poi_candidates),
    poi_updated_at: row.poi_updated_at || null,
    now_merchant_id: row.now_merchant_id || "",
    now_merchant_name: row.now_merchant_name || "",
    buzz_now_id: row.buzz_now_id || "",
    buzz_group_id: row.buzz_group_id || "",
    import_status: row.import_status || "",
    import_error: row.import_error || "",
    imported_at: row.imported_at || null,
    start_at: resolveStartAt(row),
    expired_at: resolveExpiredAt(row),
    import_ready: isImportReady(row),
    ...(() => {
      const coords = resolvePoiCoordinates(row);
      return {
        location_latitude: coords.latitude,
        location_longitude: coords.longitude,
      };
    })(),
  };
}

function getEventByUid(db, eventUid) {
  const row = db.prepare("SELECT * FROM events WHERE event_uid = ?").get(eventUid);
  return row ? rowToEvent(row) : null;
}

function applyEventPoiSelection(db, eventUid, poi, options = {}) {
  const now = new Date().toISOString();
  const event = getEventByUid(db, eventUid);
  if (!event) {
    throw new Error(`活动不存在: ${eventUid}`);
  }

  db.prepare(`
    UPDATE events SET
      location_poi_id = @location_poi_id,
      poi_title = @poi_title,
      poi_address = @poi_address,
      poi_latitude = @poi_latitude,
      poi_longitude = @poi_longitude,
      poi_candidates = @poi_candidates,
      poi_updated_at = @poi_updated_at,
      now_merchant_id = '',
      now_merchant_name = '',
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({
    event_uid: eventUid,
    location_poi_id: poi.poi_id || "",
    poi_title: poi.title || "",
    poi_address: poi.address || "",
    poi_latitude: poi.latitude ?? null,
    poi_longitude: poi.longitude ?? null,
    poi_candidates: JSON.stringify(options.candidates || []),
    poi_updated_at: now,
    updated_at: now,
  });

  return getEventByUid(db, eventUid);
}

function updateEventMerchantInfo(db, eventUid, info = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE events SET
      now_merchant_id = @now_merchant_id,
      now_merchant_name = @now_merchant_name,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({
    event_uid: eventUid,
    now_merchant_id: String(info.now_merchant_id || "").trim(),
    now_merchant_name: String(info.now_merchant_name || "").trim(),
    updated_at: now,
  });
  return getEventByUid(db, eventUid);
}

async function syncEventMerchantByPoi(db, eventUid) {
  const event = getEventByUid(db, eventUid);
  if (!event) {
    throw new Error(`活动不存在: ${eventUid}`);
  }
  const poiId = String(event.location_poi_id || "").trim();
  if (!poiId) {
    return updateEventMerchantInfo(db, eventUid, { now_merchant_id: "", now_merchant_name: "" });
  }
  const { lookupMerchantByPoiId } = require("./buzz-merchant-poi");
  const found = await lookupMerchantByPoiId(poiId);
  return updateEventMerchantInfo(db, eventUid, {
    now_merchant_id: found?.merchant_id || "",
    now_merchant_name: found?.merchant_name || "",
  });
}

async function syncMerchantsForPoiEvents(db, options = {}) {
  const rows = db.prepare(`
    SELECT event_uid, location_poi_id, now_merchant_id
    FROM events
    WHERE location_poi_id IS NOT NULL AND location_poi_id != ''
  `).all();
  let updated = 0;
  for (const row of rows) {
    if (options.only_missing && row.now_merchant_id) continue;
    await syncEventMerchantByPoi(db, row.event_uid);
    updated += 1;
  }
  return { updated };
}

function markEventImportResult(db, eventUid, result = {}) {
  const current = getEventByUid(db, eventUid);
  const now = new Date().toISOString();
  const imported = result.import_status === "imported";
  const pick = (key, fallback = "") => (
    Object.prototype.hasOwnProperty.call(result, key)
      ? String(result[key] || "").trim()
      : String(current?.[key] || fallback).trim()
  );
  db.prepare(`
    UPDATE events SET
      buzz_now_id = @buzz_now_id,
      buzz_group_id = @buzz_group_id,
      import_status = @import_status,
      import_error = @import_error,
      imported_at = @imported_at,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({
    event_uid: eventUid,
    buzz_now_id: pick("buzz_now_id"),
    buzz_group_id: pick("buzz_group_id"),
    import_status: pick("import_status"),
    import_error: pick("import_error"),
    imported_at: imported ? now : (current?.imported_at || null),
    updated_at: now,
  });
  return getEventByUid(db, eventUid);
}

function clearEventBuzzNow(db, eventUid) {
  return markEventImportResult(db, eventUid, {
    buzz_now_id: "",
    buzz_group_id: "",
    import_status: "",
    import_error: "",
  });
}

function listEventsEligibleForImport(db, options = {}) {
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 500;
  const rows = db.prepare(`
    SELECT e.*
    FROM events e
    INNER JOIN review_decisions r ON r.event_uid = e.event_uid
    WHERE r.status = 'approved'
      AND (e.import_status IS NULL OR e.import_status = '' OR e.import_status = 'failed')
    ORDER BY e.city, e.source_position, e.title
    LIMIT ?
  `).all(limit);
  return rows
    .map((row) => rowToEvent(row))
    .filter((event) => !isExpired(event))
    .filter((event) => isImportReady(event));
}

function updateEventPoiCandidatesOnly(db, eventUid, candidates) {
  const event = getEventByUid(db, eventUid);
  if (!event) {
    throw new Error(`活动不存在: ${eventUid}`);
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE events SET
      poi_candidates = @poi_candidates,
      poi_updated_at = @poi_updated_at,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({
    event_uid: eventUid,
    poi_candidates: JSON.stringify(candidates || []),
    poi_updated_at: now,
    updated_at: now,
  });

  return getEventByUid(db, eventUid);
}

function updateEventImportPrep(db, eventUid, patch) {
  const event = getEventByUid(db, eventUid);
  if (!event) {
    throw new Error(`活动不存在: ${eventUid}`);
  }

  const now = new Date().toISOString();
  const next = {
    publish_user_id: patch.publish_user_id !== undefined
      ? String(patch.publish_user_id || "").trim()
      : event.publish_user_id,
    now_type: patch.now_type !== undefined
      ? normalizeNowType(patch.now_type)
      : event.now_type,
  };

  db.prepare(`
    UPDATE events SET
      publish_user_id = @publish_user_id,
      now_type = @now_type,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({
    event_uid: eventUid,
    publish_user_id: next.publish_user_id || DEFAULT_PUBLISH_USER_ID,
    now_type: next.now_type,
    updated_at: now,
  });

  return getEventByUid(db, eventUid);
}

function listActiveEventsNeedingPoi(db, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  const rows = db.prepare(`
    SELECT e.*, COALESCE(r.status, 'pending') AS review_status
    FROM events e
    LEFT JOIN review_decisions r ON r.event_uid = e.event_uid
    ORDER BY e.city, e.source_position, e.title
  `).all();

  let events = rows
    .map((row) => ({ ...rowToEvent(row), review_status: row.review_status }))
    .filter((event) => !isExpired(event));

  if (options.city) {
    events = events.filter((event) => event.city === options.city);
  }
  if (options.only_approved) {
    events = events.filter((event) => event.review_status === "approved");
  }
  if (!options.include_with_poi) {
    events = events.filter((event) => !event.location_poi_id);
  }

  return events.slice(0, limit);
}

function syncEventPoiCoordinates(db) {
  const rows = db.prepare(`
    SELECT event_uid, location_poi_id, poi_candidates, poi_latitude, poi_longitude
    FROM events
    WHERE location_poi_id IS NOT NULL AND location_poi_id != ''
  `).all();
  const update = db.prepare(`
    UPDATE events SET
      poi_latitude = @poi_latitude,
      poi_longitude = @poi_longitude,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `);
  const now = new Date().toISOString();
  let updated = 0;

  runInTransaction(db, () => {
    for (const row of rows) {
      const coords = resolvePoiCoordinates(row);
      if (coords.latitude == null || coords.longitude == null) continue;
      if (row.poi_latitude === coords.latitude && row.poi_longitude === coords.longitude) continue;
      update.run({
        event_uid: row.event_uid,
        poi_latitude: coords.latitude,
        poi_longitude: coords.longitude,
        updated_at: now,
      });
      updated += 1;
    }
  });

  return { updated, total: rows.length };
}

function applyDefaultImportPrepToActiveEvents(db) {
  const rows = db.prepare("SELECT event_uid, start_date, end_date FROM events").all();
  const now = new Date().toISOString();
  const update = db.prepare(`
    UPDATE events SET
      publish_user_id = @publish_user_id,
      now_type = @now_type,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `);

  let updated = 0;
  runInTransaction(db, () => {
    for (const row of rows) {
      if (isExpired(row)) continue;
      update.run({
        event_uid: row.event_uid,
        publish_user_id: DEFAULT_PUBLISH_USER_ID,
        now_type: DEFAULT_NOW_TYPE,
        updated_at: now,
      });
      updated += 1;
    }
  });

  return { updated };
}

async function resolveMerchantLookupForEvents(db, events, options = {}) {
  const { buildPoiMerchantIdMap, createMerchantIdResolver } = require("./buzz-merchant-poi");
  const poiIds = events.map((event) => event.location_poi_id);
  let poiMap = new Map();
  if (options.skipMerchantLookup !== true) {
    try {
      poiMap = await buildPoiMerchantIdMap(poiIds, options.merchantPoiOptions);
    } catch (error) {
      if (options.merchantPoiOptions?.strict) throw error;
      console.warn("[export] merchant/poi/info:", error.message);
    }
  }
  return createMerchantIdResolver(db, poiMap);
}

async function getExportImportNows(db, options = {}) {
  const approvedOnly = options.approvedOnly !== false;
  const readyOnly = options.readyOnly !== false;
  const rows = db.prepare(`
    SELECT e.*, COALESCE(r.status, 'pending') AS review_status
    FROM events e
    LEFT JOIN review_decisions r ON r.event_uid = e.event_uid
    ORDER BY e.city, e.source_position, e.title
  `).all();

  const events = [];
  for (const row of rows) {
    if (isExpired(row)) continue;
    if (approvedOnly && row.review_status !== "approved") continue;
    const event = rowToEvent(row);
    if (readyOnly && !isImportReady(event)) continue;
    events.push(event);
  }

  const merchantLookup = await resolveMerchantLookupForEvents(db, events, options);
  return events.map((event) => buildImportRecord(event, { findMerchantIdByPoi: merchantLookup }));
}

function ensureDefaultMeta(db) {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES ('note', ?)
    ON CONFLICT(key) DO NOTHING
  `).run(DEFAULT_NOTE);
}

function runInTransaction(db, work) {
  db.exec("BEGIN");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function eventUidFor(event) {
  const source = event.source || "unknown";
  const sourceId = event.id || event.originalLink || event.sourceUrl || event.title;
  return `${source}:${sourceId}`;
}

function getMetaValue(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setMetaValue(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function groupEventsByCity(payload) {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const groups = new Map();
  for (const event of events) {
    const city = event.city || payload.city || "未知城市";
    if (!groups.has(city)) groups.set(city, []);
    groups.get(city).push(event);
  }
  return groups;
}

function importPayload(db, payload, options = {}) {
  const mode = options.mode || "replace-all";
  const groups = groupEventsByCity(payload);
  const cityMeta = payload.cityMeta || {};
  const sourcePages = payload.sourcePages || {};
  const note = payload.note || DEFAULT_NOTE;

  const deleteCity = db.prepare("DELETE FROM events WHERE city = ?");
  const deleteAllEvents = db.prepare("DELETE FROM events");
  const deleteAllCityImports = db.prepare("DELETE FROM city_imports");
  const upsertEvent = db.prepare(`
    INSERT INTO events (
      event_uid, source_id, source, source_name, source_position, source_url, source_list_page,
      city, district, title, category, start_date, end_date, time_text, location,
      latitude, longitude, image, fee, owner, counts, raw_detail_text, raw_detail_html, body, original_link,
      score, suggested, review_reason, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(event_uid) DO UPDATE SET
      source_id = excluded.source_id,
      source = excluded.source,
      source_name = excluded.source_name,
      source_position = excluded.source_position,
      source_url = excluded.source_url,
      source_list_page = excluded.source_list_page,
      city = excluded.city,
      district = excluded.district,
      title = excluded.title,
      category = excluded.category,
      start_date = excluded.start_date,
      end_date = excluded.end_date,
      time_text = excluded.time_text,
      location = excluded.location,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      image = excluded.image,
      fee = excluded.fee,
      owner = excluded.owner,
      counts = excluded.counts,
      raw_detail_text = excluded.raw_detail_text,
      raw_detail_html = excluded.raw_detail_html,
      body = excluded.body,
      original_link = excluded.original_link,
      score = excluded.score,
      suggested = excluded.suggested,
      review_reason = excluded.review_reason,
      updated_at = excluded.updated_at
  `);
  const deleteEventDates = db.prepare("DELETE FROM event_dates WHERE event_uid = ?");
  const insertEventDate = db.prepare("INSERT OR IGNORE INTO event_dates (event_uid, event_date) VALUES (?, ?)");
  const upsertCityImport = db.prepare(`
    INSERT INTO city_imports (city, generated_at, source_page, event_count, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(city) DO UPDATE SET
      generated_at = excluded.generated_at,
      source_page = excluded.source_page,
      event_count = excluded.event_count,
      updated_at = excluded.updated_at
  `);

  runInTransaction(db, () => {
    setMetaValue(db, "note", note);

    if (mode === "replace-all") {
      deleteAllEvents.run();
      deleteAllCityImports.run();
    } else {
      for (const city of groups.keys()) {
        deleteCity.run(city);
      }
    }

    for (const [city, events] of groups.entries()) {
      const generatedAt = cityMeta[city]?.generatedAt || payload.generatedAt || new Date().toISOString();
      const sourcePage = cityMeta[city]?.sourcePage || sourcePages[city] || payload.sourcePage || null;

      for (const event of events) {
        const eventUid = eventUidFor(event);
        upsertEvent.run(
          eventUid,
          event.id || "",
          event.source || "unknown",
          event.sourceName || "",
          Number.isFinite(Number(event.sourcePosition)) ? Number(event.sourcePosition) : null,
          event.sourceUrl || null,
          event.sourceListPage || sourcePage,
          city,
          event.district || null,
          event.title || "",
          event.category || null,
          event.startDate || null,
          event.endDate || null,
          event.timeText || null,
          event.location || null,
          Number.isFinite(Number(event.latitude)) ? Number(event.latitude) : null,
          Number.isFinite(Number(event.longitude)) ? Number(event.longitude) : null,
          event.image || null,
          event.fee || null,
          event.owner || null,
          event.counts || null,
          event.rawDetailText || null,
          event.rawDetailHtml || null,
          event.body || null,
          event.originalLink || null,
          Number.isFinite(Number(event.score)) ? Number(event.score) : null,
          event.suggested ? 1 : 0,
          event.reviewReason || null,
          new Date().toISOString()
        );

        deleteEventDates.run(eventUid);
        for (const eventDate of Array.isArray(event.eventDates) ? event.eventDates : []) {
          insertEventDate.run(eventUid, eventDate);
        }
      }

      upsertCityImport.run(
        city,
        generatedAt,
        sourcePage,
        events.length,
        new Date().toISOString()
      );
    }
  });
}

function importReviewState(db, state) {
  const decisions = state && state.decisions && typeof state.decisions === "object" ? state.decisions : {};
  replaceReviewState(db, decisions);
}

function buildDecisionLookup(db) {
  const rows = db.prepare("SELECT event_uid, source_id FROM events").all();
  const lookup = new Map();
  const sourceIdCounts = new Map();

  for (const row of rows) {
    lookup.set(row.event_uid, row.event_uid);
    sourceIdCounts.set(row.source_id, (sourceIdCounts.get(row.source_id) || 0) + 1);
  }

  for (const row of rows) {
    if (sourceIdCounts.get(row.source_id) === 1) {
      lookup.set(row.source_id, row.event_uid);
    }
  }

  return lookup;
}

function upsertReviewDecision(db, eventUid, status) {
  if (!VALID_REVIEW_STATUSES.has(status)) {
    throw new Error(`无效审核状态: ${status}`);
  }
  const event = getEventByUid(db, eventUid);
  if (!event) {
    throw new Error(`活动不存在: ${eventUid}`);
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO review_decisions (event_uid, status, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(event_uid) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(eventUid, status, now);
  return status;
}

function rejectEventForMissingPoi(db, eventUid) {
  upsertReviewDecision(db, eventUid, "rejected");
  return getEventByUid(db, eventUid);
}

function resolveDecisionEventUid(db, key) {
  const lookup = buildDecisionLookup(db);
  return lookup.get(String(key || "").trim()) || null;
}

function patchReviewDecision(db, key, status) {
  if (!VALID_REVIEW_STATUSES.has(status)) {
    throw new Error(`无效审核状态: ${status}`);
  }
  const eventUid = resolveDecisionEventUid(db, key);
  if (!eventUid) {
    throw new Error(`活动不存在: ${key}`);
  }
  return upsertReviewDecision(db, eventUid, status);
}

function patchReviewDecisions(db, decisions) {
  const entries = Object.entries(decisions || {});
  runInTransaction(db, () => {
    for (const [key, status] of entries) {
      if (!VALID_REVIEW_STATUSES.has(status)) continue;
      patchReviewDecision(db, key, status);
    }
  });
}

function clearReviewDecisions(db) {
  db.prepare("DELETE FROM review_decisions").run();
}

function replaceReviewState(db, decisions) {
  const lookup = buildDecisionLookup(db);
  const insertDecision = db.prepare(`
    INSERT INTO review_decisions (event_uid, status, updated_at)
    VALUES (?, ?, ?)
  `);

  runInTransaction(db, () => {
    db.prepare("DELETE FROM review_decisions").run();
    for (const [key, status] of Object.entries(decisions || {})) {
      if (!VALID_REVIEW_STATUSES.has(status)) continue;
      const eventUid = lookup.get(key);
      if (!eventUid) continue;
      insertDecision.run(eventUid, status, new Date().toISOString());
    }
  });
}

function getReviewState(db) {
  const rows = db.prepare("SELECT event_uid, status, updated_at FROM review_decisions ORDER BY updated_at DESC").all();
  const decisions = {};
  let updatedAt = null;

  for (const row of rows) {
    decisions[row.event_uid] = row.status;
    if (!updatedAt || row.updated_at > updatedAt) updatedAt = row.updated_at;
  }

  return { updatedAt, decisions };
}

async function getApprovedEvents(db, options = {}) {
  const rows = db.prepare(`
    SELECT e.*
    FROM events e
    INNER JOIN review_decisions r ON r.event_uid = e.event_uid
    WHERE r.status = 'approved'
    ORDER BY e.city, e.source_position, e.title
  `).all();

  const events = rows
    .map((row) => rowToEvent(row))
    .filter((event) => !isExpired(event));
  const merchantLookup = await resolveMerchantLookupForEvents(db, events, options);
  return events.map((event) => buildImportRecord(event, { findMerchantIdByPoi: merchantLookup }));
}

function countApprovedActiveEvents(db) {
  const rows = db.prepare(`
    SELECT e.end_date, e.start_date
    FROM events e
    INNER JOIN review_decisions r ON r.event_uid = e.event_uid
    WHERE r.status = 'approved'
  `).all();
  return rows.filter((item) => !isExpired(item)).length;
}

function getEventsPayload(db) {
  const cityImportRows = db.prepare(`
    SELECT city, generated_at AS generatedAt, source_page AS sourcePage, event_count AS eventCount
    FROM city_imports
    ORDER BY rowid
  `).all();
  const eventRows = db.prepare(`
    SELECT *
    FROM events
    ORDER BY city, source_position, title
  `).all();
  const dateRows = db.prepare("SELECT event_uid, event_date FROM event_dates ORDER BY event_date").all();

  const eventDatesByUid = new Map();
  for (const row of dateRows) {
    if (!eventDatesByUid.has(row.event_uid)) eventDatesByUid.set(row.event_uid, []);
    eventDatesByUid.get(row.event_uid).push(row.event_date);
  }

  const cityOrder = cityImportRows.length ? cityImportRows.map((row) => row.city) : [...new Set(eventRows.map((row) => row.city))];
  const cityOrderMap = new Map(cityOrder.map((city, index) => [city, index]));
  const events = eventRows
    .map((row) => ({
      ...rowToEvent(row),
      eventDates: eventDatesByUid.get(row.event_uid) || [],
    }))
    .sort((a, b) => {
      const cityDiff = (cityOrderMap.get(a.city) ?? Number.MAX_SAFE_INTEGER) - (cityOrderMap.get(b.city) ?? Number.MAX_SAFE_INTEGER);
      if (cityDiff !== 0) return cityDiff;
      return Number(a.sourcePosition || Number.MAX_SAFE_INTEGER) - Number(b.sourcePosition || Number.MAX_SAFE_INTEGER);
    });

  const cities = [...new Set(cityOrder.filter(Boolean).concat(events.map((event) => event.city).filter(Boolean)))];
  const sourcePages = {};
  const cityMeta = {};
  for (const row of cityImportRows) {
    sourcePages[row.city] = row.sourcePage;
    cityMeta[row.city] = {
      generatedAt: row.generatedAt,
      sourcePage: row.sourcePage,
      eventCount: row.eventCount,
    };
  }

  const dateWindow = [...new Set(dateRows.map((row) => row.event_date))].sort();
  const note = getMetaValue(db, "note", DEFAULT_NOTE);
  const generatedAt = cityImportRows.reduce((latest, row) => {
    if (!latest) return row.generatedAt || null;
    return row.generatedAt && row.generatedAt > latest ? row.generatedAt : latest;
  }, null);

  return {
    generatedAt,
    city: cities.length <= 1 ? (cities[0] || null) : "多城市",
    cities,
    sourcePage: cities.length === 1 ? (sourcePages[cities[0]] || null) : null,
    sourcePages,
    dateWindow,
    note,
    cityMeta,
    events,
  };
}

module.exports = {
  DEFAULT_NOTE,
  applyDefaultImportPrepToActiveEvents,
  applyEventPoiSelection,
  syncEventPoiCoordinates,
  eventUidFor,
  clearEventBuzzNow,
  countApprovedActiveEvents,
  getApprovedEvents,
  getEventByUid,
  getEventsPayload,
  getExportImportNows,
  getReviewState,
  importPayload,
  importReviewState,
  listActiveEventsNeedingPoi,
  listEventsEligibleForImport,
  markEventImportResult,
  openDatabase,
  rejectEventForMissingPoi,
  clearReviewDecisions,
  patchReviewDecision,
  patchReviewDecisions,
  replaceReviewState,
  rowToEvent,
  syncEventMerchantByPoi,
  syncMerchantsForPoiEvents,
  updateEventMerchantInfo,
  upsertReviewDecision,
  updateEventImportPrep,
  updateEventPoiCandidatesOnly,
};

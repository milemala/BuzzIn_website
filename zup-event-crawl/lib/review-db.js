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
  suggestNowType,
  resolveExpiredAt,
  resolvePoiCoordinates,
  resolveStartAt,
} = require("./event-import-ready");
const { enrichEventBody } = require("./event-participation");
const { buildDateWindowFromEvents, resolveEventDates } = require("./event-dates");
const {
  buildPoiKeyword,
  extractLocationBuildingDetail,
  parseDoubanLocation,
} = require("./tencent-poi");
const {
  ensurePoiAddressCacheSchema,
  learnPoiFromApprovedEvent,
} = require("./poi-address-cache");
const {
  eventContentDedupKey,
  loadContentDedupKeys,
  loadTitleLocationDedupIndex,
  collapseEventsByTitleLocation,
  createTitleLocationDedupGate,
  isEventBetterByEnd,
} = require("./event-content-dedup");
const { getComposedImagePath } = require("./composed-image");
const {
  applyBuzzEnvToEvent,
  ensureBuzzImportSchema,
  markEventImportResult: storeMarkEventImportResult,
  updateEventImportPrepForEnv,
  updateEventMerchantInfoForEnv,
} = require("./buzz-import-store");
const { normalizeBuzzEnv } = require("./buzz-env");

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
  ["poi_match_source", "TEXT NOT NULL DEFAULT ''"],
  ["poi_agent_doubtful", "INTEGER NOT NULL DEFAULT 0"],
  ["poi_agent_reason", "TEXT NOT NULL DEFAULT ''"],
  ["poi_agent_search_keyword", "TEXT NOT NULL DEFAULT ''"],
  ["now_merchant_id", "TEXT NOT NULL DEFAULT ''"],
  ["now_merchant_name", "TEXT NOT NULL DEFAULT ''"],
  ["buzz_now_id", "TEXT NOT NULL DEFAULT ''"],
  ["buzz_group_id", "TEXT NOT NULL DEFAULT ''"],
  ["import_status", "TEXT NOT NULL DEFAULT ''"],
  ["import_error", "TEXT NOT NULL DEFAULT ''"],
  ["imported_at", "TEXT"],
  ["image_original", "TEXT NOT NULL DEFAULT ''"],
  ["douban_event_type", "TEXT NOT NULL DEFAULT ''"],
  ["classification_source", "TEXT NOT NULL DEFAULT 'pending'"],
  ["body_source", "TEXT NOT NULL DEFAULT 'pending'"],
  ["time_source", "TEXT NOT NULL DEFAULT 'pending'"],
  ["original_start_date", "TEXT"],
  ["original_end_date", "TEXT"],
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
  ensurePoiAddressCacheSchema(db);
  ensureBuzzImportSchema(db);
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
    originalStartDate: row.original_start_date || "",
    originalEndDate: row.original_end_date || "",
    original_start_date: row.original_start_date || "",
    original_end_date: row.original_end_date || "",
    timeText: row.time_text,
    location: row.location,
    latitude: row.latitude,
    longitude: row.longitude,
    poi_latitude: row.poi_latitude ?? null,
    poi_longitude: row.poi_longitude ?? null,
    image: row.image,
    imageOriginal: row.image_original || "",
    image_original: row.image_original || "",
    fee: row.fee,
    owner: row.owner,
    counts: row.counts,
    rawDetailText: row.raw_detail_text,
    rawDetailHtml: row.raw_detail_html,
    body: row.body,
    originalLink: row.original_link,
    score: row.score,
    suggested: Number(row.suggested) === 1,
    reviewReason: row.review_reason,
    douban_event_type: row.douban_event_type || "",
    classification_source: String(row.classification_source || "pending").trim() || "pending",
    body_source: String(row.body_source || "pending").trim() || "pending",
    time_source: String(row.time_source || "pending").trim() || "pending",
    publish_user_id: row.publish_user_id || DEFAULT_PUBLISH_USER_ID,
    now_type: normalizeNowType(row.now_type, row),
    location_poi_id: row.location_poi_id || "",
    poi_title: row.poi_title || "",
    poi_address: row.poi_address || "",
    poi_candidates: parsePoiCandidates(row.poi_candidates),
    poi_match_source: row.poi_match_source || "",
    poi_agent_doubtful: Boolean(row.poi_agent_doubtful),
    poi_agent_reason: row.poi_agent_reason || "",
    poi_agent_search_keyword: row.poi_agent_search_keyword || "",
    poi_updated_at: row.poi_updated_at || null,
    now_merchant_id: row.now_merchant_id || "",
    now_merchant_name: row.now_merchant_name || "",
    buzz_now_id: row.buzz_now_id || "",
    buzz_group_id: row.buzz_group_id || "",
    import_status: row.import_status || "",
    import_error: row.import_error || "",
    imported_at: row.imported_at || null,
    updated_at: row.updated_at || null,
    updatedAt: row.updated_at || null,
    start_at: resolveStartAt(row),
    expired_at: resolveExpiredAt(row),
    original_start_at: String(row.original_start_date || "").trim(),
    original_expired_at: String(row.original_end_date || "").trim(),
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

function agentKeywordDroppedBuildingDetail(agentKeyword, locationTerm) {
  if (!agentKeyword || !locationTerm) return false;
  if (!/[A-Za-z0-9一二三四五六七八九十]+[栋座楼幢]/i.test(locationTerm)) return false;
  if (/[A-Za-z0-9一二三四五六七八九十]+[栋座楼幢]/i.test(agentKeyword)) return false;
  const locationCore = locationTerm.replace(/\s+/g, "").replace(/[（(].*$/, "");
  const agentCore = agentKeyword.replace(/\s+/g, "").replace(/[（(].*$/, "");
  return locationCore.startsWith(agentCore) && locationCore.length > agentCore.length;
}

/** 活动 POI 存疑只认 Agent 写入的 poi_agent_doubtful，不再叠加 JS 地址校验 */
function resolveEventPoiDisplayFlags(event) {
  if (!event?.location_poi_id || event?.poi_match_source !== "agent") {
    return { doubtful: false, score: null, reasons: [] };
  }
  const reason = String(event.poi_agent_reason || "").trim();
  const doubtful = Boolean(event.poi_agent_doubtful);
  return {
    doubtful,
    score: null,
    reasons: doubtful && reason ? [reason] : [],
  };
}

function resolvePoiSuggestKeyword(event) {
  const city = event.city || "";
  const parsed = parseDoubanLocation(event.location, city);
  const locationTerm = String(parsed.venue || parsed.address || "").trim()
    .replace(/[（(].*$/, "").trim();
  let term = String(event.poi_agent_search_keyword || "").trim();
  const locationBuilding = extractLocationBuildingDetail(event.location, city);
  const agentHasBuilding = /[A-Za-z0-9一二三四五六七八九十]+[栋座楼幢]/i.test(term);
  if (locationBuilding && !agentHasBuilding && locationTerm) {
    term = locationTerm;
  } else if (term && agentKeywordDroppedBuildingDetail(term, locationTerm)) {
    term = locationTerm;
  }
  if (!term) term = locationTerm;
  if (term) return buildPoiKeyword(term, city);
  return "";
}

function ensurePoiCandidates(event) {
  const candidates = Array.isArray(event?.poi_candidates) ? event.poi_candidates : [];
  const poiId = String(event?.location_poi_id || "").trim();
  if (!poiId) return candidates;
  if (candidates.some((item) => String(item?.poi_id || "") === poiId)) return candidates;
  return [{
    poi_id: poiId,
    title: event.poi_title || "",
    address: event.poi_address || "",
    latitude: event.poi_latitude ?? null,
    longitude: event.poi_longitude ?? null,
  }, ...candidates];
}

function enrichEventPoiFlags(event) {
  if (!event) return event;
  const withCandidates = { ...event, poi_candidates: ensurePoiCandidates(event) };
  const poiCheck = resolveEventPoiDisplayFlags(withCandidates);
  return {
    ...withCandidates,
    body: isExpired(withCandidates) ? withCandidates.body : enrichEventBody(withCandidates),
    poi_doubtful: poiCheck.doubtful,
    poi_match_score: poiCheck.score,
    poi_doubt_reasons: poiCheck.reasons,
    poi_suggest_keyword: resolvePoiSuggestKeyword(withCandidates),
  };
}

function getEventByUid(db, eventUid) {
  const row = db.prepare("SELECT * FROM events WHERE event_uid = ?").get(eventUid);
  if (!row) return null;
  return enrichEventPoiFlags(rowToEvent(row));
}

function applyEventPoiSelection(db, eventUid, poi, options = {}) {
  const now = new Date().toISOString();
  const event = getEventByUid(db, eventUid);
  if (!event) {
    throw new Error(`活动不存在: ${eventUid}`);
  }

  const matchSource = String(options.matchSource || "").trim();
  const agentDoubtful = matchSource === "agent" ? (options.agentDoubtful ? 1 : 0) : 0;
  const agentReason = matchSource === "agent" ? String(options.agentReason || "").trim() : "";
  const agentSearchKeyword = matchSource === "agent"
    ? String(options.agentSearchKeyword || "").trim()
    : "";

  db.prepare(`
    UPDATE events SET
      location_poi_id = @location_poi_id,
      poi_title = @poi_title,
      poi_address = @poi_address,
      poi_latitude = @poi_latitude,
      poi_longitude = @poi_longitude,
      poi_candidates = @poi_candidates,
      poi_match_source = @poi_match_source,
      poi_agent_doubtful = @poi_agent_doubtful,
      poi_agent_reason = @poi_agent_reason,
      poi_agent_search_keyword = @poi_agent_search_keyword,
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
    poi_match_source: matchSource,
    poi_agent_doubtful: agentDoubtful,
    poi_agent_reason: agentReason,
    poi_agent_search_keyword: agentSearchKeyword,
    poi_updated_at: now,
    updated_at: now,
  });

  const updated = getEventByUid(db, eventUid);
  if (poi.poi_id) {
    learnPoiFromApprovedEvent(db, eventUid, updated);
  }
  return updated;
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

async function syncEventMerchantByPoi(db, eventUid, options = {}) {
  const buzzEnv = normalizeBuzzEnv(options.buzz_env || options.env);
  const event = getEventByUid(db, eventUid);
  if (!event) {
    throw new Error(`活动不存在: ${eventUid}`);
  }
  const poiId = String(event.location_poi_id || "").trim();
  if (!poiId) {
    updateEventMerchantInfoForEnv(db, eventUid, buzzEnv, { now_merchant_id: "", now_merchant_name: "" });
    return applyBuzzEnvToEvent(db, event, buzzEnv);
  }
  const { lookupMerchantByPoiId } = require("./buzz-merchant-poi");
  const { createBuzzClientOptions } = require("./buzz-env");
  const found = await lookupMerchantByPoiId(poiId, createBuzzClientOptions(buzzEnv));
  updateEventMerchantInfoForEnv(db, eventUid, buzzEnv, {
    now_merchant_id: found?.merchant_id || "",
    now_merchant_name: found?.merchant_name || "",
  });
  return applyBuzzEnvToEvent(db, getEventByUid(db, eventUid), buzzEnv);
}

async function syncMerchantsForPoiEvents(db, options = {}) {
  const buzzEnv = normalizeBuzzEnv(options.buzz_env || options.env);
  const rows = db.prepare(`
    SELECT event_uid, location_poi_id
    FROM events
    WHERE location_poi_id IS NOT NULL AND location_poi_id != ''
  `).all();
  let updated = 0;
  for (const row of rows) {
    if (options.only_missing) {
      const envEvent = applyBuzzEnvToEvent(db, rowToEvent(row), buzzEnv);
      if (envEvent.now_merchant_id) continue;
    }
    await syncEventMerchantByPoi(db, row.event_uid, { buzz_env: buzzEnv });
    updated += 1;
  }
  return { updated, buzz_env: buzzEnv };
}

function markEventImportResult(db, eventUid, result = {}, buzzEnv = "test") {
  storeMarkEventImportResult(db, eventUid, result, buzzEnv);
  return applyBuzzEnvToEvent(db, getEventByUid(db, eventUid), buzzEnv);
}

function clearEventBuzzNow(db, eventUid, buzzEnv = "test") {
  return markEventImportResult(db, eventUid, {
    buzz_now_id: "",
    buzz_group_id: "",
    import_status: "",
    import_error: "",
  }, buzzEnv);
}

function listEventsEligibleForImport(db, options = {}) {
  const buzzEnv = normalizeBuzzEnv(options.buzz_env || options.env);
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 500;
  const eventUids = Array.isArray(options.event_uids)
    ? [...new Set(options.event_uids.map((uid) => String(uid || "").trim()).filter(Boolean))]
    : [];

  const importClause = `
    LEFT JOIN buzz_imports bi
      ON bi.entity_kind = 'event'
     AND bi.entity_uid = e.event_uid
     AND bi.buzz_env = ?
  `;
  const pendingClause = `AND (bi.import_status IS NULL OR bi.import_status = '' OR bi.import_status = 'failed')`;

  if (eventUids.length) {
    const placeholders = eventUids.map(() => "?").join(", ");
    const rows = db.prepare(`
      SELECT e.*
      FROM events e
      INNER JOIN review_decisions r ON r.event_uid = e.event_uid
      ${importClause}
      WHERE e.event_uid IN (${placeholders})
        AND r.status = 'approved'
        ${pendingClause}
    `).all(buzzEnv, ...eventUids);
    const byUid = new Map(rows.map((row) => [row.event_uid, row]));
    return eventUids
      .map((uid) => byUid.get(uid))
      .filter(Boolean)
      .map((row) => applyBuzzEnvToEvent(db, rowToEvent(row), buzzEnv))
      .filter((event) => !isExpired(event))
      .filter((event) => isImportReady(event));
  }

  const rows = db.prepare(`
    SELECT e.*
    FROM events e
    INNER JOIN review_decisions r ON r.event_uid = e.event_uid
    ${importClause}
    WHERE r.status = 'approved'
      ${pendingClause}
    ORDER BY e.city, e.source_position, e.title
    LIMIT ?
  `).all(buzzEnv, limit);
  return rows
    .map((row) => applyBuzzEnvToEvent(db, rowToEvent(row), buzzEnv))
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

function updateEventImportPrep(db, eventUid, patch, options = {}) {
  const event = getEventByUid(db, eventUid);
  if (!event) {
    throw new Error(`活动不存在: ${eventUid}`);
  }
  const buzzEnv = normalizeBuzzEnv(options.buzz_env || patch.buzz_env);

  const now = new Date().toISOString();
  if (patch.now_type !== undefined) {
    db.prepare(`
      UPDATE events SET
        now_type = @now_type,
        updated_at = @updated_at
      WHERE event_uid = @event_uid
    `).run({
      event_uid: eventUid,
      now_type: normalizeNowType(patch.now_type, event),
      updated_at: now,
    });
  }

  if (patch.publish_user_id !== undefined) {
    updateEventImportPrepForEnv(db, eventUid, buzzEnv, {
      publish_user_id: patch.publish_user_id,
    });
  }

  if (patch.body !== undefined) {
    const { BODY_SOURCE_MANUAL, validateManualBody } = require("./event-body-agent");
    const check = validateManualBody(patch.body);
    if (!check.ok) {
      throw new Error(check.errors.join("；"));
    }
    db.prepare(`
      UPDATE events SET
        body = @body,
        body_source = @body_source,
        updated_at = @updated_at
      WHERE event_uid = @event_uid
    `).run({
      event_uid: eventUid,
      body: check.bodyText || null,
      body_source: BODY_SOURCE_MANUAL,
      updated_at: now,
    });
  }

  if (patch.start_at !== undefined || patch.expired_at !== undefined) {
    applyManualPushTime(db, eventUid, {
      start_at: patch.start_at,
      expired_at: patch.expired_at,
    });
  }

  return applyBuzzEnvToEvent(db, getEventByUid(db, eventUid), buzzEnv);
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
        now_type: suggestNowType(row),
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

function lastImportNewUidsMetaKey(city, source) {
  return `last_import_new_uids:${city}:${source || "all"}`;
}

function getLastImportNewUids(db, city, source) {
  const raw = getMetaValue(db, lastImportNewUidsMetaKey(city, source), "");
  if (!raw) return [];
  try {
    const payload = JSON.parse(raw);
    return Array.isArray(payload?.event_uids) ? payload.event_uids : [];
  } catch {
    return [];
  }
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
      latitude, longitude, image, image_original, fee, owner, counts, raw_detail_text, raw_detail_html, body, original_link,
      score, suggested, review_reason, douban_event_type, classification_source, body_source, time_source,
      original_start_date, original_end_date, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?
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
      category = CASE
        WHEN events.classification_source = 'agent' THEN events.category
        ELSE excluded.category
      END,
      start_date = CASE
        WHEN events.time_source IN ('agent', 'manual') THEN events.start_date
        WHEN excluded.start_date IS NOT NULL AND excluded.start_date != '' THEN excluded.start_date
        ELSE events.start_date
      END,
      end_date = CASE
        WHEN events.time_source IN ('agent', 'manual') THEN events.end_date
        WHEN excluded.end_date IS NOT NULL AND excluded.end_date != '' THEN excluded.end_date
        ELSE events.end_date
      END,
      time_text = excluded.time_text,
      location = excluded.location,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      image = excluded.image,
      image_original = CASE
        WHEN excluded.image_original != '' THEN excluded.image_original
        ELSE events.image_original
      END,
      fee = excluded.fee,
      owner = excluded.owner,
      counts = excluded.counts,
      raw_detail_text = excluded.raw_detail_text,
      raw_detail_html = excluded.raw_detail_html,
      body = CASE
        WHEN events.body_source IN ('agent', 'manual') THEN events.body
        ELSE excluded.body
      END,
      original_link = excluded.original_link,
      score = CASE
        WHEN events.classification_source = 'agent' THEN events.score
        ELSE excluded.score
      END,
      suggested = CASE
        WHEN events.classification_source = 'agent' THEN events.suggested
        ELSE excluded.suggested
      END,
      review_reason = CASE
        WHEN events.classification_source = 'agent' THEN events.review_reason
        ELSE excluded.review_reason
      END,
      douban_event_type = CASE
        WHEN excluded.douban_event_type != '' THEN excluded.douban_event_type
        ELSE events.douban_event_type
      END,
      classification_source = CASE
        WHEN events.classification_source = 'agent' THEN events.classification_source
        ELSE excluded.classification_source
      END,
      body_source = CASE
        WHEN events.body_source IN ('agent', 'manual') THEN events.body_source
        ELSE excluded.body_source
      END,
      time_source = CASE
        WHEN events.time_source IN ('agent', 'manual') THEN events.time_source
        ELSE excluded.time_source
      END,
      original_start_date = CASE
        WHEN trim(COALESCE(events.original_start_date, '')) != '' THEN events.original_start_date
        WHEN events.time_source IN ('agent', 'manual') THEN events.original_start_date
        WHEN excluded.start_date IS NOT NULL AND trim(excluded.start_date) != '' THEN excluded.start_date
        ELSE events.original_start_date
      END,
      original_end_date = CASE
        WHEN trim(COALESCE(events.original_end_date, '')) != '' THEN events.original_end_date
        WHEN events.time_source IN ('agent', 'manual') THEN events.original_end_date
        WHEN excluded.end_date IS NOT NULL AND trim(excluded.end_date) != '' THEN excluded.end_date
        ELSE events.original_end_date
      END,
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
    } else if (mode === "replace-city" || mode === "merge-city") {
      for (const city of groups.keys()) {
        deleteCity.run(city);
      }
    }

    const shouldDedupContent = mode === "append-city" || mode === "merge-city";
    const existingContentKeys = shouldDedupContent ? loadContentDedupKeys(db) : new Set();
    const titleLocationGate = shouldDedupContent
      ? createTitleLocationDedupGate(loadTitleLocationDedupIndex(db))
      : null;
    const batchContentKeys = new Set();
    const deleteEvent = db.prepare("DELETE FROM events WHERE event_uid = ?");
    const eventExistsStmt = db.prepare("SELECT 1 AS ok FROM events WHERE event_uid = ? LIMIT 1");
    const newImportUidsByCitySource = new Map();
    let skippedDuplicate = 0;
    let skippedTitleLocation = 0;
    let replacedTitleLocation = 0;
    const rootDir = options.rootDir || path.join(__dirname, "..");

    for (const [city, events] of groups.entries()) {
      const generatedAt = cityMeta[city]?.generatedAt || payload.generatedAt || new Date().toISOString();
      const sourcePage = cityMeta[city]?.sourcePage || sourcePages[city] || payload.sourcePage || null;
      let importedCount = 0;
      const cityEvents = shouldDedupContent
        ? collapseEventsByTitleLocation(events, city)
        : events;

      for (const event of cityEvents) {
        if (shouldDedupContent) {
          const dedupKey = eventContentDedupKey({ ...event, city: event.city || city });
          if (existingContentKeys.has(dedupKey) || batchContentKeys.has(dedupKey)) {
            skippedDuplicate += 1;
            continue;
          }

          const tlDecision = titleLocationGate.decide({ ...event, city: event.city || city }, city);
          if (tlDecision.action === "skip") {
            skippedTitleLocation += 1;
            continue;
          }
          if (tlDecision.deleteUid) {
            deleteEvent.run(tlDecision.deleteUid);
            const coverPath = getComposedImagePath(tlDecision.deleteUid, rootDir);
            if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
            replacedTitleLocation += 1;
          }

          batchContentKeys.add(dedupKey);
        }

        importedCount += 1;
        const eventUid = eventUidFor(event);
        const eventSource = event.source || "unknown";
        const isNewImport = !eventExistsStmt.get(eventUid);
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
          event.image_original || event.imageOriginal || "",
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
          event.douban_event_type || event.doubanEventType || "",
          event.classification_source || "pending",
          event.body_source || "pending",
          event.time_source || "pending",
          event.startDate || null,
          event.endDate || null,
          new Date().toISOString()
        );

        if (isNewImport) {
          const mapKey = `${city}\0${eventSource}`;
          if (!newImportUidsByCitySource.has(mapKey)) newImportUidsByCitySource.set(mapKey, []);
          newImportUidsByCitySource.get(mapKey).push(eventUid);
        }

        const nextEventDates = resolveEventDates(event);
        if (nextEventDates.length) {
          deleteEventDates.run(eventUid);
          for (const eventDate of nextEventDates) {
            insertEventDate.run(eventUid, eventDate);
          }
        }
      }

      upsertCityImport.run(
        city,
        generatedAt,
        sourcePage,
        importedCount,
        new Date().toISOString()
      );
    }

    if (skippedDuplicate > 0) {
      setMetaValue(db, "last_import_skipped_duplicate", String(skippedDuplicate));
    }
    if (skippedTitleLocation > 0) {
      setMetaValue(db, "last_import_skipped_title_location", String(skippedTitleLocation));
    }
    if (replacedTitleLocation > 0) {
      setMetaValue(db, "last_import_replaced_title_location", String(replacedTitleLocation));
    }

    const importedAt = new Date().toISOString();
    for (const [mapKey, eventUids] of newImportUidsByCitySource.entries()) {
      const [cityName, sourceName] = mapKey.split("\0");
      setMetaValue(db, lastImportNewUidsMetaKey(cityName, sourceName), JSON.stringify({
        event_uids: eventUids,
        imported_at: importedAt,
        source: sourceName,
        city: cityName,
      }));
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
  if (status === "approved") {
    learnPoiFromApprovedEvent(db, eventUid, event);
  }
  return status;
}

function clearEventPoi(db, eventUid) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE events SET
      location_poi_id = '',
      poi_title = '',
      poi_address = '',
      poi_latitude = NULL,
      poi_longitude = NULL,
      poi_candidates = '[]',
      poi_match_source = '',
      poi_agent_doubtful = 0,
      poi_agent_reason = '',
      poi_agent_search_keyword = '',
      poi_updated_at = NULL,
      now_merchant_id = '',
      now_merchant_name = '',
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({ event_uid: eventUid, updated_at: now });
}

/** 未匹配到 POI 时清空 POI 字段，审核状态保持不动（由人工在审核台处理） */
function rejectEventForMissingPoi(db, eventUid) {
  clearEventPoi(db, eventUid);
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

/** 列表接口字段（不含 raw_detail_html / raw_detail_text，见 getEventDetail） */
const EVENT_LIST_COLUMNS = `
  event_uid, source_id, source, source_name, source_position, source_url, source_list_page,
  city, district, title, category, start_date, end_date, time_text, location,
  latitude, longitude, poi_latitude, poi_longitude, image, image_original, fee, owner, counts,
  body, original_link, score, suggested, review_reason, douban_event_type,
  classification_source, body_source, publish_user_id, now_type, location_poi_id,
  poi_title, poi_address, poi_candidates, poi_match_source, poi_agent_doubtful,
  poi_agent_reason, poi_agent_search_keyword, poi_updated_at, now_merchant_id,
  now_merchant_name, buzz_now_id, buzz_group_id, import_status, import_error, imported_at,
  time_source, original_start_date, original_end_date,
  updated_at
`.replace(/\s+/g, " ").trim();

function getEventDetail(db, eventUid) {
  const row = db.prepare(`
    SELECT event_uid, raw_detail_text, raw_detail_html
    FROM events
    WHERE event_uid = ?
  `).get(eventUid);
  if (!row) return null;
  return {
    event_uid: row.event_uid,
    rawDetailText: row.raw_detail_text || "",
    rawDetailHtml: row.raw_detail_html || "",
  };
}

function getEventsPayload(db, options = {}) {
  const includeDetail = options.includeDetail === true;
  const buzzEnv = normalizeBuzzEnv(options.buzz_env);
  const cityImportRows = db.prepare(`
    SELECT city, generated_at AS generatedAt, source_page AS sourcePage, event_count AS eventCount
    FROM city_imports
    ORDER BY rowid
  `).all();
  const eventSql = includeDetail
    ? "SELECT * FROM events ORDER BY city, source_position, title"
    : `SELECT ${EVENT_LIST_COLUMNS} FROM events ORDER BY city, source_position, title`;
  const eventRows = db.prepare(eventSql).all();
  const dateRows = db.prepare("SELECT event_uid, event_date FROM event_dates ORDER BY event_date").all();

  const eventDatesByUid = new Map();
  for (const row of dateRows) {
    if (!eventDatesByUid.has(row.event_uid)) eventDatesByUid.set(row.event_uid, []);
    eventDatesByUid.get(row.event_uid).push(row.event_date);
  }

  const cityOrder = cityImportRows.length ? cityImportRows.map((row) => row.city) : [...new Set(eventRows.map((row) => row.city))];
  const cityOrderMap = new Map(cityOrder.map((city, index) => [city, index]));
  const reviewStatusByUid = new Map(
    db.prepare("SELECT event_uid, status FROM review_decisions").all()
      .map((row) => [row.event_uid, row.status]),
  );
  const events = eventRows
    .map((row) => {
      const base = applyBuzzEnvToEvent(db, rowToEvent(row), buzzEnv);
      return enrichEventPoiFlags({
        ...base,
        review_status: reviewStatusByUid.get(row.event_uid) || "pending",
        eventDates: resolveEventDates({
          ...base,
          eventDates: eventDatesByUid.get(row.event_uid) || [],
        }),
      });
    })
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

  const dateWindow = buildDateWindowFromEvents(events);
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
    buzz_env: buzzEnv,
    events,
  };
}

function applyEventBody(db, eventUid, decision) {
  const {
    BODY_SOURCE_AGENT,
    validateBodyDecision,
  } = require("./event-body-agent");
  const check = validateBodyDecision({ ...decision, event_uid: eventUid });
  if (!check.ok) {
    throw new Error(check.errors.join("；"));
  }
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE events SET
      body = @body,
      body_source = @body_source,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({
    event_uid: eventUid,
    body: check.bodyText,
    body_source: BODY_SOURCE_AGENT,
    updated_at: now,
  });
  if (!result.changes) {
    throw new Error(`活动不存在: ${eventUid}`);
  }
  return getEventByUid(db, eventUid);
}

function getReviewStatus(db, eventUid) {
  const row = db.prepare("SELECT status FROM review_decisions WHERE event_uid = ?").get(eventUid);
  return String(row?.status || "pending").trim() || "pending";
}

function shouldSkipEventTimeApply(db, eventUid, options = {}) {
  if (options.force) return null;
  const row = db.prepare("SELECT time_source FROM events WHERE event_uid = ?").get(eventUid);
  if (!row) return null;
  const timeSource = String(row.time_source || "pending").trim() || "pending";
  const { TIME_SOURCE_AGENT, TIME_SOURCE_MANUAL } = require("./event-time-agent");
  if (timeSource === TIME_SOURCE_MANUAL) {
    return "manual";
  }
  if (options.protectApproved !== false) {
    const status = getReviewStatus(db, eventUid);
    if (status === "approved" && timeSource === TIME_SOURCE_AGENT) {
      return "approved_agent";
    }
  }
  return null;
}

function hasOriginalArchive(db, eventUid) {
  const row = db.prepare(`
    SELECT original_start_date, original_end_date FROM events WHERE event_uid = ?
  `).get(eventUid);
  if (!row) return false;
  return Boolean(String(row.original_start_date || "").trim() && String(row.original_end_date || "").trim());
}

function seedOriginalTimeIfEmpty(db, eventUid, startAt, expiredAt) {
  const row = db.prepare(`
    SELECT original_start_date, original_end_date FROM events WHERE event_uid = ?
  `).get(eventUid);
  if (!row) return;
  const origStart = String(row.original_start_date || "").trim();
  const origEnd = String(row.original_end_date || "").trim();
  if (origStart && origEnd) return;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE events SET
      original_start_date = CASE
        WHEN original_start_date IS NULL OR trim(original_start_date) = '' THEN @original_start_date
        ELSE original_start_date
      END,
      original_end_date = CASE
        WHEN original_end_date IS NULL OR trim(original_end_date) = '' THEN @original_end_date
        ELSE original_end_date
      END,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({
    event_uid: eventUid,
    original_start_date: startAt,
    original_end_date: expiredAt,
    updated_at: now,
  });
}

function setOriginalEventTime(db, eventUid, startAt, expiredAt) {
  const start = String(startAt || "").trim();
  const end = String(expiredAt || "").trim();
  if (!start || !end) {
    throw new Error("原始开始/结束时间均不能为空");
  }
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE events SET
      original_start_date = @original_start_date,
      original_end_date = @original_end_date,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({
    event_uid: eventUid,
    original_start_date: start,
    original_end_date: end,
    updated_at: now,
  });
  if (!result.changes) {
    throw new Error(`活动不存在: ${eventUid}`);
  }
  return getEventByUid(db, eventUid);
}

function applyManualPushTime(db, eventUid, decision, options = {}) {
  const { TIME_SOURCE_MANUAL, validateTimeDecision } = require("./event-time-agent");
  const event = getEventByUid(db, eventUid);
  if (!event) {
    throw new Error(`活动不存在: ${eventUid}`);
  }
  const startAt = String(decision.start_at ?? resolveStartAt(event) ?? "").trim();
  const expiredAt = String(decision.expired_at ?? resolveExpiredAt(event) ?? "").trim();
  const check = validateTimeDecision({ event_uid: eventUid, start_at: startAt, expired_at: expiredAt });
  if (!check.ok) {
    throw new Error(check.errors.join("；"));
  }
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE events SET
      start_date = @start_date,
      end_date = @end_date,
      time_source = @time_source,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({
    event_uid: eventUid,
    start_date: startAt,
    end_date: expiredAt,
    time_source: TIME_SOURCE_MANUAL,
    updated_at: now,
  });
  if (!result.changes) {
    throw new Error(`活动不存在: ${eventUid}`);
  }
  const { syncEventDates } = require("./event-time-agent");
  syncEventDates(db, eventUid, startAt, expiredAt);
  return { event: getEventByUid(db, eventUid) };
}

function applyEventTime(db, eventUid, decision, options = {}) {
  const {
    TIME_SOURCE_AGENT,
    TIME_SOURCE_MANUAL,
    syncEventDates,
    validateTimeDecision,
  } = require("./event-time-agent");
  const skipReason = shouldSkipEventTimeApply(db, eventUid, options);
  if (skipReason) {
    return { skipped: true, reason: skipReason, event: getEventByUid(db, eventUid) };
  }
  const check = validateTimeDecision({ ...decision, event_uid: eventUid });
  if (!check.ok) {
    throw new Error(check.errors.join("；"));
  }
  const timeSource = options.timeSource || TIME_SOURCE_AGENT;
  const now = new Date().toISOString();
  const writeOriginal = timeSource !== TIME_SOURCE_MANUAL && !hasOriginalArchive(db, eventUid);
  const result = db.prepare(writeOriginal ? `
    UPDATE events SET
      start_date = @start_date,
      end_date = @end_date,
      original_start_date = @start_date,
      original_end_date = @end_date,
      time_source = @time_source,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  ` : `
    UPDATE events SET
      start_date = @start_date,
      end_date = @end_date,
      time_source = @time_source,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({
    event_uid: eventUid,
    start_date: decision.start_at,
    end_date: decision.expired_at,
    time_source: timeSource === TIME_SOURCE_MANUAL ? TIME_SOURCE_MANUAL : timeSource,
    updated_at: now,
  });
  if (!result.changes) {
    throw new Error(`活动不存在: ${eventUid}`);
  }
  syncEventDates(db, eventUid, decision.start_at, decision.expired_at);
  return { skipped: false, event: getEventByUid(db, eventUid) };
}

function applyEventClassification(db, eventUid, decision) {
  const {
    CLASSIFICATION_SOURCE_AGENT,
    normalizeCategory,
    scoreFromSuggestion,
    validateClassificationDecision,
  } = require("./event-classification");
  const check = validateClassificationDecision({ ...decision, event_uid: eventUid });
  if (!check.ok) {
    throw new Error(check.errors.join("；"));
  }
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE events SET
      suggested = @suggested,
      category = @category,
      review_reason = @review_reason,
      score = @score,
      classification_source = @classification_source,
      updated_at = @updated_at
    WHERE event_uid = @event_uid
  `).run({
    event_uid: eventUid,
    suggested: decision.suggested ? 1 : 0,
    category: check.category,
    review_reason: check.reason,
    score: scoreFromSuggestion(decision.suggested),
    classification_source: CLASSIFICATION_SOURCE_AGENT,
    updated_at: now,
  });
  if (!result.changes) {
    throw new Error(`活动不存在: ${eventUid}`);
  }
  return getEventByUid(db, eventUid);
}

module.exports = {
  DEFAULT_NOTE,
  applyDefaultImportPrepToActiveEvents,
  applyEventBody,
  applyEventClassification,
  applyEventTime,
  applyManualPushTime,
  setOriginalEventTime,
  seedOriginalTimeIfEmpty,
  applyEventPoiSelection,
  syncEventPoiCoordinates,
  eventUidFor,
  clearEventBuzzNow,
  countApprovedActiveEvents,
  getApprovedEvents,
  getEventByUid,
  getEventDetail,
  getEventsPayload,
  getReviewStatus,
  getLastImportNewUids,
  lastImportNewUidsMetaKey,
  EVENT_LIST_COLUMNS,
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

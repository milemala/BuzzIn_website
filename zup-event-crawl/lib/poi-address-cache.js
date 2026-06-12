"use strict";

const crypto = require("crypto");
const { isStreetLevelAddress } = require("./tencent-poi");

function normalizeCity(city) {
  return String(city || "")
    .trim()
    .replace(/\u00a0/g, " ")
    .replace(/市$/u, "");
}

function normalizeAddressText(text) {
  return String(text || "")
    .trim()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 门牌级地址才可进映射库（区划/商圈名如「静安区」「上城区」不行） */
function isCacheableAddress(addressText) {
  return isStreetLevelAddress(normalizeAddressText(addressText));
}

function buildAddressCacheKey(city, addressText) {
  const cityNorm = normalizeCity(city);
  const addressNorm = normalizeAddressText(addressText);
  if (!addressNorm || !isStreetLevelAddress(addressNorm)) return "";
  return crypto
    .createHash("sha1")
    .update(`${cityNorm}|${addressNorm}`)
    .digest("hex");
}

function ensurePoiAddressCacheSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS poi_address_cache (
      cache_key TEXT PRIMARY KEY,
      city TEXT NOT NULL,
      address_text TEXT NOT NULL,
      poi_id TEXT NOT NULL,
      poi_title TEXT NOT NULL,
      poi_address TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      source_kind TEXT NOT NULL DEFAULT '',
      source_uid TEXT NOT NULL DEFAULT '',
      hit_count INTEGER NOT NULL DEFAULT 0,
      learned_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_poi_address_cache_city ON poi_address_cache(city);
  `);
}

function rowToCacheEntry(row) {
  if (!row) return null;
  return {
    cache_key: row.cache_key,
    city: row.city,
    address_text: row.address_text,
    poi_id: row.poi_id,
    poi_title: row.poi_title,
    poi_address: row.poi_address,
    latitude: row.latitude ?? null,
    longitude: row.longitude ?? null,
    source_kind: row.source_kind || "",
    source_uid: row.source_uid || "",
    hit_count: Number(row.hit_count) || 0,
    learned_at: row.learned_at,
    updated_at: row.updated_at,
  };
}

function lookupPoiAddressCache(db, { city, addressText }) {
  ensurePoiAddressCacheSchema(db);
  const cacheKey = buildAddressCacheKey(city, addressText);
  if (!cacheKey) return null;
  const row = db.prepare("SELECT * FROM poi_address_cache WHERE cache_key = ?").get(cacheKey);
  return rowToCacheEntry(row);
}

function upsertPoiAddressCache(db, {
  city,
  addressText,
  poi,
  sourceKind = "",
  sourceUid = "",
}) {
  ensurePoiAddressCacheSchema(db);
  const cacheKey = buildAddressCacheKey(city, addressText);
  const poiId = String(poi?.poi_id || "").trim();
  const poiTitle = String(poi?.poi_title || poi?.title || "").trim();
  if (!cacheKey || !poiId || !poiTitle) return null;

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO poi_address_cache (
      cache_key, city, address_text, poi_id, poi_title, poi_address,
      latitude, longitude, source_kind, source_uid, hit_count, learned_at, updated_at
    ) VALUES (
      @cache_key, @city, @address_text, @poi_id, @poi_title, @poi_address,
      @latitude, @longitude, @source_kind, @source_uid, 0, @learned_at, @updated_at
    )
    ON CONFLICT(cache_key) DO UPDATE SET
      poi_id = excluded.poi_id,
      poi_title = excluded.poi_title,
      poi_address = excluded.poi_address,
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      source_kind = excluded.source_kind,
      source_uid = excluded.source_uid,
      updated_at = excluded.updated_at
  `).run({
    cache_key: cacheKey,
    city: normalizeCity(city) || String(city || "").trim(),
    address_text: normalizeAddressText(addressText),
    poi_id: poiId,
    poi_title: poiTitle,
    poi_address: String(poi.poi_address || "").trim(),
    latitude: poi.latitude ?? null,
    longitude: poi.longitude ?? null,
    source_kind: String(sourceKind || "").trim(),
    source_uid: String(sourceUid || "").trim(),
    learned_at: now,
    updated_at: now,
  });

  return lookupPoiAddressCache(db, { city, addressText });
}

function recordPoiAddressCacheHit(db, cacheKey) {
  if (!cacheKey) return;
  ensurePoiAddressCacheSchema(db);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE poi_address_cache
    SET hit_count = hit_count + 1, updated_at = @updated_at
    WHERE cache_key = @cache_key
  `).run({ cache_key: cacheKey, updated_at: now });
}

function getEventReviewStatus(db, eventUid) {
  const row = db.prepare("SELECT status FROM review_decisions WHERE event_uid = ?").get(eventUid);
  return row?.status || "pending";
}

function eventAddressText(event) {
  return normalizeAddressText(event?.location || "");
}

function poiFromEventRow(event) {
  const poiId = String(event?.location_poi_id || "").trim();
  if (!poiId) return null;
  return {
    poi_id: poiId,
    title: String(event.poi_title || "").trim(),
    address: String(event.poi_address || "").trim(),
    latitude: event.poi_latitude ?? null,
    longitude: event.poi_longitude ?? null,
  };
}

function learnPoiFromApprovedEvent(db, eventUid, eventRow = null) {
  const event = eventRow || db.prepare("SELECT * FROM events WHERE event_uid = ?").get(eventUid);
  if (!event) return null;
  if (getEventReviewStatus(db, eventUid) !== "approved") return null;

  const poi = poiFromEventRow(event);
  const addressText = eventAddressText(event);
  if (!poi || !addressText || !isCacheableAddress(addressText)) return null;

  return upsertPoiAddressCache(db, {
    city: event.city,
    addressText,
    poi,
    sourceKind: "event",
    sourceUid: eventUid,
  });
}

function clearPoiAddressCache(db) {
  ensurePoiAddressCacheSchema(db);
  const { changes } = db.prepare("DELETE FROM poi_address_cache").run();
  return changes;
}

function backfillPoiAddressCacheFromApproved(db, { clear = true } = {}) {
  ensurePoiAddressCacheSchema(db);
  const cleared = clear ? clearPoiAddressCache(db) : 0;
  let events = 0;

  const eventRows = db.prepare(`
    SELECT e.*
    FROM events e
    INNER JOIN review_decisions r ON r.event_uid = e.event_uid
    WHERE r.status = 'approved'
      AND e.location_poi_id IS NOT NULL AND trim(e.location_poi_id) != ''
  `).all();
  for (const row of eventRows) {
    if (learnPoiFromApprovedEvent(db, row.event_uid, row)) events += 1;
  }

  return { cleared, events, total: events };
}

function cacheEntryToPoi(entry) {
  if (!entry) return null;
  return {
    poi_id: entry.poi_id,
    title: entry.poi_title,
    address: entry.poi_address,
    latitude: entry.latitude,
    longitude: entry.longitude,
  };
}

function cacheEntryToDecisionFields(entry) {
  const poi = cacheEntryToPoi(entry);
  if (!poi) return null;
  return {
    poi_id: poi.poi_id,
    poi_title: poi.title,
    poi_address: poi.address,
    latitude: poi.latitude,
    longitude: poi.longitude,
    action: "match",
    confidence: "high",
    doubtful: false,
    reason: `地址映射库命中：${entry.address_text} → ${poi.title}（来源 ${entry.source_kind}:${entry.source_uid}）`,
    search_keywords_tried: ["poi-address-cache"],
    from_cache: true,
    cache_key: entry.cache_key,
  };
}

module.exports = {
  backfillPoiAddressCacheFromApproved,
  buildAddressCacheKey,
  cacheEntryToDecisionFields,
  cacheEntryToPoi,
  clearPoiAddressCache,
  ensurePoiAddressCacheSchema,
  eventAddressText,
  isCacheableAddress,
  learnPoiFromApprovedEvent,
  lookupPoiAddressCache,
  normalizeAddressText,
  normalizeCity,
  recordPoiAddressCacheHit,
  upsertPoiAddressCache,
};

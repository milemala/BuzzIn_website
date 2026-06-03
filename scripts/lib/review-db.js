"use strict";

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_NOTE = "本文件用于本地人工审核。保留原始抓取详情文本，body 为基于原文提炼的 Zup 活动简介。图片发布前需再次确认来源授权与平台规则。";
const VALID_REVIEW_STATUSES = new Set(["approved", "pending", "rejected"]);

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

function getApprovedEvents(db) {
  return db.prepare(`
    SELECT
      e.title,
      e.city,
      e.district,
      e.start_date AS startDate,
      e.end_date AS endDate,
      e.time_text AS timeText,
      e.location,
      e.latitude,
      e.longitude,
      e.image,
      e.body,
      e.original_link AS originalLink,
      e.source,
      e.category
    FROM events e
    INNER JOIN review_decisions r ON r.event_uid = e.event_uid
    WHERE r.status = 'approved'
    ORDER BY e.city, e.source_position, e.title
  `).all();
}

function getEventsPayload(db) {
  const cityImportRows = db.prepare(`
    SELECT city, generated_at AS generatedAt, source_page AS sourcePage, event_count AS eventCount
    FROM city_imports
    ORDER BY rowid
  `).all();
  const eventRows = db.prepare(`
    SELECT
      event_uid AS eventUid,
      source_id AS id,
      source,
      source_name AS sourceName,
      source_position AS sourcePosition,
      source_url AS sourceUrl,
      source_list_page AS sourceListPage,
      city,
      district,
      title,
      category,
      start_date AS startDate,
      end_date AS endDate,
      time_text AS timeText,
      location,
      latitude,
      longitude,
      image,
      fee,
      owner,
      counts,
      raw_detail_text AS rawDetailText,
      raw_detail_html AS rawDetailHtml,
      body,
      original_link AS originalLink,
      score,
      suggested,
      review_reason AS reviewReason
    FROM events
    ORDER BY city, source_position, title
  `).all();
  const dateRows = db.prepare("SELECT event_uid AS eventUid, event_date AS eventDate FROM event_dates ORDER BY event_date").all();

  const eventDatesByUid = new Map();
  for (const row of dateRows) {
    if (!eventDatesByUid.has(row.eventUid)) eventDatesByUid.set(row.eventUid, []);
    eventDatesByUid.get(row.eventUid).push(row.eventDate);
  }

  const cityOrder = cityImportRows.length ? cityImportRows.map((row) => row.city) : [...new Set(eventRows.map((row) => row.city))];
  const cityOrderMap = new Map(cityOrder.map((city, index) => [city, index]));
  const events = eventRows
    .map((row) => ({
      ...row,
      suggested: Boolean(row.suggested),
      eventDates: eventDatesByUid.get(row.eventUid) || [],
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

  const dateWindow = [...new Set(dateRows.map((row) => row.eventDate))].sort();
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
  eventUidFor,
  getApprovedEvents,
  getEventsPayload,
  getReviewState,
  importPayload,
  importReviewState,
  openDatabase,
  replaceReviewState,
};

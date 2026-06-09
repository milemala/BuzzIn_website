"use strict";

const fs = require("fs");
const path = require("path");
const { parseCityMerchantList } = require("./city-merchant-list");
const { openDatabase } = require("./review-db");
const {
  buildImportRecord,
  isImportReady,
  suggestMerchantType,
} = require("./merchant-import-ready");
const {
  assessMerchantPoiConfidence,
  normalizePoiMatchMode,
  POI_MATCH_MODE_NORMAL,
  POI_MATCH_MODE_STRICT,
  suggestMerchantPoiKeyword,
} = require("./tencent-poi");
const { normalizeMerchantImageUrl } = require("./merchant-image-url");

const MERCHANT_POI_MATCH_MODE_KEY = "merchant_poi_match_mode";

const VALID_REVIEW_STATUSES = new Set(["approved", "pending", "rejected"]);

const IMPORT_PREP_COLUMNS = [
  ["merchant_type", "INTEGER"],
  ["buzz_merchant_id", "TEXT NOT NULL DEFAULT ''"],
  ["import_status", "TEXT NOT NULL DEFAULT ''"],
  ["import_error", "TEXT NOT NULL DEFAULT ''"],
  ["imported_at", "TEXT"],
  ["address_poi_id", "TEXT NOT NULL DEFAULT ''"],
  ["poi_title", "TEXT NOT NULL DEFAULT ''"],
  ["poi_address", "TEXT NOT NULL DEFAULT ''"],
  ["source_address", "TEXT NOT NULL DEFAULT ''"],
  ["poi_candidates", "TEXT NOT NULL DEFAULT '[]'"],
  ["poi_updated_at", "TEXT"],
  ["buzz_group_id", "TEXT NOT NULL DEFAULT ''"],
  ["bubble_now_id", "TEXT NOT NULL DEFAULT ''"],
  ["bubble_published_at", "TEXT"],
  ["image_original", "TEXT NOT NULL DEFAULT ''"],
];

function migrateMerchantImportColumns(db) {
  const existing = new Set(
    db.prepare("PRAGMA table_info(merchants)").all().map((row) => row.name),
  );
  for (const [name, ddl] of IMPORT_PREP_COLUMNS) {
    if (!existing.has(name)) {
      db.exec(`ALTER TABLE merchants ADD COLUMN ${name} ${ddl}`);
    }
  }
  backfillMerchantSourceAddresses(db);
}

function backfillMerchantSourceAddresses(db) {
  db.exec(`
    UPDATE merchants
    SET source_address = address
    WHERE source_address = ''
      AND address != ''
      AND (poi_address = '' OR address != poi_address)
  `);

  const pendingCount = db.prepare(`
    SELECT COUNT(*) AS count
    FROM merchants
    WHERE source_address = ''
      AND search_keyword != ''
  `).get().count;
  if (!pendingCount) return;

  const listDir = path.join(__dirname, "..", "data", "城市商户清单", "酒鬼地图统计");
  if (!fs.existsSync(listDir)) return;

  const addressByListName = new Map();
  for (const file of fs.readdirSync(listDir)) {
    if (!file.endsWith(".md")) continue;
    const { entries } = parseCityMerchantList(path.join(listDir, file));
    for (const entry of entries) {
      if (entry.listAddress) addressByListName.set(entry.listName, entry.listAddress);
    }
  }
  if (!addressByListName.size) return;

  const update = db.prepare(`
    UPDATE merchants
    SET source_address = @source_address
    WHERE merchant_uid = @merchant_uid
      AND source_address = ''
  `);
  const pending = db.prepare(`
    SELECT merchant_uid, search_keyword
    FROM merchants
    WHERE source_address = ''
      AND search_keyword != ''
  `).all();
  for (const row of pending) {
    const sourceAddress = addressByListName.get(row.search_keyword);
    if (sourceAddress) {
      update.run({ merchant_uid: row.merchant_uid, source_address: sourceAddress });
    }
  }
}

function parsePoiCandidates(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function ensureMerchantSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchants (
      merchant_uid TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'dianping',
      city TEXT,
      search_keyword TEXT,
      source_position INTEGER,
      name TEXT NOT NULL,
      address TEXT,
      district TEXT,
      category TEXT,
      image TEXT,
      original_link TEXT,
      list_region_text TEXT,
      phone TEXT,
      latitude REAL,
      longitude REAL,
      review_count INTEGER,
      avg_price TEXT,
      business_status TEXT NOT NULL DEFAULT 'open',
      needs_detail INTEGER NOT NULL DEFAULT 1,
      import_batch_id TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_merchants_city ON merchants(city);
    CREATE INDEX IF NOT EXISTS idx_merchants_keyword ON merchants(search_keyword);
    CREATE INDEX IF NOT EXISTS idx_merchants_needs_detail ON merchants(needs_detail);

    CREATE TABLE IF NOT EXISTS merchant_review_decisions (
      merchant_uid TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('approved', 'pending', 'rejected')),
      updated_at TEXT NOT NULL,
      FOREIGN KEY (merchant_uid) REFERENCES merchants(merchant_uid) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS merchant_imports (
      import_key TEXT PRIMARY KEY,
      city TEXT,
      search_keyword TEXT,
      source_page TEXT,
      merchant_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  migrateMerchantImportColumns(db);
}

function rowToMerchant(row) {
  return {
    merchant_uid: row.merchant_uid,
    source_id: row.source_id,
    source: row.source,
    city: row.city,
    search_keyword: row.search_keyword,
    source_position: row.source_position,
    name: row.name,
    address: row.address || "",
    source_address: row.source_address || "",
    district: row.district || "",
    category: row.category || "",
    image: normalizeMerchantImageUrl(row.image || ""),
    image_original: row.image_original || "",
    original_link: row.original_link || "",
    originalLink: row.original_link || "",
    list_region_text: row.list_region_text || "",
    phone: row.phone || "",
    latitude: row.latitude,
    longitude: row.longitude,
    review_count: row.review_count,
    avg_price: row.avg_price || "",
    business_status: row.business_status,
    needs_detail: Boolean(row.needs_detail),
    import_batch_id: row.import_batch_id || "",
    updated_at: row.updated_at,
    merchant_type: row.merchant_type ?? null,
    buzz_merchant_id: row.buzz_merchant_id || "",
    import_status: row.import_status || "",
    import_error: row.import_error || "",
    imported_at: row.imported_at || null,
    address_poi_id: row.address_poi_id || "",
    poi_title: row.poi_title || "",
    poi_address: row.poi_address || "",
    poi_candidates: parsePoiCandidates(row.poi_candidates),
    poi_updated_at: row.poi_updated_at || null,
    buzz_group_id: row.buzz_group_id || "",
    bubble_now_id: row.bubble_now_id || "",
    bubble_published_at: row.bubble_published_at || null,
    import_ready: isImportReady(row),
  };
}

function findBuzzMerchantIdByPoi(db, poiId) {
  ensureMerchantSchema(db);
  const id = String(poiId || "").trim();
  if (!id) return "";
  const row = db.prepare(`
    SELECT m.buzz_merchant_id
    FROM merchants m
    INNER JOIN merchant_review_decisions d ON d.merchant_uid = m.merchant_uid
    WHERE d.status = 'approved'
      AND m.address_poi_id = ?
      AND m.buzz_merchant_id IS NOT NULL
      AND m.buzz_merchant_id != ''
    LIMIT 1
  `).get(id);
  return row?.buzz_merchant_id || "";
}

function updateMerchantBuzzId(db, merchantUid, buzzMerchantId) {
  return markMerchantImportResult(db, merchantUid, {
    buzz_merchant_id: String(buzzMerchantId || "").trim(),
    import_status: buzzMerchantId ? "imported" : "",
    import_error: "",
  });
}

function markMerchantImportResult(db, merchantUid, result = {}) {
  ensureMerchantSchema(db);
  const current = getMerchantByUid(db, merchantUid);
  if (!current) {
    throw new Error(`商户不存在: ${merchantUid}`);
  }
  const now = new Date().toISOString();
  const imported = result.import_status === "imported";
  const pick = (key, fallback = "") => (
    Object.prototype.hasOwnProperty.call(result, key)
      ? String(result[key] || "").trim()
      : String(current?.[key] || fallback).trim()
  );
  db.prepare(`
    UPDATE merchants SET
      buzz_merchant_id = @buzz_merchant_id,
      import_status = @import_status,
      import_error = @import_error,
      imported_at = @imported_at,
      updated_at = @updated_at
    WHERE merchant_uid = @merchant_uid
  `).run({
    merchant_uid: merchantUid,
    buzz_merchant_id: pick("buzz_merchant_id"),
    import_status: pick("import_status"),
    import_error: pick("import_error"),
    imported_at: imported
      ? now
      : (Object.prototype.hasOwnProperty.call(result, "imported_at")
        ? result.imported_at
        : (current?.imported_at || null)),
    updated_at: now,
  });
  return getMerchantByUid(db, merchantUid);
}

function clearMerchantBuzzId(db, merchantUid) {
  return markMerchantImportResult(db, merchantUid, {
    buzz_merchant_id: "",
    import_status: "",
    import_error: "",
    imported_at: null,
  });
}

function getMerchantImportProgress(db, options = {}) {
  ensureMerchantSchema(db);
  let where = "d.status = 'approved'";
  const params = [];
  if (options.city) {
    where += " AND m.city = ?";
    params.push(options.city);
  }
  const base = `
    FROM merchants m
    INNER JOIN merchant_review_decisions d ON d.merchant_uid = m.merchant_uid
    WHERE ${where}
  `;
  const imported = db.prepare(`SELECT COUNT(*) AS c ${base} AND m.import_status = 'imported' AND m.buzz_merchant_id != ''`).get(...params).c;
  const failed = db.prepare(`SELECT COUNT(*) AS c ${base} AND m.import_status = 'failed'`).get(...params).c;
  const latestImported = db.prepare(`
    SELECT m.name, m.city, m.buzz_merchant_id, m.imported_at
    ${base} AND m.import_status = 'imported' AND m.imported_at IS NOT NULL
    ORDER BY m.imported_at DESC LIMIT 1
  `).get(...params);
  const latestFailed = db.prepare(`
    SELECT m.name, m.city, m.import_error, m.updated_at
    ${base} AND m.import_status = 'failed'
    ORDER BY m.updated_at DESC LIMIT 1
  `).get(...params);
  const pendingImport = listMerchantsEligibleForImport(db, {
    city: options.city || "",
    limit: 200,
  }).length;

  return {
    city: options.city || "",
    imported,
    failed,
    pending_import: pendingImport,
    latest_imported: latestImported || null,
    latest_failed: latestFailed || null,
  };
}

function listMerchantsEligibleForImport(db, options = {}) {
  ensureMerchantSchema(db);
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 500;
  let sql = `
    SELECT m.*
    FROM merchants m
    INNER JOIN merchant_review_decisions d ON d.merchant_uid = m.merchant_uid
    WHERE d.status = 'approved'
      AND (m.import_status IS NULL OR m.import_status = '' OR m.import_status = 'failed')
  `;
  const params = [];
  if (options.city) {
    sql += " AND m.city = ?";
    params.push(options.city);
  }
  sql += " ORDER BY m.city, m.search_keyword, m.source_position LIMIT ?";
  params.push(limit);
  const rows = db.prepare(sql).all(...params);
  return rows.map((row) => rowToMerchant(row)).filter((merchant) => isImportReady(merchant));
}

function getMerchantPoiMatchMode(db) {
  ensureMerchantSchema(db);
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(MERCHANT_POI_MATCH_MODE_KEY);
  return normalizePoiMatchMode(row?.value || POI_MATCH_MODE_NORMAL);
}

function setMerchantPoiMatchMode(db, mode) {
  ensureMerchantSchema(db);
  const normalized = normalizePoiMatchMode(mode);
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(MERCHANT_POI_MATCH_MODE_KEY, normalized);
  return normalized;
}

function enrichMerchantPoiFlags(merchant, options = {}) {
  if (!merchant) return merchant;
  const poiMatchMode = normalizePoiMatchMode(options.poiMatchMode || POI_MATCH_MODE_NORMAL);
  const poiCheck = assessMerchantPoiConfidence(merchant, { poiMatchMode });
  return {
    ...merchant,
    poi_doubtful: poiCheck.doubtful,
    poi_match_score: poiCheck.score,
    poi_doubt_reasons: poiCheck.reasons,
    suggested_poi_keyword: suggestMerchantPoiKeyword(merchant.name, merchant.city),
  };
}

function getMerchantByUid(db, merchantUid) {
  ensureMerchantSchema(db);
  const row = db.prepare("SELECT * FROM merchants WHERE merchant_uid = ?").get(merchantUid);
  return row ? rowToMerchant(row) : null;
}

function applyPoiSelection(db, merchantUid, poi, options = {}) {
  ensureMerchantSchema(db);
  const now = new Date().toISOString();
  const merchant = getMerchantByUid(db, merchantUid);
  if (!merchant) {
    throw new Error(`商户不存在: ${merchantUid}`);
  }

  const merchantType = options.merchant_type
    ?? merchant.merchant_type
    ?? suggestMerchantType(merchant.category, merchant.name);

  const sourceAddress = merchant.source_address
    || (merchant.address && merchant.address !== String(poi.address || "").trim()
      ? merchant.address
      : "");

  db.prepare(`
    UPDATE merchants SET
      address_poi_id = @address_poi_id,
      poi_title = @poi_title,
      poi_address = @poi_address,
      source_address = CASE WHEN @source_address != '' THEN @source_address ELSE source_address END,
      latitude = @latitude,
      longitude = @longitude,
      merchant_type = @merchant_type,
      poi_candidates = @poi_candidates,
      poi_updated_at = @poi_updated_at,
      updated_at = @updated_at
    WHERE merchant_uid = @merchant_uid
  `).run({
    merchant_uid: merchantUid,
    address_poi_id: poi.poi_id || "",
    poi_title: poi.title || "",
    poi_address: poi.address || "",
    source_address: String(sourceAddress || "").slice(0, 256),
    latitude: poi.latitude ?? null,
    longitude: poi.longitude ?? null,
    merchant_type: merchantType,
    poi_candidates: JSON.stringify(options.candidates || []),
    poi_updated_at: now,
    updated_at: now,
  });

  return enrichMerchantPoiFlags(getMerchantByUid(db, merchantUid), {
    poiMatchMode: getMerchantPoiMatchMode(db),
  });
}

function updatePoiCandidatesOnly(db, merchantUid, candidates, options = {}) {
  ensureMerchantSchema(db);
  const merchant = getMerchantByUid(db, merchantUid);
  if (!merchant) {
    throw new Error(`商户不存在: ${merchantUid}`);
  }

  const now = new Date().toISOString();
  const merchantType = options.merchant_type !== undefined
    ? options.merchant_type
    : merchant.merchant_type;

  db.prepare(`
    UPDATE merchants SET
      poi_candidates = @poi_candidates,
      poi_updated_at = @poi_updated_at,
      updated_at = @updated_at,
      merchant_type = @merchant_type
    WHERE merchant_uid = @merchant_uid
  `).run({
    merchant_uid: merchantUid,
    poi_candidates: JSON.stringify(candidates || []),
    poi_updated_at: now,
    updated_at: now,
    merchant_type: merchantType,
  });

  return getMerchantByUid(db, merchantUid);
}

function updateMerchantImportPrep(db, merchantUid, patch) {
  ensureMerchantSchema(db);
  const merchant = getMerchantByUid(db, merchantUid);
  if (!merchant) {
    throw new Error(`商户不存在: ${merchantUid}`);
  }

  const now = new Date().toISOString();
  const next = {
    merchant_type: patch.merchant_type !== undefined
      ? patch.merchant_type
      : merchant.merchant_type,
    name: patch.name !== undefined ? patch.name : merchant.name,
  };

  db.prepare(`
    UPDATE merchants SET
      merchant_type = @merchant_type,
      name = @name,
      updated_at = @updated_at
    WHERE merchant_uid = @merchant_uid
  `).run({
    merchant_uid: merchantUid,
    merchant_type: next.merchant_type,
    name: next.name,
    updated_at: now,
  });

  return getMerchantByUid(db, merchantUid);
}

function listMerchantsNeedingPoi(db, options = {}) {
  ensureMerchantSchema(db);
  const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
  let sql = `
    SELECT m.*, COALESCE(d.status, 'pending') AS review_status
    FROM merchants m
    LEFT JOIN merchant_review_decisions d ON d.merchant_uid = m.merchant_uid
    WHERE (m.address_poi_id IS NULL OR m.address_poi_id = '')
  `;
  const params = [];
  if (options.city) {
    sql += " AND m.city = ?";
    params.push(options.city);
  }
  if (options.only_approved) {
    sql += " AND d.status = 'approved'";
  } else if (options.only_pending) {
    sql += " AND COALESCE(d.status, 'pending') = 'pending'";
  }
  sql += " ORDER BY m.city, m.search_keyword, m.source_position LIMIT ?";
  params.push(limit);

  return db.prepare(sql).all(...params).map((row) => ({
    ...rowToMerchant(row),
    review_status: row.review_status,
  }));
}

function listPendingMerchantsForPoiRefresh(db, options = {}) {
  ensureMerchantSchema(db);
  const limit = Math.min(Math.max(Number(options.limit) || 2000, 1), 5000);
  let sql = `
    SELECT m.*, COALESCE(d.status, 'pending') AS review_status
    FROM merchants m
    LEFT JOIN merchant_review_decisions d ON d.merchant_uid = m.merchant_uid
    WHERE COALESCE(d.status, 'pending') = 'pending'
  `;
  const params = [];
  if (options.city) {
    sql += " AND m.city = ?";
    params.push(options.city);
  }
  sql += " ORDER BY m.city, m.search_keyword, m.source_position LIMIT ?";
  params.push(limit);
  return db.prepare(sql).all(...params).map((row) => ({
    ...rowToMerchant(row),
    review_status: row.review_status,
  }));
}

function getExportImportMerchants(db, options = {}) {
  ensureMerchantSchema(db);
  const approvedOnly = options.approvedOnly !== false;
  const readyOnly = options.readyOnly !== false;

  let sql = `
    SELECT m.*, COALESCE(d.status, 'pending') AS review_status
    FROM merchants m
    LEFT JOIN merchant_review_decisions d ON d.merchant_uid = m.merchant_uid
    WHERE 1=1
  `;
  if (approvedOnly) {
    sql += " AND d.status = 'approved'";
  }
  sql += " ORDER BY m.city, m.search_keyword, m.source_position";

  const rows = db.prepare(sql).all().map((row) => rowToMerchant(row));
  const merchants = readyOnly ? rows.filter(isImportReady) : rows;
  return merchants.map(buildImportRecord);
}

function getMerchantReviewState(db) {
  ensureMerchantSchema(db);
  const decisions = {};
  const rows = db.prepare(`
    SELECT merchant_uid, status, updated_at
    FROM merchant_review_decisions
    ORDER BY updated_at DESC
  `).all();

  for (const row of rows) {
    decisions[row.merchant_uid] = row.status;
  }

  const updatedAt = rows[0] ? rows[0].updated_at : null;
  return { updatedAt, decisions };
}

function replaceMerchantReviewState(db, decisions) {
  ensureMerchantSchema(db);
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO merchant_review_decisions (merchant_uid, status, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(merchant_uid) DO UPDATE SET
      status = excluded.status,
      updated_at = excluded.updated_at
  `);

  for (const [merchantUid, status] of Object.entries(decisions || {})) {
    if (!VALID_REVIEW_STATUSES.has(status)) {
      throw new Error(`Invalid review status for ${merchantUid}: ${status}`);
    }
    upsert.run(merchantUid, status, now);
  }
  return getMerchantReviewState(db);
}

function getMerchantsPayload(db) {
  ensureMerchantSchema(db);
  const rows = db.prepare(`
    SELECT m.*, COALESCE(d.status, 'pending') AS review_status
    FROM merchants m
    LEFT JOIN merchant_review_decisions d ON d.merchant_uid = m.merchant_uid
    ORDER BY m.city, m.search_keyword, m.source_position
  `).all();

  const poiMatchMode = getMerchantPoiMatchMode(db);
  const merchants = rows.map((row) => enrichMerchantPoiFlags({
    ...rowToMerchant(row),
    review_status: row.review_status,
  }, { poiMatchMode }));

  const metaRow = db.prepare(`
    SELECT value FROM app_meta WHERE key = 'merchant_review_note'
  `).get();

  return {
    updatedAt: merchants.length ? merchants[merchants.length - 1].updated_at : null,
    note: metaRow ? metaRow.value : "商户数据来自大众点评，发布前请核对店名、地址与图片。",
    poi_match_mode: poiMatchMode,
    merchants,
  };
}

function listImportedMerchants(db, options = {}) {
  ensureMerchantSchema(db);
  let sql = `
    SELECT m.*
    FROM merchants m
    INNER JOIN merchant_review_decisions d ON d.merchant_uid = m.merchant_uid
    WHERE d.status = 'approved'
      AND m.import_status = 'imported'
      AND m.buzz_merchant_id IS NOT NULL
      AND m.buzz_merchant_id != ''
  `;
  const params = [];
  if (options.city) {
    sql += " AND m.city = ?";
    params.push(options.city);
  }
  if (options.merchant_uids?.length) {
    const placeholders = options.merchant_uids.map(() => "?").join(",");
    sql += ` AND m.merchant_uid IN (${placeholders})`;
    params.push(...options.merchant_uids);
  }
  sql += " ORDER BY m.city, m.search_keyword, m.source_position";
  const limit = Number(options.limit);
  if (limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }
  return db.prepare(sql).all(...params).map((row) => rowToMerchant(row));
}

function updateMerchantGroupId(db, merchantUid, groupId) {
  ensureMerchantSchema(db);
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE merchants SET
      buzz_group_id = @buzz_group_id,
      updated_at = @updated_at
    WHERE merchant_uid = @merchant_uid
  `).run({
    merchant_uid: merchantUid,
    buzz_group_id: String(groupId || "").trim(),
    updated_at: now,
  });
  return getMerchantByUid(db, merchantUid);
}

function markMerchantBubbleResult(db, merchantUid, result = {}) {
  ensureMerchantSchema(db);
  const current = getMerchantByUid(db, merchantUid);
  if (!current) {
    throw new Error(`商户不存在: ${merchantUid}`);
  }
  const now = new Date().toISOString();
  const pick = (key, fallback = "") => (
    Object.prototype.hasOwnProperty.call(result, key)
      ? String(result[key] || "").trim()
      : String(current?.[key] || fallback).trim()
  );
  db.prepare(`
    UPDATE merchants SET
      bubble_now_id = @bubble_now_id,
      buzz_group_id = @buzz_group_id,
      bubble_published_at = @bubble_published_at,
      updated_at = @updated_at
    WHERE merchant_uid = @merchant_uid
  `).run({
    merchant_uid: merchantUid,
    bubble_now_id: pick("bubble_now_id"),
    buzz_group_id: pick("buzz_group_id", current.buzz_group_id),
    bubble_published_at: Object.prototype.hasOwnProperty.call(result, "bubble_published_at")
      ? result.bubble_published_at
      : (pick("bubble_now_id") ? now : current.bubble_published_at),
    updated_at: now,
  });
  return getMerchantByUid(db, merchantUid);
}

function getApprovedMerchants(db) {
  ensureMerchantSchema(db);
  const rows = db.prepare(`
    SELECT m.*
    FROM merchants m
    INNER JOIN merchant_review_decisions d ON d.merchant_uid = m.merchant_uid
    WHERE d.status = 'approved'
    ORDER BY m.city, m.source_position
  `).all();
  return rows.map(rowToMerchant);
}

function importMerchants(db, merchants, options = {}) {
  ensureMerchantSchema(db);
  const mode = options.mode || "merge";
  const now = new Date().toISOString();
  const importKey = `${options.city || ""}:${options.keyword || ""}`;

  if (mode === "replace-keyword" && options.city && options.keyword) {
    const uids = db.prepare(`
      SELECT merchant_uid FROM merchants WHERE city = ? AND search_keyword = ?
    `).all(options.city, options.keyword).map((row) => row.merchant_uid);
    if (uids.length) {
      const placeholders = uids.map(() => "?").join(",");
      db.prepare(`DELETE FROM merchants WHERE merchant_uid IN (${placeholders})`).run(...uids);
    }
  }

  const upsert = db.prepare(`
    INSERT INTO merchants (
      merchant_uid, source_id, source, city, search_keyword, source_position,
      name, address, source_address, district, category, image, original_link, list_region_text,
      phone, latitude, longitude, review_count, avg_price, business_status,
      needs_detail, import_batch_id, updated_at
    ) VALUES (
      @merchant_uid, @source_id, @source, @city, @search_keyword, @source_position,
      @name, @address, @source_address, @district, @category, @image, @original_link, @list_region_text,
      @phone, @latitude, @longitude, @review_count, @avg_price, @business_status,
      @needs_detail, @import_batch_id, @updated_at
    )
    ON CONFLICT(merchant_uid) DO UPDATE SET
      city = excluded.city,
      search_keyword = excluded.search_keyword,
      source_position = excluded.source_position,
      name = excluded.name,
      address = CASE WHEN excluded.address != '' THEN excluded.address ELSE merchants.address END,
      source_address = CASE WHEN excluded.source_address != '' THEN excluded.source_address ELSE merchants.source_address END,
      district = excluded.district,
      category = excluded.category,
      image = CASE WHEN excluded.image != '' THEN excluded.image ELSE merchants.image END,
      original_link = excluded.original_link,
      list_region_text = excluded.list_region_text,
      phone = CASE WHEN excluded.phone != '' THEN excluded.phone ELSE merchants.phone END,
      latitude = COALESCE(excluded.latitude, merchants.latitude),
      longitude = COALESCE(excluded.longitude, merchants.longitude),
      review_count = COALESCE(excluded.review_count, merchants.review_count),
      avg_price = excluded.avg_price,
      business_status = excluded.business_status,
      needs_detail = excluded.needs_detail,
      import_batch_id = excluded.import_batch_id,
      updated_at = excluded.updated_at
  `);

  for (const record of merchants) {
    upsert.run(record);
  }

  db.prepare(`
    INSERT INTO merchant_imports (import_key, city, search_keyword, source_page, merchant_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(import_key) DO UPDATE SET
      merchant_count = excluded.merchant_count,
      source_page = excluded.source_page,
      updated_at = excluded.updated_at
  `).run(
    importKey,
    options.city || "",
    options.keyword || "",
    options.sourcePage || "",
    merchants.length,
    now,
  );

  return { imported: merchants.length, importKey };
}

module.exports = {
  applyPoiSelection,
  clearMerchantBuzzId,
  ensureMerchantSchema,
  findBuzzMerchantIdByPoi,
  getApprovedMerchants,
  getExportImportMerchants,
  getMerchantByUid,
  getMerchantImportProgress,
  getMerchantReviewState,
  getMerchantPoiMatchMode,
  getMerchantsPayload,
  importMerchants,
  listImportedMerchants,
  listMerchantsEligibleForImport,
  listMerchantsNeedingPoi,
  listPendingMerchantsForPoiRefresh,
  setMerchantPoiMatchMode,
  markMerchantBubbleResult,
  markMerchantImportResult,
  updateMerchantGroupId,
  openDatabase,
  replaceMerchantReviewState,
  rowToMerchant,
  updateMerchantBuzzId,
  updateMerchantImportPrep,
  updatePoiCandidatesOnly,
};

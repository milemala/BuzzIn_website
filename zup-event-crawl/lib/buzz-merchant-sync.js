"use strict";

const { BuzzAdminClient } = require("./buzz-now-import");
const { createBuzzClientOptions, normalizeBuzzEnv } = require("./buzz-env");
const { normalizeMerchantImageUrl } = require("./merchant-image-url");
const {
  deleteLocalMerchant,
  listLocalMerchantsByPoi,
  upsertBuzzSyncedMerchant,
} = require("./merchant-db");
const { ENTITY_MERCHANT, ensureBuzzImportSchema } = require("./buzz-import-store");

const PAGE_SIZE = 100;

function merchantUidForBuzz(buzzEnv, merchantId) {
  return `buzz:${normalizeBuzzEnv(buzzEnv)}:${String(merchantId || "").trim()}`;
}

function parseExtraCity(extra) {
  if (!extra) return "";
  if (typeof extra === "object" && extra.city) {
    return String(extra.city).trim();
  }
  try {
    const parsed = JSON.parse(String(extra));
    return String(parsed?.city || "").trim();
  } catch {
    return "";
  }
}

function inferCityFromAddress(address) {
  const text = String(address || "").trim();
  if (!text) return "";
  const direct = text.match(/^(北京|上海|天津|重庆)市/);
  if (direct) return direct[1];
  const match = text.match(/^(.{2,4}?)市/);
  return match ? match[1] : "";
}

function isUsableBuzzImageUrl(value) {
  const url = String(value || "").trim();
  return Boolean(url && url !== "-");
}

function firstImage(item) {
  const medias = Array.isArray(item?.medias) ? item.medias : [];
  const logo = isUsableBuzzImageUrl(item?.logo) ? String(item.logo).trim() : "";
  for (const media of medias) {
    const url = media?.media_url || media?.url || "";
    if (isUsableBuzzImageUrl(url)) {
      return normalizeMerchantImageUrl(url);
    }
  }
  return logo ? normalizeMerchantImageUrl(logo) : "";
}

function mapBuzzMerchantToLocalRow(item, options = {}) {
  const buzzEnv = normalizeBuzzEnv(options.buzz_env);
  const merchantId = String(item.merchant_id || "").trim();
  const poiId = String(item.address_poi_id || "").trim();
  const displayName = String(item.name_new || item.name || "").trim();
  const poiTitle = String(item.name || displayName).trim();
  const address = String(item.address || "").trim();
  const city = parseExtraCity(item.extra) || inferCityFromAddress(address);
  const now = new Date().toISOString();

  return {
    merchant_uid: merchantUidForBuzz(buzzEnv, merchantId),
    source_id: merchantId,
    source: "buzz",
    city,
    search_keyword: displayName.slice(0, 64),
    source_position: 0,
    name: displayName,
    address,
    source_address: address,
    district: "",
    category: "",
    image: firstImage(item),
    original_link: "",
    list_region_text: "",
    phone: "",
    latitude: Number(item.latitude) || null,
    longitude: Number(item.longitude) || null,
    review_count: null,
    avg_price: "",
    business_status: "open",
    needs_detail: 0,
    import_batch_id: `buzz-sync:${buzzEnv}`,
    updated_at: now,
    address_poi_id: poiId,
    poi_title: poiTitle,
    poi_address: address,
    merchant_type: Number(item.type) || null,
    poi_candidates: "[]",
    poi_updated_at: poiId ? now : null,
  };
}

function findProdBuzzImportByMerchantId(db, merchantId, buzzEnv) {
  const env = normalizeBuzzEnv(buzzEnv);
  const id = String(merchantId || "").trim();
  if (!id) return null;
  return db.prepare(`
    SELECT bi.entity_uid, bi.buzz_id, bi.import_status
    FROM buzz_imports bi
    WHERE bi.entity_kind = ?
      AND bi.buzz_env = ?
      AND bi.buzz_id = ?
    LIMIT 1
  `).get(ENTITY_MERCHANT, env, id);
}

function findLocalBuzzSourceMerchant(db, merchantId) {
  const id = String(merchantId || "").trim();
  if (!id) return null;
  return db.prepare(`
    SELECT merchant_uid, name, address_poi_id
    FROM merchants
    WHERE source = 'buzz' AND source_id = ?
    LIMIT 1
  `).get(id);
}

function resolveSyncAction(db, buzzItem, buzzEnv) {
  const merchantId = String(buzzItem.merchant_id || "").trim();
  if (!merchantId) {
    return { action: "skip", reason: "missing_merchant_id" };
  }

  const linked = findProdBuzzImportByMerchantId(db, merchantId, buzzEnv);
  if (linked?.import_status === "imported" && linked.buzz_id === merchantId) {
    return {
      action: "skip",
      reason: "already_linked",
      merchant_uid: linked.entity_uid,
    };
  }

  const buzzSource = findLocalBuzzSourceMerchant(db, merchantId);
  if (buzzSource) {
    return {
      action: "skip",
      reason: "buzz_source_exists",
      merchant_uid: buzzSource.merchant_uid,
    };
  }

  const poiId = String(buzzItem.address_poi_id || "").trim();
  if (poiId) {
    const targetUid = merchantUidForBuzz(buzzEnv, merchantId);
    const conflicts = listLocalMerchantsByPoi(db, poiId)
      .filter((row) => row.merchant_uid !== targetUid);
    if (conflicts.length) {
      return {
        action: "replace",
        reason: "poi_conflict",
        delete_uids: conflicts.map((row) => row.merchant_uid),
        delete_details: conflicts,
      };
    }
  }

  return { action: "create", reason: "new" };
}

async function fetchAllBuzzMerchants(client, options = {}) {
  const list = [];
  let page = 1;
  let total = Infinity;
  const status = options.status;

  while ((page - 1) * PAGE_SIZE < total) {
    const body = { page, size: PAGE_SIZE, keyword: "" };
    if (status != null && status !== "") body.status = status;
    const data = await client.postJSON("/merchants/list", body);
    total = data?.pagination?.total || 0;
    const batch = data?.list || [];
    if (!batch.length) break;
    list.push(...batch);
    page += 1;
  }
  return list;
}

function refreshBuzzMerchantImages(db, remoteList, options = {}) {
  const dryRun = options.dry_run === true;
  const imageByMerchantId = new Map();
  for (const item of remoteList) {
    const merchantId = String(item.merchant_id || "").trim();
    if (!merchantId) continue;
    const image = firstImage(item);
    if (image) imageByMerchantId.set(merchantId, image);
  }

  const rows = db.prepare(`
    SELECT merchant_uid, source_id, name, image
    FROM merchants
    WHERE source = 'buzz'
  `).all();

  const report = {
    checked: rows.length,
    updated: 0,
    updated_items: [],
  };

  const update = db.prepare(`
    UPDATE merchants SET image = @image, updated_at = @updated_at
    WHERE merchant_uid = @merchant_uid
  `);
  const now = new Date().toISOString();

  for (const row of rows) {
    const nextImage = imageByMerchantId.get(String(row.source_id || "").trim()) || "";
    if (!nextImage) continue;
    const current = String(row.image || "").trim();
    if (current === nextImage) continue;
    if (!current || current === "-") {
      if (!dryRun) {
        update.run({
          merchant_uid: row.merchant_uid,
          image: nextImage,
          updated_at: now,
        });
      }
      report.updated += 1;
      report.updated_items.push({
        merchant_uid: row.merchant_uid,
        name: row.name,
        image: nextImage,
      });
    }
  }

  return report;
}

async function syncMerchantsFromBuzz(db, options = {}) {
  ensureBuzzImportSchema(db);
  const buzzEnv = normalizeBuzzEnv(options.buzz_env || options.env || "prod");
  const dryRun = options.dry_run === true;
  const status = options.status != null ? options.status : 1;
  const client = options.client || new BuzzAdminClient(createBuzzClientOptions(buzzEnv));

  const remoteList = await fetchAllBuzzMerchants(client, { status });
  const report = {
    buzz_env: buzzEnv,
    dry_run: dryRun,
    fetched: remoteList.length,
    created: 0,
    skipped: 0,
    deleted: 0,
    errors: [],
    created_items: [],
    skipped_items: [],
    deleted_items: [],
  };

  for (const item of remoteList) {
    const merchantId = String(item.merchant_id || "").trim();
    const name = String(item.name_new || item.name || merchantId).trim();
    try {
      const decision = resolveSyncAction(db, item, buzzEnv);

      if (decision.action === "skip") {
        report.skipped += 1;
        report.skipped_items.push({
          merchant_id: merchantId,
          name,
          reason: decision.reason,
          merchant_uid: decision.merchant_uid || "",
        });
        continue;
      }

      if (decision.action === "replace") {
        for (const detail of decision.delete_details || []) {
          if (dryRun) {
            report.deleted += 1;
            report.deleted_items.push({
              merchant_uid: detail.merchant_uid,
              name: detail.name,
              address_poi_id: detail.address_poi_id,
              replaced_by_merchant_id: merchantId,
            });
            continue;
          }
          const removed = deleteLocalMerchant(db, detail.merchant_uid);
          if (removed) {
            report.deleted += 1;
            report.deleted_items.push({
              merchant_uid: detail.merchant_uid,
              name: detail.name,
              address_poi_id: detail.address_poi_id,
              replaced_by_merchant_id: merchantId,
            });
          }
        }
      }

      const row = mapBuzzMerchantToLocalRow(item, { buzz_env: buzzEnv });
      if (dryRun) {
        report.created += 1;
        report.created_items.push({
          merchant_id: merchantId,
          name: row.name,
          merchant_uid: row.merchant_uid,
          address_poi_id: row.address_poi_id,
          city: row.city,
        });
        continue;
      }

      upsertBuzzSyncedMerchant(db, row, buzzEnv);
      report.created += 1;
      report.created_items.push({
        merchant_id: merchantId,
        name: row.name,
        merchant_uid: row.merchant_uid,
        address_poi_id: row.address_poi_id,
        city: row.city,
      });
    } catch (error) {
      report.errors.push({
        merchant_id: merchantId,
        name,
        error: error?.message || String(error),
      });
    }
  }

  report.images = refreshBuzzMerchantImages(db, remoteList, { dry_run: dryRun });

  return report;
}

module.exports = {
  fetchAllBuzzMerchants,
  firstImage,
  inferCityFromAddress,
  mapBuzzMerchantToLocalRow,
  merchantUidForBuzz,
  refreshBuzzMerchantImages,
  resolveSyncAction,
  syncMerchantsFromBuzz,
};

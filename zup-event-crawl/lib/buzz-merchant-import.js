"use strict";

const {
  buildImportRecord,
  importReadyIssues,
  isImportReady,
} = require("./merchant-import-ready");
const { BuzzAdminClient } = require("./buzz-now-import");
const {
  clearMerchantBuzzId,
  getMerchantByUid,
  listMerchantsEligibleForImport,
  markMerchantImportResult,
} = require("./merchant-db");

function isMerchantApproved(db, merchantUid) {
  const row = db.prepare(`
    SELECT status FROM merchant_review_decisions WHERE merchant_uid = ?
  `).get(merchantUid);
  return row?.status === "approved";
}

async function findMerchant(client, name, poiId) {
  const data = await client.postJSON("/merchants/list", {
    page: 1,
    size: 100,
    keyword: name,
  });
  const list = data?.list || [];
  for (const item of list) {
    if (item.name !== name) continue;
    if (poiId && item.address_poi_id !== poiId) continue;
    return item.merchant_id || "";
  }
  return "";
}

function buildBuzzMerchantPayload(record, media = {}) {
  const displayName = String(record.name_new || record.name || "").trim();
  const payload = {
    name: record.name,
    name_new: displayName,
    type: record.type,
    description: record.description || "",
    longitude: record.longitude,
    latitude: record.latitude,
    address: record.address,
    address_poi_id: record.address_poi_id,
    status: record.status ?? 1,
    score: record.score ?? 0,
    is_verified: record.is_verified ?? 1,
    logo: media.logo || "-",
  };
  if (media.medias?.length) payload.medias = media.medias;
  if (record.operator_user_id) payload.operator_user_id = record.operator_user_id;
  if (record.admin_ids?.length) payload.admin_ids = record.admin_ids;
  if (record.extra) payload.extra = record.extra;
  return payload;
}

async function uploadMerchantMedia(client, src) {
  const url = String(src || "").trim();
  if (!url) return null;
  return client.uploadMedia(url);
}

async function importMerchantToBuzz(db, merchantUid, options = {}) {
  const client = options.client || new BuzzAdminClient(options);
  const dedup = options.dedup !== false;
  const merchant = getMerchantByUid(db, merchantUid);
  if (!merchant) {
    return { ok: false, merchant_uid: merchantUid, error: "商户不存在" };
  }
  if (!isMerchantApproved(db, merchantUid)) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      name: merchant.name,
      error: "仅已通过的商户可入库",
      merchant,
    };
  }
  if (merchant.import_status === "imported" && merchant.buzz_merchant_id) {
    return {
      ok: true,
      skipped: true,
      merchant_uid: merchantUid,
      name: merchant.name,
      merchant_id: merchant.buzz_merchant_id,
      merchant,
    };
  }

  const issues = importReadyIssues(merchant);
  if (!isImportReady(merchant)) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      name: merchant.name,
      error: issues.join("；") || "入库字段未齐",
      merchant,
    };
  }

  const record = buildImportRecord(merchant);

  try {
    if (dedup) {
      const existingId = await findMerchant(client, record.name, record.address_poi_id);
      if (existingId) {
        const updated = markMerchantImportResult(db, merchantUid, {
          buzz_merchant_id: existingId,
          import_status: "imported",
          import_error: "",
        });
        return {
          ok: true,
          skipped: true,
          merchant_uid: merchantUid,
          name: merchant.name,
          merchant_id: existingId,
          merchant: updated,
        };
      }
    }

    const media = { logo: "-", medias: [] };
    const imageSources = [...new Set((record.images || []).filter(Boolean))];
    if (!imageSources.length && record.logo_image) {
      imageSources.push(record.logo_image);
    }
    const logoSrc = record.logo_image || imageSources[0] || "";

    for (const src of imageSources) {
      const item = await uploadMerchantMedia(client, src);
      if (!item) continue;
      media.medias.push(item);
      if (src === logoSrc) {
        media.logo = item.media_url;
      }
    }
    if (media.logo === "-" && media.medias[0]) {
      media.logo = media.medias[0].media_url;
    }

    const payload = buildBuzzMerchantPayload(record, media);
    const data = await client.postJSON("/merchants", payload);
    const merchantId = data?.merchant_id || "";
    if (!merchantId) {
      throw new Error("创建成功但未返回 merchant_id");
    }

    const updated = markMerchantImportResult(db, merchantUid, {
      buzz_merchant_id: merchantId,
      import_status: "imported",
      import_error: "",
    });
    return {
      ok: true,
      merchant_uid: merchantUid,
      name: merchant.name,
      merchant_id: merchantId,
      merchant: updated,
    };
  } catch (error) {
    const updated = markMerchantImportResult(db, merchantUid, {
      import_status: "failed",
      import_error: error.message,
    });
    return {
      ok: false,
      merchant_uid: merchantUid,
      name: merchant.name,
      error: error.message,
      merchant: updated,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function batchImportApprovedMerchants(db, options = {}) {
  const merchants = listMerchantsEligibleForImport(db, options);
  const results = [];
  let ok = 0;
  let fail = 0;
  let skipped = 0;

  for (const merchant of merchants) {
    const result = await importMerchantToBuzz(db, merchant.merchant_uid, options);
    results.push(result);
    if (result.skipped) skipped += 1;
    else if (result.ok) ok += 1;
    else fail += 1;
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 1200);
    }
  }

  return { total: merchants.length, ok, fail, skipped, results };
}

async function deleteMerchantFromBuzz(db, merchantUid, options = {}) {
  const merchant = getMerchantByUid(db, merchantUid);
  if (!merchant) {
    return { ok: false, merchant_uid: merchantUid, error: "商户不存在" };
  }
  const merchantId = String(merchant.buzz_merchant_id || "").trim();
  if (!merchantId) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      name: merchant.name,
      error: "本地未记录 merchant_id，无法删除后台商户",
      merchant,
    };
  }

  const client = options.client || new BuzzAdminClient(options);
  try {
    await client.deleteJSON(`/merchants/${encodeURIComponent(merchantId)}`);
    const updated = clearMerchantBuzzId(db, merchantUid);
    return {
      ok: true,
      merchant_uid: merchantUid,
      name: merchant.name,
      merchant_id: merchantId,
      merchant: updated,
    };
  } catch (error) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      name: merchant.name,
      merchant_id: merchantId,
      error: error.message,
      merchant,
    };
  }
}

module.exports = {
  batchImportApprovedMerchants,
  deleteMerchantFromBuzz,
  importMerchantToBuzz,
};

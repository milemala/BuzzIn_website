"use strict";

const {
  buildImportRecord,
  importReadyIssues,
  isImportReady,
  merchantTypeNameFromId,
  resolveMerchantTypeId,
  resolveMerchantTypeName,
} = require("./merchant-import-ready");
const { BuzzAdminClient } = require("./buzz-now-import");
const {
  applyBuzzEnvToMerchant,
  clearMerchantBuzzId,
  markMerchantImportResult,
} = require("./buzz-import-store");
const { normalizeBuzzEnv, createBuzzClientOptions } = require("./buzz-env");
const {
  getMerchantByUid,
  listMerchantsEligibleForImport,
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
  const payload = {
    name: record.name,
    name_new: record.name_new,
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

function resolveBuzzEnv(options = {}) {
  return normalizeBuzzEnv(options.buzz_env || options.env);
}

function createClientForEnv(options = {}) {
  if (options.client) return options.client;
  const buzzEnv = resolveBuzzEnv(options);
  return new BuzzAdminClient({ ...createBuzzClientOptions(buzzEnv), ...options, buzz_env: buzzEnv });
}

function merchantWithBuzzEnv(db, merchantUid, buzzEnv) {
  return applyBuzzEnvToMerchant(db, getMerchantByUid(db, merchantUid), buzzEnv);
}

async function buildEnvImportRecord(client, merchant) {
  const record = buildImportRecord(merchant);
  const envTypes = await client.listMerchantTypes();
  const typeName = resolveMerchantTypeName(merchant);
  record.type = resolveMerchantTypeId(merchant.merchant_type, typeName, envTypes);
  return record;
}

async function importMerchantToBuzz(db, merchantUid, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const client = createClientForEnv(options);
  const dedup = options.dedup !== false;
  const merchant = merchantWithBuzzEnv(db, merchantUid, buzzEnv);
  if (!merchant) {
    return { ok: false, merchant_uid: merchantUid, buzz_env: buzzEnv, error: "商户不存在" };
  }
  if (!isMerchantApproved(db, merchantUid)) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
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
      buzz_env: buzzEnv,
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
      buzz_env: buzzEnv,
      name: merchant.name,
      error: issues.join("；") || "入库字段未齐",
      merchant,
    };
  }

  let record;
  try {
    record = await buildEnvImportRecord(client, merchant);
  } catch (error) {
    markMerchantImportResult(db, merchantUid, {
      import_status: "failed",
      import_error: error.message,
    }, buzzEnv);
    return {
      ok: false,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      error: error.message,
      merchant: merchantWithBuzzEnv(db, merchantUid, buzzEnv),
    };
  }

  try {
    if (dedup) {
      const existingId = await findMerchant(client, record.name, record.address_poi_id);
      if (existingId) {
        markMerchantImportResult(db, merchantUid, {
          buzz_merchant_id: existingId,
          import_status: "imported",
          import_error: "",
        }, buzzEnv);
        return {
          ok: true,
          skipped: true,
          merchant_uid: merchantUid,
          buzz_env: buzzEnv,
          name: merchant.name,
          merchant_id: existingId,
          merchant: merchantWithBuzzEnv(db, merchantUid, buzzEnv),
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

    markMerchantImportResult(db, merchantUid, {
      buzz_merchant_id: merchantId,
      import_status: "imported",
      import_error: "",
    }, buzzEnv);
    return {
      ok: true,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      merchant_id: merchantId,
      merchant: merchantWithBuzzEnv(db, merchantUid, buzzEnv),
    };
  } catch (error) {
    markMerchantImportResult(db, merchantUid, {
      import_status: "failed",
      import_error: error.message,
    }, buzzEnv);
    return {
      ok: false,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      error: error.message,
      merchant: merchantWithBuzzEnv(db, merchantUid, buzzEnv),
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
    if (options.shouldAbort?.()) {
      return {
        total: merchants.length,
        processed: ok + fail + skipped,
        ok,
        fail,
        skipped,
        results,
        aborted: true,
        buzz_env: resolveBuzzEnv(options),
      };
    }
    const result = await importMerchantToBuzz(db, merchant.merchant_uid, options);
    results.push(result);
    if (result.skipped) skipped += 1;
    else if (result.ok) ok += 1;
    else fail += 1;
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 1200);
    }
  }

  return {
    total: merchants.length,
    processed: ok + fail + skipped,
    ok,
    fail,
    skipped,
    results,
    aborted: false,
    buzz_env: resolveBuzzEnv(options),
  };
}

async function deleteMerchantFromBuzz(db, merchantUid, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const merchant = merchantWithBuzzEnv(db, merchantUid, buzzEnv);
  if (!merchant) {
    return { ok: false, merchant_uid: merchantUid, buzz_env: buzzEnv, error: "商户不存在" };
  }
  const merchantId = String(merchant.buzz_merchant_id || "").trim();
  if (!merchantId) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      error: "本地未记录 merchant_id，无法删除后台商户",
      merchant,
    };
  }

  const client = createClientForEnv(options);
  try {
    await client.deleteJSON(`/merchants/${encodeURIComponent(merchantId)}`);
    clearMerchantBuzzId(db, merchantUid, buzzEnv);
    return {
      ok: true,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      merchant_id: merchantId,
      merchant: merchantWithBuzzEnv(db, merchantUid, buzzEnv),
    };
  } catch (error) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
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

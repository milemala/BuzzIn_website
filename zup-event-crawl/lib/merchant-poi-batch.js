"use strict";

const { pickBestPoiForMerchant, searchPoiForMerchant } = require("./tencent-poi");
const {
  applyPoiSelection,
  getMerchantByUid,
  listMerchantsNeedingPoi,
} = require("./merchant-db");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 为商户列表批量搜索腾讯 POI，按店名相似度选最佳候选并写入 review.db。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   merchants?: object[],
 *   merchant_uids?: string[],
 *   city?: string,
 *   only_pending?: boolean,
 *   only_approved?: boolean,
 *   refresh?: boolean,
 *   limit?: number,
 *   delayMs?: number,
 * }} options
 */
async function batchAutoPoi(db, options = {}) {
  const delayMs = options.delayMs ?? 320;
  let targets;

  if (Array.isArray(options.merchants) && options.merchants.length) {
    targets = options.merchants;
  } else if (Array.isArray(options.merchant_uids) && options.merchant_uids.length) {
    targets = options.merchant_uids
      .map((uid) => getMerchantByUid(db, uid))
      .filter(Boolean);
  } else {
    targets = listMerchantsNeedingPoi(db, {
      city: options.city || "",
      only_pending: options.only_pending,
      only_approved: options.only_approved,
      limit: options.limit || 500,
    });
  }

  if (!options.refresh) {
    targets = targets.filter((m) => !m.address_poi_id);
  }

  const report = { total: targets.length, ok: 0, fail: 0, results: [] };

  for (const merchant of targets) {
    try {
      const { items, keyword } = await searchPoiForMerchant(
        merchant.name,
        merchant.city || "全国",
      );
      if (!items.length) {
        report.fail += 1;
        report.results.push({
          merchant_uid: merchant.merchant_uid,
          name: merchant.name,
          city: merchant.city,
          ok: false,
          error: "无 POI 结果",
        });
      } else {
        const { poi: best } = pickBestPoiForMerchant(merchant.name, items);
        applyPoiSelection(db, merchant.merchant_uid, best, { candidates: items });
        report.ok += 1;
        report.results.push({
          merchant_uid: merchant.merchant_uid,
          name: merchant.name,
          city: merchant.city,
          ok: true,
          poi_id: best.poi_id,
          poi_title: best.title,
        });
      }
    } catch (error) {
      report.fail += 1;
      report.results.push({
        merchant_uid: merchant.merchant_uid,
        name: merchant.name,
        city: merchant.city,
        ok: false,
        error: error.message,
      });
    }
    await sleep(delayMs);
  }

  return report;
}

module.exports = { batchAutoPoi };

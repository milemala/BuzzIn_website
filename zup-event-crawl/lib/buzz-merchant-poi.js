"use strict";

const DEFAULT_BASE = "https://test-go-api.nowmap.cn";
const POI_INFO_PATH = "/api/v1/merchant/poi/info";
const DEFAULT_CHUNK = 50;
const REQUEST_TIMEOUT_MS = 15000;

function normalizeBase(base) {
  return String(base || process.env.BUZZ_API_BASE || DEFAULT_BASE).trim().replace(/\/$/, "");
}

function poiKeyFromItem(item) {
  if (!item || typeof item !== "object") return "";
  return String(
    item.poi_id ?? item.address_poi_id ?? item.location_poi_id ?? item.poiId ?? ""
  ).trim();
}

function merchantIdFromItem(item) {
  if (!item || typeof item !== "object") return "";
  const merchant = item.merchant || item.merchant_info;
  if (merchant && typeof merchant === "object") {
    const nested = String(merchant.merchant_id ?? merchant.id ?? "").trim();
    if (nested) return nested;
  }
  return String(item.merchant_id ?? item.merchantId ?? "").trim();
}

function merchantNameFromItem(item) {
  if (!item || typeof item !== "object") return "";
  const merchant = item.merchant || item.merchant_info;
  if (merchant && typeof merchant === "object") {
    const nested = String(merchant.merchant_name ?? merchant.name ?? merchant.merchant_name_new ?? "").trim();
    if (nested) return nested;
  }
  return String(item.merchant_name ?? item.merchant_name_new ?? item.name ?? "").trim();
}

function merchantFromItem(item) {
  const merchantId = merchantIdFromItem(item);
  if (!merchantId) return null;
  return {
    merchant_id: merchantId,
    merchant_name: merchantNameFromItem(item),
    poi_id: poiKeyFromItem(item),
  };
}

function isVerifiedMerchant(item) {
  if (!item || typeof item !== "object") return true;
  const verified = item.is_verified ?? item.isVerified;
  if (verified != null && verified !== "") {
    return Number(verified) === 1;
  }
  const status = item.status;
  if (status != null && status !== "") {
    return Number(status) === 1;
  }
  return true;
}

function parseMerchantPoiResponse(payload) {
  const map = new Map();
  if (!payload || typeof payload !== "object") return map;
  if (payload.code != null && Number(payload.code) !== 0) {
    throw new Error(payload.message || `API code=${payload.code}`);
  }
  const list = payload.data?.list ?? payload.data ?? payload.list ?? [];
  if (!Array.isArray(list)) return map;
  for (const item of list) {
    const poiId = poiKeyFromItem(item);
    const merchantId = merchantIdFromItem(item);
    if (!poiId || !merchantId) continue;
    if (!isVerifiedMerchant(item)) continue;
    if (!map.has(poiId)) map.set(poiId, merchantId);
  }
  return map;
}

async function fetchMerchantPoiMap(poiIdList, options = {}) {
  const ids = [...new Set((poiIdList || []).map((id) => String(id).trim()).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const base = normalizeBase(options.base);
  const chunkSize = options.chunkSize || DEFAULT_CHUNK;
  const map = new Map();

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${base}${POI_INFO_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ poi_id_list: chunk }),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`非 JSON 响应 (${response.status}): ${text.slice(0, 200)}`);
      }
      if (!response.ok && Number(payload.code) !== 0) {
        throw new Error(payload.message || `HTTP ${response.status}`);
      }
      const partial = parseMerchantPoiResponse(payload);
      for (const [key, value] of partial) map.set(key, value);
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("merchant/poi/info 请求超时");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return map;
}

async function buildPoiMerchantIdMap(poiIds, options = {}) {
  return fetchMerchantPoiMap(poiIds, options);
}

async function lookupMerchantByPoiId(poiId, options = {}) {
  const id = String(poiId || "").trim();
  if (!id) return null;
  const map = await lookupMerchantsByPoiIds([id], options);
  return map.get(id) || null;
}

async function lookupMerchantsByPoiIds(poiIds, options = {}) {
  const map = await fetchMerchantPoiMap(poiIds, options);
  const base = normalizeBase(options.base);
  const ids = [...new Set((poiIds || []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) return new Map();

  const details = new Map();
  for (const poiId of ids) {
    const merchantId = map.get(poiId);
    if (merchantId) {
      details.set(poiId, { merchant_id: merchantId, merchant_name: "", poi_id: poiId });
    }
  }

  if (details.size === 0) return details;

  try {
    const chunkSize = options.chunkSize || DEFAULT_CHUNK;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch(`${base}${POI_INFO_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poi_id_list: chunk }),
          signal: controller.signal,
        });
        const payload = await response.json();
        const list = payload?.data?.list ?? [];
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const merchant = merchantFromItem(item);
          if (!merchant) continue;
          if (!isVerifiedMerchant(item)) continue;
          details.set(merchant.poi_id, merchant);
        }
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    // 保留仅有 merchant_id 的降级结果
  }
  return details;
}

function createMerchantIdResolver(db, poiMap) {
  const { findBuzzMerchantIdByPoi } = require("./merchant-db");
  return (poiId) => {
    const id = String(poiId || "").trim();
    if (!id) return "";
    const fromApi = poiMap.get(id);
    if (fromApi) return fromApi;
    if (db) return findBuzzMerchantIdByPoi(db, id);
    return "";
  };
}

module.exports = {
  buildPoiMerchantIdMap,
  createMerchantIdResolver,
  fetchMerchantPoiMap,
  lookupMerchantByPoiId,
  lookupMerchantsByPoiIds,
  parseMerchantPoiResponse,
};

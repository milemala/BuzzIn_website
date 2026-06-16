"use strict";

const { normalizeMerchantImageUrl } = require("./merchant-image-url");

/** 本地回退列表（测试环境无「书店」「公园」时用「其他」） */
const MERCHANT_TYPES = [
  { id: 1, name: "啤酒吧" },
  { id: 2, name: "酒馆" },
  { id: 3, name: "茶馆" },
  { id: 4, name: "餐厅" },
  { id: 16, name: "咖啡厅" },
  { id: 13, name: "其他" },
];

const BIZ_SPECIFIC_TYPE_NAMES = new Set(["书店", "公园"]);
const TYPE_NAME_FALLBACKS = {
  书店: ["其他"],
  公园: ["其他"],
};

const MERCHANT_TYPE_NAME_BY_ID = new Map(MERCHANT_TYPES.map((item) => [item.id, item.name]));

function merchantTypeNameFromId(typeId) {
  const id = Number(typeId);
  if (!id) return "";
  return MERCHANT_TYPE_NAME_BY_ID.get(id) || "";
}

function suggestMerchantTypeName(category, name, importBatchId = "") {
  const text = `${category || ""} ${name || ""}`;
  const batch = String(importBatchId || "");

  if (batch.includes("公园") || /^(公园|植物园|风景名胜|湿地公园|森林公园)/.test(String(category || ""))) {
    return "公园";
  }
  if (/书店|图书|阅读|茑屋|PAGEONE|单向空间|BOOKSTORE/i.test(text)) {
    return "书店";
  }
  if (/公园|植物园|风景名胜|湿地|森林公园/i.test(text) && !/酒吧|精酿|餐吧|咖啡|书店/i.test(category || "")) {
    return "公园";
  }
  if (/啤酒|精酿|啤酒屋|啤酒吧/i.test(text)) return "啤酒吧";
  if (/酒馆|酒吧|清吧|Taproom|COMMUNE|跳海|京A|餐吧/i.test(text)) return "酒馆";
  if (/咖啡/i.test(text)) return "咖啡厅";
  if (/茶(?!馆)|茶饮/i.test(text)) return "茶馆";
  if (/餐|饭|食/i.test(text)) return "餐厅";
  return "酒馆";
}

function findMerchantTypeIdByName(typeName, envTypes) {
  const name = String(typeName || "").trim();
  if (!name) return 0;
  const list = Array.isArray(envTypes) && envTypes.length ? envTypes : MERCHANT_TYPES;
  const hit = list.find((item) => item.name === name);
  if (hit) return Number(hit.id);
  for (const fallbackName of TYPE_NAME_FALLBACKS[name] || []) {
    const fallback = list.find((item) => item.name === fallbackName);
    if (fallback) return Number(fallback.id);
  }
  return 0;
}

function resolveMerchantTypeName(merchant) {
  const fromCategory = suggestMerchantTypeName(
    merchant?.category,
    merchant?.name,
    merchant?.import_batch_id,
  );
  if (BIZ_SPECIFIC_TYPE_NAMES.has(fromCategory)) return fromCategory;
  const fromId = merchantTypeNameFromId(merchant?.merchant_type);
  if (fromId) return fromId;
  return fromCategory;
}

function resolveMerchantTypeId(typeId, typeName, envTypes) {
  const list = Array.isArray(envTypes) ? envTypes : [];
  const name = String(typeName || merchantTypeNameFromId(typeId) || "").trim();
  if (name) {
    const byName = findMerchantTypeIdByName(name, list);
    if (byName) return byName;
  }
  const id = Number(typeId);
  if (id && list.some((item) => Number(item.id) === id)) return id;
  if (name) {
    throw new Error(`目标环境找不到商户类型「${name}」`);
  }
  return id;
}

function resolveMerchantTypeForEnv(merchant, envTypes) {
  const typeName = resolveMerchantTypeName(merchant);
  return resolveMerchantTypeId(merchant?.merchant_type, typeName, envTypes);
}

function suggestMerchantType(category, name, importBatchId = "", envTypes) {
  const typeName = suggestMerchantTypeName(category, name, importBatchId);
  const id = findMerchantTypeIdByName(typeName, envTypes);
  if (id) return id;
  const found = MERCHANT_TYPES.find((item) => item.name === typeName);
  return found ? found.id : 2;
}

function trimName(name, maxLen = 64) {
  const chars = [...String(name || "").trim()];
  if (chars.length <= maxLen) return chars.join("");
  return chars.slice(0, maxLen).join("");
}

/** Buzz `name_new` 展示名，上限 255 */
function trimDisplayName(name, maxLen = 255) {
  return trimName(name, maxLen);
}

function importReadyIssues(merchant) {
  const issues = [];
  const poiName = trimName(merchant.poi_title);
  if (!poiName) issues.push("缺少 POI 名称");
  else if ([...String(merchant.poi_title || "").trim()].length > 64) {
    issues.push("POI 名称超过 64 字");
  }

  const displayName = trimDisplayName(merchant.name);
  if (!displayName) issues.push("缺少商户展示名（审核台卡片店名）");
  else if ([...String(merchant.name || "").trim()].length > 255) {
    issues.push("商户展示名超过 255 字");
  }

  const type = resolveMerchantTypeForEnv(merchant, MERCHANT_TYPES);
  if (!type || type <= 0) issues.push("未选商户类型");

  if (!String(merchant.address_poi_id || "").trim()) issues.push("未匹配 POI");

  const lng = Number(merchant.longitude);
  const lat = Number(merchant.latitude);
  if (!lng || !lat) issues.push("缺少经纬度");

  return issues;
}

function isImportReady(merchant) {
  return importReadyIssues(merchant).length === 0;
}

function buildImportRecord(merchant) {
  // name = 腾讯 POI 标题（地图/查重主键）；name_new = 审核台卡片商户名（C 端展示）
  const name = trimName(merchant.poi_title);
  const nameNew = trimDisplayName(merchant.name);
  const extra = JSON.stringify({
    source: merchant.source || "dianping",
    shop_id: merchant.source_id || "",
    merchant_uid: merchant.merchant_uid || "",
    search_keyword: merchant.search_keyword || "",
    city: merchant.city || "",
    card_name: nameNew,
  });

  return {
    name,
    name_new: nameNew,
    type: Number(merchant.merchant_type),
    description: merchant.category ? `${merchant.category}${merchant.district ? ` · ${merchant.district}` : ""}` : "",
    longitude: Number(merchant.longitude),
    latitude: Number(merchant.latitude),
    address: String(merchant.poi_address || "").slice(0, 128),
    address_poi_id: merchant.address_poi_id,
    status: 1,
    score: 0,
    is_verified: 1,
    logo_image: normalizeMerchantImageUrl(merchant.image || ""),
    images: merchant.image ? [normalizeMerchantImageUrl(merchant.image)] : [],
    operator_user_id: "",
    admin_ids: [],
    extra,
  };
}

module.exports = {
  MERCHANT_TYPES,
  BIZ_SPECIFIC_TYPE_NAMES,
  buildImportRecord,
  findMerchantTypeIdByName,
  importReadyIssues,
  isImportReady,
  merchantTypeNameFromId,
  resolveMerchantTypeForEnv,
  resolveMerchantTypeId,
  resolveMerchantTypeName,
  suggestMerchantType,
  suggestMerchantTypeName,
  trimDisplayName,
  trimName,
};

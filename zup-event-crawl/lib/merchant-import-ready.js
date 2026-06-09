"use strict";

/** 与测试环境 merchant-types/list 对齐的常用类型 */
const MERCHANT_TYPES = [
  { id: 1, name: "啤酒吧" },
  { id: 2, name: "酒馆" },
  { id: 3, name: "茶馆" },
  { id: 4, name: "餐厅" },
  { id: 16, name: "咖啡厅" },
  { id: 13, name: "其他" },
];

function suggestMerchantType(category, name) {
  const text = `${category || ""} ${name || ""}`;
  if (/啤酒|精酿|啤酒屋|啤酒吧/i.test(text)) return 1;
  if (/酒馆|酒吧|清吧|Taproom|COMMUNE|跳海|京A|餐吧/i.test(text)) return 2;
  if (/咖啡/i.test(text)) return 16;
  if (/茶(?!馆)|茶饮/i.test(text)) return 3;
  if (/餐|饭|食/i.test(text)) return 4;
  if (/书店|图书/i.test(text)) return 13;
  return 2;
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

  const type = Number(merchant.merchant_type || 0);
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
    logo_image: merchant.image || "",
    images: merchant.image ? [merchant.image] : [],
    operator_user_id: "",
    admin_ids: [],
    extra,
  };
}

module.exports = {
  MERCHANT_TYPES,
  buildImportRecord,
  importReadyIssues,
  isImportReady,
  suggestMerchantType,
  trimDisplayName,
  trimName,
};

"use strict";

/** 商户类型名 → Buzz now content_type（与 /api/v1/now/content/type/list 一致） */
const MERCHANT_TYPE_TO_CONTENT_TYPE = Object.freeze({
  啤酒馆: 3,
  啤酒吧: 3,
  酒吧: 3,
  酒馆: 3,
  餐厅: 1,
  茶馆: 5,
  咖啡厅: 2,
  公园: 6,
  书店: 5,
  电影演出: 9,
  桌球: 4,
  球类运动: 4,
  健身: 4,
  舞室瑜伽: 4,
  桌游棋牌: 5,
  密室: 5,
  网咖电玩: 5,
  其他: 0,
});

const DEFAULT_MERCHANT_BUBBLE_CONTENT_TYPE = 0;

function merchantTypeNameFromEnvList(typeId, envTypes) {
  const id = Number(typeId);
  if (!id || !Array.isArray(envTypes)) return "";
  const hit = envTypes.find((item) => Number(item.id) === id);
  return hit ? String(hit.name || "").trim() : "";
}

function resolveMerchantTypeNameForBubble(merchant, envTypes) {
  // 只认当前环境里的商户类型编号。分类说明里的「咖啡」「酒吧」不能改写成另一种商户类型。
  return merchantTypeNameFromEnvList(merchant?.merchant_type, envTypes);
}

function resolveMerchantBubbleContentType(merchant, envTypes) {
  const typeName = resolveMerchantTypeNameForBubble(merchant, envTypes);
  if (!typeName) return DEFAULT_MERCHANT_BUBBLE_CONTENT_TYPE;
  return MERCHANT_TYPE_TO_CONTENT_TYPE[typeName] ?? DEFAULT_MERCHANT_BUBBLE_CONTENT_TYPE;
}

module.exports = {
  DEFAULT_MERCHANT_BUBBLE_CONTENT_TYPE,
  MERCHANT_TYPE_TO_CONTENT_TYPE,
  merchantTypeNameFromEnvList,
  resolveMerchantBubbleContentType,
  resolveMerchantTypeNameForBubble,
};

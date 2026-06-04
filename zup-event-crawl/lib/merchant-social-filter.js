"use strict";

/**
 * Zup 商户收录意图：知名品牌的线下社交饮酒门店（酒馆、精酿、Taproom、餐吧等），
 * 不按品牌维护配置表，用店名 + 点评品类做通用判断。
 */
const SOCIAL_DRINK_CATEGORY = /精酿|酒吧|啤酒屋|餐吧|清吧|小酒馆|酒廊|Live\s*House|livehouse|鸡尾酒|西餐吧|啤酒花园|西式餐吧/i;
const BLOCKED_CATEGORY = /快餐|小吃|便利|超市|购物|维修|修理|美容|美发|民宿|烤串|烧烤|麻辣烫|奶茶|咖啡(?!.*酒)|酒店(?!.*餐吧)/i;

const BAR_NAME_SIGNAL = /Taproom|taproom|酒馆|精酿|啤酒屋|Brew|BREW|酒吧|清吧|小酒馆|COMMUNE|Live\s*House|啤酒花园|Goose\s*Island|鲜酿|啤酒/i;

const JUNK_NAME_SIGNAL = /快餐|美甲|租车|回收|超市|便利|维修|修理|纱窗|门窗|批发|卖场|机床|摩托车租赁|街舞|刺青|公寓$|老酒回收|酒水$/i;

function nameIncludesKeyword(name, keyword) {
  if (!keyword) return true;
  const n = String(name);
  const k = String(keyword).trim();
  if (!k) return true;
  if (n.includes(k)) return true;
  // 英文关键词大小写不敏感
  if (/[a-z]/i.test(k) && n.toLowerCase().includes(k.toLowerCase())) return true;
  return false;
}

function isSocialDrinkCategory(category) {
  const text = String(category || "");
  if (!text) return false;
  if (BLOCKED_CATEGORY.test(text)) return false;
  return SOCIAL_DRINK_CATEGORY.test(text);
}

/**
 * 判断是否为适合 Zup 收录的社交饮酒类门店。
 * @param {{ name: string, category?: string }} item
 * @param {{ searchKeyword?: string }} context 大众点评搜索词，店名应与之相关
 */
function matchesSocialVenueIntent(item, context = {}) {
  const name = item.name || "";
  const category = item.category || "";
  const searchKeyword = context.searchKeyword || "";

  if (!nameIncludesKeyword(name, searchKeyword)) {
    return { ok: false, reason: "keyword" };
  }
  if (JUNK_NAME_SIGNAL.test(name)) {
    return { ok: false, reason: "junk_name" };
  }
  if (BLOCKED_CATEGORY.test(category)) {
    return { ok: false, reason: "category_blocked" };
  }

  const looksLikeBar = BAR_NAME_SIGNAL.test(name);
  const categoryOk = isSocialDrinkCategory(category);

  if (!looksLikeBar && !categoryOk) {
    return { ok: false, reason: "not_social_venue" };
  }

  return { ok: true };
}

module.exports = {
  BAR_NAME_SIGNAL,
  BLOCKED_CATEGORY,
  JUNK_NAME_SIGNAL,
  SOCIAL_DRINK_CATEGORY,
  isSocialDrinkCategory,
  matchesSocialVenueIntent,
  nameIncludesKeyword,
};

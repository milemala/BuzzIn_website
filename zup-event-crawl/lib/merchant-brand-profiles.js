"use strict";

/**
 * 品牌抓取意图：结合店名 + 大众点评品类，只要酒馆/酒吧/Taproom 等社交饮酒类门店。
 */
const SOCIAL_DRINK_CATEGORY = /精酿|酒吧|啤酒屋|餐吧|清吧|小酒馆|酒廊|Live\s*House|livehouse|鸡尾酒|西餐吧|啤酒花园/i;
const BLOCKED_CATEGORY = /快餐|小吃|便利|超市|购物|维修|修理|美容|美发|酒店(?!.*餐吧)|民宿|烤串|烧烤|麻辣烫|奶茶|咖啡(?!.*酒)/i;

const BRAND_PROFILES = {
  跳海酒馆: {
    keyword: "跳海",
    namePattern: /跳海酒馆/,
    nameMustMatch: null,
    extraCategoryAllow: SOCIAL_DRINK_CATEGORY,
  },
  京A: {
    keyword: "京A",
    namePattern: /京A/i,
    nameMustMatch: /Taproom|精酿|啤酒|Brew|ERWING|啤酒花园/i,
    extraCategoryAllow: SOCIAL_DRINK_CATEGORY,
  },
  悠航: {
    keyword: "悠航",
    namePattern: /悠航/i,
    nameMustMatch: /悠航|Slow\s*Boat|鲜酿|啤酒/i,
    extraCategoryAllow: SOCIAL_DRINK_CATEGORY,
  },
  鹅岛: {
    keyword: "鹅岛",
    namePattern: /鹅岛|Goose/i,
    nameMustMatch: null,
    extraCategoryAllow: /啤酒|酒吧|精酿/i,
  },
  幻师: {
    keyword: "幻师",
    namePattern: /幻师|COMMUNE/i,
    nameMustMatch: null,
    extraCategoryAllow: /西餐|酒吧|餐吧|西餐吧|休闲娱乐/i,
  },
  大跃: {
    keyword: "大跃",
    namePattern: /大跃/i,
    nameMustMatch: /大跃|Leap|啤酒|精酿|Tap/i,
    extraCategoryAllow: SOCIAL_DRINK_CATEGORY,
  },
};

function getBrandProfile(label) {
  return BRAND_PROFILES[label] || null;
}

function isSocialDrinkCategory(category) {
  const text = String(category || "");
  if (!text) return false;
  if (BLOCKED_CATEGORY.test(text)) return false;
  return SOCIAL_DRINK_CATEGORY.test(text);
}

function matchesBrandIntent(item, profile) {
  if (!profile) return true;

  const name = item.name || "";
  const category = item.category || "";

  if (profile.namePattern && !profile.namePattern.test(name)) {
    return { ok: false, reason: "name_pattern" };
  }
  if (profile.nameMustMatch && !profile.nameMustMatch.test(name)) {
    return { ok: false, reason: "name_must" };
  }
  if (BLOCKED_CATEGORY.test(category)) {
    return { ok: false, reason: "category_blocked" };
  }

  const categoryOk = isSocialDrinkCategory(category)
    || (profile.extraCategoryAllow && profile.extraCategoryAllow.test(category));

  // 店名已明确是 Taproom/精酿酒吧等时，允许品类写「西餐」等
  const nameLooksLikeBar = /Taproom|精酿|啤酒|酒馆|酒吧|Brew|COMMUNE/i.test(name);
  if (!categoryOk && !nameLooksLikeBar) {
    return { ok: false, reason: "category" };
  }

  return { ok: true };
}

function buildParseOptionsFromProfile(profile) {
  if (!profile) return {};
  return {
    brandProfile: profile,
    namePattern: profile.namePattern,
  };
}

module.exports = {
  BLOCKED_CATEGORY,
  BRAND_PROFILES,
  SOCIAL_DRINK_CATEGORY,
  buildParseOptionsFromProfile,
  getBrandProfile,
  isSocialDrinkCategory,
  matchesBrandIntent,
};

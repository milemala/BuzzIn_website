"use strict";

/**
 * Zup 商户收录意图：社交饮酒类或书店/文化空间类门店。
 * 跳海/京A 有少量硬编码规则；其余搜索词按关键词 + 品类通用判断。
 */
const SOCIAL_DRINK_CATEGORY = /精酿|酒吧|啤酒屋|餐吧|清吧|小酒馆|酒廊|Live\s*House|livehouse|鸡尾酒|西餐吧|啤酒花园|西式餐吧|牛排|西餐|特色菜/i;
const CULTURE_VENUE_CATEGORY = /书店|图书|阅读|文创|杂志/i;
const BLOCKED_CATEGORY = /快餐|小吃|便利|超市|购物|维修|修理|美容|美发|民宿|烤串|烧烤|麻辣烫|奶茶|咖啡(?!.*酒)|酒店(?!.*餐吧)|游玩|海鲜|美食城|面包蛋糕|馄饨|抄手|扁食|儿童乐园|舒适型|青年旅舍|豪跑车租赁|茶饮果汁|饮品|其他分类/i;

const BAR_NAME_SIGNAL = /Taproom|taproom|酒馆|精酿|啤酒屋|Brew|BREW|酒吧|清吧|小酒馆|COMMUNE|Live\s*House|啤酒花园|Goose\s*Island|鲜酿|啤酒|跳海|京A/i;
const CULTURE_VENUE_NAME = /书店|BOOK\s*STORE|Bookstore|单向空间|茑屋|PAGEONE/i;

const BRAND_TENANT_REJECT_CATEGORY = /游玩|海鲜|美食$|美食城|面包蛋糕|馄饨|抄手|扁食|儿童乐园|舒适型|青年旅舍|豪跑车租赁|茶饮果汁|饮品|其他分类/i;

const JUNK_NAME_SIGNAL = /快餐|美甲|租车|回收|超市|便利|维修|修理|纱窗|门窗|批发|卖场|机床|摩托车租赁|街舞|刺青|公寓$|老酒回收|酒水$|取景地|美食城|游乐场|青年旅舍|旅舍|的虾|文和友|联名|云吞|馄饨|超跑|租赁|乒乓空间|^乒乓|歇业|停业|尚未开业|未开业|即将开业/i;

/** 搜索词 → 品牌直营店规则（基于审核台人工拒绝沉淀） */
const BRAND_SEARCH_RULES = {
  跳海: {
    nameStartsWith: /^跳海/i,
    rejectName: /桃小二|麦叮熊|哈啤熊|COTU|flip\s*side|哪儿$|联名|取景地|REFEEL|Answer|HEAT\(|易遥/i,
    rejectCategory: BRAND_TENANT_REJECT_CATEGORY,
  },
  京A: {
    nameStartsWith: /^京A/i,
    rejectName: /租赁|超跑|租车/i,
    rejectCategory: /豪跑车租赁|租车/i,
  },
};

function nameIncludesKeyword(name, keyword) {
  if (!keyword) return true;
  const n = String(name);
  const k = String(keyword).trim();
  if (!k) return true;
  if (n.includes(k)) return true;
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
 * 品牌搜索：必须是品牌店，不能是商场内租户、取景地、别牌精酿等。
 */
function matchesBrandSearch(item, searchKeyword) {
  const key = String(searchKeyword || "").trim();
  const rule = BRAND_SEARCH_RULES[key];
  if (!rule) return { ok: true };

  const name = item.name || "";
  const category = item.category || "";

  if (rule.rejectName && rule.rejectName.test(name)) {
    return { ok: false, reason: "brand_reject_name" };
  }
  if (rule.rejectCategory && rule.rejectCategory.test(category)) {
    return { ok: false, reason: "brand_reject_category" };
  }

  // 「xxx(品牌店)」类租户：品牌词在店名里但不在开头
  const brandInName = nameIncludesKeyword(name, key);
  if (brandInName && rule.nameStartsWith && !rule.nameStartsWith.test(name)) {
    return { ok: false, reason: "not_brand_store" };
  }

  if (rule.nameStartsWith && !rule.nameStartsWith.test(name)) {
    return { ok: false, reason: "not_brand_store" };
  }

  return { ok: true };
}

/**
 * 判断是否为适合 Zup 收录的社交饮酒类门店。
 */
function matchesSocialVenueIntent(item, context = {}) {
  const name = item.name || "";
  const category = item.category || "";
  const searchKeyword = context.searchKeyword || "";

  const brand = matchesBrandSearch(item, searchKeyword);
  if (!brand.ok) return brand;

  // 非品牌表任务仍可按关键词收紧；品牌搜索已在 matchesBrandSearch 处理店名
  const isBrandSearch = Boolean(BRAND_SEARCH_RULES[searchKeyword]);
  if (!isBrandSearch && searchKeyword && !nameIncludesKeyword(name, searchKeyword)) {
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
  const looksLikeCulture = CULTURE_VENUE_NAME.test(name);
  const cultureCategoryOk = CULTURE_VENUE_CATEGORY.test(category);

  if (!looksLikeBar && !categoryOk && !looksLikeCulture && !cultureCategoryOk) {
    return { ok: false, reason: "not_social_venue" };
  }

  return { ok: true };
}

module.exports = {
  BAR_NAME_SIGNAL,
  BLOCKED_CATEGORY,
  BRAND_SEARCH_RULES,
  JUNK_NAME_SIGNAL,
  SOCIAL_DRINK_CATEGORY,
  isSocialDrinkCategory,
  matchesBrandSearch,
  matchesSocialVenueIntent,
  nameIncludesKeyword,
};

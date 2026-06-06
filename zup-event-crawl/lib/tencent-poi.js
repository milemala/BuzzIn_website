"use strict";

/**
 * 腾讯位置服务 WebService — 关键词 POI 搜索（GCJ-02）
 * 文档：https://lbs.qq.com/service/webService/webServiceGuide/webServiceSearch
 * Key：环境变量 BUZZ_TENCENT_MAP_KEY，未设置时用与 import/query 同源的内置 key（消耗共用配额）。
 */
const DEFAULT_MAP_KEY = "KRABZ-SFJCW-YTZRK-YP25X-2EFC6-ZBFCY";

function resolveMapKey() {
  return process.env.BUZZ_TENCENT_MAP_KEY || DEFAULT_MAP_KEY;
}

/**
 * 与 Zup 后台 POI 搜索一致：「城市 + 店名」。
 * 不把点评「商圈」拼进关键词——商圈经常是商场/地标名（如新世界百货），
 * 会把腾讯结果带偏；店名里已有分店信息（如亳都新象店）时足够精确。
 */
function stripBranchSuffix(name) {
  return String(name || "").replace(/[（(][^）)]*[）)]\s*$/u, "").trim();
}

function buildPoiKeyword(name, city) {
  const n = String(name || "").trim();
  const c = String(city || "").trim();
  if (!n) return c;
  if (!c || c === "全国") return n;
  if (n.includes(c)) return n;
  return `${c} ${n}`;
}

/** Top1 标题是否与店名同一商户（避免「黑犬酒吧(白沙古井店)」搜成地标「白沙古井」） */
function poiTitleMatchesMerchant(merchantName, poiTitle) {
  const brand = stripBranchSuffix(merchantName).replace(/\s+/g, "");
  const title = String(poiTitle || "").replace(/\s+/g, "");
  if (!brand || !title) return false;
  if (title.includes(brand) || brand.includes(title)) return true;
  for (let len = Math.min(brand.length, 6); len >= 2; len -= 1) {
    const slice = brand.slice(0, len);
    if (/^[\u4e00-\u9fa5a-zA-Z0-9]+$/u.test(slice) && title.includes(slice)) {
      return true;
    }
  }
  return false;
}

/**
 * 按商户店名搜索 POI：先全名，Top1 不像同店则去掉括号分店名重搜，并在候选里优先选名称匹配的。
 */
async function searchPoiForMerchant(name, city, opts = {}) {
  const cityName = String(city || "全国").trim() || "全国";
  const fullKeyword = buildPoiKeyword(name, cityName);
  const primary = await searchPoi({ ...opts, keyword: fullKeyword, city: cityName });

  if (primary.items.length && poiTitleMatchesMerchant(name, primary.items[0].title)) {
    return { keyword: fullKeyword, ...primary };
  }

  const shortName = stripBranchSuffix(name);
  if (shortName && shortName !== String(name || "").trim()) {
    const shortKeyword = buildPoiKeyword(shortName, cityName);
    if (shortKeyword !== fullKeyword) {
      const fallback = await searchPoi({ ...opts, keyword: shortKeyword, city: cityName });
      if (fallback.items.length) {
        return { keyword: shortKeyword, ...fallback };
      }
    }
  }

  const matched = primary.items.find((item) => poiTitleMatchesMerchant(name, item.title));
  if (matched) {
    return {
      keyword: fullKeyword,
      count: primary.count,
      items: [matched, ...primary.items.filter((item) => item !== matched)],
    };
  }

  return { keyword: fullKeyword, ...primary };
}

/**
 * @param {{ keyword: string, city?: string, pageSize?: number, pageIndex?: number }} opts
 */
async function searchPoi(opts) {
  const keyword = String(opts.keyword || "").trim();
  if (!keyword) {
    return { count: 0, items: [] };
  }
  const city = String(opts.city || "全国").trim() || "全国";
  const pageSize = Math.min(Math.max(Number(opts.pageSize) || 10, 1), 20);
  const pageIndex = Math.max(Number(opts.pageIndex) || 1, 1);

  const params = new URLSearchParams({
    key: resolveMapKey(),
    keyword,
    boundary: `region(${city},1)`,
    page_size: String(pageSize),
    page_index: String(pageIndex),
  });

  const response = await fetch(`https://apis.map.qq.com/ws/place/v1/search?${params}`);
  const raw = await response.json();
  if (raw.status !== 0) {
    const err = new Error(raw.message || `腾讯地图 status=${raw.status}`);
    err.tencentStatus = raw.status;
    throw err;
  }

  const items = (raw.data || []).map((p) => ({
    poi_id: p.id,
    title: p.title || "",
    address: p.address || "",
    category: p.category || "",
    tel: p.tel || "",
    latitude: p.location?.lat ?? null,
    longitude: p.location?.lng ?? null,
  }));

  return { count: raw.count ?? items.length, items };
}

module.exports = {
  buildPoiKeyword,
  poiTitleMatchesMerchant,
  resolveMapKey,
  searchPoi,
  searchPoiForMerchant,
  stripBranchSuffix,
};

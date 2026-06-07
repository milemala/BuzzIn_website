"use strict";

/**
 * 腾讯位置服务 WebService — 关键词 POI 搜索（GCJ-02）
 * 文档：https://lbs.qq.com/service/webService/webServiceGuide/webServiceSearch
 *
 * Key 策略（可用 BUZZ_TENCENT_MAP_KEY 强制指定单一 key）：
 * 1. 个人号 ROMBZ-...（优先，省公司配额）
 * 2. 个人号日限额用尽 → 自动切公司号 KRABZ-...（与 Zup 前端同源）
 */
const PERSONAL_MAP_KEY = "ROMBZ-NP6RA-UD2K3-CVWY6-7CF6Q-J7BOX";
const COMPANY_MAP_KEY = "KRABZ-SFJCW-YTZRK-YP25X-2EFC6-ZBFCY";

const QUOTA_STATUS_CODES = new Set([120, 121]);

/** @type {boolean} 本进程内个人 key 已不可用（配额用尽或鉴权失败），后续直接用公司 key */
let personalKeySkipped = false;

function isQuotaExceeded(status, message) {
  if (QUOTA_STATUS_CODES.has(status)) return true;
  const msg = String(message || "");
  return /调用量|上限|配额|quota/i.test(msg);
}

/** 个人 key 失败时是否应切换公司 key（日配额 / 签名或鉴权失败等） */
function shouldFallbackFromPersonal(status, message) {
  if (isQuotaExceeded(status, message)) return "quota";
  if (status === 110 || status === 111) return "auth";
  return null;
}

function resolveMapKeyChain() {
  const override = process.env.BUZZ_TENCENT_MAP_KEY;
  if (override) return [override];
  if (personalKeySkipped) return [COMPANY_MAP_KEY];
  return [PERSONAL_MAP_KEY, COMPANY_MAP_KEY];
}

function resolveMapKey() {
  return resolveMapKeyChain()[0];
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

async function requestTencentPlaceSearch(params) {
  const keys = resolveMapKeyChain();
  let lastError = null;

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    params.set("key", key);
    const response = await fetch(`https://apis.map.qq.com/ws/place/v1/search?${params}`);
    const raw = await response.json();

    if (raw.status === 0) {
      return { raw, mapKey: key };
    }

    const fallbackReason = shouldFallbackFromPersonal(raw.status, raw.message);
    if (fallbackReason && key === PERSONAL_MAP_KEY && i + 1 < keys.length) {
      personalKeySkipped = true;
      const hint = fallbackReason === "quota"
        ? "日配额已满"
        : "不可用（可能需在腾讯控制台关闭 SK 签名校验或配置 WebService 白名单）";
      console.warn(`[tencent-poi] 个人 key ${hint}，切换公司 key: ${raw.message}`);
      continue;
    }

    const err = new Error(raw.message || `腾讯地图 status=${raw.status}`);
    err.tencentStatus = raw.status;
    lastError = err;
    break;
  }

  throw lastError || new Error("腾讯地图请求失败");
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
    keyword,
    boundary: `region(${city},1)`,
    page_size: String(pageSize),
    page_index: String(pageIndex),
  });

  const { raw } = await requestTencentPlaceSearch(params);

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
  COMPANY_MAP_KEY,
  PERSONAL_MAP_KEY,
  poiTitleMatchesMerchant,
  resolveMapKey,
  resolveMapKeyChain,
  searchPoi,
  searchPoiForMerchant,
  stripBranchSuffix,
};

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

/** 明显不是目标场所的 POI（停车场、地铁口等），除非查询词里就含有 */
const POI_NOISE_TITLE = /停车场|停车区|地下车库|地铁站|公交站|公交总站|卫生间|洗手间|厕所|公厕|座椅|寄存处|售票处|出入口|地下停车场/;

function normalizeMatchText(text) {
  return String(text || "").replace(/\s+/g, "").toLowerCase();
}

function tokenizeForMatch(text) {
  const raw = String(text || "");
  const tokens = new Set();
  for (const match of raw.matchAll(/[\u4e00-\u9fa5]{2,}/gu)) tokens.add(match[0]);
  for (const match of raw.matchAll(/[a-zA-Z0-9]{2,}/g)) tokens.add(match[0]);
  return [...tokens];
}

/**
 * 对单个 POI 候选打分：查询词与 title/address 越像分越高。
 * @param {string} query
 * @param {object} poi
 * @param {string[]} [extraQueries]
 */
function scorePoiCandidate(query, poi, extraQueries = []) {
  const queries = [query, ...extraQueries]
    .map((q) => String(q || "").trim())
    .filter(Boolean);
  if (!queries.length) return 0;

  const title = String(poi.title || "");
  const address = String(poi.address || "");
  const category = String(poi.category || "");
  const queryText = queries.join(" ");
  let score = 0;

  for (const q of queries) {
    const nq = normalizeMatchText(q);
    const nt = normalizeMatchText(title);
    const na = normalizeMatchText(address);

    if (nt && nq) {
      if (nt === nq) score += 120;
      else if (nt.includes(nq) || nq.includes(nt)) score += 90;
      else if (poiTitleMatchesMerchant(q, title)) score += 75;
    }

    if (na && nq && (na.includes(nq) || nq.includes(na))) score += 25;

    for (const token of tokenizeForMatch(q)) {
      const nt = normalizeMatchText(token);
      if (nt.length < 2) continue;
      if (normalizeMatchText(title).includes(nt)) score += 12;
      if (normalizeMatchText(address).includes(nt)) score += 6;
    }
  }

  if (POI_NOISE_TITLE.test(title) && !POI_NOISE_TITLE.test(queryText)) score -= 55;
  if (/剧|酒吧|咖啡|餐|店|馆|厅|中心|书院|艺术|脱口秀|剧场/i.test(queryText)
    && /剧|酒吧|咖啡|餐|店|馆|厅|中心|艺术|脱口秀|剧场/i.test(`${category} ${title}`)) {
    score += 10;
  }

  if (Number.isFinite(poi._rank)) score -= poi._rank * 0.4;
  return score;
}

function pickBestPoiCandidate(query, items, extraQueries = []) {
  if (!items?.length) return { poi: null, score: 0 };
  let best = items[0];
  let bestScore = -Infinity;
  for (let i = 0; i < items.length; i += 1) {
    const score = scorePoiCandidate(query, { ...items[i], _rank: i }, extraQueries);
    if (score > bestScore) {
      bestScore = score;
      best = items[i];
    }
  }
  return { poi: best, score: bestScore };
}

function reorderPoiByBestMatch(query, items, extraQueries = []) {
  if (!items?.length) return [];
  return [...items]
    .map((item, i) => ({
      item,
      score: scorePoiCandidate(query, { ...item, _rank: i }, extraQueries),
    }))
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}

function extractVenueHints(location, title) {
  const hints = [];
  const seen = new Set();
  const add = (text) => {
    const t = String(text || "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    hints.push(t);
  };

  if (title) add(title);
  const loc = String(location || "");
  for (const seg of loc.split(/[\s,，|/]+/)) {
    const clean = seg.replace(/[-—–].*$/, "").trim();
    if (!clean || /^\d/.test(clean)) continue;
    if (/^(北京|上海|广州|深圳|成都|杭州|武汉|西安|南京|重庆|天津|苏州|长沙|郑州|东莞|青岛|沈阳|宁波|昆明)/.test(clean)) continue;
    if (/^(朝阳|海淀|浦东|黄浦|徐汇|静安|长宁|杨浦|虹口|普陀|闵行|宝山|嘉定|松江|青浦|奉贤|崇明|天河|越秀|海珠|荔湾|白云|番禺|武侯|锦江|青羊|成华|高新)/.test(clean)) continue;
    if (/[\u4e00-\u9fa5]{2,}(馆|店|厅|中心|剧场|剧院|酒吧|咖啡|书院|演艺|会所|世界|Livehouse|livehouse|Club|club|吧)$/u.test(clean)
      || /(美术馆|博物馆|艺术馆|展览馆|脱口秀|相声|话剧|音乐厅|演艺|影城|电影院|咖啡馆|咖啡厅|精酿|餐吧|小剧场)/u.test(clean)) {
      add(clean);
    }
  }
  return hints;
}

function pickBestPoiForEvent(event, items) {
  const location = String(event?.location || "").trim();
  const title = String(event?.title || "").trim();
  const primary = location || title;
  const extras = extractVenueHints(location, title).filter((hint) => hint !== primary);
  return pickBestPoiCandidate(primary, items, extras);
}

function pickBestPoiForMerchant(name, items) {
  const full = String(name || "").trim();
  const short = stripBranchSuffix(full);
  const extras = short && short !== full ? [short] : [];
  return pickBestPoiCandidate(full, items, extras);
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
/** 按活动地点文本搜索 POI，并按相似度重排候选（豆瓣 location 字段） */
async function searchPoiForEvent(location, city, opts = {}) {
  const cityName = String(city || "全国").trim() || "全国";
  const loc = String(location || "").trim();
  const title = String(opts.title || "").trim();
  if (!loc && !title) {
    return { keyword: cityName, count: 0, items: [] };
  }
  const keyword = buildPoiKeyword(loc || title, cityName);
  const result = await searchPoi({ ...opts, keyword, city: cityName });
  const extras = extractVenueHints(loc, title).filter((hint) => hint !== (loc || title));
  const items = reorderPoiByBestMatch(loc || title, result.items, extras);
  return { keyword, count: result.count, items };
}

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

  const extras = shortName && shortName !== String(name || "").trim() ? [shortName] : [];
  const items = reorderPoiByBestMatch(name, primary.items, extras);
  return { keyword: fullKeyword, count: primary.count, items };
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
  pickBestPoiCandidate,
  pickBestPoiForEvent,
  pickBestPoiForMerchant,
  poiTitleMatchesMerchant,
  reorderPoiByBestMatch,
  resolveMapKey,
  resolveMapKeyChain,
  scorePoiCandidate,
  searchPoi,
  searchPoiForEvent,
  searchPoiForMerchant,
  stripBranchSuffix,
};

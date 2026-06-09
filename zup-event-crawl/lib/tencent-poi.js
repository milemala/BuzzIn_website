"use strict";

/**
 * 腾讯位置服务 WebService — 关键词 POI 搜索（GCJ-02）
 * 文档：https://lbs.qq.com/service/webService/webServiceGuide/webServiceSearch
 *
 * Key 策略（可用 BUZZ_TENCENT_MAP_KEY 强制指定，多个 key 用英文逗号分隔）：
 * 1. 个人号 keys（按 PERSONAL_MAP_KEYS 顺序，优先消耗个人配额）
 * 2. 个人号日限额用尽 → 自动切下一个个人号，全部用尽后再切企业号
 */
/** @type {{ key: string, owner: string }[]} 个人号，按顺序消耗 */
const PERSONAL_MAP_KEY_ENTRIES = [
  { key: "XH4BZ-FAMCB-3YWU7-JB6O2-33QAV-DIFWM", owner: "荣志" },
  { key: "RBABZ-YRA6A-76UK3-CQAJJ-RXMXV-YJBT7", owner: "帽" },
  { key: "D5YBZ-OIYCU-7N2VO-GYHXJ-NUKLS-HXFSF", owner: "东东" },
  { key: "ROMBZ-NP6RA-UD2K3-CVWY6-7CF6Q-J7BOX", owner: "明" },
  { key: "YBNBZ-UEUCQ-42N5S-B5SHE-QN477-NMBME", owner: "英子" },
];

const PERSONAL_MAP_KEYS = PERSONAL_MAP_KEY_ENTRIES.map((entry) => entry.key);

/** 企业号（个人号都耗尽后使用） */
const COMPANY_MAP_KEY = "KRABZ-SFJCW-YTZRK-YP25X-2EFC6-ZBFCY";

const MAP_KEY_OWNER = Object.fromEntries([
  ...PERSONAL_MAP_KEY_ENTRIES.map(({ key, owner }) => [key, owner]),
  [COMPANY_MAP_KEY, "企业号"],
]);

function formatMapKeyLabel(key) {
  const owner = MAP_KEY_OWNER[key];
  const short = `${String(key || "").slice(0, 8)}…`;
  return owner ? `${owner} ${short}` : short;
}

const QUOTA_STATUS_CODES = new Set([120, 121]);

/** @type {Set<string>} 本进程内已确认日配额用尽的 key（按 key 单独记录，不误伤其他个人号） */
const exhaustedMapKeys = new Set();

function isPersonalMapKey(key) {
  return PERSONAL_MAP_KEYS.includes(key);
}

function isCompanyMapKey(key) {
  return key === COMPANY_MAP_KEY;
}

function isQuotaExceeded(status, message) {
  if (QUOTA_STATUS_CODES.has(status)) return true;
  const msg = String(message || "");
  return /调用量|上限|配额|quota/i.test(msg);
}

/** 个人 key 失败时是否应切换下一个 key（日配额 / 签名或鉴权失败等） */
function shouldFallbackFromPersonal(status, message) {
  if (isQuotaExceeded(status, message)) return "quota";
  if (status === 110 || status === 111) return "auth";
  return null;
}

function resolveMapKeyChain() {
  const override = process.env.BUZZ_TENCENT_MAP_KEY;
  if (override) {
    return override.split(",").map((key) => key.trim()).filter(Boolean);
  }
  const personal = PERSONAL_MAP_KEYS.filter((key) => !exhaustedMapKeys.has(key));
  const company = exhaustedMapKeys.has(COMPANY_MAP_KEY) ? [] : [COMPANY_MAP_KEY];
  return [...personal, ...company];
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

/** 去掉分店后缀后归一化品牌名（SpicyComedy-XX店 与 SpicyComedy(XX店) 视为同一品牌） */
function normalizeVenueBrand(name) {
  return String(name || "")
    .replace(/[（(][^）)]*[）)]/gu, "")
    .replace(/[-—–][^-\s]+$/u, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function buildPoiKeyword(name, city) {
  const n = String(name || "").trim();
  const c = String(city || "").trim();
  if (!n) return c;
  if (!c || c === "全国") return n;
  if (n.includes(c)) return n;
  return `${c} ${n}`;
}

const KNOWN_CITIES = /^(北京|上海|广州|深圳|成都|杭州|武汉|西安|南京|重庆|天津|苏州|长沙|郑州|东莞|青岛|沈阳|宁波|昆明|佛山|无锡|合肥|大连|厦门|哈尔滨|长春|石家庄|温州|珠海|惠州|中山|嘉兴|金华|绍兴|泉州|南昌|济南|常州|徐州|南通|扬州|唐山|保定|洛阳|襄阳|宜昌|桂林|三亚|丽江|大庆|鞍山|吉林|秦皇岛|邯郸|乌鲁木齐|呼和浩特|南宁|海口|兰州|银川|西宁|拉萨|贵阳|南昌|福州|厦门|烟台|潍坊|镇江|株洲|湘潭|衡阳|湛江|柳州|绵阳|德阳|南充|宜宾|遵义|拉萨|银川|西宁|乌鲁木齐|呼和浩特|拉萨)$/;

/**
 * 解析豆瓣 location：城市、区划、地点名称、具体地址（空格分隔）
 * 例：成都 锦江区 四川省川剧院 指挥街108号
 */
function parseDoubanLocation(location, city = "") {
  const full = String(location || "").trim();
  if (!full) {
    return { city: String(city || "").trim(), district: "", venue: "", address: "", full: "" };
  }

  const parts = full.split(/\s+/).filter(Boolean);
  let idx = 0;
  let parsedCity = String(city || "").trim().replace(/市$/, "");

  const first = parts[idx] || "";
  const firstBare = first.replace(/市$/, "");
  if (first && (
    (parsedCity && firstBare === parsedCity)
    || (!parsedCity && KNOWN_CITIES.test(firstBare))
    || (KNOWN_CITIES.test(firstBare) && !/区|县|旗/.test(first))
  )) {
    parsedCity = firstBare;
    idx += 1;
  }

  let district = "";
  if (parts[idx] && /(区|县|旗|新区)$/.test(parts[idx])) {
    district = parts[idx];
    idx += 1;
  }

  const rest = parts.slice(idx);
  let venue = "";
  let address = "";
  const addressStart = rest.findIndex((p) => isStreetLevelAddress(p));

  if (rest.length === 0) {
    // no-op
  } else if (addressStart === -1) {
    if (rest.length === 1) {
      if (isStreetLevelAddress(rest[0])) address = rest[0];
      else venue = rest[0];
    } else {
      venue = rest.slice(0, -1).join(" ");
      address = rest[rest.length - 1];
    }
  } else if (addressStart === 0) {
    address = rest.join(" ");
  } else {
    venue = rest.slice(0, addressStart).join(" ");
    address = rest.slice(addressStart).join(" ");
  }

  return { city: parsedCity, district, venue, address, full };
}

/** 按豆瓣地址规律生成 POI 搜索词（优先 城市+地点名，其次 城市+门牌，最后全量） */
function buildEventPoiSearchKeywords(location, city, opts = {}) {
  const parsed = parseDoubanLocation(location, city);
  const cityName = parsed.city || String(city || "").trim() || "全国";
  const title = String(opts.title || "").trim();
  const keywords = [];
  const seen = new Set();
  const add = (name) => {
    const part = String(name || "").trim();
    if (!part) return;
    const kw = buildPoiKeyword(part, cityName);
    if (!kw || seen.has(kw)) return;
    seen.add(kw);
    keywords.push(kw);
  };

  if (parsed.venue) add(parsed.venue);
  if (parsed.address && normalizeMatchText(parsed.address) !== normalizeMatchText(parsed.venue)) {
    add(parsed.address);
  }
  if (parsed.district && parsed.venue) add(`${parsed.district} ${parsed.venue}`);
  if (parsed.full) add(parsed.full);
  if (title && !parsed.full.includes(title)) add(title);

  if (!keywords.length) add(location || title);
  return keywords;
}

function suggestEventPoiKeyword(location, city, title = "") {
  const keywords = buildEventPoiSearchKeywords(location, city, { title });
  return keywords[0] || buildPoiKeyword(location, city);
}

function mergePoiById(existing, incoming) {
  const map = new Map();
  for (const item of [...existing, ...incoming]) {
    if (!item?.poi_id) continue;
    if (!map.has(item.poi_id)) map.set(item.poi_id, item);
  }
  return [...map.values()];
}

/** 明显不是目标场所的 POI（停车场、地铁口等），除非查询词里就含有 */
const POI_NOISE_TITLE = /停车场|停车区|地下车库|地铁站|公交站|公交总站|卫生间|洗手间|厕所|公厕|座椅|寄存处|售票处|出入口|地下停车场/;

/** 小区门牌/道路等，酒吧搜索时常见误匹配 */
const POI_BAD_VENUE_TITLE = /(?:新村|公寓|小区|花园|大厦|宾馆|旅馆|便利店|东南门|西南门|西北门|东北门|交叉口|方向\d+米左右)$|^(?:彩虹|都市|红星)(?:路|新村|苑)/;

/** 店名在找酒吧，POI 却是其他业态 */
const POI_WRONG_BUSINESS_TITLE = /剧本杀|家居|科技|有限公司|便利店|银行|支行|理发|台球|棋牌|幼儿园|旅馆|宾馆|购物中心|写字楼/;

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

/** 是否为门牌级地址（可用于结果比对）；仅城市/区划则返回 false */
function isStreetLevelAddress(text) {
  const sample = String(text || "").trim();
  if (!sample) return false;
  return /(路|街|道|巷|弄|大道|\d+号|号铺|号楼|层|座|栋|大厦|工业区|广场.{0,6}\d|铺位|铺)/.test(sample);
}

/** 从清单门牌地址提取可用于 POI 结果比对的片段（不参与搜索关键词） */
function extractAddressHints(referenceAddress) {
  const text = String(referenceAddress || "").trim();
  if (!isStreetLevelAddress(text)) return [];

  const hints = [];
  const seen = new Set();
  const add = (value) => {
    const v = String(value || "").trim();
    if (!v || v.length < 2 || seen.has(v)) return;
    seen.add(v);
    hints.push(v);
  };

  for (const match of text.matchAll(/([\u4e00-\u9fa5A-Za-z0-9]{2,}(?:路|街|道|巷|弄|大道|工业区|大厦|广场))/gu)) {
    add(match[1]);
    const roadOnly = match[1].replace(/^[\u4e00-\u9fa5]{2,8}(?:新区|区|县|镇|市)?/, "");
    if (roadOnly.length >= 2) add(roadOnly);
  }
  for (const match of text.matchAll(/(\d+号)/gu)) add(match[1]);
  for (const match of text.matchAll(/([\u4e00-\u9fa5A-Za-z0-9]{2,}铺)/gu)) add(match[1]);

  return hints.slice(0, 10);
}

/** 点评地址与 POI 地址是否大致一致（路名、门牌等） */
function addressesRoughlyAlign(sourceAddress, poiAddress) {
  const src = normalizeMatchText(sourceAddress);
  const poi = normalizeMatchText(poiAddress);
  if (!src || !poi) return false;
  if (src === poi || poi.includes(src) || src.includes(poi)) return true;

  const hints = extractAddressHints(sourceAddress);
  if (hints.some((hint) => poi.includes(normalizeMatchText(hint)))) return true;

  const roadMatch = String(sourceAddress).match(/([\u4e00-\u9fa5]{1,10}(?:路|街|道|巷|弄|大道))/);
  const numMatch = String(sourceAddress).match(/(\d+号)/);
  if (roadMatch && poi.includes(normalizeMatchText(roadMatch[1]))) {
    if (!numMatch || poi.includes(normalizeMatchText(numMatch[1]))) return true;
  }
  return false;
}

const GENERIC_ENGLISH_SEARCH_TOKENS = new Set([
  "bar", "bars", "cafe", "coffee", "pub", "club", "live", "lounge", "bistro",
  "cocktail", "cocktails", "whisky", "whiskey", "wine", "wines", "beer", "beers",
  "taproom", "homebar", "shisha", "hookah", "the", "and", "room", "land",
  "drink", "drinks", "house", "shop", "store", "lab", "studio", "kitchen",
  "winebar", "cocktailbar", "whiskybar", "beerpark", "精酿", "餐", "酒",
]);

const GENERIC_CHINESE_SEARCH_TERMS = new Set([
  "酒吧", "酒馆", "餐吧", "咖啡厅", "咖啡", "小酒馆", "鸡尾酒吧", "鸡尾酒",
  "精酿啤酒", "精酿", "啤酒吧", "啤酒屋", "啤酒", "威士忌", "威士忌吧",
  "水烟", "水烟吧", "烟馆", "清吧", "餐酒吧", "啤酒馆", "livehouse",
  "德扑", "德扑馆", "德扑酒馆", "扑馆", "homebar",
]);

const GENERIC_CHINESE_SUFFIX_RE = /(?:鸡尾酒吧|精酿啤酒吧|精酿啤酒|威士忌酒吧|啤酒屋|啤酒吧|威士忌吧|小酒馆|鸡尾酒|威士忌|水烟吧|水烟|啤酒|酒吧|酒馆|餐吧|咖啡厅|咖啡|清吧)$/u;

function isGenericSearchToken(token) {
  const text = String(token || "").trim();
  if (!text || text.length < 2) return true;
  const lower = text.toLowerCase();
  if (GENERIC_ENGLISH_SEARCH_TOKENS.has(lower)) return true;
  if (GENERIC_CHINESE_SEARCH_TERMS.has(text)) return true;
  if (GENERIC_CHINESE_SUFFIX_RE.test(text)) {
    const stripped = text.replace(GENERIC_CHINESE_SUFFIX_RE, "").trim();
    if (stripped.length < 2) return true;
  }
  return false;
}

function isWeakMerchantSearchToken(token, merchantName = "") {
  const text = String(token || "").trim();
  if (!text || isGenericSearchToken(text)) return true;
  if (/[&,，/\\]/u.test(text)) return true;
  const latinHead = text.match(/^([A-Za-z]+)/)?.[1] || "";
  if (latinHead && isGenericSearchToken(latinHead) && /[\u4e00-\u9fa5]/.test(text)) return true;
  if (/^(?:水烟|精酿|鸡尾酒|啤酒|威士忌|德扑)/u.test(text)) return true;
  const fullNorm = normalizeBrandCompare(stripBranchSuffix(merchantName));
  const tokenNorm = normalizeBrandCompare(text);
  if (/^\d{2,}$/.test(text) && fullNorm.length > tokenNorm.length && fullNorm.startsWith(tokenNorm)) {
    return true;
  }
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(text) && fullNorm.length > tokenNorm.length + 2
    && fullNorm.includes(tokenNorm) && extractDistinctiveLatinBrands(merchantName).length) {
    return true;
  }
  return false;
}

/** 店名里可区分的英文品牌（Nightingale、Rainbow 等，排除 homebar 等大词） */
function extractDistinctiveLatinBrands(name) {
  const brands = new Set();
  for (const match of String(stripBranchSuffix(name)).matchAll(/[A-Za-z][A-Za-z0-9]{4,}/g)) {
    const word = match[0].toLowerCase();
    if (!isGenericSearchToken(word)) brands.add(word);
  }
  return [...brands];
}

/** 店名以「数字+Homebar」为品牌核心（如 707·Homebar），非长店名里顺带出现的 Home bar */
function merchantHasDigitHomebarBrand(name) {
  const sig = normalizeBrandCompare(stripBranchSuffix(name));
  return /^\d{2,}homebar/.test(sig);
}

/** 过滤「仅数字/仅中文泛词」造成的假匹配 */
function poiTitlePassesBrandGuards(merchantName, poiTitle) {
  const latinBrands = extractDistinctiveLatinBrands(merchantName);
  if (latinBrands.length) {
    const poiNorm = normalizeMatchText(poiTitle);
    if (!latinBrands.some((brand) => poiNorm.includes(brand))) return false;
  }

  if (merchantHasDigitHomebarBrand(merchantName)) {
    const poiSig = normalizeBrandCompare(stripBranchSuffix(poiTitle));
    if (!poiSig.includes("homebar")) return false;
  }

  const mSig = normalizeBrandCompare(stripBranchSuffix(merchantName));
  const pSig = normalizeBrandCompare(stripBranchSuffix(poiTitle));
  const mNum = mSig.match(/^(\d{2,})/)?.[1];
  const pNum = pSig.match(/^(\d{2,})/)?.[1];
  if (mNum && mNum === pNum && mSig.includes("homebar") && !pSig.includes("homebar")) {
    return false;
  }

  const barLike = /bar|酒吧|酒|咖啡|homebar|日咖夜酒/i.test(merchantName)
    || latinBrands.length > 0;
  if (barLike && (POI_BAD_VENUE_TITLE.test(poiTitle) || POI_WRONG_BUSINESS_TITLE.test(poiTitle))) {
    return false;
  }

  if (merchantHasDigitHomebarBrand(merchantName) && isMallLikePoiTitle(poiTitle)) {
    return false;
  }

  return true;
}

function normalizeBrandCompare(text) {
  return normalizeMatchText(text).replace(/[·•・\-—–_.\s&｜|/\\]+/g, "");
}

/** 店名/POI 标题比对用：去分店、去·、繁转简、去酒吧酒馆等大词 */
function tradToSimplified(text) {
  const pairs = [
    ["無", "无"], ["樂", "乐"], ["館", "馆"], ["臺", "台"], ["國", "国"],
    ["廣", "广"], ["貓", "猫"], ["體", "体"], ["與", "与"], ["園", "园"],
    ["號", "号"], ["庫", "库"], ["廢", "废"], ["視", "视"], ["聽", "听"],
    ["開", "开"], ["門", "门"], ["陽", "阳"], ["書", "书"], ["東", "东"],
    ["車", "车"], ["電", "电"], ["萬", "万"], ["華", "华"], ["鄉", "乡"],
    ["藝", "艺"], ["龍", "龙"], ["馬", "马"], ["鳥", "鸟"], ["魚", "鱼"],
    ["歡", "欢"], ["來", "来"], ["見", "见"], ["長", "长"], ["風", "风"],
    ["時", "时"], ["間", "间"],
  ];
  let s = String(text || "");
  for (const [trad, simp] of pairs) s = s.split(trad).join(simp);
  return s;
}

/** 店名里常见的异体字/谐音字（腾讯 POI 与点评写法不一致） */
function applyVenueCharVariants(text) {
  return String(text || "")
    .replace(/镚/g, "蹦")
    .replace(/廢/g, "废")
    .replace(/號/g, "号")
    .replace(/庫/g, "库");
}

function normalizeMerchantPoiTitle(text) {
  const stripped = stripGenericVenueSuffix(stripBranchSuffix(text));
  return normalizeBrandCompare(tradToSimplified(applyVenueCharVariants(stripped)));
}

/** 中文品牌片段是否算对上（2 字要求贴合词头/词尾，避免「氧气」撞上「氧气厂」） */
function hanBrandTokensMatch(a, b) {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length < 2) return false;
  if (short.length >= 3 && long.includes(short)) return true;
  if (short.length === 2 && /^[\u4e00-\u9fa5]+$/.test(short)
    && (long.startsWith(short) || long.endsWith(short))) {
    return true;
  }
  return false;
}

/** 按 · 等分段后的品牌名（如「旅者的驿站·露台酒吧·…」） */
function extractMerchantNameSegments(text) {
  const raw = stripBranchSuffix(text);
  const pieces = raw.split(/[·•・|｜/]+/).map((s) => s.trim()).filter(Boolean);
  if (pieces.length <= 1) return pieces;
  const segments = [];
  for (const piece of pieces) {
    const cleaned = stripGenericVenueSuffix(piece).trim();
    if (cleaned.length >= 2 && !isGenericSearchToken(cleaned)) segments.push(cleaned);
  }
  return segments.length ? segments : pieces;
}

/** 分段店名与 POI 标题是否对得上（POI 常把分店写进标题且无括号） */
function merchantNameSegmentsMatch(merchantName, poiTitle) {
  const mSegs = extractMerchantNameSegments(merchantName)
    .map((s) => normalizeMerchantPoiTitle(s))
    .filter(Boolean);
  if (!mSegs.length) return false;

  const pSegs = extractMerchantNameSegments(poiTitle)
    .map((s) => normalizeMerchantPoiTitle(s))
    .filter(Boolean);
  const pWhole = normalizeMerchantPoiTitle(poiTitle);
  const poiCandidates = [...new Set([...pSegs, pWhole].filter(Boolean))];

  return mSegs.some((a) => poiCandidates.some((b) => {
    if (a === b) return true;
    if (a.length >= 3 && b.includes(a)) return true;
    if (b.length >= 3 && a.includes(b)) return true;
    return hanBrandTokensMatch(a, b);
  }));
}

function latinBrandBonus(term) {
  let bonus = 0;
  if (/[A-Za-z]/.test(term) && /\d/.test(term)) bonus += 28;
  else if (/^[A-Za-z0-9]{4,}$/.test(term)) bonus += 12;
  return bonus;
}

function stripGenericVenueSuffix(text) {
  return String(text || "")
    .replace(GENERIC_CHINESE_SUFFIX_RE, "")
    .replace(/\b(?:BAR|Bar|bar|COCKTAIL|Cocktail|cocktail|WHISKY|Whisky|whisky|PUB|Pub|pub|BEER|Beer|beer)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 从店名提取有辨识度的搜索词，按优先级排序（排除鸡尾酒吧、精酿啤酒等大词） */
function rankMerchantSearchAliases(name) {
  const raw = String(name || "").trim();
  const short = stripBranchSuffix(raw);
  const scores = new Map();
  const consider = (term, score) => {
    const text = String(term || "").trim();
    if (text.length < 2 || isWeakMerchantSearchToken(text, raw)) return;
    scores.set(text, Math.max(scores.get(text) || 0, score));
  };

  for (const match of short.matchAll(/\d+·?[A-Za-z]{3,}/g)) {
    consider(match[0], 100);
  }

  for (const match of short.matchAll(
    /[A-Za-z][A-Za-z0-9]*[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9]*|[\u4e00-\u9fa5]+[A-Za-z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*[\u4e00-\u9fa5]+/gu,
  )) {
    consider(match[0], 96);
  }

  for (const match of short.matchAll(/[A-Za-z0-9][A-Za-z0-9]{2,}/g)) {
    const word = match[0];
    if (/^\d+$/.test(word)) continue;
    consider(word, 72 + Math.min(word.length, 10) + latinBrandBonus(word));
  }

  for (const match of short.matchAll(/[\u4e00-\u9fa5]{2,}/gu)) {
    const cleaned = stripGenericVenueSuffix(match[0]);
    if (cleaned.length >= 2) consider(cleaned, 86);
  }

  const beforeBar = short.match(/^(.+?)(?:\s+)?(?:BAR|Bar|鸡尾酒吧|威士忌酒吧)/u);
  if (beforeBar) {
    const prefix = stripGenericVenueSuffix(beforeBar[1]).trim();
    if (prefix.length >= 2) consider(prefix, 88);
    for (const match of prefix.matchAll(/[a-zA-Z][a-zA-Z0-9]{2,}/g)) {
      consider(match[0], 78 + Math.min(match[0].length, 8));
    }
    for (const match of prefix.matchAll(/[A-Za-z][A-Za-z0-9]*[\u4e00-\u9fa5]+/gu)) {
      consider(match[0], 94);
    }
  }

  for (const segment of short.split(/[·•&|｜/\s]+/)) {
    const cleaned = stripGenericVenueSuffix(segment).trim();
    if (cleaned.length >= 2) consider(cleaned, 64 + latinBrandBonus(cleaned));
  }

  const cleanedShort = stripGenericVenueSuffix(short);
  if (cleanedShort.length >= 2 && cleanedShort !== short) consider(cleanedShort, 58);

  const chineseBias = (term) => (/[\u4e00-\u9fa5]/.test(term) && !/[A-Za-z0-9]/.test(term) ? 1 : 0);
  const fullNorm = normalizeBrandCompare(short);
  return [...scores.entries()]
    .filter(([term]) => {
      const termNorm = normalizeBrandCompare(term);
      if (termNorm.length >= fullNorm.length) return true;
      if (/^\d{2,}$/.test(term) && fullNorm.startsWith(termNorm)) return false;
      if (termNorm.length <= 4 && fullNorm.includes(termNorm) && /[\u4e00-\u9fa5]/.test(term)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => (
      (b[1] + latinBrandBonus(b[0])) - (a[1] + latinBrandBonus(a[0]))
      || chineseBias(b[0]) - chineseBias(a[0])
      || b[0].length - a[0].length
    ))
    .map(([term]) => term);
}

function pickPrimaryMerchantSearchTerm(name) {
  const ranked = rankMerchantSearchAliases(name);
  if (ranked.length) return ranked[0];
  const short = stripBranchSuffix(name);
  return short || String(name || "").trim();
}

function extractMerchantSearchAliases(name) {
  return rankMerchantSearchAliases(name);
}

/**
 * 对单个 POI 候选打分：店名越像分越高；可选 referenceAddressHints 仅用于和 POI 地址比对。
 * @param {string} query
 * @param {object} poi
 * @param {{ extraQueries?: string[], addressHints?: string[] }} [options]
 */
function scorePoiCandidate(query, poi, options = {}) {
  const extraQueries = options.extraQueries || [];
  const addressHints = options.addressHints || [];
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

  for (const hint of addressHints) {
    const nh = normalizeMatchText(hint);
    if (!nh) continue;
    if (normalizeMatchText(address).includes(nh)) score += 28;
    for (const token of tokenizeForMatch(hint)) {
      const nt = normalizeMatchText(token);
      if (nt.length < 2) continue;
      if (normalizeMatchText(address).includes(nt)) score += 10;
    }
  }

  if (POI_NOISE_TITLE.test(title) && !POI_NOISE_TITLE.test(queryText)) score -= 55;
  if (POI_BAD_VENUE_TITLE.test(title) && /bar|酒吧|酒|咖啡|homebar|nightingale|rainbow/i.test(queryText)) {
    score -= 65;
  }
  for (const brand of extractDistinctiveLatinBrands(query)) {
    if (normalizeMatchText(title).includes(brand)) score += 42;
  }
  if (query.length >= 3 && !poiTitleMatchesMerchant(query, title)) {
    score -= 85;
  }
  if (POI_WRONG_BUSINESS_TITLE.test(title) && /bar|酒吧|酒|咖啡|homebar|nightingale|rainbow|日咖夜酒/i.test(queryText)) {
    score -= 80;
  }
  if (/剧|酒吧|咖啡|餐|店|馆|厅|中心|书院|艺术|脱口秀|剧场/i.test(queryText)
    && /剧|酒吧|咖啡|餐|店|馆|厅|中心|艺术|脱口秀|剧场/i.test(`${category} ${title}`)) {
    score += 10;
  }

  if (Number.isFinite(poi._rank)) score -= poi._rank * 0.4;
  return score;
}

function pickBestPoiCandidate(query, items, options = {}) {
  const extraQueries = Array.isArray(options) ? options : (options.extraQueries || []);
  const addressHints = Array.isArray(options) ? [] : (options.addressHints || []);
  if (!items?.length) return { poi: null, score: 0 };
  let best = items[0];
  let bestScore = -Infinity;
  for (let i = 0; i < items.length; i += 1) {
    const score = scorePoiCandidate(query, { ...items[i], _rank: i }, { extraQueries, addressHints });
    if (score > bestScore) {
      bestScore = score;
      best = items[i];
    }
  }
  return { poi: best, score: bestScore };
}

function reorderPoiByBestMatch(query, items, options = {}) {
  const extraQueries = Array.isArray(options) ? options : (options.extraQueries || []);
  const addressHints = Array.isArray(options) ? [] : (options.addressHints || []);
  if (!items?.length) return [];
  return [...items]
    .map((item, i) => ({
      item,
      score: scorePoiCandidate(query, { ...item, _rank: i }, { extraQueries, addressHints }),
    }))
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}

const CITY_NAMES = /^(北京|上海|广州|深圳|成都|杭州|武汉|西安|南京|重庆|天津|苏州|长沙|郑州|东莞|青岛|沈阳|宁波|昆明)$/;
const DISTRICT_NAMES = /^(朝阳|海淀|浦东|黄浦|徐汇|静安|长宁|杨浦|虹口|普陀|闵行|宝山|嘉定|松江|青浦|奉贤|崇明|天河|越秀|海珠|荔湾|白云|番禺|武侯|锦江|青羊|成华|高新)区?$/;

function isMallLikePoiTitle(poiTitle) {
  const t = String(poiTitle || "").trim();
  return /(广场|大厦|中心|商场|购物中心|百货|商城|天地)$/.test(t)
    && !/(剧场|剧院|酒吧|咖啡|电影|餐|Live|Comedy|小剧场)/i.test(t);
}

function isVenueLikeSegment(seg) {
  const s = String(seg || "").trim();
  if (!s || /^\d/.test(s)) return false;
  if (CITY_NAMES.test(s) || DISTRICT_NAMES.test(s)) return false;
  return /[\u4e00-\u9fa5]{2,}(馆|店|厅|中心|剧场|剧院|酒吧|咖啡|书院|演艺|会所|世界|Livehouse|livehouse|Club|club|吧)$/u.test(s)
    || /(美术馆|博物馆|艺术馆|展览馆|脱口秀|相声|话剧|音乐厅|演艺|影城|电影院|咖啡馆|咖啡厅|精酿|餐吧|小剧场)/u.test(s)
    || /Comedy|comedy|Live|LAB|Club/i.test(s);
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
    const raw = seg.trim();
    if (isVenueLikeSegment(raw)) add(raw);
    const clean = raw.replace(/[-—–].*$/, "").trim();
    if (!clean || /^\d/.test(clean)) continue;
    if (CITY_NAMES.test(clean) || DISTRICT_NAMES.test(clean)) continue;
    if (/[\u4e00-\u9fa5]{2,}(馆|店|厅|中心|剧场|剧院|酒吧|咖啡|书院|演艺|会所|世界|Livehouse|livehouse|Club|club|吧)$/u.test(clean)
      || /(美术馆|博物馆|艺术馆|展览馆|脱口秀|相声|话剧|音乐厅|演艺|影城|电影院|咖啡馆|咖啡厅|精酿|餐吧|小剧场)/u.test(clean)) {
      add(clean);
    }
  }
  return hints;
}

/** 从活动地点提取场所名（不含活动标题——标题是演出名不是场地） */
function extractVenueHintsFromLocation(location) {
  return extractVenueHints(location, "");
}

function poiBrandAppearsInLocation(location, poiTitle) {
  const brand = normalizeVenueBrand(poiTitle);
  if (!brand || brand.length < 2) return false;
  const loc = normalizeMatchText(location);
  if (loc.includes(brand)) return true;
  for (let len = Math.min(brand.length, 8); len >= 2; len -= 1) {
    const slice = brand.slice(0, len);
    if (/^[\u4e00-\u9fa5a-z0-9]+$/iu.test(slice) && loc.includes(slice)) return true;
  }
  return false;
}

/** 从活动标题提取品牌/场地线索（【一支麦喜剧】、by SpicyComedy），不拿整段标题当地点 */
function extractTitleBrandHints(title) {
  const hints = [];
  const seen = new Set();
  const add = (text) => {
    const t = String(text || "").trim();
    if (!t || t.length < 2 || seen.has(t)) return;
    seen.add(t);
    hints.push(t);
  };
  const raw = String(title || "");
  for (const match of raw.matchAll(/【([^】]{2,24})】/g)) add(match[1]);
  for (const match of raw.matchAll(/\bby\s+([A-Za-z0-9][\w.-]*)/gi)) add(match[1]);
  for (const match of raw.matchAll(/[｜|]\s*([^｜|【】]{2,20}(?:喜剧|剧场|小剧场|Livehouse|酒吧|咖啡))/g)) add(match[1]);
  for (const match of raw.matchAll(/】\s*([^｜|【】]{2,24}(?:喜剧|剧场|小剧场|Livehouse|酒吧|咖啡))/g)) add(match[1]);
  return hints;
}

/** 活动标题里的演出/场地名（含括号分店），如「芙蓉国粹川剧变脸秀(省川剧院)」 */
function extractTitleShowHints(title) {
  const hints = [];
  const seen = new Set();
  const add = (text) => {
    const t = String(text || "").trim();
    if (!t || t.length < 3 || seen.has(t)) return;
    seen.add(t);
    hints.push(t);
  };
  let raw = String(title || "").trim().replace(/^【[^】]+】\s*/g, "").trim();
  if (raw.length >= 3) add(raw);
  const core = stripBranchSuffix(raw);
  if (core && core.length >= 3) add(core);
  for (const match of raw.matchAll(/[（(]([^）)]{2,24})[）)]/g)) add(match[1]);
  return hints;
}

/** 地点场所名是否与 POI 标题一致（含 POI 括号内场馆名，如「四川省川剧院」） */
function venueHintMatchesPoi(hint, poiTitle) {
  if (poiTitleMatchesMerchant(hint, poiTitle)) return true;
  const hintNorm = normalizeMatchText(hint);
  const poiNorm = normalizeMatchText(poiTitle);
  if (hintNorm.length >= 2 && poiNorm.includes(hintNorm)) return true;
  for (const match of String(poiTitle).matchAll(/[（(]([^）)]+)[）)]/g)) {
    const branch = normalizeMatchText(match[1]);
    if (hintNorm.length >= 2 && (branch.includes(hintNorm) || hintNorm.includes(branch))) return true;
  }
  return false;
}

/** 活动标题与 POI 比对（商场 POI 时只看标题分段里的店名，避免长标题含商场名误撞） */
function titleShowMatchesPoi(hint, poiTitle) {
  if (isMallLikePoiTitle(poiTitle)) {
    const segments = String(hint).split(/[｜|]/).map((s) => s.trim()).filter(Boolean);
    const venueSegs = segments.filter((s) => /(剧场|剧院|酒吧|咖啡|喜剧|Live|Comedy|餐吧|小剧场)/i.test(s));
    return venueSegs.some((seg) => venueHintMatchesPoi(seg, poiTitle));
  }
  return venueHintMatchesPoi(hint, poiTitle);
}

/** 商场/楼宇等地标，用于地点与 POI 名称+地址联合比对 */
function extractLocationLandmarks(text) {
  const landmarks = [];
  const seen = new Set();
  const add = (value) => {
    const v = normalizeMatchText(value);
    if (!v || v.length < 2 || seen.has(v)) return;
    seen.add(v);
    landmarks.push(v);
  };
  const raw = String(text || "");
  for (const match of raw.matchAll(/([\u4e00-\u9fa5A-Za-z0-9]{2,}(?:广场|大厦|中心|商场|购物中心|SOHO|步行街|天地|里|坊|城|百货|商城|写字楼|大楼))/gu)) {
    add(match[1]);
  }
  for (const match of raw.matchAll(/(\d+栋\d*楼?)/gu)) add(match[1]);
  for (const match of raw.matchAll(/(\d+层|\d+楼)/gu)) add(match[1]);
  return landmarks;
}

/** 活动地点是否与 POI 名称+地址对得上（名称、门牌、地标任一足够） */
function locationAlignsWithPoi(location, poiTitle, poiAddress) {
  const poiText = normalizeMatchText(`${poiTitle} ${poiAddress}`);
  const locNorm = normalizeMatchText(location);

  const addressHints = extractAddressHints(isStreetLevelAddress(location) ? location : "");
  if (addressHints.some((hint) => poiText.includes(normalizeMatchText(hint)))) {
    return true;
  }

  const landmarks = extractLocationLandmarks(location);
  if (landmarks.some((landmark) => poiText.includes(landmark) || locNorm.includes(landmark))) {
    return true;
  }

  if (poiBrandAppearsInLocation(location, poiTitle)) {
    return true;
  }

  return addressHints.length === 0 && landmarks.length === 0;
}

function eventVenueMatchesPoi(location, title, poiTitle) {
  const venueHints = extractVenueHintsFromLocation(location);
  const titleBrands = extractTitleBrandHints(title);
  const titleShows = extractTitleShowHints(title);
  const context = `${location} ${titleBrands.join(" ")} ${titleShows.join(" ")}`;

  if (venueHints.some((hint) => venueHintMatchesPoi(hint, poiTitle))) return true;
  if (titleBrands.some((hint) => venueHintMatchesPoi(hint, poiTitle))) return true;
  if (titleShows.some((hint) => titleShowMatchesPoi(hint, poiTitle))) return true;

  // 地点里写了具体场馆/店名，但与 POI 完全对不上时，不能只因商场名相同就算对上
  const primaryVenue = venueHints.find((h) => /(剧场|剧院|酒吧|咖啡|喜剧|Live|Comedy|餐吧|小剧场)/i.test(h));
  if (primaryVenue && !venueHintMatchesPoi(primaryVenue, poiTitle)) return false;

  // POI 只是商场/地标名时，必须有店名匹配，不能只看地址里出现商场名
  if (isMallLikePoiTitle(poiTitle) && venueHints.length > 0) {
    return false;
  }

  return poiBrandAppearsInLocation(context, poiTitle);
}

function pickBestPoiForEvent(event, items) {
  const location = String(event?.location || "").trim();
  const title = String(event?.title || "").trim();
  const primary = location || title;
  const extraQueries = extractVenueHints(location, title).filter((hint) => hint !== primary);
  return pickBestPoiCandidate(primary, items, { extraQueries });
}

const POI_MATCH_MODE_NORMAL = "normal";
const POI_MATCH_MODE_STRICT = "strict";

function normalizePoiMatchMode(mode) {
  return mode === POI_MATCH_MODE_STRICT ? POI_MATCH_MODE_STRICT : POI_MATCH_MODE_NORMAL;
}

function isStrictPoiMatchMode(mode) {
  return normalizePoiMatchMode(mode) === POI_MATCH_MODE_STRICT;
}

function poiTitleMatchesForMode(merchantName, poiTitle, mode) {
  return isStrictPoiMatchMode(mode)
    ? poiTitleMatchesMerchantForPick(merchantName, poiTitle)
    : poiTitleMatchesMerchant(merchantName, poiTitle);
}

function pickBestPoiForMerchant(name, items, options = {}) {
  const full = String(name || "").trim();
  const short = stripBranchSuffix(full);
  const mode = normalizePoiMatchMode(options.poiMatchMode);
  const extraQueries = [
    ...(short && short !== full ? [short] : []),
    ...extractMerchantSearchAliases(name),
  ];
  const addressHints = extractAddressHints(options.referenceAddress || "");
  const pickOpts = { extraQueries, addressHints };

  if (!isStrictPoiMatchMode(mode)) {
    return pickBestPoiCandidate(full, items, pickOpts);
  }

  const scoredRows = items
    .map((item, i) => ({
      item,
      score: scorePoiCandidate(full, { ...item, _rank: i }, pickOpts),
    }))
    .filter((row) => poiTitleMatchesMerchantForPick(full, row.item.title))
    .sort((a, b) => b.score - a.score);
  if (scoredRows.length) {
    return { poi: scoredRows[0].item, score: scoredRows[0].score };
  }
  const fallback = pickBestPoiCandidate(full, items, pickOpts);
  return { poi: null, score: fallback.score };
}

/** 严格存疑：分店后缀与清单不一致（同品牌不同店） */
function strictMerchantBranchMismatch(merchantName, sourceAddress, poiTitle, poiAddress) {
  const mBranch = String(merchantName).match(/[（(]([^）)]+)[）)]/)?.[1]?.trim();
  const pBranch = String(poiTitle).match(/[（(]([^）)]+)[）)]/)?.[1]?.trim();
  if (!mBranch || !pBranch) return false;
  const mNorm = normalizeMatchText(mBranch);
  const pNorm = normalizeMatchText(pBranch);
  if (mNorm === pNorm || mNorm.includes(pNorm) || pNorm.includes(mNorm)) return false;

  const ref = tradToSimplified(sourceAddress || "");
  if (isStreetLevelAddress(ref)) {
    const hints = extractAddressHints(ref);
    const poiText = normalizeMatchText(`${poiTitle} ${poiAddress}`);
    if (hints.some((hint) => poiText.includes(normalizeMatchText(hint)))) {
      return false;
    }
  }

  const mCore = normalizeMatchText(stripBranchSuffix(merchantName));
  const pCore = normalizeMatchText(stripBranchSuffix(poiTitle));
  if (mCore.length < 4 || pCore.length < 4) return false;
  const prefixLen = Math.min(6, mCore.length, pCore.length);
  return mCore.includes(pCore.slice(0, prefixLen)) || pCore.includes(mCore.slice(0, prefixLen));
}

/**
 * 严格存疑专用：与自动选点（ForPick）分离，只抓高置信误绑。
 * 不再因「仅部分相似」或 ForPick 品牌守卫失败而批量误报。
 */
function collectStrictMerchantPoiDoubtReasons(merchantName, poiTitle, poiAddress, sourceAddress) {
  const reasons = [];
  if (!poiTitleMatchesMerchant(merchantName, poiTitle)) return reasons;

  const latinBrands = extractDistinctiveLatinBrands(merchantName);
  if (latinBrands.length && !isStrongMerchantPoiNameMatch(merchantName, poiTitle)) {
    const poiNorm = normalizeMatchText(poiTitle);
    if (!latinBrands.some((brand) => poiNorm.includes(brand))) {
      reasons.push("严格：店名含英文品牌，POI 未出现该品牌");
    }
  }

  if (merchantHasDigitHomebarBrand(merchantName)) {
    const poiSig = normalizeBrandCompare(stripBranchSuffix(poiTitle));
    if (!poiSig.includes("homebar")) {
      reasons.push("严格：店名含 Homebar，POI 未出现 Homebar");
    }
  }

  const barLike = /bar|酒吧|酒|咖啡|homebar|日咖夜酒/i.test(merchantName)
    || latinBrands.length > 0;
  if (barLike && (POI_BAD_VENUE_TITLE.test(poiTitle) || POI_WRONG_BUSINESS_TITLE.test(poiTitle))) {
    reasons.push("严格：POI 疑似非门店（小区门、剧本杀等）");
  }

  if (strictMerchantBranchMismatch(merchantName, sourceAddress, poiTitle, poiAddress)) {
    reasons.push("严格：POI 分店名与店名分店不一致");
  }

  return reasons;
}

/**
 * 审核台：判断已选 POI 是否存疑（名称不像、地址对不上、低分等）。
 * 严格模式只叠加额外高置信规则，不复用自动选点的 ForPick 过滤。
 */
function assessMerchantPoiConfidence(merchant, options = {}) {
  if (!merchant?.address_poi_id) {
    return { doubtful: false, score: 0, reasons: [] };
  }

  const mode = normalizePoiMatchMode(options.poiMatchMode);
  const poi = {
    poi_id: merchant.address_poi_id,
    title: merchant.poi_title || "",
    address: merchant.poi_address || "",
  };
  const dianpingAddress = merchant.source_address || merchant.address || "";
  const referenceAddress = isStreetLevelAddress(dianpingAddress) ? dianpingAddress : "";
  const { score } = pickBestPoiForMerchant(merchant.name, [poi], {
    referenceAddress,
    poiMatchMode: POI_MATCH_MODE_NORMAL,
  });
  const reasons = [];

  const nameMatch = poiTitleMatchesMerchant(merchant.name, poi.title);
  const addressesMatch = addressesRoughlyAlign(dianpingAddress, poi.address);

  if (!nameMatch) {
    reasons.push("POI 名称与店名不像同一家");
  }
  if (POI_NOISE_TITLE.test(poi.title)) {
    reasons.push("POI 疑似停车场、地铁等非门店地点");
  }

  if (!nameMatch && !addressesMatch) {
    const hints = extractAddressHints(referenceAddress);
    if (hints.length) {
      const addrNorm = normalizeMatchText(poi.address);
      const matched = hints.some((hint) => addrNorm.includes(normalizeMatchText(hint)));
      if (!matched) {
        reasons.push("POI 地址未包含清单门牌信息");
      }
    }
  }

  if (score < 55 && !nameMatch) {
    reasons.push(`自动匹配得分偏低（${Math.round(score)}）`);
  }

  if (isStrictPoiMatchMode(mode)) {
    reasons.push(...collectStrictMerchantPoiDoubtReasons(
      merchant.name,
      poi.title,
      poi.address,
      dianpingAddress,
    ));
  }

  return {
    doubtful: reasons.length > 0,
    score: Math.round(score),
    reasons,
  };
}

/**
 * 审核台：判断活动已选 POI 是否存疑（场所名不像、地址对不上、低分等）。
 */
function assessEventPoiConfidence(event) {
  if (!event?.location_poi_id) {
    return { doubtful: false, score: 0, reasons: [] };
  }

  const poi = {
    poi_id: event.location_poi_id,
    title: event.poi_title || "",
    address: event.poi_address || "",
  };
  const location = String(event.location || "").trim();
  const title = String(event.title || "").trim();
  const { score } = pickBestPoiForEvent(event, [poi]);
  const reasons = [];

  const nameOk = eventVenueMatchesPoi(location, title, poi.title);
  const addressOk = locationAlignsWithPoi(location, poi.title, poi.address);

  if (!nameOk && !addressOk) {
    reasons.push("POI 与活动地点不像同一场所（名称与地址均未对上）");
  } else if (!nameOk && extractVenueHintsFromLocation(location).length > 0) {
    const venueHints = extractVenueHintsFromLocation(location);
    const primaryVenue = venueHints.find((h) => /(剧场|剧院|酒吧|咖啡|喜剧|Live|Comedy|餐吧|小剧场)/i.test(h));
    const mallMismatch = primaryVenue && isMallLikePoiTitle(poi.title) && !venueHintMatchesPoi(primaryVenue, poi.title);
    if (!addressOk || mallMismatch) {
      reasons.push("POI 名称与活动地点不像同一场所");
    }
  } else if (!addressOk && !(nameOk && score >= 55)) {
    reasons.push("POI 地址未包含活动地点门牌信息");
  }

  if (POI_NOISE_TITLE.test(poi.title)) {
    reasons.push("POI 疑似停车场、地铁等非活动场所");
  }

  if (score < 55 && !nameOk) {
    reasons.push(`自动匹配得分偏低（${Math.round(score)}）`);
  }

  return {
    doubtful: reasons.length > 0,
    score: Math.round(score),
    reasons,
  };
}

/** 取店名主体（去掉 -分店 / (分店) 后的商场名，避免「xx剧场-正佳广场店」误撞商场 POI） */
function coreVenueBrand(name) {
  return normalizeVenueBrand(String(name || "").split(/[-—–(（]/)[0]);
}

/** 店名与 POI 名称高度一致（去分店后缀后相同或互相包含） */
function isStrongMerchantPoiNameMatch(merchantName, poiTitle) {
  if (!poiTitleMatchesMerchant(merchantName, poiTitle)) return false;
  const merchantCore = normalizeBrandCompare(stripBranchSuffix(merchantName));
  const poiCore = normalizeBrandCompare(stripBranchSuffix(poiTitle));
  if (!merchantCore || !poiCore) return false;
  if (merchantCore === poiCore) return true;
  if (merchantCore.includes(poiCore) || poiCore.includes(merchantCore)) return true;
  const brandM = coreVenueBrand(merchantName);
  const brandP = coreVenueBrand(poiTitle);
  return Boolean(brandM && brandP && (brandM === brandP || brandM.includes(brandP) || brandP.includes(brandM)));
}

/** Top1 标题是否与店名同一商户（避免「黑犬酒吧(白沙古井店)」搜成地标「白沙古井」） */
function poiTitleMatchesMerchantCore(merchantName, poiTitle) {
  const merchantNorm = normalizeMerchantPoiTitle(merchantName);
  const poiNorm = normalizeMerchantPoiTitle(poiTitle);
  if (!merchantNorm || !poiNorm) return false;
  if (merchantNorm === poiNorm) return true;
  if (merchantNorm.length >= 4 && poiNorm.includes(merchantNorm)) return true;
  if (poiNorm.length >= 4 && merchantNorm.includes(poiNorm)) return true;

  const merchantHan = merchantNorm.match(/[\u4e00-\u9fa5]{2,}/gu) || [];
  const poiHan = poiNorm.match(/[\u4e00-\u9fa5]{2,}/gu) || [];
  if (merchantHan.some((a) => poiHan.some((b) => hanBrandTokensMatch(a, b)))) {
    return true;
  }

  const merchantLatin = (merchantNorm.match(/[a-z0-9]{3,}/g) || [])
    .filter((token) => !/^\d{2,}$/.test(token));
  const poiLatin = (poiNorm.match(/[a-z0-9]{3,}/g) || [])
    .filter((token) => !/^\d{2,}$/.test(token));
  if (merchantLatin.some((a) => poiLatin.includes(a))) return true;

  if (merchantNameSegmentsMatch(merchantName, poiTitle)) return true;

  const brand = normalizeVenueBrand(stripBranchSuffix(merchantName));
  const title = normalizeVenueBrand(poiTitle);
  const core = coreVenueBrand(merchantName);
  if (brand && title && (title.includes(brand) || brand.includes(title))) return true;
  if (core && title && (title.includes(core) || core.includes(title))) return true;

  return false;
}

function poiTitleMatchesMerchant(merchantName, poiTitle) {
  return poiTitleMatchesMerchantCore(merchantName, poiTitle);
}

/** 自动选 POI 时用：在核心匹配基础上再加英文品牌/业态过滤 */
function poiTitleMatchesMerchantForPick(merchantName, poiTitle) {
  if (!poiTitleMatchesMerchantCore(merchantName, poiTitle)) return false;
  return poiTitlePassesBrandGuards(merchantName, poiTitle);
}

/**
 * 按商户店名搜索 POI：全名 → 去分店短名 → 品牌别名，名称对上即停。
 */
/** 按活动地点文本搜索 POI，并按相似度重排候选（豆瓣 location 字段） */
async function searchPoiForEvent(location, city, opts = {}) {
  const cityName = String(city || "全国").trim() || "全国";
  const loc = String(location || "").trim();
  const title = String(opts.title || "").trim();
  if (!loc && !title) {
    return { keyword: cityName, count: 0, items: [] };
  }

  const keywords = buildEventPoiSearchKeywords(loc, cityName, { title });
  let merged = [];
  let usedKeyword = keywords[0];

  for (const keyword of keywords) {
    const result = await searchPoi({ ...opts, keyword, city: cityName });
    if (result.items?.length) {
      merged = mergePoiById(merged, result.items);
      usedKeyword = keyword;
      const { score } = pickBestPoiForEvent({ location: loc, title }, merged);
      if (score >= 55) break;
    }
  }

  const extraQueries = extractVenueHints(loc, title).filter((hint) => hint !== (loc || title));
  const items = reorderPoiByBestMatch(loc || title, merged, { extraQueries });
  return { keyword: usedKeyword, keywords_tried: keywords, count: items.length, items };
}

async function searchPoiForMerchant(name, city, opts = {}) {
  const cityName = String(city || "全国").trim() || "全国";
  const mode = normalizePoiMatchMode(opts.poiMatchMode);
  const shortName = stripBranchSuffix(name);
  const aliases = extractMerchantSearchAliases(name);
  const hasNameMatch = (items) => items.some((item) => poiTitleMatchesForMode(name, item.title, mode));

  const searchTerms = [];
  const pushTerm = (term) => {
    const text = String(term || "").trim();
    if (!text || searchTerms.includes(text)) return;
    searchTerms.push(text);
  };

  pushTerm(String(name || "").trim());
  pushTerm(shortName);
  for (const brand of extractDistinctiveLatinBrands(name)) pushTerm(brand);
  for (const alias of aliases.slice(0, 5)) pushTerm(alias);

  const keywordsToTry = searchTerms.map((term) => buildPoiKeyword(term, cityName));
  let merged = [];
  let usedKeyword = keywordsToTry[0] || buildPoiKeyword(name, cityName);

  for (const keyword of keywordsToTry) {
    const result = await searchPoi({ ...opts, keyword, city: cityName });
    if (result.items?.length) {
      merged = mergePoiById(merged, result.items);
      usedKeyword = keyword;
    }
    if (hasNameMatch(merged)) break;
  }

  const matched = merged.find((item) => poiTitleMatchesForMode(name, item.title, mode));
  if (matched) {
    return {
      keyword: usedKeyword,
      count: merged.length,
      items: [matched, ...merged.filter((item) => item !== matched)],
    };
  }

  const extraQueries = [
    ...aliases,
    ...(shortName && shortName !== String(name || "").trim() ? [shortName] : []),
  ];
  const items = reorderPoiByBestMatch(name, merged, { extraQueries });
  return { keyword: usedKeyword, count: items.length, items };
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
    if (fallbackReason && (isPersonalMapKey(key) || isCompanyMapKey(key)) && i + 1 < keys.length) {
      if (fallbackReason === "quota") {
        exhaustedMapKeys.add(key);
      }
      const hint = fallbackReason === "quota"
        ? "日配额已满"
        : "不可用（可能需在腾讯控制台关闭 SK 签名校验或配置 WebService 白名单）";
      console.warn(
        `[tencent-poi] ${formatMapKeyLabel(key)} ${hint}，切换下一 key: ${raw.message}`,
      );
      continue;
    }

    if (fallbackReason === "quota") {
      exhaustedMapKeys.add(key);
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

function suggestMerchantPoiKeyword(name, city) {
  const cityName = String(city || "").trim();
  return buildPoiKeyword(String(name || "").trim(), cityName);
}

module.exports = {
  addressesRoughlyAlign,
  assessEventPoiConfidence,
  assessMerchantPoiConfidence,
  POI_MATCH_MODE_NORMAL,
  POI_MATCH_MODE_STRICT,
  isStrictPoiMatchMode,
  normalizePoiMatchMode,
  poiTitleMatchesForMode,
  buildEventPoiSearchKeywords,
  buildPoiKeyword,
  parseDoubanLocation,
  suggestEventPoiKeyword,
  suggestMerchantPoiKeyword,
  COMPANY_MAP_KEY,
  formatMapKeyLabel,
  extractAddressHints,
  extractMerchantSearchAliases,
  isGenericSearchToken,
  isStreetLevelAddress,
  pickPrimaryMerchantSearchTerm,
  isStrongMerchantPoiNameMatch,
  MAP_KEY_OWNER,
  PERSONAL_MAP_KEY_ENTRIES,
  PERSONAL_MAP_KEYS,
  pickBestPoiCandidate,
  pickBestPoiForEvent,
  pickBestPoiForMerchant,
  poiTitleMatchesMerchant,
  rankMerchantSearchAliases,
  reorderPoiByBestMatch,
  resolveMapKey,
  resolveMapKeyChain,
  scorePoiCandidate,
  searchPoi,
  searchPoiForEvent,
  searchPoiForMerchant,
  stripBranchSuffix,
};

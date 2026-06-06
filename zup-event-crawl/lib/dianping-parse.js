"use strict";

const { matchesSocialVenueIntent } = require("./merchant-social-filter");

const CLOSED_MARKERS = [
  "歇业关闭",
  "已关门",
  "门店关闭",
  "暂停营业",
  "尚未开业",
  "即将开业",
  "未开业",
  "永久关门",
  "已停业",
  "停止营业",
  "已停止营业",
  "停业",
];

const DIANPING_CITY_IDS = {
  上海: 1,
  北京: 2,
  杭州: 3,
  广州: 4,
  南京: 5,
  苏州: 6,
  深圳: 7,
  成都: 8,
  重庆: 9,
  天津: 10,
  厦门: 15,
  武汉: 16,
  西安: 17,
  长沙: 344,
  郑州: 160,
  秦皇岛: 26,
  宁波: 11,
  青岛: 21,
  无锡: 13,
};

function decodeHtml(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function stripHtmlTags(text) {
  return decodeHtml(String(text || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

function firstMatch(text, pattern) {
  const match = text.match(pattern);
  return match ? decodeHtml(match[1]) : "";
}

function isLoginWall(html) {
  const sample = String(html || "");
  return (
    sample.includes("扫码登录") ||
    sample.includes("账号登录") ||
    (sample.includes("登录") && !sample.includes("shop-all-list"))
  );
}

function isClosedShop({ name, listHtml, liAttrs, detailHtml }) {
  const attrs = String(liAttrs || "");
  const block = String(listHtml || "");
  const haystack = `${name}\n${attrs}\n${block}\n${detailHtml || ""}`;

  // 列表项 <li class="close"> 表示歇业关闭（class 在 li 开标签上，不在 innerHTML 里）
  if (/\bclass="[^"]*\bclose\b/i.test(attrs) || /\bclass='[^']*\bclose\b/i.test(attrs)) {
    return true;
  }
  if (/shop[_-]?closed|icon[_-]?closed|tag[_-]?closed/i.test(block)) {
    return true;
  }
  return CLOSED_MARKERS.some((marker) => haystack.includes(marker));
}

function buildSearchUrl(cityId, keyword) {
  const encoded = encodeURIComponent(keyword);
  return `https://www.dianping.com/search/keyword/${cityId}/0_${encoded}`;
}

function normalizeImageUrl(raw) {
  if (!raw) return "";
  let url = String(raw).trim();
  try {
    url = decodeURIComponent(url);
  } catch (error) {
    // keep raw when not percent-encoded
  }
  url = decodeHtml(url);
  if (url.startsWith("//")) url = `https:${url}`;
  return url;
}

function parseListItemImage(listItemHtml) {
  const raw = firstMatch(listItemHtml, /data-src="([^"]+)"/i)
    || firstMatch(listItemHtml, /\bsrc="(https?:\/\/[^"]+)"/i)
    || firstMatch(listItemHtml, /\bsrc="(\/\/[^"]+)"/i);
  return normalizeImageUrl(raw);
}

function parseShopDetailImage(html) {
  const raw = firstMatch(html, /"defaultPic":"([^"]+)"/)
    || firstMatch(html, /<meta property="og:image" content="([^"]+)"/i)
    || firstMatch(html, /"shopPic":"([^"]+)"/)
    || firstMatch(html, /"frontImg":"([^"]+)"/);
  return normalizeImageUrl(raw);
}

function extractSearchBasePath(searchUrl) {
  if (!searchUrl) return "";
  try {
    const pathname = new URL(searchUrl).pathname;
    return pathname.replace(/\/p\d+$/, "");
  } catch (error) {
    return "";
  }
}

function extractShopListBlock(html) {
  const marker = html.search(/id=["']shop-all-list["']/i);
  if (marker < 0) return html;

  const ulOpen = html.indexOf("<ul", marker);
  const ulClose = ulOpen >= 0 ? html.indexOf("</ul>", ulOpen) : -1;
  if (ulOpen >= 0 && ulClose > ulOpen) {
    return html.slice(ulOpen, ulClose + 5);
  }

  return html.slice(marker);
}

function collectNextPagePaths(html, searchUrl) {
  const basePath = extractSearchBasePath(searchUrl);
  if (!basePath) return [];

  const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pagePattern = new RegExp(
    `href="((?:https://www\\.dianping\\.com)?${escaped}/p\\d+)"`,
    "gi",
  );
  const nextPages = [];
  let pageMatch;
  while ((pageMatch = pagePattern.exec(html))) {
    const href = pageMatch[1];
    if (!nextPages.includes(href)) nextPages.push(href);
  }
  return nextPages.sort((a, b) => {
    const pa = Number((a.match(/\/p(\d+)$/) || [])[1] || 0);
    const pb = Number((b.match(/\/p(\d+)$/) || [])[1] || 0);
    return pa - pb;
  });
}

function isSearchNotFound(html) {
  const sample = String(html || "");
  return sample.includes("not-found-words")
    || /没有找到与[\s\S]{0,80}相关的商户/.test(sample);
}

function parseSearchListHtml(html, options = {}) {
  if (isLoginWall(html)) {
    throw new Error("大众点评返回登录页，请先在 Chrome 登录大众点评后重试抓取命令");
  }

  if (isSearchNotFound(html)) {
    return {
      totalReported: 0,
      parsedCount: 0,
      filteredCount: 0,
      filterStats: { byName: 0, byKeyword: 0, byCategory: 0, byJunk: 0 },
      nextPagePaths: [],
      items: [],
      skippedClosed: 0,
      listHtmlReady: false,
      searchNotFound: true,
    };
  }

  const listBlock = extractShopListBlock(html);

  const items = [];
  const liPattern = /<li\b([^>]*)>([\s\S]*?)<\/li>/gi;
  let match;
  let position = 0;
  let skippedClosed = 0;

  while ((match = liPattern.exec(listBlock))) {
    const liAttrs = match[1];
    const block = match[2];
    if (!block.includes("shop_title_click")) continue;

    position += 1;
    const shopId = firstMatch(block, /data-shopid="([^"]+)"/i)
      || firstMatch(block, /href="https?:\/\/www\.dianping\.com\/shop\/([^"/?#]+)/i);
    const rawName = firstMatch(block, /data-click-name="shop_title_click"[^>]*title="([^"]+)"/i)
      || firstMatch(block, /data-click-name="shop_title_click"[^>]*>([\s\S]*?)<\/a>/i)
      || firstMatch(block, /<a[^>]*data-click-name="shop_title_click"[^>]*>([\s\S]*?)<\/a>/i)
      || firstMatch(block, /<h4[^>]*>([\s\S]*?)<\/h4>/i);
    const name = stripHtmlTags(rawName);
    if (!shopId || !name) continue;

    const category = firstMatch(block, /data-click-name="shop_tag_cate_click"[^>]*><span class="tag">([^<]+)<\/span>/i);
    const district = firstMatch(block, /data-click-name="shop_tag_region_click"[^>]*><span class="tag">([^<]+)<\/span>/i);
    const reviewCount = firstMatch(block, /<a[^>]*class="review-num"[^>]*>\s*<b>(\d+)<\/b>/i);
    const avgPrice = firstMatch(block, /class="mean-price"[\s\S]*?<b>￥?([^<]+)<\/b>/i);

    const item = {
      shopId,
      name,
      image: parseListItemImage(block),
      category,
      district,
      listRegionText: [category, district].filter(Boolean).join(" | "),
      reviewCount: reviewCount ? Number(reviewCount) : null,
      avgPrice: avgPrice ? `￥${avgPrice}` : "",
      originalLink: `https://www.dianping.com/shop/${shopId}`,
      sourcePosition: position,
      listHtml: block,
      liAttrs,
      address: "",
      needsDetail: false,
      businessStatus: "open",
    };

    if (isClosedShop(item)) {
      skippedClosed += 1;
      continue;
    }

    items.push(item);
  }

  const totalMatch = html.match(/共为您找到(\d+)个/);
  const nextPages = collectNextPagePaths(html, options.searchUrl);

  const filterStats = {
    byName: 0, byKeyword: 0, byCategory: 0, byJunk: 0, byBrand: 0,
  };
  const filtered = [];
  const namePattern = options.namePattern
    ? (options.namePattern instanceof RegExp ? options.namePattern : new RegExp(options.namePattern))
    : null;
  const searchKeyword = options.searchKeyword || "";

  for (const item of items) {
    if (namePattern && !namePattern.test(item.name)) {
      filterStats.byName += 1;
      continue;
    }
    const intent = matchesSocialVenueIntent(item, { searchKeyword });
    if (!intent.ok) {
      if (intent.reason === "keyword") filterStats.byKeyword += 1;
      else if (intent.reason === "junk_name") filterStats.byJunk += 1;
      else if (
        intent.reason === "brand_reject_name"
        || intent.reason === "brand_reject_category"
        || intent.reason === "not_brand_store"
      ) {
        filterStats.byBrand += 1;
      } else if (intent.reason === "category_blocked" || intent.reason === "not_social_venue") {
        filterStats.byCategory += 1;
      }
      continue;
    }
    filtered.push(item);
  }

  return {
    totalReported: totalMatch ? Number(totalMatch[1]) : items.length,
    parsedCount: items.length,
    filteredCount: filtered.length,
    filterStats,
    nextPagePaths: nextPages,
    items: filtered,
    skippedClosed,
    listHtmlReady: items.length > 0,
  };
}

function parseShopDetailHtml(html) {
  if (isLoginWall(html)) {
    return { address: "", phone: "", loginRequired: true };
  }

  const address = firstMatch(html, /"address":"([^"]+)"/)
    || firstMatch(html, /"shopAddress":"([^"]+)"/)
    || firstMatch(html, /class="addressText[^"]*"[^>]*>([^<]+)</i);

  const phone = firstMatch(html, /"phone":"([^"]+)"/)
    || firstMatch(html, /tel:([0-9-]+)/i);

  const name = firstMatch(html, /<span class="shopName[^"]*">([^<]+)</i)
    || firstMatch(html, /<title>【([^】]+)】/);

  const lat = firstMatch(html, /"lat":([0-9.]+)/);
  const lng = firstMatch(html, /"lng":([0-9.]+)/);

  const businessStatus = isClosedShop({ name, detailHtml: html }) ? "closed" : "open";
  const image = parseShopDetailImage(html);

  return {
    name: decodeHtml(name),
    address: decodeHtml(address),
    phone: decodeHtml(phone),
    image,
    latitude: lat ? Number(lat) : null,
    longitude: lng ? Number(lng) : null,
    businessStatus,
    loginRequired: false,
  };
}

function enrichWithDetail(item, detailHtml, detailUrl) {
  const detail = parseShopDetailHtml(detailHtml);
  if (detail.loginRequired) {
    return { ...item, needsDetail: false };
  }
  if (detail.businessStatus === "closed") {
    return { ...item, businessStatus: "closed", skipReason: "closed_or_not_open" };
  }
  const originalLink = detailUrl || item.originalLink;
  return {
    ...item,
    name: detail.name || item.name,
    address: detail.address || item.address,
    phone: detail.phone || item.phone || "",
    image: detail.image || "",
    latitude: detail.latitude ?? item.latitude ?? null,
    longitude: detail.longitude ?? item.longitude ?? null,
    originalLink,
    needsDetail: false,
    businessStatus: detail.address ? "open" : item.businessStatus,
  };
}

function toMerchantRecord(item, meta) {
  const now = new Date().toISOString();
  return {
    merchant_uid: `dianping:${item.shopId}`,
    source_id: item.shopId,
    source: "dianping",
    city: meta.city,
    search_keyword: meta.keyword,
    source_position: item.sourcePosition,
    name: item.name,
    address: item.address || "",
    district: item.district || "",
    category: item.category || "",
    image: item.image || "",
    original_link: item.originalLink,
    list_region_text: item.listRegionText || "",
    phone: item.phone || "",
    latitude: item.latitude ?? null,
    longitude: item.longitude ?? null,
    review_count: item.reviewCount ?? null,
    avg_price: item.avgPrice || "",
    business_status: item.businessStatus || "open",
    needs_detail: 0,
    import_batch_id: meta.importBatchId || "",
    updated_at: now,
  };
}

module.exports = {
  CLOSED_MARKERS,
  DIANPING_CITY_IDS,
  buildSearchUrl,
  collectNextPagePaths,
  decodeHtml,
  enrichWithDetail,
  extractSearchBasePath,
  extractShopListBlock,
  isClosedShop,
  isLoginWall,
  normalizeImageUrl,
  parseSearchListHtml,
  parseShopDetailHtml,
  parseListItemImage,
  parseShopDetailImage,
  toMerchantRecord,
};

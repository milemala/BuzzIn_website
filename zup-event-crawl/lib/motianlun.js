"use strict";

/**
 * 摩天轮票务（motianlun.cn）公开列表 / 详情读取。
 * 按分类抓取（演唱会 VocalConcert、Livehouse LOCAL_LIFE），
 * 并按演出日期是否落在指定窗口内筛选。
 */

const HOST = "https://www.motianlun.cn";
const VER = "6.83.0";
const SRC = "web";
const CONCERT_SHOW_TYPE = "VocalConcert";
const LIVEHOUSE_SHOW_TYPE = "LOCAL_LIFE";

const SHOW_CATEGORIES = {
  concert: { showType: CONCERT_SHOW_TYPE, label: "演唱会" },
  livehouse: { showType: LIVEHOUSE_SHOW_TYPE, label: "Livehouse" },
};

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseIsoDate(value) {
  const match = String(value || "").match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!match) return "";
  return `${match[1]}-${pad2(match[2])}-${pad2(match[3])}`;
}

function parseClock(value) {
  const match = String(value || "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return "";
  return `${pad2(match[1])}:${match[2]}`;
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00`);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

function todayIso(now = new Date()) {
  return formatDate(now);
}

/** 演出区间与 [windowStart, windowEnd] 有交集才留下。 */
function rangesOverlap(start, end, windowStart, windowEnd) {
  if (!start || !windowStart || !windowEnd) return false;
  const rangeEnd = end || start;
  return rangeEnd >= windowStart && start <= windowEnd;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function headers() {
  return {
    "content-type": "application/json",
    src: SRC,
    source: SRC,
    ver: VER,
    "X-Requested-With": "XMLHttpRequest",
    "user-agent": "Mozilla/5.0",
    origin: HOST,
    referer: `${HOST}/list/list`,
  };
}

async function request(method, apiPath, data) {
  const time = Date.now().toString();
  const url = new URL(apiPath, HOST);
  url.searchParams.set("time", time);
  url.searchParams.set("ver", VER);
  url.searchParams.set("src", SRC);
  const response = await fetch(url, {
    method,
    headers: headers(),
    body: method === "POST" ? JSON.stringify({ src: SRC, ver: VER, time, ...(data || {}) }) : undefined,
  });
  if (!response.ok) {
    throw new Error(`摩天轮 ${method} ${apiPath} HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.statusCode && payload.statusCode !== 200) {
    throw new Error(`摩天轮 ${apiPath} ${payload.statusCode} ${payload.comments || ""}`);
  }
  return payload;
}

async function fetchCityIndex() {
  const payload = await request("GET", "/showapi/cities");
  const groups = payload.result?.allCities || [];
  const byName = new Map();
  for (const group of groups) {
    for (const city of group.cities || []) {
      const name = String(city.cityName || "").trim();
      const cityOID = String(city.cityOID || "").trim();
      if (name && cityOID && !byName.has(name)) byName.set(name, cityOID);
    }
  }
  return byName;
}

async function listCityShows(cityOID, showType = CONCERT_SHOW_TYPE) {
  const shows = [];
  let offset = 0;
  const length = 50;
  for (let page = 0; page < 40; page += 1) {
    const payload = await request("POST", "/mtl_recommendapi/pub/search/v4/find_show_list", {
      cityId: cityOID,
      showCityList: [cityOID],
      showType,
      sorting: "weight",
      keyword: "",
      offset,
      length,
    });
    const batch = payload.data?.searchData || [];
    shows.push(...batch);
    const total = Number(payload.data?.pagination?.total || 0);
    offset += batch.length;
    if (!batch.length || payload.data?.isLastPage || (total && offset >= total)) break;
  }
  return shows;
}

async function listCityConcerts(cityOID) {
  return listCityShows(cityOID, CONCERT_SHOW_TYPE);
}

async function fetchShowDetail(showId) {
  const payload = await request("GET", `/showapi/pub/show/${encodeURIComponent(showId)}`);
  return payload.result?.data || null;
}

function isCancelledShow(show) {
  const status = `${show?.showStatus?.name || show?.showStatus || ""} ${show?.showStatus?.displayName || ""} ${show?.showStatusDisplayName || ""}`;
  return /取消|已结束|已下架|Cancel|Closed|Ended/i.test(status);
}

function showLink(showId) {
  return `${HOST}/show-detail/show-detail/${showId}`;
}

/**
 * 把详情（缺失时用列表项）收成审核台活动字段。不在窗口内返回 null。
 */
function toReviewEvent(listItem, detail, options) {
  const show = detail || {};
  const showId = String(show.showOID || listItem.showId || "").trim();
  const title = String(show.showName || listItem.showName || "").replace(/\s+/g, " ").trim();
  const city = String(options.city || show.cityName || listItem.showCity || "").trim();
  if (!showId || !title || !city) return { skip: "缺少标题或编号" };

  if (isCancelledShow(show) || isCancelledShow(listItem)) return { skip: "已取消或已结束" };

  const listedCity = String(show.cityName || listItem.showCity || "").trim();
  if (listedCity && listedCity !== city) return { skip: `场次城市是${listedCity}` };

  const startDate = parseIsoDate(show.firstShowTime || show.showDate || listItem.showDate);
  const endDate = parseIsoDate(show.lastShowTime || show.showDate || listItem.showDate) || startDate;
  if (!rangesOverlap(startDate, endDate, options.windowStart, options.windowEnd)) {
    return { skip: "不在一个月窗口内" };
  }

  const clock = parseClock(show.latestShowTime || show.firstShowTime_weekday || show.showDate || listItem.showDate);
  const startLabel = clock ? `${startDate} ${clock}` : startDate;
  const endLabel = clock && endDate !== startDate ? `${endDate} ${clock}` : endDate;
  const timeText = startDate === endDate ? startLabel : `${startLabel} 至 ${endLabel}`;

  const venueName = String(show.venueName || listItem.venueName || "").trim();
  const venueAddress = String(show.venueAddress || "").trim();
  const location = [venueName, venueAddress].filter(Boolean).join(" ");
  const minPrice = Number(show.minPrice ?? listItem.priceInfo?.yuanNum ?? NaN);
  const fee = Number.isFinite(minPrice) && minPrice > 0 ? `${minPrice}元起` : "";
  const typeLabel = String(options.typeLabel || "演唱会").trim();
  const showType = String(options.showType || CONCERT_SHOW_TYPE).trim();
  const contentText = stripHtml(show.content);
  const rawDetailText = [
    `类型：${typeLabel}`,
    `时间：${timeText}`,
    venueName ? `场馆：${venueName}` : "",
    venueAddress ? `地址：${venueAddress}` : "",
    fee ? `票价：${fee}` : "",
    contentText && contentText !== title ? `介绍：${contentText.slice(0, 400)}` : "",
  ].filter(Boolean).join("\n");

  const latitude = Number(show.venueLat);
  const longitude = Number(show.venueLng);

  return {
    event: {
      id: showId,
      source: "motianlun",
      sourceName: "摩天轮",
      sourceUrl: showLink(showId),
      sourceListPage: `${HOST}/list/list?showType=${showType}&cityId=${options.cityOID}`,
      city,
      title,
      startDate,
      endDate,
      timeText,
      location,
      latitude: Number.isFinite(latitude) ? latitude : null,
      longitude: Number.isFinite(longitude) ? longitude : null,
      image: String(show.posterURL || listItem.imgUrl || "").trim(),
      fee,
      owner: "摩天轮",
      rawDetailText,
      originalLink: showLink(showId),
      douban_event_type: typeLabel,
    },
  };
}

module.exports = {
  CONCERT_SHOW_TYPE,
  HOST,
  LIVEHOUSE_SHOW_TYPE,
  SHOW_CATEGORIES,
  addDays,
  fetchCityIndex,
  fetchShowDetail,
  listCityConcerts,
  listCityShows,
  parseIsoDate,
  rangesOverlap,
  todayIso,
  toReviewEvent,
};

"use strict";

const DEFAULT_PUBLISH_USER_ID = "579362104";
const DEFAULT_NOW_TYPE = 3;
const VALID_NOW_TYPES = new Set([1, 2, 3]);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseStoredDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const full = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (full) {
    return new Date(
      Number(full[1]),
      Number(full[2]) - 1,
      Number(full[3]),
      Number(full[4]),
      Number(full[5]),
      Number(full[6]),
    );
  }
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 0, 0, 0);
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 入库时间格式：2006-01-02 15:04:05 */
function formatImportDateTime(value) {
  const date = parseStoredDateTime(value);
  if (!date) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function getEndDateValue(event) {
  const raw = event.endDate || event.end_date || event.startDate || event.start_date || "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function todayDateValue() {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function isExpired(event) {
  const endDate = getEndDateValue(event);
  return endDate ? endDate < todayDateValue() : false;
}

function splitLocation(location) {
  const text = String(location || "").trim();
  if (!text) return { name: "", address: "" };
  const parts = text.split(/\s+/);
  if (parts.length === 1) return { name: text, address: text };
  return { name: parts[0], address: text };
}

function resolveStartAt(event) {
  return formatImportDateTime(event.start_at || event.startDate || event.start_date);
}

function resolveExpiredAt(event) {
  const fromExplicit = formatImportDateTime(event.expired_at);
  if (fromExplicit) return fromExplicit;
  const fromEnd = formatImportDateTime(event.endDate || event.end_date);
  if (fromEnd) return fromEnd;
  const fromStart = formatImportDateTime(event.startDate || event.start_date);
  if (fromStart) {
    const date = parseStoredDateTime(event.startDate || event.start_date);
    if (date && !String(event.startDate || event.start_date).includes(":")) {
      return formatImportDateTime(`${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} 23:59:59`);
    }
    return fromStart;
  }
  return "";
}

function hasEventStarted(event) {
  const raw = event?.startDate || event?.start_date || "";
  const start = new Date(raw);
  if (Number.isNaN(start.getTime())) return false;
  return start.getTime() <= Date.now();
}

/** 未开始 → 3 预约；已开始 → 2 即刻邀约 */
function suggestNowType(event) {
  return hasEventStarted(event) ? 2 : 3;
}

function normalizeNowType(value, event = null) {
  const n = Number(value);
  if (VALID_NOW_TYPES.has(n)) return n;
  if (event) return suggestNowType(event);
  return DEFAULT_NOW_TYPE;
}

function parsePoiCandidates(event) {
  const raw = event.poi_candidates;
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 入库坐标只认已选 POI，不用豆瓣原始经纬度 */
function resolvePoiCoordinates(event) {
  const poiId = String(event.location_poi_id || "").trim();
  if (!poiId) {
    return { latitude: null, longitude: null };
  }

  const fromColumn = (key) => {
    if (event[key] == null || event[key] === "") return null;
    const value = Number(event[key]);
    return Number.isFinite(value) ? value : null;
  };
  const colLat = fromColumn("poi_latitude");
  const colLng = fromColumn("poi_longitude");
  if (colLat != null && colLng != null && !(colLat === 0 && colLng === 0)) {
    return { latitude: colLat, longitude: colLng };
  }

  const match = parsePoiCandidates(event).find((item) => item.poi_id === poiId);
  if (match && match.latitude != null && match.longitude != null) {
    return {
      latitude: Number(match.latitude),
      longitude: Number(match.longitude),
    };
  }

  return { latitude: null, longitude: null };
}

function importReadyIssues(event) {
  const issues = [];
  if (!String(event.publish_user_id || "").trim()) issues.push("未设置发布者 user_id");
  if (!VALID_NOW_TYPES.has(Number(event.now_type))) issues.push("now_type 无效");
  if (!String(event.title || "").trim()) issues.push("缺少标题");
  if (!String(event.location_poi_id || "").trim()) issues.push("未匹配 POI");
  const poiCoords = resolvePoiCoordinates(event);
  if (poiCoords.latitude == null || poiCoords.longitude == null) issues.push("缺少 POI 坐标");
  if (!resolveStartAt(event)) issues.push("缺少开始时间");
  if (!resolveExpiredAt(event)) issues.push("缺少过期时间");
  if (isExpired(event)) issues.push("活动已过期");
  return issues;
}

function isImportReady(event) {
  return importReadyIssues(event).length === 0;
}

function buildImportContent(event, maxLen = 2000) {
  const timeText = String(event.timeText || event.time_text || "").trim();
  const body = String(event.body || "").trim();
  const parts = [];

  if (timeText) parts.push(timeText);
  if (body && (!timeText || !body.startsWith(timeText))) {
    parts.push(body);
  }

  return parts.join("\n\n").slice(0, maxLen);
}

function resolveNowMerchantId(event, options = {}) {
  const explicit = String(event.now_merchant_id || "").trim();
  if (explicit) return explicit;
  const poiId = String(event.location_poi_id || "").trim();
  if (!poiId || typeof options.findMerchantIdByPoi !== "function") return "";
  return String(options.findMerchantIdByPoi(poiId) || "").trim();
}

function buildImportRecord(event, options = {}) {
  const loc = splitLocation(event.location);
  const images = [];
  if (event.image) images.push(event.image);
  const poiCoords = resolvePoiCoordinates(event);
  const nowMerchantId = resolveNowMerchantId(event, options);

  const publishUserId = String(event.publish_user_id || DEFAULT_PUBLISH_USER_ID).trim();
  const record = {
    publish_user_id: publishUserId,
    user_id: publishUserId,
    now_title: String(event.title || "").slice(0, 128),
    now_content: buildImportContent(event),
    now_type: normalizeNowType(event.now_type, event),
    images,
    group_id: "",
    location_poi_id: event.location_poi_id || "",
    location_name: event.poi_title || loc.name,
    location_address: event.poi_address || loc.address || event.location || "",
    location_latitude: poiCoords.latitude,
    location_longitude: poiCoords.longitude,
    start_at: resolveStartAt(event),
    expired_at: resolveExpiredAt(event),
  };
  if (nowMerchantId) {
    record.now_merchant_id = nowMerchantId;
  }
  return record;
}

function buildPoiKeywordForEvent(event) {
  const { suggestEventPoiKeyword } = require("./tencent-poi");
  return suggestEventPoiKeyword(event.location, event.city, event.title);
}

module.exports = {
  DEFAULT_NOW_TYPE,
  DEFAULT_PUBLISH_USER_ID,
  VALID_NOW_TYPES,
  hasEventStarted,
  suggestNowType,
  buildImportContent,
  buildImportRecord,
  buildPoiKeywordForEvent,
  formatImportDateTime,
  importReadyIssues,
  isExpired,
  isImportReady,
  normalizeNowType,
  resolveExpiredAt,
  resolveNowMerchantId,
  resolvePoiCoordinates,
  resolveStartAt,
  splitLocation,
};

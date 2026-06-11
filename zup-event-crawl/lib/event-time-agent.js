"use strict";

const { parseDoubanEventTime } = require("./douban-detail");
const { formatDateTime, parseEventTimeFromText, datePart } = require("./event-time-parse");

const TIME_SOURCE_AGENT = "agent";
const TIME_SOURCE_PENDING = "pending";
const TIME_SOURCE_JS = "js_fallback";

const DATETIME_RE = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/;

function isValidDateTime(value) {
  return DATETIME_RE.test(String(value || "").trim());
}

function isoToImportDatetime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return formatDateTime(
    d.getFullYear(),
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  );
}

function finishSameDayEndAt(start_at, expired_at) {
  if (!start_at) return expired_at;
  const startDay = start_at.slice(0, 10);
  const endDay = String(expired_at || "").slice(0, 10);
  const startClock = start_at.slice(11);
  const endClock = String(expired_at || "").slice(11);
  if (
    !expired_at
    || (startDay === endDay && startClock !== "00:00:00" && (endClock === "00:00:00" || start_at === expired_at))
  ) {
    return `${startDay} 23:59:59`;
  }
  return expired_at;
}

function validateTimeDecision(decision) {
  const errors = [];
  const eventUid = String(decision?.event_uid || "").trim();
  if (!eventUid) errors.push("缺少 event_uid");
  if (!isValidDateTime(decision?.start_at)) errors.push("start_at 须为 YYYY-MM-DD HH:mm:ss");
  if (!isValidDateTime(decision?.expired_at)) errors.push("expired_at 须为 YYYY-MM-DD HH:mm:ss");
  if (errors.length) return { ok: false, errors };

  const start = new Date(decision.start_at.replace(" ", "T"));
  const end = new Date(decision.expired_at.replace(" ", "T"));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    errors.push("时间格式无效");
    return { ok: false, errors };
  }
  if (end < start) errors.push("expired_at 不能早于 start_at");
  return { ok: errors.length === 0, errors };
}

function suggestDoubanTimeDecision(event, options = {}) {
  const eventUid = event.event_uid || event.eventUid;
  const html = event.raw_detail_html || event.rawDetailHtml || "";
  const parsed = parseDoubanEventTime(html);

  if (parsed?.startDate) {
    const start_at = isoToImportDatetime(parsed.startDate);
    let expired_at = isoToImportDatetime(parsed.endDate || parsed.startDate);
    expired_at = finishSameDayEndAt(start_at, expired_at);
    return {
      event_uid: eventUid,
      ok: true,
      start_at,
      expired_at,
      confidence: "high",
      reason: parsed.timeText ? `豆瓣详情：${parsed.timeText}` : "豆瓣 itemprop startDate/endDate",
      source: TIME_SOURCE_JS,
    };
  }

  const timeText = parsed?.timeText || event.time_text || event.timeText;
  if (timeText) {
    const fallback = parseEventTimeFromText(timeText, options);
    if (fallback.ok) {
      return {
        event_uid: eventUid,
        ok: true,
        start_at: fallback.start_at,
        expired_at: fallback.expired_at,
        confidence: fallback.confidence,
        reason: `豆瓣 time_text：${fallback.reason}`,
        source: TIME_SOURCE_JS,
      };
    }
  }

  return {
    event_uid: eventUid,
    ok: false,
    reason: "豆瓣详情无 itemprop 时间且 time_text 无法解析",
  };
}

function suggestXhsTimeDecision(event, options = {}) {
  const eventUid = event.event_uid || event.eventUid;
  const parsed = parseEventTimeFromText(event.time_text || event.timeText, options);
  if (!parsed.ok) {
    return {
      event_uid: eventUid,
      ok: false,
      reason: parsed.reason,
    };
  }
  return {
    event_uid: eventUid,
    ok: true,
    start_at: parsed.start_at,
    expired_at: parsed.expired_at,
    confidence: parsed.confidence,
    reason: parsed.reason,
    source: TIME_SOURCE_JS,
  };
}

function suggestTimeDecision(event, options = {}) {
  const source = String(event.source || "").trim();
  const uid = String(event.event_uid || event.eventUid || "");
  if (source === "douban" || uid.startsWith("douban:")) {
    return suggestDoubanTimeDecision(event, options);
  }
  if (source === "xiaohongshu" || uid.startsWith("xiaohongshu:")) {
    return suggestXhsTimeDecision(event, options);
  }
  if (event.raw_detail_html || event.rawDetailHtml) {
    return suggestDoubanTimeDecision(event, options);
  }
  return suggestXhsTimeDecision(event, options);
}

function syncEventDates(db, eventUid, startDate, endDate) {
  const { resolveEventDates: resolveDates } = require("./event-dates");
  const dates = resolveDates({
    start_date: datePart(startDate),
    end_date: datePart(endDate),
    startDate: datePart(startDate),
    endDate: datePart(endDate),
  });
  const deleteEventDates = db.prepare("DELETE FROM event_dates WHERE event_uid = ?");
  const insertEventDate = db.prepare("INSERT OR IGNORE INTO event_dates (event_uid, event_date) VALUES (?, ?)");
  deleteEventDates.run(eventUid);
  for (const eventDate of dates) insertEventDate.run(eventUid, eventDate);
  return dates;
}

module.exports = {
  TIME_SOURCE_AGENT,
  TIME_SOURCE_JS,
  TIME_SOURCE_PENDING,
  finishSameDayEndAt,
  isoToImportDatetime,
  suggestDoubanTimeDecision,
  suggestTimeDecision,
  suggestXhsTimeDecision,
  syncEventDates,
  validateTimeDecision,
};

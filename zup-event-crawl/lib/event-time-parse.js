"use strict";

const END_OF_DAY = "23:59:59";
const START_OF_DAY = "00:00:00";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateValue(year, month, day) {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function formatDateTime(year, month, day, hour, minute, second = 0) {
  return `${formatDateValue(year, month, day)} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

function parseClock(text) {
  const match = String(text || "").match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function dateKey(year, month, day) {
  return formatDateValue(year, month, day);
}

function addDate(year, month, day) {
  return { year, month, day, key: dateKey(year, month, day) };
}

function inferYear(month, day, options = {}) {
  const year = Number(options.year) || new Date().getFullYear();
  const anchor = options.anchorDate instanceof Date ? options.anchorDate : new Date(options.anchorDate || Date.now());
  const candidate = new Date(year, month - 1, day);
  const maxFuture = new Date(anchor);
  maxFuture.setMonth(maxFuture.getMonth() + 10);
  if (candidate > maxFuture) return year - 1;
  return year;
}

function collectDatesFromText(timeText, options = {}) {
  const text = String(timeText || "");
  const dates = new Map();

  const add = (month, day, yearHint = null) => {
    if (!month || !day) return;
    const year = yearHint || inferYear(month, day, options);
    const key = dateKey(year, month, day);
    dates.set(key, addDate(year, month, day));
  };

  // 6月12日-14日 / 6月12-14日 / 6月12日至14日
  const monthRangeRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:[—\-~～至到]|—)\s*(\d{1,2})\s*日?/g;
  let match = monthRangeRe.exec(text);
  while (match) {
    const month = Number(match[1]);
    const startDay = Number(match[2]);
    const endDay = Number(match[3]);
    const year = inferYear(month, startDay, options);
    for (let day = startDay; day <= endDay; day += 1) add(month, day, year);
    match = monthRangeRe.exec(text);
  }

  // 6月12日-6月14日
  const crossMonthRangeRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:[—\-~～至到]|—)\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g;
  match = crossMonthRangeRe.exec(text);
  while (match) {
    const startMonth = Number(match[1]);
    const startDay = Number(match[2]);
    const endMonth = Number(match[3]);
    const endDay = Number(match[4]);
    const year = inferYear(startMonth, startDay, options);
    let cursor = new Date(year, startMonth - 1, startDay);
    const end = new Date(year, endMonth - 1, endDay);
    while (cursor <= end) {
      add(cursor.getMonth() + 1, cursor.getDate(), cursor.getFullYear());
      cursor.setDate(cursor.getDate() + 1);
    }
    match = crossMonthRangeRe.exec(text);
  }

  // 6月12日 / 6月12号
  const monthDayRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g;
  match = monthDayRe.exec(text);
  while (match) {
    add(Number(match[1]), Number(match[2]));
    match = monthDayRe.exec(text);
  }

  // 6/12-6/21 or 6/12-21 or 6.12-6.21
  const slashRangeRe = /(?<![\d/])(\d{1,2})[./](\d{1,2})\s*(?:[—\-~～至到]|—)\s*(?:(\d{1,2})[./])?(\d{1,2})(?![\d:])/g;
  match = slashRangeRe.exec(text);
  while (match) {
    const startMonth = Number(match[1]);
    const startDay = Number(match[2]);
    const endMonth = match[3] ? Number(match[3]) : startMonth;
    const endDay = Number(match[4]);
    const year = inferYear(startMonth, startDay, options);
    let cursor = new Date(year, startMonth - 1, startDay);
    const end = new Date(year, endMonth - 1, endDay);
    while (cursor <= end) {
      add(cursor.getMonth() + 1, cursor.getDate(), cursor.getFullYear());
      cursor.setDate(cursor.getDate() + 1);
    }
    match = slashRangeRe.exec(text);
  }

  // single 6/12 or 6.14
  const slashSingleRe = /(?<![\d/])(\d{1,2})[./](\d{1,2})(?![\d:])/g;
  match = slashSingleRe.exec(text);
  while (match) {
    add(Number(match[1]), Number(match[2]));
    match = slashSingleRe.exec(text);
  }

  // 6月10-28日 (month once)
  const monthDashDayRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*[—\-~～至到]\s*(\d{1,2})\s*日?/g;
  match = monthDashDayRe.exec(text);
  while (match) {
    const month = Number(match[1]);
    const startDay = Number(match[2]);
    const endDay = Number(match[3]);
    const year = inferYear(month, startDay, options);
    for (let day = startDay; day <= endDay; day += 1) add(month, day, year);
    match = monthDashDayRe.exec(text);
  }

  const anchor = options.anchorDate instanceof Date ? options.anchorDate : new Date(options.anchorDate || Date.now());

  // 即日起至6月21日 / 即日起-9月20日
  const fromNowUntilRe = /即日起\s*[—\-~～至到]\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/;
  const fromNowUntil = fromNowUntilRe.exec(text);
  if (fromNowUntil) {
    add(anchor.getMonth() + 1, anchor.getDate(), anchor.getFullYear());
    add(Number(fromNowUntil[1]), Number(fromNowUntil[2]));
  } else if (/即日起/.test(text)) {
    add(anchor.getMonth() + 1, anchor.getDate(), anchor.getFullYear());
  }

  // 持续至6月14日 / 至6月21日（非「即日起至」已处理过的尾部）
  const untilRe = /(?:持续)?至\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/g;
  match = untilRe.exec(text);
  while (match) {
    add(Number(match[1]), Number(match[2]));
    match = untilRe.exec(text);
  }

  return [...dates.values()].sort((a, b) => {
    const da = new Date(a.year, a.month - 1, a.day);
    const db = new Date(b.year, b.month - 1, b.day);
    return da - db;
  });
}

function collectTimeRanges(timeText) {
  const text = String(timeText || "");
  const ranges = [];

  const dailyRe = /(?:每天|每日)\s*(\d{1,2}:\d{2})\s*[—\-~～至到]\s*(\d{1,2}:\d{2})/g;
  let match = dailyRe.exec(text);
  while (match) {
    const start = parseClock(match[1]);
    const end = parseClock(match[2]);
    if (start && end) ranges.push({ start, end, kind: "daily" });
    match = dailyRe.exec(text);
  }

  const rangeRe = /(\d{1,2}:\d{2})\s*[—\-~～至到]\s*(\d{1,2}:\d{2})/g;
  match = rangeRe.exec(text);
  while (match) {
    const start = parseClock(match[1]);
    const end = parseClock(match[2]);
    if (start && end) ranges.push({ start, end, kind: "range" });
    match = rangeRe.exec(text);
  }

  const singleRe = /(\d{1,2}:\d{2})(?:\s*起)?/g;
  match = singleRe.exec(text);
  while (match) {
    const start = parseClock(match[1]);
    if (start) ranges.push({ start, end: null, kind: "single" });
    match = singleRe.exec(text);
  }

  return ranges;
}

function pickDailyHours(timeText, ranges) {
  const daily = ranges.find((item) => item.kind === "daily");
  if (daily) return daily;
  const weekday = String(timeText || "").match(/(?:周二至周五|工作日)\s*(\d{1,2}:\d{2})\s*[—\-~～至到]\s*(\d{1,2}:\d{2})/);
  if (weekday) {
    const start = parseClock(weekday[1]);
    const end = parseClock(weekday[2]);
    if (start && end) return { start, end, kind: "daily" };
  }
  const weekend = String(timeText || "").match(/(?:周末|周六|周日|节假日)\s*(\d{1,2}:\d{2})\s*[—\-~～至到]\s*(\d{1,2}:\d{2})/);
  if (weekend) {
    const start = parseClock(weekend[1]);
    const end = parseClock(weekend[2]);
    if (start && end) return { start, end, kind: "daily" };
  }
  if (ranges.length === 1 && ranges[0].end) return ranges[0];
  return ranges.find((item) => item.end) || null;
}

function pickStartEndClock(timeText, ranges, sameDay) {
  const daily = pickDailyHours(timeText, ranges);
  if (daily && daily.end) {
    return { start: daily.start, end: daily.end };
  }
  const withRange = ranges.filter((item) => item.end);
  if (withRange.length) {
    const start = withRange.reduce((min, item) => (
      item.start.hour * 60 + item.start.minute < min.start.hour * 60 + min.start.minute ? item : min
    ));
    const end = withRange.reduce((max, item) => (
      item.end.hour * 60 + item.end.minute > max.end.hour * 60 + max.end.minute ? item : max
    ));
    return { start: start.start, end: end.end };
  }
  const singles = ranges.filter((item) => !item.end);
  if (singles.length) {
    const first = singles.reduce((min, item) => (
      item.start.hour * 60 + item.start.minute < min.start.hour * 60 + min.start.minute ? item : min
    ));
    return { start: first.start, end: null, sameDayEnd: true };
  }
  return { start: null, end: null, sameDay: sameDay !== false };
}

function resolveWeeklyRoundupEnd(anchor, options = {}) {
  if (options.summaryEndDate) {
    const raw = options.summaryEndDate;
    return raw instanceof Date ? raw : new Date(raw);
  }
  const end = new Date(anchor);
  const day = end.getDay();
  const daysUntilSunday = day === 0 ? 0 : 7 - day;
  end.setDate(end.getDate() + daysUntilSunday);
  return end;
}

function parseRecurringWeeklyTime(text, options = {}) {
  if (!/即日起/.test(text) || !/每周/.test(text)) return null;
  const anchor = options.anchorDate instanceof Date ? options.anchorDate : new Date(options.anchorDate || Date.now());
  const ranges = collectTimeRanges(text);
  const daily = pickDailyHours(text, ranges);
  const clocks = daily && daily.end
    ? { start: daily.start, end: daily.end }
    : pickStartEndClock(text, ranges, true);
  const weekEnd = resolveWeeklyRoundupEnd(anchor, options);
  const startAt = formatDateTime(
    anchor.getFullYear(),
    anchor.getMonth() + 1,
    anchor.getDate(),
    clocks.start?.hour ?? 0,
    clocks.start?.minute ?? 0,
    0,
  );
  const endAt = formatDateTime(
    weekEnd.getFullYear(),
    weekEnd.getMonth() + 1,
    weekEnd.getDate(),
    clocks.end?.hour ?? 23,
    clocks.end?.minute ?? 59,
    clocks.end ? 0 : 59,
  );
  return {
    ok: true,
    start_at: startAt,
    expired_at: endAt,
    start_date: startAt,
    end_date: endAt,
    confidence: "medium",
    reason: "即日起每周重复，结束取汇总周本周日（或 summaryEndDate）",
  };
}

function parseEventTimeFromText(timeText, options = {}) {
  const text = String(timeText || "").trim();
  if (!text) {
    return { ok: false, reason: "time_text 为空" };
  }

  const recurringWeekly = parseRecurringWeeklyTime(text, options);
  if (recurringWeekly) return recurringWeekly;

  const dates = collectDatesFromText(text, options);
  if (!dates.length) {
    // 持续至暑假等模糊表达
    if (/暑假|暑期/.test(text)) {
      const anchor = options.anchorDate instanceof Date ? options.anchorDate : new Date(options.anchorDate || Date.now());
      const year = anchor.getFullYear();
      const start = formatDateTime(year, anchor.getMonth() + 1, anchor.getDate(), 0, 0, 0);
      const end = formatDateTime(year, 8, 31, 21, 0, 0);
      return {
        ok: true,
        start_at: start,
        expired_at: end,
        start_date: start,
        end_date: end,
        confidence: "low",
        reason: "持续至暑假，按当年8月31日21:00结束估算",
      };
    }
    if ((/周末/.test(text) || /工作日/.test(text)) && /(\d{1,2}:\d{2})/.test(text)) {
      const anchor = options.anchorDate instanceof Date ? options.anchorDate : new Date(options.anchorDate || Date.now());
      const ranges = collectTimeRanges(text);
      const weekend = String(text).match(/周末[^；;]*?(\d{1,2}:\d{2})\s*[—\-~～至到]\s*(\d{1,2}:\d{2})/);
      const clocks = weekend
        ? { start: parseClock(weekend[1]), end: parseClock(weekend[2]) }
        : pickStartEndClock(text, ranges, true);
      const startDate = addDate(anchor.getFullYear(), anchor.getMonth() + 1, anchor.getDate());
      const endDate = new Date(anchor);
      const day = endDate.getDay();
      const daysUntilSunday = day === 0 ? 0 : 7 - day;
      endDate.setDate(endDate.getDate() + daysUntilSunday);
      const startAt = formatDateTime(
        startDate.year,
        startDate.month,
        startDate.day,
        clocks.start?.hour ?? 0,
        clocks.start?.minute ?? 0,
        0,
      );
      const endAt = formatDateTime(
        endDate.getFullYear(),
        endDate.getMonth() + 1,
        endDate.getDate(),
        clocks.end?.hour ?? 23,
        clocks.end?.minute ?? 59,
        clocks.end ? 0 : 59,
      );
      return {
        ok: true,
        start_at: startAt,
        expired_at: endAt,
        start_date: startAt,
        end_date: endAt,
        confidence: "medium",
        reason: "按周末/工作日时段，本周重复活动取即日起至本周日",
      };
    }
    if (/每周末|每周[五六日]/.test(text)) {
      const anchor = options.anchorDate instanceof Date ? options.anchorDate : new Date(options.anchorDate || Date.now());
      const ranges = collectTimeRanges(text);
      const clocks = pickStartEndClock(text, ranges, true);
      const startDate = addDate(anchor.getFullYear(), anchor.getMonth() + 1, anchor.getDate());
      const endDate = new Date(anchor);
      const day = endDate.getDay();
      const daysUntilSunday = day === 0 ? 0 : 7 - day;
      endDate.setDate(endDate.getDate() + daysUntilSunday);
      const startAt = formatDateTime(
        startDate.year,
        startDate.month,
        startDate.day,
        clocks.start?.hour ?? 0,
        clocks.start?.minute ?? 0,
        0,
      );
      const endAt = formatDateTime(
        endDate.getFullYear(),
        endDate.getMonth() + 1,
        endDate.getDate(),
        clocks.end?.hour ?? 23,
        clocks.end?.minute ?? 59,
        clocks.end ? 0 : 59,
      );
      return {
        ok: true,
        start_at: startAt,
        expired_at: endAt,
        start_date: startAt,
        end_date: endAt,
        confidence: "medium",
        reason: "即日起每周重复，按本周日至每日结束时间估算",
      };
    }
    return { ok: false, reason: "未能解析日期" };
  }

  const ranges = collectTimeRanges(text);
  const clocks = pickStartEndClock(text, ranges, dates.length === 1);
  const first = dates[0];
  const last = dates[dates.length - 1];
  const sameDay = first.key === last.key;

  let startHour = clocks.start?.hour ?? 0;
  let startMinute = clocks.start?.minute ?? 0;
  let endHour;
  let endMinute;
  let endSecond = 0;

  if (clocks.end) {
    endHour = clocks.end.hour;
    endMinute = clocks.end.minute;
  } else if (sameDay && clocks.start) {
    endHour = 23;
    endMinute = 59;
    endSecond = 59;
  } else {
    endHour = 23;
    endMinute = 59;
    endSecond = 59;
  }

  let endDateObj = last;
  let reason = "按 time_text 解析";
  if (sameDay && clocks.start && !clocks.end) {
    reason = "仅开始时刻，结束延至当天 23:59:59";
  } else if (!clocks.start && !clocks.end) {
    reason = "仅日期无时刻，开始 00:00:00、结束日 23:59:59";
  }

  const startOnlyRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*起/.exec(text);
  if (startOnlyRe && sameDay && !clocks.start && !clocks.end && !/[至到\-—]/.test(text.replace(startOnlyRe[0], ""))) {
    const end = new Date(first.year, first.month - 1, first.day);
    end.setDate(end.getDate() + 30);
    endDateObj = addDate(end.getFullYear(), end.getMonth() + 1, end.getDate());
    endHour = 23;
    endMinute = 59;
    endSecond = 59;
    reason = "仅有开始日（X日起），结束按展期30天估算至 23:59:59";
  }

  const start_at = formatDateTime(first.year, first.month, first.day, startHour, startMinute, 0);
  const expired_at = formatDateTime(endDateObj.year, endDateObj.month, endDateObj.day, endHour, endMinute, endSecond);

  return {
    ok: true,
    start_at,
    expired_at,
    start_date: start_at,
    end_date: expired_at,
    confidence: dates.length && (clocks.start || clocks.end || dates.length > 1) ? "high" : "medium",
    reason,
  };
}

/** @deprecated use parseEventTimeFromText */
function parseXhsTimeRange(timeText, options = {}) {
  const parsed = parseEventTimeFromText(timeText, options);
  if (!parsed.ok) return { startDate: null, endDate: null };
  return {
    startDate: parsed.start_date.slice(0, 10),
    endDate: parsed.end_date.slice(0, 10),
  };
}

function datePart(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(0, 10);
}

module.exports = {
  END_OF_DAY,
  START_OF_DAY,
  collectDatesFromText,
  collectTimeRanges,
  datePart,
  formatDateTime,
  parseEventTimeFromText,
  parseXhsTimeRange,
};

const DEFAULT_MAX_EVENT_DAYS = 90;

function formatDateValue(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseEventDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function toDateValue(raw) {
  const text = String(raw || "").trim();
  const dateOnly = text.slice(0, 10);
  const date = parseEventDate(dateOnly);
  if (!date) return "";
  return formatDateValue(date);
}

function buildEventDates(startDate, endDate, options = {}) {
  const maxDays = Number.isFinite(options.maxDays) ? options.maxDays : DEFAULT_MAX_EVENT_DAYS;
  const fromToday = options.fromToday !== false;
  const anchorDate = fromToday
    ? startOfDay(options.anchorDate || new Date())
    : null;

  const start = parseEventDate(startDate);
  const end = parseEventDate(endDate) || start;
  if (!start) return [];

  let rangeStart = startOfDay(start);
  if (anchorDate) {
    rangeStart = startOfDay(new Date(Math.max(rangeStart.getTime(), anchorDate.getTime())));
  }
  const rangeEnd = startOfDay(end);
  if (rangeEnd < rangeStart) return [];

  const capEnd = new Date(rangeStart);
  capEnd.setDate(capEnd.getDate() + maxDays - 1);
  const finalEnd = rangeEnd.getTime() > capEnd.getTime() ? capEnd : rangeEnd;

  const dates = [];
  const cursor = new Date(rangeStart);
  while (cursor <= finalEnd) {
    dates.push(formatDateValue(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

function mergeEventDates(storedDates, computedDates) {
  return [...new Set([...(storedDates || []), ...(computedDates || [])])].sort();
}

function resolveEventDates(event, options = {}) {
  const startDate = event.startDate || event.start_date;
  const endDate = event.endDate || event.end_date;
  const computed = buildEventDates(startDate, endDate, {
    ...options,
    fromToday: false,
  });
  return mergeEventDates(event.eventDates, computed);
}

function eventOccursOnDate(event, dateValue) {
  const start = toDateValue(event.startDate || event.start_date);
  const end = toDateValue(event.endDate || event.end_date) || start;
  if (start && end) return dateValue >= start && dateValue <= end;
  return (event.eventDates || []).includes(dateValue);
}

function collectFilterDates(events, todayValue, options = {}) {
  const maxDays = Number.isFinite(options.maxDays) ? options.maxDays : DEFAULT_MAX_EVENT_DAYS;
  const dates = new Set();

  for (const event of events) {
    const start = toDateValue(event.startDate || event.start_date);
    const end = toDateValue(event.endDate || event.end_date) || start;
    if (!start || !end) {
      for (const date of event.eventDates || []) {
        if (date >= todayValue) dates.add(date);
      }
      continue;
    }

    const rangeStart = start > todayValue ? start : todayValue;
    if (end < rangeStart) continue;

    const cursor = startOfDay(parseEventDate(`${rangeStart}T00:00:00`));
    const finalEnd = startOfDay(parseEventDate(`${end}T00:00:00`));
    let count = 0;
    while (cursor <= finalEnd && count < maxDays) {
      dates.add(formatDateValue(cursor));
      cursor.setDate(cursor.getDate() + 1);
      count += 1;
    }
  }

  return [...dates].sort();
}

function buildDateWindowFromEvents(events, options = {}) {
  return [...new Set(events.flatMap((event) => resolveEventDates(event, options)))].sort();
}

module.exports = {
  DEFAULT_MAX_EVENT_DAYS,
  buildDateWindowFromEvents,
  buildEventDates,
  collectFilterDates,
  eventOccursOnDate,
  formatDateValue,
  mergeEventDates,
  parseEventDate,
  resolveEventDates,
  toDateValue,
};

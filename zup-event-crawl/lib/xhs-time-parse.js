"use strict";

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateValue(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function collectDatesFromText(timeText, year) {
  const text = String(timeText || "");
  const dates = [];

  const monthDayRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
  let match = monthDayRe.exec(text);
  while (match) {
    dates.push(new Date(year, Number(match[1]) - 1, Number(match[2])));
    match = monthDayRe.exec(text);
  }

  const dotRe = /(?<![\d.])(\d{1,2})\.(\d{1,2})(?![\d.])/g;
  match = dotRe.exec(text);
  while (match) {
    dates.push(new Date(year, Number(match[1]) - 1, Number(match[2])));
    match = dotRe.exec(text);
  }

  return dates.filter((date) => !Number.isNaN(date.getTime()));
}

function parseXhsTimeRange(timeText, options = {}) {
  const year = Number(options.year) || new Date().getFullYear();
  const dates = collectDatesFromText(timeText, year);
  if (!dates.length) {
    return { startDate: null, endDate: null };
  }
  dates.sort((a, b) => a.getTime() - b.getTime());
  return {
    startDate: formatDateValue(dates[0]),
    endDate: formatDateValue(dates[dates.length - 1]),
  };
}

module.exports = {
  parseXhsTimeRange,
};

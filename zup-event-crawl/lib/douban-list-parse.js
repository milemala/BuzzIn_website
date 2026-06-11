"use strict";

const { buildEventDates } = require("./event-dates");

const LIST_ENTRY_RE = /<li class="list-entry"[\s\S]*?<\/li>\s*<\/ul>|<li class="list-entry"[\s\S]*?<\/li>/g;

function isShopListEntry(block) {
  return /list-shopitem/i.test(block);
}

function parseListEventIds(html) {
  const blocks = String(html || "").match(LIST_ENTRY_RE) || [];
  const ids = new Set();
  blocks.forEach((block) => {
    if (isShopListEntry(block)) return;
    const id = block.match(/event\/(\d+)\//)?.[1];
    if (id) ids.add(id);
  });
  return [...ids];
}

function parseListEvents(html, options = {}) {
  const city = options.city || "";
  const anchorDate = options.anchorDate || new Date();
  const fromToday = options.fromToday !== false;
  const blocks = String(html || "").match(LIST_ENTRY_RE) || [];
  const byUrl = new Map();

  blocks.forEach((block) => {
    if (isShopListEntry(block)) return;

    const url = block.match(/<a href="(https:\/\/www\.douban\.com\/event\/\d+\/)"/)?.[1];
    if (!url || byUrl.has(url)) return;

    const title = block.match(/<span itemprop="summary">([\s\S]*?)<\/span>/)?.[1] || "";
    const startDate = block.match(/itemprop="startDate" datetime="([^"]+)"/)?.[1] || "";
    const endDate = block.match(/itemprop="endDate" datetime="([^"]+)"/)?.[1] || "";
    const eventDates = buildEventDates(startDate, endDate, { fromToday, anchorDate });
    if (!eventDates.length) return;

    const location = block.match(/<meta itemscope itemprop="location" content="([^"]+)"/)?.[1] || "";
    const id = url.match(/event\/(\d+)\//)?.[1] || url;

    byUrl.set(url, {
      id,
      sourceUrl: url,
      city,
      title: title.replace(/<[^>]+>/g, "").trim(),
      startDate,
      endDate,
      eventDates,
      location,
    });
  });

  return [...byUrl.values()];
}

module.exports = {
  parseListEventIds,
  parseListEvents,
};

#!/usr/bin/env node
"use strict";

/**
 * 抓取摩天轮各城一个月内的演唱会或 Livehouse，写入审核台。
 *
 * 默认演唱会和 Livehouse 一起抓。只要其中一类时加 --category=。
 *
 *   node scripts/scrape-motianlun-concerts.js
 *   node scripts/scrape-motianlun-concerts.js --category=concert
 *   node scripts/scrape-motianlun-concerts.js --category=livehouse
 *   node scripts/scrape-motianlun-concerts.js --city=上海,大连 --days=30
 *   node scripts/scrape-motianlun-concerts.js --dry-run
 */

const path = require("path");
const { buildPendingClassificationFields } = require("../lib/event-classification");
const { eventTitleLocationDedupKey, isEventUnexpired } = require("../lib/event-content-dedup");
const { matchLowSocialEvent } = require("../lib/event-low-social-filter");
const { appendParticipationToBody } = require("../lib/event-participation");
const { composeScrapedEventImage } = require("../lib/compose-event-images-batch");
const {
  addDays,
  fetchCityIndex,
  fetchShowDetail,
  listCityShows,
  SHOW_CATEGORIES,
  todayIso,
  toReviewEvent,
} = require("../lib/motianlun");
const { importPayload, openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");

/** 审核台里已有的城市，外加用户点名的大连（合肥已在库里，这里一并列出）。 */
const DEFAULT_CITIES = [
  "上海", "成都", "北京", "深圳", "杭州", "武汉", "重庆", "广州", "天津", "南京",
  "西安", "长沙", "郑州", "苏州", "青岛", "厦门", "宁波", "无锡", "沈阳", "佛山",
  "福州", "石家庄", "合肥", "哈尔滨", "温州", "长春", "秦皇岛", "大连",
];

function parseArgs(argv) {
  const options = {
    cities: DEFAULT_CITIES,
    days: 30,
    dbPath: defaultDb,
    dryRun: false,
    skipCompose: false,
    concurrency: 4,
    category: "all",
  };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) {
      options.cities = arg.slice("--city=".length).split(",").map((item) => item.trim()).filter(Boolean);
    } else if (arg.startsWith("--days=")) {
      options.days = Number(arg.slice("--days=".length)) || 30;
    } else if (arg.startsWith("--db=")) {
      options.dbPath = arg.slice("--db=".length);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--skip-compose") {
      options.skipCompose = true;
    } else if (arg.startsWith("--concurrency=")) {
      options.concurrency = Math.max(1, Number(arg.slice("--concurrency=".length)) || 4);
    } else if (arg.startsWith("--category=")) {
      options.category = arg.slice("--category=".length).trim() || "all";
    }
  }
  if (!options.category || options.category === "all" || options.category === "both") {
    options.showCategories = [SHOW_CATEGORIES.concert, SHOW_CATEGORIES.livehouse];
  } else if (SHOW_CATEGORIES[options.category]) {
    options.showCategories = [SHOW_CATEGORIES[options.category]];
  } else {
    throw new Error(`不认识的分类：${options.category}（可用 all、concert、livehouse）`);
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  const width = Math.min(limit, items.length) || 1;
  await Promise.all(Array.from({ length: width }, () => run()));
  return results;
}

function loadForeignTitleLocationKeys(db) {
  const rows = db.prepare(`
    SELECT city, title, location, start_date, end_date
    FROM events
    WHERE source != 'motianlun'
  `).all();
  const keys = new Set();
  for (const row of rows) {
    if (!isEventUnexpired({ startDate: row.start_date, endDate: row.end_date })) continue;
    const key = eventTitleLocationDedupKey({
      city: row.city,
      title: row.title,
      location: row.location,
    });
    if (key) keys.add(key);
  }
  return keys;
}

function buildBody(event) {
  const when = event.timeText || event.startDate;
  const where = event.location || "场馆待定";
  const intro = `${event.title}，${when}，${where}。`;
  return appendParticipationToBody(intro, event);
}

async function scrapeCity(city, cityOID, options, foreignKeys) {
  const windowStart = todayIso();
  const windowEnd = addDays(windowStart, options.days);
  const summary = {
    city,
    listed: 0,
    kept: 0,
    skippedWindow: 0,
    skippedOther: 0,
    skippedLowSocial: 0,
    skippedSameTitle: 0,
    detailFailed: 0,
    composeOk: 0,
    composeFail: 0,
    samples: [],
  };

  const listed = await listCityShows(cityOID, options.showCategory.showType);
  summary.listed = listed.length;
  const detailed = await mapPool(listed, options.concurrency, async (item) => {
    await sleep(60);
    try {
      const detail = await fetchShowDetail(item.showId);
      return { item, detail };
    } catch (error) {
      summary.detailFailed += 1;
      console.warn(`  详情失败 ${item.showName}: ${error.message}`);
      return { item, detail: null };
    }
  });

  const events = [];
  for (const { item, detail } of detailed) {
    const mapped = toReviewEvent(item, detail, {
      city,
      cityOID,
      windowStart,
      windowEnd,
      showType: options.showCategory.showType,
      typeLabel: options.showCategory.label,
    });
    if (!mapped.event) {
      if (mapped.skip === "不在一个月窗口内") summary.skippedWindow += 1;
      else summary.skippedOther += 1;
      continue;
    }
    const event = {
      ...mapped.event,
      ...buildPendingClassificationFields(options.showCategory.label),
      body_source: "motianlun_source",
    };
    event.body = buildBody(event);
    const lowSocial = matchLowSocialEvent(event);
    if (lowSocial) {
      summary.skippedLowSocial += 1;
      console.log(`  跳过（${lowSocial.reason}）${event.title}`);
      continue;
    }
    const sameKey = eventTitleLocationDedupKey(event);
    if (sameKey && foreignKeys.has(sameKey)) {
      summary.skippedSameTitle += 1;
      console.log(`  跳过（审核台已有同名同地点）${event.title}`);
      continue;
    }
    events.push(event);
  }

  events.forEach((event, index) => {
    event.sourcePosition = index + 1;
  });

  if (!options.dryRun && !options.skipCompose) {
    for (const event of events) {
      if (!event.image) continue;
      try {
        const composed = await composeScrapedEventImage(event, { rootDir: root });
        if (composed.status === "ok") summary.composeOk += 1;
      } catch (error) {
        summary.composeFail += 1;
        console.warn(`  封面失败 ${event.title}: ${error.message}`);
      }
    }
  }

  summary.kept = events.length;
  summary.samples = events.slice(0, 5).map((event) => `${event.startDate} ${event.title}`);
  return { summary, events, windowStart, windowEnd };
}

async function main() {
  const options = parseArgs(process.argv);
  const cityIndex = await fetchCityIndex();
  const db = openDatabase(options.dbPath);
  const foreignKeys = loadForeignTitleLocationKeys(db);
  const summaries = [];

  try {
    for (const city of options.cities) {
      const cityOID = cityIndex.get(city);
      if (!cityOID) {
        console.warn(`找不到城市：${city}`);
        summaries.push({ city, missing: true, kept: 0 });
        continue;
      }
      console.log(`\n${city}（${cityOID}）`);
      const events = [];
      let windowStart = "";
      let windowEnd = "";
      for (const showCategory of options.showCategories) {
        const scoped = { ...options, showCategory };
        const result = await scrapeCity(city, cityOID, scoped, foreignKeys);
        windowStart = result.windowStart;
        windowEnd = result.windowEnd;
        result.summary.label = showCategory.label;
        summaries.push(result.summary);
        events.push(...result.events);
        console.log(`  ${showCategory.label} 列表 ${result.summary.listed} · 一个月内留下 ${result.summary.kept} · 窗口外 ${result.summary.skippedWindow} · 其他跳过 ${result.summary.skippedOther} · 规则丢弃 ${result.summary.skippedLowSocial} · 同名跳过 ${result.summary.skippedSameTitle}`);
        if (options.dryRun) {
          for (const line of result.summary.samples) console.log(`  · ${line}`);
        }
      }
      events.forEach((event, index) => {
        event.sourcePosition = index + 1;
      });
      if (options.dryRun || !events.length) continue;
      const labels = options.showCategories.map((item) => item.label).join("+");
      importPayload(db, {
        generatedAt: new Date().toISOString(),
        sourcePage: events[0].sourceListPage,
        city,
        events,
        note: `摩天轮${labels} ${windowStart} 至 ${windowEnd}`,
      }, { mode: "append-city", rootDir: root });
      console.log(`  已写入审核台 ${events.length} 条`);
    }
  } finally {
    db.close();
  }

  const kept = summaries.reduce((sum, row) => sum + (row.kept || 0), 0);
  const labelText = options.showCategories.map((item) => item.label).join("+");
  console.log(`\n完成：${options.cities.length} 个城市，留下 ${kept} 条${labelText}`);
  for (const row of summaries) {
    if (row.missing) console.log(`- ${row.city}：摩天轮没有这个城市`);
    else console.log(`- ${row.city} ${row.label || ""}：留下 ${row.kept}（列表 ${row.listed}）`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const {
  applyDoubanEventLocation,
  applyDoubanEventTime,
  cleanDetailText,
} = require("../lib/douban-detail");
const { buildPendingBodyFields } = require("../lib/event-body-agent");
const {
  DEFAULT_DETAIL_GAP_MS,
  DEFAULT_LIST_GAP_MS,
  DEFAULT_WAIT_MS,
  fetchDoubanViaChrome,
  isDoubanDetailUrl,
} = require("../lib/douban-chrome-fetch");
const { DoubanBlockedError, isDoubanBlockedError } = require("../lib/douban-block");
const { composeScrapedEventImage } = require("../lib/compose-event-images-batch");
const { ensureImageCached } = require("../lib/image-fetch");
const { batchEventAutoPoi } = require("../lib/event-poi-batch");
const { buildDateWindowFromEvents, buildEventDates } = require("../lib/event-dates");
const { buildPendingClassificationFields } = require("../lib/event-classification");
const { eventUidFor, importPayload, openDatabase, syncEventPoiCoordinates } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const imageCacheDir = path.join(root, "data", "image-cache");

const { buildDoubanWeekListUrl, listDoubanCityNames, resolveDoubanCity } = require("../lib/douban-cities");

const args = process.argv.slice(2);
const optionArgs = args.filter((arg) => arg.startsWith("--"));
const positionalArgs = args.filter((arg) => !arg.startsWith("--"));
const limit = Number(positionalArgs[0] || 20);
const output = positionalArgs[1] || path.join(process.cwd(), "data", "review.db");
const cityOption = optionArgs.find((arg) => arg.startsWith("--city="))?.split("=")[1];
const mode = optionArgs.find((arg) => arg.startsWith("--mode="))?.split("=")[1] || "merge-city";
const sortMode = optionArgs.find((arg) => arg.startsWith("--sort="))?.split("=")[1] || "source";
const listFiles = optionArgs
  .filter((arg) => arg.startsWith("--list-file="))
  .map((arg) => arg.slice("--list-file=".length));
const listDirOption = optionArgs.find((arg) => arg.startsWith("--list-dir="))?.split("=")[1];
const detailDirOption = optionArgs.find((arg) => arg.startsWith("--detail-dir="))?.split("=")[1];
const maxPages = Math.max(1, Number(
  optionArgs.find((arg) => arg.startsWith("--max-pages="))?.split("=")[1] || 8,
));
const viaFetch = optionArgs.includes("--via-fetch");
const skipCompose = optionArgs.includes("--skip-compose");
const withPoi = optionArgs.includes("--with-poi");
if (withPoi) {
  console.warn("[已废弃] --with-poi：活动 POI 请由 Cursor Agent 在抓取后匹配，见 docs/event-poi-agent-workflow.md");
}
const chromeWaitMs = Math.max(2000, Number(
  optionArgs.find((arg) => arg.startsWith("--chrome-wait="))?.split("=")[1] || DEFAULT_WAIT_MS,
));
const cityInfo = resolveDoubanCity(cityOption) || resolveDoubanCity("上海");
if (!cityInfo) {
  parseArgsError(`Unknown city: ${cityOption || "(empty)"}. Supported: ${listDoubanCityNames().join("、")}`);
}
const city = cityInfo.name;
const citySlug = cityInfo.slug;
const listUrlKind = cityInfo.listKind;
const sourcePage = buildDoubanWeekListUrl(citySlug, listUrlKind);
const sourcePages = Array.from({ length: maxPages }, (_, index) => (
  index === 0 ? sourcePage : `${sourcePage}?start=${index * 10}`
));
const scrapeAnchor = new Date();
scrapeAnchor.setHours(0, 0, 0, 0);

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#47;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpace(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value) {
  return decodeHtml(String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " "));
}

function matchOne(text, pattern) {
  const match = text.match(pattern);
  return match ? decodeHtml(match[1]) : "";
}

function formatDate(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseArgsError(message) {
  throw new Error(`${message}\nUsage: node scripts/scrape-douban-week-events.js [limit] [output] [--city=城市名或slug] [--mode=merge-city|append-city|replace-city|replace-all] [--sort=source|score] [--max-pages=N] [--chrome-wait=ms] [--via-fetch] [--skip-compose] [--with-poi] [--list-file=path] [--list-dir=path] [--detail-dir=path]`);
}

if (!Number.isFinite(limit) || limit <= 0) {
  parseArgsError(`Invalid limit: ${positionalArgs[0]}`);
}

if (!["merge-city", "append-city", "replace-city", "replace-all"].includes(mode)) {
  parseArgsError(`Invalid mode: ${mode}`);
}

if (!["source", "score"].includes(sortMode)) {
  parseArgsError(`Invalid sort mode: ${sortMode}`);
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}



function parseDoubanEventType(detailHtml) {
  return matchOne(detailHtml, /itemprop="eventType">([^<]+)</);
}

function getExcludeReason(event, eventType = "") {
  const type = String(eventType || event.doubanEventType || "").trim();
  const haystack = `${event.title} ${event.owner} ${event.location} ${event.detailText || event.rawDetailText || ""}`;

  if (type) {
    if (/^戏剧-戏曲/.test(type) || /^戏曲/.test(type)) return "戏曲";
    if (/^公益/.test(type)) return "公益";
    if (/^课程/.test(type)) return "课程";
  }

  if (/戏曲|京剧|昆曲|豫剧|越剧|黄梅戏|评剧|沪剧|秦腔|粤剧|川剧|梆子|折子戏|梨园/.test(haystack)) {
    return "戏曲";
  }
  if (/公益/.test(`${event.title} ${event.owner}`)) return "公益";
  if (/课程|培训课|认证课|体验课|学习班|研习班/.test(event.title || "")) return "课程";
  return "";
}

function isLegacyFileTarget(filePath) {
  return filePath.endsWith(".js") || filePath.endsWith(".json");
}

function isDatabaseTarget(filePath) {
  return filePath.endsWith(".db");
}

function loadExistingDoubanIds(filePath, targetCity) {
  if (!isDatabaseTarget(filePath) || !fs.existsSync(filePath)) return new Set();
  const db = openDatabase(filePath);
  try {
    const rows = db.prepare(`
      SELECT source_id
      FROM events
      WHERE source = 'douban' AND city = ?
    `).all(targetCity);
    return new Set(rows.map((row) => String(row.source_id || "").trim()).filter(Boolean));
  } finally {
    db.close();
  }
}

function readExistingPayload(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return null;
  if (filePath.endsWith(".js")) {
    const match = raw.match(/^window\.CRAWLED_EVENTS\s*=\s*([\s\S]*);\s*$/);
    if (!match) return null;
    return JSON.parse(match[1]);
  }
  return JSON.parse(raw);
}

function buildOutputPayload(events) {
  return {
    generatedAt: new Date().toISOString(),
    sourcePage,
    city,
    dateWindow: buildDateWindowFromEvents(events),
    note: "本文件用于本地人工审核。保留原始抓取详情文本，body 为基于原文提炼的 Zup 活动简介。图片发布前需再次确认来源授权与平台规则。",
    events,
  };
}

function mergePayload(existingPayload, cityPayload) {
  if (!existingPayload || mode === "replace-all") {
    return cityPayload;
  }

  const existingEvents = Array.isArray(existingPayload.events) ? existingPayload.events : [];
  const keptEvents = mode === "replace-city"
    ? existingEvents.filter((event) => event.city !== city)
    : existingEvents.filter((event) => event.city !== city);
  const mergedEvents = [...keptEvents, ...cityPayload.events];
  const cityNames = [...new Set(mergedEvents.map((event) => event.city).filter(Boolean))];
  const dateWindow = buildDateWindowFromEvents(mergedEvents);
  const sourcePages = { ...(existingPayload.sourcePages || {}) };
  cityNames.forEach((name) => {
    if (existingPayload.cityMeta?.[name]?.sourcePage) {
      sourcePages[name] = existingPayload.cityMeta[name].sourcePage;
    }
  });
  sourcePages[city] = cityPayload.sourcePage;

  const cityMeta = { ...(existingPayload.cityMeta || {}) };
  cityMeta[city] = {
    generatedAt: cityPayload.generatedAt,
    sourcePage: cityPayload.sourcePage,
    eventCount: cityPayload.events.length,
  };

  if (cityNames.length === 1) {
    return {
      ...cityPayload,
      events: mergedEvents,
      dateWindow,
    };
  }

  return {
    generatedAt: new Date().toISOString(),
    city: "多城市",
    cities: cityNames,
    sourcePage: null,
    sourcePages,
    dateWindow,
    note: cityPayload.note || existingPayload.note || "",
    cityMeta,
    events: mergedEvents,
  };
}

function writePayload(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (filePath.endsWith(".js")) {
    fs.writeFileSync(filePath, `window.CRAWLED_EVENTS = ${JSON.stringify(payload, null, 2)};\n`);
    fs.writeFileSync(filePath.replace(/\.js$/, ".json"), `${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.writeFileSync(filePath.replace(/\.json$/, ".js"), `window.CRAWLED_EVENTS = ${JSON.stringify(payload, null, 2)};\n`);
}

function parseListEvents(html) {
  const blocks = html.match(/<li class="list-entry"[\s\S]*?<\/li>\s*<\/ul>|<li class="list-entry"[\s\S]*?<\/li>/g) || [];
  const byUrl = new Map();

  blocks.forEach((block) => {
    const url = matchOne(block, /<a href="(https:\/\/www\.douban\.com\/event\/\d+\/)"/);
    if (!url || byUrl.has(url)) return;

    const title = matchOne(block, /<span itemprop="summary">([\s\S]*?)<\/span>/);
    const image = matchOne(block, /<img[^>]+data-lazy="([^"]+)"/);
    const startDate = matchOne(block, /itemprop="startDate" datetime="([^"]+)"/);
    const endDate = matchOne(block, /itemprop="endDate" datetime="([^"]+)"/);
    const eventDates = buildEventDates(startDate, endDate, { fromToday: false, anchorDate: scrapeAnchor });
    if (!eventDates.length) return;

    const location = matchOne(block, /<meta itemscope itemprop="location" content="([^"]+)"/);
    const latitude = matchOne(block, /itemprop="latitude" content="([^"]+)"/);
    const longitude = matchOne(block, /itemprop="longitude" content="([^"]+)"/);
    const fee = stripTags(matchOne(block, /<li class="fee">([\s\S]*?)<\/li>/)).replace(/^费用：/, "").trim();
    const owner = stripTags(matchOne(block, /<span class="meta-title">发起：<\/span>([\s\S]*?)<\/li>/)).replace(/^发起：/, "").trim();
    const counts = stripTags(matchOne(block, /<p class="counts">([\s\S]*?)<\/p>/));
    const rawTimeText = stripTags(matchOne(block, /<li class="event-time">([\s\S]*?)<\/li>/)).replace(/^时间：/, "").trim();
    const district = location.replace(new RegExp(`^${city}\\s*`), "").split(/\s+/)[0] || "";

    byUrl.set(url, {
      id: url.match(/event\/(\d+)\//)?.[1] || url,
      source: "douban",
      sourceName: "豆瓣同城",
      sourceUrl: url,
      city,
      district,
      title,
      startDate,
      endDate,
      eventDates,
      timeText: rawTimeText,
      location,
      latitude: latitude ? Number(latitude) : null,
      longitude: longitude ? Number(longitude) : null,
      image,
      fee,
      owner,
      counts,
      originalLink: url,
    });
  });

  return [...byUrl.values()];
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
}

function readListHtmlFiles() {
  const files = [];
  if (listDirOption) {
    const dir = resolvePath(listDirOption);
    if (!fs.existsSync(dir)) throw new Error(`List dir not found: ${dir}`);
    files.push(...fs.readdirSync(dir)
      .filter((name) => /\.html?$/i.test(name))
      .sort()
      .map((name) => path.join(dir, name)));
  }
  files.push(...listFiles.map(resolvePath));
  return files;
}

function readDetailHtmlFromCache(event) {
  if (!detailDirOption) return null;
  const detailPath = path.join(resolvePath(detailDirOption), `${event.id}.html`);
  if (!fs.existsSync(detailPath)) return null;
  return fs.readFileSync(detailPath, "utf8");
}

function ingestListHtml(candidateMap, listHtml, pageUrl) {
  parseListEvents(listHtml).forEach((event) => {
    if (!candidateMap.has(event.id)) {
      event.sourcePosition = candidateMap.size + 1;
      event.sourceListPage = pageUrl;
      candidateMap.set(event.id, event);
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(fetchUrl, options = {}) {
  const retries = Number(options.retries) || 3;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(1200 * attempt);
    const response = await fetch(fetchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.8",
        "Referer": listUrlKind === "location"
          ? `https://www.douban.com/location/${citySlug}/`
          : `https://${citySlug}.douban.com/`,
      },
    });
    if (response.ok) return response.text();
    if (response.status === 403 || response.status === 429) {
      throw new DoubanBlockedError(`豆瓣 HTTP ${response.status}`, { url: fetchUrl, status: response.status });
    }
    lastError = new Error(`${response.status} ${fetchUrl}`);
    if (response.status !== 429 || attempt >= retries) throw lastError;
  }
  throw lastError;
}

async function fetchPageHtml(pageUrl) {
  if (viaFetch) {
    return fetchText(pageUrl);
  }
  const result = await fetchDoubanViaChrome(pageUrl, { waitMs: chromeWaitMs });
  return result.html;
}

async function loadListCandidates() {
  const candidateMap = new Map();
  const savedListFiles = readListHtmlFiles();
  if (savedListFiles.length) {
    savedListFiles.forEach((filePath, index) => {
      const listHtml = fs.readFileSync(filePath, "utf8");
      const pageUrl = sourcePages[Math.min(index, sourcePages.length - 1)] || sourcePage;
      ingestListHtml(candidateMap, listHtml, pageUrl);
      console.log(`Loaded list HTML: ${filePath} (${candidateMap.size} candidates so far)`);
    });
    return candidateMap;
  }

  if (!viaFetch) {
    console.log(`使用 Chrome 抓取豆瓣列表（已登录 Chrome + AppleScript）`);
  }

  for (const pageUrl of sourcePages) {
    try {
      const listHtml = await fetchPageHtml(pageUrl);
      ingestListHtml(candidateMap, listHtml, pageUrl);
      if (!viaFetch) {
        console.log(`List page OK: ${pageUrl} (${candidateMap.size} candidates)`);
        await sleep(DEFAULT_LIST_GAP_MS);
      }
    } catch (error) {
      if (isDoubanBlockedError(error)) throw error;
      console.warn(`Skip list page ${pageUrl}: ${error.message}`);
    }
  }

  if (candidateMap.size === 0) {
    throw new DoubanBlockedError(`豆瓣列表页未获取到任何活动（${city}，可能被风控或页面异常）`, { url: sourcePage });
  }
  return candidateMap;
}

function writeCityResults(events) {
  const cityPayload = buildOutputPayload(events);
  if (isLegacyFileTarget(output)) {
    const existingPayload = readExistingPayload(output);
    const finalPayload = mergePayload(existingPayload, cityPayload);
    writePayload(output, finalPayload);
  } else {
    const db = openDatabase(output);
    try {
      importPayload(db, cityPayload, { mode });
    } finally {
      db.close();
    }
  }
  return events;
}

async function autoPoiImportedEvents(importedEvents) {
  if (!isDatabaseTarget(output) || !withPoi || !importedEvents.length) return;
  const db = openDatabase(output);
  try {
    const eventUids = importedEvents.map((event) => eventUidFor(event));
    console.log(`POI Top1 匹配 ${eventUids.length} 条...`);
    const report = await batchEventAutoPoi(db, { event_uids: eventUids });
    const synced = syncEventPoiCoordinates(db);
    console.log(`POI: ${report.ok} 成功 / ${report.fail} 失败（无结果保持待审核）`);
    if (synced.updated) console.log(`POI 坐标同步: ${synced.updated} 条`);
  } finally {
    db.close();
  }
}

async function main() {
  const existingIds = loadExistingDoubanIds(output, city);
  const candidateMap = await loadListCandidates();
  const candidates = [...candidateMap.values()];
  const detailed = [];
  const counters = {
    listTotal: candidates.length,
    skippedExisting: 0,
    skippedExcluded: 0,
    detailFailed: 0,
    composeOk: 0,
    composeFail: 0,
  };

  for (const event of candidates) {
    if (existingIds.has(String(event.id))) {
      counters.skippedExisting += 1;
      continue;
    }

    const listExcludeReason = getExcludeReason(event);
    if (listExcludeReason) {
      counters.skippedExcluded += 1;
      console.log(`Skip list [${listExcludeReason}] ${event.title}`);
      continue;
    }

    try {
      let detailHtml = readDetailHtmlFromCache(event);
      if (!detailHtml) {
        if (!viaFetch && !detailDirOption) {
          console.log(`Detail Chrome: ${event.title}`);
        }
        detailHtml = await fetchPageHtml(event.originalLink);
        if (!viaFetch && isDoubanDetailUrl(event.originalLink)) {
          await sleep(DEFAULT_DETAIL_GAP_MS);
        }
      }
      event.rawDetailHtml = detailHtml;
      event.rawDetailText = cleanDetailText(detailHtml);
      event.detailText = event.rawDetailText;
      event.doubanEventType = parseDoubanEventType(detailHtml);
      applyDoubanEventLocation(event, detailHtml, city);
      applyDoubanEventTime(event, detailHtml);
      event.eventDates = [];
      const detailExcludeReason = getExcludeReason(event, event.doubanEventType);
      if (detailExcludeReason) {
        counters.skippedExcluded += 1;
        console.log(`Skip detail [${detailExcludeReason}/${event.doubanEventType || "未知类型"}] ${event.title}`);
        continue;
      }
      const largeImage = matchOne(detailHtml, /<img id="poster_img" itemprop="image" src="([^"]+)"/);
      if (largeImage) event.image = largeImage;
      if (event.image) {
        try {
          await ensureImageCached(event.image, imageCacheDir);
        } catch (cacheError) {
          event.imageCacheError = cacheError.message;
        }
        if (!skipCompose) {
          try {
            const composeResult = await composeScrapedEventImage(event, {
              rootDir: root,
              cacheDir: imageCacheDir,
            });
            if (composeResult.status === "ok") {
              counters.composeOk += 1;
            }
          } catch (composeError) {
            counters.composeFail += 1;
            event.imageComposeError = composeError.message;
            console.warn(`4:3 compose failed ${event.title}: ${composeError.message}`);
          }
        }
      }
    } catch (error) {
      if (isDoubanBlockedError(error)) {
        console.error(`\n豆瓣风控，暂停抓取（${city}）：${error.message}`);
        if (detailed.length) {
          const saved = writeCityResults(detailed.slice(0, limit));
          await autoPoiImportedEvents(saved);
          console.log(`已保存本城已抓取的 ${saved.length} 条后暂停`);
        }
        throw error;
      }
      counters.detailFailed += 1;
      event.detailText = "";
      event.rawDetailText = "";
      event.rawDetailHtml = "";
      event.detailError = error.message;
      console.warn(`Detail failed ${event.title}: ${error.message}`);
      continue;
    }
    const classification = buildPendingClassificationFields(event.doubanEventType);
    event.category = classification.category;
    event.score = classification.score;
    event.suggested = classification.suggested;
    event.reviewReason = classification.reviewReason;
    event.douban_event_type = classification.douban_event_type;
    event.classification_source = classification.classification_source;
    Object.assign(event, buildPendingBodyFields());
    delete event.detailText;
    detailed.push(event);
  }

  const ordered = sortMode === "score"
    ? [...detailed].sort((a, b) => b.score - a.score)
    : [...detailed].sort((a, b) => Number(a.sourcePosition) - Number(b.sourcePosition));
  const events = ordered.slice(0, limit);
  writeCityResults(events);
  await autoPoiImportedEvents(events);
  console.log(`Wrote ${events.length} new ${city} events to ${output} (${mode})`);
  console.log(`List ${counters.listTotal} · skipped existing ${counters.skippedExisting} · skipped excluded ${counters.skippedExcluded} · detail failed ${counters.detailFailed} · 4:3 composed ${counters.composeOk} · compose failed ${counters.composeFail}`);
  console.log(events.map((event) => `${event.sourcePosition}. ${event.score} ${event.category} ${event.title}`).join("\n"));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(isDoubanBlockedError(error) ? 2 : 1);
});

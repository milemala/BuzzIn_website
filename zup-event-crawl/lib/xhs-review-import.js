"use strict";

const fs = require("fs");
const path = require("path");
const { buildComposedImageUrl, saveComposedImage } = require("./composed-image");
const { composeEventPosterImage } = require("./event-image-compose");
const { buildXhsBodyFields } = require("./event-body-agent");
const { buildPendingClassificationFields } = require("./event-classification");
const { readImageFile } = require("./image-fetch");
const { buildScrapeLocalImageUrl, normalizeRelativePath } = require("./scrape-local-image");
const { composeXhsTextCover } = require("./xhs-text-cover-compose");
const { parseEventTimeFromText } = require("./event-time-parse");
const {
  eventContentDedupKey,
  loadContentDedupKeys,
} = require("./event-content-dedup");
const { openDatabase } = require("./review-db");

const XHS_SOURCE = "xiaohongshu";
const XHS_SOURCE_NAME = "小红书";

function xhsEventId(noteId, index) {
  return `${noteId}:${index}`;
}

function xhsEventUid(noteId, index) {
  return `${XHS_SOURCE}:${noteId}:${index}`;
}

function relFromRoot(absPath, rootDir) {
  return normalizeRelativePath(path.relative(rootDir, absPath));
}

function buildRawDetailText(extracted, event, noteDir) {
  const lines = [
    `分类：${event.category || "—"}`,
    `费用：${event.price || "—"}`,
    `时间：${event.time || "—"}`,
    `地址：${event.address || "—"}`,
  ];
  if (event.highlights) lines.push(`介绍：${event.highlights}`);
  lines.push(
    "",
    `来源账号：${extracted.account || "—"}`,
    `合集标题：${extracted.title || "—"}`,
    `来源笔记：${extracted.sourceUrl || "—"}`,
  );
  if (event.sourceImage) {
    lines.push(`原 slide：${path.join(path.basename(noteDir), event.sourceImage)}`);
  }
  if (event.poster) {
    lines.push(`裁切海报：${path.join(path.basename(noteDir), event.poster)}`);
  }
  return lines.join("\n");
}

function mapExtractedEventToReview(extracted, event, noteDir, rootDir, position) {
  const noteId = extracted.noteId;
  const id = xhsEventId(noteId, event.index);
  const parsedTime = parseEventTimeFromText(event.time, {
    year: new Date().getFullYear(),
  });
  const startDate = parsedTime.ok ? parsedTime.start_date : null;
  const endDate = parsedTime.ok ? parsedTime.end_date : null;

  const reviewEvent = {
    id,
    source: XHS_SOURCE,
    sourceName: XHS_SOURCE_NAME,
    sourcePosition: position,
    sourceUrl: extracted.sourceUrl || null,
    sourceListPage: extracted.sourceUrl || null,
    city: extracted.city || "未知城市",
    district: null,
    title: event.name || "",
    startDate,
    endDate,
    timeText: event.time || null,
    location: event.address || null,
    latitude: null,
    longitude: null,
    image: null,
    image_original: "",
    fee: event.price || null,
    owner: extracted.account || null,
    counts: null,
    rawDetailText: buildRawDetailText(extracted, event, noteDir),
    rawDetailHtml: null,
    originalLink: extracted.sourceUrl || null,
    xhsNoteId: noteId,
    xhsIndex: event.index,
    xhsCategory: event.category || null,
    xhsPosterRelative: event.poster || null,
    xhsSourceImageRelative: event.sourceImage || null,
  };

  Object.assign(reviewEvent, buildPendingClassificationFields());
  Object.assign(reviewEvent, buildXhsBodyFields(event));
  reviewEvent.reviewReason = `小红书一周合集 · ${extracted.account || "未知账号"} · 待分类 Agent`;

  return reviewEvent;
}

async function composePosterCoverFromFile(posterAbsPath, eventUid, rootDir, title) {
  const { buffer } = readImageFile(posterAbsPath);
  const composedBuffer = await composeEventPosterImage(buffer, { title });
  saveComposedImage(eventUid, composedBuffer, rootDir);
  return buildComposedImageUrl(eventUid);
}

async function composeTextCover(title, eventUid, rootDir, options = {}) {
  const { buffer } = await composeXhsTextCover(title, options);
  saveComposedImage(eventUid, buffer, rootDir);
  return buildComposedImageUrl(eventUid);
}

async function attachCoverImages(reviewEvent, noteDir, rootDir, options = {}) {
  const eventUid = xhsEventUid(reviewEvent.xhsNoteId, reviewEvent.xhsIndex);
  const posterAbs = reviewEvent.xhsPosterRelative
    ? path.join(noteDir, reviewEvent.xhsPosterRelative)
    : null;

  if (posterAbs && fs.existsSync(posterAbs)) {
    const originalRel = relFromRoot(posterAbs, rootDir);
    reviewEvent.image_original = buildScrapeLocalImageUrl(originalRel);
    if (!options.dryRun) {
      reviewEvent.image = await composePosterCoverFromFile(
        posterAbs,
        eventUid,
        rootDir,
        reviewEvent.title,
      );
    } else {
      reviewEvent.image = buildComposedImageUrl(eventUid);
    }
    return { mode: "poster", eventUid };
  }

  const sourceAbs = reviewEvent.xhsSourceImageRelative
    ? path.join(noteDir, reviewEvent.xhsSourceImageRelative)
    : null;
  if (sourceAbs && fs.existsSync(sourceAbs)) {
    reviewEvent.image_original = buildScrapeLocalImageUrl(relFromRoot(sourceAbs, rootDir));
  }

  if (!options.dryRun) {
    reviewEvent.image = await composeTextCover(reviewEvent.title, eventUid, rootDir, options.textCoverOptions);
  } else {
    reviewEvent.image = buildComposedImageUrl(eventUid);
  }
  return { mode: "text", eventUid };
}

function listXhsNoteDirs(xhsRoot, cityFilter = null) {
  if (!fs.existsSync(xhsRoot)) return [];
  const cities = fs.readdirSync(xhsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);

  const noteDirs = [];
  for (const city of cities) {
    if (cityFilter && city !== cityFilter) continue;
    const cityDir = path.join(xhsRoot, city);
    for (const entry of fs.readdirSync(cityDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const noteDir = path.join(cityDir, entry.name);
      const extractedFile = path.join(noteDir, "events-extracted.json");
      if (fs.existsSync(extractedFile)) {
        noteDirs.push({ city, noteDir, extractedFile });
      }
    }
  }
  return noteDirs;
}

async function loadReviewEventsFromNote(noteDir, rootDir, options = {}) {
  const extractedFile = path.join(noteDir, "events-extracted.json");
  const extracted = JSON.parse(fs.readFileSync(extractedFile, "utf8"));
  const events = (extracted.events || []).filter((event) => event.name && !event.needsVision);
  const reviewEvents = [];
  const coverStats = { poster: 0, text: 0, fail: 0 };
  const contentKeys = options.contentDedupKeys instanceof Set
    ? new Set(options.contentDedupKeys)
    : new Set();
  let skippedDuplicate = 0;

  let position = 1;
  for (const event of events) {
    const reviewEvent = mapExtractedEventToReview(extracted, event, noteDir, rootDir, position);
    const dedupKey = eventContentDedupKey(reviewEvent);
    if (contentKeys.has(dedupKey)) {
      skippedDuplicate += 1;
      if (options.log !== false) {
        console.log(`  跳过重复内容: ${reviewEvent.title}`);
      }
      continue;
    }
    contentKeys.add(dedupKey);
    position += 1;
    try {
      const cover = await attachCoverImages(reviewEvent, noteDir, rootDir, options);
      coverStats[cover.mode] += 1;
    } catch (error) {
      coverStats.fail += 1;
      reviewEvent.imageComposeError = error.message;
      if (options.log !== false) {
        console.error(`  封面失败 ${reviewEvent.title}: ${error.message}`);
      }
    }
    delete reviewEvent.xhsNoteId;
    delete reviewEvent.xhsIndex;
    delete reviewEvent.xhsCategory;
    delete reviewEvent.xhsPosterRelative;
    delete reviewEvent.xhsSourceImageRelative;
    reviewEvents.push(reviewEvent);
  }

  return { extracted, reviewEvents, coverStats, skippedDuplicate };
}

async function loadAllXhsReviewEvents(rootDir, options = {}) {
  const xhsRoot = path.join(rootDir, "data", "scrape-cache", "xhs");
  const noteDirs = listXhsNoteDirs(xhsRoot, options.city || null);
  const allEvents = [];
  const byCity = {};
  const totals = { poster: 0, text: 0, fail: 0, notes: 0, events: 0, skippedDuplicate: 0 };
  let contentDedupKeys = options.contentDedupKeys;
  if (!contentDedupKeys && options.dbPath && fs.existsSync(options.dbPath)) {
    const db = openDatabase(options.dbPath);
    try {
      contentDedupKeys = loadContentDedupKeys(db, {
        city: options.city || undefined,
        source: XHS_SOURCE,
      });
    } finally {
      db.close();
    }
  }

  for (const item of noteDirs) {
    if (options.log !== false) {
      console.log(`\n读取 ${item.city} / ${path.basename(item.noteDir)}`);
    }
    const { extracted, reviewEvents, coverStats, skippedDuplicate } = await loadReviewEventsFromNote(
      item.noteDir,
      rootDir,
      { ...options, contentDedupKeys },
    );
    totals.notes += 1;
    totals.events += reviewEvents.length;
    totals.skippedDuplicate += skippedDuplicate || 0;
    totals.poster += coverStats.poster;
    totals.text += coverStats.text;
    totals.fail += coverStats.fail;
    contentDedupKeys = contentDedupKeys || new Set();
    for (const event of reviewEvents) {
      contentDedupKeys.add(eventContentDedupKey(event));
    }
    if (!byCity[item.city]) {
      byCity[item.city] = { events: [], sourcePage: extracted.sourceUrl || null };
    }
    byCity[item.city].events.push(...reviewEvents);
    allEvents.push(...reviewEvents);
    if (options.log !== false) {
      const dupHint = skippedDuplicate ? ` · 跳过重复 ${skippedDuplicate}` : "";
      console.log(`  ${reviewEvents.length} 条 · 海报封面 ${coverStats.poster} · 文字封面 ${coverStats.text} · 失败 ${coverStats.fail}${dupHint}`);
    }
  }

  if (totals.skippedDuplicate && options.log !== false) {
    console.log(`\n内容去重：共跳过 ${totals.skippedDuplicate} 条（名称+地址+时间相同）`);
  }

  return { allEvents, byCity, totals, noteDirs };
}

function buildImportPayload(loadResult) {
  const cityMeta = {};
  const sourcePages = {};
  for (const [city, info] of Object.entries(loadResult.byCity)) {
    cityMeta[city] = {
      generatedAt: new Date().toISOString(),
      sourcePage: info.sourcePage,
      eventCount: info.events.length,
    };
    sourcePages[city] = info.sourcePage;
  }

  return {
    generatedAt: new Date().toISOString(),
    city: Object.keys(loadResult.byCity).length === 1 ? Object.keys(loadResult.byCity)[0] : "多城市",
    cities: Object.keys(loadResult.byCity),
    sourcePage: null,
    sourcePages,
    cityMeta,
    note: "小红书一周活动合集入库。封面：有裁切海报→4:3 左图右文；无海报→文字封面。POI 待后续批量匹配。",
    events: loadResult.allEvents,
  };
}

module.exports = {
  XHS_SOURCE,
  XHS_SOURCE_NAME,
  attachCoverImages,
  buildImportPayload,
  listXhsNoteDirs,
  loadAllXhsReviewEvents,
  loadReviewEventsFromNote,
  mapExtractedEventToReview,
  xhsEventId,
  xhsEventUid,
};

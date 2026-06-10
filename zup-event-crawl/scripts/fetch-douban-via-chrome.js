#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { sleep } = require("../lib/chrome-fetch");
const {
  DEFAULT_DETAIL_GAP_MS,
  DEFAULT_LIST_GAP_MS,
  fetchDoubanViaChrome,
} = require("../lib/douban-chrome-fetch");
const { isDoubanBlockedError } = require("../lib/douban-block");
const { openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const args = process.argv.slice(2);

const { buildDoubanWeekListUrl, resolveDoubanCity } = require("../lib/douban-cities");

function parseOptions(argv) {
  const cityInfo = resolveDoubanCity(argv.find((arg) => arg.startsWith("--city="))?.split("=")[1]) || resolveDoubanCity("北京");
  const city = cityInfo.name;
  const maxPages = Math.max(1, Number(
    argv.find((arg) => arg.startsWith("--max-pages="))?.split("=")[1] || 10,
  ));
  const waitMs = Math.max(2000, Number(
    argv.find((arg) => arg.startsWith("--wait-ms="))?.split("=")[1] || 4500,
  ));
  const dbPath = argv.find((arg) => !arg.startsWith("--") && arg.endsWith(".db"))
    || path.join(root, "data", "review.db");
  const cacheRoot = argv.find((arg) => arg.startsWith("--cache-dir="))?.split("=")[1]
    || path.join(root, "data", "scrape-cache", city);
  const listOnly = argv.includes("--list-only");
  const detailOnly = argv.includes("--detail-only");
  return { city, cityInfo, maxPages, waitMs, dbPath, cacheRoot, listOnly, detailOnly };
}

function listPageUrl(base, pageIndex) {
  return pageIndex === 0 ? base : `${base}?start=${pageIndex * 10}`;
}

function saveHtml(filePath, html) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, html);
}

function parseListIds(html) {
  return [...new Set([...html.matchAll(/event\/(\d+)\//g)].map((match) => match[1]))];
}

function loadExistingDoubanIds(dbPath, city) {
  if (!fs.existsSync(dbPath)) return new Set();
  const db = openDatabase(dbPath);
  try {
    const rows = db.prepare(`
      SELECT source_id FROM events WHERE source = 'douban' AND city = ?
    `).all(city);
    return new Set(rows.map((row) => String(row.source_id || "").trim()).filter(Boolean));
  } finally {
    db.close();
  }
}

async function fetchListPages(options) {
  const cityInfo = options.cityInfo || resolveDoubanCity(options.city);
  const base = buildDoubanWeekListUrl(cityInfo.slug, cityInfo.listKind);
  const listDir = path.join(options.cacheRoot, "list");
  const allIds = new Set();

  for (let page = 0; page < options.maxPages; page += 1) {
    const url = listPageUrl(base, page);
    const fileName = `${String(page + 1).padStart(2, "0")}-week-all${page === 0 ? "" : `-start-${page * 10}`}.html`;
    const filePath = path.join(listDir, fileName);
    console.log(`[list ${page + 1}/${options.maxPages}] ${url}`);
    const result = await fetchDoubanViaChrome(url, { waitMs: options.waitMs });
    saveHtml(filePath, result.html);
    parseListIds(result.html).forEach((id) => allIds.add(id));
    console.log(`  saved ${result.html.length} bytes -> ${filePath}`);
    await sleep(DEFAULT_LIST_GAP_MS);
  }

  return { listDir, allIds: [...allIds] };
}

async function fetchDetailPages(ids, options) {
  const detailDir = path.join(options.cacheRoot, "detail");
  const saved = [];
  const failed = [];

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const url = `https://www.douban.com/event/${id}/`;
    const filePath = path.join(detailDir, `${id}.html`);
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 8000) {
      console.log(`[detail ${index + 1}/${ids.length}] skip cached ${id}`);
      saved.push(id);
      continue;
    }
    console.log(`[detail ${index + 1}/${ids.length}] ${url}`);
    try {
      const result = await fetchDoubanViaChrome(url, { waitMs: options.waitMs });
      saveHtml(filePath, result.html);
      saved.push(id);
      console.log(`  saved ${result.html.length} bytes -> ${filePath}`);
    } catch (error) {
      if (isDoubanBlockedError(error)) throw error;
      failed.push({ id, error: error.message });
      console.error(`  FAIL ${id}: ${error.message}`);
    }
    await sleep(DEFAULT_DETAIL_GAP_MS);
  }

  return { detailDir, saved, failed };
}

async function main() {
  const options = parseOptions(args);
  const existingIds = loadExistingDoubanIds(options.dbPath, options.city);
  let missingIds = [];

  if (!options.detailOnly) {
    const listResult = await fetchListPages(options);
    missingIds = listResult.allIds.filter((id) => !existingIds.has(id));
    console.log(`List IDs ${listResult.allIds.length} · existing ${existingIds.size} · missing ${missingIds.length}`);
  } else {
    const listDir = path.join(options.cacheRoot, "list");
    if (fs.existsSync(listDir)) {
      const ids = new Set();
      for (const name of fs.readdirSync(listDir).filter((file) => /\.html?$/i.test(file))) {
        const html = fs.readFileSync(path.join(listDir, name), "utf8");
        parseListIds(html).forEach((id) => ids.add(id));
      }
      missingIds = [...ids].filter((id) => !existingIds.has(id));
    }
  }

  if (!options.listOnly && missingIds.length) {
    const detailResult = await fetchDetailPages(missingIds, options);
    console.log(`Detail saved ${detailResult.saved.length} · failed ${detailResult.failed.length}`);
    if (detailResult.failed.length) {
      detailResult.failed.forEach((row) => console.log(`  - ${row.id}: ${row.error}`));
    }
  } else if (!options.listOnly) {
    console.log("No missing detail pages to fetch.");
  }

  console.log(`Cache root: ${options.cacheRoot}`);
}

main().catch((error) => {
  console.error(error.message || error);
  if (error.code === "CHROME_JS_DENIED" || error.code === "CHROME_UNAVAILABLE") {
    console.error("请打开 Chrome 并登录豆瓣，且开启「允许 AppleScript 中的 JavaScript」。");
  }
  process.exit(isDoubanBlockedError(error) ? 2 : 1);
});

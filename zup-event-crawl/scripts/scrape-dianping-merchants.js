#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  DIANPING_CITY_IDS,
  buildSearchUrl,
  enrichWithDetail,
  isLoginWall,
  parseSearchListHtml,
  toMerchantRecord,
} = require("../lib/dianping-parse");
const { fetchViaChrome, sleep } = require("../lib/chrome-fetch");
const { importMerchants, openDatabase } = require("../lib/merchant-db");

const root = path.join(__dirname, "..");
const defaultDbPath = path.join(root, "data", "review.db");

function parseArgs(argv) {
  const options = {
    city: "上海",
    cityId: null,
    keyword: "",
    namePattern: "",
    htmlFiles: [],
    detailDir: "",
    dbPath: "",
    mode: "replace-keyword",
    dryRun: false,
    allowEmpty: false,
    jsonOut: "",
    offline: false,
    skipDetails: true,
    chromeWaitMs: 4500,
    detailWaitMs: 3500,
    maxPages: 20,
    pageDelayMs: 1200,
    detailDelayMs: 900,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--allow-empty") {
      options.allowEmpty = true;
    } else if (arg === "--offline") {
      options.offline = true;
    } else if (arg === "--skip-details") {
      options.skipDetails = true;
    } else if (arg === "--with-details") {
      options.skipDetails = false;
    } else if (arg.startsWith("--city=")) {
      options.city = arg.slice("--city=".length);
    } else if (arg.startsWith("--city-id=")) {
      options.cityId = Number(arg.slice("--city-id=".length));
    } else if (arg.startsWith("--keyword=")) {
      options.keyword = arg.slice("--keyword=".length);
    } else if (arg.startsWith("--name-pattern=")) {
      options.namePattern = arg.slice("--name-pattern=".length);
    } else if (arg.startsWith("--html-file=")) {
      options.htmlFiles.push(arg.slice("--html-file=".length));
      options.offline = true;
    } else if (arg.startsWith("--html-dir=")) {
      const dir = arg.slice("--html-dir=".length);
      const absDir = path.isAbsolute(dir) ? dir : path.join(root, dir);
      const names = fs.readdirSync(absDir).filter((name) => name.endsWith(".html")).sort();
      options.htmlFiles.push(...names.map((name) => path.join(absDir, name)));
      options.offline = true;
    } else if (arg.startsWith("--detail-dir=")) {
      options.detailDir = arg.slice("--detail-dir=".length);
    } else if (arg.startsWith("--db=")) {
      options.dbPath = arg.slice("--db=".length);
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg.startsWith("--json-out=")) {
      options.jsonOut = arg.slice("--json-out=".length);
    } else if (arg.startsWith("--chrome-wait=")) {
      options.chromeWaitMs = Number(arg.slice("--chrome-wait=".length));
    } else if (arg.startsWith("--detail-wait=")) {
      options.detailWaitMs = Number(arg.slice("--detail-wait=".length));
    } else if (arg.startsWith("--max-pages=")) {
      options.maxPages = Number(arg.slice("--max-pages=".length));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }

  if (!options.cityId) {
    options.cityId = DIANPING_CITY_IDS[options.city];
  }
  return options;
}

function printHelp() {
  console.log(`大众点评商户抓取（默认仅列表页，不打开详情，避免反爬）:

  node scripts/scrape-dianping-merchants.js \\
    --city=上海 --keyword=跳海

从列表取：店名、列表封面图、品类、商圈、点评链接。不抓街道地址。

前提：Google Chrome 已登录大众点评。入选规则见 merchant-social-filter.js。

可选：
  --with-details        打开详情页（易触发 403，一般不推荐）
  --offline --html-file=...   离线解析已保存 HTML
  --dry-run             不入库
  --mode=merge|replace-keyword
`);
}

function loadDetailHtml(detailDir, shopId) {
  if (!detailDir) return "";
  const absDir = path.isAbsolute(detailDir) ? detailDir : path.join(root, detailDir);
  const candidates = [
    path.join(absDir, `${shopId}.html`),
    path.join(absDir, `shop-${shopId}.html`),
  ];
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
  }
  return "";
}

function buildParseOptions(options) {
  const parseOptions = { searchKeyword: options.keyword || "" };
  if (options.namePattern) {
    parseOptions.namePattern = options.namePattern;
  }
  return parseOptions;
}

function saveDebugHtml(city, keyword, html) {
  const dir = path.join(root, "data", "scrape-cache", "dianping", "debug");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${city}-${keyword}-${Date.now()}.html`);
  fs.writeFileSync(file, html);
  return file;
}

function explainListFailure(parsed, shopCount) {
  if (parsed.parsedCount > 0 && parsed.filteredCount === 0) {
    const s = parsed.filterStats || {};
    return `列表已解析 ${parsed.parsedCount} 家，但社交门店规则全部筛掉（店名 ${s.byName || 0}，关键词 ${s.byKeyword || 0}，非饮酒类 ${s.byCategory || 0}，无关 ${s.byJunk || 0}）`;
  }
  if ((parsed.totalReported > 0 || shopCount > 0) && parsed.parsedCount === 0) {
    return `浏览器约有 ${parsed.totalReported || shopCount} 条结果，但抓取时列表 HTML 未就绪（与你在 Chrome 里看到的不一致，属抓取时机问题）`;
  }
  return "搜索页无匹配列表或该城市无此品牌门店";
}

function toAbsoluteDianpingUrl(href) {
  if (href.startsWith("http")) return href;
  return `https://www.dianping.com${href}`;
}

async function fetchSearchResultsViaChrome(options) {
  const parseOptions = buildParseOptions(options);
  const queue = [buildSearchUrl(options.cityId, options.keyword)];
  const visited = new Set();
  const merged = new Map();
  let totalReported = null;
  let lastParsed = null;
  let lastShopCount = 0;
  let lastHtml = "";

  console.log("\n[1/2] Chrome 自动搜索列表（仅列表页，不抓详情）…");
  console.log("      后台专用窗口，不抢焦点；请保持 Chrome 已登录大众点评。");

  while (queue.length && visited.size < options.maxPages) {
    const pageUrl = queue.shift();
    if (visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    console.log(`  → 列表页 ${visited.size}: ${pageUrl}`);
    let html = "";
    let parsed = { parsedCount: 0, filteredCount: 0, items: [], nextPagePaths: [], totalReported: 0 };
    let pageShopCount = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1) {
        console.log(`     列表未就绪，重试 1 次…`);
        await sleep(2000);
      }
      const fetched = await fetchViaChrome(pageUrl, {
        waitMs: options.chromeWaitMs + (attempt - 1) * 2500,
        expectShopList: true,
      });
      html = fetched.html;
      pageShopCount = fetched.shopCount || 0;
      lastShopCount = pageShopCount;
      lastHtml = html;
      if (isLoginWall(html)) {
        throw new Error(
          "大众点评要求登录：请先在 Chrome 打开 dianping.com 并完成登录，再重新运行本命令。",
        );
      }
      parsed = parseSearchListHtml(html, { ...parseOptions, searchUrl: pageUrl });
      lastParsed = parsed;
      if (parsed.parsedCount > 0) break;
    }
    if (totalReported == null) totalReported = parsed.totalReported;
    const stats = parsed.filterStats || {};
    console.log(
      `     页面约 ${parsed.totalReported ?? "?"} 条 | DOM ${pageShopCount} 家 | 解析 ${parsed.parsedCount} | 入选 ${parsed.filteredCount}`
      + (stats.byCategory ? ` | 品类筛掉 ${stats.byCategory}` : "")
      + (stats.byJunk ? ` | 无关店名 ${stats.byJunk}` : ""),
    );

    for (const item of parsed.items) {
      merged.set(item.shopId, item);
    }

    for (const href of parsed.nextPagePaths) {
      const nextUrl = toAbsoluteDianpingUrl(href);
      if (!visited.has(nextUrl) && !queue.includes(nextUrl)) {
        queue.push(nextUrl);
      }
    }

    if (queue.length) {
      await sleep(options.pageDelayMs);
    }
  }

  console.log(`  合计 ${merged.size} 家（搜索共约 ${totalReported ?? "?"} 条）`);
  const items = [...merged.values()].sort((a, b) => a.sourcePosition - b.sourcePosition);
  if (!items.length && lastParsed) {
    const debugFile = lastHtml ? saveDebugHtml(options.city, options.keyword, lastHtml) : "";
    const hint = explainListFailure(lastParsed, lastShopCount);
    return { items, skipReason: hint, debugFile };
  }
  return { items };
}

function loadSearchResultsFromFiles(options) {
  const parseOptions = buildParseOptions(options);
  const merged = new Map();
  for (const filePath of options.htmlFiles) {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
    const html = fs.readFileSync(absPath, "utf8");
    const parsed = parseSearchListHtml(html, parseOptions);
    console.log(`Parsed ${path.basename(absPath)}: ${parsed.filteredCount}/${parsed.parsedCount}`);
    for (const item of parsed.items) {
      merged.set(item.shopId, item);
    }
  }
  return [...merged.values()].sort((a, b) => a.sourcePosition - b.sourcePosition);
}

async function enrichDetailsViaChrome(items, options) {
  const detailDir = options.detailDir
    ? (path.isAbsolute(options.detailDir) ? options.detailDir : path.join(root, options.detailDir))
    : path.join(root, "data", "scrape-cache", "dianping", "details-auto");
  fs.mkdirSync(detailDir, { recursive: true });

  console.log("\n[2/3] Chrome 自动抓取详情（街道地址）…");
  const enriched = [];
  let index = 0;

  for (const item of items) {
    index += 1;
    const cachePath = path.join(detailDir, `${item.shopId}.html`);
    let detailHtml = loadDetailHtml(detailDir, item.shopId);
    let detailUrl = item.originalLink;

    if (!detailHtml) {
      console.log(`  → 详情 ${index}/${items.length}: ${item.name}`);
      const fetched = await fetchViaChrome(item.originalLink, {
        waitMs: options.detailWaitMs,
        expectShopList: false,
      });
      detailHtml = fetched.html;
      detailUrl = fetched.url || item.originalLink;
      fs.writeFileSync(cachePath, detailHtml);
      await sleep(options.detailDelayMs);
    } else {
      console.log(`  → 详情 ${index}/${items.length}: ${item.name}（用缓存）`);
    }

    const record = enrichWithDetail(item, detailHtml, detailUrl);
    if (record.skipReason === "closed_or_not_open") {
      console.log(`     跳过（闭店/未开业）: ${record.name}`);
      continue;
    }
    enriched.push(record);
  }

  return enriched;
}

function enrichDetailsFromCache(items, options) {
  const detailDir = options.detailDir
    ? (path.isAbsolute(options.detailDir) ? options.detailDir : path.join(root, options.detailDir))
    : "";
  const enriched = [];
  for (const item of items) {
    const detailHtml = loadDetailHtml(detailDir, item.shopId);
    if (!detailHtml) {
      enriched.push(item);
      continue;
    }
    const record = enrichWithDetail(item, detailHtml);
    if (record.skipReason === "closed_or_not_open") continue;
    enriched.push(record);
  }
  return enriched;
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.keyword) {
    console.error("Missing --keyword=");
    printHelp();
    process.exit(1);
  }
  if (!options.cityId) {
    console.error(`Unknown city id for ${options.city}. Pass --city-id= manually.`);
    process.exit(1);
  }

  let items;
  if (options.offline) {
    if (!options.htmlFiles.length) {
      console.error("离线模式需要 --html-file= 或 --html-dir=");
      process.exit(1);
    }
    items = loadSearchResultsFromFiles(options);
  } else {
    const listResult = await fetchSearchResultsViaChrome(options);
    items = listResult.items;
    if (!items.length && listResult.skipReason) {
      console.warn(`\n⚠ 跳过入库：${listResult.skipReason}`);
      if (listResult.debugFile) {
        console.warn(`   调试 HTML：${listResult.debugFile}`);
      }
    }
  }

  if (!items.length) {
    if (!options.allowEmpty) process.exit(1);
    return;
  }

  let enriched;
  if (options.skipDetails) {
    enriched = items;
  } else if (options.offline) {
    enriched = enrichDetailsFromCache(items, options);
  } else {
    enriched = await enrichDetailsViaChrome(items, options);
  }

  const withImage = enriched.filter((row) => row.image).length;
  const withDistrict = enriched.filter((row) => row.district).length;
  const importBatchId = `${options.city}-${options.keyword}-${new Date().toISOString().slice(0, 10)}`;
  const merchantRows = enriched.map((item) => toMerchantRecord(item, {
    city: options.city,
    keyword: options.keyword,
    importBatchId,
  }));

  const summary = {
    city: options.city,
    keyword: options.keyword,
    searchUrl: buildSearchUrl(options.cityId, options.keyword),
    imported: merchantRows.length,
    withImage,
    withDistrict,
    merchants: merchantRows.map((row) => ({
      name: row.name,
      address: row.address,
      district: row.district,
      category: row.category,
      image: row.image,
      link: row.original_link,
    })),
  };

  console.log("\n[2/2] 结果汇总");
  console.log(`搜索词: ${options.keyword} | 城市: ${options.city}`);
  console.log(`入库 ${merchantRows.length} 家 | 有列表图 ${withImage} | 有商圈 ${withDistrict}`);
  for (const row of summary.merchants) {
    const region = row.district || row.category || "未知";
    console.log(`- ${row.name} — 商圈: ${region}`);
  }

  if (options.jsonOut) {
    const outPath = path.isAbsolute(options.jsonOut) ? options.jsonOut : path.join(root, options.jsonOut);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  }

  if (options.dryRun) {
    console.log("\n(dry-run: 未写入数据库)");
    return;
  }

  const dbPath = options.dbPath
    ? (path.isAbsolute(options.dbPath) ? options.dbPath : path.join(root, options.dbPath))
    : defaultDbPath;
  const db = openDatabase(dbPath);
  const result = importMerchants(db, merchantRows, {
    mode: options.mode === "merge" ? "merge" : "replace-keyword",
    city: options.city,
    keyword: options.keyword,
    sourcePage: buildSearchUrl(options.cityId, options.keyword),
  });
  console.log(`\n已写入 ${result.imported} 条 → ${dbPath}`);
  console.log(`打开审核台: npm start → http://127.0.0.1:8787/merchants.html`);
}

main().catch((error) => {
  console.error(`\n抓取失败: ${error.message}`);
  process.exit(1);
});

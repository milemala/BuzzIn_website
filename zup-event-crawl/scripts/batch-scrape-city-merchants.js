#!/usr/bin/env node
"use strict";

/**
 * 按城市酒鬼地图清单逐店搜索大众点评（仅列表第一页，不进详情）。
 *
 * 用法：
 *   node scripts/batch-scrape-city-merchants.js \
 *     --city=佛山 \
 *     --list-file=docs/各城市酒鬼地图/拆分结果/佛山8.md
 */
const fs = require("fs");
const path = require("path");
const {
  DIANPING_CITY_IDS,
  buildSearchUrl,
  isLoginWall,
  parseSearchListHtml,
  toMerchantRecord,
} = require("../lib/dianping-parse");
const { fetchViaChrome, sleep } = require("../lib/chrome-fetch");
const { importMerchants, openDatabase } = require("../lib/merchant-db");
const { batchAutoPoi } = require("../lib/merchant-poi-batch");
const {
  parseCityMerchantList,
  updateCityMerchantListScrapeStatus,
} = require("../lib/city-merchant-list");

const root = path.join(__dirname, "..");
const defaultDbPath = path.join(root, "data", "review.db");

function parseArgs(argv) {
  const options = {
    city: "",
    cityId: null,
    listFile: "",
    dbPath: "",
    dryRun: false,
    skipPoi: false,
    chromeWaitMs: 10000,
    taskDelayMs: 3000,
    minScore: 35,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-poi") options.skipPoi = true;
    else if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length);
    else if (arg.startsWith("--city-id=")) options.cityId = Number(arg.slice("--city-id=".length));
    else if (arg.startsWith("--list-file=")) options.listFile = arg.slice("--list-file=".length);
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (arg.startsWith("--chrome-wait=")) options.chromeWaitMs = Number(arg.slice("--chrome-wait=".length));
    else if (arg.startsWith("--task-delay=")) options.taskDelayMs = Number(arg.slice("--task-delay=".length));
    else if (arg.startsWith("--min-score=")) options.minScore = Number(arg.slice("--min-score=".length));
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      printHelp();
      process.exit(1);
    }
  }

  if (!options.cityId && options.city) {
    options.cityId = DIANPING_CITY_IDS[options.city];
  }
  return options;
}

function printHelp() {
  console.log(`按城市酒鬼地图清单抓取大众点评（仅列表页）:

  node scripts/batch-scrape-city-merchants.js \\
    --city=佛山 \\
    --list-file=docs/各城市酒鬼地图/拆分结果/佛山8.md

前提：Chrome 已登录大众点评。
`);
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
}

function loadCityMerchantEntries(filePath) {
  const { entries } = parseCityMerchantList(resolvePath(filePath));
  if (!entries.length) {
    throw new Error(`清单中未解析到商户：${filePath}`);
  }
  return entries.map((entry) => ({
    listName: entry.listName,
    listAddress: entry.listAddress,
  }));
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[·・\s　（）()&\-—:：.]/g, "")
    .replace(/bar|cocktail|whisky|whiskey|homebar/gi, "");
}

function buildSearchKeyword(listName) {
  const base = listName
    .replace(/（[^）]+）/g, "")
    .replace(/\([^)]+\)/g, "")
    .replace(/[·・]/g, " ")
    .trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && /[a-z]/i.test(parts[0]) && parts[0].length <= 6) {
    return parts.slice(0, 2).join(" ");
  }
  return base.split(/[·・]/)[0].trim() || base;
}

function scoreMatch(listName, listAddress, item) {
  const target = normalizeName(listName);
  const candidate = normalizeName(item.name);
  let score = 0;

  if (target && candidate && target === candidate) score += 100;
  else if (target && candidate && (candidate.includes(target) || target.includes(candidate))) score += 75;
  else if (target && candidate) {
    const overlap = [...target].filter((ch) => candidate.includes(ch)).length;
    score += Math.round((overlap / Math.max(target.length, 1)) * 55);
  }

  const regionText = `${item.district || ""} ${item.listRegionText || ""} ${item.name || ""}`;
  const districts = ["南海", "禅城", "顺德", "三水", "高明", "祖庙", "桂城", "石湾"];
  for (const district of districts) {
    if (listAddress.includes(district) && regionText.includes(district)) {
      score += 12;
      break;
    }
  }

  const hints = ["国瑞升平", "金澜北", "影荫", "玫瑰西", "玫瑰东", "乐周", "海二", "季华园", "格沙"];
  for (const hint of hints) {
    if (listAddress.includes(hint) && regionText.includes(hint)) {
      score += 8;
      break;
    }
  }

  if (item.sourcePosition === 1) score += 4;
  return score;
}

function pickBestMatch(listName, listAddress, items, minScore) {
  const ranked = items
    .map((item) => ({ item, score: scoreMatch(listName, listAddress, item) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < minScore) return null;
  return best;
}

async function fetchListForKeyword(options, keyword) {
  const pageUrl = buildSearchUrl(options.cityId, keyword);
  const expectedPath = `/search/keyword/${options.cityId}/`;
  let html = "";
  let parsed = null;
  let shopCount = 0;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (attempt > 1) {
      console.log("     列表未就绪，重试 1 次…");
      await sleep(2000);
    }
    const fetched = await fetchViaChrome(pageUrl, {
      waitMs: options.chromeWaitMs + (attempt - 1) * 2500,
      expectShopList: true,
      minShopCount: 1,
    });
    if (!fetched.url.includes(expectedPath)) {
      console.warn(`     ⚠ 当前标签 URL 与目标城市不一致: ${fetched.url}`);
      if (attempt < 2) continue;
    }
    html = fetched.html;
    shopCount = fetched.shopCount || 0;
    if (isLoginWall(html)) {
      throw new Error("大众点评要求登录：请先在 Chrome 打开 dianping.com 并完成登录。");
    }
    parsed = parseSearchListHtml(html, { searchKeyword: keyword, searchUrl: pageUrl });
    if (parsed.parsedCount > 0) break;
  }

  return { pageUrl, html, parsed, shopCount };
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.city || !options.listFile) {
    console.error("需要 --city= 和 --list-file=");
    printHelp();
    process.exit(1);
  }
  if (!options.cityId) {
    console.error(`未知城市 id：${options.city}，请传 --city-id=`);
    process.exit(1);
  }

  const listPath = resolvePath(options.listFile);
  const entries = loadCityMerchantEntries(listPath);
  const importBatchId = `${options.city}-酒鬼地图-${new Date().toISOString().slice(0, 10)}`;
  const report = { ok: [], miss: [], fail: [] };
  const merchantRows = [];

  console.log(`\n按清单抓取 ${options.city} · 共 ${entries.length} 家（仅列表页）`);
  console.log("请保持 Chrome 已登录大众点评。\n");

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const keyword = buildSearchKeyword(entry.listName);
    console.log(`${"=".repeat(60)}`);
    console.log(`[${i + 1}/${entries.length}] ${entry.listName}`);
    console.log(`搜索词: ${keyword}`);
    if (entry.listAddress) console.log(`清单地址: ${entry.listAddress}`);

    try {
      const { pageUrl, parsed, shopCount } = await fetchListForKeyword(options, keyword);
      console.log(`     页面约 ${parsed.totalReported ?? "?"} 条 | DOM ${shopCount} 家 | 解析 ${parsed.parsedCount}`);
      const best = pickBestMatch(entry.listName, entry.listAddress, parsed.allItems || [], options.minScore);
      if (!best) {
        console.log(`     ✗ 未找到足够匹配的列表结果（阈值 ${options.minScore}）`);
        report.miss.push({ ...entry, keyword, reason: "no_match" });
      } else {
        const item = best.item;
        console.log(`     ✓ 匹配 ${item.name}（得分 ${best.score}）— ${item.district || item.category || "未知商圈"}`);
        const record = toMerchantRecord(item, {
          city: options.city,
          keyword: entry.listName,
          importBatchId,
        });
        record.address = entry.listAddress || record.address;
        merchantRows.push(record);
        report.ok.push({
          listName: entry.listName,
          matchedName: item.name,
          score: best.score,
          district: item.district || "",
          link: item.originalLink,
        });
      }
    } catch (error) {
      console.log(`     ✗ 抓取失败: ${error.message}`);
      report.fail.push({ ...entry, keyword, error: error.message });
    }

    if (i < entries.length - 1) {
      await sleep(options.taskDelayMs);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("抓取汇总");
  console.log(`成功匹配 ${report.ok.length} / ${entries.length}`);
  if (report.miss.length) console.log(`未匹配 ${report.miss.length}`);
  if (report.fail.length) console.log(`失败 ${report.fail.length}`);

  for (const row of report.ok) {
    console.log(`- ${row.listName} → ${row.matchedName}（${row.district || "无商圈"}）`);
  }

  if (!merchantRows.length && !report.miss.length && !report.fail.length) {
    process.exit(1);
  }

  if (options.dryRun) {
    updateCityMerchantListScrapeStatus(listPath, {
      scraped: report.ok.map((row) => ({
        listName: row.listName,
        matchedName: row.matchedName,
        link: row.link,
      })),
      notFound: [...report.miss, ...report.fail].map((row) => ({
        listName: row.listName,
        reason: row.reason || row.error || "抓取失败",
      })),
    });
    console.log(`\n(dry-run: 未写入数据库，已更新清单标注 → ${listPath})`);
    return;
  }

  const dbPath = options.dbPath ? resolvePath(options.dbPath) : defaultDbPath;
  const db = openDatabase(dbPath);
  const result = importMerchants(db, merchantRows, {
    mode: "merge",
    city: options.city,
    keyword: `酒鬼地图-${options.city}`,
    sourcePage: `list:${listPath}`,
  });
  console.log(`\n已写入 ${result.imported} 条 → ${dbPath}`);

  if (!options.skipPoi && merchantRows.length) {
    const listAddressByUid = Object.fromEntries(
      merchantRows.map((row) => [row.merchant_uid, row.address || ""]),
    );
    console.log("\n补全腾讯 POI（店名搜索，清单门牌地址仅用于结果比对）…");
    const poiReport = await batchAutoPoi(db, {
      merchant_uids: merchantRows.map((row) => row.merchant_uid),
      listAddressByUid,
      refresh: true,
    });
    console.log(`POI: ${poiReport.ok} 成功 / ${poiReport.fail} 失败`);
    for (const row of poiReport.results) {
      if (!row.ok) {
        console.log(`  ✗ ${row.name} — ${row.error}`);
      }
    }
  }

  const listUpdate = updateCityMerchantListScrapeStatus(listPath, {
    scraped: report.ok.map((row) => ({
      listName: row.listName,
      matchedName: row.matchedName,
      link: row.link,
    })),
    notFound: [...report.miss, ...report.fail].map((row) => ({
      listName: row.listName,
      reason: row.reason || row.error || "抓取失败",
    })),
  });
  console.log(`\n已更新清单标注 → ${listPath}`);
  console.log(`清单进度：已抓取 ${listUpdate.scrapedCount} / 未找到 ${listUpdate.notFoundCount}`);
  console.log(`打开审核台: npm start → http://127.0.0.1:8787/merchants.html`);
}

main().catch((error) => {
  console.error(`\n批量抓取失败: ${error.message}`);
  process.exit(1);
});

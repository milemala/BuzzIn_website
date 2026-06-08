#!/usr/bin/env node
"use strict";

/**
 * 按城市酒鬼地图清单逐店搜索大众点评（仅列表第一页，不进详情）。
 *
 * 用法：
 *   node scripts/batch-scrape-city-merchants.js \
 *     --city=成都 \
 *     --list-file=docs/各城市酒鬼地图/拆分结果/成都105.md
 */
const fs = require("fs");
const path = require("path");
const {
  DIANPING_CITY_IDS,
  buildSearchUrl,
  detectDianpingBlock,
  parseSearchListHtml,
  shouldStopListFetchRetry,
  toMerchantRecord,
} = require("../lib/dianping-parse");
const { matchesSocialVenueIntent } = require("../lib/merchant-social-filter");
const { extractAddressHints } = require("../lib/tencent-poi");
const { fetchViaChrome, sleep } = require("../lib/chrome-fetch");
const { importMerchants, openDatabase } = require("../lib/merchant-db");
const { batchAutoPoi } = require("../lib/merchant-poi-batch");
const {
  countExistingScrapeStatus,
  finalizeCityMerchantList,
  normalizeListAddress,
  parseCityMerchantList,
} = require("../lib/city-merchant-list");

const root = path.join(__dirname, "..");
const defaultDbPath = path.join(root, "data", "review.db");

class DianpingBlockedError extends Error {
  constructor(detail, reason = "blocked") {
    super(`大众点评限制访问，已暂停抓取：${detail}`);
    this.name = "DianpingBlockedError";
    this.code = "DIANPING_BLOCKED";
    this.reason = reason;
    this.detail = detail;
  }
}

function parseArgs(argv) {
  const options = {
    city: "",
    cityId: null,
    listFile: "",
    dbPath: "",
    dryRun: false,
    skipPoi: false,
    force: false,
    chromeWaitMs: 10000,
    taskDelayMs: 3500,
    minScore: 35,
    blockThreshold: 1,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-poi") options.skipPoi = true;
    else if (arg === "--force") options.force = true;
    else if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length);
    else if (arg.startsWith("--city-id=")) options.cityId = Number(arg.slice("--city-id=".length));
    else if (arg.startsWith("--list-file=")) options.listFile = arg.slice("--list-file=".length);
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (arg.startsWith("--chrome-wait=")) options.chromeWaitMs = Number(arg.slice("--chrome-wait=".length));
    else if (arg.startsWith("--task-delay=")) options.taskDelayMs = Number(arg.slice("--task-delay=".length));
    else if (arg.startsWith("--min-score=")) options.minScore = Number(arg.slice("--min-score=".length));
    else if (arg.startsWith("--block-threshold=")) options.blockThreshold = Number(arg.slice("--block-threshold=".length));
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
    --city=成都 \\
    --list-file=docs/各城市酒鬼地图/拆分结果/成都105.md

前提：Chrome 已登录大众点评。默认跳过清单里已标注「已抓取」的商户。
`);
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
}

function saveDebugHtml(city, keyword, html) {
  const dir = path.join(root, "data", "scrape-cache", "dianping", "debug");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${city}-${keyword}-${Date.now()}.html`);
  fs.writeFileSync(file, html);
  return file;
}

function loadCityMerchantEntries(filePath, options = {}) {
  const parsed = parseCityMerchantList(resolvePath(filePath));
  const entries = parsed.entries.map((entry) => ({
    listName: entry.listName,
    listAddress: entry.listAddress,
    scrapeStatus: entry.scrapeStatus,
  }));
  if (!entries.length) {
    throw new Error(`清单中未解析到商户：${filePath}`);
  }
  if (!options.force) {
    return entries.filter((entry) => entry.scrapeStatus !== "scraped");
  }
  return entries;
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[·・\s　（）()&\-—:：.]/g, "")
    .replace(/bar|cocktail|whisky|whiskey|homebar/gi, "");
}

const GENERIC_BAR_TAIL_RE =
  /\s*(精酿|鸡尾酒|啤酒|酒馆|酒吧|餐吧|小酒馆|威士忌|民谣|咖啡|书店|餐酒|酒铺|酒场|酒舍|打酒铺|台吧|taproom|homebar|home\s*bar|lounge|pub|club|bar|bistro|pizza|musicbar|music\s*bar|shisha|餐吧|轻酒吧).*$/iu;

function stripBranchName(name) {
  return String(name || "")
    .replace(/（[^）]+）/g, "")
    .replace(/\([^)]+\)/g, "")
    .trim();
}

function buildSearchKeywords(listName) {
  const base = stripBranchName(listName).replace(/[·・]/g, " ").trim();
  const keywords = [];
  const add = (kw) => {
    const k = String(kw || "").replace(/\s+/g, " ").trim();
    if (k.length < 2) return;
    if (keywords.some((x) => x.toLowerCase() === k.toLowerCase())) return;
    keywords.push(k);
  };

  add(base.split(/[&＆]/)[0].trim());

  const withoutTail = base.replace(GENERIC_BAR_TAIL_RE, "").trim();
  add(withoutTail);

  const parts = base.split(/\s+/).filter(Boolean);
  const cnParts = parts.filter((p) => /[\u4e00-\u9fa5]/.test(p));
  const enParts = parts.filter((p) => /^[A-Za-z][A-Za-z0-9'&.-]*$/i.test(p));
  if (cnParts.length && enParts.length) {
    add(`${cnParts[0]} ${enParts[0]}`);
    if (enParts.length > 1) {
      add(`${cnParts[0]} ${enParts.slice(0, 2).join(" ")}`);
    }
  }

  if (parts.length > 1 && /^[A-Za-z]/.test(parts[0])) {
    const enRun = [];
    for (const p of parts) {
      if (/^[A-Za-z][A-Za-z0-9'&.-]*$/i.test(p)) enRun.push(p);
      else break;
    }
    if (enRun.length) add(enRun.join(" "));
  }

  const dualMatch = base.match(/^([\u4e00-\u9fa5]{1,8})\s+([A-Za-z][\w\s&'.-]{1,30})/u);
  if (dualMatch) {
    const enCore = dualMatch[2].replace(GENERIC_BAR_TAIL_RE, "").trim();
    const enWords = enCore.split(/\s+/).filter(Boolean);
    add(`${dualMatch[1]} ${enWords.slice(0, 3).join(" ")}`.trim());
  }

  add(stripBranchName(listName).split(/[·・]/)[0].trim());

  const cnOnly = base.replace(/[A-Za-z0-9&'.\s-]/g, "").trim();
  if (cnOnly.length >= 2 && cnOnly.length <= 8 && base.length > cnOnly.length + 3) {
    add(cnOnly.slice(0, 6));
  }

  add(base);
  return keywords;
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
  const districtMatch = listAddress.match(/([\u4e00-\u9fa5]+区)/);
  if (districtMatch && regionText.includes(districtMatch[1])) score += 12;

  for (const hint of extractAddressHints(listAddress)) {
    if (regionText.includes(hint) || (item.district || "").includes(hint)) score += 8;
  }

  if (item.sourcePosition === 1) score += 4;
  return score;
}

function filterBarVenueCandidates(items) {
  return (items || []).filter((item) => matchesSocialVenueIntent(item, { skipKeywordCheck: true }).ok);
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
  let fetchedUrl = "";

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
    fetchedUrl = fetched.url || "";
    if (!fetched.url.includes(expectedPath)) {
      console.warn(`     ⚠ 当前标签 URL 与目标城市不一致: ${fetched.url}`);
      if (attempt < 2) continue;
    }
    html = fetched.html;
    shopCount = fetched.shopCount || 0;
    const block = detectDianpingBlock(html, fetchedUrl);
    if (block.blocked) {
      const debugFile = saveDebugHtml(options.city, keyword, html);
      throw new DianpingBlockedError(`${block.detail}（调试 HTML: ${debugFile}）`, block.reason);
    }
    parsed = parseSearchListHtml(html, { searchKeyword: keyword, searchUrl: pageUrl });
    if (shouldStopListFetchRetry(parsed)) {
      if (parsed.searchNotFound || (parsed.hasTotalReported && parsed.totalReported === 0)) {
        console.log("     大众点评：没有找到相关商户");
      }
      break;
    }
  }

  return { pageUrl, html, parsed, shopCount, fetchedUrl };
}

async function persistResults(options, listPath, report, merchantRows) {
  if (!options.dryRun && merchantRows.length) {
    const dbPath = options.dbPath ? resolvePath(options.dbPath) : defaultDbPath;
    const db = openDatabase(dbPath);
    const result = importMerchants(db, merchantRows, {
      mode: "merge",
      city: options.city,
      keyword: `酒鬼地图-${options.city}`,
      sourcePage: `list:${listPath}`,
    });
    console.log(`\n已写入 ${result.imported} 条 → ${dbPath}`);

    if (!options.skipPoi) {
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
        if (!row.ok) console.log(`  ✗ ${row.name} — ${row.error}`);
      }
    }
  }

  const listUpdate = finalizeCityMerchantList(listPath, {
    scraped: report.ok.map((row) => ({
      listName: row.listName,
      matchedName: row.matchedName,
      link: row.link,
    })),
    notFound: [...report.miss, ...report.fail].map((row) => ({
      listName: row.listName,
      reason: row.reason || row.error || "抓取失败",
    })),
    blocked: report.blocked || "",
  });

  console.log(`\n已更新并重命名清单 → ${listUpdate.path}`);
  console.log(`清单进度：已抓取 ${listUpdate.scrapedCount} / 未找到 ${listUpdate.notFoundCount} / 总数 ${listUpdate.total}`);
  return listUpdate;
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
  const allParsed = parseCityMerchantList(listPath);
  const existing = countExistingScrapeStatus(allParsed.entries);
  const entries = loadCityMerchantEntries(listPath, options);
  const importBatchId = `${options.city}-酒鬼地图-${new Date().toISOString().slice(0, 10)}`;
  const report = { ok: [], miss: [], fail: [], blocked: "" };
  const merchantRows = [];
  console.log(`\n按清单抓取 ${options.city} · 待抓 ${entries.length} 家 / 清单共 ${allParsed.entries.length} 家（仅列表页）`);
  if (!entries.length) {
    console.log("清单中待抓商户为 0，仅同步清单标注与文件名。");
    await persistResults(options, listPath, report, merchantRows);
    return;
  }
  if (existing.scraped) {
    console.log(`已跳过此前已抓取 ${existing.scraped} 家`);
  }
  console.log("请保持 Chrome 已登录大众点评；若出现验证码/频繁访问将自动暂停。\n");

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const keywords = buildSearchKeywords(entry.listName);
    console.log(`${"=".repeat(60)}`);
    console.log(`[${i + 1}/${entries.length}] ${entry.listName}`);
    console.log(`搜索词候选: ${keywords.join(" → ")}`);
    if (entry.listAddress) console.log(`清单地址: ${entry.listAddress}`);

    try {
      let matched = null;
      let lastKeyword = keywords[0];
      for (let ki = 0; ki < keywords.length; ki += 1) {
        const keyword = keywords[ki];
        lastKeyword = keyword;
        if (ki > 0) {
          console.log(`     换搜索词重试: ${keyword}`);
          await sleep(2000);
        } else {
          console.log(`搜索词: ${keyword}`);
        }

        const { parsed, shopCount } = await fetchListForKeyword(options, keyword);
        console.log(`     页面约 ${parsed.totalReported ?? "?"} 条 | DOM ${shopCount} 家 | 解析 ${parsed.parsedCount}`);
        const candidates = filterBarVenueCandidates(parsed.allItems || []);
        const best = pickBestMatch(entry.listName, entry.listAddress, candidates, options.minScore);
        if (best) {
          matched = { best, keyword };
          break;
        }
        if (ki < keywords.length - 1) {
          console.log(`     无匹配，尝试下一搜索词…`);
        }
      }

      if (!matched) {
        console.log(`     ✗ 未找到足够匹配的列表结果（阈值 ${options.minScore}）`);
        report.miss.push({ ...entry, keyword: lastKeyword, reason: "no_match" });
      } else {
        const { best, keyword } = matched;
        const item = best.item;
        console.log(`     ✓ 匹配 ${item.name}（得分 ${best.score}，搜索词「${keyword}」）— ${item.district || item.category || "未知商圈"}`);
        const record = toMerchantRecord(item, {
          city: options.city,
          keyword: entry.listName,
          importBatchId,
        });
        record.address = normalizeListAddress(entry.listAddress) || record.address;
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
      if (error instanceof DianpingBlockedError || error.code === "DIANPING_BLOCKED") {
        report.blocked = error.message;
        console.log(`\n⚠ ${error.message}`);
        console.log("\n检测到大众点评限制，立即暂停后续抓取。");
        break;
      } else {
        console.log(`     ✗ 抓取失败: ${error.message}`);
        report.fail.push({ ...entry, keyword: keywords[0], error: error.message });
      }
    }

    if (i < entries.length - 1) {
      await sleep(options.taskDelayMs);
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("抓取汇总");
  console.log(`本轮成功 ${report.ok.length} 家`);
  if (report.miss.length) console.log(`本轮未匹配 ${report.miss.length} 家`);
  if (report.fail.length) console.log(`本轮失败 ${report.fail.length} 家`);
  if (report.blocked) console.log(`限制状态：${report.blocked}`);

  if (!merchantRows.length && !report.miss.length && !report.fail.length && !report.blocked) {
    console.log("\n没有需要处理的条目。");
    return;
  }

  const listUpdate = await persistResults(options, listPath, report, merchantRows);

  if (report.blocked) {
    console.log("\n⚠ 抓取已提前暂停。请检查 Chrome 登录态/验证码后，重新运行同一命令继续。");
    console.log(`当前清单文件：${listUpdate.path}`);
    process.exit(2);
  }

  if (!options.dryRun) {
    console.log(`打开审核台: npm start → http://127.0.0.1:8787/merchants.html`);
  }
}

main().catch(async (error) => {
  console.error(`\n批量抓取失败: ${error.message}`);
  process.exit(1);
});

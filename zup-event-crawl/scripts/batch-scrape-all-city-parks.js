#!/usr/bin/env node
"use strict";

/**
 * 从公园总览清单生成各城 md（若缺失），并逐城调用 batch-scrape-city-parks。
 *
 *   node scripts/batch-scrape-all-city-parks.js
 *   node scripts/batch-scrape-all-city-parks.js --city=上海
 *   node scripts/batch-scrape-all-city-parks.js --dry-run
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { DIANPING_CITY_IDS } = require("../lib/dianping-parse");
const { parseCityMerchantList } = require("../lib/city-merchant-list");

const root = path.join(__dirname, "..");
const masterPath = path.join(root, "data", "城市商户清单", "公园统计", "各城市主要公园清单.md");
const parkDir = path.join(root, "data", "城市商户清单", "公园统计");

function parseArgs(argv) {
  const options = { city: "", dryRun: false, skipPoi: false, force: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--skip-poi") options.skipPoi = true;
    else if (arg === "--force") options.force = true;
    else if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length);
  }
  return options;
}

function parseMasterParkList(md) {
  const cities = [];
  for (const part of md.split(/\n(?=### )/)) {
    const head = part.match(/^###\s+(.+?)(?:（\d+）)?\s*$/m);
    if (!head) continue;
    const city = head[1].trim();
    if (city.includes("城市分级") || city.includes("一线") || city.includes("二线")) continue;
    const parks = [...part.matchAll(/^\d+、(.+)$/gm)].map((m) => m[1].trim());
    if (!parks.length) continue;
    cities.push({ city, parks });
  }
  return cities;
}

function findExistingListFile(city, count) {
  if (!fs.existsSync(parkDir)) return "";
  const files = fs.readdirSync(parkDir);
  const exact = `${city}公园${count}.md`;
  const scraped = files.find((name) => name.startsWith(`${city}公园${count}_已抓`) && name.endsWith(".md"));
  if (scraped) return path.join(parkDir, scraped);
  if (files.includes(exact)) return path.join(parkDir, exact);
  const loose = files.find((name) => name.startsWith(`${city}公园`) && name.endsWith(".md") && !name.includes("各城市"));
  return loose ? path.join(parkDir, loose) : "";
}

function writeCityListFile(city, parks) {
  const n = parks.length;
  const filePath = path.join(parkDir, `${city}公园${n}.md`);
  const content = `# ${city}主要公园清单

- 城市：${city}
- 公园数量：${n}
- 来源：\`各城市主要公园清单.md\`

## 公园清单

${parks.map((name, i) => `${i + 1}、${name}`).join("\n")}
`;
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function ensureCityListFile(city, parks) {
  const existing = findExistingListFile(city, parks.length);
  if (existing) return existing;
  return writeCityListFile(city, parks);
}

function pendingCount(listPath) {
  try {
    const parsed = parseCityMerchantList(listPath);
    return parsed.entries.filter((e) => e.scrapeStatus !== "scraped").length;
  } catch {
    return parksLengthFromFile(listPath);
  }
}

function parksLengthFromFile(listPath) {
  const parsed = parseCityMerchantList(listPath);
  return parsed.entries.length;
}

function main() {
  const options = parseArgs(process.argv);
  if (!fs.existsSync(masterPath)) {
    console.error(`找不到公园总览：${masterPath}`);
    process.exit(1);
  }

  const master = fs.readFileSync(masterPath, "utf8");
  let cities = parseMasterParkList(master);
  if (options.city) {
    cities = cities.filter((item) => item.city === options.city);
    if (!cities.length) {
      console.error(`总览中未找到城市：${options.city}`);
      process.exit(1);
    }
  }

  fs.mkdirSync(parkDir, { recursive: true });
  const summary = { ok: 0, skip: 0, fail: 0, blocked: false };

  for (const { city, parks } of cities) {
    if (!DIANPING_CITY_IDS[city]) {
      console.error(`\n✗ 跳过 ${city}：未配置大众点评 cityId`);
      summary.fail += 1;
      continue;
    }

    const listPath = ensureCityListFile(city, parks);
    const pending = options.force ? parks.length : pendingCount(listPath);
    if (!pending) {
      console.log(`\n— 跳过 ${city}：清单已全部抓取（${listPath}）`);
      summary.skip += 1;
      continue;
    }

    console.log(`\n${"=".repeat(60)}\n开始抓取 ${city} · ${pending} 个待抓 · ${listPath}\n`);
    if (options.dryRun) {
      console.log(`[dry-run] node scripts/batch-scrape-city-parks.js --city=${city} --list-file=${path.relative(root, listPath)}`);
      summary.ok += 1;
      continue;
    }

    const args = [
      path.join(__dirname, "batch-scrape-city-parks.js"),
      `--city=${city}`,
      `--list-file=${path.relative(root, listPath)}`,
    ];
    if (options.skipPoi) args.push("--skip-poi");
    if (options.force) args.push("--force");

    const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit" });
    if (result.status === 2) {
      summary.blocked = true;
      console.error(`\n⚠ ${city} 触发大众点评限制，停止后续城市。`);
      break;
    }
    if (result.status !== 0) {
      summary.fail += 1;
      console.error(`\n✗ ${city} 抓取异常退出 code=${result.status}`);
      continue;
    }
    summary.ok += 1;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`全部完成：成功 ${summary.ok} 城 · 跳过 ${summary.skip} 城 · 失败 ${summary.fail} 城${summary.blocked ? " · 已因限制中断" : ""}`);
  if (summary.blocked) process.exit(2);
  if (summary.fail > 0) process.exit(1);
}

main();

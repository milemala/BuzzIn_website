#!/usr/bin/env node
"use strict";

/**
 * 逐城抓取豆瓣最近一周活动（Chrome 主路 + 去重 + 4:3 合成）。
 *
 *   node scripts/batch-scrape-douban-cities.js
 *   node scripts/batch-scrape-douban-cities.js --city=上海
 *   node scripts/batch-scrape-douban-cities.js --skip-city=北京 --max-pages=10
 */
const path = require("path");
const { spawnSync } = require("child_process");
const { listDoubanCityNames } = require("../lib/douban-cities");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");

const DEFAULT_CITIES = [
  "北京", "上海", "广州", "深圳",
  "沈阳", "哈尔滨", "南京", "武汉", "宁波", "西安", "重庆", "佛山", "杭州",
  "秦皇岛", "青岛", "苏州", "长沙", "郑州", "成都", "天津", "长春", "厦门",
  "石家庄", "温州", "无锡", "福州",
];

function parseArgs(argv) {
  const options = {
    cities: [],
    skipCities: new Set(),
    city: "",
    limit: 500,
    dbPath: defaultDb,
    maxPages: 10,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length);
    else if (arg.startsWith("--skip-city=")) {
      arg.slice("--skip-city=".length).split(/[,，]/).forEach((name) => {
        if (name.trim()) options.skipCities.add(name.trim());
      });
    }
    else if (arg.startsWith("--cities=")) {
      options.cities = arg.slice("--cities=".length).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length));
    else if (arg.startsWith("--max-pages=")) options.maxPages = Number(arg.slice("--max-pages=".length));
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (!arg.startsWith("--") && arg.endsWith(".db")) options.dbPath = arg;
  }
  return options;
}

function resolveCityList(options) {
  let cities = options.cities.length
    ? options.cities
    : (options.city ? [options.city] : DEFAULT_CITIES);
  cities = cities.filter((name) => !options.skipCities.has(name));
  const known = new Set(listDoubanCityNames());
  const invalid = cities.filter((name) => !known.has(name));
  if (invalid.length) {
    throw new Error(`未知豆瓣城市：${invalid.join("、")}。请在 lib/douban-cities.js 登记。`);
  }
  return cities;
}

function runCity(city, options) {
  const script = path.join(__dirname, "scrape-douban-week-events.js");
  const args = [
    script,
    String(options.limit),
    options.dbPath,
    `--city=${city}`,
    "--mode=append-city",
    `--max-pages=${options.maxPages}`,
  ];
  if (options.dryRun) args.push("--dry-run");
  console.log(`\n========== ${city} ==========`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  return result.status ?? 1;
}

function main() {
  const options = parseArgs(process.argv);
  const cities = resolveCityList(options);
  if (!cities.length) {
    console.log("没有需要抓取的城市。");
    return;
  }

  console.log(`豆瓣批量抓取：${cities.length} 城 · 每城最多 ${options.maxPages} 页 · ${options.dbPath}`);
  const summary = { ok: 0, fail: 0, failed: [], pausedAt: "" };
  const completedCities = [];

  for (const city of cities) {
    const exitCode = runCity(city, options);
    if (exitCode === 0) {
      summary.ok += 1;
      completedCities.push(city);
    } else {
      summary.fail += 1;
      summary.failed.push(city);
      summary.pausedAt = city;
      const isBlocked = exitCode === 2;
      console.error(`\n${isBlocked ? "豆瓣风控" : "抓取失败"}，批量抓取已暂停于「${city}」（exit ${exitCode}）`);
      if (completedCities.length) {
        const skipHint = [...options.skipCities, ...completedCities].join(",");
        console.error(`稍后继续可跳过已完成城市：`);
        console.error(`  node scripts/batch-scrape-douban-cities.js --skip-city=${skipHint} --max-pages=${options.maxPages}`);
      }
      process.exitCode = exitCode;
      break;
    }
  }

  if (!summary.pausedAt) {
    console.log(`\n全部完成：成功 ${summary.ok} 城 · 失败 ${summary.fail} 城`);
  } else if (summary.ok) {
    console.log(`\n已完成 ${summary.ok} 城后暂停`);
  }
}

main();

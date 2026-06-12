#!/usr/bin/env node
"use strict";

/**
 * 调腾讯 POI API，输出 JSON 供 Cursor Agent 阅读与判断。
 * 本脚本不分词、不选点、不写库——搜词由 Agent 决定，match/reject 由 Agent 写 decisions.json。
 *
 *   node scripts/poi-search-cli.js --city=深圳 --keyword="福田区 寰映影城"
 *
 * 见 docs/event-poi-agent-workflow.md
 */
const path = require("path");
const { searchPoi } = require("../lib/tencent-poi");
const { openDatabase } = require("../lib/review-db");
const { lookupPoiAddressCache, cacheEntryToPoi } = require("../lib/poi-address-cache");

const defaultDb = path.join(__dirname, "..", "data", "review.db");

function parseArgs(argv) {
  const options = { city: "全国", keyword: "", location: "", pageSize: 10, dbPath: defaultDb };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim() || "全国";
    else if (arg.startsWith("--keyword=")) options.keyword = arg.slice("--keyword=".length).trim();
    else if (arg.startsWith("--location=")) options.location = arg.slice("--location=".length).trim();
    else if (arg.startsWith("--page-size=")) options.pageSize = Number(arg.slice("--page-size=".length)) || 10;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  if (!options.keyword && !options.location) {
    throw new Error("请指定 --keyword=搜索词，或 --location=豆瓣地址 以先查映射库");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv);

  if (options.location) {
    const db = openDatabase(options.dbPath);
    try {
      const cached = lookupPoiAddressCache(db, {
        city: options.city,
        addressText: options.location,
      });
      if (cached) {
        const poi = cacheEntryToPoi(cached);
        const output = {
          keyword: options.keyword || "poi-address-cache",
          city: options.city,
          location: options.location,
          from_cache: true,
          cache_key: cached.cache_key,
          count: 1,
          items: [{
            index: 0,
            poi_id: poi.poi_id,
            title: poi.title,
            address: poi.address,
            category: "",
            latitude: poi.latitude ?? null,
            longitude: poi.longitude ?? null,
          }],
        };
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
        return;
      }
    } finally {
      db.close();
    }
  }

  if (!options.keyword) {
    throw new Error("映射库未命中，请补充 --keyword= 再搜腾讯 POI");
  }

  const result = await searchPoi({
    keyword: options.keyword,
    city: options.city,
    pageSize: options.pageSize,
  });
  const output = {
    keyword: options.keyword,
    city: options.city,
    count: result.items?.length || 0,
    items: (result.items || []).map((item, index) => ({
      index,
      poi_id: item.poi_id,
      title: item.title,
      address: item.address,
      category: item.category || "",
      latitude: item.latitude ?? null,
      longitude: item.longitude ?? null,
    })),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

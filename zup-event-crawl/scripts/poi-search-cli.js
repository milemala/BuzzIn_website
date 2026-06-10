#!/usr/bin/env node
"use strict";

/**
 * 命令行搜索腾讯 POI，输出 JSON 供 Cursor Agent 阅读。
 *
 *   node scripts/poi-search-cli.js --city=深圳 --keyword="福田区 寰映影城"
 */
const { searchPoi } = require("../lib/tencent-poi");

function parseArgs(argv) {
  const options = { city: "全国", keyword: "", pageSize: 10 };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim() || "全国";
    else if (arg.startsWith("--keyword=")) options.keyword = arg.slice("--keyword=".length).trim();
    else if (arg.startsWith("--page-size=")) options.pageSize = Number(arg.slice("--page-size=".length)) || 10;
  }
  if (!options.keyword) {
    throw new Error("请指定 --keyword=搜索词");
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv);
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

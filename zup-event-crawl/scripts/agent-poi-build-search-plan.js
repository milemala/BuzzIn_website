#!/usr/bin/env node
"use strict";

/**
 * 从 pending.json 生成 search-plan.json（按豆瓣地址提炼搜索词，保留栋/座）。
 *
 *   node scripts/agent-poi-build-search-plan.js 上海
 */
const fs = require("fs");
const path = require("path");
const { buildEventPoiSearchKeywords } = require("../lib/tencent-poi");

const city = process.argv[2];
if (!city) {
  console.error("用法: node scripts/agent-poi-build-search-plan.js <城市>");
  process.exit(1);
}

const workbench = path.join(__dirname, "..", "data", "poi-agent-workbench", city);
const pendingPath = path.join(workbench, "pending.json");
const outPath = path.join(workbench, "search-plan.json");

function stripCityPrefix(keyword, cityName) {
  const kw = String(keyword || "").trim();
  const c = String(cityName || "").trim().replace(/市$/, "");
  if (!c || c === "全国") return kw;
  return kw.replace(new RegExp(`^${c}市?\\s*`), "").trim() || kw;
}

function keywordsForGroup(group, cityName) {
  const seen = new Set();
  const keywords = [];
  const add = (raw) => {
    const kw = stripCityPrefix(raw, cityName);
    if (!kw || seen.has(kw)) return;
    seen.add(kw);
    keywords.push(kw);
  };
  for (const kw of buildEventPoiSearchKeywords(group.location, cityName, { title: group.sample_title })) {
    add(kw);
  }
  return keywords.slice(0, 3);
}

const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
const payload = {
  city,
  planned_at: new Date().toISOString(),
  groups: pending.groups.map((group) => ({
    group_id: group.group_id,
    keywords: keywordsForGroup(group, city),
  })),
};

fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`已生成 ${payload.groups.length} 组搜索词 → ${outPath}`);

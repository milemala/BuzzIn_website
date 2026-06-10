#!/usr/bin/env node
"use strict";

/**
 * @deprecated 活动 POI 已改由 Cursor 大模型判断，勿再使用本脚本。
 * 见 docs/event-poi-agent-workflow.md
 *
 * 从 pending.json 生成 search-plan.json（旧版 JS 自动搜词，已废弃）。
 */
const fs = require("fs");
const path = require("path");
const { buildEventPoiSearchKeywords, parseDoubanLocation } = require("../lib/tencent-poi");

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

function shortenVenueLabel(text) {
  let venue = String(text || "").trim();
  if (!venue) return "";
  // 店名+分店为主，去掉门牌/楼层/进场说明
  venue = venue.replace(/\s+\d+号.*$/, "").trim();
  venue = venue.replace(/\s*商场\d*楼.*$/i, "").trim();
  venue = venue.replace(/[（(].*[）)]\s*$/, "").trim();
  return venue;
}

function keywordsForGroup(group, cityName) {
  const parsed = parseDoubanLocation(group.location, cityName);
  const venue = shortenVenueLabel(parsed.venue || "");
  const addressCore = shortenVenueLabel(parsed.address || "");
  const seen = new Set();
  const keywords = [];
  const add = (raw) => {
    const kw = stripCityPrefix(raw, cityName);
    if (!kw || kw.length > 48 || seen.has(kw)) return;
    seen.add(kw);
    keywords.push(kw);
  };

  if (venue) add(venue);
  if (parsed.district && venue) add(`${parsed.district} ${venue}`);
  if (addressCore && addressCore !== venue) add(addressCore);
  if (group.sample_title && !venue.includes(group.sample_title.slice(0, 8))) {
    add(group.sample_title);
  }
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

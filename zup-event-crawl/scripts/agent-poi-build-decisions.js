#!/usr/bin/env node
"use strict";

/**
 * @deprecated 活动 POI 已改由 Cursor 大模型判断，勿再使用本脚本。
 * 见 docs/event-poi-agent-workflow.md
 *
 * 根据 search-results.json 生成 decisions.json（旧版 JS 规则，已废弃）。
 */
const fs = require("fs");
const path = require("path");
const {
  assessEventPoiConfidence,
  eventVenueMatchesPoi,
  locationAlignsWithPoi,
  parseDoubanLocation,
  pickBestPoiForEvent,
} = require("../lib/tencent-poi");

const POI_NOISE_TITLE = /停车场|停车区|地下车库|地铁站|公交站|公交总站|卫生间|洗手间|厕所|公厕|座椅|寄存处|售票处|出入口|地下停车场/;

const city = process.argv[2];
if (!city) {
  console.error("用法: node scripts/agent-poi-build-decisions.js <城市>");
  process.exit(1);
}

const workbench = path.join(__dirname, "..", "data", "poi-agent-workbench", city);
const pending = JSON.parse(fs.readFileSync(path.join(workbench, "pending.json"), "utf8"));
const searchPayload = JSON.parse(fs.readFileSync(path.join(workbench, "search-results.json"), "utf8"));
const resultMap = new Map((searchPayload.results || []).map((row) => [row.group_id, row]));

const GRANULARITY_REASON = "豆瓣仅写到大厦/园区级地址，已匹配地标POI，具体楼层/活动室建议人工核对";

function normalizeCompact(text) {
  return String(text || "").replace(/\s+/g, "");
}

function locationBuildingDetail(location, cityName) {
  const parsed = parseDoubanLocation(location, cityName);
  const term = String(parsed.venue || parsed.address || "").trim();
  const match = term.match(/[A-Za-z0-9一二三四五六七八九十]+[栋座楼幢]/);
  return match ? match[0] : "";
}

function poiHasBuildingDetail(title) {
  return /[A-Za-z0-9一二三四五六七八九十]+[栋座楼幢]/.test(String(title || ""));
}

function isFloorOnlyDetail(detail) {
  return /^\d+楼$/.test(String(detail || ""));
}

function eventDistrict(location, cityName) {
  return String(parseDoubanLocation(location, cityName).district || "").trim();
}

function poiMatchesEventDistrict(district, poiAddress) {
  if (!district) return true;
  const addr = String(poiAddress || "");
  if (addr.includes(district)) return true;
  const short = district.replace(/(区|县|市)$/, "");
  return short.length >= 2 && addr.includes(short);
}

function filterItemsByDistrict(items, district) {
  if (!district) return items;
  const matched = items.filter((item) => poiMatchesEventDistrict(district, item.address));
  return matched.length ? matched : items;
}

function isGranularityDoubt(location, cityName, poiTitle, poiAddress) {
  const building = locationBuildingDetail(location, cityName);
  if (!building) return false;

  const addrNorm = normalizeCompact(poiAddress);
  const buildingNorm = normalizeCompact(building);
  if (isFloorOnlyDetail(building) && addrNorm.includes(buildingNorm)) {
    return false;
  }

  if (eventVenueMatchesPoi(location, "", poiTitle)
    && locationAlignsWithPoi(location, poiTitle, poiAddress)) {
    return false;
  }

  if (poiHasBuildingDetail(poiTitle)) {
    const titleNorm = normalizeCompact(poiTitle);
    return !titleNorm.includes(buildingNorm);
  }
  return true;
}

function decideGroup(group, searchResult) {
  const tried = Array.isArray(searchResult?.search_keywords_tried)
    ? searchResult.search_keywords_tried
    : [];
  const items = Array.isArray(searchResult?.items) ? searchResult.items : [];
  const base = {
    group_id: group.group_id,
    event_uids: group.event_uids,
    search_keywords_tried: tried,
  };

  if (!items.length) {
    return {
      ...base,
      action: "reject",
      reason: "腾讯 POI 无结果，建议人工补搜或拒绝",
    };
  }

  const district = eventDistrict(group.location, city);
  const districtItems = filterItemsByDistrict(items, district);
  if (district && !districtItems.some((item) => poiMatchesEventDistrict(district, item.address))) {
    return {
      ...base,
      action: "reject",
      reason: `腾讯 POI 结果均不在豆瓣${district}，建议换词重搜或人工处理`,
      candidates: items,
    };
  }

  const event = { location: group.location, title: group.sample_title, city };
  const { poi, score } = pickBestPoiForEvent(event, districtItems.map((item) => ({
    poi_id: item.poi_id,
    title: item.title,
    address: item.address,
    latitude: item.latitude,
    longitude: item.longitude,
    category: item.category,
  })));

  if (!poi) {
    return { ...base, action: "reject", reason: "候选 POI 无法选出有效场所" };
  }

  if (!poiMatchesEventDistrict(district, poi.address)) {
    return {
      ...base,
      action: "reject",
      reason: `POI 位于${poi.address.match(/市[\u4e00-\u9fa5]+?(区|县)/)?.[0] || "其它区域"}，与豆瓣${district || "地点"}不符`,
      candidates: items,
    };
  }

  if (POI_NOISE_TITLE.test(poi.title) && score < 50) {
    return {
      ...base,
      action: "reject",
      reason: "地址仅命中地铁站/停车场等非活动场所",
      candidates: items,
    };
  }

  const synthetic = {
    location: group.location,
    title: group.sample_title,
    city,
    location_poi_id: poi.poi_id,
    poi_title: poi.title,
    poi_address: poi.address,
  };
  const check = assessEventPoiConfidence(synthetic);
  if (check.doubtful && check.reasons.some((r) => /不像同一场所|非活动场所|得分偏低/.test(r)) && score < 40) {
    return {
      ...base,
      action: "reject",
      reason: check.reasons[0] || "POI 与豆瓣地点不匹配",
      candidates: items,
    };
  }

  const doubtful = isGranularityDoubt(group.location, city, poi.title, poi.address);
  return {
    ...base,
    action: "match",
    poi_id: poi.poi_id,
    poi_title: poi.title,
    poi_address: poi.address,
    latitude: poi.latitude ?? null,
    longitude: poi.longitude ?? null,
    candidates: items,
    confidence: doubtful ? "medium" : "high",
    doubtful,
    reason: doubtful
      ? GRANULARITY_REASON
      : "POI名称与地址与豆瓣活动地点一致",
  };
}

const decisions = [];
for (const group of pending.groups) {
  decisions.push(decideGroup(group, resultMap.get(group.group_id)));
}

const payload = {
  city,
  decided_at: new Date().toISOString(),
  agent: "cursor-composer-batch",
  decisions,
};

const outPath = path.join(workbench, "decisions.json");
fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

const summary = {
  match: decisions.filter((d) => d.action === "match").length,
  reject: decisions.filter((d) => d.action === "reject").length,
  doubtful: decisions.filter((d) => d.action === "match" && d.doubtful).length,
  events: decisions.reduce((n, d) => n + (d.event_uids?.length || 0), 0),
};
console.log(`已生成 decisions → ${outPath}`);
console.log(`组: 匹配 ${summary.match} · 拒绝 ${summary.reject} · 存疑 ${summary.doubtful} · 活动 ${summary.events}`);

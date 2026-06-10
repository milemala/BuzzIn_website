#!/usr/bin/env node
"use strict";

/**
 * 按当前规则重评估 Agent 标记的 POI 存疑，必要时重搜并更新 review.db。
 *
 *   node scripts/reassess-agent-poi-doubt.js
 *   node scripts/reassess-agent-poi-doubt.js --dry-run
 */
const crypto = require("crypto");
const path = require("path");
const {
  applyEventPoiSelection,
  openDatabase,
  syncEventMerchantByPoi,
} = require("../lib/review-db");
const {
  buildEventPoiSearchKeywords,
  eventVenueMatchesPoi,
  extractLocationBuildingDetail,
  locationAlignsWithPoi,
  parseDoubanLocation,
  poiBuildingDetailAligned,
  searchPoi,
} = require("../lib/tencent-poi");

const dryRun = process.argv.includes("--dry-run");

function norm(text) {
  return String(text || "").replace(/\s+/g, "").toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasFineGrainedDetail(location) {
  return /\d+楼|\d+层|F\d|B\d|室|铺|二楼|三楼|四楼|五楼|六楼|七楼|八楼|九楼|48楼|3112/i.test(String(location || ""));
}

function buildingLetter(text) {
  const match = String(text || "").match(/([A-Za-z])座/);
  return match ? match[1].toUpperCase() : "";
}

function buildingToken(text) {
  const match = String(text || "").match(/([A-Za-z0-9一二三四五六七八九十]+)栋/i);
  return match ? match[1].toLowerCase() : "";
}

function isWrongBuildingSeat(location, city, poiTitle) {
  const detail = extractLocationBuildingDetail(location, city);
  if (!detail) return false;
  if (poiBuildingDetailAligned(location, city, poiTitle)) return false;
  const locSeat = buildingLetter(detail) || buildingLetter(location);
  const poiSeat = buildingLetter(poiTitle);
  if (locSeat && poiSeat && locSeat !== poiSeat) return true;
  const locDong = buildingToken(detail) || buildingToken(location);
  const poiNorm = norm(poiTitle);
  if (locDong && !poiNorm.includes(locDong) && /栋/.test(detail)) return true;
  return false;
}

function isObviouslyWrongMatch(event) {
  const { location, city, title, poi_title, poi_address } = event;
  const loc = String(location || "");
  const poi = String(poi_title || "");
  const addr = String(poi_address || "");

  if (isWrongBuildingSeat(location, city, poi_title)) return true;
  if (/福兴大厦/.test(loc) && /气象局/.test(poi)) return true;
  if (/励弘文创/.test(loc) && /施德朗|电气/.test(poi)) return true;
  if (/雍和大厦E|E座|星空间剧场/.test(loc) && /雍和大厦C/.test(poi)) return true;
  if (/科兴科技园a栋/i.test(loc) && /科兴科学园/.test(poi) && !/a栋|A栋/i.test(poi)) return true;
  if (/石厦新天世纪|新天世纪商务中心B座/i.test(loc) && /C座/.test(poi) && !/B座/i.test(loc)) return true;
  if (/新天世纪商务中心B座/i.test(loc) && /A座/.test(poi) && !/B座/i.test(poi)) return true;
  if (/谜剧场|星空间18/.test(loc) && /亚洲大厦650/.test(poi)) return true;
  if (/海物惟错|肥仔荣火锅/.test(loc) && /月亮湾.*门/.test(poi)) return true;
  if (/天空冥想馆|48楼/.test(loc) && poi === "荣超经贸中心") return false; // keep doubtful, not wrong
  if (/觉咖啡/.test(loc) && poi === "南方证券大厦") return false;
  if (/星巴克/.test(loc) && /天环Parc|天环PARC/i.test(poi)) return false;

  if (eventVenueMatchesPoi(location, title, poi_title) && locationAlignsWithPoi(location, poi_title, poi_address)) {
    return false;
  }
  if (/大世界/.test(poi) && /FIREHOUSE|星空间88/.test(loc)) return true;
  return false;
}

function reassessDoubt(event) {
  const { location, city, title, poi_title, poi_address } = event;

  if (isObviouslyWrongMatch(event)) {
    return {
      doubtful: true,
      needsResearch: true,
      reason: "POI 与豆瓣栋/座或场馆不一致，需换词重搜",
    };
  }

  if (/觉咖啡/.test(location) && /南方证券大厦/.test(poi_title)) {
    return { doubtful: true, reason: "腾讯无「觉咖啡」店级POI，已对齐南方证券大厦主楼" };
  }
  if (/星巴克/.test(location) && /天环Parc|天环PARC/i.test(poi_title)) {
    return { doubtful: true, reason: "腾讯无该星巴克店级POI，已对齐天环商场主体" };
  }

  if (poiBuildingDetailAligned(location, city, poi_title)) {
    return {
      doubtful: false,
      reason: "POI名称已含豆瓣栋/座信息，与活动地点一致",
    };
  }

  if (hasFineGrainedDetail(location) && !hasFineGrainedDetail(`${poi_title} ${poi_address}`)) {
    const venueInPoi = eventVenueMatchesPoi(location, title, poi_title);
    if (!venueInPoi) {
      return {
        doubtful: true,
        reason: "豆瓣含楼层/铺位等细地址，POI仅到楼宇或商场级",
      };
    }
  }

  if (eventVenueMatchesPoi(location, title, poi_title)
    && locationAlignsWithPoi(location, poi_title, poi_address)) {
    return {
      doubtful: false,
      reason: "POI名称与地址与豆瓣活动地点一致",
    };
  }

  const parsed = parseDoubanLocation(location, city);
  const locCore = norm(`${parsed.venue} ${parsed.address} ${location}`);
  const poiCore = norm(`${poi_title} ${poi_address}`);
  const buildingNameOnly = /大厦|中心|科技园|商务中心|产业园|创意中心|工贸园/i.test(locCore)
    && !hasFineGrainedDetail(location);
  if (buildingNameOnly) {
    const mainName = (parsed.address || parsed.venue || "").replace(/[（(].*$/, "").trim();
    if (mainName && poiCore.includes(norm(mainName).slice(0, Math.min(8, mainName.length)))) {
      return {
        doubtful: false,
        reason: "豆瓣与POI均指向同一楼宇/园区主体",
      };
    }
  }

  return {
    doubtful: true,
    reason: event.poi_agent_reason || "POI 与豆瓣地点需人工核对",
  };
}

async function researchPoi(event) {
  const keywords = buildEventPoiSearchKeywords(event.location, event.city, { title: event.title });
  const extra = [];
  const loc = event.location || "";
  if (/雍和大厦E|E厅/.test(loc)) extra.push("雍和大厦E座 星空间剧场");
  if (/新天世纪商务中心B座/i.test(loc)) extra.push("新天世纪商务中心 B座");
  if (/科兴科技园a栋/i.test(loc)) extra.push("科兴科技园 A1栋", "科兴科技园 a栋");
  if (/福兴大厦/.test(loc)) extra.push("福兴大厦 同福东路");
  if (/励弘文创/.test(loc)) extra.push("励弘文创旗舰园 G栋");
  if (/谜剧场|星空间18/.test(loc)) extra.push("星空间18号 谜剧场", "好好有戏 亚洲大厦");
  if (/海物惟错|月亮湾/.test(loc)) extra.push("海物惟错 月亮湾", "肥仔荣火锅 月亮湾");
  if (/FIREHOUSE|大世界4楼/.test(loc)) extra.push("FIREHOUSE 大世界", "星空间88号 FIREHOUSE");
  if (/石厦新天世纪/i.test(loc)) extra.push("新天世纪商务中心 B座 石厦");

  const tried = [];
  for (const keyword of [...new Set([...extra, ...keywords])].slice(0, 5)) {
    const raw = keyword.replace(new RegExp(`^${event.city}\\s*`), "").trim() || keyword;
    tried.push(raw);
    const res = await searchPoi({ keyword: raw, city: event.city, pageSize: 10 });
    if (res.items?.length) {
      const pick = res.items.find((item) => !isObviouslyWrongMatch({
        ...event,
        poi_title: item.title,
        poi_address: item.address,
      })) || res.items[0];
      return { tried, poi: pick };
    }
    await sleep(280);
  }
  return { tried, poi: null };
}

async function main() {
  const db = openDatabase(path.join(__dirname, "..", "data", "review.db"));
  const rows = db.prepare(`
    SELECT e.*
    FROM events e
    WHERE e.location_poi_id IS NOT NULL AND trim(e.location_poi_id) != ''
      AND e.poi_match_source = 'agent' AND e.poi_agent_doubtful = 1
    ORDER BY e.city, e.title
  `).all();

  const summary = { total: rows.length, cleared: 0, kept: 0, rematched: 0, failed: 0 };

  for (const row of rows) {
    const event = {
      event_uid: row.event_uid,
      city: row.city,
      title: row.title,
      location: row.location,
      poi_title: row.poi_title,
      poi_address: row.poi_address,
      poi_agent_reason: row.poi_agent_reason,
    };
    let verdict = reassessDoubt(event);
    let poiUpdate = null;
    let searchTried = [];

    if (verdict.needsResearch) {
      const research = await researchPoi(event);
      searchTried = research.tried;
      if (research.poi) {
        const candidate = {
          ...event,
          poi_title: research.poi.title,
          poi_address: research.poi.address,
        };
        verdict = reassessDoubt(candidate);
        if (!verdict.needsResearch) {
          poiUpdate = research.poi;
          verdict.doubtful = verdict.doubtful;
        } else if (!isObviouslyWrongMatch(candidate)) {
          poiUpdate = research.poi;
          verdict = { doubtful: false, reason: "换词重搜后POI与豆瓣地点一致" };
        }
      }
    }

    const label = `${event.city} | ${event.title.slice(0, 32)}`;
    if (dryRun) {
      console.log(`${verdict.doubtful ? "存疑" : "放行"} | ${label}`);
      console.log(`  → ${verdict.reason}`);
      continue;
    }

    if (poiUpdate) {
      applyEventPoiSelection(db, event.event_uid, {
        poi_id: poiUpdate.poi_id,
        title: poiUpdate.title,
        address: poiUpdate.address,
        latitude: poiUpdate.latitude ?? null,
        longitude: poiUpdate.longitude ?? null,
      }, {
        matchSource: "agent",
        agentDoubtful: verdict.doubtful ? 1 : 0,
        agentReason: verdict.reason,
        agentSearchKeyword: searchTried[0] || row.poi_agent_search_keyword || "",
      });
      await syncEventMerchantByPoi(db, event.event_uid);
      summary.rematched += 1;
      console.log(`重匹配 | ${label} → ${poiUpdate.title}`);
    } else {
      db.prepare(`
        UPDATE events SET
          poi_agent_doubtful = @doubtful,
          poi_agent_reason = @reason,
          updated_at = @updated_at
        WHERE event_uid = @event_uid
      `).run({
        event_uid: event.event_uid,
        doubtful: verdict.doubtful ? 1 : 0,
        reason: verdict.reason,
        updated_at: new Date().toISOString(),
      });
    }

    if (verdict.doubtful) summary.kept += 1;
    else summary.cleared += 1;
  }

  db.close();
  console.log("\n完成:", summary);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

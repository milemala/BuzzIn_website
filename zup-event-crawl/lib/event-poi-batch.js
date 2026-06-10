"use strict";

const { pickBestPoiForEvent, searchPoiForEvent } = require("./tencent-poi");
const {
  applyEventPoiSelection,
  getEventByUid,
  listActiveEventsNeedingPoi,
  syncEventMerchantByPoi,
} = require("./review-db");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 为活动列表批量搜索腾讯 POI，按相似度选最佳候选并写入 review.db。
 */
async function batchEventAutoPoi(db, options = {}) {
  const delayMs = options.delayMs ?? 320;
  let targets;

  if (Array.isArray(options.events) && options.events.length) {
    targets = options.events;
  } else if (Array.isArray(options.event_uids) && options.event_uids.length) {
    targets = options.event_uids
      .map((uid) => getEventByUid(db, uid))
      .filter(Boolean);
  } else {
    targets = listActiveEventsNeedingPoi(db, {
      city: options.city || "",
      only_approved: options.only_approved,
      include_with_poi: options.refresh === true,
      limit: options.limit || 500,
    });
  }

  if (!options.refresh) {
    targets = targets.filter((event) => !event.location_poi_id);
  }

  const report = { total: targets.length, ok: 0, fail: 0, results: [] };

  for (const event of targets) {
    try {
      const { items, keyword } = await searchPoiForEvent(
        event.location,
        event.city || "全国",
        { title: event.title },
      );
      if (!items.length) {
        report.fail += 1;
        report.results.push({
          event_uid: event.event_uid,
          title: event.title,
          city: event.city,
          ok: false,
          error: "无 POI 结果",
          keyword,
        });
      } else {
        const { poi: best } = pickBestPoiForEvent(event, items);
        applyEventPoiSelection(db, event.event_uid, best, {
          candidates: items,
          matchSource: "auto",
        });
        await syncEventMerchantByPoi(db, event.event_uid);
        report.ok += 1;
        report.results.push({
          event_uid: event.event_uid,
          title: event.title,
          city: event.city,
          ok: true,
          poi_id: best.poi_id,
          poi_title: best.title,
          keyword,
        });
      }
    } catch (error) {
      report.fail += 1;
      report.results.push({
        event_uid: event.event_uid,
        title: event.title,
        city: event.city,
        ok: false,
        error: error.message,
      });
    }
    await sleep(delayMs);
  }

  return report;
}

module.exports = { batchEventAutoPoi };

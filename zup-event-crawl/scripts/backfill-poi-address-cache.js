#!/usr/bin/env node
"use strict";

/**
 * 清空并回填活动地址→POI 映射库（仅门牌级豆瓣 location；商户不入库）。
 *
 *   node scripts/backfill-poi-address-cache.js
 */
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { backfillPoiAddressCacheFromApproved } = require("../lib/poi-address-cache");

const defaultDb = path.join(__dirname, "..", "data", "review.db");

function main() {
  const db = openDatabase(defaultDb);
  try {
    const summary = backfillPoiAddressCacheFromApproved(db);
    const total = db.prepare("SELECT COUNT(*) AS n FROM poi_address_cache").get().n;
    console.log(`已清空旧映射 ${summary.cleared} 条`);
    console.log(`回填完成：活动 ${summary.events} 条`);
    console.log(`映射库当前共 ${total} 条（仅活动、门牌级地址）`);
  } finally {
    db.close();
  }
}

main();

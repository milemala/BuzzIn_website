#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { isExpired } = require("../lib/event-import-ready");

const outPath = path.join(__dirname, "..", "data", "other-reclassify-pending.json");

function excerpt(text, max = 480) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  return raw.length <= max ? raw : `${raw.slice(0, max)}…`;
}

function main() {
  const db = openDatabase(path.join(__dirname, "..", "data", "review.db"));
  const rows = db.prepare(`
    SELECT event_uid, city, source, title, location, fee, owner, time_text,
           body, douban_event_type, category, suggested, review_reason, raw_detail_text,
           end_date, start_date
    FROM events WHERE category = '其他'
    ORDER BY city, event_uid
  `).all();

  const events = rows
    .filter((row) => !isExpired({ endDate: row.end_date, startDate: row.start_date }))
    .map((row) => ({
      event_uid: row.event_uid,
      city: row.city,
      source: row.source || "douban",
      title: row.title,
      location: row.location,
      fee: row.fee,
      owner: row.owner,
      time_text: row.time_text,
      douban_event_type: row.douban_event_type || "",
      body_excerpt: excerpt(row.body),
      detail_excerpt: excerpt(row.raw_detail_text, 800),
      current_category: row.category,
      current_suggested: Boolean(row.suggested),
      current_reason: row.review_reason || "",
    }));

  fs.writeFileSync(outPath, `${JSON.stringify({
    exported_at: new Date().toISOString(),
    scope: "active_only",
    note: "重审「其他」：线下交流局/破圈社交/跨职业话题→主题沙龙；仅行业展会/博览会/系统培训课/宠物乐园门票等留其他",
    events,
  }, null, 2)}\n`, "utf8");
  console.log(`导出 ${events.length} 条 → ${outPath}`);
  db.close();
}

main();

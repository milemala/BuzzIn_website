#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { isExpired } = require("../lib/event-import-ready");

const TARGET_CATEGORIES = ["疗愈成长", "交友聚会", "其他"];
const outPath = path.join(__dirname, "..", "data", "salon-reclassify-pending.json");

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
    FROM events
    WHERE category IN (${TARGET_CATEGORIES.map(() => "?").join(",")})
    ORDER BY category, city, event_uid
  `).all(...TARGET_CATEGORIES);

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

  const payload = {
    exported_at: new Date().toISOString(),
    scope: "active_only",
    source_categories: TARGET_CATEGORIES,
    note: "将疗愈成长/交友聚会/其他 重分为 主题沙龙 或 其他。保留 current_suggested。",
    events,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`导出 ${events.length} 条 → ${outPath}`);
  db.close();
}

main();

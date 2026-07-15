#!/usr/bin/env node
"use strict";

/**
 * 按审核台 category 补写 Buzz 气泡 content_type（PUT /internal/nows/:id）。
 *
 *   node scripts/sync-event-content-type.js --scope=shorten-restored --buzz-env=prod
 *   node scripts/sync-event-content-type.js --scope=active-imported --buzz-env=prod
 *   node scripts/sync-event-content-type.js --uid=douban:123 --buzz-env=prod
 *   node scripts/sync-event-content-type.js --dry-run ...
 */

const fs = require("fs");
const path = require("path");
const { openDatabase, getEventByUid } = require("../lib/review-db");
const { resolveExpiredAt, resolveContentType, isExpired } = require("../lib/event-import-ready");
const { createClientForEnv } = require("../lib/buzz-now-import");

const root = path.join(__dirname, "..");
const shortenFile = path.join(root, "data", "shorten-expire-before-after.json");

function parseArgs(argv) {
  const options = {
    buzzEnv: "prod",
    dryRun: false,
    scope: "",
    uid: "",
    delayMs: 150,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--buzz-env=")) options.buzzEnv = arg.slice("--buzz-env=".length).trim();
    else if (arg.startsWith("--scope=")) options.scope = arg.slice("--scope=".length).trim();
    else if (arg.startsWith("--uid=")) options.uid = arg.slice("--uid=".length).trim();
    else if (arg.startsWith("--delay-ms=")) options.delayMs = Number(arg.slice("--delay-ms=".length)) || 150;
  }
  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadShortenUids() {
  if (!fs.existsSync(shortenFile)) return new Set();
  const data = JSON.parse(fs.readFileSync(shortenFile, "utf8"));
  return new Set((data.records || []).map((row) => String(row.uid || "").trim()).filter(Boolean));
}

function selectTargets(db, options) {
  if (options.uid) {
    const event = getEventByUid(db, options.uid);
    return event ? [event] : [];
  }

  const shortenUids = options.scope === "shorten-restored" ? loadShortenUids() : null;
  const rows = db.prepare(`
    SELECT e.event_uid
    FROM events e
    JOIN buzz_imports bi
      ON bi.entity_uid = e.event_uid
     AND bi.entity_kind = 'event'
     AND bi.buzz_env = @buzz_env
    WHERE bi.import_status = 'imported'
      AND trim(bi.buzz_id) != ''
    ORDER BY e.city, e.title
  `).all({ buzz_env: options.buzzEnv });

  const targets = [];
  for (const row of rows) {
    const event = getEventByUid(db, row.event_uid);
    if (!event) continue;
    if (shortenUids && !shortenUids.has(event.event_uid)) continue;
    if (options.scope === "shorten-restored" || options.scope === "active-imported") {
      if (isExpired(event)) continue;
    }
    targets.push(event);
  }
  return targets;
}

async function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(path.join(root, "data", "review.db"));
  const client = createClientForEnv({ buzz_env: options.buzzEnv });
  const targets = selectTargets(db, options);

  const stats = { total: targets.length, updated: 0, skipped: 0, fail: 0 };
  const byType = {};
  const failures = [];

  console.log(`补写 content_type（${options.buzzEnv}${options.dryRun ? "，dry-run" : ""}）共 ${targets.length} 条`);

  for (let i = 0; i < targets.length; i += 1) {
    const event = targets[i];
    const eventUid = event.event_uid;
    const imp = db.prepare(`
      SELECT buzz_id FROM buzz_imports
      WHERE entity_kind = 'event' AND entity_uid = ? AND buzz_env = ?
        AND import_status = 'imported' AND trim(buzz_id) != ''
    `).get(eventUid, options.buzzEnv);
    const nowId = String(imp?.buzz_id || "").trim();
    const contentType = resolveContentType(event);
    const label = `${event.city || ""} · ${String(event.title || eventUid).slice(0, 36)}`;

    if (!nowId) {
      stats.fail += 1;
      failures.push({ title: event.title, error: "无 buzz_id" });
      continue;
    }

    try {
      const current = await client.getNowById(nowId);
      const currentType = Number(current?.content_type) || 0;
      if (currentType === contentType) {
        stats.skipped += 1;
        continue;
      }

      if (options.dryRun) {
        stats.updated += 1;
        byType[contentType] = (byType[contentType] || 0) + 1;
        if (stats.updated <= 8) {
          console.log(`  [dry-run] ${label} | ${event.category} → content_type=${contentType}（当前 ${currentType}）`);
        }
        continue;
      }

      await client.updateNow(nowId, { content_type: contentType });
      const verify = await client.getNowById(nowId);
      const saved = Number(verify?.content_type) || 0;
      if (saved !== contentType) {
        throw new Error(`回读不一致：期望 ${contentType}，实际 ${saved}`);
      }
      stats.updated += 1;
      byType[contentType] = (byType[contentType] || 0) + 1;
      if (stats.updated <= 5 || stats.updated % 50 === 0) {
        console.log(`  [${stats.updated}/${targets.length}] ${label} → ${event.category} (${contentType})`);
      }
    } catch (error) {
      stats.fail += 1;
      failures.push({ title: event.title, now_id: nowId, error: error.message });
    }

    if (!options.dryRun && i < targets.length - 1) {
      await sleep(options.delayMs);
    }
  }

  db.close();
  console.log(`完成：更新 ${stats.updated}，跳过 ${stats.skipped}，失败 ${stats.fail}`);
  if (Object.keys(byType).length) {
    console.log("content_type 分布:", Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(", "));
  }
  if (failures.length) {
    console.log("失败样例:");
    failures.slice(0, 8).forEach((row) => console.log(`  - ${row.title?.slice(0, 30) || ""}: ${row.error}`));
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

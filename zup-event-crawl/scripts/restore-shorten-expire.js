#!/usr/bin/env node
"use strict";

/**
 * 还原批量 shorten 改过的推送过期时间。
 * 规则：原结束日在「现在+2个月」以内 → 恢复原值；更远 → 改为「现在+50天 23:59:59」。
 *
 *   node scripts/restore-shorten-expire.js --dry-run
 *   node scripts/restore-shorten-expire.js
 *   node scripts/restore-shorten-expire.js --no-buzz-sync
 */

const fs = require("fs");
const path = require("path");
const { openDatabase, applyManualPushTime, getEventByUid } = require("../lib/review-db");
const { resolveExpiredAt, resolveStartAt } = require("../lib/event-import-ready");
const { applyBuzzEnvToEvent } = require("../lib/buzz-import-store");
const { createClientForEnv } = require("../lib/buzz-now-import");

const root = path.join(__dirname, "..");
const shortenFile = path.join(root, "data", "shorten-expire-before-after.json");
const BUZZ_ENVS = ["prod", "test"];

const CAP_DAYS = 50;
const FAR_MONTHS = 2;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function parseDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function endOfDay(date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 0);
  return copy;
}

function addMonths(date, months) {
  const copy = new Date(date);
  copy.setMonth(copy.getMonth() + months);
  return copy;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function resolveRestoreExpiredAt(originalBefore, now = new Date()) {
  const before = String(originalBefore || "").trim();
  if (!before) return null;
  const beforeDate = parseDateTime(before);
  if (!beforeDate) return before;

  const farThreshold = addMonths(now, FAR_MONTHS);
  if (beforeDate > farThreshold) {
    return formatDateTime(endOfDay(addDays(now, CAP_DAYS)));
  }
  return before;
}

function parseArgs(argv) {
  const options = { dryRun: false, syncBuzz: true };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--no-buzz-sync") options.syncBuzz = false;
  }
  return options;
}

async function syncBuzzExpiredAt(db, eventUid, expiredAt, options) {
  if (!options.syncBuzz) return { updated: 0, errors: [] };
  let updated = 0;
  const errors = [];
  for (const buzzEnv of BUZZ_ENVS) {
    const event = applyBuzzEnvToEvent(db, getEventByUid(db, eventUid), buzzEnv);
    const nowId = String(event?.buzz_now_id || "").trim();
    if (!nowId || event.import_status !== "imported") continue;
    try {
      const client = createClientForEnv({ buzz_env: buzzEnv });
      await client.updateNow(nowId, { expired_at: expiredAt });
      updated += 1;
    } catch (error) {
      errors.push({ buzz_env: buzzEnv, now_id: nowId, error: error.message });
    }
  }
  return { updated, errors };
}

async function main() {
  const options = parseArgs(process.argv);
  if (!fs.existsSync(shortenFile)) {
    throw new Error(`缺少对照文件: ${shortenFile}`);
  }

  const data = JSON.parse(fs.readFileSync(shortenFile, "utf8"));
  const records = data.records || [];
  const now = new Date();
  const capAt = formatDateTime(endOfDay(addDays(now, CAP_DAYS)));
  const farThreshold = addMonths(now, FAR_MONTHS);

  const db = openDatabase(path.join(root, "data", "review.db"));
  const stats = {
    total: records.length,
    updated: 0,
    skipped_same: 0,
    skipped_missing: 0,
    restored_original: 0,
    capped_50d: 0,
    buzz_updated: 0,
    fail: 0,
  };
  const samples = [];
  const failures = [];

  for (const record of records) {
    const uid = String(record.uid || "").trim();
    const before = String(record.before || "").trim();
    if (!uid || !before) continue;

    const event = getEventByUid(db, uid);
    if (!event) {
      stats.skipped_missing += 1;
      continue;
    }

    const targetExpiredAt = resolveRestoreExpiredAt(before, now);
    const currentExpiredAt = String(resolveExpiredAt(event) || "").trim();
    if (!targetExpiredAt || currentExpiredAt === targetExpiredAt) {
      stats.skipped_same += 1;
      continue;
    }

    const beforeDate = parseDateTime(before);
    const capped = beforeDate && beforeDate > farThreshold;
    if (capped) stats.capped_50d += 1;
    else stats.restored_original += 1;

    if (options.dryRun) {
      stats.updated += 1;
      if (samples.length < 10) {
        samples.push({
          uid,
          title: record.title,
          city: record.city,
          before,
          current: currentExpiredAt,
          target: targetExpiredAt,
          mode: capped ? "cap_50d" : "restore",
        });
      }
      continue;
    }

    try {
      const startAt = String(resolveStartAt(event) || "").trim();
      applyManualPushTime(db, uid, {
        start_at: startAt,
        expired_at: targetExpiredAt,
      });
      const buzz = await syncBuzzExpiredAt(db, uid, targetExpiredAt, options);
      stats.buzz_updated += buzz.updated;
      if (buzz.errors.length) {
        failures.push({ uid, title: record.title, buzz_errors: buzz.errors });
      }
      stats.updated += 1;
      if (samples.length < 8) {
        samples.push({
          uid,
          title: record.title,
          before,
          current: currentExpiredAt,
          target: targetExpiredAt,
          mode: capped ? "cap_50d" : "restore",
          buzz: buzz.updated,
        });
      }
    } catch (error) {
      stats.fail += 1;
      failures.push({ uid, title: record.title, error: error.message });
    }
  }

  db.close();

  console.log(`还原 shorten 过期时间${options.dryRun ? "（dry-run）" : ""}`);
  console.log(`  对照记录: ${stats.total}`);
  console.log(`  将更新: ${stats.updated}`);
  console.log(`  恢复原日期: ${stats.restored_original}`);
  console.log(`  超2个月封顶50天: ${stats.capped_50d}（封顶值 ${capAt}）`);
  console.log(`  已是目标值跳过: ${stats.skipped_same}`);
  console.log(`  库中不存在: ${stats.skipped_missing}`);
  if (!options.dryRun) {
    console.log(`  Buzz 同步: ${stats.buzz_updated}`);
    console.log(`  失败: ${stats.fail}`);
  }
  if (samples.length) {
    console.log("示例：");
    for (const row of samples) {
      console.log(`  [${row.mode}] ${row.city || ""} ${row.title?.slice(0, 28)}`);
      console.log(`    ${row.current} → ${row.target}`);
    }
  }
  if (failures.length) {
    console.log("失败/部分 Buzz 同步问题：");
    for (const row of failures.slice(0, 10)) {
      console.log(`  ${row.uid} ${row.title?.slice(0, 24)}`, row.error || row.buzz_errors);
    }
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

/**
 * 查询线上未过期气泡的群聊参与情况（进群 / 发言），按自然日筛选。
 *
 * 用法：
 *   node scripts/query-bubble-group-activity.js --env=prod --from=2026-06-22 --to=2026-06-26
 *   node scripts/query-bubble-group-activity.js --env=prod --from=2026-06-26 --scope=crawled
 */

const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { queryBubbleGroupActivity } = require("../lib/bubble-group-activity");

const root = path.join(__dirname, "..");

function readArg(name, fallback = "") {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function chinaDateString(date = new Date()) {
  const offset = date.getTime() + date.getTimezoneOffset() * 60000 + 8 * 3600000;
  const d = new Date(offset);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function main() {
  const buzzEnv = readArg("env", "prod");
  const dateFrom = readArg("from", chinaDateString());
  const dateTo = readArg("to", dateFrom);
  const scope = readArg("scope", "all");
  const onlyActive = readArg("only-active", "true") !== "false";
  const dbPath = process.argv.find((arg) => arg.endsWith(".db")) || path.join(root, "data", "review.db");
  const db = openDatabase(dbPath);

  const result = await queryBubbleGroupActivity({
    buzz_env: buzzEnv,
    date_from: dateFrom,
    date_to: dateTo,
    scope,
    only_active: onlyActive,
    db,
  });
  db.close();

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

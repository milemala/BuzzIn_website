#!/usr/bin/env node
"use strict";

/**
 * 将 Agent 编写的 body-decisions.json 写入 review.db。
 *
 *   node scripts/apply-event-body-decisions.js --city=深圳
 */
const fs = require("fs");
const path = require("path");
const { applyEventBody, openDatabase } = require("../lib/review-db");
const { validateBodyDecision } = require("../lib/event-body-agent");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");
const workbenchRoot = path.join(root, "data", "poi-agent-workbench");

function parseArgs(argv) {
  const options = {
    city: "",
    file: "",
    dbPath: defaultDb,
    dryRun: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg.startsWith("--file=")) options.file = arg.slice("--file=".length).trim();
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (!arg.startsWith("--") && arg.endsWith(".json")) options.file = arg;
  }
  if (!options.file && options.city) {
    options.file = path.join(workbenchRoot, options.city, "body-decisions.json");
  }
  if (!options.file || !fs.existsSync(options.file)) {
    throw new Error(options.file
      ? `找不到文件: ${options.file}`
      : "请指定 --city=城市 或 --file=body-decisions.json");
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv);
  const payload = JSON.parse(fs.readFileSync(options.file, "utf8"));
  const decisions = Array.isArray(payload.decisions) ? payload.decisions : [];
  const db = openDatabase(options.dbPath);
  const summary = { ok: 0, fail: 0 };

  try {
    for (const decision of decisions) {
      const eventUid = String(decision.event_uid || "").trim();
      const check = validateBodyDecision(decision);
      if (!check.ok) {
        summary.fail += 1;
        console.warn(`✗ ${eventUid || "(无 uid)"}: ${check.errors.join("；")}`);
        continue;
      }
      if (options.dryRun) {
        summary.ok += 1;
        console.log(`[dry-run] ${eventUid} → ${check.bodyText.slice(0, 48)}…`);
        continue;
      }
      try {
        const event = applyEventBody(db, eventUid, decision);
        summary.ok += 1;
        console.log(`✓ ${event.title?.slice(0, 40)} · ${check.bodyText.slice(0, 36)}…`);
      } catch (error) {
        summary.fail += 1;
        console.warn(`✗ ${eventUid}: ${error.message}`);
      }
    }
    console.log(`完成: 成功 ${summary.ok} · 失败 ${summary.fail}`);
  } finally {
    db.close();
  }
}

main();

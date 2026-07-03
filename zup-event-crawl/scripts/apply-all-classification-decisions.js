#!/usr/bin/env node
"use strict";

/**
 * 将各城 workbench 下 classification-decisions.json 批量写入 review.db。
 *
 *   node scripts/apply-all-classification-decisions.js
 *   node scripts/apply-all-classification-decisions.js --dry-run
 */
const fs = require("fs");
const path = require("path");
const { applyEventClassification, openDatabase } = require("../lib/review-db");
const { validateClassificationDecision } = require("../lib/event-classification");
const { classificationDecisionsPath, workbenchDir } = require("../lib/export-classification-pending");

const workbenchRoot = path.join(__dirname, "..", "data", "poi-agent-workbench");
const defaultDb = path.join(__dirname, "..", "data", "review.db");

function parseArgs(argv) {
  const options = { dbPath: defaultDb, dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  return options;
}

function listDecisionFiles() {
  if (!fs.existsSync(workbenchRoot)) return [];
  const files = [];
  for (const entry of fs.readdirSync(workbenchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(workbenchRoot, entry.name, "classification-decisions.json");
    if (fs.existsSync(filePath)) files.push(filePath);
  }
  return files.sort();
}

function main() {
  const options = parseArgs(process.argv);
  const db = openDatabase(options.dbPath);
  const summary = { files: 0, ok: 0, fail: 0, skip: 0 };

  try {
    for (const filePath of listDecisionFiles()) {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const decisions = Array.isArray(payload.decisions) ? payload.decisions : [];
      if (!decisions.length) continue;
      summary.files += 1;

      for (const decision of decisions) {
        const check = validateClassificationDecision(decision);
        if (!check.ok) {
          summary.fail += 1;
          console.warn(`✗ ${decision.event_uid || "?"}: ${check.errors.join("；")}`);
          continue;
        }
        if (options.dryRun) {
          summary.ok += 1;
          continue;
        }
        try {
          applyEventClassification(db, check.eventUid, decision);
          summary.ok += 1;
        } catch (error) {
          summary.fail += 1;
          console.warn(`✗ ${check.eventUid}: ${error.message}`);
        }
      }
    }

    console.log(`完成: ${summary.files} 个 decisions 文件 · 成功 ${summary.ok} · 失败 ${summary.fail}${options.dryRun ? "（dry-run）" : ""}`);
  } finally {
    db.close();
  }
}

main();

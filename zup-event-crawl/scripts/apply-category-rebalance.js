#!/usr/bin/env node
"use strict";

/**
 * 应用 data/category-rebalance-decisions.json（局部重分类，不改全量 workbench）。
 */
const fs = require("fs");
const path = require("path");
const { applyEventClassification, openDatabase } = require("../lib/review-db");
const { validateClassificationDecision } = require("../lib/event-classification");

const decisionsPath = path.join(__dirname, "..", "data", "category-rebalance-decisions.json");
const defaultDb = path.join(__dirname, "..", "data", "review.db");

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const payload = JSON.parse(fs.readFileSync(decisionsPath, "utf8"));
  const decisions = Array.isArray(payload.decisions) ? payload.decisions : [];
  const db = openDatabase(defaultDb);
  let ok = 0;
  let fail = 0;

  try {
    for (const decision of decisions) {
      const check = validateClassificationDecision(decision);
      if (!check.ok) {
        fail += 1;
        console.warn(`✗ ${decision.event_uid}: ${check.errors.join("；")}`);
        continue;
      }
      if (dryRun) {
        ok += 1;
        continue;
      }
      try {
        applyEventClassification(db, check.eventUid, decision);
        ok += 1;
      } catch (error) {
        fail += 1;
        console.warn(`✗ ${check.eventUid}: ${error.message}`);
      }
    }
    console.log(`完成: 成功 ${ok} · 失败 ${fail}${dryRun ? "（dry-run）" : ""}`);
  } finally {
    db.close();
  }
}

main();

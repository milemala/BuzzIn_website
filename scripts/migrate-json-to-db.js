#!/usr/bin/env node

"use strict";

const fs = require("fs");
const path = require("path");
const {
  getEventsPayload,
  getReviewState,
  importPayload,
  importReviewState,
  openDatabase,
} = require("./lib/review-db");

const root = process.cwd();
const dbPath = process.argv[2] || path.join(root, "data", "review.db");
const crawledEventsPath = path.join(root, "data", "crawled-events.json");
const reviewDecisionsPath = path.join(root, "data", "review-decisions.json");

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function main() {
  const db = openDatabase(dbPath);
  try {
    const payload = readJson(crawledEventsPath, { events: [] });
    const reviewState = readJson(reviewDecisionsPath, { decisions: {} });

    importPayload(db, payload, { mode: "replace-all" });
    importReviewState(db, reviewState);

    const importedPayload = getEventsPayload(db);
    const importedState = getReviewState(db);
    console.log(JSON.stringify({
      dbPath,
      cityCount: importedPayload.cities.length,
      eventCount: importedPayload.events.length,
      reviewDecisionCount: Object.keys(importedState.decisions).length,
      cities: importedPayload.cities,
    }, null, 2));
  } finally {
    db.close();
  }
}

main();

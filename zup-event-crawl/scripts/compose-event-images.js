#!/usr/bin/env node
"use strict";

const path = require("path");
const { batchComposeEventImages } = require("../lib/compose-event-images-batch");
const { openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const cityArg = argv.find((arg) => arg.startsWith("--city="));
const city = cityArg ? cityArg.slice("--city=".length) : "";
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

async function main() {
  const db = openDatabase(dbPath);
  const report = await batchComposeEventImages(db, {
    city: city || undefined,
    dryRun,
    force,
    rootDir: root,
  });
  db.close();

  const updated = report.ok + report.dry_run;
  const cityLabel = city || "全部";
  console.log(dryRun
    ? `Would compose ${updated} ${cityLabel} events (total ${report.total}, skipped ${report.skip_done} already composed, ${report.skip_no_source} no source)`
    : `Composed ${updated} ${cityLabel} events (total ${report.total}, skipped ${report.skip_done} already composed, ${report.skip_no_source} no source, ${report.fail} failed)`);

  if (report.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

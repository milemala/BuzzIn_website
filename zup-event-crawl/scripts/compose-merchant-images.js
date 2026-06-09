#!/usr/bin/env node
"use strict";

const path = require("path");
const { batchComposeMerchantImages } = require("../lib/compose-merchant-images-batch");
const { ensureMerchantSchema } = require("../lib/merchant-db");
const { openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const statusArg = argv.find((arg) => arg.startsWith("--status="));
const status = statusArg ? statusArg.slice("--status=".length) : "approved";
const concurrency = Math.max(1, Number(
  argv.find((arg) => arg.startsWith("--concurrency="))?.split("=")[1] || 5,
));
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

async function main() {
  const db = openDatabase(dbPath);
  ensureMerchantSchema(db);

  const report = await batchComposeMerchantImages(db, {
    status,
    dryRun,
    force,
    concurrency,
    rootDir: root,
  });

  db.close();

  const updated = report.ok + report.dry_run;
  const label = { pending: "待定", approved: "已通过", rejected: "已拒绝", all: "全部" }[status] || status;
  console.log(dryRun
    ? `Would compose ${updated} ${label} merchants (total ${report.total}, skipped ${report.skip_done} already composed, ${report.skip_no_source} no source)`
    : `Composed ${updated} ${label} merchants (total ${report.total}, skipped ${report.skip_done} already composed, ${report.skip_no_source} no source, ${report.fail} failed)`);

  if (report.fail > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

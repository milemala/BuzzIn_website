#!/usr/bin/env node
"use strict";

const path = require("path");
const {
  buildComposedImageUrl,
  isComposedImageUrl,
  saveComposedImage,
} = require("../lib/composed-image");
const { composeMerchantCoverFromUrl } = require("../lib/merchant-image-compose");
const { normalizeMerchantImageUrl } = require("../lib/merchant-image-url");
const { ensureMerchantSchema } = require("../lib/merchant-db");
const { openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const concurrency = Math.max(1, Number(
  argv.find((arg) => arg.startsWith("--concurrency="))?.split("=")[1] || 5,
));
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

const update = `
  UPDATE merchants
  SET image_original = @image_original,
      image = @image,
      updated_at = @updated_at
  WHERE merchant_uid = @merchant_uid
`;

function listApprovedMerchantsWithImage(db) {
  return db.prepare(`
    SELECT m.merchant_uid, m.name, m.city, m.image, m.image_original
    FROM merchants m
    INNER JOIN merchant_review_decisions d ON d.merchant_uid = m.merchant_uid
    WHERE d.status = 'approved' AND m.image != ''
    ORDER BY m.city, m.name
  `).all();
}

function resolveSourceUrl(row) {
  const currentImage = String(row.image || "").trim();
  const storedOriginal = String(row.image_original || "").trim();
  if (storedOriginal && !isComposedImageUrl(storedOriginal)) {
    return storedOriginal;
  }
  if (currentImage && !isComposedImageUrl(currentImage)) {
    return normalizeMerchantImageUrl(currentImage);
  }
  return "";
}

async function composeOne(row, options) {
  const sourceUrl = resolveSourceUrl(row);
  if (!sourceUrl) {
    return { status: "skip_no_source", row };
  }

  const currentImage = String(row.image || "").trim();
  if (!options.force && isComposedImageUrl(currentImage)) {
    return { status: "skip_done", row };
  }

  if (options.dryRun) {
    return {
      status: "dry_run",
      row,
      sourceUrl,
      composedUrl: buildComposedImageUrl(row.merchant_uid),
    };
  }

  const buffer = await composeMerchantCoverFromUrl(sourceUrl, {
    cacheDir: options.cacheDir,
  });
  const composedUrl = buildComposedImageUrl(row.merchant_uid);
  saveComposedImage(row.merchant_uid, buffer, options.root);
  options.stmt.run({
    merchant_uid: row.merchant_uid,
    image_original: sourceUrl,
    image: composedUrl,
    updated_at: options.now,
  });
  return { status: "ok", row, composedUrl };
}

async function runPool(rows, worker, limit) {
  const results = [];
  let index = 0;

  async function workerLoop() {
    while (index < rows.length) {
      const row = rows[index];
      index += 1;
      results.push(await worker(row));
    }
  }

  await Promise.all(Array.from({ length: limit }, () => workerLoop()));
  return results;
}

async function main() {
  const db = openDatabase(dbPath);
  ensureMerchantSchema(db);
  const rows = listApprovedMerchantsWithImage(db);
  const stmt = db.prepare(update);
  const now = new Date().toISOString();
  const cacheDir = path.join(root, "data", "image-cache");

  const counters = {
    ok: 0,
    skip_done: 0,
    skip_no_source: 0,
    fail: 0,
  };

  let processed = 0;
  const results = await runPool(rows, async (row) => {
    try {
      const result = await composeOne(row, {
        dryRun,
        force,
        cacheDir,
        root,
        stmt,
        now,
      });
      counters[result.status] = (counters[result.status] || 0) + 1;
      processed += 1;
      if (result.status === "ok") {
        console.log(`OK [${processed}/${rows.length}] ${row.name}（${row.city}）`);
      } else if (result.status === "fail") {
        console.error(`FAIL [${processed}/${rows.length}] ${row.name}（${row.city}）`);
      }
      return result;
    } catch (error) {
      counters.fail += 1;
      processed += 1;
      console.error(`FAIL [${processed}/${rows.length}] ${row.name}（${row.city}）: ${error.message}`);
      return { status: "fail", row, error };
    }
  }, concurrency);

  db.close();

  const skippedDone = counters.skip_done || 0;
  const skippedNoSource = counters.skip_no_source || 0;
  const updated = (counters.ok || 0) + (counters.dry_run || 0);
  const failed = counters.fail || 0;

  console.log(dryRun
    ? `Would compose ${updated} approved merchants (total ${rows.length}, skipped ${skippedDone} already composed, ${skippedNoSource} no source)`
    : `Composed ${updated} approved merchants (total ${rows.length}, skipped ${skippedDone} already composed, ${skippedNoSource} no source, ${failed} failed)`);

  if (failed > 0) process.exitCode = 1;
  return results;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

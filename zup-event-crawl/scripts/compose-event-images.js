#!/usr/bin/env node
"use strict";

const path = require("path");
const { saveComposedImage, isComposedImageUrl, buildComposedImageUrl } = require("../lib/composed-image");
const { composeEventPosterFromUrl } = require("../lib/event-image-compose");
const { isExpired } = require("../lib/event-import-ready");
const { openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const force = argv.includes("--force");
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

const update = `
  UPDATE events
  SET image_original = @image_original,
      image = @image,
      updated_at = @updated_at
  WHERE event_uid = @event_uid
`;

async function main() {
  const db = openDatabase(dbPath);
  const rows = db.prepare(`
    SELECT event_uid, title, city, image, image_original, start_date, end_date
    FROM events
    ORDER BY city, title
  `).all();
  const stmt = db.prepare(update);
  const now = new Date().toISOString();

  let skippedExpired = 0;
  let skippedDone = 0;
  let skippedNoImage = 0;
  let failed = 0;
  let updated = 0;

  for (const row of rows) {
    if (isExpired(row)) {
      skippedExpired += 1;
      continue;
    }

    const currentImage = String(row.image || "").trim();
    if (!currentImage) {
      skippedNoImage += 1;
      continue;
    }

    if (!force && isComposedImageUrl(currentImage)) {
      skippedDone += 1;
      continue;
    }

    const sourceUrl = String(row.image_original || "").trim() || currentImage;
    if (isComposedImageUrl(sourceUrl)) {
      skippedNoImage += 1;
      continue;
    }

    try {
      const buffer = await composeEventPosterFromUrl(sourceUrl, {
        cacheDir: path.join(root, "data", "image-cache"),
      });
      const composedUrl = buildComposedImageUrl(row.event_uid);

      if (dryRun) {
        console.log(`[dry-run] ${row.title}（${row.city}）`);
        console.log(`  ${sourceUrl}`);
        console.log(`  -> ${composedUrl}`);
        updated += 1;
        continue;
      }

      saveComposedImage(row.event_uid, buffer, root);
      stmt.run({
        event_uid: row.event_uid,
        image_original: sourceUrl,
        image: composedUrl,
        updated_at: now,
      });
      updated += 1;
      console.log(`OK ${row.title}（${row.city}）`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${row.title}（${row.city}）: ${error.message}`);
    }
  }

  db.close();

  console.log(dryRun
    ? `Would compose ${updated} active events (skipped ${skippedExpired} expired, ${skippedDone} already composed, ${skippedNoImage} no image)`
    : `Composed ${updated} active events (skipped ${skippedExpired} expired, ${skippedDone} already composed, ${skippedNoImage} no image, ${failed} failed)`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

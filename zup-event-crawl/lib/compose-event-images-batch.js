"use strict";

const path = require("path");
const {
  buildComposedImageUrl,
  isComposedImageUrl,
  saveComposedImage,
} = require("./composed-image");
const { composeEventPosterFromUrl, composeEventPosterImage } = require("./event-image-compose");
const { getScrapeLocalImagePath } = require("./scrape-local-image");
const { readImageFile } = require("./image-fetch");
const { isExpired } = require("./event-import-ready");
const { eventUidFor } = require("./review-db");

function resolveEventSourceUrl(row) {
  const currentImage = String(row.image || "").trim();
  const storedOriginal = String(row.image_original || row.imageOriginal || "").trim();
  if (storedOriginal && !isComposedImageUrl(storedOriginal)) {
    return storedOriginal;
  }
  if (currentImage && !isComposedImageUrl(currentImage)) {
    return currentImage;
  }
  return "";
}

function listEventsForImageCompose(db, options = {}) {
  const params = [];
  let sql = `
    SELECT event_uid, title, city, image, image_original, start_date, end_date
    FROM events
    WHERE image != ''
  `;

  if (Array.isArray(options.event_uids) && options.event_uids.length) {
    const placeholders = options.event_uids.map(() => "?").join(", ");
    sql += ` AND event_uid IN (${placeholders})`;
    params.push(...options.event_uids);
  } else if (options.city) {
    sql += " AND city = ?";
    params.push(options.city);
  }

  if (options.only_active !== false) {
    sql += " AND (end_date IS NULL OR end_date = '' OR end_date >= date('now'))";
  }

  sql += " ORDER BY city, title";
  return db.prepare(sql).all(...params);
}

async function composeEventImageRecord(record, options = {}) {
  const root = options.rootDir || path.join(__dirname, "..");
  const cacheDir = options.cacheDir || path.join(root, "data", "image-cache");
  const force = options.force === true;
  const dryRun = options.dryRun === true;

  const eventUid = record.event_uid || eventUidFor(record);
  const sourceUrl = resolveEventSourceUrl(record);
  if (!sourceUrl) {
    return { status: "skip_no_source", record, eventUid };
  }

  const currentImage = String(record.image || "").trim();
  if (!force && isComposedImageUrl(currentImage)) {
    return { status: "skip_done", record, eventUid };
  }

  if (dryRun) {
    return {
      status: "dry_run",
      record,
      eventUid,
      sourceUrl,
      composedUrl: buildComposedImageUrl(eventUid),
    };
  }

  const scrapeLocalPath = getScrapeLocalImagePath(sourceUrl, root);
  const buffer = scrapeLocalPath
    ? await composeEventPosterImage(readImageFile(scrapeLocalPath).buffer, {
      title: record.title,
    })
    : await composeEventPosterFromUrl(sourceUrl, {
      cacheDir,
      rootDir: root,
      title: record.title,
    });
  const composedUrl = buildComposedImageUrl(eventUid);
  saveComposedImage(eventUid, buffer, root);

  return {
    status: "ok",
    record,
    eventUid,
    sourceUrl,
    composedUrl,
    image_original: sourceUrl,
    image: composedUrl,
  };
}

async function composeScrapedEventImage(event, options = {}) {
  const result = await composeEventImageRecord(event, options);
  if (result.status === "ok") {
    event.image_original = result.image_original;
    event.imageOriginal = result.image_original;
    event.image = result.image;
  }
  return result;
}

async function batchComposeEventImages(db, options = {}) {
  const rows = listEventsForImageCompose(db, options).filter((row) => !isExpired(row));
  const root = options.rootDir || path.join(__dirname, "..");
  const cacheDir = options.cacheDir || path.join(root, "data", "image-cache");
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE events
    SET image_original = @image_original,
        image = @image,
        updated_at = @updated_at
    WHERE event_uid = @event_uid
  `);

  const counters = { ok: 0, dry_run: 0, skip_done: 0, skip_no_source: 0, fail: 0 };
  const log = options.log !== false;

  for (const row of rows) {
    try {
      const result = await composeEventImageRecord(row, {
        rootDir: root,
        cacheDir,
        force: options.force,
        dryRun: options.dryRun,
      });
      counters[result.status] = (counters[result.status] || 0) + 1;
      if (result.status === "ok") {
        stmt.run({
          event_uid: result.eventUid,
          image_original: result.sourceUrl,
          image: result.composedUrl,
          updated_at: now,
        });
        if (log) console.log(`  4:3 OK ${row.title}（${row.city}）`);
      }
    } catch (error) {
      counters.fail += 1;
      if (log) console.error(`  4:3 FAIL ${row.title}（${row.city}）: ${error.message}`);
    }
  }

  return {
    total: rows.length,
    ok: counters.ok || 0,
    dry_run: counters.dry_run || 0,
    skip_done: counters.skip_done || 0,
    skip_no_source: counters.skip_no_source || 0,
    fail: counters.fail || 0,
  };
}

module.exports = {
  batchComposeEventImages,
  composeEventImageRecord,
  composeScrapedEventImage,
  listEventsForImageCompose,
  resolveEventSourceUrl,
};

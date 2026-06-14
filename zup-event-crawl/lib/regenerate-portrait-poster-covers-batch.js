"use strict";

const path = require("path");
const sharp = require("sharp");
const { isComposedImageUrl } = require("./composed-image");
const {
  composeEventImageRecord,
  resolveEventSourceUrl,
} = require("./compose-event-images-batch");
const { isPortraitPosterLayout } = require("./event-image-compose");
const { ensureImageCached, readImageFile } = require("./image-fetch");
const { getScrapeLocalImagePath, parseScrapeLocalRelativePath } = require("./scrape-local-image");

function isPosterSourceEvent(row) {
  if (row.source === "xiaohongshu") {
    const rel = parseScrapeLocalRelativePath(row.image_original || "");
    return Boolean(rel && rel.includes("/posters/"));
  }
  const original = String(row.image_original || row.imageOriginal || "").trim();
  if (original && !isComposedImageUrl(original)) return true;
  const current = String(row.image || "").trim();
  return Boolean(current && !isComposedImageUrl(current));
}

function listApprovedPortraitPosterCandidates(db, options = {}) {
  const params = [];
  let sql = `
    SELECT e.event_uid, e.title, e.city, e.source, e.image, e.image_original, e.end_date,
           COALESCE(r.status, 'pending') AS review_status
    FROM events e
    LEFT JOIN review_decisions r ON r.event_uid = e.event_uid
    WHERE e.image != ''
      AND COALESCE(r.status, 'pending') = 'approved'
      AND (e.end_date IS NULL OR e.end_date = '' OR e.end_date >= date('now'))
  `;

  if (options.city) {
    sql += " AND e.city = ?";
    params.push(options.city);
  }

  if (Array.isArray(options.event_uids) && options.event_uids.length) {
    const placeholders = options.event_uids.map(() => "?").join(", ");
    sql += ` AND e.event_uid IN (${placeholders})`;
    params.push(...options.event_uids);
  }

  sql += " ORDER BY e.city, e.title";
  return db.prepare(sql).all(...params).filter(isPosterSourceEvent);
}

async function loadSourceBuffer(record, options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, "..");
  const cacheDir = options.cacheDir || path.join(rootDir, "data", "image-cache");
  const sourceUrl = resolveEventSourceUrl(record);
  if (!sourceUrl) return null;

  const localPath = getScrapeLocalImagePath(sourceUrl, rootDir);
  if (localPath) {
    return readImageFile(localPath).buffer;
  }

  const cachedPath = await ensureImageCached(sourceUrl, cacheDir);
  return readImageFile(cachedPath).buffer;
}

async function isPortraitPosterRecord(record, options = {}) {
  const buffer = await loadSourceBuffer(record, options);
  if (!buffer) return false;
  const meta = await sharp(buffer).metadata();
  return isPortraitPosterLayout(meta.width, meta.height);
}

async function batchRegeneratePortraitPosterCovers(db, options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, "..");
  const cacheDir = options.cacheDir || path.join(rootDir, "data", "image-cache");
  const dryRun = options.dryRun === true;
  const log = options.log !== false;
  const candidates = listApprovedPortraitPosterCandidates(db, options);

  const results = {
    candidates: candidates.length,
    total: 0,
    ok: 0,
    dry_run: 0,
    skip_landscape: 0,
    skip_no_source: 0,
    skip_no_title: 0,
    fail: 0,
    items: [],
  };

  const updateStmt = !dryRun && options.updateDb !== false
    ? db.prepare(`
      UPDATE events
      SET image_original = @image_original,
          image = @image,
          updated_at = @updated_at
      WHERE event_uid = @event_uid
    `)
    : null;
  const now = new Date().toISOString();

  for (const record of candidates) {
    const title = String(record.title || "").trim();
    if (!title) {
      results.skip_no_title += 1;
      continue;
    }

    const sourceUrl = resolveEventSourceUrl(record);
    if (!sourceUrl) {
      results.skip_no_source += 1;
      continue;
    }

    let portrait = false;
    try {
      portrait = await isPortraitPosterRecord(record, { rootDir, cacheDir });
    } catch (error) {
      results.fail += 1;
      results.items.push({
        status: "fail",
        record,
        error: `读取原图失败: ${error.message || error}`,
      });
      if (log) console.error(`  ✗ ${record.title}（${record.city}）: ${error.message}`);
      continue;
    }

    if (!portrait) {
      results.skip_landscape += 1;
      continue;
    }

    results.total += 1;

    if (dryRun) {
      results.dry_run += 1;
      if (log) console.log(`  [dry-run] ${record.title}（${record.city}）`);
      continue;
    }

    try {
      const result = await composeEventImageRecord(record, {
        rootDir,
        cacheDir,
        force: true,
      });
      if (result.status === "ok") {
        results.ok += 1;
        if (updateStmt) {
          updateStmt.run({
            event_uid: result.eventUid,
            image_original: result.image_original,
            image: result.image,
            updated_at: now,
          });
        }
        if (log) console.log(`  OK ${record.title}（${record.city}）`);
      } else {
        results.skip_no_source += 1;
      }
    } catch (error) {
      results.fail += 1;
      results.items.push({
        status: "fail",
        record,
        error: error.message || String(error),
      });
      if (log) console.error(`  ✗ ${record.title}（${record.city}）: ${error.message}`);
    }
  }

  return results;
}

module.exports = {
  batchRegeneratePortraitPosterCovers,
  isPosterSourceEvent,
  isPortraitPosterRecord,
  listApprovedPortraitPosterCandidates,
  loadSourceBuffer,
};

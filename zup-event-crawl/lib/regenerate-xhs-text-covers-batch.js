"use strict";

const { buildComposedImageUrl, saveComposedImage } = require("./composed-image");
const { parseScrapeLocalRelativePath } = require("./scrape-local-image");
const { composeXhsTextCover } = require("./xhs-text-cover-compose");

function isXhsTextCoverEvent(row) {
  if (row.source !== "xiaohongshu") return false;
  const rel = parseScrapeLocalRelativePath(row.image_original || "");
  if (!rel) return true;
  return rel.includes("/images/") && !rel.includes("/posters/");
}

function listXhsTextCoverEvents(db, options = {}) {
  const params = [];
  let sql = `
    SELECT e.event_uid, e.title, e.city, e.source, e.image, e.image_original, e.end_date,
           COALESCE(r.status, 'pending') AS review_status
    FROM events e
    LEFT JOIN review_decisions r ON r.event_uid = e.event_uid
    WHERE e.source = 'xiaohongshu'
      AND e.image != ''
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
  return db.prepare(sql).all(...params).filter(isXhsTextCoverEvent);
}

async function regenerateXhsTextCoverRecord(record, options = {}) {
  const rootDir = options.rootDir;
  const dryRun = options.dryRun === true;
  const title = String(record.title || "").trim();
  if (!title) {
    return { status: "skip_no_title", record };
  }

  const composedUrl = buildComposedImageUrl(record.event_uid);
  if (dryRun) {
    return { status: "dry_run", record, composedUrl };
  }

  const { buffer, backgroundPath } = await composeXhsTextCover(title, options.textCoverOptions);
  saveComposedImage(record.event_uid, buffer, rootDir);
  return {
    status: "ok",
    record,
    composedUrl,
    backgroundPath,
  };
}

async function batchRegenerateXhsTextCovers(db, options = {}) {
  const records = listXhsTextCoverEvents(db, options);
  const results = {
    total: records.length,
    ok: 0,
    dry_run: 0,
    skip_no_title: 0,
    fail: 0,
    items: [],
  };

  const updateImage = options.updateDb !== false && !options.dryRun
    ? db.prepare("UPDATE events SET image = ? WHERE event_uid = ?")
    : null;

  for (const record of records) {
    try {
      const result = await regenerateXhsTextCoverRecord(record, options);
      results.items.push(result);
      if (result.status === "ok") {
        results.ok += 1;
        if (updateImage && record.image !== result.composedUrl) {
          updateImage.run(result.composedUrl, record.event_uid);
        }
      } else if (result.status === "dry_run") {
        results.dry_run += 1;
      } else {
        results.skip_no_title += 1;
      }
    } catch (error) {
      results.fail += 1;
      results.items.push({
        status: "fail",
        record,
        error: error.message || String(error),
      });
    }
  }

  return results;
}

module.exports = {
  isXhsTextCoverEvent,
  listXhsTextCoverEvents,
  regenerateXhsTextCoverRecord,
  batchRegenerateXhsTextCovers,
};

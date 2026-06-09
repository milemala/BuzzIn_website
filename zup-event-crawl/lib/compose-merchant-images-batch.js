"use strict";

const path = require("path");
const {
  buildComposedImageUrl,
  isComposedImageUrl,
  saveComposedImage,
} = require("./composed-image");
const { composeMerchantCoverFromUrl } = require("./merchant-image-compose");
const { normalizeMerchantImageUrl } = require("./merchant-image-url");
const { ensureMerchantSchema } = require("./merchant-db");

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

function listMerchantsForImageCompose(db, options = {}) {
  ensureMerchantSchema(db);
  const status = String(options.status || "approved").trim();
  const params = [];
  let sql = `
    SELECT m.merchant_uid, m.name, m.city, m.image, m.image_original
    FROM merchants m
    LEFT JOIN merchant_review_decisions d ON d.merchant_uid = m.merchant_uid
    WHERE m.image != ''
  `;

  if (Array.isArray(options.merchant_uids) && options.merchant_uids.length) {
    const placeholders = options.merchant_uids.map(() => "?").join(", ");
    sql += ` AND m.merchant_uid IN (${placeholders})`;
    params.push(...options.merchant_uids);
  } else if (status === "pending") {
    sql += " AND COALESCE(d.status, 'pending') = 'pending'";
  } else if (status === "approved") {
    sql += " AND d.status = 'approved'";
  } else if (status === "rejected") {
    sql += " AND d.status = 'rejected'";
  }

  sql += " ORDER BY m.city, m.name";
  return db.prepare(sql).all(...params);
}

async function composeMerchantImageRow(db, row, options = {}) {
  const root = options.rootDir || path.join(__dirname, "..");
  const cacheDir = options.cacheDir || path.join(root, "data", "image-cache");
  const force = options.force === true;
  const dryRun = options.dryRun === true;

  const sourceUrl = resolveSourceUrl(row);
  if (!sourceUrl) {
    return { status: "skip_no_source", row };
  }

  const currentImage = String(row.image || "").trim();
  if (!force && isComposedImageUrl(currentImage)) {
    return { status: "skip_done", row };
  }

  if (dryRun) {
    return {
      status: "dry_run",
      row,
      sourceUrl,
      composedUrl: buildComposedImageUrl(row.merchant_uid),
    };
  }

  const buffer = await composeMerchantCoverFromUrl(sourceUrl, { cacheDir });
  const composedUrl = buildComposedImageUrl(row.merchant_uid);
  saveComposedImage(row.merchant_uid, buffer, root);

  const now = options.now || new Date().toISOString();
  const stmt = options.stmt || db.prepare(`
    UPDATE merchants
    SET image_original = @image_original,
        image = @image,
        updated_at = @updated_at
    WHERE merchant_uid = @merchant_uid
  `);
  stmt.run({
    merchant_uid: row.merchant_uid,
    image_original: sourceUrl,
    image: composedUrl,
    updated_at: now,
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

  const workers = Math.max(1, Math.min(limit || 5, rows.length || 1));
  await Promise.all(Array.from({ length: workers }, () => workerLoop()));
  return results;
}

async function batchComposeMerchantImages(db, options = {}) {
  ensureMerchantSchema(db);
  const rows = listMerchantsForImageCompose(db, options);
  const root = options.rootDir || path.join(__dirname, "..");
  const cacheDir = options.cacheDir || path.join(root, "data", "image-cache");
  const concurrency = Math.max(1, Number(options.concurrency) || 5);
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE merchants
    SET image_original = @image_original,
        image = @image,
        updated_at = @updated_at
    WHERE merchant_uid = @merchant_uid
  `);

  const counters = { ok: 0, dry_run: 0, skip_done: 0, skip_no_source: 0, fail: 0 };
  const log = options.log !== false;

  await runPool(rows, async (row) => {
    try {
      const result = await composeMerchantImageRow(db, row, {
        rootDir: root,
        cacheDir,
        force: options.force,
        dryRun: options.dryRun,
        now,
        stmt,
      });
      counters[result.status] = (counters[result.status] || 0) + 1;
      if (log && result.status === "ok") {
        console.log(`  16:9 OK ${row.name}（${row.city}）`);
      }
      return result;
    } catch (error) {
      counters.fail += 1;
      if (log) {
        console.error(`  16:9 FAIL ${row.name}（${row.city}）: ${error.message}`);
      }
      return { status: "fail", row, error };
    }
  }, concurrency);

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
  batchComposeMerchantImages,
  composeMerchantImageRow,
  listMerchantsForImageCompose,
  resolveSourceUrl,
};

#!/usr/bin/env node
"use strict";

const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { ensureMerchantSchema } = require("../lib/merchant-db");
const {
  isMeituanThumbnailUrl,
  normalizeMerchantImageUrl,
} = require("../lib/merchant-image-url");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

function main() {
  const db = openDatabase(dbPath);
  ensureMerchantSchema(db);

  const rows = db.prepare(`
    SELECT merchant_uid, name, city, image
    FROM merchants
    WHERE image != ''
      AND image LIKE '%@%w_%h%'
  `).all();

  const update = db.prepare(`
    UPDATE merchants
    SET image = @image, updated_at = @updated_at
    WHERE merchant_uid = @merchant_uid
  `);

  const now = new Date().toISOString();
  let candidates = 0;
  let updated = 0;

  for (const row of rows) {
    if (!isMeituanThumbnailUrl(row.image)) continue;
    candidates += 1;
    const nextImage = normalizeMerchantImageUrl(row.image);
    if (!nextImage || nextImage === row.image) continue;

    if (!dryRun) {
      update.run({
        merchant_uid: row.merchant_uid,
        image: nextImage,
        updated_at: now,
      });
    }
    updated += 1;
    console.log(`${dryRun ? "[dry-run] " : ""}${row.city || ""} ${row.name}`);
    console.log(`  ${row.image}`);
    console.log(`  -> ${nextImage}`);
  }

  console.log(`\n${dryRun ? "将升级" : "已升级"} ${updated} / ${candidates} 条美团缩略图（共 ${rows.length} 家有图商户）`);
  db.close();
}

main();

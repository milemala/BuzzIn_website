#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { composeMerchantCoverFromUrl } = require("../lib/merchant-image-compose");
const { normalizeMerchantImageUrl } = require("../lib/merchant-image-url");
const { openDatabase } = require("../lib/review-db");
const { ensureMerchantSchema } = require("../lib/merchant-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

const name = readArg("name") || "GoodFriend好朋友精酿";
const city = readArg("city") || "";
const outputDir = readArg("out") || path.join(root, "data", "image-composed-preview");
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

async function main() {
  const db = openDatabase(dbPath);
  ensureMerchantSchema(db);
  const row = city
    ? db.prepare("SELECT merchant_uid, name, city, image FROM merchants WHERE name = ? AND city = ?").get(name, city)
    : db.prepare("SELECT merchant_uid, name, city, image FROM merchants WHERE name LIKE ?").get(`%${name}%`);
  db.close();

  if (!row?.image) {
    throw new Error(`未找到商户或缺少封面图: ${name}${city ? ` / ${city}` : ""}`);
  }

  const sourceUrl = normalizeMerchantImageUrl(row.image);
  fs.mkdirSync(outputDir, { recursive: true });
  const safeName = `${row.name}-${row.city || "preview"}-16x9.jpg`.replace(/[\\/:*?"<>|]/g, "_");
  const outputPath = path.join(outputDir, safeName);

  const buffer = await composeMerchantCoverFromUrl(sourceUrl);
  fs.writeFileSync(outputPath, buffer);

  const meta = await require("sharp")(buffer).metadata();
  console.log(`商户: ${row.name}（${row.city}）`);
  console.log(`原图: ${row.image}`);
  console.log(`合成源: ${sourceUrl}`);
  console.log(`预览: ${outputPath}`);
  console.log(`尺寸: ${meta.width}x${meta.height}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

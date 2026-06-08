#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { composeEventPosterFromUrl } = require("../lib/event-image-compose");
const { isComposedImageUrl } = require("../lib/composed-image");
const { openDatabase } = require("../lib/review-db");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

const title = readArg("title") || "主动社交的力量";
const city = readArg("city") || "成都";
const outputDir = readArg("out") || path.join(root, "data", "image-composed-preview");
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

async function main() {
  const db = openDatabase(dbPath);
  const row = city
    ? db.prepare("SELECT title, city, image, image_original FROM events WHERE title = ? AND city = ?").get(title, city)
    : db.prepare("SELECT title, city, image, image_original FROM events WHERE title LIKE ?").get(`%${title}%`);
  db.close();

  if (!row?.image) {
    throw new Error(`未找到活动或缺少封面图: ${title}${city ? ` / ${city}` : ""}`);
  }

  const sourceUrl = row.image_original
    || (isComposedImageUrl(row.image) ? "" : row.image);
  if (!sourceUrl) {
    throw new Error(`未找到豆瓣原图，请确认 image_original 字段: ${title}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const safeName = `${row.title}-${row.city || "preview"}-4x3.jpg`.replace(/[\\/:*?"<>|]/g, "_");
  const outputPath = path.join(outputDir, safeName);

  const buffer = await composeEventPosterFromUrl(sourceUrl);
  fs.writeFileSync(outputPath, buffer);

  console.log(`活动: ${row.title}（${row.city}）`);
  console.log(`原图: ${sourceUrl}`);
  console.log(`预览: ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

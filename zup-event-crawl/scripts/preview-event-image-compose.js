#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { composeEventPosterFromUrl, composeEventPosterImage } = require("../lib/event-image-compose");
const { isComposedImageUrl } = require("../lib/composed-image");
const { openDatabase } = require("../lib/review-db");
const { readImageFile } = require("../lib/image-fetch");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

const posterPath = readArg("poster");
const titleArg = readArg("title");
const city = readArg("city") || "成都";
const outputDir = readArg("out") || path.join(root, "data", "image-composed-preview");
const dbPath = argv.find((arg) => !arg.startsWith("--")) || path.join(root, "data", "review.db");

async function composeFromPosterFile(posterAbs, title, outputPath) {
  const { buffer: sourceBuffer } = readImageFile(posterAbs);
  const buffer = await composeEventPosterImage(sourceBuffer, { title });
  fs.writeFileSync(outputPath, buffer);
  console.log(`海报: ${posterAbs}`);
  console.log(`标题: ${title}`);
  console.log(`预览: ${outputPath}`);
}

async function composeFromReviewDb(title, cityName) {
  const db = openDatabase(dbPath);
  const row = cityName
    ? db.prepare("SELECT title, city, image, image_original FROM events WHERE title = ? AND city = ?").get(title, cityName)
    : db.prepare("SELECT title, city, image, image_original FROM events WHERE title LIKE ?").get(`%${title}%`);
  db.close();

  if (!row?.image) {
    throw new Error(`未找到活动或缺少封面图: ${title}${cityName ? ` / ${cityName}` : ""}`);
  }

  const sourceUrl = row.image_original
    || (isComposedImageUrl(row.image) ? "" : row.image);
  if (!sourceUrl) {
    throw new Error(`未找到原图，请确认 image_original 字段: ${title}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const safeName = `${row.title}-${row.city || "preview"}-4x3.jpg`.replace(/[\\/:*?"<>|]/g, "_");
  const outputPath = path.join(outputDir, safeName);

  const buffer = await composeEventPosterFromUrl(sourceUrl, { title: row.title });
  fs.writeFileSync(outputPath, buffer);

  console.log(`活动: ${row.title}（${row.city}）`);
  console.log(`原图: ${sourceUrl}`);
  console.log(`预览: ${outputPath}`);
}

async function main() {
  if (posterPath) {
    const posterAbs = path.isAbsolute(posterPath) ? posterPath : path.join(root, posterPath);
    if (!fs.existsSync(posterAbs)) {
      throw new Error(`海报文件不存在: ${posterAbs}`);
    }
    const title = titleArg || "周末市集·手作体验";
    fs.mkdirSync(outputDir, { recursive: true });
    const safeName = `${title}-poster-side-preview.jpg`.replace(/[\\/:*?"<>|]/g, "_");
    const outputPath = path.join(outputDir, safeName);
    await composeFromPosterFile(posterAbs, title, outputPath);
    return;
  }

  const title = titleArg || "主动社交的力量";
  await composeFromReviewDb(title, city);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

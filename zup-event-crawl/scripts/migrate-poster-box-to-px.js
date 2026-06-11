#!/usr/bin/env node
"use strict";

/**
 * 将 vision-slots.json 里仍为 0–1 比例的 posterBox 换算为像素。
 *
 * 用法:
 *   node scripts/migrate-poster-box-to-px.js <笔记目录>
 *   node scripts/migrate-poster-box-to-px.js data/scrape-cache/xhs --all
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

function isRatioBox(box) {
  const x = Number(box.x ?? box.left);
  const y = Number(box.y ?? box.top);
  const w = Number(box.w ?? box.width);
  const h = Number(box.h ?? box.height);
  return x > 0 && y > 0 && w > 0 && h > 0 && x <= 1 && y <= 1 && w <= 1 && h <= 1;
}

function toPxBox(box, width, height) {
  return {
    slide: box.slide,
    x: Math.round(Number(box.x ?? box.left) * width),
    y: Math.round(Number(box.y ?? box.top) * height),
    w: Math.round(Number(box.w ?? box.width) * width),
    h: Math.round(Number(box.h ?? box.height) * height),
  };
}

async function migrateNoteDir(noteDir) {
  const visionFile = path.join(noteDir, "vision-slots.json");
  if (!fs.existsSync(visionFile)) return { noteDir, skipped: "no vision-slots" };

  const vision = JSON.parse(fs.readFileSync(visionFile, "utf8"));
  const imagesDir = path.join(noteDir, "images");
  const sizeCache = new Map();
  let converted = 0;
  let alreadyPx = 0;

  for (const entry of Object.values(vision)) {
    const box = entry?.posterBox;
    if (!box) continue;
    if (!isRatioBox(box)) {
      alreadyPx += 1;
      continue;
    }
    const slide = box.slide || entry.slide;
    if (!slide) continue;
    const imagePath = path.join(imagesDir, slide);
    if (!fs.existsSync(imagePath)) {
      console.warn(`  跳过 ${slide}：找不到 ${imagePath}`);
      continue;
    }
    if (!sizeCache.has(slide)) {
      const meta = await sharp(imagePath).metadata();
      sizeCache.set(slide, { width: meta.width, height: meta.height });
    }
    const { width, height } = sizeCache.get(slide);
    entry.posterBox = toPxBox(box, width, height);
    converted += 1;
  }

  if (converted > 0) {
    fs.writeFileSync(visionFile, `${JSON.stringify(vision, null, 2)}\n`);
  }
  return { noteDir, converted, alreadyPx };
}

function findNoteDirs(root) {
  const dirs = [];
  if (fs.existsSync(path.join(root, "vision-slots.json"))) return [root];

  for (const cityEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!cityEntry.isDirectory()) continue;
    const cityPath = path.join(root, cityEntry.name);
    for (const noteEntry of fs.readdirSync(cityPath, { withFileTypes: true })) {
      if (!noteEntry.isDirectory()) continue;
      const notePath = path.join(cityPath, noteEntry.name);
      if (fs.existsSync(path.join(notePath, "vision-slots.json"))) dirs.push(notePath);
    }
  }
  return dirs;
}

async function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const target = path.resolve(args.find((a) => !a.startsWith("-")) || "");
  if (!target || !fs.existsSync(target)) {
    console.error("用法: node scripts/migrate-poster-box-to-px.js <笔记目录>");
    console.error("      node scripts/migrate-poster-box-to-px.js data/scrape-cache/xhs --all");
    process.exit(1);
  }

  const noteDirs = all ? findNoteDirs(target) : [target];
  let total = 0;
  for (const noteDir of noteDirs) {
    const r = await migrateNoteDir(noteDir);
    if (r.converted) {
      console.log(`${path.relative(process.cwd(), noteDir)}：换算 ${r.converted} 条 posterBox → px`);
      total += r.converted;
    }
  }
  console.log(total ? `完成，共换算 ${total} 条` : "无需换算（已是像素或无可换算项）");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

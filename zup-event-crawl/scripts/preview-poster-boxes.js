#!/usr/bin/env node
"use strict";

/**
 * 【已退出标准流程，勿在 Agent 标框时运行】
 * 在 slide 原图上叠加 posterBox 红框。默认禁用。
 *
 * 用法（仅人工调试）:
 *   node scripts/preview-poster-boxes.js data/scrape-cache/xhs/<城市>/<笔记ID>
 *
 * 输出: <笔记目录>/poster-box-preview/<slotKey>.png
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const STROKE = 4;

function buildOverlaySvg(width, height, stroke) {
  const s = stroke;
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${width}" height="${s}" fill="#FF3030"/>
  <rect x="0" y="${height - s}" width="${width}" height="${s}" fill="#FF3030"/>
  <rect x="0" y="0" width="${s}" height="${height}" fill="#FF3030"/>
  <rect x="${width - s}" y="0" width="${s}" height="${height}" fill="#FF3030"/>
</svg>`);
}

async function drawBox(imagePath, box, outPath) {
  const meta = await sharp(imagePath).metadata();
  const imgW = meta.width || 1;
  const imgH = meta.height || 1;
  const left = Math.max(0, Math.round(box.x));
  const top = Math.max(0, Math.round(box.y));
  const width = Math.min(Math.round(box.w), imgW - left);
  const height = Math.min(Math.round(box.h), imgH - top);
  if (width <= 0 || height <= 0) {
    throw new Error(`无效 box: ${JSON.stringify(box)}`);
  }

  const stroke = Math.min(STROKE, Math.max(2, Math.floor(Math.min(width, height) / 40)));
  const overlay = buildOverlaySvg(width, height, stroke);

  await sharp(imagePath)
    .composite([{ input: overlay, left, top }])
    .png()
    .toFile(outPath);
}

async function main() {
  const noteDir = path.resolve(process.argv[2] || "");
  const visionFile = path.join(noteDir, "vision-slots.json");
  if (!fs.existsSync(visionFile)) {
    console.error("用法: node scripts/preview-poster-boxes.js <笔记目录>");
    process.exit(1);
  }

  const vision = JSON.parse(fs.readFileSync(visionFile, "utf8"));
  const outDir = path.join(noteDir, "poster-box-preview");
  fs.mkdirSync(outDir, { recursive: true });

  let count = 0;
  for (const [slotKey, entry] of Object.entries(vision)) {
    const box = entry?.posterBox;
    if (!box) continue;
    const slide = box.slide || entry.slide;
    const imagePath = path.join(noteDir, "images", slide);
    if (!fs.existsSync(imagePath)) {
      console.warn(`跳过 ${slotKey}：找不到 ${slide}`);
      continue;
    }
    const outPath = path.join(outDir, `${slotKey}.png`);
    await drawBox(imagePath, box, outPath);
    const aspect = (box.w / box.h).toFixed(3);
    console.log(`${slotKey}  ${box.w}×${box.h} (${aspect})  →  ${outPath}`);
    count += 1;
  }

  if (!count) {
    console.log("vision-slots.json 中没有 posterBox");
    return;
  }
  console.log(`\n共 ${count} 个框，请对照原图检查四边是否贴海报外缘、比例是否正确。`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

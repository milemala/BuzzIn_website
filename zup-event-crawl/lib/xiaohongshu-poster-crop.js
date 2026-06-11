"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** 将 vision-slots 里的 posterBox 转为像素矩形（支持 0–1 比例或绝对像素） */
function resolvePosterBoxPixels(box, imageWidth, imageHeight) {
  if (!box || !imageWidth || !imageHeight) return null;
  const isRatio = (n) => typeof n === "number" && n > 0 && n <= 1;
  const toPx = (v, max) => (isRatio(v) ? Math.round(v * max) : Math.round(Number(v) || 0));

  let left = toPx(box.left ?? box.x, imageWidth);
  let top = toPx(box.top ?? box.y, imageHeight);
  let width = toPx(box.width ?? box.w, imageWidth);
  let height = toPx(box.height ?? box.h, imageHeight);

  if (width <= 0 || height <= 0) return null;
  left = clamp(left, 0, imageWidth - 1);
  top = clamp(top, 0, imageHeight - 1);
  width = clamp(width, 1, imageWidth - left);
  height = clamp(height, 1, imageHeight - top);
  return { left, top, width, height };
}

async function cropPosterFromBox(imagePath, box, outPath) {
  const meta = await sharp(imagePath).metadata();
  const pixels = resolvePosterBoxPixels(box, meta.width, meta.height);
  if (!pixels) throw new Error(`无效 posterBox: ${imagePath}`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await sharp(imagePath).extract(pixels).jpeg({ quality: 92 }).toFile(outPath);
  return { ...pixels, sourceImage: imagePath, posterFile: outPath };
}

/**
 * 仅当 vision-slots 条目含 posterBox 时才切图；无 box 的不猜、不裁。
 * @returns {Map<string, { posterFile: string, box: object }>}
 */
async function cropPostersFromVisionSlots(imagesDir, postersDir, visionMap) {
  fs.mkdirSync(postersDir, { recursive: true });
  const cropped = new Map();

  for (const [slotKey, entry] of Object.entries(visionMap || {})) {
    const box = entry?.posterBox;
    if (!box) continue;

    const slideName = box.slide || `${String(slotKey.split("_")[0]).padStart(2, "0")}.webp`;
    const imagePath = path.join(imagesDir, slideName);
    if (!fs.existsSync(imagePath)) {
      console.warn(`  跳过 ${slotKey}：找不到 slide ${slideName}`);
      continue;
    }

    const posterName = `${String(slotKey.split("_")[0]).padStart(2, "0")}_slot${slotKey.split("_")[1] || 0}.jpg`;
    const posterFile = path.join(postersDir, posterName);
    const result = await cropPosterFromBox(imagePath, box, posterFile);
    cropped.set(slotKey, { posterFile, box: result, slide: slideName });
  }
  return cropped;
}

module.exports = {
  cropPosterFromBox,
  cropPostersFromVisionSlots,
  resolvePosterBoxPixels,
};

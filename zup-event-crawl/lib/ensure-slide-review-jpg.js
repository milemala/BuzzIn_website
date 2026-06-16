"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

/** Agent 读图用 JPEG 质量（与 webp 同尺寸；裁切仍用 webp） */
const DEFAULT_JPEG_QUALITY = 60;

function imagesJpgDir(noteDir) {
  return path.join(noteDir, "images-jpg");
}

function slideWebpPath(noteDir, slide) {
  return path.join(noteDir, "images", slide);
}

function slideJpgPath(noteDir, slide) {
  const base = path.basename(slide, path.extname(slide));
  return path.join(imagesJpgDir(noteDir), `${base}.jpg`);
}

function needsRegenerate(webpPath, jpgPath) {
  if (!fs.existsSync(jpgPath)) return true;
  if (!fs.existsSync(webpPath)) return false;
  const webpMtime = fs.statSync(webpPath).mtimeMs;
  const jpgMtime = fs.statSync(jpgPath).mtimeMs;
  return webpMtime > jpgMtime;
}

/**
 * 将单张 slide webp 转为同尺寸 JPEG，供 Agent Read 工具读图。
 * posterBox 坐标仍以 images/*.webp 为准。
 */
async function webpToReviewJpg(webpPath, jpgPath, quality = DEFAULT_JPEG_QUALITY) {
  fs.mkdirSync(path.dirname(jpgPath), { recursive: true });
  await sharp(webpPath)
    .jpeg({ quality, mozjpeg: true })
    .toFile(jpgPath);
  const meta = await sharp(webpPath).metadata();
  return { webpPath, jpgPath, width: meta.width, height: meta.height, quality };
}

async function ensureSlideReviewJpg(noteDir, slide, options = {}) {
  const quality = options.quality ?? DEFAULT_JPEG_QUALITY;
  const webpPath = slideWebpPath(noteDir, slide);
  if (!fs.existsSync(webpPath)) {
    throw new Error(`找不到 slide 原图: ${webpPath}`);
  }
  const jpgPath = slideJpgPath(noteDir, slide);
  if (!needsRegenerate(webpPath, jpgPath)) {
    const meta = await sharp(webpPath).metadata();
    return { slide, jpgPath, skipped: true, width: meta.width, height: meta.height, quality };
  }
  const result = await webpToReviewJpg(webpPath, jpgPath, quality);
  return { slide, jpgPath, skipped: false, ...result };
}

async function ensureAllSlideReviewJpgs(noteDir, options = {}) {
  const imagesDir = path.join(noteDir, "images");
  if (!fs.existsSync(imagesDir)) return [];
  const slides = fs
    .readdirSync(imagesDir)
    .filter((f) => f.endsWith(".webp"))
    .sort();
  const results = [];
  for (const slide of slides) {
    results.push(await ensureSlideReviewJpg(noteDir, slide, options));
  }
  return results;
}

module.exports = {
  DEFAULT_JPEG_QUALITY,
  ensureAllSlideReviewJpgs,
  ensureSlideReviewJpg,
  imagesJpgDir,
  needsRegenerate,
  slideJpgPath,
  slideWebpPath,
  webpToReviewJpg,
};

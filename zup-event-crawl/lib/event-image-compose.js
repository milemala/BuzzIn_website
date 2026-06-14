"use strict";

const path = require("path");
const sharp = require("sharp");
const { ensureImageCached, readImageFile } = require("./image-fetch");
const {
  DEFAULT_CTA_LINES,
  DEFAULT_FONT_PRESET,
  buildPosterSideTextLayerSvg,
  rasterizeTextSvg,
  resolveCtaLines,
  resolveFontPreset,
} = require("./xhs-text-cover-compose");

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 900;
const DEFAULT_TEXT_LINES = DEFAULT_CTA_LINES;
const DEFAULT_BLUR_SIGMA = 32;
/** 宽于 4:5（如 1:1）的海报居中叠底图，右侧不留文案区 */
const PORTRAIT_TEXT_MAX_RATIO = 4 / 5;

function buildRightOverlaySvg(width, height) {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="shade" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="rgba(0,0,0,0.18)"/>
      <stop offset="100%" stop-color="rgba(0,0,0,0.42)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#shade)"/>
</svg>`);
}

async function buildPosterRightTextLayer(rightWidth, height, options = {}) {
  const title = String(options.title || "").trim();
  if (!title) return null;

  const ctaLines = resolveCtaLines(options.ctaLines || options.text || options.textLines);
  const fontPreset = resolveFontPreset(options.font || options.fontPreset || DEFAULT_FONT_PRESET);
  const { svg } = buildPosterSideTextLayerSvg(
    rightWidth,
    height,
    title,
    ctaLines,
    fontPreset,
    options.textLayerStyle || {},
  );
  return rasterizeTextSvg(Buffer.from(svg), rightWidth, height, fontPreset);
}

async function composeEventPosterImage(sourceBuffer, options = {}) {
  const width = options.width || DEFAULT_WIDTH;
  const height = options.height || DEFAULT_HEIGHT;
  const blurSigma = options.blurSigma || DEFAULT_BLUR_SIGMA;

  const sourceMeta = await sharp(sourceBuffer).metadata();
  const sourceWidth = sourceMeta.width || 1;
  const sourceHeight = sourceMeta.height || 1;
  const useCenterOnly = sourceWidth / sourceHeight > PORTRAIT_TEXT_MAX_RATIO;

  const background = await sharp(sourceBuffer)
    .resize(width, height, { fit: "cover", position: "centre" })
    .blur(blurSigma)
    .toBuffer();

  if (useCenterOnly) {
    const poster = await sharp(sourceBuffer)
      .resize(width, height, { fit: "inside" })
      .toBuffer();
    const posterMeta = await sharp(poster).metadata();
    const posterW = posterMeta.width || width;
    const posterH = posterMeta.height || height;
    return sharp(background)
      .composite([{
        input: poster,
        left: Math.round((width - posterW) / 2),
        top: Math.round((height - posterH) / 2),
      }])
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
  }

  const poster = await sharp(sourceBuffer)
    .resize({ height, fit: "inside" })
    .toBuffer();
  const posterMeta = await sharp(poster).metadata();
  const posterWidth = posterMeta.width || Math.round(height * 2 / 3);
  const rightWidth = Math.max(width - posterWidth, 0);

  const composites = [{ input: poster, left: 0, top: 0 }];
  if (rightWidth > 0) {
    composites.push({ input: buildRightOverlaySvg(rightWidth, height), left: posterWidth, top: 0 });
    const textLayer = await buildPosterRightTextLayer(rightWidth, height, options);
    if (textLayer) {
      composites.push({ input: textLayer, left: posterWidth, top: 0 });
    }
  }

  return sharp(background)
    .composite(composites)
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

async function loadSourceBuffer(imageUrl, cacheDir) {
  const cachedPath = await ensureImageCached(imageUrl, cacheDir);
  return readImageFile(cachedPath).buffer;
}

async function composeEventPosterFromUrl(imageUrl, options = {}) {
  const cacheDir = options.cacheDir || path.join(__dirname, "..", "data", "image-cache");
  const sourceBuffer = options.sourceBuffer || await loadSourceBuffer(imageUrl, cacheDir);
  return composeEventPosterImage(sourceBuffer, options);
}

function isPortraitPosterLayout(sourceWidth, sourceHeight) {
  const width = sourceWidth || 1;
  const height = sourceHeight || 1;
  return width / height <= PORTRAIT_TEXT_MAX_RATIO;
}

module.exports = {
  DEFAULT_BLUR_SIGMA,
  DEFAULT_HEIGHT,
  DEFAULT_TEXT_LINES,
  DEFAULT_WIDTH,
  PORTRAIT_TEXT_MAX_RATIO,
  composeEventPosterFromUrl,
  composeEventPosterImage,
  isPortraitPosterLayout,
};

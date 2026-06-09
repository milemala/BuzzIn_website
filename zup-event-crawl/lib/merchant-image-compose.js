"use strict";

const path = require("path");
const sharp = require("sharp");
const { ensureImageCached, readImageFile } = require("./image-fetch");
const { normalizeMerchantImageUrl } = require("./merchant-image-url");

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_BLUR_SIGMA = 28;

async function composeMerchantCoverImage(sourceBuffer, options = {}) {
  const width = options.width || DEFAULT_WIDTH;
  const height = options.height || DEFAULT_HEIGHT;
  const blurSigma = options.blurSigma || DEFAULT_BLUR_SIGMA;

  const sourceMeta = await sharp(sourceBuffer).metadata();
  const sourceWidth = sourceMeta.width || width;
  const sourceHeight = sourceMeta.height || height;

  const background = await sharp(sourceBuffer)
    .resize(width, height, { fit: "cover", position: "centre" })
    .blur(blurSigma)
    .toBuffer();

  const left = Math.round((width - sourceWidth) / 2);
  const top = Math.round((height - sourceHeight) / 2);

  let foreground = sourceBuffer;
  let compositeLeft = left;
  let compositeTop = top;

  // 原图大于画布时：不缩放，只取与画布相交的 1:1 中心区域
  if (sourceWidth > width || sourceHeight > height) {
    const extractLeft = Math.max(0, -left);
    const extractTop = Math.max(0, -top);
    const extractWidth = Math.min(sourceWidth - extractLeft, width - Math.max(0, left));
    const extractHeight = Math.min(sourceHeight - extractTop, height - Math.max(0, top));
    foreground = await sharp(sourceBuffer)
      .extract({
        left: extractLeft,
        top: extractTop,
        width: extractWidth,
        height: extractHeight,
      })
      .toBuffer();
    compositeLeft = Math.max(0, left);
    compositeTop = Math.max(0, top);
  }

  return sharp(background)
    .composite([{ input: foreground, left: compositeLeft, top: compositeTop }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

async function loadSourceBuffer(imageUrl, cacheDir) {
  const cachedPath = await ensureImageCached(imageUrl, cacheDir);
  return readImageFile(cachedPath).buffer;
}

async function composeMerchantCoverFromUrl(imageUrl, options = {}) {
  const cacheDir = options.cacheDir || path.join(__dirname, "..", "data", "image-cache");
  const normalizedUrl = normalizeMerchantImageUrl(imageUrl);
  const sourceBuffer = options.sourceBuffer || await loadSourceBuffer(normalizedUrl, cacheDir);
  return composeMerchantCoverImage(sourceBuffer, options);
}

module.exports = {
  DEFAULT_BLUR_SIGMA,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  composeMerchantCoverFromUrl,
  composeMerchantCoverImage,
};

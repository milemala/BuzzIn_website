"use strict";

const path = require("path");
const sharp = require("sharp");
const { ensureImageCached, readImageFile } = require("./image-fetch");
const { getComposedImagePath, isComposedImageUrl, parseComposedEventUid } = require("./composed-image");
const { normalizeMerchantImageUrl } = require("./merchant-image-url");

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const DEFAULT_BLUR_SIGMA = 32;

/**
 * 16:9 商户封面：原图铺满后高斯模糊作底，清晰原图完整居中。
 * 原图大于画布时仅缩小到能完整放入（不裁切）；小于画布时不放大。
 */
async function composeMerchantCoverImage(sourceBuffer, options = {}) {
  const width = options.width || DEFAULT_WIDTH;
  const height = options.height || DEFAULT_HEIGHT;
  const blurSigma = options.blurSigma || DEFAULT_BLUR_SIGMA;

  const background = await sharp(sourceBuffer)
    .resize(width, height, { fit: "cover", position: "centre" })
    .blur(blurSigma)
    .toBuffer();

  const foreground = await sharp(sourceBuffer)
    .resize(width, height, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .toBuffer();

  const fgMeta = await sharp(foreground).metadata();
  const fgWidth = fgMeta.width || width;
  const fgHeight = fgMeta.height || height;
  const left = Math.round((width - fgWidth) / 2);
  const top = Math.round((height - fgHeight) / 2);

  return sharp(background)
    .composite([{ input: foreground, left, top }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

async function loadSourceBuffer(imageUrl, cacheDir) {
  const url = String(imageUrl || "").trim();
  if (isComposedImageUrl(url)) {
    const uid = parseComposedEventUid(url);
    const rootDir = path.join(cacheDir, "..");
    return readImageFile(getComposedImagePath(uid, rootDir)).buffer;
  }
  const cachedPath = await ensureImageCached(normalizeMerchantImageUrl(url), cacheDir);
  return readImageFile(cachedPath).buffer;
}

async function composeMerchantCoverFromUrl(imageUrl, options = {}) {
  const cacheDir = options.cacheDir || path.join(__dirname, "..", "data", "image-cache");
  const url = String(imageUrl || "").trim();
  const sourceUrl = isComposedImageUrl(url) ? url : normalizeMerchantImageUrl(url);
  const sourceBuffer = options.sourceBuffer || await loadSourceBuffer(sourceUrl, cacheDir);
  return composeMerchantCoverImage(sourceBuffer, options);
}

module.exports = {
  DEFAULT_BLUR_SIGMA,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  composeMerchantCoverFromUrl,
  composeMerchantCoverImage,
};

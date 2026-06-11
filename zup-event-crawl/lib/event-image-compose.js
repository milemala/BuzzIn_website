"use strict";

const path = require("path");
const sharp = require("sharp");
const { ensureImageCached, readImageFile } = require("./image-fetch");

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 900;
const DEFAULT_TEXT_LINES = ["加入群聊", "一起组局"];
const DEFAULT_BLUR_SIGMA = 32;
/** 宽于 4:5（如 1:1）的海报居中叠底图，右侧不留文案区 */
const PORTRAIT_TEXT_MAX_RATIO = 4 / 5;

function resolveTextLines(text) {
  if (Array.isArray(text)) return text.map((line) => String(line).trim()).filter(Boolean);
  const raw = String(text || "").trim();
  if (!raw) return [...DEFAULT_TEXT_LINES];
  if (raw.includes("\n")) return raw.split("\n").map((line) => line.trim()).filter(Boolean);
  return [raw.replace(/[，,]/g, "")];
}

function buildTextSvg(width, height, text, fontSize) {
  const lines = resolveTextLines(text);

  const lineHeight = fontSize * 1.35;
  const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;

  const tspans = lines
    .map((line, index) => `<tspan x="50%" dy="${index === 0 ? "0" : "1.35em"}">${escapeXml(line)}</tspan>`)
    .join("");

  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="6" flood-color="rgba(0,0,0,0.45)"/>
    </filter>
  </defs>
  <text x="50%" y="${startY}" text-anchor="middle" dominant-baseline="middle"
        font-family="PingFang SC, Hiragino Sans GB, STHeiti, Microsoft YaHei, sans-serif"
        font-size="${fontSize}" font-weight="600" fill="#FFFFFF" filter="url(#shadow)"
        letter-spacing="1">
    ${tspans}
  </text>
</svg>`);
}

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

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function composeEventPosterImage(sourceBuffer, options = {}) {
  const width = options.width || DEFAULT_WIDTH;
  const height = options.height || DEFAULT_HEIGHT;
  const text = options.text || options.textLines || DEFAULT_TEXT_LINES;
  const blurSigma = options.blurSigma || DEFAULT_BLUR_SIGMA;
  const fontSize = options.fontSize || Math.round(width * 0.078);

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
    composites.push({ input: buildTextSvg(rightWidth, height, text, fontSize), left: posterWidth, top: 0 });
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

module.exports = {
  DEFAULT_BLUR_SIGMA,
  DEFAULT_HEIGHT,
  DEFAULT_TEXT_LINES,
  DEFAULT_WIDTH,
  PORTRAIT_TEXT_MAX_RATIO,
  composeEventPosterFromUrl,
  composeEventPosterImage,
};

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COMPOSED_HOST = "zup-event-crawl.local";

function buildComposedImageUrl(eventUid) {
  return `https://${COMPOSED_HOST}/composed/${encodeURIComponent(eventUid)}.jpg`;
}

function parseComposedEventUid(src) {
  try {
    const url = new URL(String(src || ""));
    if (url.hostname !== COMPOSED_HOST) return "";
    const match = url.pathname.match(/^\/composed\/(.+)\.jpg$/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

function isComposedImageUrl(src) {
  return Boolean(parseComposedEventUid(src));
}

function getComposedImageDir(rootDir) {
  return path.join(rootDir || path.join(__dirname, ".."), "data", "image-composed");
}

function getComposedImagePath(eventUid, rootDir) {
  return path.join(getComposedImageDir(rootDir), `${eventUid}.jpg`);
}

function saveComposedImage(eventUid, buffer, rootDir) {
  const composedDir = getComposedImageDir(rootDir);
  fs.mkdirSync(composedDir, { recursive: true });
  const filePath = getComposedImagePath(eventUid, rootDir);
  fs.writeFileSync(filePath, buffer);

  const composedUrl = buildComposedImageUrl(eventUid);
  const cacheDir = path.join(rootDir || path.join(__dirname, ".."), "data", "image-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cachePath = path.join(cacheDir, `${crypto.createHash("sha1").update(composedUrl).digest("hex")}.jpg`);
  fs.writeFileSync(cachePath, buffer);

  return { composedUrl, filePath, cachePath };
}

module.exports = {
  COMPOSED_HOST,
  buildComposedImageUrl,
  getComposedImageDir,
  getComposedImagePath,
  isComposedImageUrl,
  parseComposedEventUid,
  saveComposedImage,
};

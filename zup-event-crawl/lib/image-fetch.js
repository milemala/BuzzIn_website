"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function defaultReferer(src) {
  if (/meituan\.net|dianping\.com/i.test(src)) return "https://www.dianping.com/";
  if (/douban/i.test(src)) return "https://www.douban.com/";
  return "";
}

function contentTypeFor(filename) {
  const ext = String(filename || "").toLowerCase().split(".").pop();
  switch (ext) {
    case "png": return "image/png";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    default: return "image/jpeg";
  }
}

function getCachedImagePath(cacheDir, src, contentType) {
  const extFromUrl = path.extname(new URL(src).pathname).split("?")[0];
  const extFromType = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  }[String(contentType || "").split(";")[0].toLowerCase()];
  const ext = extFromType || extFromUrl || ".img";
  const name = crypto.createHash("sha1").update(src).digest("hex");
  return path.join(cacheDir, `${name}${ext}`);
}

function findCachedImage(cacheDir, src) {
  if (!cacheDir || !fs.existsSync(cacheDir)) return null;
  const hashPrefix = crypto.createHash("sha1").update(src).digest("hex");
  const match = fs.readdirSync(cacheDir).find((name) => name.startsWith(hashPrefix));
  return match ? path.join(cacheDir, match) : null;
}

async function fetchRemoteImage(src, options = {}) {
  const referer = options.referer || defaultReferer(src) || undefined;
  const response = await fetch(src, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      ...(referer ? { Referer: referer } : {}),
    },
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`下载媒体失败 HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "application/octet-stream";
  const buffer = Buffer.from(await response.arrayBuffer());
  let filename = path.basename(new URL(src).pathname.split("?")[0] || "");
  if (!filename || filename === "." || filename === "/") filename = "image.jpg";
  if (!filename.includes(".")) filename = `${filename}.jpg`;
  return { buffer, filename, contentType };
}

async function readImageSource(src, options = {}) {
  const url = String(src || "").trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error(`不支持的媒体路径: ${url}`);
  }

  const cachedPath = findCachedImage(options.cacheDir, url);
  if (cachedPath) {
    return readImageFile(cachedPath);
  }

  if (options.localOnly) {
    throw new Error("本地无封面缓存。请先在审核页打开该活动，等封面加载出来后再入库。");
  }

  const result = await fetchRemoteImage(url, options);
  if (options.cacheDir) {
    fs.mkdirSync(options.cacheDir, { recursive: true });
    const savePath = getCachedImagePath(options.cacheDir, url, result.contentType);
    fs.writeFileSync(savePath, result.buffer);
    result.filename = path.basename(savePath);
  }
  return result;
}

function readImageFile(filePath) {
  const filename = path.basename(filePath);
  return {
    buffer: fs.readFileSync(filePath),
    filename,
    contentType: contentTypeFor(filename),
  };
}

/** 抓取/入库前：本地无缓存则从图床拉一次并写入 image-cache */
async function ensureImageCached(originalUrl, cacheDir, options = {}) {
  const url = String(originalUrl || "").trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error(`无效图片地址: ${url}`);
  }
  const existing = findCachedImage(cacheDir, url);
  if (existing) return existing;

  const result = await fetchRemoteImage(url, options);
  if (!cacheDir) return null;
  fs.mkdirSync(cacheDir, { recursive: true });
  const savePath = getCachedImagePath(cacheDir, url, result.contentType);
  fs.writeFileSync(savePath, result.buffer);
  return savePath;
}

/** 入库：优先读 image-cache；无缓存时自动补拉一次（不再依赖审核页先打开） */
async function readImageForImport(originalUrl, cacheDir, options = {}) {
  const url = String(originalUrl || "").trim();
  if (!url) throw new Error("媒体地址为空");
  const cachedPath = await ensureImageCached(url, cacheDir, options);
  if (!cachedPath) {
    throw new Error("封面缓存失败");
  }
  return readImageFile(cachedPath);
}

module.exports = {
  defaultReferer,
  ensureImageCached,
  fetchRemoteImage,
  findCachedImage,
  readImageFile,
  readImageForImport,
  readImageSource,
};

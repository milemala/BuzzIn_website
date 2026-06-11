"use strict";

const path = require("path");

const SCRAPE_LOCAL_HOST = "zup-event-crawl.local";

function normalizeRelativePath(relativePath) {
  return String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function buildScrapeLocalImageUrl(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) return "";
  const segments = normalized.split("/").map((part) => encodeURIComponent(part)).join("/");
  return `https://${SCRAPE_LOCAL_HOST}/scrape/${segments}`;
}

function parseScrapeLocalRelativePath(src) {
  try {
    const url = new URL(String(src || ""));
    if (url.hostname !== SCRAPE_LOCAL_HOST) return "";
    const match = url.pathname.match(/^\/scrape\/(.+)$/);
    if (!match) return "";
    return match[1]
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return "";
  }
}

function isScrapeLocalImageUrl(src) {
  return Boolean(parseScrapeLocalRelativePath(src));
}

function getScrapeLocalImagePath(src, rootDir) {
  const relative = parseScrapeLocalRelativePath(src);
  if (!relative) return "";
  const root = path.resolve(rootDir || path.join(__dirname, ".."));
  const abs = path.resolve(root, relative);
  if (!abs.startsWith(root + path.sep) && abs !== root) return "";
  return abs;
}

module.exports = {
  SCRAPE_LOCAL_HOST,
  buildScrapeLocalImageUrl,
  getScrapeLocalImagePath,
  isScrapeLocalImageUrl,
  normalizeRelativePath,
  parseScrapeLocalRelativePath,
};

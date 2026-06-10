"use strict";

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#47;/g, "/")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function normalizeSpace(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEdescHtml(html) {
  const source = String(html || "");
  const start = source.search(/<div id="edesc_s" class="wr">/);
  if (start < 0) return "";

  const contentStart = source.indexOf(">", start) + 1;
  const endMarkers = [
    source.indexOf('<div class="mod">', contentStart),
    source.indexOf('<div id="link-report"', contentStart),
    source.indexOf('<div class="event_ticket"', contentStart),
  ].filter((index) => index > contentStart);

  const end = endMarkers.length ? Math.min(...endMarkers) : -1;
  if (end < 0) return source.slice(contentStart);
  return source.slice(contentStart, end);
}

function htmlFragmentToLines(fragment) {
  const rawText = String(fragment || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  return decodeHtml(rawText)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function extractEventNoticeHtml(html) {
  const source = String(html || "");
  const match = source.match(/<h2>活动须知<\/h2>\s*<div class="wr">([\s\S]*?)<\/div>/);
  return match ? match[1] : "";
}

function extractEventNotices(html) {
  const fragment = extractEventNoticeHtml(html);
  if (!fragment) return [];

  return htmlFragmentToLines(fragment)
    .map((line) => line.replace(/^\d+[\.、]\s*/, "").trim())
    .filter(Boolean);
}

module.exports = {
  decodeHtml,
  extractEdescHtml,
  extractEventNoticeHtml,
  extractEventNotices,
  htmlFragmentToLines,
  normalizeSpace,
};

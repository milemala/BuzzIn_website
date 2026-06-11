"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { navigateChrome, readActiveTab, sleep } = require("./chrome-fetch");
const {
  buildNoteExploreUrl,
  parseNoteDetailFromHtml,
  parseProfileNotes,
} = require("./xiaohongshu-parse");

const DEFAULT_WAIT_MS = 12000;
const DEFAULT_POLL_MS = 1500;

async function waitForHtml(predicate, options = {}) {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + waitMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    last = readActiveTab();
    if (last?.html && predicate(last)) return last;
  }
  return last;
}

function profileReady(last) {
  return last.html.includes("__INITIAL_STATE__") && /noteCard|displayTitle/.test(last.html);
}

function noteDetailReady(html, noteId) {
  const detail = parseNoteDetailFromHtml(html, noteId);
  return Boolean(detail?.desc && detail.desc.length > 30);
}

async function fetchXhsProfileViaChrome(profileUrl, options = {}) {
  navigateChrome(profileUrl);
  const last = await waitForHtml(profileReady, options);
  if (!last?.html) throw new Error(`未能读取小红书个人页: ${profileUrl}`);
  return { url: last.url, html: last.html, notes: parseProfileNotes(last.html, options.limit ?? 10) };
}

async function fetchXhsNoteViaChrome(noteId, xsecToken, options = {}) {
  const url = buildNoteExploreUrl(noteId, xsecToken);
  navigateChrome(url);
  const last = await waitForHtml((tab) => noteDetailReady(tab.html, noteId), options);
  if (!last?.html || !noteDetailReady(last.html, noteId)) {
    throw new Error(`未能读取小红书笔记详情（需带 xsec_token）: ${noteId}`);
  }
  return {
    url: last.url,
    html: last.html,
    note: parseNoteDetailFromHtml(last.html, noteId),
  };
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib
      .get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchBuffer(res.headers.location).then(resolve, reject);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

async function downloadNoteImages(note, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const saved = [];
  const list = note?.imageList || [];
  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    const url = img.urlDefault || img.url || img.infoList?.find((x) => x.imageScene === "WB_DFT")?.url;
    if (!url) continue;
    const buf = await fetchBuffer(url);
    const file = path.join(outDir, `${String(i).padStart(2, "0")}.webp`);
    fs.writeFileSync(file, buf);
    saved.push({ index: i, file, url, bytes: buf.length });
  }
  return saved;
}

module.exports = {
  DEFAULT_POLL_MS,
  DEFAULT_WAIT_MS,
  downloadNoteImages,
  fetchXhsNoteViaChrome,
  fetchXhsProfileViaChrome,
};

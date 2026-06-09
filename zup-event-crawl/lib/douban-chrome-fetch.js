"use strict";

const { navigateChrome, readActiveTab, sleep } = require("./chrome-fetch");

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_LIST_GAP_MS = 1200;
const DEFAULT_DETAIL_GAP_MS = 1500;

function isDoubanListReady(html) {
  return html.length > 12000 && html.includes("list-entry");
}

function isDoubanDetailReady(html) {
  return html.length > 8000 && (html.includes("event-detail") || html.includes('itemprop="summary"'));
}

function isDoubanDetailUrl(url) {
  return /\/event\/\d+\//.test(url);
}

async function fetchDoubanViaChrome(url, options = {}) {
  const waitMs = Math.max(2000, Number(options.waitMs) || DEFAULT_WAIT_MS);
  navigateChrome(url);
  const deadline = Date.now() + waitMs;
  let last = null;
  while (Date.now() < deadline) {
    await sleep(800);
    last = readActiveTab();
    if (!last.url.includes("douban.com")) continue;
    const ready = isDoubanDetailUrl(url)
      ? isDoubanDetailReady(last.html)
      : isDoubanListReady(last.html);
    if (ready) {
      return {
        url: last.url,
        html: last.html,
      };
    }
  }
  if (!last || !last.html) {
    throw new Error(`Chrome 未能读取豆瓣页面: ${url}`);
  }
  return {
    url: last.url,
    html: last.html,
  };
}

module.exports = {
  DEFAULT_DETAIL_GAP_MS,
  DEFAULT_LIST_GAP_MS,
  DEFAULT_WAIT_MS,
  fetchDoubanViaChrome,
  isDoubanDetailReady,
  isDoubanDetailUrl,
  isDoubanListReady,
};

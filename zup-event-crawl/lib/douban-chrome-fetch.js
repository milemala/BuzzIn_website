"use strict";

const { navigateChrome, readActiveTab, sleep } = require("./chrome-fetch");
const {
  assertDoubanPageAccessible,
  detectDoubanBlock,
  DoubanBlockedError,
  isDoubanDetailReady,
  isDoubanDetailUrl,
  isDoubanListReady,
} = require("./douban-block");

const DEFAULT_WAIT_MS = 5000;
const DEFAULT_LIST_GAP_MS = 1200;
const DEFAULT_DETAIL_GAP_MS = 1500;

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
      assertDoubanPageAccessible(last.html, last.url, {
        expectList: !isDoubanDetailUrl(url),
        expectDetail: isDoubanDetailUrl(url),
      });
      return {
        url: last.url,
        html: last.html,
      };
    }
  }
  if (!last || !last.html) {
    throw new Error(`Chrome 未能读取豆瓣页面: ${url}`);
  }
  const blockReason = detectDoubanBlock(last.html, last.url);
  if (blockReason) {
    throw new DoubanBlockedError(`豆瓣风控：${blockReason}`, { url: last.url, reason: blockReason });
  }
  assertDoubanPageAccessible(last.html, last.url, {
    expectList: !isDoubanDetailUrl(url),
    expectDetail: isDoubanDetailUrl(url),
  });
  return {
    url: last.url,
    html: last.html,
  };
}

module.exports = {
  DEFAULT_DETAIL_GAP_MS,
  DEFAULT_LIST_GAP_MS,
  DEFAULT_WAIT_MS,
  DoubanBlockedError,
  fetchDoubanViaChrome,
  isDoubanDetailReady,
  isDoubanDetailUrl,
  isDoubanListReady,
};

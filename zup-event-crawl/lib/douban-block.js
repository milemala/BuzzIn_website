"use strict";

function isDoubanListReady(html) {
  return html.length > 12000 && html.includes("list-entry");
}

function isDoubanDetailReady(html) {
  return html.length > 8000 && (html.includes("event-detail") || html.includes('itemprop="summary"'));
}

function isDoubanDetailUrl(url) {
  return /\/event\/\d+\//.test(url);
}

class DoubanBlockedError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = "DoubanBlockedError";
    this.code = "DOUBAN_BLOCKED";
    this.url = meta.url || "";
    this.reason = meta.reason || "";
    this.status = meta.status;
  }
}

function isDoubanBlockedError(error) {
  return Boolean(error && (error instanceof DoubanBlockedError || error.code === "DOUBAN_BLOCKED"));
}

function detectDoubanBlock(html, url = "") {
  const text = String(html || "");
  const urlText = String(url || "");

  if (/sec\.douban\.com/i.test(urlText)) return "安全验证页";
  if (/accounts\.douban\.com/i.test(urlText) && !/\/event\//i.test(urlText)) return "跳转登录页";

  const patterns = [
    [/有异常请求从你的 IP 发出/, "IP 异常请求"],
    [/请登录(?:后)?使用豆瓣/, "需登录"],
    [/人机验证|验证码|captcha/i, "验证码/人机验证"],
    [/访问过于频繁/, "访问过于频繁"],
    [/系统繁忙|稍后再试/, "系统繁忙"],
  ];
  for (const [pattern, reason] of patterns) {
    if (pattern.test(text)) return reason;
  }
  return "";
}

function assertDoubanPageAccessible(html, url, options = {}) {
  const blockReason = detectDoubanBlock(html, url);
  if (blockReason) {
    throw new DoubanBlockedError(`豆瓣风控：${blockReason}`, { url, reason: blockReason });
  }

  const expectList = options.expectList || (!isDoubanDetailUrl(url) && options.expectList !== false);
  const expectDetail = options.expectDetail || isDoubanDetailUrl(url);

  if (expectList && !isDoubanListReady(html)) {
    throw new DoubanBlockedError("豆瓣列表页无法加载（无活动内容，可能被风控）", { url });
  }
  if (expectDetail && !isDoubanDetailReady(html)) {
    throw new DoubanBlockedError("豆瓣详情页无法加载（可能被风控）", { url });
  }
}

module.exports = {
  DoubanBlockedError,
  assertDoubanPageAccessible,
  detectDoubanBlock,
  isDoubanBlockedError,
  isDoubanDetailReady,
  isDoubanDetailUrl,
  isDoubanListReady,
};

"use strict";

const { execFileSync } = require("child_process");

const DEFAULT_WAIT_MS = 4500;
const MAX_HTML_BYTES = 45 * 1024 * 1024;

/** 专用抓取窗口序号（1-based），避免占用用户前台标签、且不 activate Chrome */
let scrapeWindowIndex = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runAppleScript(script) {
  try {
    return execFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      maxBuffer: MAX_HTML_BYTES,
    }).trim();
  } catch (error) {
    if (String(error.message || "").includes("-1723")) {
      const hint = new Error(
        "Chrome 未允许 AppleScript 执行 JavaScript。请在 Chrome 菜单：查看 → 开发者 → 允许 AppleScript 中的 JavaScript，然后重试。",
      );
      hint.code = "CHROME_JS_DENIED";
      throw hint;
    }
    if (String(error.message || "").includes("Google Chrome")) {
      const hint = new Error("未检测到 Google Chrome，或 Chrome 无法通过 AppleScript 控制。请先打开 Chrome。");
      hint.code = "CHROME_UNAVAILABLE";
      throw hint;
    }
    throw error;
  }
}

function ensureScrapeWindowScript() {
  if (scrapeWindowIndex === null) {
    return `
  if (count of windows) = 0 then
    make new window
  else
    make new window
  end if
  set winIdx to count of windows`;
  }
  return `set winIdx to ${scrapeWindowIndex}
  if winIdx > (count of windows) then
    make new window
    set winIdx to count of windows
  end if`;
}

function navigateChrome(url) {
  const escapedUrl = escapeAppleScriptString(url);
  const script = `
tell application "Google Chrome"
  ${ensureScrapeWindowScript()}
  tell window winIdx
    tell active tab
      set URL to "${escapedUrl}"
    end tell
  end tell
end tell
return winIdx`;
  const winIdx = Number(runAppleScript(script));
  if (winIdx > 0) {
    scrapeWindowIndex = winIdx;
  }
}

function readActiveTab() {
  const winIdx = scrapeWindowIndex || 1;
  const script = `
tell application "Google Chrome"
  set winIdx to ${winIdx}
  if winIdx > (count of windows) then
    error "抓取专用 Chrome 窗口已关闭，请重新运行抓取命令"
  end if
  tell window winIdx
    set pageUrl to URL of active tab
    tell active tab
      set shopCount to execute javascript "(function(){return document.querySelectorAll('[data-click-name=shop_title_click]').length})()"
      set htmlText to execute javascript "document.documentElement.outerHTML"
    end tell
  end tell
end tell
return pageUrl & "\\n<<<SHOPS>>>" & shopCount & "\\n<<<HTML>>>" & htmlText`;
  const raw = runAppleScript(script);
  const shopSplit = raw.indexOf("\n<<<SHOPS>>>");
  const htmlSplit = raw.indexOf("\n<<<HTML>>>");
  if (shopSplit < 0 || htmlSplit < 0) {
    throw new Error("Chrome 返回格式异常，无法读取页面 HTML");
  }
  return {
    url: raw.slice(0, shopSplit),
    shopCount: Number(raw.slice(shopSplit + "\n<<<SHOPS>>>".length, htmlSplit)) || 0,
    html: raw.slice(htmlSplit + "\n<<<HTML>>>".length),
  };
}

async function waitForPage(url, options = {}) {
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let last = null;
  let expectedHost;
  try {
    expectedHost = new URL(url).hostname;
  } catch (error) {
    expectedHost = "dianping.com";
  }

  while (Date.now() < deadline) {
    await sleep(700);
    last = readActiveTab();
    if (!last.url.includes(expectedHost)) {
      continue;
    }
    const ready = last.html.length > 8000;
    const hasList = last.html.includes("shop-all-list") || last.html.includes("/shop/");
    const isLoginOnly = last.html.includes("扫码登录") && !hasList;
    const listReady = options.expectShopList
      ? last.shopCount > 0 && last.html.includes("shop_title_click")
      : hasList;
    if (ready && listReady && !isLoginOnly) {
      return last;
    }
  }

  return last || readActiveTab();
}

/**
 * 用本机已登录的 Google Chrome 在后台专用窗口打开 URL 并取回 HTML（不 activate，不抢焦点）。
 * 需一次性开启：Chrome → 查看 → 开发者 → 允许 AppleScript 中的 JavaScript。
 */
async function fetchViaChrome(url, options = {}) {
  navigateChrome(url);
  const result = await waitForPage(url, {
    waitMs: options.waitMs,
    expectShopList: options.expectShopList,
  });
  if (!result || !result.html) {
    throw new Error(`未能从 Chrome 读取页面: ${url}`);
  }
  return result;
}

module.exports = {
  fetchViaChrome,
  navigateChrome,
  readActiveTab,
  sleep,
};

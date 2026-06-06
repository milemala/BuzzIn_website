"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_WAIT_MS = 4500;
const MAX_HTML_BYTES = 45 * 1024 * 1024;
const STATE_FILE = path.join(__dirname, "..", "data", "chrome-scrape-window.json");

/** 进程内缓存，与 STATE_FILE 同步，供同一 Node 进程多次导航复用 */
let scrapeWindowIndex = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeAppleScriptString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function readWindowState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    if (Number.isFinite(Number(data.windowIndex)) && Number(data.windowIndex) > 0) {
      return Number(data.windowIndex);
    }
  } catch (error) {
    // no state yet
  }
  return 1;
}

function writeWindowState(windowIndex) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    `${JSON.stringify({ windowIndex, updatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  scrapeWindowIndex = windowIndex;
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

/**
 * 复用单一「抓取专用」窗口：子进程通过 data/chrome-scrape-window.json 共享窗口序号。
 * 禁止每次抓取都 make new window（批量任务会 spawn 多个 Node 进程）。
 */
function ensureScrapeWindowScript() {
  const pinned = scrapeWindowIndex || readWindowState();
  return `
  set winIdx to ${pinned}
  if (count of windows) = 0 then
    make new window
    set winIdx to 1
  else if winIdx > (count of windows) then
    set winIdx to 1
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
    writeWindowState(winIdx);
  }
}

function readActiveTab() {
  const winIdx = scrapeWindowIndex || readWindowState();
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
  const minShopCount = options.minShopCount ?? 8;
  const deadline = Date.now() + waitMs;
  let last = null;
  let expectedHost;
  let expectedPath = "";
  try {
    const parsed = new URL(url);
    expectedHost = parsed.hostname;
    expectedPath = parsed.pathname;
  } catch (error) {
    expectedHost = "dianping.com";
  }

  while (Date.now() < deadline) {
    await sleep(700);
    last = readActiveTab();
    if (!last.url.includes(expectedHost)) {
      continue;
    }
    if (expectedPath && !last.url.includes(expectedPath.split("/p")[0])) {
      continue;
    }
    const ready = last.html.length > 8000;
    const hasList = last.html.includes("shop-all-list") || last.html.includes("/shop/");
    const isLoginOnly = last.html.includes("扫码登录") && !hasList;
    const listReady = options.expectShopList
      ? last.shopCount >= minShopCount && last.html.includes("shop_title_click")
      : hasList;
    const listPartial = options.expectShopList
      && last.shopCount > 0
      && last.shopCount < minShopCount
      && last.html.includes("shop_title_click");
    if (ready && listReady && !isLoginOnly) {
      return last;
    }
    if (ready && listPartial && Date.now() + 1500 >= deadline) {
      return last;
    }
  }

  return last || readActiveTab();
}

/**
 * 用本机已登录的 Google Chrome 在**同一后台专用窗口**打开 URL 并取回 HTML。
 * 不 activate Chrome，不每次新建窗口；窗口序号持久化在 data/chrome-scrape-window.json。
 */
async function fetchViaChrome(url, options = {}) {
  navigateChrome(url);
  const result = await waitForPage(url, {
    waitMs: options.waitMs,
    expectShopList: options.expectShopList,
    minShopCount: options.minShopCount,
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
  readWindowState,
  writeWindowState,
  sleep,
};

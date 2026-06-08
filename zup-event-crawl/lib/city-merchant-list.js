"use strict";

const fs = require("fs");
const path = require("path");

const STATUS_PREFIX = /^(已抓取|未找到|搜不到)/;

function parseCityMerchantList(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const entries = [];
  let inList = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "## 商户清单") {
      inList = true;
      continue;
    }
    if (!inList || !line) continue;
    const match = line.match(/^(\d+)、(.+)$/);
    if (!match) continue;
    const index = Number(match[1]);
    const listName = match[2].trim();
    let listAddress = "";
    let statusLine = "";
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j].trim();
      if (/^\d+、/.test(next)) break;
      if (next.startsWith("#")) break;
      if (!next) continue;
      if (STATUS_PREFIX.test(next)) {
        statusLine = next;
        continue;
      }
      if (!listAddress) {
        listAddress = next;
        continue;
      }
    }
    entries.push({ index, listName, listAddress, statusLine, lineIndex: i });
  }

  return { text, lines, entries };
}

function buildStatusLine(status, detail = "") {
  if (status === "scraped") {
    return detail ? `已抓取｜${detail}` : "已抓取";
  }
  if (status === "not_found") {
    return detail ? `未找到｜${detail}` : "未找到";
  }
  return detail || "未找到";
}

/**
 * 根据抓取结果回写城市清单 md。
 * @param {string} filePath
 * @param {{
 *   scraped?: Array<{ listName: string, matchedName?: string, link?: string }>,
 *   notFound?: Array<{ listName: string, reason?: string }>,
 * }} report
 */
function updateCityMerchantListScrapeStatus(filePath, report = {}) {
  const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
  const { lines, entries } = parseCityMerchantList(absPath);
  const scrapedMap = new Map((report.scraped || []).map((row) => [row.listName, row]));
  const notFoundMap = new Map((report.notFound || []).map((row) => [row.listName, row]));

  const rebuilt = [];
  let inList = false;
  let entryIdx = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();

    if (line === "## 大众点评抓取进度") {
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith("## ")) i += 1;
      continue;
    }

    if (line === "## 商户清单") {
      inList = true;
      rebuilt.push(raw);
      continue;
    }

    if (!inList) {
      rebuilt.push(raw);
      continue;
    }

    const match = line.match(/^(\d+)、(.+)$/);
    if (!match) {
      if (STATUS_PREFIX.test(line)) continue;
      rebuilt.push(raw);
      continue;
    }

    const entry = entries[entryIdx];
    entryIdx += 1;
    rebuilt.push(raw);

    let j = i + 1;
    const block = [];
    while (j < lines.length) {
      const next = lines[j].trim();
      if (/^\d+、/.test(next)) break;
      if (next.startsWith("## ")) break;
      if (next && !STATUS_PREFIX.test(next)) block.push(lines[j]);
      j += 1;
    }

    if (!block.length && entry?.listAddress) {
      rebuilt.push(entry.listAddress);
    } else {
      for (const row of block) rebuilt.push(row);
    }

    const scraped = scrapedMap.get(entry.listName);
    const missing = notFoundMap.get(entry.listName);
    if (scraped) {
      const detail = scraped.matchedName
        ? `大众点评：${scraped.matchedName}`
        : "大众点评已入库";
      rebuilt.push(buildStatusLine("scraped", detail));
    } else if (missing) {
      rebuilt.push(buildStatusLine("not_found", missing.reason || "列表页无匹配结果"));
    }

    i = j - 1;
  }

  const scrapedCount = (report.scraped || []).length;
  const notFoundCount = (report.notFound || []).length;
  const progress = [
    "",
    "## 大众点评抓取进度",
    "",
    `- 已抓取：${scrapedCount} 家`,
    `- 未找到：${notFoundCount} 家`,
    `- 最后更新：${new Date().toISOString().slice(0, 10)}`,
    "",
  ];

  const listHeadingIdx = rebuilt.findIndex((line) => line.trim() === "## 商户清单");
  if (listHeadingIdx >= 0) {
    rebuilt.splice(listHeadingIdx, 0, ...progress);
  } else {
    rebuilt.push(...progress);
  }

  fs.writeFileSync(absPath, `${rebuilt.join("\n").replace(/\n{3,}/g, "\n\n")}\n`, "utf8");
  return { scrapedCount, notFoundCount, total: entries.length };
}

module.exports = {
  buildStatusLine,
  parseCityMerchantList,
  updateCityMerchantListScrapeStatus,
};

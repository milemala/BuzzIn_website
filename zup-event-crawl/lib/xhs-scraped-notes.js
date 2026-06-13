"use strict";

const fs = require("fs");
const path = require("path");
const { openDatabase } = require("./review-db");

function noteIdFromXhsEventUid(eventUid) {
  const match = String(eventUid || "").match(/^xiaohongshu:([^:]+):/);
  return match ? match[1] : "";
}

/**
 * 已抓取过的小红书汇总帖 noteId（本地 weekly-summary + 库内同城 xhs 活动反查）
 */
function loadScrapedXhsNoteIds(city, rootDir, dbPath) {
  const ids = new Set();
  const cityDir = path.join(rootDir, "data", "scrape-cache", "xhs", city);

  if (fs.existsSync(cityDir)) {
    for (const entry of fs.readdirSync(cityDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const summaryPath = path.join(cityDir, entry.name, "weekly-summary.json");
      if (fs.existsSync(summaryPath)) {
        ids.add(entry.name);
      }
    }
  }

  if (dbPath && fs.existsSync(dbPath)) {
    const db = openDatabase(dbPath);
    try {
      const rows = db.prepare(`
        SELECT event_uid
        FROM events
        WHERE source = 'xiaohongshu' AND city = ?
      `).all(city);
      for (const row of rows) {
        const noteId = noteIdFromXhsEventUid(row.event_uid);
        if (noteId) ids.add(noteId);
      }
    } finally {
      db.close();
    }
  }

  return ids;
}

module.exports = {
  loadScrapedXhsNoteIds,
  noteIdFromXhsEventUid,
};

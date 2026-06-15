#!/usr/bin/env node
"use strict";

/**
 * 清除某篇小红书汇总帖的入库记录与裁切产物，便于重标 vision-slots 后重跑流水线。
 *
 *   node scripts/purge-xhs-note-for-reprocess.js --city=重庆 --note=6a22bc9200000000080245d6
 *   node scripts/purge-xhs-note-for-reprocess.js --city=广州,西安,南京,重庆 --note=...
 */

const fs = require("fs");
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { xhsEventUid } = require("../lib/xhs-review-import");
const { getComposedImageDir } = require("../lib/composed-image");

const root = path.join(__dirname, "..");

function parseArgs(argv) {
  const options = { cities: [], noteIds: [], dbPath: path.join(root, "data", "review.db"), dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--city=")) {
      options.cities = arg.slice("--city=".length).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    } else if (arg.startsWith("--note=")) {
      options.noteIds.push(...arg.slice("--note=".length).split(/[,，]/).map((s) => s.trim()).filter(Boolean));
    } else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
  }
  return options;
}

function rmIfExists(target, dryRun) {
  if (!fs.existsSync(target)) return;
  if (dryRun) {
    console.log(`[dry-run] 删除 ${target}`);
    return;
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function purgeNoteDir(noteDir, dryRun) {
  for (const name of [
    "vision-slots.json",
    "events-extracted.json",
    "events-extracted.md",
    "poster-qa.json",
    "posters-contact-sheet.png",
  ]) {
    const file = path.join(noteDir, name);
    if (fs.existsSync(file)) {
      if (dryRun) console.log(`[dry-run] 删除 ${file}`);
      else fs.unlinkSync(file);
    }
  }
  rmIfExists(path.join(noteDir, "posters"), dryRun);
  rmIfExists(path.join(noteDir, "poster-box-preview"), dryRun);
  const meta = path.join(noteDir, "vision-slots.meta.json");
  if (fs.existsSync(meta)) {
    if (dryRun) console.log(`[dry-run] 删除 ${meta}`);
    else fs.unlinkSync(meta);
  }
}

function purgeDb(noteId, dbPath, dryRun) {
  const db = openDatabase(dbPath);
  try {
    const prefix = `xiaohongshu:${noteId}:%`;
    const rows = db.prepare(`
      SELECT event_uid FROM events WHERE event_uid LIKE ?
    `).all(prefix);
    if (!rows.length) {
      console.log(`  库中无 ${noteId} 记录`);
      return 0;
    }
    if (dryRun) {
      console.log(`[dry-run] 将删除 ${rows.length} 条 events + review_decisions`);
      return rows.length;
    }
    db.prepare("DELETE FROM review_decisions WHERE event_uid LIKE ?").run(prefix);
    db.prepare("DELETE FROM events WHERE event_uid LIKE ?").run(prefix);
    return rows.length;
  } finally {
    db.close();
  }
}

function purgeComposedImages(noteId, dryRun) {
  const dir = getComposedImageDir(root);
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".jpg")) continue;
    const uid = decodeURIComponent(file.replace(/\.jpg$/, ""));
    if (!uid.startsWith(`xiaohongshu:${noteId}:`)) continue;
    n += 1;
    const target = path.join(dir, file);
    if (dryRun) console.log(`[dry-run] 删除封面 ${target}`);
    else fs.unlinkSync(target);
  }
  return n;
}

function resolveNoteDirs(cities, noteIds) {
  const pairs = [];
  if (noteIds.length) {
    for (const noteId of noteIds) {
      for (const city of cities.length ? cities : fs.readdirSync(path.join(root, "data", "scrape-cache", "xhs"))) {
        const noteDir = path.join(root, "data", "scrape-cache", "xhs", city, noteId);
        if (fs.existsSync(noteDir)) pairs.push({ city, noteId, noteDir });
      }
    }
    return pairs;
  }
  for (const city of cities) {
    const cityDir = path.join(root, "data", "scrape-cache", "xhs", city);
    if (!fs.existsSync(cityDir)) continue;
    for (const entry of fs.readdirSync(cityDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      pairs.push({ city, noteId: entry.name, noteDir: path.join(cityDir, entry.name) });
    }
  }
  return pairs;
}

function main() {
  const options = parseArgs(process.argv);
  const pairs = resolveNoteDirs(options.cities, options.noteIds);
  if (!pairs.length) {
    console.error("未找到笔记目录");
    process.exit(2);
  }

  let totalEvents = 0;
  let totalCovers = 0;
  for (const { city, noteId, noteDir } of pairs) {
    console.log(`\n清除 ${city} / ${noteId}`);
    totalEvents += purgeDb(noteId, options.dbPath, options.dryRun);
    purgeNoteDir(noteDir, options.dryRun);
    totalCovers += purgeComposedImages(noteId, options.dryRun);
  }
  console.log(`\n完成：events ${totalEvents} · 封面缓存 ${totalCovers} · 笔记 ${pairs.length}`);
}

main();

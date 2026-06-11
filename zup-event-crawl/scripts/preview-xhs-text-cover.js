#!/usr/bin/env node
"use strict";

/**
 * 预览小红书无海报活动的 4:3 文字封面
 *
 *   node scripts/preview-xhs-text-cover.js --title="三立方夏日草坪快闪市集"
 *   node scripts/preview-xhs-text-cover.js --event=01_0 --note-dir=data/scrape-cache/xhs/上海/6a26a11a00000000070139c2
 */

const fs = require("fs");
const path = require("path");
const { composeXhsTextCoverToFile } = require("../lib/xhs-text-cover-compose");

const root = path.join(__dirname, "..");

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

async function main() {
  let title = readArg("title");
  const eventIndex = readArg("event");
  const noteDir = path.resolve(root, readArg("note-dir") || "");
  const out = readArg("out");

  if (!title && eventIndex && noteDir) {
    const extracted = JSON.parse(fs.readFileSync(path.join(noteDir, "events-extracted.json"), "utf8"));
    const ev = extracted.events.find((e) => e.index === eventIndex);
    if (!ev) throw new Error(`未找到活动 ${eventIndex}`);
    title = ev.name;
  }

  if (!title) {
    console.error("用法: node scripts/preview-xhs-text-cover.js --title=活动名");
    console.error("  或: node scripts/preview-xhs-text-cover.js --event=01_0 --note-dir=<笔记目录>");
    process.exit(1);
  }

  const safeName = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 48);
  const outputPath =
    out ||
    path.join(root, "data", "scrape-cache", "xhs", "cover-preview", `${safeName}-4x3.jpg`);

  await composeXhsTextCoverToFile(title, outputPath);
  const meta = await require("sharp")(outputPath).metadata();

  console.log(`标题: ${title}`);
  console.log(`尺寸: ${meta.width}×${meta.height} (${meta.width / meta.height === 4 / 3 ? "4:3" : "非4:3"})`);
  console.log(`输出: ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

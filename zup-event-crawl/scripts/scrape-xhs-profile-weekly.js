#!/usr/bin/env node
"use strict";

/**
 * 小红书个人页 → 识别本周活动汇总帖 → 下载 slide 图 →（可选）合并 vision-slots
 *
 * 前置：本机 Chrome 已登录小红书；已开启「允许 AppleScript 中的 JavaScript」
 *
 * 用法:
 *   node scripts/scrape-xhs-profile-weekly.js --city=北京 "<个人页URL>"
 *   node scripts/scrape-xhs-profile-weekly.js --city=上海 "https://www.xiaohongshu.com/user/profile/..."
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const {
  downloadNoteImages,
  fetchXhsNoteViaChrome,
  fetchXhsProfileViaChrome,
} = require("../lib/xiaohongshu-chrome-fetch");
const {
  parseEventsFromDesc,
  pickWeeklyRoundupNote,
} = require("../lib/xiaohongshu-parse");

function parseArgs(argv) {
  const options = { city: "", profileUrl: "", limit: 10, skipExtract: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg === "--skip-extract") options.skipExtract = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length)) || 10;
    else if (!arg.startsWith("--")) options.profileUrl = arg;
  }
  return options;
}

async function scrapeXhsProfileWeekly(profileUrl, options = {}) {
  const city = options.city || "未标注城市";
  const outRoot = path.join(__dirname, "..", "data", "scrape-cache", "xhs", city);

  console.log(`[${city}] 1/4 抓取个人页…`);
  const profile = await fetchXhsProfileViaChrome(profileUrl, { limit: options.limit || 10 });
  console.log(`   前 ${profile.notes.length} 条笔记:`);
  profile.notes.forEach((n, i) => console.log(`   ${i + 1}. ${n.title}`));

  const picked = pickWeeklyRoundupNote(profile.notes);
  if (!picked) {
    throw new Error(`[${city}] 未在前 ${profile.notes.length} 条中找到「本周/一周活动汇总」类帖子`);
  }
  console.log(`\n[${city}] 2/4 选中汇总帖: ${picked.title} (${picked.noteId})`);

  const detail = await fetchXhsNoteViaChrome(picked.noteId, picked.xsecToken);
  const noteDir = path.join(outRoot, picked.noteId);
  fs.mkdirSync(noteDir, { recursive: true });
  fs.writeFileSync(path.join(noteDir, "note.json"), `${JSON.stringify(detail.note, null, 2)}\n`);

  console.log(`[${city}] 3/4 下载 slide 图…`);
  const images = await downloadNoteImages(detail.note, path.join(noteDir, "images"));

  const eventsFromText = parseEventsFromDesc(detail.note.desc);
  const result = {
    city,
    profileUrl,
    account: detail.note.user?.nickname,
    pickedNote: {
      noteId: picked.noteId,
      title: picked.title,
      url: detail.url,
    },
    period: (detail.note.desc.match(/活动周期：([^\n]+)/) || [])[1] || null,
    eventsFromText,
    imageFiles: images.map((x) => path.relative(noteDir, x.file).split(path.sep).join("/")),
    scrapedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(noteDir, "weekly-summary.json"), `${JSON.stringify(result, null, 2)}\n`);

  if (!options.skipExtract) {
    console.log(`[${city}] 4/4 合并 vision（无 posterBox 则不裁图）…`);
    execFileSync(process.execPath, [path.join(__dirname, "extract-xhs-weekly-events.js"), noteDir], {
      stdio: "inherit",
    });
  }

  return { city, noteDir, picked, eventsFromText };
}

async function main() {
  const options = parseArgs(process.argv);
  if (!options.profileUrl) {
    console.error("用法: node scripts/scrape-xhs-profile-weekly.js --city=城市名 <小红书个人页URL>");
    process.exit(1);
  }
  if (!options.city) {
    console.error("请指定 --city=城市名（用于输出目录 data/scrape-cache/xhs/<城市>/）");
    process.exit(1);
  }

  const { noteDir, eventsFromText } = await scrapeXhsProfileWeekly(options.profileUrl, options);
  console.log(`\n完成 → ${noteDir}`);
  console.log("下一步：Agent 读 images/*.webp 全图填写 vision-slots.json；需要单独海报时再写 posterBox");
  eventsFromText.forEach((sec) => {
    console.log(`\n【${sec.category}】`);
    sec.items.forEach((name, i) => console.log(`  ${i + 1}. ${name}`));
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = { scrapeXhsProfileWeekly };

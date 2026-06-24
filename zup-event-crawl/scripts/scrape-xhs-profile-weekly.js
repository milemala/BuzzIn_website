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
  buildNoteExploreUrl,
  extractActivityPeriod,
  isRoundupContentExpired,
  parseEventsFromDesc,
  pickWeeklyRoundupNotes,
} = require("../lib/xiaohongshu-parse");
const { loadScrapedXhsNoteIds } = require("../lib/xhs-scraped-notes");
const {
  hasVisionSlots,
  printAwaitingVisionHelp,
  processNoteDir,
  runExtractScript,
} = require("../lib/xhs-weekly-pipeline");

function parseArgs(argv) {
  const options = { city: "", profileUrl: "", limit: 10, skipExtract: false, withImport: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg === "--skip-extract") options.skipExtract = true;
    else if (arg === "--with-import") options.withImport = true;
    else if (arg.startsWith("--limit=")) options.limit = Number(arg.slice("--limit=".length)) || 10;
    else if (!arg.startsWith("--")) options.profileUrl = arg;
  }
  return options;
}

async function pickValidRoundupWithDetail(profileNotes, refDate, scrapedNoteIds, outRoot, fetchDetail) {
  const candidates = pickWeeklyRoundupNotes(profileNotes, refDate, { scrapedNoteIds });
  if (!candidates.length) return null;

  for (const candidate of candidates) {
    const noteDir = path.join(outRoot, candidate.noteId);
    const cachedNotePath = path.join(noteDir, "note.json");
    let detail;
    if (fs.existsSync(cachedNotePath)) {
      const note = JSON.parse(fs.readFileSync(cachedNotePath, "utf8"));
      detail = { note, url: buildNoteExploreUrl(candidate.noteId, candidate.xsecToken) };
    } else {
      detail = await fetchDetail(candidate.noteId, candidate.xsecToken);
    }

    const period = extractActivityPeriod(detail.note.desc);
    const check = isRoundupContentExpired({
      title: detail.note.title || candidate.title,
      desc: detail.note.desc,
      period,
    }, refDate);
    if (check.expired) {
      console.log(`   跳过（详情日期已过期）: ${candidate.title} — ${check.reason}`);
      continue;
    }
    return { picked: candidate, detail };
  }
  return null;
}

async function scrapeXhsProfileWeekly(profileUrl, options = {}) {
  const rootDir = path.join(__dirname, "..");
  const city = options.city || "未标注城市";
  const outRoot = path.join(rootDir, "data", "scrape-cache", "xhs", city);
  const dbPath = options.dbPath || path.join(rootDir, "data", "review.db");

  console.log(`[${city}] 1/4 抓取个人页…`);
  const profile = await fetchXhsProfileViaChrome(profileUrl, { limit: options.limit || 10 });
  console.log(`   前 ${profile.notes.length} 条笔记:`);
  profile.notes.forEach((n, i) => console.log(`   ${i + 1}. ${n.title}`));

  const scrapedNoteIds = loadScrapedXhsNoteIds(city, rootDir, dbPath);
  if (scrapedNoteIds.size) {
    console.log(`   已抓过 ${scrapedNoteIds.size} 篇汇总帖，将跳过重复 noteId`);
  }

  const refDate = new Date();
  const resolved = await pickValidRoundupWithDetail(
    profile.notes,
    refDate,
    scrapedNoteIds,
    outRoot,
    fetchXhsNoteViaChrome,
  );
  if (!resolved) {
    const hadCandidates = pickWeeklyRoundupNotes(profile.notes, refDate, { scrapedNoteIds }).length > 0;
    throw new Error(
      hadCandidates
        ? `[${city}] 个人页汇总帖详情日期均已过期，本批跳过（已抓 ${scrapedNoteIds.size} 篇）`
        : `[${city}] 无新的合适汇总帖（已抓 ${scrapedNoteIds.size} 篇；个人页前 ${profile.notes.length} 条中无可选本周/节日/整月汇总）`,
    );
  }
  const { picked, detail: prefetchedDetail } = resolved;
  const tierLabels = { week: "本周/下周汇总", dated: "节日/专题汇总", month: "整月汇总" };
  const tierLabel = tierLabels[picked.pickTier] || "活动汇总";
  console.log(`\n[${city}] 2/4 选中${tierLabel}: ${picked.title} (${picked.noteId})`);

  const noteDir = path.join(outRoot, picked.noteId);
  const alreadyScraped = fs.existsSync(path.join(noteDir, "weekly-summary.json"));
  if (alreadyScraped) {
    console.log(`[${city}] 本地已有该帖缓存，跳过重复下载 → ${noteDir}`);
    if (!options.skipExtract) {
      await finishExtractAndImport(noteDir, city, { ...options, rootDir, dbPath });
    }
    const summary = JSON.parse(fs.readFileSync(path.join(noteDir, "weekly-summary.json"), "utf8"));
    return { city, noteDir, picked, eventsFromText: summary.eventsFromText || [], skipped: true };
  }

  const detail = prefetchedDetail;
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
    period: extractActivityPeriod(detail.note.desc),
    eventsFromText,
    imageFiles: images.map((x) => path.relative(noteDir, x.file).split(path.sep).join("/")),
    scrapedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(noteDir, "weekly-summary.json"), `${JSON.stringify(result, null, 2)}\n`);

  if (!options.skipExtract) {
    await finishExtractAndImport(noteDir, city, { ...options, rootDir, dbPath });
  }

  return { city, noteDir, picked, eventsFromText };
}

async function finishExtractAndImport(noteDir, city, options) {
  const rootDir = options.rootDir || path.join(__dirname, "..");
  if (!hasVisionSlots(noteDir)) {
    console.log(`[${city}] 4/4 等待 Agent 填写 vision-slots.json（无则跳过 extract/入库）`);
    printAwaitingVisionHelp(city, rootDir);
    return;
  }
  console.log(`[${city}] 4/4 合并 vision + 入库准备…`);
  if (options.withImport) {
    await processNoteDir(noteDir, { rootDir, dbPath: options.dbPath, skipImport: false, log: true });
  } else {
    runExtractScript(noteDir, rootDir);
  }
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
  console.log("标准流水线：node scripts/run-xhs-weekly-pipeline.js --skip-scrape --city=" + options.city);
  console.log("说明：docs/xiaohongshu-review-workflow.md");
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

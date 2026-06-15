#!/usr/bin/env node
"use strict";

/**
 * 合并 vision-slots.json → events-extracted.json
 *
 * 活动字段与 posterBox 均由 Agent 读 images/*.webp 后填写。
 * 脚本只负责：有 posterBox → 按框裁 posters/；无则 poster=null。
 *
 * 用法: node scripts/extract-xhs-weekly-events.js <笔记目录>
 */

const fs = require("fs");
const path = require("path");
const { cropPostersFromVisionSlots } = require("../lib/xiaohongshu-poster-crop");
const { buildIntroFromVisionSlot, formatIntroParagraphs } = require("../lib/xhs-event-intro");
const {
  META_FILENAME,
  loadMeta,
  validateVisionPosterBoxes,
} = require("../lib/xhs-vision-poster-guard");

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function rel(file, base) {
  return path.relative(base, file).split(path.sep).join("/");
}

function slideFromSlotKey(slotKey, entry) {
  if (entry?.slide) return entry.slide;
  if (entry?.posterBox?.slide) return entry.posterBox.slide;
  const slideIndex = slotKey.split("_")[0];
  if (/^\d+$/.test(slideIndex)) return `${slideIndex.padStart(2, "0")}.webp`;
  return null;
}

function slotFromKey(slotKey) {
  const parts = slotKey.split("_");
  return parts.length > 1 ? Number(parts[1]) : 0;
}

function buildEventsFromVision(noteDir, vision, cropped) {
  const keys = Object.keys(vision || {}).sort();
  if (!keys.length) return [];

  return keys.map((slotKey) => {
    const v = vision[slotKey] || {};
    const slide = slideFromSlotKey(slotKey, v);
    const crop = cropped.get(slotKey);

    return {
      index: slotKey,
      slide,
      slot: slotFromKey(slotKey),
      sourceImage: slide ? `images/${slide}` : null,
      poster: crop ? rel(crop.posterFile, noteDir) : null,
      posterDropped: Boolean(v.posterDrop),
      posterDropReasons: v.posterDropReasons || null,
      needsPosterBox: false,
      category: v.category || null,
      name: v.name || null,
      price: v.price ?? null,
      intro: formatIntroParagraphs(buildIntroFromVisionSlot(v)) || null,
      time: v.time || null,
      address: v.address || null,
      needsVision: !v.name,
    };
  });
}

function buildPlaceholderEvents(summary) {
  const items = [];
  for (const sec of summary.eventsFromText || []) {
    sec.items.forEach((name, i) => {
      items.push({
        index: `text_${items.length}`,
        slide: null,
        slot: i,
        sourceImage: null,
        poster: null,
        needsPosterBox: false,
        category: sec.category,
        name,
        price: null,
        time: null,
        address: null,
        intro: null,
        needsVision: true,
      });
    });
  }
  return items;
}

async function main() {
  const noteDir = path.resolve(process.argv[2] || "");
  if (!noteDir || !fs.existsSync(noteDir)) {
    console.error("用法: node scripts/extract-xhs-weekly-events.js <笔记目录>");
    process.exit(1);
  }

  const imagesDir = path.join(noteDir, "images");
  if (!fs.existsSync(imagesDir)) {
    console.error("缺少 images/ 目录，请先运行 scrape-xhs-profile-weekly.js");
    process.exit(2);
  }

  const summaryFile = path.join(noteDir, "weekly-summary.json");
  const summary = fs.existsSync(summaryFile) ? loadJson(summaryFile) : {};
  const noteId = summary.pickedNote?.noteId || path.basename(noteDir);
  const vision = fs.existsSync(path.join(noteDir, "vision-slots.json"))
    ? loadJson(path.join(noteDir, "vision-slots.json"))
    : {};

  const postersDir = path.join(noteDir, "posters");
  const cropped = new Map();
  const withBox = Object.values(vision).filter((v) => v?.posterBox).length;
  const skipPosterGuard = process.argv.includes("--skip-poster-guard");

  if (withBox && !skipPosterGuard) {
    const meta = loadMeta(noteDir, fs);
    const check = validateVisionPosterBoxes(vision, { meta });
    for (const w of check.warnings) console.warn(`  ⚠ posterBox 守卫：${w}`);
    if (!check.ok) {
      console.error("✗ posterBox 硬性守卫未通过，拒绝裁切。须重标 vision-slots.json 并写入 vision-slots.meta.json");
      for (const e of check.errors) console.error(`  · ${e}`);
      console.error(`  见 .cursor/rules/zup-event-crawl-hard-gates.mdc 与 docs/xiaohongshu-vision-labeling-prompt.md`);
      process.exit(3);
    }
  }

  if (withBox) {
    console.log(`按 Agent 标注的 posterBox 切图（${withBox} 条）…`);
    const map = await cropPostersFromVisionSlots(imagesDir, postersDir, vision);

    for (const [slotKey, crop] of map.entries()) {
      cropped.set(slotKey, crop);
    }

    console.log(`  裁切 ${cropped.size} 张 → posters/（crop/skip 由标框阶段决定，extract 不做 JS 门禁丢弃）`);
  } else {
    console.log("vision-slots 无 posterBox，跳过裁图（见 docs/xiaohongshu-vision-agent.md）");
  }

  let events = buildEventsFromVision(noteDir, vision, cropped);
  if (!events.length) {
    events = buildPlaceholderEvents(summary);
    console.log(`vision-slots 为空，已从正文列出 ${events.length} 条占位（待 Agent 读图）`);
  }

  const withPoster = events.filter((e) => e.poster).length;
  const withoutPoster = events.length - withPoster;
  if (withoutPoster) {
    console.log(`共 ${events.length} 条活动，其中 ${withPoster} 条有海报、${withoutPoster} 条无海报（poster 留空）`);
  }

  const byCategory = {};
  for (const ev of events) {
    const cat = ev.category || "未分类";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(ev);
  }

  const out = {
    city: summary.city || null,
    noteId,
    account: summary.account || null,
    title: summary.pickedNote?.title || null,
    period: summary.period || null,
    sourceUrl: summary.pickedNote?.url || null,
    extractedAt: new Date().toISOString(),
    extractionMode: withBox ? "vision+posterBox" : "vision-full-slide",
    eventCount: events.filter((e) => e.name && !e.needsVision).length,
    eventCountWithPoster: events.filter((e) => e.poster).length,
    events,
    byCategory,
  };

  const outFile = path.join(noteDir, "events-extracted.json");
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);

  const md = [
    `# ${out.title || noteId}`,
    "",
    `- 账号：${out.account || "—"}`,
    `- 周期：${out.period || "—"}`,
    `- 活动数：${out.eventCount}（有海报 ${out.eventCountWithPoster}）`,
    `- 提炼方式：${out.extractionMode}`,
    "",
  ];
  for (const [cat, list] of Object.entries(byCategory)) {
    md.push(`## ${cat}`, "");
    list.forEach((ev, i) => {
      md.push(`### ${i + 1}. ${ev.name || "（待读图）"}`);
      if (ev.price) md.push(`- **费用**：${ev.price}`);
      if (ev.time) md.push(`- **时间**：${ev.time}`);
      if (ev.address) md.push(`- **地址**：${ev.address}`);
      if (ev.intro) md.push(`- **介绍**：${ev.intro}`);
      if (ev.sourceImage) md.push(`- **原图（slide）**：\`${ev.sourceImage}\``);
      if (ev.poster) md.push(`- **海报（裁切）**：\`${ev.poster}\``);
      else md.push("- **海报**：无");
      md.push("");
    });
  }
  fs.writeFileSync(path.join(noteDir, "events-extracted.md"), `${md.join("\n")}\n`);

  console.log(`\n完成：${outFile}`);
  const pendingVision = events.filter((e) => e.needsVision).length;
  const pendingPoster = events.filter((e) => e.needsPosterBox).length;
  if (pendingVision) console.log(`⚠ ${pendingVision} 条待补全活动字段`);
  if (pendingPoster) console.log(`⚠ ${pendingPoster} 条待 Agent 标注 posterBox 后重跑本脚本`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

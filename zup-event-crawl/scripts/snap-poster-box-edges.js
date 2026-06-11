#!/usr/bin/env node
"use strict";

/**
 * 把 vision-slots.json 里 Agent 标的框（px）四边吸附到海报真实边缘。
 *
 * 分工（见 docs/xiaohongshu-vision-agent.md）：
 *   - Agent：决定每场 crop / skip，并一次标最终框
 *   - 本脚本：仅作为可选修边工具；不增删框、不改判定
 *
 * 用法:
 *   node scripts/snap-poster-box-edges.js <笔记目录>
 *     默认只打印预览，不写回 vision-slots.json
 *
 *   node scripts/snap-poster-box-edges.js <笔记目录> --write
 *     明确确认后才写回 vision-slots.json
 */

const fs = require("fs");
const path = require("path");
const { snapBoxesOnSlide } = require("../lib/xhs-poster-edge-snap");

async function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const noteDir = path.resolve(args.find((a) => !a.startsWith("-")) || "");
  const visionFile = path.join(noteDir, "vision-slots.json");
  if (!fs.existsSync(visionFile)) {
    console.error("用法: node scripts/snap-poster-box-edges.js <笔记目录> [--write]");
    process.exit(1);
  }

  const vision = JSON.parse(fs.readFileSync(visionFile, "utf8"));

  // 按 slide 分组
  const bySlide = new Map();
  for (const [key, entry] of Object.entries(vision)) {
    const box = entry?.posterBox;
    if (!box) continue;
    const slide = box.slide || entry.slide;
    if (!bySlide.has(slide)) bySlide.set(slide, []);
    bySlide.get(slide).push({ key, box: { x: box.x, y: box.y, w: box.w, h: box.h } });
  }

  let moved = 0;
  let warned = 0;
  for (const [slide, boxes] of bySlide) {
    const imagePath = path.join(noteDir, "images", slide);
    if (!fs.existsSync(imagePath)) {
      console.warn(`跳过 ${slide}：找不到原图`);
      continue;
    }
    const results = await snapBoxesOnSlide(imagePath, boxes);
    for (const r of results) {
      const d = r.deltas;
      const movedEdges = Object.entries(d)
        .filter(([, v]) => v !== 0)
        .map(([k, v]) => `${k}${v > 0 ? "+" : ""}${v}`)
        .join(" ");
      const tags = [];
      if (r.flags?.trimmed) tags.push("修剪残影");
      if (r.flags?.extended) tags.push("外扩");
      if (r.flags?.failed?.length) tags.push(`未吸附:${r.flags.failed.join("/")}`);
      const warn = r.check.warnings.length ? ` ⚠ ${r.check.warnings.join(",")}` : "";
      console.log(
        `${r.key} ${r.before.x},${r.before.y},${r.before.w},${r.before.h} → ` +
          `${r.after.x},${r.after.y},${r.after.w},${r.after.h}` +
          (movedEdges ? `  (${movedEdges})` : "  (未动)") +
          (tags.length ? ` [${tags.join(" ")}]` : "") +
          warn
      );
      if (movedEdges) moved++;
      if (r.check.warnings.length) warned++;
      if (write) {
        vision[r.key].posterBox = { slide, ...r.after };
      }
    }
  }

  if (write) {
    fs.writeFileSync(visionFile, `${JSON.stringify(vision, null, 2)}\n`);
    console.log(`\n已写回 vision-slots.json（吸附调整 ${moved} 条，自检警告 ${warned} 条）`);
  } else {
    console.log(`\n[preview] 吸附调整 ${moved} 条，自检警告 ${warned} 条（未写回；确认需要时加 --write）`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

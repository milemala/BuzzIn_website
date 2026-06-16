#!/usr/bin/env node
"use strict";

/**
 * 按需生成 Agent 读图用 JPEG（同尺寸 webp，默认 quality=60）。
 * 禁止批量转全帖 PNG；标到第几页再转第几页，或抓取时已双写 images-jpg/。
 *
 * 用法:
 *   node scripts/ensure-slide-review-jpg.js <笔记目录> --slide=03.webp
 *   node scripts/ensure-slide-review-jpg.js <笔记目录> --all
 */

const fs = require("fs");
const path = require("path");
const {
  DEFAULT_JPEG_QUALITY,
  ensureAllSlideReviewJpgs,
  ensureSlideReviewJpg,
} = require("../lib/ensure-slide-review-jpg");

function parseArgs(argv) {
  const opts = { quality: DEFAULT_JPEG_QUALITY, slide: "", all: false };
  let target = "";
  for (const arg of argv) {
    if (arg.startsWith("--slide=")) opts.slide = arg.slice("--slide=".length).trim();
    else if (arg === "--all") opts.all = true;
    else if (arg.startsWith("--quality=")) opts.quality = Number(arg.slice("--quality=".length)) || DEFAULT_JPEG_QUALITY;
    else if (!arg.startsWith("-")) target = arg;
  }
  return { target: path.resolve(target), ...opts };
}

async function main() {
  const { target, slide, all, quality } = parseArgs(process.argv.slice(2));
  if (!target || !fs.existsSync(target)) {
    console.error("用法: node scripts/ensure-slide-review-jpg.js <笔记目录> --slide=03.webp");
    console.error("      node scripts/ensure-slide-review-jpg.js <笔记目录> --all");
    process.exit(1);
  }
  if (!slide && !all) {
    console.error("须指定 --slide=XX.webp 或 --all");
    process.exit(1);
  }

  if (all) {
    const results = await ensureAllSlideReviewJpgs(target, { quality });
    const created = results.filter((r) => !r.skipped).length;
    console.log(`images-jpg/：${results.length} 张，新生成 ${created} 张（quality=${quality}）`);
    return;
  }

  const r = await ensureSlideReviewJpg(target, slide, { quality });
  console.log(
    r.skipped
      ? `已存在 ${path.relative(process.cwd(), r.jpgPath)}（${r.width}×${r.height}）`
      : `已生成 ${path.relative(process.cwd(), r.jpgPath)}（${r.width}×${r.height}，quality=${quality}）`,
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

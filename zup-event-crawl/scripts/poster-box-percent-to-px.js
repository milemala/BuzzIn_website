#!/usr/bin/env node
"use strict";

/**
 * Agent 问题清单 → posterBox 像素换算（纯算术，不猜海报位置）。
 *
 * 用法:
 *   node scripts/poster-box-percent-to-px.js <笔记目录> --slide=03.webp --left=60 --top=20 --width=35 --height=50
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const {
  posterBoxFromPercent,
  shouldSkipBySize,
} = require("../lib/poster-box-percent-to-px");

function parseArgs(argv) {
  const opts = { slide: "", left: NaN, top: NaN, width: NaN, height: NaN };
  let target = "";
  for (const arg of argv) {
    if (arg.startsWith("--slide=")) opts.slide = arg.slice("--slide=".length).trim();
    else if (arg.startsWith("--left=")) opts.left = Number(arg.slice("--left=".length));
    else if (arg.startsWith("--top=")) opts.top = Number(arg.slice("--top=".length));
    else if (arg.startsWith("--width=")) opts.width = Number(arg.slice("--width=".length));
    else if (arg.startsWith("--height=")) opts.height = Number(arg.slice("--height=".length));
    else if (!arg.startsWith("-")) target = arg;
  }
  return { target: path.resolve(target), ...opts };
}

async function main() {
  const { target, slide, left, top, width, height } = parseArgs(process.argv.slice(2));
  if (!target || !fs.existsSync(target) || !slide) {
    console.error(
      "用法: node scripts/poster-box-percent-to-px.js <笔记目录> --slide=03.webp --left=60 --top=20 --width=35 --height=50",
    );
    process.exit(1);
  }

  const imagePath = path.join(target, "images", slide);
  if (!fs.existsSync(imagePath)) {
    console.error(`找不到 ${imagePath}`);
    process.exit(1);
  }

  const meta = await sharp(imagePath).metadata();
  const posterBox = posterBoxFromPercent(
    { leftPct: left, topPct: top, widthPct: width, heightPct: height },
    slide,
    meta.width,
    meta.height,
  );
  const skipCheck = shouldSkipBySize(posterBox, meta.width, meta.height);

  console.log(JSON.stringify({ slideSize: { width: meta.width, height: meta.height }, posterBox }, null, 2));
  if (skipCheck.skip) {
    console.warn(`⚠ 尺寸建议 skip：${skipCheck.reasons.join("；")}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

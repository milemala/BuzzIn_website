#!/usr/bin/env node
"use strict";

/**
 * 生成 posters/ 总览图，用一张图低成本复核裁切质量。
 *
 * 用法：
 *   node scripts/create-poster-contact-sheet.js <笔记目录> [--out=文件名.png]
 */

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function makeLabel(text, width, height) {
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    <text x="8" y="22" font-family="Arial, sans-serif" font-size="18" fill="black">${escapeXml(text)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  const args = process.argv.slice(2);
  const noteArg = args.find((a) => !a.startsWith("-"));
  const noteDir = path.resolve(noteArg || "");
  const outArg = args.find((a) => a.startsWith("--out="));
  const outName = outArg ? outArg.slice("--out=".length) : "posters-contact-sheet.png";
  const posterDir = path.join(noteDir, "posters");

  if (!noteArg || !fs.existsSync(posterDir)) {
    console.error("用法: node scripts/create-poster-contact-sheet.js <笔记目录> [--out=文件名.png]");
    process.exit(1);
  }

  const files = fs
    .readdirSync(posterDir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .sort();
  if (!files.length) {
    console.error(`没有找到海报图: ${posterDir}`);
    process.exit(1);
  }

  const cellW = 220;
  const cellH = 300;
  const labelH = 32;
  const pad = 24;
  const cols = 4;
  const rows = Math.ceil(files.length / cols);
  const thumbs = [];

  for (const file of files) {
    const input = path.join(posterDir, file);
    const resized = await sharp(input)
      .resize({ width: cellW, height: cellH - labelH, fit: "inside", background: "#fff" })
      .png()
      .toBuffer();
    const meta = await sharp(resized).metadata();
    const label = await makeLabel(file, cellW, labelH);
    const thumb = await sharp({
      create: { width: cellW, height: cellH, channels: 3, background: "#ffffff" },
    })
      .composite([
        { input: resized, left: Math.round((cellW - meta.width) / 2), top: 0 },
        { input: label, left: 0, top: cellH - labelH },
      ])
      .png()
      .toBuffer();
    thumbs.push(thumb);
  }

  const outPath = path.join(noteDir, outName);
  await sharp({
    create: {
      width: cols * cellW + (cols + 1) * pad,
      height: rows * cellH + (rows + 1) * pad,
      channels: 3,
      background: "#eeeeee",
    },
  })
    .composite(
      thumbs.map((input, i) => ({
        input,
        left: pad + (i % cols) * (cellW + pad),
        top: pad + Math.floor(i / cols) * (cellH + pad),
      }))
    )
    .png()
    .toFile(outPath);

  console.log(`已生成 ${files.length} 张海报总览: ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

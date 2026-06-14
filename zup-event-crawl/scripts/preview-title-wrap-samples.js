#!/usr/bin/env node
"use strict";

/**
 * 预览新换行规则：英文整词 / ｜· 语义分段 / 最多 4 行省略
 *
 *   node scripts/preview-title-wrap-samples.js
 */

const fs = require("fs");
const path = require("path");
const { composeEventPosterImage, isPortraitPosterLayout } = require("../lib/event-image-compose");
const { readImageFile } = require("../lib/image-fetch");
const { layoutPosterText, buildTextLayerSvg, POSTER_SIDE_TEXT_LAYOUT, lineUnitsBudget } = require("../lib/xhs-text-cover-compose");
const sharp = require("sharp");

const root = path.join(__dirname, "..");

const SAMPLES = [
  { id: "01-english", title: "Laufey 林冰: A Matter of Time Tour 北京站" },
  { id: "02-pipe-dot", title: "暮色时刻 · 城市音乐会《爱乐之城》《天空之城》《我心永恒》｜约会打卡｜亲子游玩｜沉浸式｜" },
  { id: "03-long-pipe", title: "【二狗旗下】一支麦小剧场｜天河正佳广场每日脱口秀｜爆笑解压精品秀演出｜开心互动&约会推荐｜打卡精选" },
];

async function main() {
  const posterRel = "data/scrape-cache/xhs/西安/6a2670f50000000021015c86/posters/01_slot0.jpg";
  const posterAbs = path.join(root, posterRel);
  const { buffer: sourceBuffer } = readImageFile(posterAbs);
  const meta = await sharp(sourceBuffer).metadata();
  if (!isPortraitPosterLayout(meta.width, meta.height)) {
    throw new Error("请使用竖图 ≤4:5 的海报");
  }

  const outDir = path.join(root, "data", "scrape-cache", "xhs", "cover-preview", "title-wrap-samples");
  fs.mkdirSync(outDir, { recursive: true });

  const h = 900;
  const posterW = Math.round((meta.width / meta.height) * h);
  const rightW = 1200 - posterW;
  const padX = Math.round(rightW * POSTER_SIDE_TEXT_LAYOUT.padXRatio);
  const innerW = rightW - padX * 2;
  const maxUnits = Math.round(
    Math.min(
      POSTER_SIDE_TEXT_LAYOUT.maxLineChars,
      lineUnitsBudget(innerW, POSTER_SIDE_TEXT_LAYOUT.titleFontMin, 0.98) * 10,
    ) / 10,
  );

  console.log(`海报: ${posterRel}，右侧 innerW≈${innerW}px，每行约 ${maxUnits} 单位\n`);

  for (const sample of SAMPLES) {
    const { titleLines: lines } = layoutPosterText(sample.title, innerW, 0.98, 1.16, POSTER_SIDE_TEXT_LAYOUT);
    const { layout } = buildTextLayerSvg(rightW, h, sample.title, ["加入群聊", "一起组局"], "jiangcheng-lvdong-yuan", {
      fill: "#FFFFFF",
      padX,
      textShadow: true,
      ...POSTER_SIDE_TEXT_LAYOUT,
    });

    const outputPath = path.join(outDir, `${sample.id}.jpg`);
    const buffer = await composeEventPosterImage(sourceBuffer, { title: sample.title });
    fs.writeFileSync(outputPath, buffer);

    console.log(`[${sample.id}] ${sample.title}`);
    lines.forEach((line, index) => console.log(`  ${index + 1}. ${line}`));
    console.log(`  → 字号 ${layout.titleFontSize}px，${outputPath}\n`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

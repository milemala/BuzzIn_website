#!/usr/bin/env node
"use strict";

/**
 * 竖图分屏封面：不同标题长度 × 不同字号方案预览
 *
 *   node scripts/preview-poster-title-lengths.js
 *   node scripts/preview-poster-title-lengths.js --poster=data/scrape-cache/xhs/西安/.../posters/04_slot0.jpg
 */

const fs = require("fs");
const path = require("path");
const { composeEventPosterImage, isPortraitPosterLayout } = require("../lib/event-image-compose");
const { buildTextLayerSvg } = require("../lib/xhs-text-cover-compose");
const { readImageFile } = require("../lib/image-fetch");
const sharp = require("sharp");

const root = path.join(__dirname, "..");

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

const SAMPLES = [
  { id: "01-short", label: "短标题6字", title: "周末市集" },
  { id: "02-mid", label: "中标题10字", title: "三立方夏日草坪快闪市集" },
  { id: "03-midlong", label: "中长14字", title: "「百联之夜·苏河潮韵」非遗造物周" },
  { id: "04-long", label: "长标题18字", title: "「非·长」好物——文化和自然遗产生活集" },
  { id: "05-verylong", label: "超长24字", title: "2025成都国际非遗节暨非遗造物周沉浸式体验展览" },
];

const VARIANTS = [
  {
    id: "A-current",
    label: "当前规格",
    textLayerStyle: {},
  },
  {
    id: "B-large",
    label: "加大一档",
    textLayerStyle: {
      titleFontMax: 176,
      titleFontMin: 68,
      safeTopRatio: 0.24,
      safeBottomRatio: 0.87,
      titleBaselineFactor: 0.98,
      ctaGapScale: 0.82,
      ctaFontScale: 0.55,
    },
    padXRatio: 0.05,
  },
  {
    id: "C-xlarge",
    label: "加大两档",
    textLayerStyle: {
      titleFontMax: 192,
      titleFontMin: 72,
      safeTopRatio: 0.22,
      safeBottomRatio: 0.89,
      titleBaselineFactor: 0.92,
      ctaGapScale: 0.72,
      ctaFontScale: 0.52,
    },
    padXRatio: 0.04,
  },
];

async function estimateRightWidth(posterAbs) {
  const { buffer } = readImageFile(posterAbs);
  const meta = await sharp(buffer).metadata();
  const height = 900;
  const posterWidth = Math.round((meta.width || 1) / (meta.height || 1) * height);
  return Math.max(1200 - posterWidth, 0);
}

function measureTitleLayout(rightWidth, title, variant) {
  const padX = variant.padXRatio != null
    ? Math.round(rightWidth * variant.padXRatio)
    : Math.round(rightWidth * 0.08);
  const { layout } = buildTextLayerSvg(rightWidth, 900, title, ["加入群聊", "一起组局"], "jiangcheng-lvdong-yuan", {
    fill: "#FFFFFF",
    padX,
    textShadow: true,
    ...variant.textLayerStyle,
  });
  return layout;
}

async function assertSplitPoster(posterAbs) {
  const { buffer } = readImageFile(posterAbs);
  const meta = await sharp(buffer).metadata();
  const ratio = (meta.width || 1) / (meta.height || 1);
  if (!isPortraitPosterLayout(meta.width, meta.height)) {
    throw new Error(
      `海报 ${path.basename(posterAbs)} 宽高比 ${ratio.toFixed(3)} > 4:5，`
      + "会走居中版式、右侧无标题。请换 *_slot0.jpg 等更窄的竖图海报。",
    );
  }
  return buffer;
}

async function main() {
  const posterRel = readArg("poster")
    || "data/scrape-cache/xhs/西安/6a2670f50000000021015c86/posters/01_slot0.jpg";
  const posterAbs = path.isAbsolute(posterRel) ? posterRel : path.join(root, posterRel);
  if (!fs.existsSync(posterAbs)) {
    throw new Error(`海报不存在: ${posterAbs}`);
  }

  const outDir = path.join(root, "data", "scrape-cache", "xhs", "cover-preview", "poster-title-samples");
  fs.mkdirSync(outDir, { recursive: true });

  const sourceBuffer = await assertSplitPoster(posterAbs);
  const rightWidth = await estimateRightWidth(posterAbs);

  console.log(`海报: ${posterRel}`);
  console.log(`右侧文案区宽约 ${rightWidth}px\n`);

  const summaryLines = ["# 竖图分屏标题字号预览", "", `海报: \`${posterRel}\``, ""];

  for (const variant of VARIANTS) {
    summaryLines.push(`## ${variant.id} ${variant.label}`);
    summaryLines.push("");
    for (const sample of SAMPLES) {
      const style = { ...variant.textLayerStyle };
      if (variant.padXRatio != null) {
        style.padX = Math.round(rightWidth * variant.padXRatio);
      }
      const layout = measureTitleLayout(rightWidth, sample.title, variant);
      const fileName = `${variant.id}_${sample.id}.jpg`;
      const outputPath = path.join(outDir, fileName);
      const buffer = await composeEventPosterImage(sourceBuffer, {
        title: sample.title,
        textLayerStyle: style,
      });
      fs.writeFileSync(outputPath, buffer);
      summaryLines.push(
        `- **${sample.label}**（标题 ${sample.title.length} 字，字号 ${layout.titleFontSize}px，${layout.titleLines.length} 行）`
        + `\n  - 文件: \`${fileName}\``,
      );
      console.log(`${variant.id} ${sample.id}: 标题${layout.titleFontSize}px / CTA${layout.ctaFontSize}px / ${layout.titleLines.length}行 → ${fileName}`);
    }
    summaryLines.push("");
  }

  const readmePath = path.join(outDir, "README.md");
  fs.writeFileSync(readmePath, `${summaryLines.join("\n")}\n`);
  console.log(`\n预览目录: ${outDir}`);
  console.log(`说明: ${readmePath}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

#!/usr/bin/env node
"use strict";

/**
 * 批量预览各字体封面样张
 *
 *   node scripts/preview-xhs-text-cover-fonts.js
 *   node scripts/preview-xhs-text-cover-fonts.js --title="周末市集·手作体验"
 */

const path = require("path");
const {
  FONT_PRESETS,
  composeXhsTextCoverToFile,
} = require("../lib/xhs-text-cover-compose");

const root = path.join(__dirname, "..");

function readArg(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

async function main() {
  const title = readArg("title") || "周末市集·手作体验";
  const outDir = path.resolve(root, readArg("out-dir") || "data/scrape-cache/xhs/cover-preview/font-compare");
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 32);

  console.log(`标题: ${title}`);
  console.log(`输出目录: ${outDir}\n`);

  for (const preset of Object.values(FONT_PRESETS)) {
    const outputPath = path.join(outDir, `${safeTitle}-${preset.id}.jpg`);
    await composeXhsTextCoverToFile(title, outputPath, { font: preset.id });
    console.log(`✓ ${preset.label} (${preset.id})`);
    console.log(`  ${outputPath}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

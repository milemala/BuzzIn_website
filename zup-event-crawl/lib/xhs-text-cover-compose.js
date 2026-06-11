"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 900;
const DEFAULT_CTA_LINES = ["加入群聊", "一起组局"];
const DEFAULT_BACKGROUND = path.join(__dirname, "..", "data", "scrape-cache", "xhs", "background.jpg");

const FONT_STACK =
  "PingFang SC, -apple-system, BlinkMacSystemFont, SF Pro Display, SF Pro Text, Hiragino Sans GB, Helvetica Neue, sans-serif";

const TITLE_FILL = "#5C6773";
const CTA_FILL = "#F5F1E8";
const CTA_SHADOW_FILL = "#2F3842";
const TITLE_GLOW_FILL = "#FFFCF6";

const CTA_SHADOW_OFFSET = { x: 5, y: 7 };
const CTA_SHADOW_BLUR = 5.5;
const TITLE_GLOW_BLUR = 11;

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function balanceLines(lines) {
  if (lines.length < 2) return lines;
  const last = lines[lines.length - 1];
  if (last.length > 2) return lines;
  const prev = lines[lines.length - 2];
  if (prev.length <= 3) return lines;
  const move = last.length === 1 ? 1 : 2;
  return [
    ...lines.slice(0, -2),
    prev.slice(0, -move),
    prev.slice(-move) + last,
  ];
}

function wrapTitle(title, maxChars = 11) {
  const text = String(title || "").trim();
  if (!text) return [""];
  if (text.length <= maxChars) return [text];

  const lines = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = maxChars;
    const slice = rest.slice(0, maxChars + 1);
    const punct = Math.max(
      slice.lastIndexOf("，"),
      slice.lastIndexOf("、"),
      slice.lastIndexOf(" "),
      slice.lastIndexOf("—"),
      slice.lastIndexOf("-"),
    );
    if (punct > 3) cut = punct + 1;
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) lines.push(rest);
  return balanceLines(lines);
}

function estimateLineWidth(chars, fontSize) {
  return chars * fontSize * 0.94;
}

function verticalAnchorForTitleLines(lineCount) {
  if (lineCount <= 1) return 0.44;
  if (lineCount === 2) return 0.47;
  if (lineCount === 3) return 0.43;
  return 0.41;
}

function layoutPosterText(title, width, height, ctaLineCount = 2) {
  let best = {
    titleLines: [String(title || "").trim() || ""],
    titleFontSize: 80,
    ctaFontSize: 64,
    titleLineHeight: 100,
    ctaLineHeight: 82,
    gap: 40,
  };

  const plain = String(title || "").trim();
  for (let titleFontSize = 124; titleFontSize >= 58; titleFontSize -= 2) {
    let titleLines = plain.length <= 14 ? [plain] : null;
    const maxChars = Math.max(
      5,
      Math.min(14, Math.floor((width * 0.82) / (titleFontSize * 0.94))),
    );
    if (!titleLines) titleLines = wrapTitle(title, maxChars);
    if (estimateLineWidth(Math.max(...titleLines.map((l) => l.length)), titleFontSize) > width * 0.86) {
      titleLines = wrapTitle(title, maxChars);
    }

    const titleLineHeight = Math.round(titleFontSize * 1.24);
    const titleBlockH = titleLines.length * titleLineHeight;

    const ctaFontSize = Math.max(64, Math.round(titleFontSize * 0.72));
    const ctaLineHeight = Math.round(ctaFontSize * 1.3);
    const ctaBlockH = ctaLineCount * ctaLineHeight;

    const gap = Math.round(height * 0.065);
    const ctaExtraDown = Math.round(height * 0.028);
    const stackH = titleBlockH + gap + ctaExtraDown + ctaBlockH;
    const longest = Math.max(...titleLines.map((line) => line.length), 1);
    const totalW = estimateLineWidth(longest, titleFontSize);

    if (stackH <= height * 0.8 && totalW <= width * 0.88) {
      best = { titleLines, titleFontSize, ctaFontSize, titleLineHeight, ctaLineHeight, gap };
      break;
    }
  }

  return best;
}

function computeTextLayout(width, height, layout, ctaLines) {
  const {
    titleLines,
    titleFontSize,
    ctaFontSize,
    titleLineHeight,
    ctaLineHeight,
    gap,
  } = layout;

  const titleBlockH = titleLines.length * titleLineHeight;
  const ctaBlockH = ctaLines.length * ctaLineHeight;
  const ctaExtraDown = Math.round(height * 0.028);
  const stackH = titleBlockH + gap + ctaExtraDown + ctaBlockH;
  const anchorY = height * verticalAnchorForTitleLines(titleLines.length);
  const stackTop = Math.round(anchorY - stackH / 2);

  return {
    titleTextStartY: stackTop + Math.round(titleFontSize * 0.9),
    ctaTextStartY: stackTop + titleBlockH + gap + ctaExtraDown + Math.round(ctaFontSize * 0.9),
  };
}

function textTag({ x, y, fontSize, fontWeight, fill, letterSpacing, opacity = 1, line }) {
  return `<text x="${x}" y="${y}" text-anchor="middle" opacity="${opacity}"
        font-family="${FONT_STACK}" font-size="${fontSize}" font-weight="${fontWeight}"
        fill="${fill}" letter-spacing="${letterSpacing}">${escapeXml(line)}</text>`;
}

function buildLineElements({ lines, centerX, startY, lineHeight, fontSize, fontWeight, fill, letterSpacing }) {
  return lines
    .map((line, index) =>
      textTag({
        x: centerX,
        y: startY + index * lineHeight,
        fontSize,
        fontWeight,
        fill,
        letterSpacing,
        line,
      }),
    )
    .join("\n  ");
}

function buildTextBlocks(width, height, title, ctaLines) {
  const layout = layoutPosterText(title, width, height, ctaLines.length);
  const geo = computeTextLayout(width, height, layout, ctaLines);
  const {
    titleLines,
    titleFontSize,
    ctaFontSize,
    titleLineHeight,
    ctaLineHeight,
  } = layout;

  const titleMain = buildLineElements({
    lines: titleLines,
    centerX: width / 2,
    startY: geo.titleTextStartY,
    lineHeight: titleLineHeight,
    fontSize: titleFontSize,
    fontWeight: 700,
    fill: TITLE_FILL,
    letterSpacing: 0.5,
  });

  const titleGlow = buildLineElements({
    lines: titleLines,
    centerX: width / 2,
    startY: geo.titleTextStartY,
    lineHeight: titleLineHeight,
    fontSize: titleFontSize,
    fontWeight: 700,
    fill: TITLE_GLOW_FILL,
    letterSpacing: 0.5,
  });

  const ctaMain = buildLineElements({
    lines: ctaLines,
    centerX: width / 2,
    startY: geo.ctaTextStartY,
    lineHeight: ctaLineHeight,
    fontSize: ctaFontSize,
    fontWeight: 500,
    fill: CTA_FILL,
    letterSpacing: 4,
  });

  const ctaShadow = buildLineElements({
    lines: ctaLines,
    centerX: width / 2,
    startY: geo.ctaTextStartY,
    lineHeight: ctaLineHeight,
    fontSize: ctaFontSize,
    fontWeight: 500,
    fill: CTA_SHADOW_FILL,
    letterSpacing: 4,
  });

  const wrap = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  ${body}
</svg>`;

  return {
    layout,
    titleGlowSvg: Buffer.from(wrap(titleGlow)),
    ctaShadowSvg: Buffer.from(wrap(ctaShadow)),
    mainSvg: Buffer.from(wrap(`${titleMain}\n  ${ctaMain}`)),
  };
}

async function rasterizeSvg(svgBuffer, width, height) {
  return sharp(svgBuffer, { density: 144 })
    .resize(width, height)
    .ensureAlpha()
    .png()
    .toBuffer();
}

async function composeXhsTextCover(title, options = {}) {
  const width = options.width || DEFAULT_WIDTH;
  const height = options.height || DEFAULT_HEIGHT;
  const backgroundPath = options.backgroundPath || DEFAULT_BACKGROUND;
  const ctaLines = resolveCtaLines(options.ctaLines || options.text);
  const ctaShadowOffset = options.ctaShadowOffset || options.shadowOffset || CTA_SHADOW_OFFSET;
  const ctaShadowBlur = options.ctaShadowBlur ?? options.shadowBlur ?? CTA_SHADOW_BLUR;
  const titleGlowBlur = options.titleGlowBlur ?? TITLE_GLOW_BLUR;

  if (!fs.existsSync(backgroundPath)) {
    throw new Error(`背景图不存在: ${backgroundPath}`);
  }

  const { titleGlowSvg, ctaShadowSvg, mainSvg } = buildTextBlocks(width, height, title, ctaLines);

  const background = await sharp(backgroundPath)
    .resize(width, height, { fit: "cover", position: "centre" })
    .modulate({ brightness: 1.03, saturation: 0.9 })
    .toBuffer();

  const titleGlowLayer = await rasterizeSvg(titleGlowSvg, width, height);
  const blurredTitleGlow = await sharp(titleGlowLayer).blur(titleGlowBlur).png().toBuffer();
  const ctaShadowLayer = await rasterizeSvg(ctaShadowSvg, width, height);
  const blurredCtaShadow = await sharp(ctaShadowLayer).blur(ctaShadowBlur).png().toBuffer();
  const mainLayer = await rasterizeSvg(mainSvg, width, height);

  return sharp(background)
    .composite([
      { input: blurredTitleGlow, left: 0, top: 0, blend: "over" },
      { input: blurredCtaShadow, left: ctaShadowOffset.x, top: ctaShadowOffset.y, blend: "over" },
      { input: mainLayer, left: 0, top: 0, blend: "over" },
    ])
    .jpeg({ quality: 93, mozjpeg: true })
    .toBuffer();
}

function resolveCtaLines(text) {
  if (Array.isArray(text)) return text.map((line) => String(line).trim()).filter(Boolean);
  const raw = String(text || "").trim();
  if (!raw) return [...DEFAULT_CTA_LINES];
  if (raw.includes("\n")) return raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (/加入群聊/.test(raw) && /一起组局/.test(raw)) return ["加入群聊", "一起组局"];
  return [raw.replace(/[，,]/g, "")];
}

async function composeXhsTextCoverToFile(title, outputPath, options = {}) {
  const buffer = await composeXhsTextCover(title, options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

module.exports = {
  DEFAULT_BACKGROUND,
  DEFAULT_CTA_LINES,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  CTA_SHADOW_BLUR,
  CTA_SHADOW_OFFSET,
  TITLE_GLOW_BLUR,
  composeXhsTextCover,
  composeXhsTextCoverToFile,
  computeTextLayout,
  layoutPosterText,
  verticalAnchorForTitleLines,
  wrapTitle,
};

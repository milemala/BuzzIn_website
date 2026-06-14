"use strict";

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { Resvg } = require("@resvg/resvg-js");

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 900;
const DEFAULT_CTA_LINES = ["加入群聊", "一起组局"];

const COVER_BG_FALLBACK = path.join(__dirname, "..", "assets", "xhs-crayon-frame-bg.png");
const XHS_BACKGROUND_DIR = path.join(__dirname, "..", "data", "scrape-cache", "xhs");
const BACKGROUND_NAME_RE = /^background\d+\.(?:jpe?g|png|webp)$/i;
const FONTS_DIR = path.join(__dirname, "..", "assets", "fonts");

const COLOR_TEXT = "#1A2332";
const COLOR_TEXT_ON_DARK = "#FFFFFF";

/** 封面字体预设 */
const FONT_PRESETS = {
  "jiangcheng-lvdong-yuan": {
    id: "jiangcheng-lvdong-yuan",
    label: "江城律动圆",
    file: path.join(FONTS_DIR, "jiangcheng-lvdong-yuan.ttf"),
    family: "'JiangChengLvDongYuan', '江城律动圆', sans-serif",
    resvgFamily: "JiangChengLvDongYuan",
    widthFactor: 1.0,
    titleTilt: 0,
    titleLetterSpacing: -2,
  },
  "houzun-song": {
    id: "houzun-song",
    label: "猴尊宋体",
    file: path.join(
      __dirname,
      "..",
      "node_modules",
      "@fontpkg",
      "hou-zun-song-ti",
      "猴尊宋体.ttf",
    ),
    family: "'HouZunSongTi', '猴尊宋体', serif",
    resvgFamily: "HouZunSongTi",
    widthFactor: 1.02,
    titleTilt: -1.5,
  },
  "source-han-sans-heavy": {
    id: "source-han-sans-heavy",
    label: "思源黑体特粗",
    file: path.join(
      __dirname,
      "..",
      "node_modules",
      "@fontsource",
      "noto-sans-sc",
      "files",
      "noto-sans-sc-chinese-simplified-900-normal.woff",
    ),
    family: "'Noto Sans SC', 'Source Han Sans SC', sans-serif",
    resvgFamily: "Noto Sans SC",
    fontWeight: 900,
    widthFactor: 0.96,
    titleTilt: 0,
  },
  "zcool-kuaile": {
    id: "zcool-kuaile",
    label: "站酷快乐体",
    file: path.join(
      __dirname,
      "..",
      "node_modules",
      "@fontsource",
      "zcool-kuaile",
      "files",
      "zcool-kuaile-chinese-simplified-400-normal.woff",
    ),
    family: "'ZCOOL KuaiLe', Yuanti SC, YouYuan, PingFang SC, sans-serif",
    resvgFamily: "ZCOOL KuaiLe",
    widthFactor: 0.98,
    titleTilt: -1.5,
  },
};

const DEFAULT_FONT_PRESET = "jiangcheng-lvdong-yuan";

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function resolveFontPreset(font) {
  if (!font) return FONT_PRESETS[DEFAULT_FONT_PRESET];
  if (typeof font === "object" && font.file) return font;
  const key = String(font).trim();
  if (FONT_PRESETS[key]) return FONT_PRESETS[key];
  throw new Error(`未知封面字体: ${key}，可选: ${Object.keys(FONT_PRESETS).join(", ")}`);
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

function rebalanceTwoLines(lines, maxChars) {
  if (lines.length !== 2) return lines;
  const [a, b] = lines;
  const total = a + b;
  if (total.length <= maxChars) return [total];

  const ratio = Math.max(a.length, b.length) / Math.min(a.length, b.length);
  if (ratio < 1.65 && b.length > 2) return lines;

  const mid = Math.ceil(total.length / 2);
  const punct = ["·", "、", "，", " ", "—", "-"];
  let bestCut = mid;
  let bestScore = Infinity;
  for (let cut = Math.max(2, mid - 2); cut <= Math.min(total.length - 2, mid + 2); cut++) {
    const left = total.slice(0, cut);
    const right = total.slice(cut);
    if (left.length > maxChars || right.length > maxChars) continue;
    let score = Math.abs(left.length - right.length);
    if (punct.includes(total[cut - 1]) || punct.includes(total[cut])) score -= 1.5;
    if (score < bestScore) {
      bestScore = score;
      bestCut = cut;
    }
  }
  const left = total.slice(0, bestCut).replace(/[·、，—-]+$/, "");
  const right = total.slice(bestCut).replace(/^[·、，—-\s]+/, "");
  if (!left || !right) return lines;
  if (left.length > maxChars || right.length > maxChars) return lines;
  return [left, right];
}

function splitBeforeKeyword(text, maxChars) {
  const keywords = ["啤酒节", "音乐节", "嘉年华", "市集", "体验", "快闪", "沙龙", "派对", "展览"];
  for (const word of keywords) {
    const idx = text.indexOf(word);
    if (idx > 0 && idx <= maxChars && text.length - idx <= maxChars) {
      return [text.slice(0, idx), text.slice(idx)];
    }
  }
  return null;
}

function splitEvenly(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const byKeyword = splitBeforeKeyword(text, maxChars);
  if (byKeyword) return byKeyword;

  const mid = Math.ceil(text.length / 2);
  let bestCut = mid;
  let bestScore = Infinity;
  for (let cut = 2; cut <= text.length - 2; cut++) {
    const left = text.slice(0, cut);
    const right = text.slice(cut);
    if (left.length > maxChars || right.length > maxChars) continue;
    let score = Math.abs(left.length - right.length);
    if (left.length < 3 || right.length < 3) score += 4;
    if (score < bestScore) {
      bestScore = score;
      bestCut = cut;
    }
  }
  return [text.slice(0, bestCut), text.slice(bestCut)];
}

function wrapTitle(title, maxChars = 11) {
  const text = String(title || "").trim();
  if (!text) return [""];
  if (text.length <= maxChars) return [text];

  const dash = text.includes("——") ? "——" : (text.includes("—") ? "—" : "");
  if (dash) {
    const dashIdx = text.indexOf(dash);
    const before = text.slice(0, dashIdx);
    const after = text.slice(dashIdx + dash.length);
    if (after && after.length <= maxChars) {
      const headLines = before.length <= maxChars
        ? [before]
        : splitEvenly(before, maxChars);
      if (headLines.every((line) => line.length <= maxChars)) {
        const lines = [...headLines];
        lines[lines.length - 1] += dash;
        lines.push(after);
        return lines;
      }
    }
  }

  if (text.includes("·")) {
    const parts = text.split("·").map((part) => part.trim()).filter(Boolean);
    if (parts.length === 2) {
      const [head, tail] = parts;
      if (head.length <= maxChars && tail.length <= maxChars) {
        return [head, tail];
      }
    }
  }

  const lines = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = maxChars;
    const slice = rest.slice(0, maxChars + 1);
    const punct = Math.max(
      slice.lastIndexOf("，"),
      slice.lastIndexOf("、"),
      slice.lastIndexOf("·"),
      slice.lastIndexOf(" "),
      slice.lastIndexOf("—"),
      slice.lastIndexOf("-"),
    );
    if (punct > 3) cut = punct + 1;
    lines.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) lines.push(rest);
  const balanced = balanceLines(lines);
  return rebalanceTwoLines(balanced, maxChars);
}

function estimateLineWidth(chars, fontSize, widthFactor = 0.98) {
  return chars * fontSize * widthFactor;
}

function layoutPosterText(title, innerWidth, widthFactor = 0.98, lineHeightFactor = 1.16) {
  const plain = String(title || "").trim() || "活动";
  let best = {
    titleLines: [plain],
    titleFontSize: 96,
    titleLineHeight: 112,
    titleBlockH: 112,
  };

  for (let titleFontSize = 140; titleFontSize >= 56; titleFontSize -= 2) {
    const maxChars = Math.max(
      4,
      Math.min(11, Math.floor(innerWidth / (titleFontSize * widthFactor))),
    );
    const titleLines = plain.length <= maxChars ? [plain] : wrapTitle(title, maxChars);
    const longest = Math.max(...titleLines.map((line) => line.length), 1);
    const totalW = estimateLineWidth(longest, titleFontSize, widthFactor);
    const titleLineHeight = Math.round(titleFontSize * lineHeightFactor);
    const titleBlockH = titleLines.length * titleLineHeight;

    if (totalW <= innerWidth * 0.96 && titleBlockH <= innerWidth * 0.78) {
      best = { titleLines, titleFontSize, titleLineHeight, titleBlockH };
      break;
    }
  }

  return best;
}

/** 按两行标题场景计算 CTA 字号，三行标题时保持不变 */
function computeReferenceCtaLayout(width, height, innerW, widthFactor, ctaLineCount) {
  const safeTop = Math.round(height * 0.2);
  const safeBottom = Math.round(height * 0.82);
  const ctaGap = Math.round(height * 0.065);

  for (let titleFontSize = 140; titleFontSize >= 56; titleFontSize -= 2) {
    const titleLineHeight = Math.round(titleFontSize * 1.16);
    const titleBlockH = 2 * titleLineHeight;
    const ctaFontSize = Math.max(54, Math.round(titleFontSize * 0.58));
    const ctaLineHeight = Math.round(ctaFontSize * 1.38);
    const titleStartY = safeTop + Math.round(titleFontSize * 0.88);
    const ctaStartY = titleStartY + titleBlockH + ctaGap + ctaFontSize;
    const ctaEnd = ctaStartY + (ctaLineCount - 1) * ctaLineHeight;
    if (ctaEnd <= safeBottom) {
      return { ctaFontSize, ctaLineHeight, ctaGap };
    }
  }

  return {
    ctaFontSize: 54,
    ctaLineHeight: Math.round(54 * 1.38),
    ctaGap,
  };
}

function maxTitleFontSizeForLines({
  titleLines,
  innerW,
  widthFactor,
  lineHeightFactor,
  safeTop,
  safeBottom,
  ctaGap,
  ctaFontSize,
  ctaLineHeight,
  ctaLineCount,
}) {
  let best = 56;
  for (let titleFontSize = 140; titleFontSize >= 56; titleFontSize -= 2) {
    const longest = Math.max(...titleLines.map((line) => line.length), 1);
    const totalW = estimateLineWidth(longest, titleFontSize, widthFactor);
    if (totalW > innerW * 0.96) continue;

    const titleLineHeight = Math.round(titleFontSize * lineHeightFactor);
    const titleBlockH = titleLines.length * titleLineHeight;
    const titleStartY = safeTop + Math.round(titleFontSize * 0.88);
    const ctaStartY = titleStartY + titleBlockH + ctaGap + ctaFontSize;
    const ctaEnd = ctaStartY + (ctaLineCount - 1) * ctaLineHeight;
    if (ctaEnd <= safeBottom) {
      best = titleFontSize;
      break;
    }
  }
  return best;
}

function plainText({ x, y, fontSize, line, fontPreset, letterSpacing = 0, fill = COLOR_TEXT, filter }) {
  const weight = fontPreset.fontWeight || 400;
  const filterAttr = filter ? ` filter="${filter}"` : "";
  return `<text x="${x}" y="${y}"
    font-family="${fontPreset.family}" font-size="${fontSize}" font-weight="${weight}"
    letter-spacing="${letterSpacing}" text-anchor="middle"
    fill="${fill}" stroke="none"${filterAttr}>${escapeXml(line)}</text>`;
}

function buildTextLayerSvg(width, height, title, ctaLines, fontPreset, styleOptions = {}) {
  const preset = resolveFontPreset(fontPreset);
  const fill = styleOptions.fill || COLOR_TEXT;
  const textFilter = styleOptions.textShadow ? "textShadow" : null;
  const padX = styleOptions.padX ?? Math.round(width * 0.12);
  const innerW = width - padX * 2;
  const centerX = width / 2;
  const safeTop = Math.round(height * 0.2);
  const safeBottom = Math.round(height * 0.82);

  const refCta = computeReferenceCtaLayout(width, height, innerW, preset.widthFactor, ctaLines.length);
  const ctaFontSize = refCta.ctaFontSize;
  const ctaLineHeight = refCta.ctaLineHeight;

  const titleLineHeightFactor = 1.16;
  let { titleLines, titleFontSize } = layoutPosterText(
    title,
    innerW,
    preset.widthFactor,
    titleLineHeightFactor,
  );

  const isThreeLineTitle = titleLines.length >= 3;
  const titleLineHeightFactorFinal = isThreeLineTitle ? 1.08 : 1.16;
  const ctaGap = isThreeLineTitle
    ? Math.round(refCta.ctaGap * 0.68)
    : refCta.ctaGap;
  const layoutSafeBottom = isThreeLineTitle ? Math.round(height * 0.835) : safeBottom;

  titleFontSize = maxTitleFontSizeForLines({
    titleLines,
    innerW,
    widthFactor: preset.widthFactor,
    lineHeightFactor: titleLineHeightFactorFinal,
    safeTop,
    safeBottom: layoutSafeBottom,
    ctaGap,
    ctaFontSize,
    ctaLineHeight,
    ctaLineCount: ctaLines.length,
  });

  let titleLineHeight = Math.round(titleFontSize * titleLineHeightFactorFinal);
  let titleBlockH = titleLines.length * titleLineHeight;
  let titleStartY = safeTop + Math.round(titleFontSize * 0.88);
  let ctaStartY = titleStartY + titleBlockH + ctaGap + ctaFontSize;

  const titlePivotY = titleStartY + (titleBlockH - titleLineHeight) / 2;
  const tilt = preset.titleTilt || 0;

  const titleSvg = titleLines
    .map((line, index) => {
      const y = titleStartY + index * titleLineHeight;
      const spacing = preset.titleLetterSpacing ?? (titleLines.length === 2 ? 0 : 1);
      return plainText({
        x: centerX,
        y,
        fontSize: titleFontSize,
        line,
        fontPreset: preset,
        letterSpacing: spacing,
        fill,
        filter: textFilter,
      });
    })
    .join("\n    ");

  const ctaSvg = ctaLines
    .map((line, index) => {
      const y = ctaStartY + index * ctaLineHeight;
      return plainText({
        x: centerX,
        y,
        fontSize: ctaFontSize,
        line,
        fontPreset: preset,
        letterSpacing: 2,
        fill,
        filter: textFilter,
      });
    })
    .join("\n    ");

  const titleGroup = tilt
    ? `<g transform="translate(${centerX} ${titlePivotY}) rotate(${tilt}) translate(${-centerX} ${-titlePivotY})">
    ${titleSvg}
  </g>`
    : titleSvg;

  const shadowDefs = textFilter
    ? `<defs>
    <filter id="textShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="5" flood-color="rgba(0,0,0,0.42)"/>
    </filter>
  </defs>`
    : "";

  return {
    svg: `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  ${shadowDefs}
  <rect width="${width}" height="${height}" fill="none"/>
  ${titleGroup}
  ${ctaSvg}
</svg>`,
    layout: { titleLines, titleFontSize, ctaFontSize, fontPreset: preset.id },
  };
}

/** 海报合成右侧窄条：白字 + 阴影，与无海报文字封面同一套排版 */
function buildPosterSideTextLayerSvg(width, height, title, ctaLines, fontPreset) {
  return buildTextLayerSvg(width, height, title, ctaLines, fontPreset, {
    fill: COLOR_TEXT_ON_DARK,
    padX: Math.round(width * 0.08),
    textShadow: true,
  });
}

async function loadCoverBackground(width, height, backgroundPath) {
  const bgPath = backgroundPath || COVER_BG_FALLBACK;
  if (!fs.existsSync(bgPath)) {
    throw new Error(`封面背景图不存在: ${bgPath}`);
  }
  return sharp(bgPath)
    .resize(width, height, { fit: "cover", position: "centre" })
    .modulate({ brightness: 1.01, saturation: 1.03 })
    .toBuffer();
}

function listXhsCoverBackgrounds(dir = XHS_BACKGROUND_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => BACKGROUND_NAME_RE.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(dir, name));
}

/** 随机选取 xhs 目录下的 background1~N 底图；可用 options.backgroundPath 指定 */
function resolveCoverBackgroundPath(options = {}) {
  if (options.backgroundPath) return options.backgroundPath;

  const backgrounds = listXhsCoverBackgrounds(
    options.backgroundDir || XHS_BACKGROUND_DIR,
  );
  if (!backgrounds.length) return COVER_BG_FALLBACK;

  if (typeof options.backgroundIndex === "number") {
    const index = ((options.backgroundIndex % backgrounds.length) + backgrounds.length) % backgrounds.length;
    return backgrounds[index];
  }

  return backgrounds[Math.floor(Math.random() * backgrounds.length)];
}

async function rasterizeTextSvg(svgBuffer, width, height, fontPreset) {
  const preset = resolveFontPreset(fontPreset);
  if (!fs.existsSync(preset.file)) {
    throw new Error(`封面字体缺失: ${preset.file}（${preset.label}，请执行 npm install 或检查 assets/fonts）`);
  }
  const resvg = new Resvg(svgBuffer.toString("utf8"), {
    fitTo: { mode: "width", value: width },
    font: {
      fontFiles: [preset.file],
      defaultFontFamily: preset.resvgFamily,
      loadSystemFonts: true,
    },
  });
  const png = resvg.render().asPng();
  if (!png.length) throw new Error("文字层渲染失败");
  return sharp(png).resize(width, height).ensureAlpha().png().toBuffer();
}

async function composeXhsTextCover(title, options = {}) {
  const width = options.width || DEFAULT_WIDTH;
  const height = options.height || DEFAULT_HEIGHT;
  const ctaLines = resolveCtaLines(options.ctaLines || options.text);
  const fontPreset = resolveFontPreset(options.font || options.fontPreset || DEFAULT_FONT_PRESET);
  const backgroundPath = resolveCoverBackgroundPath(options);

  const background = await loadCoverBackground(width, height, backgroundPath);
  const { svg } = buildTextLayerSvg(width, height, title, ctaLines, fontPreset);
  const textLayer = await rasterizeTextSvg(Buffer.from(svg), width, height, fontPreset);

  const buffer = await sharp(background)
    .composite([{ input: textLayer, left: 0, top: 0, blend: "over" }])
    .jpeg({ quality: 93, mozjpeg: true })
    .toBuffer();

  return { buffer, backgroundPath };
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
  const { buffer, backgroundPath } = await composeXhsTextCover(title, options);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buffer);
  return { outputPath, backgroundPath };
}

const DEFAULT_BACKGROUND = XHS_BACKGROUND_DIR;

module.exports = {
  DEFAULT_BACKGROUND,
  DEFAULT_FONT_PRESET,
  COVER_BG_FALLBACK,
  XHS_BACKGROUND_DIR,
  DEFAULT_CTA_LINES,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  FONT_PRESETS,
  COLOR_TEXT,
  COLOR_TEXT_ON_DARK,
  composeXhsTextCover,
  composeXhsTextCoverToFile,
  layoutPosterText,
  wrapTitle,
  buildTextLayerSvg,
  buildPosterSideTextLayerSvg,
  rasterizeTextSvg,
  resolveCtaLines,
  resolveFontPreset,
  listXhsCoverBackgrounds,
  resolveCoverBackgroundPath,
};

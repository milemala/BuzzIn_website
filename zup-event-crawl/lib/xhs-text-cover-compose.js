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

/** 标题区距顶比例（原 0.2 偏上，略加大留白） */
const LAYOUT_SAFE_TOP_RATIO = 0.30;
/** 首行标题 baseline 相对 safeTop 的下移量（× 字号） */
const TITLE_BASELINE_OFFSET_FACTOR = 1.12;
/** 江城律动圆缺 U+00B7，统一为字体内已有的 U+30FB，避免 Resvg 回退系统字体 */
const COVER_MIDDLE_DOT = "\u30FB";

/** 竖图分屏海报右侧文案排版（加大两档 xlarge） */
const POSTER_SIDE_TEXT_LAYOUT = {
  padXRatio: 0.04,
  titleFontMax: 192,
  titleFontMin: 72,
  maxLineChars: 14,
  maxTitleLines: 4,
  safeTopRatio: 0.22,
  safeBottomRatio: 0.89,
  titleBaselineFactor: 0.92,
  ctaGapScale: 0.72,
  ctaFontScale: 0.52,
};

const MAX_TITLE_LINES_DEFAULT = 4;
const TITLE_ELLIPSIS = "…";

function normalizeCoverFontText(text) {
  return String(text || "")
    .replace(/\u00B7/g, COVER_MIDDLE_DOT)
    .trim();
}

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

function balanceLines(lines, maxUnits) {
  if (lines.length < 2) return lines;
  const last = lines[lines.length - 1];
  const prev = lines[lines.length - 2];
  if (last.length <= 2 && prev.length > 2) {
    const merged = prev + last;
    if (!maxUnits || fitsLine(merged, maxUnits)) {
      return [...lines.slice(0, -2), merged];
    }
  }
  return lines;
}

function isOrphanLine(line) {
  const text = String(line || "").trim();
  if (!text) return true;
  if (text.length === 1) return true;
  if (/^[-—–·・|｜]$/.test(text)) return true;
  if (/^《[^》]+》$/.test(text) && text.length <= 6) return true;
  return false;
}

function polishTitleLines(lines, maxUnits) {
  let polished = lines.map((line) => String(line || "").trim()).filter(Boolean);
  if (!polished.length) return polished;

  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    const next = [];

    for (let i = 0; i < polished.length; i += 1) {
      const line = polished[i];
      if (isOrphanLine(line) && next.length) {
        const merged = joinTitleTokens(next[next.length - 1], line);
        if (!maxUnits || fitsLine(merged, maxUnits)) {
          next[next.length - 1] = merged;
          changed = true;
          continue;
        }
      }
      if (isOrphanLine(line) && i + 1 < polished.length) {
        const merged = joinTitleTokens(line, polished[i + 1]);
        if (!maxUnits || fitsLine(merged, maxUnits)) {
          next.push(merged);
          i += 1;
          changed = true;
          continue;
        }
      }
      next.push(line);
    }

    polished = next;
    if (!changed) break;
  }

  return balanceLines(polished, maxUnits);
}

function splitLongTokenBalanced(text, maxUnits, maxLineBudget) {
  const raw = String(text || "");
  if (!raw) return [];
  if (fitsLine(raw, maxUnits)) return [raw];

  const yearCjk = raw.match(/^([0-9]{4})([\u4e00-\u9fff].+)$/u);
  if (yearCjk) {
    const first = `${yearCjk[1]}${yearCjk[2].slice(0, 2)}`;
    const second = yearCjk[2].slice(2);
    if (second && fitsLine(first, maxUnits) && fitsLine(second, maxUnits)) {
      return [first, second];
    }
  }

  const chars = [...raw];
  const n = chars.length;
  let lineCount = Math.min(
    Math.max(1, maxLineBudget),
    Math.ceil(estimateLineUnits(raw) / maxUnits),
  );
  lineCount = Math.max(2, Math.min(lineCount, n));

  const sizes = Array(lineCount).fill(0);
  const base = Math.floor(n / lineCount);
  let extra = n % lineCount;
  if (lineCount === 2 && extra === 0 && n >= 6) {
    if (n >= 12 && n % 2 === 0) {
      sizes[0] = n / 2;
      sizes[1] = n / 2;
    } else {
      sizes[0] = (n / 2) + 1;
      sizes[1] = (n / 2) - 1;
    }
  } else if (lineCount === 2 && extra === 1) {
    sizes[0] = base;
    sizes[1] = base + 1;
  } else {
    for (let i = 0; i < lineCount; i += 1) {
      sizes[i] = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra -= 1;
    }
  }
  if (sizes[lineCount - 1] === 1 && lineCount > 1) {
    sizes[lineCount - 2] += 1;
    sizes[lineCount - 1] -= 1;
  }

  const chunks = [];
  let idx = 0;
  for (const size of sizes) {
    if (idx >= n) break;
    let chunk = chars.slice(idx, idx + size).join("");
    idx += size;
    while (chunk && estimateLineUnits(chunk) > maxUnits) {
      const sliced = sliceByUnits(chunk, maxUnits);
      if (sliced.head) chunks.push(sliced.head);
      chunk = sliced.tail;
    }
    if (chunk) chunks.push(chunk);
  }
  if (idx < n) {
    const tail = chars.slice(idx).join("");
    if (chunks.length && fitsLine(joinTitleTokens(chunks[chunks.length - 1], tail), maxUnits)) {
      chunks[chunks.length - 1] = joinTitleTokens(chunks[chunks.length - 1], tail);
    } else if (tail) chunks.push(tail);
  }
  return chunks;
}

const LINE_UNIT = {
  latin: 0.55,
  space: 0.28,
  cjk: 1,
  punct: 0.72,
};

function estimateCharUnit(ch) {
  if (/\s/u.test(ch)) return LINE_UNIT.space;
  if (/[A-Za-z0-9]/u.test(ch)) return LINE_UNIT.latin;
  if (/[\u4e00-\u9fff]/u.test(ch)) return LINE_UNIT.cjk;
  return LINE_UNIT.punct;
}

function estimateLineUnits(text) {
  let units = 0;
  for (const ch of String(text || "")) units += estimateCharUnit(ch);
  return units;
}

function fitsLine(text, maxUnits) {
  return estimateLineUnits(text) <= maxUnits + 1e-6;
}

function sliceByUnits(text, maxUnits) {
  const s = String(text || "");
  let units = 0;
  let i = 0;
  for (; i < s.length; i += 1) {
    const next = units + estimateCharUnit(s[i]);
    if (next > maxUnits + 1e-6) break;
    units = next;
  }
  if (i === 0 && s.length) return { head: s.slice(0, 1), tail: s.slice(1) };
  return { head: s.slice(0, i), tail: s.slice(i) };
}

function lineUnitsBudget(innerWidth, fontSize, widthFactor = 0.98) {
  return (innerWidth * 0.96) / (fontSize * widthFactor);
}

function trimWithEllipsis(text, maxUnits) {
  const raw = String(text || "").trim();
  if (fitsLine(raw, maxUnits)) return raw;
  const ellipsisUnits = estimateLineUnits(TITLE_ELLIPSIS);
  const budget = Math.max(ellipsisUnits + 0.5, maxUnits - ellipsisUnits);
  let head = sliceByUnits(raw, budget).head.replace(/\s+$/u, "");
  if (!head) head = raw.slice(0, 1);
  return `${head}${TITLE_ELLIPSIS}`;
}

function capTitleLines(lines, maxLines, maxUnits, tailJoiner = "") {
  const cleaned = lines.map((line) => String(line || "").trim()).filter(Boolean);
  if (cleaned.length <= maxLines) return cleaned;
  const head = cleaned.slice(0, maxLines - 1);
  const tail = cleaned.slice(maxLines - 1).join(tailJoiner);
  head.push(trimWithEllipsis(tail, maxUnits));
  return head;
}

/** 拆成可换行 token：英文整词、书名号整体、中文词组、标点 */
function tokenizeMixedText(text) {
  const tokens = [];
  const s = String(text || "").trim();
  let i = 0;
  while (i < s.length) {
    if (s[i] === " ") {
      i += 1;
      continue;
    }
    if (s[i] === "【") {
      const end = s.indexOf("】", i + 1);
      if (end !== -1) {
        tokens.push(s.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    if (s[i] === "《") {
      const end = s.indexOf("》", i + 1);
      if (end !== -1) {
        tokens.push(s.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    if (/[A-Za-z0-9]/.test(s[i])) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9'']/.test(s[j])) j += 1;
      const word = s.slice(i, j);
      if (/^[0-9]+$/.test(word)) {
        let j2 = j;
        while (j2 < s.length && /[\u4e00-\u9fff]/.test(s[j2])) j2 += 1;
        if (j2 > j) {
          tokens.push(s.slice(i, j2));
          i = j2;
          continue;
        }
      }
      tokens.push(word);
      i = j;
      continue;
    }
    if (/[\u4e00-\u9fff]/.test(s[i])) {
      let j = i + 1;
      while (j < s.length && /[\u4e00-\u9fff]/.test(s[j])) j += 1;
      tokens.push(s.slice(i, j));
      i = j;
      continue;
    }
    if (/[-—–]/.test(s[i]) && i + 1 < s.length && /[\u4e00-\u9fff]/.test(s[i + 1])) {
      let j = i + 1;
      while (j < s.length && /[\u4e00-\u9fff]/.test(s[j])) j += 1;
      tokens.push(s.slice(i, j));
      i = j;
      continue;
    }
    tokens.push(s[i]);
    i += 1;
  }
  return tokens.filter(Boolean);
}

function joinTitleTokens(line, token) {
  if (!line) return token;
  if (token === ":" || token === "：") return `${line}${token}`;
  if (/^[,.;:!?，。！？、]/.test(token)) return `${line}${token}`;

  const needSpace =
    (/[A-Za-z0-9]$/.test(line) && /^[A-Za-z0-9]/.test(token))
    || (/[A-Za-z0-9]$/.test(line) && /^[\u4e00-\u9fff]/.test(token))
    || (/[\u4e00-\u9fff]$/.test(line) && /^[A-Za-z0-9]/.test(token))
    || (/[:：]$/.test(line) && /^[A-Za-z0-9]/.test(token));

  return needSpace ? `${line} ${token}` : `${line}${token}`;
}

function joinTitleTokenList(tokens, start = 0) {
  let out = "";
  for (let i = start; i < tokens.length; i += 1) {
    out = joinTitleTokens(out, tokens[i]);
  }
  return out;
}

function packTokensIntoLines(tokens, maxUnits, maxLines, options = {}) {
  const allowEllipsis = options.allowEllipsis !== false;
  const lines = [];
  let line = "";
  let overflow = "";

  const finish = () => {
    if (line) lines.push(line);
    line = "";
  };

  for (let index = 0; index < tokens.length; index += 1) {
    let rest = tokens[index];

    while (rest) {
      const next = joinTitleTokens(line, rest);
      if (fitsLine(next, maxUnits)) {
        line = next;
        rest = "";
        break;
      }

      if (line) {
        finish();
        if (lines.length >= maxLines) {
          overflow = joinTitleTokenList(tokens, index);
          return { lines: lines.slice(0, maxLines), overflow };
        }
        continue;
      }

      if (lines.length >= maxLines - 1) {
        const tail = joinTitleTokenList(tokens, index);
        if (allowEllipsis) {
          finish();
          lines.push(trimWithEllipsis(tail, maxUnits));
          return { lines: lines.slice(0, maxLines), overflow: "" };
        }
        overflow = tail;
        return { lines: lines.slice(0, maxLines), overflow };
      }

      const linesLeft = maxLines - lines.length;
      const shouldBalance = !/[《》]/.test(rest)
        && /[\u4e00-\u9fff0-9【】]/.test(rest)
        && rest.length > 3;
      if (shouldBalance) {
        const chunks = splitLongTokenBalanced(rest, maxUnits, linesLeft);
        for (const chunk of chunks) {
          if (lines.length >= maxLines) {
            overflow = joinTitleTokens(overflow, chunk);
            continue;
          }
          lines.push(chunk);
        }
        rest = "";
        break;
      }

      const chunk = sliceByUnits(rest, maxUnits);
      lines.push(chunk.head);
      rest = chunk.tail;
    }

    if (lines.length >= maxLines) {
      overflow = joinTitleTokenList(tokens, index + 1);
      return { lines: lines.slice(0, maxLines), overflow };
    }
  }

  finish();
  return { lines: lines.slice(0, maxLines), overflow };
}

function packTokensIntoLinesSimple(tokens, maxUnits, maxLines, options = {}) {
  return packTokensIntoLines(tokens, maxUnits, maxLines, options).lines;
}

function wrapTitleBlock(text, maxUnits, maxLines, allowEllipsis = true) {
  const normalized = normalizeCoverFontText(text);
  if (!normalized) return { lines: [""], overflow: "" };
  if (fitsLine(normalized, maxUnits)) return { lines: [normalized], overflow: "" };

  const dashParts = normalized.split(/[-—–]/u).map((s) => s.trim()).filter(Boolean);
  if (dashParts.length >= 2 && dashParts.every((part) => /[\u4e00-\u9fff]/.test(part))) {
    return wrapDashParts(dashParts, maxUnits, maxLines, allowEllipsis);
  }

  const dotParts = normalized.split(/\s*[·・]\s*/u).map((s) => s.trim()).filter(Boolean);
  if (dotParts.length >= 2) {
    return wrapDotParts(dotParts, maxUnits, maxLines, allowEllipsis);
  }

  const packed = packTokensIntoLines(
    tokenizeMixedText(normalized),
    maxUnits,
    maxLines,
    { allowEllipsis },
  );
  if (packed.overflow && allowEllipsis && packed.lines.length) {
    const lines = [...packed.lines];
    lines[lines.length - 1] = trimWithEllipsis(
      joinTitleTokens(lines[lines.length - 1], packed.overflow),
      maxUnits,
    );
    return { lines, overflow: "" };
  }
  return packed;
}

function wrapDashParts(parts, maxUnits, maxLines, allowEllipsis = true) {
  const lines = [];
  let current = "";
  let overflow = "";

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const sep = current ? "-" : "";
    const merged = `${current}${sep}${part}`;
    const remainingParts = parts.length - i - 1;
    let linesLeft = maxLines - lines.length;

    if (fitsLine(merged, maxUnits)) {
      current = merged;
      continue;
    }

    if (current) {
      lines.push(current);
      current = "";
      linesLeft = maxLines - lines.length;
    }

    if (lines.length >= maxLines) {
      overflow = [part, ...parts.slice(i + 1)].join("-");
      return { lines: lines.slice(0, maxLines), overflow };
    }

    if (fitsLine(part, maxUnits)) {
      current = part;
    } else if (/[《》]/.test(part)) {
      const packed = packTokensIntoLines(
        tokenizeMixedText(part),
        maxUnits,
        linesLeft,
        { allowEllipsis: allowEllipsis && remainingParts === 0 },
      );
      if (packed.overflow) {
        overflow = packed.overflow;
        lines.push(...packed.lines);
        return { lines: lines.slice(0, maxLines), overflow };
      }
      if (packed.lines.length === 1) {
        current = packed.lines[0];
      } else {
        lines.push(...packed.lines.slice(0, -1));
        current = packed.lines[packed.lines.length - 1] || "";
      }
    } else {
      const chunks = splitLongTokenBalanced(part, maxUnits, linesLeft);
      if (chunks.length === 1) {
        current = chunks[0];
      } else {
        lines.push(...chunks.slice(0, -1));
        current = chunks[chunks.length - 1] || "";
      }
      if (remainingParts > 0 && lines.length + (current ? 1 : 0) >= maxLines) {
        overflow = parts.slice(i + 1).join("-");
        if (current) lines.push(current);
        return { lines: lines.slice(0, maxLines), overflow };
      }
    }
  }

  if (current) lines.push(current);
  if (overflow && allowEllipsis && lines.length) {
    lines[lines.length - 1] = trimWithEllipsis(joinTitleTokens(lines[lines.length - 1], overflow), maxUnits);
    overflow = "";
  }
  return { lines: lines.slice(0, maxLines), overflow };
}

function wrapDotParts(parts, maxUnits, maxLines, allowEllipsis = true) {
  const lines = [];
  let current = "";
  let overflow = "";

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const sep = current ? " · " : "";
    const merged = `${current}${sep}${part}`;
    const remainingParts = parts.length - i - 1;
    let linesLeft = maxLines - lines.length;

    if (fitsLine(merged, maxUnits)) {
      current = merged;
      continue;
    }

    if (current) {
      lines.push(current);
      current = "";
      linesLeft = maxLines - lines.length;
    }

    if (lines.length >= maxLines) {
      overflow = [part, ...parts.slice(i + 1)].join(" · ");
      return { lines: lines.slice(0, maxLines), overflow };
    }

    if (fitsLine(part, maxUnits)) {
      current = part;
    } else if (/[《》]/.test(part)) {
      const packed = packTokensIntoLines(
        tokenizeMixedText(part),
        maxUnits,
        linesLeft,
        { allowEllipsis: allowEllipsis && remainingParts === 0 },
      );
      if (packed.overflow) {
        overflow = packed.overflow;
        lines.push(...packed.lines);
        return { lines: lines.slice(0, maxLines), overflow };
      }
      if (packed.lines.length === 1) {
        current = packed.lines[0];
      } else {
        lines.push(...packed.lines.slice(0, -1));
        current = packed.lines[packed.lines.length - 1] || "";
      }
    } else {
      const chunks = splitLongTokenBalanced(part, maxUnits, linesLeft);
      if (chunks.length === 1) {
        current = chunks[0];
      } else {
        lines.push(...chunks.slice(0, -1));
        current = chunks[chunks.length - 1] || "";
      }
      if (remainingParts > 0 && lines.length + (current ? 1 : 0) >= maxLines) {
        overflow = [part, ...parts.slice(i + 1)].join(" · ");
        if (current) lines.push(current);
        return { lines: lines.slice(0, maxLines), overflow };
      }
    }
  }

  if (current) lines.push(current);
  if (overflow && allowEllipsis && lines.length) {
    lines[lines.length - 1] = trimWithEllipsis(joinTitleTokens(lines[lines.length - 1], overflow), maxUnits);
    overflow = "";
  }
  return { lines: lines.slice(0, maxLines), overflow };
}

function fitPipePartLine(part, maxUnits, allowEllipsis) {
  const text = String(part || "").trim();
  if (!text) return { line: "", overflow: "" };
  if (fitsLine(text, maxUnits)) return { line: text, overflow: "" };
  if (allowEllipsis) return { line: trimWithEllipsis(text, maxUnits), overflow: "" };

  const packed = packTokensIntoLines(
    tokenizeMixedText(text),
    maxUnits,
    1,
    { allowEllipsis: false },
  );
  if (packed.lines[0]) {
    return { line: packed.lines[0], overflow: packed.overflow };
  }
  const chunk = sliceByUnits(text, maxUnits);
  return { line: chunk.head, overflow: chunk.tail };
}

function wrapPipeTail(parts, maxUnits, maxLines) {
  const lines = [];
  const queue = parts.map((part) => String(part || "").trim()).filter(Boolean);

  while (queue.length && lines.length < maxLines) {
    const linesLeft = maxLines - lines.length;
    const partsLeft = queue.length;

    if (partsLeft > linesLeft) {
      const soloCount = Math.max(0, linesLeft - 1);
      for (let i = 0; i < soloCount && queue.length; i += 1) {
        const part = queue.shift();
        const fit = fitPipePartLine(part, maxUnits, false);
        if (fit.line) lines.push(fit.line);
        if (fit.overflow) queue.unshift(fit.overflow);
      }
      if (queue.length) {
        const merged = queue.join("｜");
        lines.push(fitsLine(merged, maxUnits) ? merged : trimWithEllipsis(merged, maxUnits));
      }
      break;
    }

    const isLastLine = linesLeft === 1;
    const part = queue.shift();
    const fit = fitPipePartLine(part, maxUnits, isLastLine && queue.length === 0);
    if (fit.line) lines.push(fit.line);
    if (fit.overflow) queue.unshift(fit.overflow);
  }

  return lines.slice(0, maxLines);
}

function wrapPipeParts(parts, maxUnits, maxLines) {
  if (parts.length === 1) {
    return wrapTitleBlock(parts[0], maxUnits, maxLines, true).lines;
  }

  const head = wrapTitleBlock(parts[0], maxUnits, maxLines, false);
  const tailParts = [head.overflow, ...parts.slice(1)].map((s) => String(s || "").trim()).filter(Boolean);
  const lines = [...head.lines];
  const linesLeft = maxLines - lines.length;

  if (!tailParts.length) return lines.slice(0, maxLines);

  if (linesLeft > 0) {
    lines.push(...wrapPipeTail(tailParts, maxUnits, linesLeft));
    return capTitleLines(lines, maxLines, maxUnits, "｜");
  }

  if (lines.length) {
    const merged = tailParts.join("｜");
    lines[lines.length - 1] = trimWithEllipsis(
      joinTitleTokens(lines[lines.length - 1], merged),
      maxUnits,
    );
  }
  return lines.slice(0, maxLines);
}

function wrapTitle(title, maxUnits = 11, maxLines = MAX_TITLE_LINES_DEFAULT) {
  const text = normalizeCoverFontText(title);
  if (!text) return [""];
  if (fitsLine(text, maxUnits)) {
    return polishTitleLines(capTitleLines([text], maxLines, maxUnits), maxUnits).slice(0, maxLines);
  }

  const pipeParts = text.split(/[｜|]/u).map((s) => s.trim()).filter(Boolean);
  let lines;
  if (pipeParts.length >= 2) {
    lines = wrapPipeParts(pipeParts, maxUnits, maxLines);
  } else {
    lines = wrapTitleBlock(text, maxUnits, maxLines, true).lines;
  }
  return polishTitleLines(lines, maxUnits).slice(0, maxLines);
}

function estimateLineWidth(text, fontSize, widthFactor = 0.98) {
  return estimateLineUnits(text) * fontSize * widthFactor;
}

function layoutPosterText(title, innerWidth, widthFactor = 0.98, lineHeightFactor = 1.16, layoutOpts = {}) {
  const fontMax = layoutOpts.titleFontMax || 140;
  const fontMin = layoutOpts.titleFontMin || 56;
  const maxLineUnits = layoutOpts.maxLineChars || 14;
  const maxTitleLines = layoutOpts.maxTitleLines || MAX_TITLE_LINES_DEFAULT;
  const plain = normalizeCoverFontText(title) || "活动";

  const resolveTitleLines = (fontSize) => {
    const maxUnits = Math.max(
      4,
      Math.min(maxLineUnits, lineUnitsBudget(innerWidth, fontSize, widthFactor)),
    );
    return {
      maxUnits,
      titleLines: fitsLine(plain, maxUnits)
        ? capTitleLines([plain], maxTitleLines, maxUnits)
        : wrapTitle(plain, maxUnits, maxTitleLines),
    };
  };

  let { maxUnits, titleLines } = resolveTitleLines(fontMin);

  let titleFontSize = fontMin;
  for (let size = fontMax; size >= fontMin; size -= 2) {
    const widest = Math.max(...titleLines.map((line) => estimateLineWidth(line, size, widthFactor)), 1);
    if (widest <= innerWidth * 0.96) {
      titleFontSize = size;
      break;
    }
  }

  const refined = resolveTitleLines(titleFontSize);
  if (refined.maxUnits > maxUnits * 1.05) {
    maxUnits = refined.maxUnits;
    titleLines = refined.titleLines;
    for (let size = fontMax; size >= fontMin; size -= 2) {
      const widest = Math.max(...titleLines.map((line) => estimateLineWidth(line, size, widthFactor)), 1);
      if (widest <= innerWidth * 0.96) {
        titleFontSize = size;
        break;
      }
    }
  }

  const titleLineHeight = Math.round(titleFontSize * lineHeightFactor);
  return {
    titleLines,
    titleFontSize,
    titleLineHeight,
    titleBlockH: titleLines.length * titleLineHeight,
  };
}

/** 按两行标题场景计算 CTA 字号，三行标题时保持不变 */
function computeReferenceCtaLayout(width, height, innerW, widthFactor, ctaLineCount, layoutOpts = {}) {
  const safeTop = Math.round(height * (layoutOpts.safeTopRatio ?? LAYOUT_SAFE_TOP_RATIO));
  const safeBottom = Math.round(height * (layoutOpts.safeBottomRatio ?? 0.82));
  const ctaGap = Math.round(height * 0.065 * (layoutOpts.ctaGapScale ?? 1));

  const fontMax = layoutOpts.titleFontMax || 140;
  const fontMin = layoutOpts.titleFontMin || 56;
  const baselineFactor = layoutOpts.titleBaselineFactor ?? TITLE_BASELINE_OFFSET_FACTOR;

  for (let titleFontSize = fontMax; titleFontSize >= fontMin; titleFontSize -= 2) {
    const titleLineHeight = Math.round(titleFontSize * 1.16);
    const titleBlockH = 2 * titleLineHeight;
    const ctaFontSize = Math.max(54, Math.round(titleFontSize * (layoutOpts.ctaFontScale ?? 0.58)));
    const ctaLineHeight = Math.round(ctaFontSize * 1.38);
    const titleStartY = safeTop + Math.round(titleFontSize * baselineFactor);
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
  titleFontMax = 140,
  titleFontMin = 56,
  titleBaselineFactor = TITLE_BASELINE_OFFSET_FACTOR,
}) {
  let best = titleFontMin;
  for (let titleFontSize = titleFontMax; titleFontSize >= titleFontMin; titleFontSize -= 2) {
    const widest = Math.max(...titleLines.map((line) => estimateLineWidth(line, titleFontSize, widthFactor)), 1);
    if (widest > innerW * 0.96) continue;

    const titleLineHeight = Math.round(titleFontSize * lineHeightFactor);
    const titleBlockH = titleLines.length * titleLineHeight;
    const titleStartY = safeTop + Math.round(titleFontSize * titleBaselineFactor);
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
  const layoutOpts = {
    titleFontMax: styleOptions.titleFontMax,
    titleFontMin: styleOptions.titleFontMin,
    safeTopRatio: styleOptions.safeTopRatio,
    safeBottomRatio: styleOptions.safeBottomRatio,
    titleBaselineFactor: styleOptions.titleBaselineFactor,
    ctaGapScale: styleOptions.ctaGapScale,
    ctaFontScale: styleOptions.ctaFontScale,
  };
  const safeTop = Math.round(height * (layoutOpts.safeTopRatio ?? LAYOUT_SAFE_TOP_RATIO));
  const safeBottom = Math.round(height * (layoutOpts.safeBottomRatio ?? 0.82));

  const refCta = computeReferenceCtaLayout(width, height, innerW, preset.widthFactor, ctaLines.length, layoutOpts);
  const ctaFontSize = refCta.ctaFontSize;
  const ctaLineHeight = refCta.ctaLineHeight;

  const titleLineHeightFactor = 1.16;
  let { titleLines, titleFontSize } = layoutPosterText(
    normalizeCoverFontText(title),
    innerW,
    preset.widthFactor,
    titleLineHeightFactor,
    layoutOpts,
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
    titleFontMax: layoutOpts.titleFontMax || 140,
    titleFontMin: layoutOpts.titleFontMin || 56,
    titleBaselineFactor: layoutOpts.titleBaselineFactor ?? TITLE_BASELINE_OFFSET_FACTOR,
  });

  if (styleOptions.titleFontScale && styleOptions.titleFontScale !== 1) {
    titleFontSize = Math.max(
      layoutOpts.titleFontMin || 56,
      Math.min(layoutOpts.titleFontMax || 140, Math.round(titleFontSize * styleOptions.titleFontScale)),
    );
  }

  let titleLineHeight = Math.round(titleFontSize * titleLineHeightFactorFinal);
  let titleBlockH = titleLines.length * titleLineHeight;
  let titleStartY = safeTop + Math.round(titleFontSize * TITLE_BASELINE_OFFSET_FACTOR);
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
function buildPosterSideTextLayerSvg(width, height, title, ctaLines, fontPreset, styleOptions = {}) {
  const merged = { ...POSTER_SIDE_TEXT_LAYOUT, ...styleOptions };
  const padX = merged.padX ?? Math.round(width * (merged.padXRatio ?? 0.08));
  const { padXRatio, ...rest } = merged;
  return buildTextLayerSvg(width, height, title, ctaLines, fontPreset, {
    fill: COLOR_TEXT_ON_DARK,
    padX,
    textShadow: true,
    ...rest,
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
      loadSystemFonts: false,
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
  POSTER_SIDE_TEXT_LAYOUT,
  composeXhsTextCover,
  composeXhsTextCoverToFile,
  layoutPosterText,
  wrapTitle,
  estimateLineUnits,
  lineUnitsBudget,
  normalizeCoverFontText,
  buildTextLayerSvg,
  buildPosterSideTextLayerSvg,
  rasterizeTextSvg,
  resolveCtaLines,
  resolveFontPreset,
  listXhsCoverBackgrounds,
  resolveCoverBackgroundPath,
};

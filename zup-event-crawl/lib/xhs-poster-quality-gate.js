"use strict";

const fs = require("fs");
const sharp = require("sharp");

/**
 * 裁切结果宽高比（宽/高）合理区间。
 * 竖版/方版为主，但也存在 16:9 左右的真实横版海报（约 1.4~1.8），
 * 上限只挡明显的横条说明区（通常 >2.5）。
 */
const ASPECT_MIN = 0.32;
const ASPECT_MAX = 2.0;

const MIN_WIDTH_PX = 100;
const MIN_HEIGHT_PX = 100;

/** posterBox 占整 slide 比例上限（超过多半框进了说明区） */
const MAX_BOX_WIDTH_RATIO = 0.48;
const MAX_BOX_HEIGHT_RATIO = 0.46;

function sampleStats(data, channels, step = 4) {
  const rs = [];
  const gs = [];
  const bs = [];
  let blank = 0;
  let total = 0;

  for (let i = 0; i < data.length; i += channels * step) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    rs.push(r);
    gs.push(g);
    bs.push(b);
    total += 1;
    if (r > 245 && g > 242 && b > 235) blank += 1;
  }

  const mean = (arr) => arr.reduce((a, v) => a + v, 0) / Math.max(1, arr.length);
  const mr = mean(rs);
  const mg = mean(gs);
  const mb = mean(bs);
  const variance =
    rs.reduce((a, v) => a + (v - mr) ** 2, 0) / Math.max(1, rs.length) +
    gs.reduce((a, v) => a + (v - mg) ** 2, 0) / Math.max(1, gs.length) +
    bs.reduce((a, v) => a + (v - mb) ** 2, 0) / Math.max(1, bs.length);

  return {
    colorStd: Math.sqrt(variance),
    blankRatio: total ? blank / total : 1,
  };
}

function boxRatios(posterBox, slideWidth, slideHeight) {
  if (!posterBox || !slideWidth || !slideHeight) return null;
  const w = Number(posterBox.w ?? posterBox.width);
  const h = Number(posterBox.h ?? posterBox.height);
  if (!w || !h) return null;
  if (w <= 1 && h <= 1) return { w, h };
  return { w: w / slideWidth, h: h / slideHeight };
}

/**
 * 裁切后几何诊断（已退出默认流水线；extract 不再据此 drop）。
 * crop/skip 与框是否准确由 Agent 标框阶段决定；验收靠红框预览 + 总览图。
 * 不合格 → 调用方应 drop（poster=null，走文字封面）。
 *
 * @returns {{ ok: boolean, reasons: string[], metrics: object }}
 */
async function validatePosterCrop(imagePath, posterBox = null, slideSize = null) {
  const reasons = [];
  if (!imagePath || !fs.existsSync(imagePath)) {
    return { ok: false, reasons: ["file_missing"], metrics: {} };
  }

  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const aspect = width / height;
  const stats = sampleStats(data, channels);
  const ratios = boxRatios(posterBox, slideSize?.width, slideSize?.height);

  const metrics = {
    width,
    height,
    aspect: Number(aspect.toFixed(3)),
    colorStd: Number(stats.colorStd.toFixed(1)),
    blankRatio: Number(stats.blankRatio.toFixed(3)),
    boxWRatio: ratios?.w ?? null,
    boxHRatio: ratios?.h ?? null,
  };

  if (width < MIN_WIDTH_PX || height < MIN_HEIGHT_PX) {
    reasons.push("too_small");
  }
  if (aspect < ASPECT_MIN) {
    reasons.push("aspect_too_narrow");
  }
  if (aspect > ASPECT_MAX) {
    reasons.push("aspect_too_wide");
  }
  if (stats.blankRatio > 0.88) {
    reasons.push("mostly_blank");
  }
  if (stats.colorStd < 12) {
    reasons.push("low_visual_detail");
  }
  if (ratios?.w > MAX_BOX_WIDTH_RATIO) {
    reasons.push("box_too_wide");
  }
  if (ratios?.h > MAX_BOX_HEIGHT_RATIO) {
    reasons.push("box_too_tall");
  }

  return { ok: reasons.length === 0, reasons, metrics };
}

const REASON_LABELS = {
  file_missing: "裁切文件不存在",
  too_small: "裁切尺寸过小",
  aspect_too_narrow: "过窄（像竖条/误框文字）",
  aspect_too_wide: "过宽（像横条说明区）",
  mostly_blank: "几乎空白",
  low_visual_detail: "画面过于单调（不像海报）",
  box_too_wide: "标注框过宽（可能框进说明文字）",
  box_too_tall: "标注框过高（可能跨行）",
};

function formatDropReasons(reasons) {
  return reasons.map((code) => REASON_LABELS[code] || code);
}

module.exports = {
  validatePosterCrop,
  formatDropReasons,
  REASON_LABELS,
};

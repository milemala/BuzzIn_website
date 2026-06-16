"use strict";

/**
 * 将 Agent 在问题清单里定的「占 slide 百分比」换算为 posterBox 像素。
 * 仅做算术，不做语义判断（哪块是海报仍由 Agent 读图决定）。
 *
 * 百分比约定：0–100 的数，表示相对 slide 宽/高的占比。
 * 例：leftPct=60 表示左边缘在 slide 宽度 60% 处。
 */

/**
 * 宽度占比低于此值 → 仅「建议」skip（装饰/icon 级小图）。
 * 本地宝等列表帖左栏活动海报常约 17–22%，仍应标 posterBox。
 */
const MIN_POSTER_WIDTH_RATIO = 0.12;

/** 高度像素低于此值 → 建议 skip（横条 banner / 极小缩略） */
const MIN_POSTER_HEIGHT_PX = 160;

function clampInt(n) {
  return Math.max(0, Math.round(Number(n)));
}

function percentBoxToPx(percentBox, slideWidth, slideHeight) {
  const w = Number(slideWidth);
  const h = Number(slideHeight);
  if (!w || !h) throw new Error("slideWidth / slideHeight 无效");

  const leftPct = Number(percentBox.leftPct ?? percentBox.xPct ?? percentBox.x);
  const topPct = Number(percentBox.topPct ?? percentBox.yPct ?? percentBox.y);
  const widthPct = Number(percentBox.widthPct ?? percentBox.wPct ?? percentBox.w);
  const heightPct = Number(percentBox.heightPct ?? percentBox.hPct ?? percentBox.h);

  if ([leftPct, topPct, widthPct, heightPct].some((v) => Number.isNaN(v))) {
    throw new Error("percentBox 须含 leftPct/topPct/widthPct/heightPct（或 x/y/w/h 作 0–100 百分比）");
  }

  const x = clampInt((leftPct / 100) * w);
  const y = clampInt((topPct / 100) * h);
  const boxW = clampInt((widthPct / 100) * w);
  const boxH = clampInt((heightPct / 100) * h);

  return { x, y, w: boxW, h: boxH };
}

function shouldSkipBySize(boxPx, slideWidth, slideHeight) {
  if (!boxPx || !slideWidth || !slideHeight) return { skip: false };
  const widthRatio = boxPx.w / slideWidth;
  const reasons = [];
  if (widthRatio < MIN_POSTER_WIDTH_RATIO) {
    reasons.push(`宽度占比 ${(widthRatio * 100).toFixed(1)}% < ${MIN_POSTER_WIDTH_RATIO * 100}%`);
  }
  if (boxPx.h < MIN_POSTER_HEIGHT_PX) {
    reasons.push(`高度 ${boxPx.h}px < ${MIN_POSTER_HEIGHT_PX}px`);
  }
  return { skip: reasons.length > 0, reasons, widthRatio };
}

function posterBoxFromPercent(percentBox, slide, slideWidth, slideHeight) {
  const px = percentBoxToPx(percentBox, slideWidth, slideHeight);
  return { slide, ...px };
}

module.exports = {
  MIN_POSTER_HEIGHT_PX,
  MIN_POSTER_WIDTH_RATIO,
  percentBoxToPx,
  posterBoxFromPercent,
  shouldSkipBySize,
};

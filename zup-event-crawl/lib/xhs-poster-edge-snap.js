"use strict";

/**
 * 海报边缘吸附：Agent 已给出语义正确的最终框后，
 * 本模块只作为可选工具在四边附近做几何修正，分三步：
 *
 *   1. 修剪（trim）   ：剔除框内边缘处的「邻场残影」——小块墨水 + 明显白隙后才是海报主体
 *   2. 吸附（snap）   ：把每条边贴到最近的「白隙↔墨水」分界
 *   3. 外扩（extend） ：若边外侧仍有墨水（白底海报的文字被切），向外推到干净白隙为止
 *
 * 与已废弃的全图猜框脚本本质不同：
 *   - 不猜海报在哪侧、不猜该不该裁（语义全由 Agent 决定）
 *   - 所有移动都限制在原框邻域内，走不到就保持 Agent 原值并报告
 */

const sharp = require("sharp");

/** 修剪阶段（向内剔除残影/白隙）单边最大移动（px） */
const MAX_WALK = 90;
/**
 * 吸附阶段向外最多走多少 px。原框若偏差超过这个量，
 * 走更远还停不下来，多半是贴着标题条/邻栏内容，回退 Agent 原值更安全。
 */
const MAX_OUTWARD = 50;
/** 外扩阶段最大额外移动（px） */
const MAX_EXTEND = 140;
/**
 * 判定为「白隙」所需的白色覆盖率（用于修剪/外扩的干净判定）。
 * 剖面取全宽：海报自身的边框线（约占 5%~8%）必须算进墨水，
 * 否则白底海报的边框行会被误判成白隙、底部文字被切。
 */
const GAP_WHITE_RATIO = 0.985;
/**
 * 向外吸附的停止阈值（比 GAP 宽松）：行/列大体是白的就停。
 * 介于两者之间（0.90~0.985）的行/列：带边框的海报内容行（继续走）、
 * 邻场元素小尾巴（停下，避免吞掉标题条）。
 */
const STOP_WHITE_RATIO = 0.9;
/** 残影修剪：墨水段 ≤ 框尺寸该比例，且其后紧跟 ≥ MIN_GAP_RUN 白隙，才视为残影 */
const SLIVER_MAX_RATIO = 0.25;
const MIN_GAP_RUN = 8;
/** 外扩后边外侧需要的连续白隙宽度 */
const CLEAN_GAP_RUN = 6;

function isWhite(r, g, b) {
  return r > 235 && g > 233 && b > 227;
}

function colWhiteRatio(img, x, y0, y1) {
  const { data, width, channels } = img;
  let white = 0;
  for (let y = y0; y < y1; y++) {
    const i = (y * width + x) * channels;
    if (isWhite(data[i], data[i + 1], data[i + 2])) white++;
  }
  return white / (y1 - y0);
}

function rowWhiteRatio(img, y, x0, x1) {
  const { data, width, channels } = img;
  let white = 0;
  for (let x = x0; x < x1; x++) {
    const i = (y * width + x) * channels;
    if (isWhite(data[i], data[i + 1], data[i + 2])) white++;
  }
  return white / (x1 - x0);
}

/**
 * 处理一条边（一维问题）。
 * @param {(pos:number)=>boolean} isGapAt 该列/行是否白隙（严格）
 * @param {(pos:number)=>boolean} isStopAt 向外吸附时是否应停（宽松，大体白即停）
 * @param {number} start Agent 原框的这条边
 * @param {number} dir   +1 表示「向内」是正方向（左/上边），-1 表示向内是负方向（右/下边）
 * @param {number} lo/hi 图像合法范围
 * @param {number} boxDim 框在该轴上的尺寸（用于残影比例判断）
 * @param {boolean} allowExtend 是否允许外扩。只有上下边允许：白底海报的文字
 *   只会在纵向被切；左右外扩会误抓相邻说明文字栏
 * @returns {{edge:number|null, trimmed:boolean, extended:boolean}}
 */
function resolveEdge(isGapAt, isStopAt, start, dir, lo, hi, boxDim, allowExtend) {
  const clamp = (v) => Math.max(lo, Math.min(hi, v));
  let pos = clamp(start);
  let trimmed = false;
  let extended = false;

  const inRange = (v) => v >= lo && v <= hi;

  // —— 第1步：向内跳过「白隙 + 残影小段」，定位海报主体的起点 ——
  // 最多剔除 2 个残影段
  let cursor = pos;
  let walked = 0;
  for (let round = 0; round < 3; round++) {
    // 跳过白隙
    while (walked <= MAX_WALK + MAX_EXTEND && isGapAt(cursor) && inRange(cursor + dir)) {
      cursor += dir;
      walked++;
    }
    if (round === 2) break;
    // 现在 cursor 在墨水上：量这段墨水的长度
    let runEnd = cursor;
    let runLen = 0;
    while (runLen <= boxDim && !isGapAt(runEnd) && inRange(runEnd + dir)) {
      runEnd += dir;
      runLen++;
    }
    // 墨水段后面的白隙长度
    let gapEnd = runEnd;
    let gapLen = 0;
    while (gapLen <= MAX_WALK && isGapAt(gapEnd) && inRange(gapEnd + dir)) {
      gapEnd += dir;
      gapLen++;
    }
    const isSliver = runLen <= boxDim * SLIVER_MAX_RATIO && gapLen >= MIN_GAP_RUN;
    if (!isSliver) break;
    trimmed = true;
    cursor = gapEnd; // 跳过残影 + 白隙，进入下一段
    walked += runLen + gapLen;
  }
  pos = cursor;

  // —— 第2步：吸附——pos 已在墨水上，向外走到「大体白」处停，边界取墨水第一格 ——
  if (isGapAt(pos)) return { edge: null, trimmed, extended }; // 邻域内全是白，放弃
  let edge = pos;
  let stopFound = false;
  for (let step = 1; step <= MAX_OUTWARD; step++) {
    const p = pos - dir * step;
    if (!inRange(p) || isStopAt(p)) {
      stopFound = true;
      break;
    }
    edge = p;
  }
  // 走满 MAX_OUTWARD 仍没遇到白隙：说明外侧贴着别的内容（标题条、邻栏文字），
  // 吸附不可信，退回 Agent 原值
  if (!stopFound) {
    edge = clamp(start);
    return { edge, trimmed, extended };
  }

  // —— 第3步：外扩——边外侧若有实质墨水（白底海报内容被切），推到连续白隙 ——
  // 用宽松的 isStopAt 判干净：邻场小尾巴（白率 0.9+）不触发外扩
  const outsideClean = () => {
    for (let k = 1; k <= CLEAN_GAP_RUN; k++) {
      const p = edge - dir * k;
      if (p < lo || p > hi) return true; // 顶到图边视为干净
      if (!isStopAt(p)) return false;
    }
    return true;
  };
  if (allowExtend && !outsideClean()) {
    let p = edge;
    let gapRun = 0;
    for (let step = 1; step <= MAX_EXTEND; step++) {
      const next = clamp(p - dir);
      if (next === p) break;
      p = next;
      if (isGapAt(p)) {
        gapRun++;
        if (gapRun >= CLEAN_GAP_RUN) {
          edge = p + dir * CLEAN_GAP_RUN; // 回到白隙内侧的墨水边
          extended = true;
          break;
        }
      } else {
        gapRun = 0;
      }
    }
  }

  return { edge, trimmed, extended };
}

/**
 * 对单个 posterBox 做修剪 + 吸附 + 外扩。
 * @param {object} img { data, width, height, channels }
 * @param {object} box { x, y, w, h } px
 */
function snapBox(img, box) {
  const { width: W, height: H } = img;

  // 全宽剖面：留边距会漏掉海报自身的边框线（白底海报的边框行会被误判成白隙）
  const midY0 = Math.max(0, Math.round(box.y));
  const midY1 = Math.min(img.height, Math.round(box.y + box.h));
  const midX0 = Math.max(0, Math.round(box.x));
  const midX1 = Math.min(img.width, Math.round(box.x + box.w));

  const colCache = new Map();
  const rowCache = new Map();
  const colRatio = (x) => {
    if (!colCache.has(x)) colCache.set(x, colWhiteRatio(img, x, midY0, midY1));
    return colCache.get(x);
  };
  const rowRatio = (y) => {
    if (!rowCache.has(y)) rowCache.set(y, rowWhiteRatio(img, y, midX0, midX1));
    return rowCache.get(y);
  };
  const colIsGap = (x) => colRatio(x) >= GAP_WHITE_RATIO;
  const rowIsGap = (y) => rowRatio(y) >= GAP_WHITE_RATIO;
  const colIsStop = (x) => colRatio(x) >= STOP_WHITE_RATIO;
  const rowIsStop = (y) => rowRatio(y) >= STOP_WHITE_RATIO;

  const left = resolveEdge(colIsGap, colIsStop, box.x, +1, 0, W - 1, box.w, false);
  const right = resolveEdge(colIsGap, colIsStop, box.x + box.w - 1, -1, 0, W - 1, box.w, false);
  const top = resolveEdge(rowIsGap, rowIsStop, box.y, +1, 0, H - 1, box.h, true);
  const bottom = resolveEdge(rowIsGap, rowIsStop, box.y + box.h - 1, -1, 0, H - 1, box.h, true);

  const nx = left.edge ?? box.x;
  const ny = top.edge ?? box.y;
  const nr = right.edge ?? box.x + box.w - 1;
  const nb = bottom.edge ?? box.y + box.h - 1;

  const snappedBox = { x: nx, y: ny, w: nr - nx + 1, h: nb - ny + 1 };
  return {
    box: snappedBox,
    deltas: {
      left: nx - box.x,
      top: ny - box.y,
      right: nr - (box.x + box.w - 1),
      bottom: nb - (box.y + box.h - 1),
    },
    flags: {
      trimmed: [left, top, right, bottom].some((e) => e.trimmed),
      extended: [left, top, right, bottom].some((e) => e.extended),
      failed: [
        left.edge === null && "left",
        top.edge === null && "top",
        right.edge === null && "right",
        bottom.edge === null && "bottom",
      ].filter(Boolean),
    },
  };
}

/**
 * 裁后自检：吸附后的框，四边外侧应是白隙（干净分离），内侧应有墨水。
 */
function checkBox(img, box) {
  const { width: W, height: H } = img;
  const midY0 = Math.max(0, Math.round(box.y));
  const midY1 = Math.min(H, Math.round(box.y + box.h));
  const midX0 = Math.max(0, Math.round(box.x));
  const midX1 = Math.min(W, Math.round(box.x + box.w));

  const colR = (x) => (x >= 0 && x < W ? colWhiteRatio(img, x, midY0, midY1) : 1);
  const rowR = (y) => (y >= 0 && y < H ? rowWhiteRatio(img, y, midX0, midX1) : 1);
  const avg = (vals) => vals.reduce((a, b) => a + b, 0) / vals.length;

  const outside = {
    left: avg([colR(box.x - 2), colR(box.x - 3)]),
    right: avg([colR(box.x + box.w + 1), colR(box.x + box.w + 2)]),
    top: avg([rowR(box.y - 2), rowR(box.y - 3)]),
    bottom: avg([rowR(box.y + box.h + 1), rowR(box.y + box.h + 2)]),
  };
  const inside = {
    left: avg([colR(box.x + 2), colR(box.x + 5)]),
    right: avg([colR(box.x + box.w - 3), colR(box.x + box.w - 6)]),
    top: avg([rowR(box.y + 2), rowR(box.y + 5)]),
    bottom: avg([rowR(box.y + box.h - 3), rowR(box.y + box.h - 6)]),
  };

  const warnings = [];
  for (const edge of ["left", "right", "top", "bottom"]) {
    if (outside[edge] < 0.9) warnings.push(`${edge}_outside_not_clean`);
    if (inside[edge] > 0.995) warnings.push(`${edge}_inside_blank`);
  }
  return { warnings, outside, inside };
}

async function loadRaw(imagePath) {
  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

/**
 * 对一张 slide 上的多个 posterBox 做吸附 + 自检。
 * @param {string} imagePath slide 原图
 * @param {Array<{key:string, box:object}>} boxes
 */
async function snapBoxesOnSlide(imagePath, boxes) {
  const img = await loadRaw(imagePath);
  return boxes.map(({ key, box }) => {
    const snap = snapBox(img, box);
    const check = checkBox(img, snap.box);
    return { key, before: box, after: snap.box, deltas: snap.deltas, flags: snap.flags, check };
  });
}

module.exports = { snapBoxesOnSlide, snapBox, checkBox, loadRaw, MAX_WALK };

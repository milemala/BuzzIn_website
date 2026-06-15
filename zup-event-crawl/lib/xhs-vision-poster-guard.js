"use strict";

/**
 * vision-slots.json 的 posterBox 硬性守卫（extract 前执行）。
 * 目的：拦住「脚本套模板坐标」类坏标框，要求有标框元数据记录。
 */

const META_FILENAME = "vision-slots.meta.json";

function loadMeta(noteDir, fs) {
  const p = require("path").join(noteDir, META_FILENAME);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function boxKey(box) {
  if (!box) return null;
  return `${box.x},${box.y},${box.w},${box.h}`;
}

/**
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
function validateVisionPosterBoxes(vision, options = {}) {
  const errors = [];
  const warnings = [];
  const entries = Object.entries(vision || {}).filter(([, v]) => v?.posterBox);
  if (!entries.length) return { ok: true, errors, warnings };

  const meta = options.meta;
  if (!meta) {
    errors.push(
      `缺少 ${META_FILENAME}：有 posterBox 时须在同目录写入标框元数据（至少含 labeledAt）`,
    );
  } else if (!meta.labeledAt) {
    errors.push(
      `${META_FILENAME} 缺少 labeledAt：标框完成后须记录标框时间`,
    );
  }

  const byKey = new Map();
  for (const [slot, entry] of entries) {
    const k = boxKey(entry.posterBox);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(slot);
  }

  for (const [k, slots] of byKey.entries()) {
    if (slots.length >= 3) {
      errors.push(
        `模板坐标：${slots.length} 场共用 posterBox ${k}（${slots.slice(0, 5).join(", ")}${slots.length > 5 ? "…" : ""}）— 须逐场重标`,
      );
    } else if (slots.length === 2) {
      warnings.push(`两场共用坐标 ${k}：${slots.join(", ")}（请确认是否真为相同尺寸）`);
    }
  }

  const widths = entries.map(([, e]) => e.posterBox.w);
  const dominantW = mode(widths);
  if (dominantW != null && entries.length >= 6) {
    const sameW = widths.filter((w) => w === dominantW).length;
    if (sameW / widths.length >= 0.7) {
      errors.push(
        `${sameW}/${widths.length} 场 posterBox 宽度同为 ${dominantW}px（≥70%）— 疑似脚本套版，禁止 extract，须重标`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function mode(nums) {
  const c = new Map();
  for (const n of nums) c.set(n, (c.get(n) || 0) + 1);
  let best = null;
  let max = 0;
  for (const [n, cnt] of c.entries()) {
    if (cnt > max) {
      max = cnt;
      best = n;
    }
  }
  return best;
}

module.exports = {
  META_FILENAME,
  loadMeta,
  validateVisionPosterBoxes,
};

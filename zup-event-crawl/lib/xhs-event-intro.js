"use strict";

/** 去掉 Agent 可能误加的「门票：」「亮点：」等标签前缀 */
function stripIntroLabel(text) {
  return String(text || "")
    .replace(/^门票[：:]\s*/u, "")
    .replace(/^亮点[：:]\s*/u, "")
    .replace(/^介绍[：:]\s*/u, "")
    .replace(/^费用[：:]\s*/u, "")
    .trim();
}

/** 单行归一（段内不换行） */
function normalizeLine(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * 多段介绍：段与段之间仅一个换行（\n），不加空行。
 */
function normalizeBodyParagraphs(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .split("\n")
    .map((p) => normalizeLine(p))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeBodyText(text) {
  return normalizeBodyParagraphs(text);
}

const PARA = "\n";

/**
 * 将 intro 整理为 1～2 段，段间单换行（无空行）。
 */
function formatIntroParagraphs(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";

  if (raw.includes("\n")) {
    return normalizeBodyParagraphs(raw);
  }

  const one = normalizeLine(raw);
  const signupRe =
    /^(.+?(?:免费入场|免费预约|免门票|免票|消费自理|可刷本人|身份证|官号预约|小程序预约|无需预约|报名|购票|票价)[^。！？]*[。！？]?)\s*(.+)$/u;
  const m = one.match(signupRe);
  if (m && m[2] && m[2].length >= 12) {
    return `${stripIntroLabel(m[1])}${PARA}${stripIntroLabel(m[2])}`;
  }

  const parts = one.split(/(?<=[。！？])\s*(?=[^。！？])/u).map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0];
    const rest = parts.slice(1).join("");
    if (/预约|入场|身份证|消费自理|免票|购票|报名/.test(first) && rest.length >= 12) {
      return `${stripIntroLabel(first)}${PARA}${stripIntroLabel(rest)}`;
    }
  }

  return stripIntroLabel(one);
}

function buildIntroFromEventFields(event) {
  const direct = formatIntroParagraphs(event?.intro || "");
  if (direct) return direct;

  const parts = [];
  const seen = new Set();
  const add = (raw) => {
    const text = stripIntroLabel(normalizeLine(raw));
    if (!text || seen.has(text)) return;
    seen.add(text);
    parts.push(text);
  };

  add(event?.ticket);
  add(event?.highlights);
  add(event?.notes);
  add(event?.description);
  const price = normalizeLine(event?.price || "");
  if (price && /预约|入场|身份证|消费|购票|免票|凭/.test(price)) {
    add(price);
  }

  return parts.join(PARA).trim();
}

function buildIntroFromVisionSlot(slot) {
  let intro = slot?.intro ? formatIntroParagraphs(slot.intro) : "";
  if (!intro) intro = buildIntroFromEventFields(slot);
  if (intro && !intro.includes("\n")) {
    const price = normalizeLine(slot?.price || "");
    if (price === "免费") {
      intro = `免费入场。${PARA}${intro}`;
    } else if (price && /预约|入场|身份证|消费自理|免票|购票/.test(price) && !intro.includes(price)) {
      intro = `${price}${PARA}${intro}`;
    }
  }
  return intro;
}

module.exports = {
  buildIntroFromEventFields,
  buildIntroFromVisionSlot,
  formatIntroParagraphs,
  stripIntroLabel,
  normalizeBodyText,
  normalizeBodyParagraphs,
  normalizeLine,
};

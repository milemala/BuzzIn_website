"use strict";

const { buildIntroFromEventFields } = require("./xhs-event-intro");

const BODY_SOURCE_PENDING = "pending";
const BODY_SOURCE_AGENT = "agent";
const BODY_SOURCE_JS_FALLBACK = "js_fallback";
/** 小红书合集 vision 提炼的介绍，入库时直写 body，不走 Agent */
const BODY_SOURCE_XHS = "xhs_source";

/** 活动介绍正文建议字数（不含参加方式也可，但推荐两段合一写入 body） */
const BODY_INTRO_MAX_LENGTH = 220;
/** 完整 body（介绍 + 参加方式）硬上限 */
const BODY_HARD_MAX = 500;

const BODY_PENDING_PLACEHOLDER = "";

function isAgentBody(event) {
  return String(event?.body_source || "").trim() === BODY_SOURCE_AGENT;
}

function isXhsSourceBody(event) {
  return String(event?.body_source || "").trim() === BODY_SOURCE_XHS;
}

function isBodyPending(event) {
  if (isAgentBody(event) || isXhsSourceBody(event)) return false;
  const source = String(event?.body_source || BODY_SOURCE_PENDING).trim();
  return source === BODY_SOURCE_PENDING || !String(event?.body || "").trim();
}

function buildPendingBodyFields() {
  return {
    body: BODY_PENDING_PLACEHOLDER || null,
    body_source: BODY_SOURCE_PENDING,
  };
}

/** 小红书 events-extracted.json → 审核台「介绍」（整段 intro，不拆门票/亮点标签） */
function buildXhsBodyFields(event) {
  const body = buildIntroFromEventFields(event);
  if (!body) {
    return buildPendingBodyFields();
  }
  return {
    body,
    body_source: BODY_SOURCE_XHS,
  };
}

function normalizeBodyText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function validateBodyDecision(decision) {
  const errors = [];
  const eventUid = String(decision?.event_uid || "").trim();
  if (!eventUid) errors.push("缺少 event_uid");

  const bodyText = normalizeBodyText(decision?.body ?? decision?.body_intro);
  if (!bodyText) errors.push("缺少 body（完整活动介绍，含参加方式）");
  else if (bodyText.length > BODY_HARD_MAX) {
    errors.push(`body 不超过 ${BODY_HARD_MAX} 字（当前 ${bodyText.length}）`);
  }

  const reason = String(decision?.reason || "").trim();
  if (!reason) errors.push("缺少 reason");

  return {
    ok: errors.length === 0,
    errors,
    eventUid,
    bodyText,
    reason,
  };
}

module.exports = {
  BODY_HARD_MAX,
  BODY_INTRO_MAX_LENGTH,
  BODY_PENDING_PLACEHOLDER,
  BODY_SOURCE_AGENT,
  BODY_SOURCE_JS_FALLBACK,
  BODY_SOURCE_PENDING,
  BODY_SOURCE_XHS,
  buildPendingBodyFields,
  buildXhsBodyFields,
  isAgentBody,
  isBodyPending,
  isXhsSourceBody,
  normalizeBodyText,
  validateBodyDecision,
};

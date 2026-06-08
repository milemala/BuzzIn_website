"use strict";

const { extractEdescHtml, extractEventNotices, htmlFragmentToLines } = require("./douban-html");

const TICKET_CHANNELS = [
  { pattern: /猫眼/, name: "猫眼", action: "购票" },
  { pattern: /大麦/, name: "大麦", action: "购票" },
  { pattern: /秀动/, name: "秀动", action: "购票" },
  { pattern: /票星球/, name: "票星球", action: "购票" },
  { pattern: /摩天轮/, name: "摩天轮", action: "购票" },
  { pattern: /活动行/, name: "活动行", action: "报名" },
];

const BAD_HINT = /扫码|添加客服|添加微信|请咨询管理员|微信咨询|原始链接/;

function normalizeSpace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function formatFee(fee) {
  const raw = normalizeSpace(fee);
  if (!raw || /待确认|面议|TBD/i.test(raw)) return "";
  if (/免费/.test(raw) || /^0\s*元/.test(raw)) return "免费";
  return raw
    .replace(/\.00(?=元)/g, "")
    .replace(/\s+/g, "");
}

function resolveTicketChannel(event) {
  const owner = String(event.owner || "").trim();
  const title = String(event.title || "");
  const raw = String(event.rawDetailText || event.raw_detail_text || "");

  for (const row of TICKET_CHANNELS) {
    if (row.pattern.test(owner)) return { ...row };
  }

  for (const row of TICKET_CHANNELS) {
    if (row.pattern.test(raw) || row.pattern.test(title)) return { ...row };
  }

  const appMatch = raw.match(/在[\s「『"]?([^」』"\n]{2,12})(?:App|APP|app|小程序|公众号)/);
  if (appMatch) {
    const name = appMatch[1].trim();
    const action = /购票|选座|门票/.test(raw + title) ? "购票" : "报名";
    return { name, action };
  }

  return null;
}

function extractPublicAccount(source) {
  const text = String(source || "");
  const patterns = [
    /公众号[:：]\s*[「『"']?([^」』"'\s<，。；\n]{2,24})[」』"']?/,
    /关注[「『"']?([^」』"'\s<，。；\n]{2,24})[」』"']?公众号/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return normalizeSpace(match[1]);
  }
  return "";
}

function resolveOrganizerName(event, html = "") {
  const owner = normalizeSpace(event.owner || "");
  if (owner && !/^\d+$/.test(owner)) return owner;

  const match = String(html).match(/itemprop="name"[^>]*>([^<]+)</);
  const fromHtml = match ? normalizeSpace(match[1]) : "";
  if (fromHtml && !/^\d+$/.test(fromHtml)) return fromHtml;
  return owner;
}

function extractIrregularScheduleNote(rawDetailText, html) {
  const sources = [
    String(rawDetailText || ""),
    htmlFragmentToLines(extractEdescHtml(html)).join("\n"),
  ];
  for (const source of sources) {
    const match = source.match(/本活动[^。；\n]{0,6}(?:长期|不定期)[^。；\n]{0,24}/);
    if (!match) continue;
    return normalizeSpace(match[0]
      .replace(/其他内容[:：]\s*/, "")
      .replace(/，?具体时间请咨询管理员/, ""));
  }
  return "";
}

function buildSignupEntryHint(event, html) {
  const account = extractPublicAccount(html)
    || extractPublicAccount(event.rawDetailText || event.raw_detail_text || "");
  if (account) return `可关注「${account}」公众号报名`;

  const organizer = resolveOrganizerName(event, html);
  if (organizer && !/^\d+$/.test(organizer)) {
    const fee = formatFee(event.fee);
    const action = fee && fee !== "免费" ? "购票报名" : "报名";
    return `可在豆瓣同城搜索本活动并联系发起人「${organizer}」${action}`;
  }
  return "";
}

function extractParticipationHint(rawDetailText) {
  const raw = String(rawDetailText || "").trim();
  if (!raw) return "";

  const lineHints = [];
  for (const line of raw.split(/\n+/)) {
    const text = normalizeSpace(line);
    if (!text || BAD_HINT.test(text)) continue;
    if (/^报名方式[:：]/.test(text)) lineHints.push(text.replace(/^报名方式[:：]\s*/, "报名"));
    else if (/^购票方式[:：]/.test(text)) lineHints.push(text.replace(/^购票方式[:：]\s*/, "可于"));
    else if (/^取票方式[:：]/.test(text)) lineHints.push(`取票方式：${text.replace(/^取票方式[:：]\s*/, "")}`);
    else if (/^报名请/.test(text)) lineHints.push(text);
    else if (/^免费名额[:：]/.test(text) && !/^取票方式/.test(text)) lineHints.push(text);
    else if (/^预约方式[:：]/.test(text)) lineHints.push(text.replace(/^预约方式[:：]\s*/, "预约"));
  }

  if (lineHints.length) {
    return truncateHint(lineHints[0]);
  }

  const inline = [
    raw.match(/报名请[^。\n；]{4,48}/),
    raw.match(/可于[^。\n；]{2,20}(?:购票|报名|预约)/),
  ].find(Boolean);

  return inline && !BAD_HINT.test(inline[0])
    ? truncateHint(normalizeSpace(inline[0]))
    : "";
}

function summarizeEventNotices(notices) {
  const hints = [];
  for (const line of notices) {
    const text = normalizeSpace(line);
    if (!text) continue;
    if (/提前预约|预约后/.test(text)) hints.push("需提前预约后入场");
    else if (/开展时间|开放时间|入场时间/.test(text)) hints.push(text.replace(/[。.]$/, ""));
    else if (/购票后支持退票|支持退票/.test(text)) hints.push("购票后支持退票");
    else if (/另行收费/.test(text)) hints.push("部分体验区另行收费");
    else if (/免费名额|名额有限/.test(text)) hints.push(text);
  }
  return [...new Set(hints)].slice(0, 3);
}

function extractParticipationFromHtml(rawDetailHtml) {
  const html = String(rawDetailHtml || "");
  if (!html) return "";

  const edescLines = htmlFragmentToLines(extractEdescHtml(html));
  for (const line of edescLines) {
    const text = normalizeSpace(line);
    if (BAD_HINT.test(text)) continue;
    if (/^报名方式[:：]/.test(text)) return truncateHint(text.replace(/^报名方式[:：]\s*/, "报名"));
    if (/^购票方式[:：]/.test(text)) return truncateHint(text.replace(/^购票方式[:：]\s*/, "可于"));
    if (/^预约方式[:：]/.test(text)) return truncateHint(text.replace(/^预约方式[:：]\s*/, "预约"));
  }

  return "";
}

function truncateHint(text, max = 80) {
  const value = normalizeSpace(text);
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max).replace(/[，、；：,\s]+$/g, "")}…`;
}

function needsParticipationInfo(event) {
  const fee = formatFee(event.fee);
  const rawDetailHtml = event.rawDetailHtml || event.raw_detail_html || "";
  const text = `${event.title} ${event.owner} ${event.rawDetailText || event.raw_detail_text} ${event.fee}`;
  if (/免费/.test(fee) && !/报名|预约|购票|招募|取票|名额|选座|门票|票价|元|公众号|不定期/.test(text + rawDetailHtml)) {
    return false;
  }
  return Boolean(
    fee
    || resolveTicketChannel(event)
    || buildSignupEntryHint(event, rawDetailHtml)
    || extractParticipationHint(event.rawDetailText || event.raw_detail_text)
    || extractParticipationFromHtml(rawDetailHtml)
    || summarizeEventNotices(extractEventNotices(rawDetailHtml)).length
    || /购票|选座|门票|报名|预约|招募|票价/.test(text),
  );
}

function buildParticipationParagraph(event) {
  if (!needsParticipationInfo(event)) return "";

  const fee = formatFee(event.fee);
  const channel = resolveTicketChannel(event);
  const rawDetailHtml = event.rawDetailHtml || event.raw_detail_html || "";
  const title = String(event.title || "");

  if (channel) {
    const action = /选座/.test(title) ? "购票选座" : channel.action;
    if (fee === "免费") return `可于${channel.name}${action}，免费参加。`;
    if (fee) return `可于${channel.name}${action}，票价${fee}。`;
    return `可于${channel.name}${action}。`;
  }

  const signupEntry = buildSignupEntryHint(event, rawDetailHtml);
  const scheduleNote = extractIrregularScheduleNote(event.rawDetailText || event.raw_detail_text, rawDetailHtml);
  const noticeHints = summarizeEventNotices(extractEventNotices(rawDetailHtml));
  const rawHint = extractParticipationHint(event.rawDetailText || event.raw_detail_text)
    || extractParticipationFromHtml(rawDetailHtml);

  const parts = [];

  if (fee === "免费") {
    parts.push("免费参加");
  } else if (fee) {
    parts.push(`票价${fee}`);
  }

  if (scheduleNote) parts.push(scheduleNote);
  if (signupEntry) parts.push(signupEntry);
  else if (rawHint && !BAD_HINT.test(rawHint)) parts.push(rawHint);

  for (const hint of noticeHints) {
    if (!parts.includes(hint)) parts.push(hint);
  }

  if (!parts.length) {
    if (fee === "免费") return "免费开放，欢迎参加。";
    if (fee) return `票价${fee}，请提前预约或购票后入场。`;
    return "";
  }

  return `${parts.join("，").replace(/，+/g, "，")}。`;
}

const STALE_PARTICIPATION = /报名购票方式请查看活动原始链接|请查看活动原始链接|具体时间请咨询管理员|添加客服了解详情/;

function stripParticipationParagraph(body) {
  const lines = String(body || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "";

  const last = lines[lines.length - 1];
  if (/^(免费参加|免费开放|票价|可于)/.test(last)) {
    return lines.slice(0, -1).join("\n").trim();
  }
  return lines.join("\n").trim();
}

function stripStaleParticipation(body) {
  return stripParticipationParagraph(
    String(body || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line && !STALE_PARTICIPATION.test(line))
      .join("\n")
      .trim(),
  );
}

function appendParticipationToBody(body, event) {
  const participation = buildParticipationParagraph(event);
  const current = stripStaleParticipation(stripParticipationParagraph(body));
  if (!participation) return current;
  if (!current) return participation;
  if (current.includes(participation)) return current;
  return `${current}\n\n${participation}`;
}

function enrichEventBody(event) {
  return appendParticipationToBody(event.body, event);
}

module.exports = {
  appendParticipationToBody,
  buildParticipationParagraph,
  buildSignupEntryHint,
  enrichEventBody,
  extractParticipationFromHtml,
  extractParticipationHint,
  extractPublicAccount,
  formatFee,
  needsParticipationInfo,
  resolveOrganizerName,
  resolveTicketChannel,
  stripStaleParticipation,
};

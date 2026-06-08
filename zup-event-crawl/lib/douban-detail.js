"use strict";

const { appendParticipationToBody } = require("./event-participation");
const {
  decodeHtml,
  extractEdescHtml,
  htmlFragmentToLines,
  normalizeSpace,
} = require("./douban-html");

const DETAIL_NOISE_LINE = /限购|儿童购票|演出\/活动时长|活动时长|禁止携带|寄存说明|发票|订单|票品|退换|平台|购票|售票|实名|入场规则|温馨提示|观演|座位|不可转让|主办方有权|预约说明|付款时效|异常排单|一人一票|无免票政策|退票|改签|门票/;

function cleanDetailText(html) {
  const lines = htmlFragmentToLines(extractEdescHtml(html))
    .map((line) => line
      .replace(/微信号?[:：]?\s*[A-Za-z0-9_-]+/g, "")
      .replace(/添加微信[^，。；\n]*/g, "")
      .replace(/报名请[^，。；\n]*/g, "")
      .trim())
    .filter(Boolean)
    .filter((line) => !DETAIL_NOISE_LINE.test(line));

  return lines
    .join("\n")
    .replace(/[√✔️]+/g, "")
    .trim();
}

function trimSummary(value, maxLength = 110) {
  let text = normalizeSpace(value || "");
  if (!text) return "";
  if (text.length > maxLength) text = text.slice(0, maxLength).replace(/[，、；：,\s]+$/g, "");
  if (!/[。！？]$/.test(text)) text += "。";
  return text;
}

function normalizeDetailSentence(sentence) {
  return normalizeSpace(String(sentence || "")
    .replace(/[“”]/g, "\"")
    .replace(/[ \t]+/g, " ")
    .replace(/^\d+[\.、]\s*/g, "")
    .replace(/^[-*•]\s*/g, "")
    .replace(/^【[^】]{1,20}】/g, "")
    .replace(/^[（(][^)）]{1,20}[)）]/g, "")
    .replace(/^(活动介绍|演出介绍|展览介绍|课程介绍|详情介绍|活动内容|演出内容|展览内容|活动亮点|活动信息)[:：]\s*/g, ""));
}

function extractSectionSummary(detailText, maxLength = 220) {
  const wanted = ["为什么成立", "活动形式", "通常围绕", "活动内容", "活动亮点"];
  const lines = String(detailText || "").split("\n");
  const parts = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].trim();
    if (!/^【[^】]+】$/.test(header)) continue;
    if (!wanted.some((key) => header.includes(key))) continue;

    const bodyLines = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (/^【[^】]+】$/.test(lines[cursor].trim())) break;
      const line = normalizeDetailSentence(lines[cursor]);
      if (line) bodyLines.push(line);
    }

    const chunk = normalizeSpace(bodyLines.join(" "));
    if (chunk.length >= 8) parts.push(chunk);
  }

  if (!parts.length) return "";

  let summary = "";
  for (const part of parts) {
    if ((summary + part).length > maxLength) break;
    summary += part;
  }
  return trimSummary(summary, maxLength);
}

function extractDetailSentences(detailText) {
  const introHeader = /^(展会介绍|活动介绍|演出介绍|展览介绍|课程介绍|项目介绍|内容介绍)[:：]?$/;
  const stopMarkers = /^(展示范围|核心零部件与材料|AI大模型与软件生态|场景解决方案|整机本体|演出曲目|课程安排|购票须知|活动须知|票务须知|注意事项|我们以往探讨过的主题有？|我们希望加一线青年社交站的你)$/;
  const banned = /限购|退票|换票|儿童购票|儿童说明|发票说明|购票证件说明|异常排单|异常购票|付款时效|温馨提示|禁止携带|预约说明|一人一票|无需实名制购票|电子发票|票品|订单|观演|须持票|请勿|客服|添加微信|微信|扫码|联系电话|联系方式|组委会|手机号|合作伙伴|最终解释权|入场方式说明|入场时间|演出\/活动时长|最低演出曲目|最低演出\/活动时长|主要演员|以现场为准|无需预约|未成年人|儿童谢绝入场|指定区域入座|家庭票至多携|停止检票|名单公布|免费名额|观影时间|观影地点|取票时间|取票方式|报名规则|场次信息|限定福利|活动要求|关于破浪|特殊提示|参观须知|限一次入场|周一闭馆|请确认好所购时间及场次|退场后禁止再次入场|不可更换|不可延期|不可退款|注意：本链接售票|中奖|黑名单|转票|学生票|先到先得|换纸质门票|路线指引|禁止入内|不可携带|购票时请确认|官方公众号|活动地址|其他内容|讲素质|禁止辱骂/;
  const lines = String(detailText || "").split(/\n+/).map((line) => normalizeDetailSentence(line)).filter(Boolean);
  if (!lines.length) return [];

  const hasIntro = lines.some((line) => introHeader.test(line));
  const firstMeaningful = lines[0] || "";
  if (!hasIntro && /^(【场次信息】|【报名规则】|💡注意|Note:|限购说明|退票\/换票政策|入场方式说明|演出\/活动时长|入场时间|观影时间|免费名额|取票时间|名单公布)/.test(firstMeaningful)) {
    return [];
  }

  const kept = [];
  let started = !hasIntro;
  for (const line of lines) {
    if (introHeader.test(line)) {
      started = true;
      continue;
    }
    if (!started) continue;
    if (stopMarkers.test(line) && kept.length > 0) break;
    if (/^(时间|地点|费用|票价|发起|主办|报名方式|活动时间|活动地点|活动费用)[:：]/.test(line)) continue;
    if (/^[A-Z0-9\s\-:()&/.]{8,}$/.test(line)) continue;
    if (banned.test(line)) continue;
    kept.push(line);
    if (kept.length >= 8) break;
  }

  return kept
    .join(" ")
    .split(/(?<=[。！？])/)
    .map((line) => normalizeSpace(line))
    .filter(Boolean)
    .filter((line) => line.length >= 12)
    .filter((line) => !banned.test(line));
}

function makeZupSummary(event) {
  const detailText = event.detailText || event.rawDetailText || "";
  const clean = detailText
    .replace(event.title || "", "")
    .replace(/时间[:：][^。；\n]+/g, "")
    .replace(/地点[:：][^。；\n]+/g, "")
    .replace(/费用[:：][^。；\n]+/g, "")
    .replace(/具体[^。]*以现场为准/g, "")
    .replace(/详情[^。]*以原始链接为准/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  let summary = extractSectionSummary(clean, 220);
  const sentences = extractDetailSentences(clean);
  if (!summary && sentences.length) {
    for (const sentence of sentences) {
      if ((summary + sentence).length > 220) break;
      summary += sentence;
    }
    summary = trimSummary(summary, 220);
  }
  return appendParticipationToBody(summary, event);
}

function rebuildDetailFields(event) {
  const html = event.rawDetailHtml || event.raw_detail_html || "";
  const detailText = html ? cleanDetailText(html) : (event.rawDetailText || event.raw_detail_text || "");
  const nextEvent = {
    ...event,
    detailText,
    rawDetailText: detailText,
    rawDetailHtml: html,
  };
  return {
    rawDetailText: detailText || null,
    body: makeZupSummary(nextEvent) || null,
  };
}

module.exports = {
  cleanDetailText,
  decodeHtml,
  extractDetailSentences,
  extractSectionSummary,
  extractEdescHtml,
  makeZupSummary,
  normalizeSpace,
  rebuildDetailFields,
};

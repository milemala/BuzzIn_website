"use strict";

const { appendParticipationToBody } = require("./event-participation");
const {
  decodeHtml,
  extractEdescHtml,
  extractEventNoticeHtml,
  htmlFragmentToLines,
  normalizeSpace,
} = require("./douban-html");

const DETAIL_NOISE_LINE = /限购|儿童购票|演出\/活动时长|活动时长|禁止携带|寄存说明|发票|订单|票品|退换|平台|购票|售票|实名|入场规则|温馨提示|观演|座位|不可转让|主办方有权|预约说明|付款时效|异常排单|一人一票|无免票政策|退票|改签|门票/;
const LOGISTICS_LINE = /^(▏|︱)?\s*(活动时间|活动地点|活动嘉宾|主办方|报名方式|时间|地点|费用|票价)[:：]|^▏|请点击海报报名|报名方式[:：]/;
const TICKET_LINE = /^[√✔️]|^√|演出\/活动时长|限购说明|退票|儿童说明|儿童购票|发票说明|异常购票|禁止携带|付款时效|实名制|限购说明|退换政策|入场规则|以现场为准|最低演出|主要演员|预约说明|特殊提示|票品为有价/i;
const INTRO_STOP_LINE = /^嘉\s*\|\s*宾|图\s*\|\s*书|嘉宾介绍|图书介绍|书目信息|展示范围|课程安排|购票须知|报名规则|场次信息|活动要求|关于破浪/;

function cleanDetailLines(fragment) {
  return htmlFragmentToLines(fragment)
    .map((line) => line
      .replace(/微信号?[:：]?\s*[A-Za-z0-9_-]+/g, "")
      .replace(/添加微信[^，。；\n]*/g, "")
      .replace(/报名请[^，。；\n]*/g, "")
      .trim())
    .filter(Boolean)
    .filter((line) => !DETAIL_NOISE_LINE.test(line));
}

/** 合并详情页各区块纯文本（活动须知 + edesc_s），存储与提炼均不再区分板块 */
function cleanDetailText(html) {
  const source = String(html || "");
  const noticeLines = cleanDetailLines(extractEventNoticeHtml(source));
  const edescLines = cleanDetailLines(extractEdescHtml(source));
  const merged = [];
  const seen = new Set();
  for (const line of [...noticeLines, ...edescLines]) {
    const key = normalizeSpace(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }
  return merged
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

function isTitleRepeatLine(line, title) {
  const t = normalizeSpace(title);
  const l = normalizeSpace(line);
  if (!t || !l || t.length < 6) return false;
  if (l === t) return true;
  const head = t.slice(0, Math.min(t.length, 24));
  return l.startsWith(head) && l.length <= t.length + 48;
}

const TICKET_HINT = /电子发票|订单详情|购票页面|票品为有价|未成年人|专业摄录设备|猫眼客服|异常购票|付款时效|限购说明|入场规则|以现场为准|下单成功后需在指定时间内完成支付/i;

function isTicketBoilerplateText(detailText) {
  const lines = String(detailText || "").split(/\n+/).map(normalizeDetailSentence).filter(Boolean);
  if (!lines.length) return true;

  const ticketish = lines.filter((line) => TICKET_LINE.test(line) || TICKET_HINT.test(line));
  if (ticketish.length >= 2 || (lines.length >= 3 && ticketish.length / lines.length >= 0.45)) {
    return true;
  }

  const substantive = lines.filter((line) => (
    !TICKET_LINE.test(line)
    && !TICKET_HINT.test(line)
    && !LOGISTICS_LINE.test(line)
    && line.length >= 16
    && /[。！？，；]/.test(line)
  ));
  return substantive.length === 0;
}

function isWeakSummary(summary) {
  const text = normalizeSpace(summary);
  if (!text || text.length < 16) return true;
  if (/▏|︱/.test(text) && /活动时间|活动地点|活动嘉宾|主办方/.test(text)) return true;
  if (/^(90分钟|\d+分钟)|实名制购票|退换政策|入场规则/.test(text)) return true;
  if (TICKET_HINT.test(text)) return true;
  if (TICKET_LINE.test(text) && text.length < 120) return true;
  return false;
}

/** 从合并后的全文提炼介绍句，不区分活动须知/活动详情 */
function extractIntroSentences(detailText, event = {}) {
  const title = String(event.title || "");
  const lines = String(detailText || "").split(/\n+/).map(normalizeDetailSentence).filter(Boolean);
  const kept = [];

  for (const line of lines) {
    if (INTRO_STOP_LINE.test(line) && kept.length > 0) break;
    if (LOGISTICS_LINE.test(line)) continue;
    if (TICKET_LINE.test(line)) continue;
    if (isTitleRepeatLine(line, title)) continue;
    if (/^Hi[～~]|徽章一枚|进群|扫码|影迷群|周边领取/.test(line) && !kept.length) continue;
    if (/^！！！|请注意/.test(line)) continue;
    if (/^【场次|【报名规则】|名单公布/.test(line)) continue;
    if (/^\d+号厅/.test(line)) continue;
    if (line.length < 12 && !/[。！？]/.test(line)) continue;
    kept.push(line);
    if (kept.length >= 6) break;
  }

  const banned = /号厅|观影 取票|报名规则|抽奖|黑名单|转票|取票时间|观影时间/;
  return kept
    .join(" ")
    .split(/(?<=[。！？])/)
    .map((line) => normalizeSpace(line))
    .filter(Boolean)
    .filter((line) => line.length >= 12)
    .filter((line) => !TICKET_LINE.test(line) && !LOGISTICS_LINE.test(line) && !banned.test(line));
}

function extractDetailSentences(detailText, event = {}) {
  return extractIntroSentences(detailText, event);
}

function splitTitleSegments(title) {
  return String(title || "")
    .split(/[｜|/／+]+/)
    .map(normalizeSpace)
    .filter(Boolean);
}

function extractPlaceFromLocation(event) {
  const location = normalizeSpace(event.location || "");
  if (!location) return "";
  const tokens = location.split(/\s+/).map((t) => t.replace(/[（(].*$/, "").trim()).filter(Boolean);
  const venue = tokens.find((part) => /剧场|剧院|酒吧|咖啡|喜剧|Live|影城|艺术馆|美术馆|博物馆|共享际|商场|广场|书店|书|中心|餐吧|小剧场|俱乐部|体育馆|游泳馆|公园/i.test(part));
  if (venue && venue.length <= 28) return venue;
  if (tokens.length >= 3) return tokens[2];
  return "";
}

/** 详情无实质介绍时，根据标题/场地/分类拼一段发布型简介（不是复述标题） */
function inferSummaryFromTitle(event, maxLength = 220) {
  const title = normalizeSpace(event.title || "");
  if (!title || title.length < 8) return "";

  const segments = splitTitleSegments(title);
  const category = normalizeSpace(event.category || "");
  const brand = segments.find((part) => /喜剧|剧场|剧社|俱乐部|Club|Live|酒吧|酒馆|脱口秀|话筒/i.test(part) && part.length <= 28)
    || segments[segments.length - 1]
    || "";

  const isEnglish = /英语|英文|English/i.test(title);
  const isShanghai = /沪语|上海话/i.test(title);
  const isMandarin = /普通话|中文/i.test(title);
  const isOpenMic = /Open\s*Mic|开放麦/i.test(title);
  const isHeadliner = /Headliner/i.test(title);
  const isAdvanced = /进阶/.test(title);
  const isSpecial = /专场|精品秀/.test(title);
  const isTalkShow = /脱口秀|相声|sketch|Sketch|即兴/i.test(title);

  let formatLabel = "";
  if (isEnglish && isOpenMic) formatLabel = "英语开放麦";
  else if (isOpenMic) formatLabel = "开放麦";
  else if (/相声/.test(title)) formatLabel = "相声";
  else if (/脱口秀/.test(title)) formatLabel = "脱口秀";
  else if (/音乐剧|话剧|舞剧/.test(title)) formatLabel = title.match(/音乐剧|话剧|舞剧/)[0];
  else if (/观影|电影|影展/.test(title)) formatLabel = "观影活动";
  else if (/展览|美术馆|博物馆/.test(title)) formatLabel = "展览";
  else if (/沙龙|分享会|签售|新书/.test(title)) formatLabel = "沙龙分享";
  else if (category === "喜剧脱口秀") formatLabel = "脱口秀";

  if (isAdvanced && formatLabel) formatLabel += "进阶场";
  else if (isSpecial && formatLabel) formatLabel += "专场";

  let langNote = "";
  if (isEnglish && !formatLabel.includes("英语")) langNote = "英语";
  else if (isShanghai) langNote = "沪语";
  else if (isMandarin) langNote = "普通话";

  const place = extractPlaceFromLocation(event);
  const formatWithLang = `${langNote}${formatLabel}`.replace(/的的/g, "的");
  const clauses = [];

  if (brand && formatLabel && place) {
    clauses.push(`${brand}在${place}举办${formatWithLang}`);
  } else if (brand && formatLabel) {
    clauses.push(`${brand}带来${formatWithLang}`);
  } else if (formatLabel && place) {
    clauses.push(`${place}举办${formatWithLang}`);
  } else if (formatLabel) {
    clauses.push(formatWithLang);
  } else if (brand && place) {
    clauses.push(`${brand}在${place}举办活动`);
  } else if (brand) {
    clauses.push(`${brand}线下活动`);
  } else {
    clauses.push(title.replace(/[！!…]+$/g, "").slice(0, 48));
  }

  if (isHeadliner) clauses.push("当晚设 Headliner 压轴");
  if (isEnglish && isOpenMic) clauses.push("段子以英语呈现，开放麦可上台试段");
  else if (isOpenMic) clauses.push("设有开放麦环节，欢迎上台试段");
  else if (isShanghai && isTalkShow) clauses.push("演出以沪语为主");
  else if (isMandarin && isTalkShow) clauses.push("普通话演出");
  else if (/观影|电影|影展/.test(title)) clauses.push("现场放映");
  else if (/签售/.test(title)) clauses.push("含签售环节");
  else if (/新书|沙龙|分享会/.test(title)) clauses.push("嘉宾到场对谈交流");
  else if (/展览|美术馆|博物馆/.test(title)) clauses.push("现场看展");
  else if (/徒步|Citywalk/.test(title)) clauses.push("结伴同行");
  else if (/露营/.test(title)) clauses.push("户外露营体验");

  return trimSummary(`${clauses.join("，")}。`, maxLength);
}

function buildTitleFallbackSummary(event, maxLength = 220) {
  return inferSummaryFromTitle(event, maxLength);
}

function makeZupIntro(event, maxLength = 220) {
  const detailText = event.detailText || event.rawDetailText || "";
  const clean = detailText
    .replace(/时间[:：][^。；\n]+/g, "")
    .replace(/地点[:：][^。；\n]+/g, "")
    .replace(/费用[:：][^。；\n]+/g, "")
    .replace(/具体[^。]*以现场为准/g, "")
    .replace(/详情[^。]*以原始链接为准/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();

  let summary = extractSectionSummary(clean, maxLength);

  if (!summary && !isTicketBoilerplateText(detailText)) {
    const sentences = extractIntroSentences(detailText, event);
    for (const sentence of sentences) {
      if ((summary + sentence).length > maxLength) break;
      summary += sentence;
    }
    summary = trimSummary(summary, maxLength);
  }

  if (!summary || isWeakSummary(summary) || isTicketBoilerplateText(detailText)) {
    summary = buildTitleFallbackSummary(event, maxLength);
  }

  return summary;
}

function makeZupSummary(event) {
  return appendParticipationToBody(makeZupIntro(event), event);
}

function matchMicroAddress(html, prop) {
  const spanMatch = html.match(new RegExp(`<span[^>]*itemprop="${prop}"[^>]*>([\\s\\S]*?)<\\/span>`, "i"));
  if (spanMatch) return normalizeSpace(decodeHtml(spanMatch[1]));
  const metaMatch = html.match(new RegExp(`itemprop="${prop}"[^>]*content="([^"]+)"`, "i"));
  if (metaMatch) return normalizeSpace(decodeHtml(metaMatch[1]));
  return "";
}

function parseDoubanEventLocation(detailHtml) {
  const html = String(detailHtml || "");
  if (!html) return null;

  const region = matchMicroAddress(html, "region");
  const locality = matchMicroAddress(html, "locality");
  const street = matchMicroAddress(html, "street-address");

  let latitude = null;
  let longitude = null;
  const latMatch = html.match(/itemprop="latitude"\s+content="([^"]+)"/);
  const lngMatch = html.match(/itemprop="longitude"\s+content="([^"]+)"/);
  if (latMatch) latitude = Number(latMatch[1]);
  if (lngMatch) longitude = Number(lngMatch[1]);
  if (!Number.isFinite(latitude)) latitude = null;
  if (!Number.isFinite(longitude)) longitude = null;

  let location = "";
  if (region || locality || street) {
    location = [region, locality, street].filter(Boolean).join(" ");
  }
  if (!location) {
    const mapMatch = html.match(/_event_map_\s*=\s*\{[\s\S]*?address:\s*'((?:\\'|[^'])*)'/);
    if (mapMatch) location = mapMatch[1].replace(/\\'/g, "'");
  }
  if (!location) return null;

  return {
    location: normalizeSpace(location),
    district: locality || "",
    latitude,
    longitude,
  };
}

/** 从详情页解析完整活动时间（优先 calendar-str-item 多场次列表） */
function parseDoubanEventTime(detailHtml) {
  const html = String(detailHtml || "");
  if (!html) return null;

  const sessions = [];
  for (const match of html.matchAll(/<li[^>]*class="[^"]*calendar-str-item[^"]*"[^>]*>([\s\S]*?)<\/li>/gi)) {
    const text = normalizeSpace(decodeHtml(String(match[1]).replace(/<[^>]+>/g, "")));
    if (text) sessions.push(text);
  }

  const startDates = [...html.matchAll(/itemprop="startDate"\s+datetime="([^"]+)"/g)].map((m) => m[1]);
  const endDates = [...html.matchAll(/itemprop="endDate"\s+datetime="([^"]+)"/g)].map((m) => m[1]);
  const startDate = startDates[0] || null;
  const endDate = endDates[endDates.length - 1] || endDates[0] || startDate || null;

  let timeText = "";
  if (sessions.length === 1) timeText = sessions[0];
  else if (sessions.length > 1) timeText = sessions.join(" / ");

  return {
    timeText,
    startDate,
    endDate,
    sessions,
  };
}

function applyDoubanEventTime(event, detailHtml) {
  const parsed = parseDoubanEventTime(detailHtml);
  if (!parsed) return event;
  if (parsed.timeText) event.timeText = parsed.timeText;
  if (parsed.startDate) event.startDate = parsed.startDate;
  if (parsed.endDate) event.endDate = parsed.endDate;
  return event;
}

function applyDoubanEventLocation(event, detailHtml, cityName = "") {
  const parsed = parseDoubanEventLocation(detailHtml);
  if (!parsed) return event;
  if (!event.location) event.location = parsed.location;
  if (!event.district) {
    const districtFromLocation = parsed.location
      .replace(new RegExp(`^${cityName}\\s*`), "")
      .split(/\s+/)[0] || "";
    event.district = parsed.district || districtFromLocation;
  }
  if (!Number.isFinite(Number(event.latitude)) && parsed.latitude != null) {
    event.latitude = parsed.latitude;
  }
  if (!Number.isFinite(Number(event.longitude)) && parsed.longitude != null) {
    event.longitude = parsed.longitude;
  }
  return event;
}

function rebuildDetailFields(event) {
  return rebuildEventDerivedFields(event);
}

/** 从已存详情 HTML 重算：完整原文、简介、详情页时间 */
function rebuildEventDerivedFields(event) {
  const { buildEventDates } = require("./event-dates");
  const html = event.rawDetailHtml || event.raw_detail_html || "";
  const detailText = html ? cleanDetailText(html) : (event.rawDetailText || event.raw_detail_text || "");
  const nextEvent = {
    ...event,
    detailText,
    rawDetailText: detailText,
    rawDetailHtml: html,
  };
  if (html) applyDoubanEventTime(nextEvent, html);

  const eventDates = nextEvent.startDate && nextEvent.endDate
    ? buildEventDates(nextEvent.startDate, nextEvent.endDate, { fromToday: false })
    : (event.eventDates || []);

  return {
    rawDetailText: detailText || null,
    body: makeZupIntro(nextEvent) || null,
    timeText: nextEvent.timeText || null,
    startDate: nextEvent.startDate || null,
    endDate: nextEvent.endDate || null,
    eventDates,
  };
}

module.exports = {
  applyDoubanEventLocation,
  applyDoubanEventTime,
  cleanDetailText,
  decodeHtml,
  extractDetailSentences,
  extractSectionSummary,
  extractEdescHtml,
  makeZupIntro,
  makeZupSummary,
  normalizeSpace,
  parseDoubanEventLocation,
  parseDoubanEventTime,
  inferSummaryFromTitle,
  rebuildDetailFields,
  rebuildEventDerivedFields,
};

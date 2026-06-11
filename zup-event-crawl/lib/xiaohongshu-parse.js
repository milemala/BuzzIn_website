"use strict";

/** 从 Chrome 抓到的 XHS 页面 HTML 里解析 window.__INITIAL_STATE__ */
function parseInitialState(html) {
  const match = String(html || "").match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].replace(/undefined/g, "null"));
  } catch (error) {
    return null;
  }
}

function normalizeNoteCard(entry) {
  const card = entry?.noteCard || {};
  return {
    noteId: entry?.id || card?.noteId || card?.id || "",
    title: card.displayTitle || card.title || card.desc || "",
    xsecToken: entry?.xsecToken || card?.xsecToken || "",
    type: card.type || entry?.type || "normal",
  };
}

/** 个人页前 N 条笔记（需已登录 Chrome 抓到的 profile HTML） */
function parseProfileNotes(html, limit = 10) {
  const state = parseInitialState(html);
  const raw = state?.user?.notes?.[0];
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, limit).map(normalizeNoteCard).filter((n) => n.noteId);
}

const WEEKLY_TITLE_RE =
  /(?:本周|这周|下周|一周|周末).{0,30}(?:活动汇总|活动合集|活动指南|可做的?\d*件事)|(?:活动汇总|活动合集).{0,30}(?:本周|这周|下周|一周|周末)|(?:本周|这周).{0,10}\d+件事/;

const THIS_OR_NEXT_WEEK_RE = /本周|这周|下周|一周|周末|本周末/;
const ROUNDUP_KEYWORD_RE = /活动汇总|活动合集|活动指南|活动清单|可做的?\d*件事|一周活动|活动合集/;
const MONTH_ROUNDUP_RE = /活动汇总|活动清单|活动合集|市集活动|活动攻略|值得一去|活动指南|展览排期|新展/;

/** 从标题里解析日期区间：6.8-6.14、（6.08-6.14）、6月8日-14日、(6.9-14) 等 */
function parseTitleDateRange(title) {
  const text = String(title || "");
  const patterns = [
    { re: /[（(【\[]?(\d{1,2})月(\d{1,2})日\s*[-–—~至]\s*(\d{1,2})月(\d{1,2})日[）)】\]]?/, groups: [1, 2, 3, 4] },
    { re: /[（(【\[]?(\d{1,2})月(\d{1,2})日\s*[-–—~至]\s*(\d{1,2})日[）)】\]]?/, groups: [1, 2, 1, 3] },
    { re: /[（(【\[]?(\d{1,2})\.(\d{1,2})\s*[-–—~至]\s*(\d{1,2})\.(\d{1,2})[）)】\]]?/, groups: [1, 2, 3, 4] },
    { re: /[（(【\[]?(\d{1,2})\.(\d{1,2})\s*[-–—~至]\s*(\d{1,2})[）)】\]]?/, groups: [1, 2, 1, 3] },
    { re: /(\d{1,2})\.(\d{1,2})\s*[-–—~至]\s*(\d{1,2})\.(\d{1,2})(?:\s*$|[^\d])/, groups: [1, 2, 3, 4] },
  ];
  for (const { re, groups } of patterns) {
    const m = text.match(re);
    if (m) {
      return {
        startMonth: Number(m[groups[0]]),
        startDay: Number(m[groups[1]]),
        endMonth: Number(m[groups[2]]),
        endDay: Number(m[groups[3]]),
      };
    }
  }
  return null;
}

function dateInRange(range, refDate = new Date()) {
  if (!range) return false;
  const year = refDate.getFullYear();
  const start = new Date(year, range.startMonth - 1, range.startDay);
  let end = new Date(year, range.endMonth - 1, range.endDay, 23, 59, 59);
  if (end < start) end = new Date(year + 1, range.endMonth - 1, range.endDay, 23, 59, 59);
  return refDate >= start && refDate <= end;
}

function isWeekRoundupTitle(title) {
  const text = String(title || "");
  if (!THIS_OR_NEXT_WEEK_RE.test(text)) return false;
  return WEEKLY_TITLE_RE.test(text)
    || ROUNDUP_KEYWORD_RE.test(text)
    || parseTitleDateRange(text) != null
    || /件事/.test(text);
}

function isMonthRoundupTitle(title, refDate = new Date()) {
  const text = String(title || "");
  if (/本周|这周|下周/.test(text)) return false;
  if (!MONTH_ROUNDUP_RE.test(text)) return false;
  const month = refDate.getMonth() + 1;
  if (new RegExp(`(?:^|[^\\d])${month}月`).test(text)) return true;
  return /\d{1,2}月/.test(text);
}

function rangeEndTime(range, refDate = new Date()) {
  if (!range) return 0;
  const year = refDate.getFullYear();
  let end = new Date(year, range.endMonth - 1, range.endDay, 23, 59, 59);
  const start = new Date(year, range.startMonth - 1, range.startDay);
  if (end < start) end = new Date(year + 1, range.endMonth - 1, range.endDay, 23, 59, 59);
  return end.getTime();
}

function rangeStartTime(range, refDate = new Date()) {
  if (!range) return 0;
  const year = refDate.getFullYear();
  return new Date(year, range.startMonth - 1, range.startDay).getTime();
}

function isRangeExpired(range, refDate = new Date()) {
  if (!range) return false;
  return rangeEndTime(range, refDate) < refDate.getTime();
}

function pickBestCandidate(candidates, refDate = new Date()) {
  const withRange = candidates.map((n) => ({
    ...n,
    range: parseTitleDateRange(n.title),
  }));

  const covering = withRange.find((n) => dateInRange(n.range, refDate));
  if (covering) return covering;

  const nextWeek = withRange.find((n) => /下周/.test(n.title));
  if (nextWeek) return nextWeek;

  const active = withRange.filter((n) => !isRangeExpired(n.range, refDate));
  const pool = active.length ? active : withRange;

  const withFutureRange = pool.filter((n) => n.range && rangeStartTime(n.range, refDate) >= refDate.getTime());
  if (withFutureRange.length) {
    return withFutureRange.sort((a, b) => rangeStartTime(a.range, refDate) - rangeStartTime(b.range, refDate))[0];
  }

  return pool.sort((a, b) => {
    const score = (n) => (n.range ? n.range.startMonth * 100 + n.range.startDay : 0);
    return score(b) - score(a);
  })[0];
}

/**
 * 在前 N 条里选汇总帖：
 * 1. 本周/下周活动汇总（含日期区间或「可做的 N 件事」）
 * 2. 整月活动汇总（如「6月值得一去的市集活动」）
 * 3. 无合适帖子 → null（调用方应跳过该城）
 */
function pickWeeklyRoundupNote(notes, refDate = new Date()) {
  const weekCandidates = notes.filter((n) => isWeekRoundupTitle(n.title));
  if (weekCandidates.length) {
    const picked = pickBestCandidate(weekCandidates, refDate);
    if (picked) return { ...picked, pickTier: "week" };
  }

  const monthCandidates = notes.filter((n) => isMonthRoundupTitle(n.title, refDate));
  if (monthCandidates.length) {
    const picked = pickBestCandidate(monthCandidates, refDate);
    if (picked) return { ...picked, pickTier: "month" };
  }

  return null;
}

function parseNoteDetailFromHtml(html, noteId) {
  const state = parseInitialState(html);
  const map = state?.note?.noteDetailMap || {};
  if (map[noteId]?.note) return map[noteId].note;
  const firstKey = Object.keys(map).find((k) => k !== "null" && map[k]?.note);
  return firstKey ? map[noteId]?.note || map[firstKey].note : null;
}

/** 把正文 desc 里的编号列表拆成活动名（不含图片里的时间地点） */
function parseEventsFromDesc(desc) {
  const text = String(desc || "");
  const sections = [];
  const sectionRe = /【([^】]+)】\s*([\s\S]*?)(?=【[^】]+】|$)/g;
  let sm;
  while ((sm = sectionRe.exec(text)) !== null) {
    const category = sm[1].trim();
    const body = sm[2];
    const items = [];
    const itemRe = /^\s*\d+[、.．]\s*(.+)$/gm;
    let im;
    while ((im = itemRe.exec(body)) !== null) {
      const name = im[1].replace(/[话题]#.*$/, "").trim();
      if (name && !/主页合集|综合整理/.test(name)) items.push(name);
    }
    if (items.length) sections.push({ category, items });
  }
  return sections;
}

function buildNoteExploreUrl(noteId, xsecToken) {
  const base = `https://www.xiaohongshu.com/explore/${noteId}`;
  if (!xsecToken) return base;
  const qs = new URLSearchParams({ xsec_token: xsecToken, xsec_source: "pc_user" });
  return `${base}?${qs}`;
}

module.exports = {
  WEEKLY_TITLE_RE,
  buildNoteExploreUrl,
  dateInRange,
  isMonthRoundupTitle,
  isWeekRoundupTitle,
  normalizeNoteCard,
  parseEventsFromDesc,
  parseInitialState,
  parseNoteDetailFromHtml,
  parseProfileNotes,
  parseTitleDateRange,
  pickWeeklyRoundupNote,
};

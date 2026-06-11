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

const WEEKLY_TITLE_RE = /(?:本周|一周|周末).{0,8}活动汇总|活动汇总.*(?:本周|一周|周末)/;

/** 从标题里解析 (M.D-M.D) 或 （M.D-M.D）日期区间 */
function parseTitleDateRange(title) {
  const m = String(title || "").match(/[（(](\d{1,2})\.(\d{1,2})\s*[-–—~至]\s*(\d{1,2})\.(\d{1,2})[）)]/);
  if (!m) return null;
  return {
    startMonth: Number(m[1]),
    startDay: Number(m[2]),
    endMonth: Number(m[3]),
    endDay: Number(m[4]),
  };
}

function dateInRange(range, refDate = new Date()) {
  if (!range) return false;
  const year = refDate.getFullYear();
  const start = new Date(year, range.startMonth - 1, range.startDay);
  let end = new Date(year, range.endMonth - 1, range.endDay, 23, 59, 59);
  if (end < start) end = new Date(year + 1, range.endMonth - 1, range.endDay, 23, 59, 59);
  return refDate >= start && refDate <= end;
}

/**
 * 在前 N 条里找「本周活动汇总」帖。
 * 优先：标题含活动汇总 + 日期区间覆盖今天；其次：标题含活动汇总且日期最近。
 */
function pickWeeklyRoundupNote(notes, refDate = new Date()) {
  const candidates = notes.filter((n) => WEEKLY_TITLE_RE.test(n.title));
  if (!candidates.length) return null;

  const withRange = candidates.map((n) => ({
    ...n,
    range: parseTitleDateRange(n.title),
  }));

  const covering = withRange.find((n) => dateInRange(n.range, refDate));
  if (covering) return covering;

  return withRange.sort((a, b) => {
    const score = (n) => (n.range ? n.range.startMonth * 100 + n.range.startDay : 0);
    return score(b) - score(a);
  })[0];
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
  normalizeNoteCard,
  parseEventsFromDesc,
  parseInitialState,
  parseNoteDetailFromHtml,
  parseProfileNotes,
  parseTitleDateRange,
  pickWeeklyRoundupNote,
};

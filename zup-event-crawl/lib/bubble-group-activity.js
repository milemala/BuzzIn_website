"use strict";

const { BuzzAdminClient } = require("./buzz-now-import");
const { createBuzzClientOptions, normalizeBuzzEnv } = require("./buzz-env");
const { getGroupInfoBatch, getGroupMessages } = require("./tencent-im-group");

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const IM_BATCH_SIZE = 50;
const IM_DELAY_MS = 100;
const MSG_FETCH_LIMIT = 30;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 80;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatChinaDate(tsSec) {
  const d = new Date(Number(tsSec) * 1000 + CHINA_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function parseChinaDayStart(day) {
  const text = String(day || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw new Error(`日期格式应为 YYYY-MM-DD：${text}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const utcMs = Date.UTC(year, month - 1, date, 0, 0, 0) - CHINA_OFFSET_MS;
  return Math.floor(utcMs / 1000);
}

function parseDayRange(dateFrom, dateTo) {
  const from = String(dateFrom || "").trim();
  const to = String(dateTo || "").trim() || from;
  if (!from) throw new Error("请选择开始日期");
  const startTs = parseChinaDayStart(from);
  const endTs = parseChinaDayStart(to) + 24 * 60 * 60;
  if (endTs <= startTs) throw new Error("结束日期不能早于开始日期");
  return { date_from: from, date_to: to, start_ts: startTs, end_ts: endTs };
}

function inRange(ts, startTs, endTs) {
  const value = Number(ts || 0);
  return value >= startTs && value < endTs;
}

function isSystemAccount(account) {
  const id = String(account || "").trim();
  return !id || id === "@TIM#SYSTEM";
}

function isUserSpeakMessage(msg) {
  const from = String(msg?.From_Account || "");
  if (isSystemAccount(from)) return false;
  const bodies = Array.isArray(msg?.MsgBody) ? msg.MsgBody : (msg?.MsgBody ? [msg.MsgBody] : []);
  for (const body of bodies) {
    if (body?.MsgType === "TIMTextElem") return true;
    if (body?.MsgType === "TIMImageElem" || body?.MsgType === "TIMSoundElem" || body?.MsgType === "TIMVideoFileElem") {
      return true;
    }
    if (body?.MsgType === "TIMCustomElem") {
      const data = String(body?.MsgContent?.Data || "");
      if (data.includes("group_create")) return false;
      if (data.trim()) return true;
    }
  }
  return false;
}

function analyzeJoiners(groupInfo, range, ownerId) {
  const owner = String(ownerId || groupInfo?.Owner_Account || "").trim();
  const members = groupInfo?.MemberList || [];
  const joiners = [];
  for (const member of members) {
    const uid = String(member?.Member_Account || "").trim();
    if (!uid || uid === owner) continue;
    if (!inRange(member.JoinTime, range.start_ts, range.end_ts)) continue;
    joiners.push({
      user_id: uid,
      join_time: Number(member.JoinTime || 0),
      join_date: formatChinaDate(member.JoinTime),
    });
  }
  return joiners;
}

function analyzeSpeakers(messages, range, ownerId) {
  const owner = String(ownerId || "").trim();
  const speakers = new Map();
  for (const msg of messages || []) {
    const from = String(msg?.From_Account || "").trim();
    if (!from || from === owner || isSystemAccount(from)) continue;
    if (!inRange(msg.MsgTimeStamp, range.start_ts, range.end_ts)) continue;
    if (!isUserSpeakMessage(msg)) continue;
    if (!speakers.has(from)) {
      speakers.set(from, {
        user_id: from,
        message_count: 0,
        last_speak_time: Number(msg.MsgTimeStamp || 0),
        last_speak_date: formatChinaDate(msg.MsgTimeStamp),
      });
    }
    const row = speakers.get(from);
    row.message_count += 1;
    if (Number(msg.MsgTimeStamp || 0) >= row.last_speak_time) {
      row.last_speak_time = Number(msg.MsgTimeStamp || 0);
      row.last_speak_date = formatChinaDate(msg.MsgTimeStamp);
    }
  }
  return [...speakers.values()];
}

function needsMessageScan(groupInfo, range) {
  const nextSeq = Number(groupInfo?.NextMsgSeq || 1);
  if (nextSeq <= 2) return false;
  const lastMsg = Number(groupInfo?.LastMsgTime || 0);
  if (inRange(lastMsg, range.start_ts, range.end_ts)) return true;
  for (const member of groupInfo?.MemberList || []) {
    if (inRange(member?.LastSendMsgTime, range.start_ts, range.end_ts)) return true;
  }
  return false;
}

async function fetchActiveNowsWithGroups(client, options = {}) {
  const rows = [];
  const crawledIds = options.crawled_now_ids instanceof Set ? options.crawled_now_ids : null;
  let page = 1;
  while (page <= LIST_MAX_PAGES) {
    const body = {
      page,
      size: LIST_PAGE_SIZE,
      expired: 0,
    };
    const data = await client.postJSON("/nows/list", body);
    const list = data?.list || [];
    if (!list.length) break;
    for (const item of list) {
      const groupId = String(item.group_id || "").trim();
      if (!groupId) continue;
      const nowId = String(item.now_id || "").trim();
      if (crawledIds && !crawledIds.has(nowId)) continue;
      rows.push({
        now_id: nowId,
        now_title: String(item.now_title || "").trim(),
        group_id: groupId,
        group_name: String(item.now_title || "").trim(),
        created_at: item.created_at || "",
        expired_at: item.expired_at || "",
        publish_user_id: String(item.user?.user_id || "").trim(),
        city: String(item.location_name || "").trim(),
      });
    }
    const total = Number(data?.pagination?.total || 0);
    if (list.length < LIST_PAGE_SIZE || (total > 0 && rows.length >= total)) break;
    page += 1;
  }
  return rows;
}

function buildCrawledNowIdSet(db, buzzEnv) {
  if (!db) return null;
  const env = normalizeBuzzEnv(buzzEnv);
  const rows = db.prepare(`
    SELECT buzz_id
    FROM buzz_imports
    WHERE entity_kind = 'event'
      AND buzz_env = @env
      AND buzz_id != ''
      AND import_status = 'imported'
  `).all({ env });
  return new Set(rows.map((row) => String(row.buzz_id)));
}

async function queryBubbleGroupActivity(options = {}) {
  const buzzEnv = normalizeBuzzEnv(options.buzz_env || options.env);
  const range = parseDayRange(options.date_from, options.date_to);
  const scope = String(options.scope || "all").trim().toLowerCase();
  const onlyActive = options.only_active !== false;
  const client = options.client || new BuzzAdminClient({ ...createBuzzClientOptions(buzzEnv), buzz_env: buzzEnv });

  const crawledIds = scope === "crawled" ? buildCrawledNowIdSet(options.db, buzzEnv) : null;
  if (scope === "crawled" && crawledIds && crawledIds.size === 0) {
    return {
      buzz_env: buzzEnv,
      range,
      scope,
      summary: {
        bubbles_total: 0,
        bubbles_with_join: 0,
        bubbles_with_speak: 0,
        join_user_count: 0,
        speak_user_count: 0,
      },
      items: [],
    };
  }

  const bubbles = await fetchActiveNowsWithGroups(client, { crawled_now_ids: crawledIds });
  const byGroup = new Map();
  for (const bubble of bubbles) {
    if (!byGroup.has(bubble.group_id)) byGroup.set(bubble.group_id, bubble);
  }
  const groupIds = [...byGroup.keys()];

  const groupInfos = await getGroupInfoBatch(groupIds, {
    batchSize: IM_BATCH_SIZE,
    delayMs: IM_DELAY_MS,
    memberInfo: true,
  });

  const items = [];
  let joinUserTotal = 0;
  let speakUserTotal = 0;
  let bubblesWithJoin = 0;
  let bubblesWithSpeak = 0;

  for (const info of groupInfos) {
    if (info.ErrorCode !== 0) continue;
    const bubble = byGroup.get(info.GroupId);
    if (!bubble) continue;
    const owner = String(info.Owner_Account || bubble.publish_user_id || "").trim();
    const joiners = analyzeJoiners(info, range, owner);
    let speakers = [];

    if (needsMessageScan(info, range)) {
      const messages = await getGroupMessages(info.GroupId, { limit: MSG_FETCH_LIMIT });
      speakers = analyzeSpeakers(messages, range, owner);
      if (IM_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, IM_DELAY_MS));
      }
    }

    const joinCount = joiners.length;
    const speakCount = speakers.length;
    if (joinCount === 0 && speakCount === 0) {
      if (onlyActive) continue;
    } else {
      if (joinCount > 0) bubblesWithJoin += 1;
      if (speakCount > 0) bubblesWithSpeak += 1;
      joinUserTotal += joinCount;
      speakUserTotal += speakCount;
    }

    items.push({
      now_id: bubble.now_id,
      now_title: bubble.now_title,
      group_id: info.GroupId,
      group_name: String(info.Name || bubble.group_name || "").trim(),
      publish_user_id: owner,
      created_at: bubble.created_at,
      expired_at: bubble.expired_at,
      member_num: Number(info.MemberNum || 0),
      join_count: joinCount,
      speak_count: speakCount,
      joiners,
      speakers,
    });
  }

  items.sort((a, b) => {
    const scoreA = a.speak_count * 100 + a.join_count;
    const scoreB = b.speak_count * 100 + b.join_count;
    return scoreB - scoreA || String(a.now_title).localeCompare(String(b.now_title), "zh-CN");
  });

  return {
    buzz_env: buzzEnv,
    range,
    scope,
    summary: {
      bubbles_total: groupIds.length,
      bubbles_scanned: groupInfos.filter((item) => item.ErrorCode === 0).length,
      bubbles_with_join: bubblesWithJoin,
      bubbles_with_speak: bubblesWithSpeak,
      join_user_count: joinUserTotal,
      speak_user_count: speakUserTotal,
      rows_returned: items.length,
    },
    items,
  };
}

module.exports = {
  formatChinaDate,
  parseDayRange,
  queryBubbleGroupActivity,
};

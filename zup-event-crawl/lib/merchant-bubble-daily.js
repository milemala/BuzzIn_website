"use strict";

const { normalizeBuzzEnv } = require("./buzz-env");
const { getMerchantBubbleRoster, listMerchantsToPublish } = require("./merchant-bubble");
const { merchantAdminUserId } = require("./merchant-admin-user");

const SCHEDULE_PREFIX = "merchant_bubble_daily_schedule";
const CHECK_MS = 1000;
const GRACE_SECONDS = 30;

function scheduleMetaKey(buzzEnv) {
  return `${SCHEDULE_PREFIX}_${normalizeBuzzEnv(buzzEnv)}`;
}

function getMetaValue(db, key, fallback = null) {
  const row = db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

function setMetaValue(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, typeof value === "string" ? value : JSON.stringify(value));
}

function shanghaiParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((item) => [item.type, item.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

function normalizeDailyTime(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return "";
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] == null ? 0 : Number(match[3]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
}

function timeToSeconds(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function emptySchedule(buzzEnv) {
  return {
    enabled: false,
    time: "09:00:00",
    buzz_env: normalizeBuzzEnv(buzzEnv),
    publisher_mode: "unified",
    publish_user_id: "",
    group_mode: "use_merchant",
    now_type: 2,
    content_type: "auto",
    admin_nick_mode: "shop_name",
    admin_nickname: "",
    admin_avatar: "",
    admin_gender: 0,
    admin_age: "",
    admin_description: "",
    last_run_on: "",
    last_message: "",
    last_job_id: "",
  };
}

function getDailySchedule(db, buzzEnv) {
  const env = normalizeBuzzEnv(buzzEnv);
  const raw = getMetaValue(db, scheduleMetaKey(env), "");
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  const schedule = { ...emptySchedule(env), ...parsed, buzz_env: env };
  schedule.enabled = schedule.enabled === true;
  schedule.time = normalizeDailyTime(schedule.time) || "09:00:00";
  schedule.publisher_mode = schedule.publisher_mode === "per_merchant" ? "per_merchant" : "unified";
  schedule.group_mode = schedule.group_mode === "create_new" ? "create_new" : "use_merchant";
  return schedule;
}

function saveDailySchedule(db, buzzEnv, input = {}) {
  const env = normalizeBuzzEnv(buzzEnv);
  const previous = getDailySchedule(db, env);
  const time = normalizeDailyTime(input.time);
  const enabled = input.enabled === true;
  if (enabled && !time) {
    throw new Error("请选择每天几点发布");
  }
  const schedule = {
    ...previous,
    enabled,
    time: time || previous.time,
    buzz_env: env,
    publisher_mode: input.publisher_mode === "per_merchant" ? "per_merchant" : "unified",
    publish_user_id: String(input.publish_user_id || "").trim(),
    group_mode: input.group_mode === "create_new" ? "create_new" : "use_merchant",
    now_type: Number(input.now_type) || 2,
    content_type: input.content_type == null || input.content_type === "" ? "auto" : input.content_type,
    admin_nick_mode: input.admin_nick_mode === "unified" ? "unified" : "shop_name",
    admin_nickname: String(input.admin_nickname || "").trim(),
    admin_avatar: String(input.admin_avatar || "").trim(),
    admin_gender: Number(input.admin_gender) || 0,
    admin_age: input.admin_age === "" || input.admin_age == null ? "" : Number(input.admin_age),
    admin_description: String(input.admin_description || "").trim(),
  };
  setMetaValue(db, scheduleMetaKey(env), schedule);
  return getDailySchedule(db, env);
}

function isDailyScheduleDue(schedule, nowParts) {
  if (!schedule?.enabled) return false;
  if (!nowParts?.date || !nowParts?.time) return false;
  if (schedule.last_run_on === nowParts.date) return false;
  const target = timeToSeconds(normalizeDailyTime(schedule.time));
  const now = timeToSeconds(nowParts.time);
  if (target == null || now == null) return false;
  return now >= target && now < target + GRACE_SECONDS;
}

function publishOptionsFromSchedule(schedule, merchantUids) {
  return {
    buzz_env: schedule.buzz_env,
    city: "",
    merchant_uids: merchantUids,
    publisher_mode: schedule.publisher_mode,
    publish_user_id: schedule.publish_user_id,
    group_mode: schedule.group_mode,
    now_type: schedule.now_type,
    content_type: schedule.content_type,
    start_at: "",
    expired_at: "",
    admin_nick_mode: schedule.admin_nick_mode,
    admin_nickname: schedule.admin_nickname,
    admin_avatar: schedule.admin_avatar,
    admin_gender: schedule.admin_gender,
    admin_age: schedule.admin_age,
    admin_description: schedule.admin_description,
    delayMs: 200,
  };
}

function rememberRun(db, schedule, patch) {
  const next = { ...schedule, ...patch };
  setMetaValue(db, scheduleMetaKey(schedule.buzz_env), next);
  return next;
}

async function runDueSchedule(db, buzzEnv, deps, nowParts = shanghaiParts()) {
  const schedule = getDailySchedule(db, buzzEnv);
  if (!isDailyScheduleDue(schedule, nowParts)) return { ran: false };
  const enabledUids = getMerchantBubbleRoster(db, { buzz_env: schedule.buzz_env }).items
    .filter((item) => item.enabled !== false)
    .map((item) => item.merchant_uid);
  if (!enabledUids.length) {
    rememberRun(db, schedule, {
      last_run_on: nowParts.date,
      last_message: `${nowParts.date} ${schedule.time} 没有已启用的店，没有发布`,
      last_job_id: "",
    });
    return { ran: true, started: false };
  }
  const options = publishOptionsFromSchedule(schedule, enabledUids);
  const targets = await listMerchantsToPublish(db, options);
  if (!targets.length) {
    rememberRun(db, schedule, {
      last_run_on: nowParts.date,
      last_message: `${nowParts.date} ${schedule.time} 已启用的店都有未过期气泡，没有重复发`,
      last_job_id: "",
    });
    return { ran: true, started: false };
  }
  if (schedule.publisher_mode === "per_merchant") {
    const missing = targets.filter((item) => !merchantAdminUserId(item));
    if (missing.length) {
      rememberRun(db, schedule, {
        last_run_on: nowParts.date,
        last_message: `${nowParts.date} ${schedule.time} 有 ${missing.length} 家还没有管理员，这次没有发`,
        last_job_id: "",
      });
      return { ran: true, started: false };
    }
  }
  options.merchant_uids = targets.map((item) => item.merchant_uid);
  const jobId = deps.startPublishBatchJob(db, options);
  rememberRun(db, schedule, {
    last_run_on: nowParts.date,
    last_message: `${nowParts.date} ${schedule.time} 已开始发布 ${options.merchant_uids.length} 家`,
    last_job_id: jobId,
  });
  return { ran: true, started: true, job_id: jobId, total: options.merchant_uids.length };
}

function startDailyScheduleLoop(db, deps) {
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const nowParts = shanghaiParts();
      for (const buzzEnv of ["test", "prod"]) {
        try {
          await runDueSchedule(db, buzzEnv, deps, nowParts);
        } catch (error) {
          console.error(`定时发布 ${buzzEnv} 失败：${error.message}`);
        }
      }
    } finally {
      ticking = false;
    }
  };
  const timer = setInterval(tick, CHECK_MS);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

module.exports = {
  getDailySchedule,
  isDailyScheduleDue,
  normalizeDailyTime,
  runDueSchedule,
  saveDailySchedule,
  shanghaiParts,
  startDailyScheduleLoop,
};

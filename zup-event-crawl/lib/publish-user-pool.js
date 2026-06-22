"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeBuzzEnv, getBuzzEnvConfig } = require("./buzz-env");

const USERS_PATH = path.join(__dirname, "..", "data", "users.json");
const META_PREFIX = "publish_user_pool";

let cachedUsers = null;

function loadPoolUsers() {
  if (cachedUsers) return cachedUsers;
  try {
    const raw = fs.readFileSync(USERS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cachedUsers = (Array.isArray(parsed) ? parsed : [])
      .map((item) => ({
        user_id: String(item.user_id || "").trim(),
        nick_name: String(item.nick_name || "").trim(),
        phone: String(item.phone || "").trim(),
      }))
      .filter((item) => item.user_id);
  } catch {
    cachedUsers = [];
  }
  return cachedUsers;
}

function poolEnabled(buzzEnv) {
  return normalizeBuzzEnv(buzzEnv) === "prod" && loadPoolUsers().length > 0;
}

function metaKey(buzzEnv) {
  return `${META_PREFIX}_${normalizeBuzzEnv(buzzEnv)}`;
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

function loadPoolState(db, buzzEnv) {
  const raw = getMetaValue(db, metaKey(buzzEnv), "{}");
  try {
    const parsed = JSON.parse(raw);
    return {
      index: Number(parsed.index) || 0,
      exhausted: Array.isArray(parsed.exhausted)
        ? parsed.exhausted.map((id) => String(id).trim()).filter(Boolean)
        : [],
    };
  } catch {
    return { index: 0, exhausted: [] };
  }
}

function savePoolState(db, buzzEnv, state) {
  const users = loadPoolUsers();
  const index = Math.max(0, Math.min(Number(state.index) || 0, Math.max(users.length - 1, 0)));
  setMetaValue(db, metaKey(buzzEnv), {
    index,
    exhausted: Array.isArray(state.exhausted) ? state.exhausted : [],
  });
}

function isImGroupLimitError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return msg.includes("group amount limit")
    || msg.includes("reached group")
    || msg.includes("群数量") && msg.includes("上限");
}

function findNextPoolIndex(users, state, fromUserId) {
  const exhausted = new Set(state.exhausted);
  if (fromUserId) exhausted.add(String(fromUserId).trim());
  const n = users.length;
  if (!n) return -1;
  for (let step = 1; step <= n; step += 1) {
    const idx = (state.index + step) % n;
    if (!exhausted.has(users[idx].user_id)) return idx;
  }
  return -1;
}

function getPoolUserAt(db, buzzEnv, index) {
  const users = loadPoolUsers();
  if (!users.length) return null;
  const state = loadPoolState(db, buzzEnv);
  const idx = Math.max(0, Math.min(Number(index) || state.index, users.length - 1));
  return { ...users[idx], index: idx };
}

function getDefaultPoolUserId(db, buzzEnv) {
  if (!poolEnabled(buzzEnv)) {
    return getBuzzEnvConfig(buzzEnv).defaultPublishUserId;
  }
  const user = getPoolUserAt(db, buzzEnv);
  return user?.user_id || getBuzzEnvConfig(buzzEnv).defaultPublishUserId;
}

function resolvePublishUserId(db, buzzEnv, explicitUserId) {
  const explicit = String(explicitUserId || "").trim();
  if (explicit) return explicit;
  return getDefaultPoolUserId(db, buzzEnv);
}

function createPublishUserPoolContext(db, buzzEnv) {
  const env = normalizeBuzzEnv(buzzEnv);
  const users = loadPoolUsers();
  if (!users.length) {
    throw new Error("users.json 为空，无法使用马甲号池");
  }
  let state = loadPoolState(db, env);

  function currentUser() {
    const idx = Math.max(0, Math.min(state.index, users.length - 1));
    return { ...users[idx], index: idx };
  }

  return {
    buzzEnv: env,
    userCount() {
      return users.length;
    },
    currentUserId() {
      return currentUser().user_id;
    },
    currentUserLabel() {
      const user = currentUser();
      return user.nick_name || user.user_id;
    },
    rotateOnLimit(usedUserId) {
      const used = String(usedUserId || currentUser().user_id).trim();
      if (used && !state.exhausted.includes(used)) {
        state.exhausted.push(used);
      }
      const nextIndex = findNextPoolIndex(users, state, used);
      if (nextIndex < 0) {
        throw new Error("所有马甲号群聊额度均已用尽");
      }
      const from = currentUser();
      state.index = nextIndex;
      savePoolState(db, env, state);
      const to = users[nextIndex];
      return {
        from_user_id: from.user_id,
        from_label: from.nick_name || from.user_id,
        to_user_id: to.user_id,
        to_label: to.nick_name || to.user_id,
        index: nextIndex,
      };
    },
    getStatus() {
      const user = currentUser();
      return {
        enabled: true,
        index: user.index,
        total: users.length,
        exhausted: state.exhausted.length,
        current_user_id: user.user_id,
        current_label: user.nick_name || user.user_id,
      };
    },
  };
}

function getPublishUserPoolStatus(db, buzzEnv) {
  const env = normalizeBuzzEnv(buzzEnv);
  if (!poolEnabled(env)) {
    return {
      enabled: false,
      default_publish_user_id: getBuzzEnvConfig(env).defaultPublishUserId,
    };
  }
  const ctx = createPublishUserPoolContext(db, env);
  return {
    enabled: true,
    default_publish_user_id: ctx.currentUserId(),
    ...ctx.getStatus(),
  };
}

module.exports = {
  createPublishUserPoolContext,
  getDefaultPoolUserId,
  getPublishUserPoolStatus,
  getPoolUserAt,
  isImGroupLimitError,
  loadPoolUsers,
  poolEnabled,
  resolvePublishUserId,
};

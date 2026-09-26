"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeBuzzEnv, getBuzzEnvConfig } = require("./buzz-env");

const USERS_PATH = path.join(__dirname, "..", "data", "users.json");
const META_PREFIX = "publish_user_pool";
const DEFAULT_VEST_AVATAR = "https://cdn.nowmap.cn/bz/media/2026/06/22/71/cf/d7e4fc98-7a93-471f-812b-e7920e7a20a4.jpg";
const VEST_PHONE_PREFIX = "1017777";

let cachedRawUsers = null;
let cachedUsers = null;

function readUsersFileRaw() {
  if (cachedRawUsers) return cachedRawUsers;
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
    cachedRawUsers = Array.isArray(parsed) ? parsed : [];
  } catch {
    cachedRawUsers = [];
  }
  return cachedRawUsers;
}

function normalizeVestUser(item = {}) {
  const userId = String(item.user_id || "").trim();
  return {
    phone: String(item.phone || "").trim(),
    avatar: String(item.avatar || "").trim(),
    nick_name: String(item.nick_name || item.nickname || "").trim(),
    gender: Number.isFinite(Number(item.gender)) ? Number(item.gender) : 0,
    user_id: userId,
    enabled: item.enabled !== false,
    note: String(item.note || "").trim(),
    created_env: String(item.created_env || "").trim(),
  };
}

function vestUserToFile(item) {
  const row = {
    phone: item.phone || "",
    avatar: item.avatar || DEFAULT_VEST_AVATAR,
    nick_name: item.nick_name || "",
    gender: Number(item.gender) || 0,
    user_id: item.user_id,
  };
  if (item.enabled === false) row.enabled = false;
  if (item.note) row.note = item.note;
  if (item.created_env) row.created_env = item.created_env;
  return row;
}

function writeUsersFile(users) {
  const list = (users || [])
    .map(normalizeVestUser)
    .filter((item) => item.user_id);
  fs.writeFileSync(USERS_PATH, `${JSON.stringify(list.map(vestUserToFile), null, 2)}\n`);
  cachedRawUsers = list.map(vestUserToFile);
  cachedUsers = null;
  return listVestUsers();
}

function listVestUsers() {
  return readUsersFileRaw().map(normalizeVestUser).filter((item) => item.user_id);
}

function suggestNextVestPhone() {
  let max = 0;
  for (const user of listVestUsers()) {
    const match = String(user.phone || "").match(/^1017777(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  const next = Math.max(max + 1, 1);
  return `${VEST_PHONE_PREFIX}${String(next).padStart(4, "0")}`;
}

function findVestUser(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;
  return listVestUsers().find((item) => item.user_id === id) || null;
}

function addVestUser(input = {}) {
  const user = normalizeVestUser(input);
  if (!user.user_id) throw new Error("缺少 user_id");
  const users = listVestUsers();
  if (users.some((item) => item.user_id === user.user_id)) {
    throw new Error(`马甲号已在名单里：${user.user_id}`);
  }
  if (user.phone && users.some((item) => item.phone && item.phone === user.phone)) {
    throw new Error(`手机号已在名单里：${user.phone}`);
  }
  if (!user.avatar) user.avatar = DEFAULT_VEST_AVATAR;
  users.push(user);
  writeUsersFile(users);
  return user;
}

function updateVestUser(userId, patch = {}) {
  const id = String(userId || "").trim();
  const users = listVestUsers();
  const index = users.findIndex((item) => item.user_id === id);
  if (index < 0) throw new Error("名单里没有这个马甲号");
  const merged = { ...users[index] };
  for (const key of ["nick_name", "phone", "avatar", "gender", "enabled", "note", "created_env"]) {
    if (patch[key] !== undefined) merged[key] = patch[key];
  }
  const next = normalizeVestUser({ ...merged, user_id: id });
  if (next.phone && users.some((item, i) => i !== index && item.phone === next.phone)) {
    throw new Error(`手机号已被其他马甲号占用：${next.phone}`);
  }
  users[index] = next;
  writeUsersFile(users);
  return next;
}

function removeVestUser(userId) {
  const id = String(userId || "").trim();
  const users = listVestUsers();
  const found = users.find((item) => item.user_id === id);
  if (!found) throw new Error("名单里没有这个马甲号");
  writeUsersFile(users.filter((item) => item.user_id !== id));
  return found;
}

function loadPoolUsers() {
  if (cachedUsers) return cachedUsers;
  cachedUsers = listVestUsers()
    .filter((item) => item.enabled)
    .map((item) => ({
      user_id: item.user_id,
      nick_name: item.nick_name,
      phone: item.phone,
    }));
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
  const users = listVestUsers();
  const roster = {
    users,
    total: users.length,
    enabled_count: users.filter((item) => item.enabled).length,
    next_phone: suggestNextVestPhone(),
    default_avatar: DEFAULT_VEST_AVATAR,
  };
  if (!poolEnabled(env)) {
    return {
      enabled: false,
      default_publish_user_id: getBuzzEnvConfig(env).defaultPublishUserId,
      ...roster,
    };
  }
  const ctx = createPublishUserPoolContext(db, env);
  const pool = ctx.getStatus();
  return {
    enabled: true,
    default_publish_user_id: ctx.currentUserId(),
    index: pool.index,
    exhausted: pool.exhausted,
    current_user_id: pool.current_user_id,
    current_label: pool.current_label,
    pool_total: pool.total,
    ...roster,
  };
}

module.exports = {
  DEFAULT_VEST_AVATAR,
  addVestUser,
  createPublishUserPoolContext,
  findVestUser,
  getDefaultPoolUserId,
  getPublishUserPoolStatus,
  getPoolUserAt,
  isImGroupLimitError,
  listVestUsers,
  loadPoolUsers,
  poolEnabled,
  removeVestUser,
  resolvePublishUserId,
  suggestNextVestPhone,
  updateVestUser,
};

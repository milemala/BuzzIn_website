"use strict";

const { BuzzAdminClient } = require("./buzz-now-import");
const { applyBuzzEnvToMerchant, markMerchantImportResult } = require("./buzz-import-store");
const { resolveMerchantTypeNameForBubble } = require("./merchant-bubble-content-type");
const { getMerchantByUid, listImportedMerchants } = require("./merchant-db");
const { normalizeBuzzEnv } = require("./buzz-env");
const { DEFAULT_VEST_AVATAR, suggestNextVestPhone } = require("./publish-user-pool");

const PHONE_META_KEY = "merchant_admin_phone_seq";
const PHONE_PREFIX = "1017777";
const MAX_NICK_LEN = 64;

function resolveBuzzEnv(options = {}) {
  return normalizeBuzzEnv(options.buzz_env || options.env);
}

function truncateRunes(value, max) {
  const chars = [...String(value || "").trim()];
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max).join("");
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
  `).run(key, String(value));
}

function publisherMode(options = {}) {
  return String(options.publisher_mode || "unified").trim() === "per_merchant"
    ? "per_merchant"
    : "unified";
}

function shouldUseVestPool(options = {}) {
  return publisherMode(options) !== "unified" && publisherMode(options) !== "per_merchant";
}

function merchantAdminUserId(merchant) {
  return String(merchant?.admin_user_id || merchant?.publish_user_id || "").trim();
}

function staffUserId(item) {
  if (!item || typeof item !== "object") return "";
  return String(
    item.user_id
    || item.userId
    || item.operator_user_id
    || item.user?.user_id
    || item.User?.user_id
    || "",
  ).trim();
}

function staffRole(item) {
  const role = item?.role ?? item?.Role ?? item?.staff_role;
  const n = Number(role);
  if (Number.isFinite(n) && n > 0) return n;
  const text = String(role || "").toLowerCase();
  if (text.includes("owner") || text.includes("店长")) return 1;
  if (text.includes("admin") || text.includes("管理")) return 2;
  return 0;
}

function staffNickname(item) {
  return String(item?.nickname || item?.name || item?.nick_name || "").trim();
}

function pickMerchantStaff(remote) {
  if (!remote || typeof remote !== "object") return null;
  const staffs = Array.isArray(remote.staffs) ? remote.staffs : [];
  const owners = staffs.filter((item) => staffRole(item) === 1);
  const admins = staffs.filter((item) => staffRole(item) === 2);
  const picked = owners[0] || admins[0] || staffs[0] || null;
  if (picked) {
    const userId = staffUserId(picked);
    if (userId) return { user_id: userId, nickname: staffNickname(picked), role: staffRole(picked) };
  }
  const direct = String(remote.operator_user_id || "").trim();
  if (!direct) return null;
  return { user_id: direct, nickname: "", role: 1 };
}

function pickMerchantStaffUserId(remote) {
  return pickMerchantStaff(remote)?.user_id || "";
}

const staffMapCache = new Map();
const STAFF_CACHE_MS = 5 * 60 * 1000;

async function getMerchantStaffMap(buzzEnv, options = {}) {
  const env = resolveBuzzEnv({ buzz_env: buzzEnv });
  const cached = staffMapCache.get(env);
  if (!options.refresh && cached && Date.now() - cached.at < STAFF_CACHE_MS) {
    return cached.map;
  }
  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: env });
  options.client = client;
  const list = await client.listAllMerchants();
  const map = new Map();
  for (const item of list) {
    const merchantId = String(item?.merchant_id || "").trim();
    const staff = pickMerchantStaff(item);
    if (!merchantId || !staff?.user_id) continue;
    map.set(merchantId, staff);
  }
  staffMapCache.set(env, { at: Date.now(), map });
  return map;
}

async function attachMerchantAdmins(db, merchants, options = {}) {
  const rows = Array.isArray(merchants) ? merchants : [];
  const buzzEnv = resolveBuzzEnv(options);
  let staffMap = new Map();
  try {
    staffMap = await getMerchantStaffMap(buzzEnv, options);
  } catch {
    staffMap = new Map();
  }
  for (const merchant of rows) {
    const merchantId = String(merchant?.buzz_merchant_id || "").trim();
    const staff = staffMap.get(merchantId);
    if (staff?.user_id) {
      merchant.admin_user_id = staff.user_id;
      merchant.admin_nickname = staff.nickname || "";
      if (String(merchant.publish_user_id || "").trim() !== staff.user_id) {
        saveMerchantAdmin(db, merchant.merchant_uid, staff.user_id, buzzEnv);
        merchant.publish_user_id = staff.user_id;
      }
    } else {
      merchant.admin_nickname = String(merchant.admin_nickname || "").trim();
    }
  }
  return rows;
}

function nextPhoneCandidate(db) {
  const vestNext = Number(String(suggestNextVestPhone() || "").replace(PHONE_PREFIX, "")) || 100;
  const stored = Number(getMetaValue(db, PHONE_META_KEY, "0")) || 0;
  return Math.max(stored + 1, vestNext, 100);
}

async function allocateUnusedPhone(db, client) {
  let n = nextPhoneCandidate(db);
  for (let i = 0; i < 80; i += 1) {
    const phone = `${PHONE_PREFIX}${String(n).padStart(4, "0")}`;
    const existing = await client.findUserByKeyword(phone);
    if (!existing?.user_id) {
      setMetaValue(db, PHONE_META_KEY, String(n));
      return phone;
    }
    n += 1;
  }
  throw new Error("找不到可用的管理员手机号");
}

function merchantInEnv(db, merchantUid, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  return applyBuzzEnvToMerchant(db, getMerchantByUid(db, merchantUid), buzzEnv);
}

function saveMerchantAdmin(db, merchantUid, userId, buzzEnv) {
  markMerchantImportResult(db, merchantUid, { publish_user_id: userId }, buzzEnv);
  return merchantInEnv(db, merchantUid, { buzz_env: buzzEnv });
}

function birthdayFromAge(age) {
  const n = Number(age);
  if (!Number.isInteger(n) || n < 1 || n > 120) return 0;
  return Math.floor(Date.UTC(new Date().getFullYear() - n, 0, 1) / 1000);
}

const PLACE_ADMIN_NICKNAME = "神秘小刘";
const PLACE_ADMIN_TYPE_NAMES = new Set(["公园", "其他"]);

function resolveAdminProfile(merchant, options = {}) {
  const nickMode = String(options.admin_nick_mode || "shop_name").trim();
  const unifiedNick = String(options.admin_nickname || "").trim();
  const typeName = resolveMerchantTypeNameForBubble(merchant, options.merchant_types);
  const nickname = truncateRunes(
    PLACE_ADMIN_TYPE_NAMES.has(typeName)
      ? PLACE_ADMIN_NICKNAME
      : (nickMode === "unified" && unifiedNick
        ? unifiedNick
        : (merchant.name || unifiedNick || "店铺管理员")),
    MAX_NICK_LEN,
  ) || "店铺管理员";
  const genderRaw = Number(options.admin_gender);
  const gender = genderRaw === 1 || genderRaw === 2 ? genderRaw : 0;
  return {
    nickname,
    avatar: String(options.admin_avatar || "").trim() || DEFAULT_VEST_AVATAR,
    gender,
    description: String(options.admin_description || options.admin_signature || "").trim(),
    birthday: birthdayFromAge(options.admin_age),
  };
}

async function createAdminUser(client, merchant, phone, options = {}) {
  const profile = resolveAdminProfile(merchant, options);
  const payload = {
    phone,
    nickname: profile.nickname,
    avatar: profile.avatar,
    gender: profile.gender,
    status: 0,
  };
  if (profile.description) payload.description = profile.description;
  if (profile.birthday) payload.birthday = profile.birthday;
  const created = await client.createUser(payload);
  const userId = String(created.user_id || created.id || "").trim();
  if (!userId) throw new Error("后台创建用户成功但未返回 user_id");
  return { userId, nickname: profile.nickname, phone };
}

async function bindMerchantOperator(client, merchantId, userId) {
  await client.updateMerchant(merchantId, { operator_user_id: userId });
}

async function ensureMerchantAdmin(db, merchantUid, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const merchant = merchantInEnv(db, merchantUid, options);
  if (!merchant) {
    return { ok: false, merchant_uid: merchantUid, buzz_env: buzzEnv, error: "商户不存在" };
  }
  if (merchant.import_status !== "imported" || !merchant.buzz_merchant_id) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      error: "商户尚未入库后台",
      merchant,
    };
  }

  const existingLocal = merchantAdminUserId(merchant);
  if (existingLocal && options.force !== true) {
    return {
      ok: true,
      skipped: true,
      reused: true,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      admin_user_id: existingLocal,
      note: "本地已有管理员",
      merchant,
    };
  }

  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
  options.client = client;

  try {
    const remote = await client.getMerchantById(merchant.buzz_merchant_id);
    if (!remote) throw new Error("当前环境找不到这家后台商户");
    const existingStaff = pickMerchantStaffUserId(remote);
    if (existingStaff) {
      const updated = saveMerchantAdmin(db, merchantUid, existingStaff, buzzEnv);
      return {
        ok: true,
        reused: true,
        merchant_uid: merchantUid,
        buzz_env: buzzEnv,
        name: merchant.name,
        admin_user_id: existingStaff,
        note: "沿用店里已有店长/管理员",
        merchant: updated,
      };
    }

    const phone = await allocateUnusedPhone(db, client);
    const created = await createAdminUser(client, merchant, phone, options);
    await bindMerchantOperator(client, merchant.buzz_merchant_id, created.userId);
    const updated = saveMerchantAdmin(db, merchantUid, created.userId, buzzEnv);
    return {
      ok: true,
      created: true,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      admin_user_id: created.userId,
      phone: created.phone,
      merchant: updated,
    };
  } catch (error) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      error: error.message,
      merchant,
    };
  }
}

function importListOptions(options = {}) {
  return {
    city: options.city || "",
    buzz_env: resolveBuzzEnv(options),
    limit: options.limit || 0,
    merchant_uids: options.merchant_uids,
  };
}

function listMerchantsNeedingAdmin(db, options = {}) {
  return listImportedMerchants(db, importListOptions(options)).filter((merchant) => (
    options.force === true || !merchantAdminUserId(merchant)
  ));
}

async function batchEnsureMerchantAdmins(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
  options.client = client;
  if (!Array.isArray(options.merchant_types) || !options.merchant_types.length) {
    try {
      options.merchant_types = await client.listMerchantTypes();
    } catch {
      options.merchant_types = [];
    }
  }
  const merchants = listMerchantsNeedingAdmin(db, options);
  const results = [];
  let ok = 0;
  let fail = 0;
  let created = 0;
  let skipped = 0;

  for (const merchant of merchants) {
    if (typeof options.shouldCancel === "function" && options.shouldCancel()) {
      return {
        total: merchants.length,
        ok,
        fail,
        created,
        skipped,
        canceled: true,
        results,
      };
    }
    const result = await ensureMerchantAdmin(db, merchant.merchant_uid, options);
    results.push(result);
    if (result.ok) {
      ok += 1;
      if (result.created) created += 1;
      if (result.skipped || result.reused) skipped += 1;
    } else fail += 1;
    if (typeof options.onItem === "function") options.onItem(result);
    if (options.delayMs !== 0) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 400));
    }
  }

  return {
    total: merchants.length,
    ok,
    fail,
    created,
    skipped,
    results,
  };
}

function resolveMerchantPublishUserId(merchant, options = {}) {
  if (publisherMode(options) === "per_merchant") {
    const userId = merchantAdminUserId(merchant);
    if (!userId) {
      throw new Error("该店还没有管理员账号，请先为勾选的店创建管理员");
    }
    return userId;
  }
  const explicit = String(options.publish_user_id || "").trim();
  if (explicit) return explicit;
  const { getBuzzEnvConfig } = require("./buzz-env");
  return getBuzzEnvConfig(resolveBuzzEnv(options)).defaultPublishUserId;
}

module.exports = {
  attachMerchantAdmins,
  batchEnsureMerchantAdmins,
  ensureMerchantAdmin,
  listMerchantsNeedingAdmin,
  merchantAdminUserId,
  pickMerchantStaff,
  pickMerchantStaffUserId,
  publisherMode,
  resolveAdminProfile,
  resolveMerchantPublishUserId,
  shouldUseVestPool,
};

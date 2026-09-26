"use strict";

const crypto = require("crypto");
const fs = require("fs");
const { BuzzAdminClient, buildBuzzPayload } = require("./buzz-now-import");
const { getComposedImagePath, parseComposedEventUid } = require("./composed-image");
const {
  createGroupForMerchant,
  destroyGroup,
  ensureGroupOwner,
  merchantGroupDisplayName,
  modifyGroupBaseInfo,
} = require("./tencent-im-group");
const {
  getMerchantByUid,
  listImportedMerchants,
  markMerchantBubbleResult,
  patchMerchantCityIfEmpty,
  updateMerchantGroupId,
} = require("./merchant-db");
const { applyBuzzEnvToMerchant } = require("./buzz-import-store");
const { getBuzzEnvConfig, normalizeBuzzEnv } = require("./buzz-env");
const { resolveMerchantCity } = require("./buzz-merchant-sync");
const {
  createPublishUserPoolContext,
  getDefaultPoolUserId,
  isImGroupLimitError,
  poolEnabled,
  resolvePublishUserId: resolvePoolPublishUserId,
} = require("./publish-user-pool");
const {
  resolveMerchantBubbleContentType,
  resolveMerchantTypeNameForBubble,
} = require("./merchant-bubble-content-type");
const {
  attachMerchantAdmins,
  resolveMerchantPublishUserId,
  shouldUseVestPool,
} = require("./merchant-admin-user");

const ROTATION_META_PREFIX = "merchant_bubble_rotation";
const ROSTER_META_PREFIX = "merchant_bubble_roster";
const TITLE_POOL_META_KEY = "merchant_bubble_title_pool";
const TITLE_POOL_CURSOR_KEY = "merchant_bubble_title_pool_cursor";
const TITLE_POOLS_META_KEY = "merchant_bubble_title_pools";
const TITLE_POOL_CURSORS_KEY = "merchant_bubble_title_pool_cursors";
const TITLE_POOL_SIZE = 10;
const DEFAULT_COPY_POOL = Array.from({ length: TITLE_POOL_SIZE }, () => ({
  title: "",
  content: "",
  enabled: true,
}));
const DEFAULT_TITLE_POOL = DEFAULT_COPY_POOL.map((item) => item.title);
/** 每个城市至少分 3 组；单组超过 MAX_BUCKET_SIZE 时自动增加组数 */
const MIN_BUCKET_COUNT = 3;
const MAX_BUCKET_SIZE = 40;
const BUBBLE_EXPIRE_DAYS = 3;
const BUBBLE_PUBLISH_DELAY_MS = 200;
const BAR_TYPE_NAMES = new Set(["酒馆", "酒吧", "啤酒馆", "啤酒吧"]);
const activeBubbleCache = new Map();
const ACTIVE_BUBBLE_CACHE_MS = 60 * 1000;

function fingerprintBubbleImage(src) {
  const url = String(src || "").trim();
  const uid = parseComposedEventUid(url);
  if (uid) {
    try {
      return crypto.createHash("sha1").update(fs.readFileSync(getComposedImagePath(uid))).digest("hex");
    } catch {
      return `missing:${uid}`;
    }
  }
  if (!url) return "";
  return crypto.createHash("sha1").update(url).digest("hex");
}

function parseCachedBubbleMedia(raw) {
  try {
    const parsed = JSON.parse(String(raw || "").trim() || "null");
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object") return [parsed];
  } catch {
    // ignore
  }
  return [];
}

function cachedBubbleMedias(merchant, srcs, hash) {
  if (!hash || hash !== String(merchant?.bubble_media_hash || "").trim()) return null;
  const cached = parseCachedBubbleMedia(merchant?.bubble_media_json);
  if (cached.length !== srcs.length) return null;
  const medias = [];
  for (let i = 0; i < cached.length; i += 1) {
    const item = cached[i] || {};
    const mediaId = String(item.media_id || "").trim();
    const mediaUrl = String(item.media_url || "").trim();
    const width = Number(item.width) || 0;
    const height = Number(item.height) || 0;
    if (!mediaId || !mediaUrl || width <= 0 || height <= 0) return null;
    if (item.src && String(item.src) !== srcs[i]) return null;
    medias.push({
      media_id: mediaId,
      media_url: mediaUrl,
      media_type: Number(item.media_type) || 1,
      width,
      height,
    });
  }
  return medias;
}

function pickNowMedias(nowItem) {
  const list = nowItem?.now_medias || nowItem?.medias || [];
  const medias = [];
  for (const item of list || []) {
    const mediaId = String(item?.media_id || "").trim();
    const mediaUrl = String(item?.media_url || "").trim();
    const width = Number(item?.width) || 0;
    const height = Number(item?.height) || 0;
    if (!mediaId || !mediaUrl || width <= 0 || height <= 0) continue;
    medias.push({
      media_id: mediaId,
      media_url: mediaUrl,
      media_type: Number(item.media_type) || 1,
      width,
      height,
    });
  }
  return medias;
}

function nowItemMerchantId(item) {
  return String(
    item?.merchant?.merchant_id
    || item?.now_merchant_id
    || item?.merchant_id
    || "",
  ).trim();
}

function reusedMediaResult(srcs, hash, medias) {
  const stored = srcs.map((src, index) => ({
    src,
    media_id: medias[index].media_id,
    media_url: medias[index].media_url,
    media_type: medias[index].media_type || 1,
    width: medias[index].width,
    height: medias[index].height,
  }));
  return {
    medias: medias.map((item) => ({
      media_id: item.media_id,
      media_url: item.media_url,
      media_type: item.media_type || 1,
      width: item.width,
      height: item.height,
    })),
    hash,
    reused: true,
    mediaJson: JSON.stringify(stored),
  };
}

async function listNowPages(client, extra, onItem, options = {}) {
  const maxPages = Number(options.maxPages) > 0 ? Number(options.maxPages) : 60;
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await client.postJSON("/nows/list", { page, size: 100, ...extra });
    const list = data?.list || [];
    if (!list.length) return;
    for (const item of list) {
      if (onItem(item) === true) return;
    }
    if (list.length < 100) return;
  }
}

async function loadMerchantMediaFromRecentNows(client, merchantIds, options = {}) {
  const needed = new Set(
    (merchantIds || []).map((id) => String(id || "").trim()).filter(Boolean),
  );
  const found = new Map();
  if (!needed.size) return found;

  const take = (item) => {
    const merchantId = nowItemMerchantId(item);
    if (!needed.has(merchantId) || found.has(merchantId)) {
      return found.size >= needed.size;
    }
    const medias = pickNowMedias(item);
    if (medias.length) found.set(merchantId, medias);
    return found.size >= needed.size;
  };

  const publishUserId = String(options.publish_user_id || "").trim();
  if (publishUserId) {
    await listNowPages(client, { user_identifier: publishUserId, expired: 1, type: 2 }, take);
    if (found.size < needed.size) {
      await listNowPages(client, { user_identifier: publishUserId, type: 2 }, take);
    }
  }
  if (found.size < needed.size) {
    await listNowPages(client, { type: 2, expired: 1 }, take, { maxPages: 80 });
  }
  return found;
}

async function attachRemoteNowMedias(client, merchants, options = {}) {
  const missingMediaIds = (merchants || [])
    .filter((item) => !String(item.bubble_media_hash || "").trim())
    .map((item) => item.buzz_merchant_id)
    .filter(Boolean);
  if (!missingMediaIds.length) return;
  if (typeof options.onStatus === "function") {
    options.onStatus("正在找回上次用过的封面，找到就不重新上传");
  }
  options.remoteNowMedias = await loadMerchantMediaFromRecentNows(client, missingMediaIds, {
    publish_user_id: String(options.publish_user_id || "").trim(),
  });
  if (typeof options.onStatus === "function") {
    const n = options.remoteNowMedias.size || 0;
    options.onStatus(n ? `已找回上次封面 ${n} 家，开始发布` : "没有找到可复用封面，将重新上传");
  }
}

async function fetchNowMediasForMerchant(client, merchant) {
  const merchantId = String(merchant?.buzz_merchant_id || "").trim();
  const name = String(merchant?.name || "").trim();
  if (!merchantId) return null;
  const queries = [];
  if (name) {
    queries.push({ page: 1, size: 20, keyword: name, type: 2, expired: 1 });
    queries.push({ page: 1, size: 20, keyword: name, type: 2 });
  }
  for (const body of queries) {
    try {
      const data = await client.postJSON("/nows/list", body);
      for (const item of data?.list || []) {
        if (nowItemMerchantId(item) !== merchantId) continue;
        const medias = pickNowMedias(item);
        if (medias.length) return medias;
      }
    } catch {
      // 找不到上次气泡就改走上传
    }
  }
  return null;
}

function remoteMediasForMerchant(merchant, remoteMedias) {
  const merchantId = String(merchant?.buzz_merchant_id || "").trim();
  if (!merchantId || !remoteMedias) return null;
  if (typeof remoteMedias.get === "function") return remoteMedias.get(merchantId) || null;
  return remoteMedias[merchantId] || null;
}

async function resolveBubbleMedias(client, images, merchant, options = {}) {
  const srcs = (images || []).map((src) => String(src || "").trim()).filter(Boolean);
  if (!srcs.length) {
    return { medias: [], hash: "", reused: false, mediaJson: "" };
  }
  const hash = srcs.map(fingerprintBubbleImage).join(",");
  if (!options.forceUpload) {
    const cached = cachedBubbleMedias(merchant, srcs, hash);
    if (cached) return reusedMediaResult(srcs, hash, cached);
    const remote = remoteMediasForMerchant(merchant, options.remoteMedias);
    if (remote?.length >= srcs.length) {
      return reusedMediaResult(srcs, hash, remote.slice(0, srcs.length));
    }
    const fetched = await fetchNowMediasForMerchant(client, merchant);
    if (fetched?.length >= srcs.length) {
      return reusedMediaResult(srcs, hash, fetched.slice(0, srcs.length));
    }
  }
  const medias = [];
  for (const src of srcs) {
    medias.push(await client.uploadMedia(src));
  }
  const stored = srcs.map((src, index) => ({
    src,
    media_id: medias[index].media_id,
    media_url: medias[index].media_url,
    media_type: medias[index].media_type || 1,
    width: medias[index].width || 0,
    height: medias[index].height || 0,
  }));
  return {
    medias,
    hash,
    reused: false,
    mediaJson: JSON.stringify(stored),
  };
}

function canSkipGroupOwnerTransfer(merchant, groupId, publishUserId) {
  const knownGroup = String(merchant?.buzz_group_id || "").trim();
  const knownOwner = String(merchant?.bubble_group_owner_id || "").trim();
  return Boolean(
    groupId
    && publishUserId
    && knownGroup === groupId
    && knownOwner === publishUserId
  );
}

function publishDelayMs(options = {}) {
  if (options.delayMs === 0) return 0;
  const n = Number(options.delayMs);
  if (Number.isFinite(n) && n > 0) return n;
  return BUBBLE_PUBLISH_DELAY_MS;
}

async function pauseAfterBubblePublish(options, result, isLast) {
  if (isLast || result?.skipped) return;
  const ms = publishDelayMs(options);
  if (ms > 0) await sleep(ms);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function invalidateActiveBubbleCache(buzzEnv) {
  if (buzzEnv) activeBubbleCache.delete(normalizeBuzzEnv(buzzEnv));
  else activeBubbleCache.clear();
}

function pad2(n) {
  return String(n).padStart(2, "0");
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

function rotationMetaKey(buzzEnv) {
  return `${ROTATION_META_PREFIX}_${normalizeBuzzEnv(buzzEnv)}`;
}

function rosterMetaKey(buzzEnv) {
  return `${ROSTER_META_PREFIX}_${normalizeBuzzEnv(buzzEnv)}`;
}

function truncateTitle(value) {
  return String(value || "").trim().slice(0, 128);
}

function truncateContent(value) {
  return String(value || "").trim().slice(0, 2000);
}

function emptyCopyItem() {
  return { title: "", content: "", enabled: true };
}

function copyItemEnabled(item) {
  return item?.enabled !== false;
}

function normalizeCopyItem(item, fallback = emptyCopyItem()) {
  if (typeof item === "string") {
    return {
      title: truncateTitle(item) || fallback.title || "",
      content: fallback.content || "",
      enabled: true,
    };
  }
  if (item && typeof item === "object") {
    return {
      title: truncateTitle(item.title || item.now_title),
      content: truncateContent(item.content || item.now_content),
      enabled: copyItemEnabled(item),
    };
  }
  return {
    title: fallback.title || "",
    content: fallback.content || "",
    enabled: copyItemEnabled(fallback),
  };
}

function normalizeTitlePool(value) {
  const list = Array.isArray(value) ? value : [];
  const out = [];
  for (let i = 0; i < TITLE_POOL_SIZE; i += 1) {
    const fallback = DEFAULT_COPY_POOL[i] || emptyCopyItem();
    const raw = list[i];
    if (raw == null) {
      out.push(emptyCopyItem());
      continue;
    }
    out.push(normalizeCopyItem(raw, typeof raw === "string" ? fallback : emptyCopyItem()));
  }
  return out;
}

function usableCopyItems(pool) {
  return normalizeTitlePool(pool).filter((item) => item.title && copyItemEnabled(item));
}

function getTitlePool(db) {
  const raw = getMetaValue(db, TITLE_POOL_META_KEY, null);
  if (raw == null) return normalizeTitlePool(DEFAULT_COPY_POOL);
  try {
    return normalizeTitlePool(JSON.parse(raw));
  } catch {
    return normalizeTitlePool(DEFAULT_COPY_POOL);
  }
}

function saveTitlePool(db, titles) {
  const pool = normalizeTitlePool(titles);
  setMetaValue(db, TITLE_POOL_META_KEY, JSON.stringify(pool));
  return pool;
}

function cloneCopyPool(pool) {
  return normalizeTitlePool(pool).map((item) => ({ ...item }));
}

const LEGACY_BAR_COPY_TYPES = ["酒馆", "啤酒吧"];

function legacyBarTitlePools(db) {
  const pool = getTitlePool(db);
  const pools = {};
  for (const name of LEGACY_BAR_COPY_TYPES) pools[name] = cloneCopyPool(pool);
  return pools;
}

function normalizeTitlePools(value) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [name, pool] of Object.entries(src)) {
    const typeName = String(name || "").trim();
    if (!typeName) continue;
    out[typeName] = normalizeTitlePool(pool);
  }
  return out;
}

function getTitlePools(db) {
  const raw = getMetaValue(db, TITLE_POOLS_META_KEY, null);
  if (raw == null) return legacyBarTitlePools(db);
  try {
    const pools = normalizeTitlePools(JSON.parse(raw));
    if (!Object.keys(pools).length) return legacyBarTitlePools(db);
    return pools;
  } catch {
    return legacyBarTitlePools(db);
  }
}

function saveTitlePools(db, pools) {
  const merged = {
    ...getTitlePools(db),
    ...normalizeTitlePools(pools),
  };
  setMetaValue(db, TITLE_POOLS_META_KEY, JSON.stringify(merged));
  return merged;
}

function getTitlePoolCursor(db) {
  const n = Number(getMetaValue(db, TITLE_POOL_CURSOR_KEY, "0"));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n % TITLE_POOL_SIZE;
}

function setTitlePoolCursor(db, index) {
  const n = Number(index);
  const next = Number.isFinite(n) && n >= 0 ? n % TITLE_POOL_SIZE : 0;
  setMetaValue(db, TITLE_POOL_CURSOR_KEY, String(next));
  return next;
}

function getTitlePoolCursors(db) {
  const raw = getMetaValue(db, TITLE_POOL_CURSORS_KEY, null);
  if (raw == null) {
    const legacy = getTitlePoolCursor(db);
    const cursors = {};
    for (const name of LEGACY_BAR_COPY_TYPES) cursors[name] = legacy;
    return cursors;
  }
  try {
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [name, value] of Object.entries(parsed || {})) {
      const typeName = String(name || "").trim();
      const n = Number(value);
      if (!typeName) continue;
      out[typeName] = Number.isFinite(n) && n >= 0 ? n % TITLE_POOL_SIZE : 0;
    }
    return out;
  } catch {
    return {};
  }
}

function setTitlePoolCursorForType(db, typeName, index) {
  const name = String(typeName || "").trim();
  if (!name) return getTitlePoolCursors(db);
  const cursors = getTitlePoolCursors(db);
  const n = Number(index);
  cursors[name] = Number.isFinite(n) && n >= 0 ? n % TITLE_POOL_SIZE : 0;
  setMetaValue(db, TITLE_POOL_CURSORS_KEY, JSON.stringify(cursors));
  return cursors;
}

function nextUsableCopyIndex(pool, start) {
  const items = normalizeTitlePool(pool);
  const begin = ((Number(start) % TITLE_POOL_SIZE) + TITLE_POOL_SIZE) % TITLE_POOL_SIZE;
  for (let step = 0; step < TITLE_POOL_SIZE; step += 1) {
    const idx = (begin + step) % TITLE_POOL_SIZE;
    const item = items[idx];
    if (item?.title && copyItemEnabled(item)) return idx;
  }
  return -1;
}

function createTitlePicker(pool, options = {}) {
  const items = normalizeTitlePool(pool);
  if (nextUsableCopyIndex(items, 0) < 0) {
    throw new Error("请至少启用一组填好标题的文案");
  }
  let cursor = Number(options.startCursor);
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0;
  cursor %= TITLE_POOL_SIZE;

  return () => {
    const idx = nextUsableCopyIndex(items, cursor);
    if (idx < 0) throw new Error("请至少启用一组填好标题的文案");
    cursor = (idx + 1) % TITLE_POOL_SIZE;
    if (typeof options.onAdvance === "function") options.onAdvance(cursor);
    return { ...items[idx] };
  };
}

function attachTitlePicker(db, options = {}) {
  if (typeof options.pickCopyForMerchant === "function") return options;
  let pools;
  if (options.title_pools && typeof options.title_pools === "object" && !Array.isArray(options.title_pools)) {
    pools = saveTitlePools(db, options.title_pools);
  } else if (Array.isArray(options.title_pool)) {
    const patch = {};
    for (const name of LEGACY_BAR_COPY_TYPES) patch[name] = options.title_pool;
    pools = saveTitlePools(db, patch);
  } else {
    pools = getTitlePools(db);
  }
  options.title_pools = pools;
  const cursors = getTitlePoolCursors(db);
  const pickers = {};
  for (const [typeName, pool] of Object.entries(pools)) {
    if (nextUsableCopyIndex(pool, 0) < 0) continue;
    pickers[typeName] = createTitlePicker(pool, {
      startCursor: cursors[typeName] || 0,
      onAdvance: (next) => setTitlePoolCursorForType(db, typeName, next),
    });
  }
  options.pickCopyForMerchant = (merchant) => {
    const typeName = resolveMerchantTypeNameForBubble(merchant, options.merchant_types);
    if (!typeName) {
      const shop = String(merchant?.name || "这家店").trim();
      throw new Error(`「${shop}」的商户类型没有对上当前环境，已停止按分类说明猜测。请刷新商户列表后再发`);
    }
    const pick = pickers[typeName];
    if (!pick) {
      throw new Error(`「${typeName}」还没有可用文案。请先在发布设置里为这个类型至少启用一组标题`);
    }
    return pick();
  };
  return options;
}

function pickBubbleCopy(merchant, options = {}) {
  const explicitTitle = truncateTitle(options.now_title);
  const explicitContent = truncateContent(options.now_content || options.unified_content);
  if (explicitTitle) {
    return { title: explicitTitle, content: explicitContent };
  }
  if (typeof options.pickCopyForMerchant === "function") return options.pickCopyForMerchant(merchant);
  if (typeof options.pickCopy === "function") return options.pickCopy();
  const typeName = resolveMerchantTypeNameForBubble(merchant, options.merchant_types);
  if (!typeName) {
    const shop = String(merchant?.name || "这家店").trim();
    throw new Error(`「${shop}」的商户类型没有对上当前环境，已停止按分类说明猜测。请刷新商户列表后再发`);
  }
  const pool = options.title_pools?.[typeName];
  const usable = usableCopyItems(pool);
  if (!usable.length) {
    throw new Error(typeName
      ? `「${typeName}」还没有可用文案。请先在发布设置里为这个类型至少启用一组标题`
      : "请至少启用一组填好标题的文案");
  }
  const idx = nextUsableCopyIndex(pool, 0);
  return { ...normalizeTitlePool(pool)[idx] };
}

function normalizeRosterItems(items) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const uid = String(item?.merchant_uid || item || "").trim();
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    out.push({
      merchant_uid: uid,
      enabled: item?.enabled !== false,
    });
  }
  return out;
}

function getMerchantBubbleRoster(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const raw = getMetaValue(db, rosterMetaKey(buzzEnv), "[]");
  let parsed = [];
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = [];
  }
  const stored = normalizeRosterItems(parsed);
  const merchants = listImportedMerchants(db, { buzz_env: buzzEnv });
  const byUid = new Map((merchants || []).map((item) => [item.merchant_uid, item]));
  const items = [];
  for (const item of stored) {
    const merchant = byUid.get(item.merchant_uid);
    if (!merchant) continue;
    const city = resolveMerchantCity(merchant) || "未分类";
    if (city !== "未分类" && !String(merchant.city || "").trim()) {
      patchMerchantCityIfEmpty(db, merchant.merchant_uid, city);
      merchant.city = city;
    }
    items.push({
      merchant_uid: item.merchant_uid,
      enabled: item.enabled !== false,
      name: merchant.name || "",
      city,
    });
  }
  if (items.length !== stored.length) {
    setMetaValue(
      db,
      rosterMetaKey(buzzEnv),
      JSON.stringify(items.map((item) => ({ merchant_uid: item.merchant_uid, enabled: item.enabled }))),
    );
  }
  return { buzz_env: buzzEnv, items };
}

function saveMerchantBubbleRoster(db, items, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const normalized = normalizeRosterItems(items);
  setMetaValue(
    db,
    rosterMetaKey(buzzEnv),
    JSON.stringify(normalized.map((item) => ({ merchant_uid: item.merchant_uid, enabled: item.enabled }))),
  );
  return getMerchantBubbleRoster(db, { ...options, buzz_env: buzzEnv });
}

function resolveBuzzEnv(options = {}) {
  return normalizeBuzzEnv(options.buzz_env || options.env);
}

function defaultPublishUserId(options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  if (shouldUseVestPool(options) && options.db && poolEnabled(buzzEnv)) {
    return getDefaultPoolUserId(options.db, buzzEnv);
  }
  return getBuzzEnvConfig(buzzEnv).defaultPublishUserId;
}

function ensurePoolContext(db, options = {}) {
  if (!shouldUseVestPool(options)) return null;
  const buzzEnv = resolveBuzzEnv(options);
  if (!poolEnabled(buzzEnv)) return null;
  if (options.poolContext) return options.poolContext;
  const pool = createPublishUserPoolContext(db, buzzEnv);
  options.poolContext = pool;
  if (!String(options.publish_user_id || "").trim()) {
    options.publish_user_id = pool.currentUserId();
  }
  return pool;
}

function notifyPoolRotate(options, rotation) {
  if (typeof options.onPoolRotate === "function") {
    options.onPoolRotate(rotation);
  }
}

async function createGroupForMerchantWithPool(merchant, options = {}) {
  const pool = options.poolContext;
  if (!pool) {
    const publishUserId = String(options.publish_user_id || options.owner || "").trim();
    return createGroupForMerchant(merchant, {
      ...options,
      owner: publishUserId,
      publish_user_id: publishUserId,
    });
  }

  const maxTries = pool.userCount();
  let lastError = null;
  for (let attempt = 0; attempt < maxTries; attempt += 1) {
    const publishUserId = pool.currentUserId();
    try {
      const groupId = await createGroupForMerchant(merchant, {
        ...options,
        owner: publishUserId,
        publish_user_id: publishUserId,
      });
      options.publish_user_id = publishUserId;
      return groupId;
    } catch (error) {
      lastError = error;
      if (!isImGroupLimitError(error)) throw error;
      const rotation = pool.rotateOnLimit(publishUserId);
      options.publish_user_id = rotation.to_user_id;
      notifyPoolRotate(options, rotation);
    }
  }
  throw lastError || new Error("所有马甲号群聊额度均已用尽");
}

function merchantInEnv(db, merchantUid, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  return applyBuzzEnvToMerchant(db, getMerchantByUid(db, merchantUid), buzzEnv);
}

function loadRotationState(db, buzzEnv) {
  const raw = getMetaValue(db, rotationMetaKey(buzzEnv), "{}");
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveRotationState(db, state, buzzEnv) {
  setMetaValue(db, rotationMetaKey(buzzEnv), state);
}

function shuffleInPlace(list, random = Math.random) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function groupMerchantsByCity(merchants) {
  const groups = new Map();
  for (const merchant of merchants) {
    const city = String(merchant.city || "未分类").trim() || "未分类";
    if (!groups.has(city)) groups.set(city, []);
    groups.get(city).push(merchant);
  }
  return groups;
}

function computeBucketCount(merchantCount) {
  const total = Math.max(0, Number(merchantCount) || 0);
  if (total === 0) return MIN_BUCKET_COUNT;
  return Math.max(MIN_BUCKET_COUNT, Math.ceil(total / MAX_BUCKET_SIZE));
}

function cityBucketCount(cityState) {
  const fromBuckets = Array.isArray(cityState?.buckets) ? cityState.buckets.length : 0;
  const stored = Number(cityState?.bucket_count);
  if (fromBuckets > 0) return fromBuckets;
  if (Number.isFinite(stored) && stored > 0) return stored;
  return 1;
}

function cityBucketsNeedRebuild(current, merchantUids) {
  if (!current?.buckets?.length) return true;
  const requiredCount = computeBucketCount(merchantUids.length);
  if (current.buckets.length !== requiredCount) return true;
  return current.buckets.some((bucket) => bucket.length > MAX_BUCKET_SIZE);
}

function splitIntoBuckets(merchantUids, bucketCount) {
  const count = Math.max(1, bucketCount || computeBucketCount(merchantUids.length));
  const buckets = Array.from({ length: count }, () => []);
  merchantUids.forEach((uid, index) => {
    buckets[index % count].push(uid);
  });
  return buckets;
}

function buildCityRotation(merchantUids, options = {}) {
  const bucketCount = computeBucketCount(merchantUids.length);
  const shuffled = shuffleInPlace([...merchantUids]);
  const slot = options.preserveSlot === true
    ? Math.max(0, Number(options.slot) || 0) % bucketCount
    : 0;
  return {
    slot,
    bucket_count: bucketCount,
    buckets: splitIntoBuckets(shuffled, bucketCount),
  };
}

function ensureCityRotation(state, city, merchantUids, options = {}) {
  const reshuffle = options.reshuffle === true;
  const current = state[city];
  const uidSet = new Set(merchantUids);
  if (!current || reshuffle || cityBucketsNeedRebuild(current, merchantUids)) {
    state[city] = buildCityRotation(merchantUids);
    return state[city];
  }

  const known = new Set(current.buckets.flat());
  const missing = merchantUids.filter((uid) => !known.has(uid));
  if (missing.length) {
    const bucketSizes = current.buckets.map((bucket) => bucket.length);
    for (const uid of missing) {
      const target = bucketSizes.indexOf(Math.min(...bucketSizes));
      current.buckets[target].push(uid);
      bucketSizes[target] += 1;
    }
  }

  current.buckets = current.buckets.map((bucket) => bucket.filter((uid) => uidSet.has(uid)));
  current.bucket_count = current.buckets.length;
  if (cityBucketsNeedRebuild(current, merchantUids)) {
    state[city] = buildCityRotation(merchantUids, {
      preserveSlot: true,
      slot: current.slot,
    });
    return state[city];
  }

  const bucketCount = cityBucketCount(current);
  current.slot = Number(current.slot) % bucketCount;
  if (!Number.isFinite(current.slot) || current.slot < 0) current.slot = 0;
  return current;
}

function importListOptions(options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  return {
    city: options.city || "",
    buzz_env: buzzEnv,
    limit: options.limit || 0,
    merchant_uids: options.merchant_uids,
  };
}

function fullStateOptions(options = {}) {
  return { buzz_env: resolveBuzzEnv(options) };
}

function rebuildRotationBuckets(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const merchants = listImportedMerchants(db, importListOptions(options));
  const byCity = groupMerchantsByCity(merchants);
  const state = loadRotationState(db, buzzEnv);

  for (const [city, list] of byCity.entries()) {
    ensureCityRotation(state, city, list.map((item) => item.merchant_uid), { reshuffle: true });
  }

  saveRotationState(db, state, buzzEnv);
  return { buzzEnv, options };
}

function pickMerchantsForCurrentSlot(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const merchants = listImportedMerchants(db, importListOptions(options));
  const byCity = groupMerchantsByCity(merchants);
  const state = loadRotationState(db, buzzEnv);
  const selected = [];
  const plan = [];

  for (const [city, list] of byCity.entries()) {
    const cityState = ensureCityRotation(
      state,
      city,
      list.map((item) => item.merchant_uid),
    );
    const bucketIndex = cityState.slot % cityBucketCount(cityState);
    const uidSet = new Set(cityState.buckets[bucketIndex] || []);
    const cityMerchants = list.filter((item) => uidSet.has(item.merchant_uid));
    selected.push(...cityMerchants);
    const bucketCount = cityBucketCount(cityState);
    plan.push({
      city,
      slot: bucketIndex,
      next_slot: (bucketIndex + 1) % bucketCount,
      count: cityMerchants.length,
      merchant_uids: cityMerchants.map((item) => item.merchant_uid),
    });
  }

  saveRotationState(db, state, buzzEnv);
  return { merchants: selected, plan, state, buzz_env: buzzEnv };
}

function advanceRotationSlots(db, cities, buzzEnv = "test") {
  const env = normalizeBuzzEnv(buzzEnv);
  const state = loadRotationState(db, env);
  const targetCities = cities?.length ? cities : Object.keys(state);
  for (const city of targetCities) {
    if (!state[city]) continue;
    const bucketCount = cityBucketCount(state[city]);
    state[city].slot = (Number(state[city].slot || 0) + 1) % bucketCount;
  }
  saveRotationState(db, state, env);
  return state;
}

function advanceCityRotationAfterBucket(db, city, publishedSlot, buzzEnv = "test") {
  const env = normalizeBuzzEnv(buzzEnv);
  const state = loadRotationState(db, env);
  if (!state[city]) return state;
  const bucketCount = cityBucketCount(state[city]);
  state[city].slot = (Number(publishedSlot) + 1) % bucketCount;
  saveRotationState(db, state, env);
  return state;
}

function getMerchantsInCityBucket(db, city, slotIndex, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const cityName = String(city || "").trim();
  if (!cityName) throw new Error("缺少城市");
  const merchants = listImportedMerchants(db, importListOptions({ ...options, city: cityName }));
  const cityMerchants = merchants.filter((item) => {
    const itemCity = String(item.city || "未分类").trim() || "未分类";
    return itemCity === cityName;
  });
  const state = loadRotationState(db, buzzEnv);
  const cityState = ensureCityRotation(
    state,
    cityName,
    cityMerchants.map((item) => item.merchant_uid),
  );
  saveRotationState(db, state, buzzEnv);
  const slot = Number(slotIndex);
  const bucketCount = cityBucketCount(cityState);
  if (!Number.isFinite(slot) || slot < 0 || slot >= bucketCount) {
    throw new Error(`分组序号无效: ${slotIndex}`);
  }
  const uidSet = new Set(cityState.buckets[slot] || []);
  return {
    city: cityName,
    slot,
    merchants: cityMerchants.filter((item) => uidSet.has(item.merchant_uid)),
    buzz_env: buzzEnv,
  };
}

function parseBuzzDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const ts = Date.parse(normalized);
  return Number.isFinite(ts) ? ts : null;
}

function isNowExpired(expiredAt, extra = {}) {
  const expiredStatus = Number(extra?.expired_status);
  if (expiredStatus === 1 || extra?.expired === true) return true;
  const ts = parseBuzzDateTime(expiredAt);
  if (ts == null) return false;
  return ts <= Date.now();
}

function nowDateTime() {
  return formatBuzzDateTime(new Date());
}

function formatBuzzDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function toBuzzDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2}))?/);
  if (match) return `${match[1]} ${match[2]}:${match[3] || "00"}`;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) throw new Error(`时间格式不对：${raw}`);
  return formatBuzzDateTime(new Date(ts));
}

function resolveMerchantBubbleSchedule(options = {}) {
  const startAt = options.start_at ? toBuzzDateTime(options.start_at) : "";
  const expiredAt = String(options.expired_at || "").trim()
    ? toBuzzDateTime(options.expired_at)
    : "";
  if (startAt && expiredAt) {
    const startTs = parseBuzzDateTime(startAt);
    const endTs = parseBuzzDateTime(expiredAt);
    if (startTs != null && endTs != null && endTs <= startTs) {
      throw new Error("过期时间必须晚于开始时间");
    }
  }
  return { start_at: startAt, expired_at: expiredAt };
}

function applyPublishSchedule(options = {}) {
  if (options._scheduleApplied) return options;
  const schedule = resolveMerchantBubbleSchedule(options);
  options.start_at = schedule.start_at;
  options.expired_at = schedule.expired_at;
  options._scheduleApplied = true;
  return options;
}

function resolveBubbleContentType(merchant, options = {}) {
  const raw = options.content_type;
  if (raw !== "" && raw != null && raw !== "auto") {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) {
      throw new Error("content_type 须为 0 或正整数，或填 auto");
    }
    return value;
  }
  return resolveMerchantBubbleContentType(merchant, options.merchant_types);
}

function localBubbleExpireTs(merchant) {
  const publishedAt = parseBuzzDateTime(merchant.bubble_published_at);
  if (publishedAt == null) return null;
  return publishedAt + BUBBLE_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
}

/** @returns {boolean|null} false=本地已过期或没有；null=需向后台核实真实 expired_at */
function isLocallyActiveBubble(merchant) {
  if (!String(merchant.bubble_now_id || "").trim()) return false;
  const expireTs = localBubbleExpireTs(merchant);
  if (expireTs != null && expireTs <= Date.now()) return false;
  return null;
}

async function verifyActiveBubblesRemotely(db, client, merchants, buzzEnv, options = {}) {
  const concurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : 20;
  const activeUids = new Set();
  if (!merchants.length) return activeUids;

  let index = 0;
  async function worker() {
    while (index < merchants.length) {
      const current = merchants[index];
      index += 1;
      try {
        const nowItem = await client.getNowById(current.bubble_now_id);
        if (nowItem && !isNowExpired(nowItem.expired_at, nowItem)) {
          activeUids.add(current.merchant_uid);
        } else if (!nowItem || isNowExpired(nowItem.expired_at, nowItem)) {
          clearMerchantBubbleLocal(db, current.merchant_uid, buzzEnv);
        }
      } catch {
        // 查询失败时不清理本地，避免网络抖动误删
      }
    }
  }

  const workers = Math.min(concurrency, merchants.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return activeUids;
}

async function loadActiveBubbleMerchantUids(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const cached = activeBubbleCache.get(buzzEnv);
  if (!options.refresh && cached && Date.now() - cached.at < ACTIVE_BUBBLE_CACHE_MS) {
    return new Set(cached.uids);
  }
  const merchants = listImportedMerchants(db, importListOptions(options));
  const withBubble = merchants.filter((item) => String(item.bubble_now_id || "").trim());
  const activeUids = new Set();
  if (!withBubble.length) {
    activeBubbleCache.set(buzzEnv, { at: Date.now(), uids: [] });
    return activeUids;
  }

  const needsRemote = [];
  for (const merchant of withBubble) {
    const local = isLocallyActiveBubble(merchant);
    if (local === true) {
      activeUids.add(merchant.merchant_uid);
      continue;
    }
    if (local === false) {
      clearMerchantBubbleLocal(db, merchant.merchant_uid, buzzEnv);
      continue;
    }
    needsRemote.push(merchant);
  }

  if (needsRemote.length) {
    const client = new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
    const verified = await verifyActiveBubblesRemotely(db, client, needsRemote, buzzEnv, options);
    for (const uid of verified) activeUids.add(uid);
  }
  activeBubbleCache.set(buzzEnv, { at: Date.now(), uids: [...activeUids] });
  return activeUids;
}

async function listBubbleMerchantsInBucket(db, city, slotIndex, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
  const pick = getMerchantsInCityBucket(db, city, slotIndex, options);
  const targets = [];
  const stale = [];

  for (const merchant of pick.merchants) {
    const nowId = String(merchant.bubble_now_id || "").trim();
    if (!nowId) continue;

    const localActive = isLocallyActiveBubble(merchant);
    if (localActive === false) {
      stale.push({
        merchant,
        now_id: nowId,
        reason: "expired",
      });
      continue;
    }
    if (localActive === true) {
      targets.push({
        merchant,
        now_id: nowId,
        now_item: null,
      });
      continue;
    }

    let nowItem = null;
    let fetchError = null;

    try {
      nowItem = await client.getNowById(nowId);
    } catch (error) {
      fetchError = error;
    }

    if (!nowItem) {
      stale.push({
        merchant,
        now_id: nowId,
        reason: fetchError ? "api_error" : "missing",
      });
      continue;
    }
    if (isNowExpired(nowItem.expired_at, nowItem)) {
      stale.push({
        merchant,
        now_id: nowId,
        reason: "expired",
        expired_at: nowItem.expired_at,
      });
      continue;
    }
    targets.push({
      merchant,
      now_id: nowId,
      now_item: nowItem,
    });
  }

  return { ...pick, targets, stale, client };
}

async function listMerchantsToPublish(db, options = {}) {
  const merchants = listImportedMerchants(db, importListOptions(options));
  if (!merchants.length) return merchants;
  const activeUids = await loadActiveBubbleMerchantUids(db, options);
  return merchants.filter((item) => !activeUids.has(item.merchant_uid));
}

async function merchantHasActiveBubble(merchant, options = {}) {
  const local = isLocallyActiveBubble(merchant);
  if (local === true) return true;
  if (local === false) return false;
  const nowId = String(merchant?.bubble_now_id || "").trim();
  if (!nowId) return false;
  try {
    const client = options.client || new BuzzAdminClient({ ...options, buzz_env: resolveBuzzEnv(options) });
    options.client = client;
    const nowItem = await client.getNowById(nowId);
    return Boolean(nowItem && !isNowExpired(nowItem.expired_at, nowItem));
  } catch {
    return true;
  }
}

async function deleteActiveBubbleForMerchant(db, merchant, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const nowId = String(merchant.bubble_now_id || "").trim();
  if (!nowId) {
    return {
      ok: true,
      skipped: true,
      merchant_uid: merchant.merchant_uid,
      name: merchant.name,
    };
  }
  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
  options.client = client;
  try {
    await client.deleteNow(nowId);
  } catch (error) {
    const msg = String(error.message || "");
    if (!/not found|不存在|404|already/i.test(msg)) {
      return {
        ok: false,
        merchant_uid: merchant.merchant_uid,
        name: merchant.name,
        now_id: nowId,
        error: error.message,
      };
    }
  }
  clearMerchantBubbleLocal(db, merchant.merchant_uid, buzzEnv);
  return {
    ok: true,
    deleted: true,
    merchant_uid: merchant.merchant_uid,
    name: merchant.name,
    now_id: nowId,
  };
}

async function mutateMerchantActiveBubble(db, merchantUid, action, options = {}) {
  const merchant = merchantInEnv(db, merchantUid, options);
  if (!merchant) {
    return { ok: false, merchant_uid: merchantUid, error: "商户不存在" };
  }
  const kind = String(action || "").trim();
  if (kind === "expire") {
    return expireActiveBubbleForMerchant(db, merchant, options);
  }
  if (kind === "delete") {
    return deleteActiveBubbleForMerchant(db, merchant, options);
  }
  throw new Error("请选择删除或设为过期");
}

function clearMerchantBubbleLocal(db, merchantUid, buzzEnv) {
  invalidateActiveBubbleCache(buzzEnv);
  markMerchantBubbleResult(db, merchantUid, {
    bubble_now_id: "",
    bubble_published_at: null,
  }, buzzEnv);
}

async function expireActiveBubbleForMerchant(db, merchant, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const nowId = String(merchant.bubble_now_id || "").trim();
  if (!nowId) {
    return {
      ok: true,
      skipped: true,
      merchant_uid: merchant.merchant_uid,
      name: merchant.name,
    };
  }
  if (isLocallyActiveBubble(merchant) === false) {
    clearMerchantBubbleLocal(db, merchant.merchant_uid, buzzEnv);
    return {
      ok: true,
      skipped: true,
      merchant_uid: merchant.merchant_uid,
      name: merchant.name,
      note: "本地已过期",
    };
  }
  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
  options.client = client;
  try {
    let nowItem = null;
    try {
      nowItem = await client.getNowById(nowId);
    } catch {
      nowItem = null;
    }
    if (nowItem) {
      const src = String(merchant.image || "").trim();
      const medias = pickNowMedias(nowItem);
      const hash = src ? fingerprintBubbleImage(src) : "";
      if (hash && medias.length) {
        markMerchantBubbleResult(db, merchant.merchant_uid, {
          bubble_media_hash: hash,
          bubble_media_json: JSON.stringify([{ src, ...medias[0] }]),
        }, buzzEnv);
      }
    }
    await client.updateNow(nowId, { expired_at: nowDateTime() });
    clearMerchantBubbleLocal(db, merchant.merchant_uid, buzzEnv);
    return {
      ok: true,
      expired: true,
      merchant_uid: merchant.merchant_uid,
      name: merchant.name,
      now_id: nowId,
    };
  } catch (error) {
    return {
      ok: false,
      merchant_uid: merchant.merchant_uid,
      name: merchant.name,
      now_id: nowId,
      error: error.message,
    };
  }
}

async function expireActiveBubblesForMerchants(db, merchants, options = {}) {
  const results = [];
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  for (const merchant of merchants) {
    const result = await expireActiveBubbleForMerchant(db, merchant, options);
    results.push(result);
    if (result.ok && result.expired) ok += 1;
    else if (result.ok && result.skipped) skipped += 1;
    else fail += 1;
    if (options.delayMs !== 0 && options.delayMs != null) {
      await sleep(options.delayMs);
    }
  }
  return { total: merchants.length, ok, fail, skipped, results };
}

async function expirePreviousCityBucketBubbles(db, city, publishingSlot, options = {}) {
  const cityName = String(city || "").trim();
  if (!cityName) throw new Error("缺少城市");
  const slot = Number(publishingSlot);
  if (!Number.isFinite(slot)) throw new Error("缺少分组序号");

  const buzzEnv = resolveBuzzEnv(options);
  const merchants = listImportedMerchants(db, importListOptions({ ...options, city: cityName }));
  const cityMerchants = merchants.filter((item) => {
    const itemCity = String(item.city || "未分类").trim() || "未分类";
    return itemCity === cityName;
  });
  const state = loadRotationState(db, buzzEnv);
  ensureCityRotation(
    state,
    cityName,
    cityMerchants.map((item) => item.merchant_uid),
  );
  saveRotationState(db, state, buzzEnv);
  const bucketCount = cityBucketCount(state[cityName]);
  const previousSlot = (slot - 1 + bucketCount) % bucketCount;
  const pick = getMerchantsInCityBucket(db, cityName, previousSlot, options);
  const toExpire = pick.merchants.filter((item) => String(item.bubble_now_id || "").trim());

  const report = await expireActiveBubblesForMerchants(db, toExpire, {
    ...options,
    delayMs: options.expire_delay_ms ?? 150,
  });

  return {
    city: cityName,
    publishing_slot: slot,
    previous_slot: previousSlot,
    candidates: toExpire.length,
    ...report,
  };
}

function staleBubbleNote(entry) {
  if (entry.reason === "expired") return "气泡已过期，已清理本地标记";
  if (entry.reason === "api_error") return "暂时无法查询气泡状态，未改动本地记录";
  return "气泡在后台已不存在（商户仍在），已清理本地气泡记录";
}

async function cleanupStaleBucketBubbles(db, stale, buzzEnv, options = {}) {
  const results = [];
  let cleaned = 0;
  let skipped = 0;

  for (const entry of stale) {
    if (entry.reason === "api_error") {
      results.push({
        ok: false,
        skipped: true,
        merchant_uid: entry.merchant.merchant_uid,
        name: entry.merchant.name,
        now_id: entry.now_id,
        note: staleBubbleNote(entry),
      });
      skipped += 1;
      continue;
    }
    clearMerchantBubbleLocal(db, entry.merchant.merchant_uid, buzzEnv);
    results.push({
      ok: true,
      cleaned: true,
      merchant_uid: entry.merchant.merchant_uid,
      name: entry.merchant.name,
      now_id: entry.now_id,
      note: staleBubbleNote(entry),
    });
    cleaned += 1;
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 100);
    }
  }

  return { results, cleaned, skipped };
}

const DEFAULT_PER_MERCHANT_CONTENT = "附近的小伙伴们可以约起来了～\n欢迎进群组局，来认识几个新朋友吧～";

function buildPerMerchantCopy(merchant, options = {}) {
  const name = String(merchant.name || "").trim();
  const content = String(options.unified_content || "").trim() || DEFAULT_PER_MERCHANT_CONTENT;
  return {
    now_title: name.slice(0, 128),
    now_content: content,
  };
}

function buildBubbleRecord(merchant, options = {}) {
  const publishUserId = String(options.publish_user_id || defaultPublishUserId(options)).trim();
  const copy = pickBubbleCopy(merchant, options);
  if (!copy.title) {
    throw new Error("请至少启用一组填好标题的文案");
  }

  applyPublishSchedule(options);
  const contentType = resolveBubbleContentType(merchant, options);
  const merchantTypeName = resolveMerchantTypeNameForBubble(merchant, options.merchant_types);

  return {
    user_id: publishUserId,
    publish_user_id: publishUserId,
    now_title: copy.title,
    now_content: copy.content,
    now_type: Number(options.now_type) || 1,
    content_type: contentType,
    merchant_type_name: merchantTypeName,
    now_merchant_id: merchant.buzz_merchant_id,
    location_poi_id: merchant.address_poi_id || "",
    location_name: merchant.poi_title || merchant.name || "",
    location_address: merchant.poi_address || merchant.address || "",
    location_latitude: merchant.latitude,
    location_longitude: merchant.longitude,
    start_at: options.start_at || "",
    expired_at: options.expired_at || "",
    group_id: "",
    images: merchant.image ? [merchant.image] : [],
  };
}

async function getMerchantBubbleState(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const viewOptions = fullStateOptions(options);
  const merchants = listImportedMerchants(db, importListOptions(viewOptions));
  await attachMerchantAdmins(db, merchants, { ...options, buzz_env: buzzEnv });
  const activeUids = await loadActiveBubbleMerchantUids(db, viewOptions);
  return {
    buzz_env: buzzEnv,
    imported_total: merchants.length,
    with_group: merchants.filter((item) => item.buzz_group_id).length,
    with_bubble: merchants.filter((item) => item.bubble_now_id).length,
    with_active_bubble: merchants.filter((item) => activeUids.has(item.merchant_uid)).length,
    with_admin: merchants.filter((item) => item.admin_user_id).length,
    default_publish_user_id: getBuzzEnvConfig(buzzEnv).defaultPublishUserId,
    roster: getMerchantBubbleRoster(db, { buzz_env: buzzEnv }).items,
    title_pools: getTitlePools(db),
    title_pool: getTitlePools(db)["酒馆"] || getTitlePool(db),
  };
}

async function listMerchantBubbleCandidates(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const merchants = listImportedMerchants(db, importListOptions({ ...options, buzz_env: buzzEnv }));
  let envTypes = [];
  try {
    envTypes = await ensureMerchantTypes({ ...options, buzz_env: buzzEnv });
  } catch {
    envTypes = [];
  }
  const query = String(options.q || options.keyword || "").trim().toLowerCase();
  const barOnly = options.bar_only === true || options.bar_only === "1" || options.bar_only === "true";
  await attachMerchantAdmins(db, merchants, { ...options, buzz_env: buzzEnv });
  const activeUids = await loadActiveBubbleMerchantUids(db, { ...options, buzz_env: buzzEnv });
  const rows = [];
  for (const merchant of merchants) {
    const typeName = resolveMerchantTypeNameForBubble(merchant, envTypes) || "未分类";
    const isBar = BAR_TYPE_NAMES.has(typeName);
    if (barOnly && !isBar) continue;
    const city = resolveMerchantCity(merchant) || "未分类";
    if (city !== "未分类" && !String(merchant.city || "").trim()) {
      patchMerchantCityIfEmpty(db, merchant.merchant_uid, city);
      merchant.city = city;
    }
    if (query) {
      const hay = `${merchant.name || ""} ${city} ${typeName}`.toLowerCase();
      if (!hay.includes(query)) continue;
    }
    rows.push({
      merchant_uid: merchant.merchant_uid,
      name: merchant.name,
      source: merchant.source || "",
      city,
      type_name: typeName,
      is_bar: isBar,
      has_group: Boolean(merchant.buzz_group_id),
      has_bubble: Boolean(merchant.bubble_now_id),
      has_active_bubble: activeUids.has(merchant.merchant_uid),
      admin_user_id: merchant.admin_user_id || "",
      admin_nickname: merchant.admin_nickname || "",
      bubble_published_at: merchant.bubble_published_at || "",
    });
  }
  const cities = [...new Set(rows.map((item) => item.city))].sort((a, b) => a.localeCompare(b, "zh"));
  return {
    buzz_env: buzzEnv,
    total: rows.length,
    bar_count: rows.filter((item) => item.is_bar).length,
    with_admin: rows.filter((item) => item.admin_user_id).length,
    with_active_bubble: rows.filter((item) => item.has_active_bubble).length,
    cities,
    merchants: rows,
  };
}

async function createMerchantGroup(db, merchantUid, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const merchant = merchantInEnv(db, merchantUid, options);
  if (!merchant) {
    return { ok: false, merchant_uid: merchantUid, error: "商户不存在" };
  }
  if (merchant.import_status !== "imported" || !merchant.buzz_merchant_id) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      name: merchant.name,
      error: "商户尚未入库后台",
      merchant,
    };
  }
  const pool = ensurePoolContext(db, options);
  let publishUserId = "";
  try {
    publishUserId = resolveMerchantPublishUserId(merchant, { ...options, db });
  } catch (error) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      name: merchant.name,
      error: error.message,
      merchant,
    };
  }
  const groupName = merchantGroupDisplayName(merchant);
  try {
    if (merchant.buzz_group_id) {
      await modifyGroupBaseInfo(merchant.buzz_group_id, { name: groupName });
      return {
        ok: true,
        renamed: true,
        merchant_uid: merchantUid,
        buzz_env: buzzEnv,
        name: merchant.name,
        group_id: merchant.buzz_group_id,
        publish_user_id: publishUserId,
        merchant,
      };
    }

    const groupId = await createGroupForMerchantWithPool(merchant, {
      ...options,
      owner: publishUserId,
      publish_user_id: publishUserId,
    });
    const updated = updateMerchantGroupId(db, merchantUid, groupId, buzzEnv);
    return {
      ok: true,
      created: true,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      group_id: groupId,
      publish_user_id: options.publish_user_id || publishUserId,
      merchant: updated,
    };
  } catch (error) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      name: merchant.name,
      error: error.message,
      publish_user_id: options.publish_user_id || publishUserId,
      merchant,
    };
  }
}

async function batchCreateMerchantGroups(db, options = {}) {
  const merchants = listImportedMerchants(db, importListOptions(options));
  const targets = options.only_missing === true
    ? merchants.filter((item) => !item.buzz_group_id)
    : merchants;

  ensurePoolContext(db, options);

  const results = [];
  let ok = 0;
  let fail = 0;
  let created = 0;
  let renamed = 0;

  for (const merchant of targets) {
    if (batchCanceled(options)) {
      return {
        total: targets.length,
        ok,
        fail,
        created,
        renamed,
        canceled: true,
        results,
        state: await getMerchantBubbleState(db, fullStateOptions(options)),
      };
    }
    const result = await createMerchantGroup(db, merchant.merchant_uid, options);
    results.push(result);
    if (result.ok) {
      ok += 1;
      if (result.created) created += 1;
      if (result.renamed) renamed += 1;
    } else fail += 1;
    if (typeof options.onItem === "function") options.onItem(result);
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 400);
    }
  }

  return {
    total: targets.length,
    ok,
    fail,
    created,
    renamed,
    results,
    state: await getMerchantBubbleState(db, fullStateOptions(options)),
  };
}

function clearMerchantGroupLocal(db, merchantUid, buzzEnv) {
  updateMerchantGroupId(db, merchantUid, "", buzzEnv);
}

async function dissolveMerchantGroup(db, merchantUid, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const merchant = merchantInEnv(db, merchantUid, options);
  if (!merchant) {
    return { ok: false, merchant_uid: merchantUid, error: "商户不存在" };
  }
  const groupId = String(merchant.buzz_group_id || "").trim();
  if (!groupId) {
    return {
      ok: true,
      skipped: true,
      merchant_uid: merchantUid,
      name: merchant.name,
      note: "本地无群聊记录",
      merchant,
    };
  }

  try {
    if (options.destroy_remote !== false) {
      await destroyGroup(groupId, { ignoreMissing: options.ignore_missing !== false });
    }
    clearMerchantGroupLocal(db, merchantUid, buzzEnv);
    return {
      ok: true,
      dissolved: true,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      group_id: groupId,
      merchant: merchantInEnv(db, merchantUid, options),
    };
  } catch (error) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      name: merchant.name,
      group_id: groupId,
      error: error.message,
      merchant,
    };
  }
}

async function batchDissolveMerchantGroups(db, options = {}) {
  const merchants = listImportedMerchants(db, importListOptions(options))
    .filter((item) => item.buzz_group_id);

  const results = [];
  let ok = 0;
  let fail = 0;
  let dissolved = 0;
  let skipped = 0;

  for (const merchant of merchants) {
    const result = await dissolveMerchantGroup(db, merchant.merchant_uid, options);
    results.push(result);
    if (result.ok) {
      ok += 1;
      if (result.dissolved) dissolved += 1;
      if (result.skipped) skipped += 1;
    } else fail += 1;
    if (typeof options.onItem === "function") options.onItem(result);
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 300);
    }
  }

  return {
    total: merchants.length,
    ok,
    fail,
    dissolved,
    skipped,
    results,
    state: await getMerchantBubbleState(db, fullStateOptions(options)),
  };
}

async function ensureMerchantTypes(options = {}) {
  if (Array.isArray(options.merchant_types) && options.merchant_types.length) {
    return options.merchant_types;
  }
  const buzzEnv = resolveBuzzEnv(options);
  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
  const types = await client.listMerchantTypes();
  options.merchant_types = types;
  options.client = client;
  return types;
}

async function publishMerchantBubble(db, merchantUid, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  applyPublishSchedule(options);
  attachTitlePicker(db, options);
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

  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
  const groupMode = options.group_mode === "create_new" ? "create_new" : "use_merchant";
  ensurePoolContext(db, options);
  let publishUserId = "";
  try {
    publishUserId = shouldUseVestPool(options) && poolEnabled(buzzEnv)
      ? resolvePoolPublishUserId(db, buzzEnv, options.publish_user_id)
      : resolveMerchantPublishUserId(merchant, { ...options, db });
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

  try {
    options.merchant_types = await ensureMerchantTypes({ ...options, buzz_env: buzzEnv, client });
    const current = merchantInEnv(db, merchantUid, options) || merchant;
    if (await merchantHasActiveBubble(current, { ...options, client })) {
      return {
        ok: true,
        skipped: true,
        merchant_uid: merchantUid,
        buzz_env: buzzEnv,
        name: merchant.name,
        now_id: current.bubble_now_id || "",
        note: "已有未过期气泡",
        merchant: current,
      };
    }
    const merchantForPublish = current;
    const record = buildBubbleRecord(merchantForPublish, { ...options, publish_user_id: publishUserId });
    let groupCreated = false;
    let groupOwnerTransferred = false;
    let groupOwnerId = String(merchantForPublish.bubble_group_owner_id || "").trim();

    if (groupMode === "use_merchant") {
      let groupId = String(merchantForPublish.buzz_group_id || "").trim();
      if (!groupId) {
        const created = await createMerchantGroup(db, merchantUid, {
          ...options,
          publish_user_id: publishUserId,
          client,
        });
        if (!created.ok) throw new Error(created.error || "自动创建商户群聊失败");
        groupId = String(created.group_id || "").trim();
        if (!groupId) throw new Error("自动创建商户群聊失败");
        groupCreated = Boolean(created.created);
        groupOwnerId = publishUserId;
      } else if (canSkipGroupOwnerTransfer(merchantForPublish, groupId, publishUserId)) {
        groupOwnerId = publishUserId;
      } else {
        const transferred = await ensureGroupOwner(groupId, publishUserId);
        groupOwnerTransferred = Boolean(transferred?.transferred);
        groupOwnerId = publishUserId;
      }
      record.group_id = groupId;
    } else {
      const groupId = await createGroupForMerchantWithPool(merchantForPublish, {
        ...options,
        owner: publishUserId,
        publish_user_id: publishUserId,
      });
      record.group_id = groupId;
      const finalPublishUserId = String(options.publish_user_id || publishUserId).trim();
      record.user_id = finalPublishUserId;
      record.publish_user_id = finalPublishUserId;
    }

    let mediaResult = await resolveBubbleMedias(client, record.images || [], merchantForPublish, {
      remoteMedias: options.remoteNowMedias,
    });
    const payload = buildBuzzPayload(record);
    if (mediaResult.medias.length) payload.now_medias = mediaResult.medias;
    payload.enroll_hidden = 1;

    let nowId = "";
    try {
      nowId = await client.createNow(payload);
    } catch (error) {
      if (!mediaResult.reused) throw error;
      mediaResult = await resolveBubbleMedias(client, record.images || [], merchantForPublish, {
        forceUpload: true,
      });
      if (mediaResult.medias.length) payload.now_medias = mediaResult.medias;
      nowId = await client.createNow(payload);
    }
    if (!nowId) throw new Error("创建成功但未返回 now_id");

    const bubblePatch = {
      bubble_now_id: nowId,
      bubble_published_at: new Date().toISOString(),
      bubble_media_hash: mediaResult.hash,
      bubble_media_json: mediaResult.mediaJson,
    };
    // 临时新建群只挂在本条气泡上，不覆盖商户已绑定的 buzz_group_id
    if (groupMode === "use_merchant") {
      bubblePatch.buzz_group_id = record.group_id;
      if (groupOwnerId) bubblePatch.bubble_group_owner_id = groupOwnerId;
    }

    invalidateActiveBubbleCache(buzzEnv);
    const updated = markMerchantBubbleResult(db, merchantUid, bubblePatch, buzzEnv);

    return {
      ok: true,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      now_id: nowId,
      group_id: record.group_id,
      group_created: groupCreated,
      group_owner_transferred: groupOwnerTransferred,
      media_reused: Boolean(mediaResult.reused),
      content_type: record.content_type,
      merchant_type_name: record.merchant_type_name,
      merchant: updated,
    };
  } catch (error) {
    return {
      ok: false,
      merchant_uid: merchantUid,
      name: merchant.name,
      error: error.message,
      merchant,
    };
  }
}

async function batchPublishMerchantBubbles(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  applyPublishSchedule(options);
  ensurePoolContext(db, options);
  options.buzz_env = buzzEnv;
  options.merchant_types = await ensureMerchantTypes(options);
  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
  options.client = client;

  if (!options.merchant_uids?.length) {
    throw new Error("请先勾选要发布的店");
  }
  const merchants = await listMerchantsToPublish(db, { ...options, buzz_env: buzzEnv });
  await attachRemoteNowMedias(client, merchants, options);

  const results = [];
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < merchants.length; i += 1) {
    const merchant = merchants[i];
    if (batchCanceled(options)) {
      return {
        total: merchants.length,
        ok,
        fail,
        canceled: true,
        buzz_env: buzzEnv,
        plan: [],
        results,
        state: await getMerchantBubbleState(db, fullStateOptions(options)),
      };
    }
    const result = await publishMerchantBubble(db, merchant.merchant_uid, options);
    results.push(result);
    if (result.ok) ok += 1;
    else fail += 1;
    if (typeof options.onItem === "function") options.onItem(result, { plan: [] });
    await pauseAfterBubblePublish(options, result, i === merchants.length - 1);
  }

  return {
    total: merchants.length,
    ok,
    fail,
    buzz_env: buzzEnv,
    plan: [],
    results,
    state: await getMerchantBubbleState(db, fullStateOptions(options)),
  };
}

function batchCanceled(options = {}) {
  return typeof options.shouldCancel === "function" && options.shouldCancel();
}

async function publishCityBucketBubbles(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  applyPublishSchedule(options);
  ensurePoolContext(db, options);
  options.buzz_env = buzzEnv;
  options.merchant_types = await ensureMerchantTypes(options);
  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
  options.client = client;
  const city = String(options.city || "").trim();
  if (!city) throw new Error("缺少城市");
  const slot = Number(options.slot);
  if (!Number.isFinite(slot)) throw new Error("缺少分组序号");

  const expiredPrevious = options.skip_expire_previous_batch
    ? null
    : await expirePreviousCityBucketBubbles(db, city, slot, options);

  const pick = getMerchantsInCityBucket(db, city, slot, options);
  await attachRemoteNowMedias(client, pick.merchants, options);
  const results = [];
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < pick.merchants.length; i += 1) {
    const merchant = pick.merchants[i];
    const result = await publishMerchantBubble(db, merchant.merchant_uid, options);
    results.push(result);
    if (result.ok) ok += 1;
    else fail += 1;
    if (typeof options.onItem === "function") options.onItem(result);
    await pauseAfterBubblePublish(options, result, i === pick.merchants.length - 1);
  }

  if (pick.merchants.length) {
    advanceCityRotationAfterBucket(db, city, slot, buzzEnv);
  }

  const state = loadRotationState(db, buzzEnv);
  const bucketCount = cityBucketCount(state[city]);

  return {
    total: pick.merchants.length,
    ok,
    fail,
    buzz_env: buzzEnv,
    city,
    slot,
    next_slot: (slot + 1) % bucketCount,
    expired_previous: expiredPrevious,
    results,
    state: await getMerchantBubbleState(db, fullStateOptions(options)),
  };
}

async function batchDeleteBucketBubbles(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const city = String(options.city || "").trim();
  if (!city) throw new Error("缺少城市");
  const slot = Number(options.slot);
  if (!Number.isFinite(slot)) throw new Error("缺少分组序号");

  const pick = await listBubbleMerchantsInBucket(db, city, slot, options);
  const results = [];
  let ok = 0;
  let fail = 0;

  for (const target of pick.targets) {
    const { merchant, now_id: nowId } = target;
    try {
      await pick.client.deleteNow(nowId);
      clearMerchantBubbleLocal(db, merchant.merchant_uid, buzzEnv);
      results.push({
        ok: true,
        merchant_uid: merchant.merchant_uid,
        name: merchant.name,
        now_id: nowId,
      });
      ok += 1;
    } catch (error) {
      results.push({
        ok: false,
        merchant_uid: merchant.merchant_uid,
        name: merchant.name,
        now_id: nowId,
        error: error.message,
      });
      fail += 1;
    }
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 400);
    }
  }

  const staleReport = await cleanupStaleBucketBubbles(db, pick.stale, buzzEnv, options);

  return {
    total: pick.targets.length + pick.stale.length,
    ok,
    fail,
    cleaned: staleReport.cleaned,
    skipped: staleReport.skipped,
    buzz_env: buzzEnv,
    city,
    slot,
    results: [...results, ...staleReport.results],
    state: await getMerchantBubbleState(db, fullStateOptions(options)),
  };
}

async function batchExpireBucketBubbles(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const city = String(options.city || "").trim();
  if (!city) throw new Error("缺少城市");
  const slot = Number(options.slot);
  if (!Number.isFinite(slot)) throw new Error("缺少分组序号");

  const pick = await listBubbleMerchantsInBucket(db, city, slot, options);
  const expiredAt = nowDateTime();
  const results = [];
  let ok = 0;
  let fail = 0;

  for (const target of pick.targets) {
    const { merchant, now_id: nowId } = target;
    try {
      await pick.client.updateNow(nowId, { expired_at: expiredAt });
      clearMerchantBubbleLocal(db, merchant.merchant_uid, buzzEnv);
      results.push({
        ok: true,
        merchant_uid: merchant.merchant_uid,
        name: merchant.name,
        now_id: nowId,
        expired_at: expiredAt,
      });
      ok += 1;
    } catch (error) {
      results.push({
        ok: false,
        merchant_uid: merchant.merchant_uid,
        name: merchant.name,
        now_id: nowId,
        error: error.message,
      });
      fail += 1;
    }
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 400);
    }
  }

  const staleReport = await cleanupStaleBucketBubbles(db, pick.stale, buzzEnv, options);

  return {
    total: pick.targets.length + pick.stale.length,
    ok,
    fail,
    cleaned: staleReport.cleaned,
    skipped: staleReport.skipped,
    buzz_env: buzzEnv,
    city,
    slot,
    expired_at: expiredAt,
    results: [...results, ...staleReport.results],
    state: await getMerchantBubbleState(db, fullStateOptions(options)),
  };
}

function clearAllLocalBubbleRecords(db, buzzEnv) {
  const env = normalizeBuzzEnv(buzzEnv);
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE buzz_imports
    SET bubble_now_id = '', bubble_published_at = NULL, updated_at = @updated_at
    WHERE entity_kind = 'merchant' AND buzz_env = @buzz_env AND bubble_now_id != ''
  `).run({ buzz_env: env, updated_at: now });
  return Number(result.changes) || 0;
}

async function expireAllActiveMerchantBubbles(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
  const merchants = listImportedMerchants(db, importListOptions(options));
  const withBubble = merchants.filter((item) => String(item.bubble_now_id || "").trim());
  const expiredAt = nowDateTime();
  const results = [];
  let ok = 0;
  let fail = 0;
  let skipped = 0;

  for (const merchant of withBubble) {
    const nowId = String(merchant.bubble_now_id || "").trim();
    try {
      const nowItem = await client.getNowById(nowId);
      if (!nowItem) {
        clearMerchantBubbleLocal(db, merchant.merchant_uid, buzzEnv);
        skipped += 1;
        results.push({
          ok: true,
          skipped: true,
          merchant_uid: merchant.merchant_uid,
          name: merchant.name,
          now_id: nowId,
          note: "后台已不存在，已清理本地记录",
        });
        continue;
      }
      if (isNowExpired(nowItem.expired_at, nowItem)) {
        clearMerchantBubbleLocal(db, merchant.merchant_uid, buzzEnv);
        skipped += 1;
        results.push({
          ok: true,
          skipped: true,
          merchant_uid: merchant.merchant_uid,
          name: merchant.name,
          now_id: nowId,
          note: "已是过期状态，已清理本地记录",
        });
        continue;
      }
      await client.updateNow(nowId, { expired_at: expiredAt });
      clearMerchantBubbleLocal(db, merchant.merchant_uid, buzzEnv);
      ok += 1;
      results.push({
        ok: true,
        merchant_uid: merchant.merchant_uid,
        name: merchant.name,
        now_id: nowId,
        expired_at: expiredAt,
      });
    } catch (error) {
      fail += 1;
      results.push({
        ok: false,
        merchant_uid: merchant.merchant_uid,
        name: merchant.name,
        now_id: nowId,
        error: error.message,
      });
    }
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 200);
    }
  }

  return {
    total: withBubble.length,
    ok,
    fail,
    skipped,
    buzz_env: buzzEnv,
    expired_at: expiredAt,
    results,
    state: await getMerchantBubbleState(db, fullStateOptions(options)),
  };
}

async function publishRandomTestMerchantBubble(db, options = {}) {
  const city = String(options.city || "北京").trim() || "北京";
  const merchants = listImportedMerchants(db, importListOptions({ ...options, city }));
  if (!merchants.length) {
    throw new Error(`「${city}」暂无已入库商户，无法发布测试气泡`);
  }

  const merchant = merchants[Math.floor(Math.random() * merchants.length)];
  const result = await publishMerchantBubble(db, merchant.merchant_uid, {
    ...options,
    city,
    group_mode: options.group_mode || "create_new",
    now_type: options.now_type || 1,
    skip_expire_previous: true,
    skip_expire_previous_batch: true,
  });
  if (typeof options.onItem === "function") options.onItem(result);

  return {
    ...result,
    city,
    picked_from: merchants.length,
    merchant_name: merchant.name,
    merchant_uid: merchant.merchant_uid,
    buzz_merchant_id: merchant.buzz_merchant_id,
    address: merchant.poi_address || merchant.address || "",
    state: await getMerchantBubbleState(db, fullStateOptions(options)),
  };
}

module.exports = {
  BUCKET_COUNT: MIN_BUCKET_COUNT,
  MIN_BUCKET_COUNT,
  MAX_BUCKET_SIZE,
  BAR_TYPE_NAMES,
  computeBucketCount,
  advanceCityRotationAfterBucket,
  advanceRotationSlots,
  batchCreateMerchantGroups,
  batchDissolveMerchantGroups,
  batchDeleteBucketBubbles,
  batchExpireBucketBubbles,
  batchPublishMerchantBubbles,
  buildBubbleRecord,
  buildPerMerchantCopy,
  clearAllLocalBubbleRecords,
  DEFAULT_PER_MERCHANT_CONTENT,
  DEFAULT_COPY_POOL,
  DEFAULT_TITLE_POOL,
  getTitlePool,
  getTitlePools,
  saveTitlePool,
  saveTitlePools,
  createMerchantGroup,
  defaultPublishUserId,
  dissolveMerchantGroup,
  expireAllActiveMerchantBubbles,
  getMerchantBubbleState,
  getMerchantBubbleRoster,
  saveMerchantBubbleRoster,
  getMerchantsInCityBucket,
  isNowExpired,
  listMerchantBubbleCandidates,
  listMerchantsToPublish,
  mutateMerchantActiveBubble,
  pickMerchantsForCurrentSlot,
  publishCityBucketBubbles,
  publishMerchantBubble,
  publishRandomTestMerchantBubble,
  rebuildRotationBuckets,
  resolveMerchantBubbleSchedule,
};

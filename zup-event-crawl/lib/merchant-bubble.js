"use strict";

const { BuzzAdminClient, buildBuzzPayload } = require("./buzz-now-import");
const {
  createGroupForMerchant,
  destroyGroup,
  merchantGroupDisplayName,
  modifyGroupBaseInfo,
} = require("./tencent-im-group");
const {
  getMerchantByUid,
  listImportedMerchants,
  markMerchantBubbleResult,
  updateMerchantGroupId,
} = require("./merchant-db");
const { applyBuzzEnvToMerchant } = require("./buzz-import-store");
const { getBuzzEnvConfig, normalizeBuzzEnv } = require("./buzz-env");
const {
  createPublishUserPoolContext,
  getDefaultPoolUserId,
  getPublishUserPoolStatus,
  isImGroupLimitError,
  poolEnabled,
  resolvePublishUserId: resolvePoolPublishUserId,
} = require("./publish-user-pool");
const {
  resolveMerchantBubbleContentType,
  resolveMerchantTypeNameForBubble,
} = require("./merchant-bubble-content-type");

const ROTATION_META_PREFIX = "merchant_bubble_rotation";
/** 每个城市至少分 3 组；单组超过 MAX_BUCKET_SIZE 时自动增加组数 */
const MIN_BUCKET_COUNT = 3;
const MAX_BUCKET_SIZE = 40;
const BUBBLE_EXPIRE_DAYS = 3;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function merchantBubbleExpiredAt() {
  const date = new Date();
  date.setDate(date.getDate() + BUBBLE_EXPIRE_DAYS);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
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

function resolveBuzzEnv(options = {}) {
  return normalizeBuzzEnv(options.buzz_env || options.env);
}

function defaultPublishUserId(options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  if (options.db && poolEnabled(buzzEnv)) {
    return getDefaultPoolUserId(options.db, buzzEnv);
  }
  return getBuzzEnvConfig(buzzEnv).defaultPublishUserId;
}

function ensurePoolContext(db, options = {}) {
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

function isNowExpired(expiredAt) {
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

function localBubbleExpireTs(merchant) {
  const publishedAt = parseBuzzDateTime(merchant.bubble_published_at);
  if (publishedAt == null) return null;
  return publishedAt + BUBBLE_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
}

/** @returns {boolean|null} true=本地未过期 false=本地已过期 null=无发布时间需远程核实 */
function isLocallyActiveBubble(merchant) {
  if (!String(merchant.bubble_now_id || "").trim()) return false;
  const expireTs = localBubbleExpireTs(merchant);
  if (expireTs == null) return null;
  return expireTs > Date.now();
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
        if (nowItem && !isNowExpired(nowItem.expired_at)) {
          activeUids.add(current.merchant_uid);
        } else if (!nowItem || isNowExpired(nowItem.expired_at)) {
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
  const merchants = listImportedMerchants(db, importListOptions(options));
  const withBubble = merchants.filter((item) => String(item.bubble_now_id || "").trim());
  const activeUids = new Set();
  if (!withBubble.length) return activeUids;

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
    if (isNowExpired(nowItem.expired_at)) {
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

function clearMerchantBubbleLocal(db, merchantUid, buzzEnv) {
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
  const titleMode = options.title_mode === "per_merchant" ? "per_merchant" : "unified";
  const copy = titleMode === "per_merchant"
    ? buildPerMerchantCopy(merchant, options)
    : {
      now_title: String(options.unified_title || "").trim(),
      now_content: String(options.unified_content || "").trim(),
    };

  if (!copy.now_title) {
    throw new Error("缺少气泡标题");
  }

  const contentType = resolveMerchantBubbleContentType(merchant, options.merchant_types);
  const merchantTypeName = resolveMerchantTypeNameForBubble(merchant, options.merchant_types);

  return {
    user_id: publishUserId,
    publish_user_id: publishUserId,
    now_title: copy.now_title,
    now_content: copy.now_content,
    now_type: Number(options.now_type) || 1,
    content_type: contentType,
    merchant_type_name: merchantTypeName,
    now_merchant_id: merchant.buzz_merchant_id,
    location_poi_id: merchant.address_poi_id || "",
    location_name: merchant.poi_title || merchant.name || "",
    location_address: merchant.poi_address || merchant.address || "",
    location_latitude: merchant.latitude,
    location_longitude: merchant.longitude,
    expired_at: options.expired_at || merchantBubbleExpiredAt(),
    group_id: "",
    images: merchant.image ? [merchant.image] : [],
  };
}

async function getMerchantBubbleState(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  const stateOptions = { ...options, db };
  const viewOptions = fullStateOptions(options);
  const merchants = listImportedMerchants(db, importListOptions(viewOptions));
  const activeUids = await loadActiveBubbleMerchantUids(db, viewOptions);
  const byCity = groupMerchantsByCity(merchants);
  const state = loadRotationState(db, buzzEnv);
  const cities = [];

  for (const [city, list] of byCity.entries()) {
    const cityState = ensureCityRotation(
      state,
      city,
      list.map((item) => item.merchant_uid),
    );
    const bucketCount = cityBucketCount(cityState);
    const bucketIndex = cityState.slot % bucketCount;
    cities.push({
      city,
      total: list.length,
      bucket_count: bucketCount,
      current_slot: bucketIndex,
      next_slot: (bucketIndex + 1) % bucketCount,
      buckets: cityState.buckets.map((uids, index) => ({
        index,
        count: uids.length,
        is_current: index === bucketIndex,
        with_bubble: list.filter((item) => uids.includes(item.merchant_uid) && item.bubble_now_id).length,
        with_active_bubble: list.filter((item) => uids.includes(item.merchant_uid) && activeUids.has(item.merchant_uid)).length,
      })),
      with_group: list.filter((item) => item.buzz_group_id).length,
      with_bubble: list.filter((item) => item.bubble_now_id).length,
      with_active_bubble: list.filter((item) => activeUids.has(item.merchant_uid)).length,
    });
  }

  saveRotationState(db, state, buzzEnv);

  return {
    buzz_env: buzzEnv,
    imported_total: merchants.length,
    with_group: merchants.filter((item) => item.buzz_group_id).length,
    with_bubble: merchants.filter((item) => item.bubble_now_id).length,
    with_active_bubble: merchants.filter((item) => activeUids.has(item.merchant_uid)).length,
    default_publish_user_id: defaultPublishUserId(stateOptions),
    publish_user_pool: poolEnabled(buzzEnv) ? getPublishUserPoolStatus(db, buzzEnv) : { enabled: false },
    cities,
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
  const publishUserId = String(
    options.publish_user_id
    || (pool ? pool.currentUserId() : "")
    || defaultPublishUserId({ ...options, db }),
  ).trim();
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
  const publishUserId = poolEnabled(buzzEnv)
    ? resolvePoolPublishUserId(db, buzzEnv, options.publish_user_id)
    : String(options.publish_user_id || defaultPublishUserId({ ...options, db })).trim();

  try {
    await ensureMerchantTypes({ ...options, buzz_env: buzzEnv, client });
    if (!options.skip_expire_previous) {
      const refreshed = merchantInEnv(db, merchantUid, options);
      if (refreshed && String(refreshed.bubble_now_id || "").trim() && isLocallyActiveBubble(refreshed) !== false) {
        await expireActiveBubbleForMerchant(db, refreshed, { ...options, client });
      }
    }
    const merchantForPublish = merchantInEnv(db, merchantUid, options) || merchant;
    const record = buildBubbleRecord(merchantForPublish, { ...options, publish_user_id: publishUserId });

    if (groupMode === "use_merchant") {
      if (!merchantForPublish.buzz_group_id) {
        throw new Error("商户尚无群聊，请先批量创建商户群聊");
      }
      record.group_id = merchantForPublish.buzz_group_id;
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

    const medias = [];
    for (const src of record.images || []) {
      const media = await client.uploadMedia(src);
      medias.push(media);
    }

    const payload = buildBuzzPayload(record);
    if (medias.length) payload.now_medias = medias;

    const nowId = await client.createNow(payload);
    if (!nowId) throw new Error("创建成功但未返回 now_id");

    const bubblePatch = {
      bubble_now_id: nowId,
      bubble_published_at: new Date().toISOString(),
    };
    // 临时新建群只挂在本条气泡上，不覆盖「批量创建商户群聊」写入的 buzz_group_id
    if (groupMode === "use_merchant") {
      bubblePatch.buzz_group_id = record.group_id;
    }

    const updated = markMerchantBubbleResult(db, merchantUid, bubblePatch, buzzEnv);

    return {
      ok: true,
      merchant_uid: merchantUid,
      buzz_env: buzzEnv,
      name: merchant.name,
      now_id: nowId,
      group_id: record.group_id,
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
  ensurePoolContext(db, options);
  await ensureMerchantTypes({ ...options, buzz_env: buzzEnv });
  const client = options.client || new BuzzAdminClient({ ...options, buzz_env: buzzEnv });
  options.client = client;

  const pick = options.merchant_uids?.length
    ? {
      merchants: listImportedMerchants(db, importListOptions(options)),
      plan: [],
    }
    : pickMerchantsForCurrentSlot(db, options);

  const expiredPrevious = [];
  if (!options.skip_expire_previous_batch && !options.merchant_uids?.length && !Number.isFinite(Number(options.slot))) {
    const seenCities = new Set();
    for (const item of pick.plan || []) {
      if (!item.city || seenCities.has(item.city)) continue;
      seenCities.add(item.city);
      const report = await expirePreviousCityBucketBubbles(db, item.city, item.slot, options);
      expiredPrevious.push(report);
    }
  }

  const merchants = pick.merchants;
  const results = [];
  let ok = 0;
  let fail = 0;

  for (const merchant of merchants) {
    const result = await publishMerchantBubble(db, merchant.merchant_uid, options);
    results.push(result);
    if (result.ok) ok += 1;
    else fail += 1;
    if (typeof options.onItem === "function") options.onItem(result, { plan: pick.plan });
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 1200);
    }
  }

  if (options.advance_rotation !== false && !options.merchant_uids?.length && !Number.isFinite(Number(options.slot))) {
    advanceRotationSlots(db, pick.plan.map((item) => item.city), buzzEnv);
  }

  return {
    total: merchants.length,
    ok,
    fail,
    buzz_env: buzzEnv,
    plan: pick.plan,
    expired_previous: expiredPrevious,
    results,
    state: await getMerchantBubbleState(db, fullStateOptions(options)),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishCityBucketBubbles(db, options = {}) {
  const buzzEnv = resolveBuzzEnv(options);
  ensurePoolContext(db, options);
  await ensureMerchantTypes({ ...options, buzz_env: buzzEnv });
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
  const results = [];
  let ok = 0;
  let fail = 0;

  for (const merchant of pick.merchants) {
    const result = await publishMerchantBubble(db, merchant.merchant_uid, options);
    results.push(result);
    if (result.ok) ok += 1;
    else fail += 1;
    if (typeof options.onItem === "function") options.onItem(result);
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 1200);
    }
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
      if (isNowExpired(nowItem.expired_at)) {
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
    title_mode: options.title_mode || "per_merchant",
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
  createMerchantGroup,
  defaultPublishUserId,
  dissolveMerchantGroup,
  expireAllActiveMerchantBubbles,
  getMerchantBubbleState,
  getMerchantsInCityBucket,
  isNowExpired,
  pickMerchantsForCurrentSlot,
  publishCityBucketBubbles,
  publishMerchantBubble,
  publishRandomTestMerchantBubble,
  rebuildRotationBuckets,
};

"use strict";

const { BuzzAdminClient, buildBuzzPayload } = require("./buzz-now-import");
const {
  createGroupForMerchant,
  merchantGroupDisplayName,
  modifyGroupBaseInfo,
} = require("./tencent-im-group");
const {
  getMerchantByUid,
  listImportedMerchants,
  markMerchantBubbleResult,
  updateMerchantGroupId,
} = require("./merchant-db");

const DEFAULT_PUBLISH_USER_ID = "579362104";
const ROTATION_META_KEY = "merchant_bubble_rotation";
const BUCKET_COUNT = 3;
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

function loadRotationState(db) {
  const raw = getMetaValue(db, ROTATION_META_KEY, "{}");
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveRotationState(db, state) {
  setMetaValue(db, ROTATION_META_KEY, state);
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

function splitIntoBuckets(merchantUids) {
  const buckets = [[], [], []];
  merchantUids.forEach((uid, index) => {
    buckets[index % BUCKET_COUNT].push(uid);
  });
  return buckets;
}

function ensureCityRotation(state, city, merchantUids, options = {}) {
  const reshuffle = options.reshuffle === true;
  const current = state[city];
  const uidSet = new Set(merchantUids);
  if (!current || reshuffle) {
    const shuffled = shuffleInPlace([...merchantUids]);
    state[city] = {
      slot: 0,
      buckets: splitIntoBuckets(shuffled),
    };
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
  current.slot = Number(current.slot) % BUCKET_COUNT;
  if (!Number.isFinite(current.slot) || current.slot < 0) current.slot = 0;
  return current;
}

function rebuildRotationBuckets(db, options = {}) {
  const merchants = listImportedMerchants(db, { city: options.city || "" });
  const byCity = groupMerchantsByCity(merchants);
  const state = loadRotationState(db);

  for (const [city, list] of byCity.entries()) {
    ensureCityRotation(state, city, list.map((item) => item.merchant_uid), { reshuffle: true });
  }

  saveRotationState(db, state);
  return getMerchantBubbleState(db, options);
}

function pickMerchantsForCurrentSlot(db, options = {}) {
  const merchants = listImportedMerchants(db, { city: options.city || "" });
  const byCity = groupMerchantsByCity(merchants);
  const state = loadRotationState(db);
  const selected = [];
  const plan = [];

  for (const [city, list] of byCity.entries()) {
    const cityState = ensureCityRotation(
      state,
      city,
      list.map((item) => item.merchant_uid),
    );
    const bucketIndex = cityState.slot % BUCKET_COUNT;
    const uidSet = new Set(cityState.buckets[bucketIndex] || []);
    const cityMerchants = list.filter((item) => uidSet.has(item.merchant_uid));
    selected.push(...cityMerchants);
    plan.push({
      city,
      slot: bucketIndex,
      next_slot: (bucketIndex + 1) % BUCKET_COUNT,
      count: cityMerchants.length,
      merchant_uids: cityMerchants.map((item) => item.merchant_uid),
    });
  }

  saveRotationState(db, state);
  return { merchants: selected, plan, state };
}

function advanceRotationSlots(db, cities) {
  const state = loadRotationState(db);
  const targetCities = cities?.length ? cities : Object.keys(state);
  for (const city of targetCities) {
    if (!state[city]) continue;
    state[city].slot = (Number(state[city].slot || 0) + 1) % BUCKET_COUNT;
  }
  saveRotationState(db, state);
  return state;
}

function buildPerMerchantCopy(merchant) {
  const name = String(merchant.name || "").trim();
  return {
    now_title: name.slice(0, 128),
    now_content: "欢迎进群组局邀约，看看谁有空一起。",
  };
}

function buildBubbleRecord(merchant, options = {}) {
  const publishUserId = String(options.publish_user_id || DEFAULT_PUBLISH_USER_ID).trim();
  const titleMode = options.title_mode === "per_merchant" ? "per_merchant" : "unified";
  const copy = titleMode === "per_merchant"
    ? buildPerMerchantCopy(merchant)
    : {
      now_title: String(options.unified_title || "").trim(),
      now_content: String(options.unified_content || "").trim(),
    };

  if (!copy.now_title) {
    throw new Error("缺少气泡标题");
  }

  return {
    user_id: publishUserId,
    publish_user_id: publishUserId,
    now_title: copy.now_title,
    now_content: copy.now_content,
    now_type: Number(options.now_type) || 1,
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

function getMerchantBubbleState(db, options = {}) {
  const merchants = listImportedMerchants(db, { city: options.city || "" });
  const byCity = groupMerchantsByCity(merchants);
  const state = loadRotationState(db);
  const cities = [];

  for (const [city, list] of byCity.entries()) {
    const cityState = ensureCityRotation(
      state,
      city,
      list.map((item) => item.merchant_uid),
    );
    const bucketIndex = cityState.slot % BUCKET_COUNT;
    cities.push({
      city,
      total: list.length,
      current_slot: bucketIndex,
      next_slot: (bucketIndex + 1) % BUCKET_COUNT,
      buckets: cityState.buckets.map((uids, index) => ({
        index,
        count: uids.length,
        is_current: index === bucketIndex,
      })),
      with_group: list.filter((item) => item.buzz_group_id).length,
      with_bubble: list.filter((item) => item.bubble_now_id).length,
    });
  }

  saveRotationState(db, state);

  return {
    imported_total: merchants.length,
    with_group: merchants.filter((item) => item.buzz_group_id).length,
    with_bubble: merchants.filter((item) => item.bubble_now_id).length,
    default_publish_user_id: DEFAULT_PUBLISH_USER_ID,
    cities,
  };
}

async function createMerchantGroup(db, merchantUid, options = {}) {
  const merchant = getMerchantByUid(db, merchantUid);
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
  const publishUserId = String(options.publish_user_id || DEFAULT_PUBLISH_USER_ID).trim();
  const groupName = merchantGroupDisplayName(merchant);
  try {
    if (merchant.buzz_group_id) {
      await modifyGroupBaseInfo(merchant.buzz_group_id, { name: groupName });
      return {
        ok: true,
        renamed: true,
        merchant_uid: merchantUid,
        name: merchant.name,
        group_id: merchant.buzz_group_id,
        merchant,
      };
    }

    const groupId = await createGroupForMerchant(merchant, {
      owner: publishUserId,
      publish_user_id: publishUserId,
    });
    const updated = updateMerchantGroupId(db, merchantUid, groupId);
    return {
      ok: true,
      created: true,
      merchant_uid: merchantUid,
      name: merchant.name,
      group_id: groupId,
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

async function batchCreateMerchantGroups(db, options = {}) {
  const merchants = listImportedMerchants(db, {
    city: options.city || "",
    limit: options.limit || 0,
  });
  const targets = options.only_missing === true
    ? merchants.filter((item) => !item.buzz_group_id)
    : merchants;

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
    state: getMerchantBubbleState(db, options),
  };
}

async function publishMerchantBubble(db, merchantUid, options = {}) {
  const merchant = getMerchantByUid(db, merchantUid);
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

  const client = options.client || new BuzzAdminClient(options);
  const groupMode = options.group_mode === "create_new" ? "create_new" : "use_merchant";
  const publishUserId = String(options.publish_user_id || DEFAULT_PUBLISH_USER_ID).trim();

  try {
    const record = buildBubbleRecord(merchant, { ...options, publish_user_id: publishUserId });

    if (groupMode === "use_merchant") {
      if (!merchant.buzz_group_id) {
        throw new Error("商户尚无群聊，请先批量创建商户群聊");
      }
      record.group_id = merchant.buzz_group_id;
    } else {
      const groupId = await createGroupForMerchant(merchant, {
        owner: publishUserId,
        publish_user_id: publishUserId,
      });
      record.group_id = groupId;
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

    const updated = markMerchantBubbleResult(db, merchantUid, {
      bubble_now_id: nowId,
      buzz_group_id: record.group_id,
      bubble_published_at: new Date().toISOString(),
    });

    return {
      ok: true,
      merchant_uid: merchantUid,
      name: merchant.name,
      now_id: nowId,
      group_id: record.group_id,
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
  const pick = options.merchant_uids?.length
    ? {
      merchants: listImportedMerchants(db, { merchant_uids: options.merchant_uids }),
      plan: [],
    }
    : pickMerchantsForCurrentSlot(db, options);

  const merchants = pick.merchants;
  const results = [];
  let ok = 0;
  let fail = 0;

  for (const merchant of merchants) {
    const result = await publishMerchantBubble(db, merchant.merchant_uid, options);
    results.push(result);
    if (result.ok) ok += 1;
    else fail += 1;
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 1200);
    }
  }

  if (options.advance_rotation !== false && !options.merchant_uids?.length) {
    advanceRotationSlots(db, pick.plan.map((item) => item.city));
  }

  return {
    total: merchants.length,
    ok,
    fail,
    plan: pick.plan,
    results,
    state: getMerchantBubbleState(db, options),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  BUCKET_COUNT,
  DEFAULT_PUBLISH_USER_ID,
  advanceRotationSlots,
  batchCreateMerchantGroups,
  batchPublishMerchantBubbles,
  buildBubbleRecord,
  buildPerMerchantCopy,
  createMerchantGroup,
  getMerchantBubbleState,
  pickMerchantsForCurrentSlot,
  publishMerchantBubble,
  rebuildRotationBuckets,
};

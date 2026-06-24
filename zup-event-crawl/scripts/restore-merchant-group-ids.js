#!/usr/bin/env node
"use strict";

/**
 * 恢复被「每次新建群聊」发布误写入的 buzz_group_id（仅本地记录）。
 *
 * 腾讯 IM 群 ID 无业务含义、无固定规律，不能靠 ID 片段判断群类型。
 * 可靠做法（--im-lookup）：在马甲号池的 IM 群列表里按店名匹配，取与登记表不同的那条正式群。
 *
 * 用法：
 *   node scripts/restore-merchant-group-ids.js --dry-run --env=prod --im-lookup
 *   node scripts/restore-merchant-group-ids.js --env=prod --im-lookup
 */

const path = require("path");
const TLSSigAPIv2 = require("tls-sig-api-v2");
const { openDatabase } = require("../lib/review-db");
const { getBuzzEnvConfig, normalizeBuzzEnv } = require("../lib/buzz-env");
const { updateMerchantGroupId } = require("../lib/merchant-db");
const { merchantGroupDisplayName } = require("../lib/tencent-im-group");
const { loadPoolUsers } = require("../lib/publish-user-pool");

const root = path.join(__dirname, "..");
const extraDb = process.argv.find((a) => a.endsWith(".db"));
const dbPath = extraDb || path.join(root, "data", "review.db");

const IM_BASE = "https://console.tim.qq.com/v4/";
const SDK = Number(process.env.BUZZ_IM_SDKAPPID || 1600107795);
const KEY = String(process.env.BUZZ_IM_KEY || "34b157159d5b5f21c5b6b02e43d3fb4e904b1a3c68092585e9cd36b67c841b9d").trim();
const ADMIN = "administrator";

function readFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readArg(name, fallback = "") {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function isTempGroupId(groupId) {
  return /RC4T/i.test(String(groupId || ""));
}

/** 测试「新建群聊」写入的临时群（含 RC4T 与 …C4Tx 后缀；正式批量群多为 …2T3T…） */
function isOverwrittenTestGroupId(groupId) {
  const id = String(groupId || "");
  if (!id) return false;
  if (/RC4T/i.test(id)) return true;
  if (/2T3T/i.test(id)) return false;
  return /C4T[A-Z0-9]$/i.test(id);
}

async function imPost(svc, body) {
  const api = new TLSSigAPIv2.Api(SDK, KEY);
  const usersig = api.genSig(ADMIN, 86400);
  const random = Math.floor(Math.random() * 1e7);
  const url = `${IM_BASE}${svc}?sdkappid=${SDK}&identifier=${ADMIN}&usersig=${encodeURIComponent(usersig)}&random=${random}&contenttype=json`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json();
  if (payload.ErrorCode !== 0) {
    throw new Error(payload.ErrorInfo || `IM 错误 code=${payload.ErrorCode}`);
  }
  return payload;
}

async function loadJoinedGroupIds(ownerUserId) {
  const ids = [];
  let offset = 0;
  while (offset <= 5000) {
    const result = await imPost("group_open_http_svc/get_joined_group_list", {
      Member_Account: String(ownerUserId).trim(),
      Offset: offset,
      Limit: 100,
    });
    const chunk = result.GroupIdList || [];
    for (const item of chunk) {
      if (item.GroupId && !isTempGroupId(item.GroupId)) {
        ids.push(item.GroupId);
      }
    }
    if (chunk.length < 100) break;
    offset += 100;
  }
  return ids;
}

async function loadGroupNames(groupIds) {
  const named = [];
  const batchSize = 50;
  for (let i = 0; i < groupIds.length; i += batchSize) {
    const slice = groupIds.slice(i, i + batchSize);
    const result = await imPost("group_open_http_svc/get_group_info", {
      GroupIdList: slice,
    });
    for (const item of result.GroupInfo || []) {
      if (item.ErrorCode === 0 && item.GroupId && item.Name) {
        named.push({ id: item.GroupId, name: item.Name });
      }
    }
  }
  return named;
}

function listFromTestBackup(db, targetEnv) {
  const refEnv = targetEnv === "prod" ? "test" : "prod";
  return db.prepare(`
    SELECT m.merchant_uid, m.name,
      ref.buzz_group_id AS restore_group,
      target.buzz_group_id AS wrong_group
    FROM merchants m
    JOIN buzz_imports target ON target.entity_uid = m.merchant_uid AND target.entity_kind = 'merchant' AND target.buzz_env = @targetEnv
    JOIN buzz_imports ref ON ref.entity_uid = m.merchant_uid AND ref.entity_kind = 'merchant' AND ref.buzz_env = @refEnv
    WHERE target.buzz_group_id LIKE '%RC4T%'
      AND ref.buzz_group_id != ''
      AND ref.buzz_group_id NOT LIKE '%RC4T%'
      AND ref.buzz_group_id != target.buzz_group_id
  `).all({ targetEnv, refEnv });
}

function listAllNeedRestore(db, targetEnv) {
  const rows = db.prepare(`
    SELECT m.merchant_uid, m.name, target.buzz_group_id AS wrong_group
    FROM merchants m
    JOIN buzz_imports target ON target.entity_uid = m.merchant_uid AND target.entity_kind = 'merchant' AND target.buzz_env = @targetEnv
    WHERE target.buzz_group_id != ''
  `).all({ targetEnv });
  return rows.filter((row) => isOverwrittenTestGroupId(row.wrong_group));
}

async function buildImGroupIndex(targetEnv) {
  const userIds = new Set([String(getBuzzEnvConfig(targetEnv).defaultPublishUserId || "").trim()]);
  for (const user of loadPoolUsers()) {
    if (user.user_id) userIds.add(String(user.user_id).trim());
  }
  userIds.delete("");

  const byName = new Map();
  for (const userId of userIds) {
    const groupIds = await loadJoinedGroupIds(userId);
    const groups = await loadGroupNames(groupIds);
    for (const group of groups) {
      if (!byName.has(group.name)) byName.set(group.name, []);
      byName.get(group.name).push({ id: group.id, owner: userId });
    }
  }
  return byName;
}

function pickFromIndex(byName, merchantName, wrongGroupId) {
  const target = merchantGroupDisplayName({ name: merchantName });
  const candidates = (byName.get(target) || []).filter((g) => g.id !== wrongGroupId);
  if (candidates.length === 1) return candidates[0].id;
  return "";
}

async function main() {
  const dryRun = readFlag("dry-run");
  const imLookup = readFlag("im-lookup");
  const targetEnv = normalizeBuzzEnv(readArg("env", "prod"));

  const db = openDatabase(dbPath);
  db.exec("PRAGMA busy_timeout = 15000");
  const fromTest = targetEnv === "test" ? listFromTestBackup(db, targetEnv) : [];
  const imPlans = [];

  if (imLookup) {
    const byName = await buildImGroupIndex(targetEnv);
    for (const row of listAllNeedRestore(db, targetEnv)) {
      const restore = pickFromIndex(byName, row.name, row.wrong_group);
      if (restore) {
        imPlans.push({ ...row, restore_group: restore, source: "im" });
      }
    }
  }

  const imUids = new Set(imPlans.map((p) => p.merchant_uid));
  const plans = [
    ...imPlans,
    ...fromTest
      .filter((row) => !imUids.has(row.merchant_uid))
      .map((row) => ({ ...row, source: "test-env" })),
  ];

  if (!plans.length) {
    console.log(`未发现可恢复的商户（env=${targetEnv}）`);
    db.close();
    return;
  }

  console.log(`${dryRun ? "[dry-run] " : ""}准备恢复 ${plans.length} 家商户群聊 ID（${targetEnv}）\n`);
  let ok = 0;
  for (const plan of plans) {
    console.log(`- ${plan.name}`);
    console.log(`  ${plan.wrong_group} → ${plan.restore_group} （${plan.source}）`);
    if (!dryRun) {
      updateMerchantGroupId(db, plan.merchant_uid, plan.restore_group, targetEnv);
      ok += 1;
    }
  }

  if (!dryRun) {
    console.log(`\n已恢复 ${ok} 家。临时群仍在腾讯 IM，未自动删除。`);
  } else {
    console.log("\n以上为预览，加 --env=prod 去掉 --dry-run 执行。");
  }

  const restoredUids = new Set(plans.map((p) => p.merchant_uid));
  const remaining = listAllNeedRestore(db, targetEnv).filter((row) => !restoredUids.has(row.merchant_uid));
  if (remaining.length) {
    console.log(`\n仍有 ${remaining.length} 家无法自动匹配，需人工核对或重新批量建群：`);
    for (const row of remaining.slice(0, 10)) {
      console.log(`  · ${row.name}`);
    }
    if (remaining.length > 10) console.log(`  … 另有 ${remaining.length - 10} 家`);
  }

  db.close();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

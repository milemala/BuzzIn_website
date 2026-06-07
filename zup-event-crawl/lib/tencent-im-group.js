"use strict";

const TLSSigAPIv2 = require("tls-sig-api-v2");

const IM_BASE = "https://console.tim.qq.com/v4/";
const DEFAULT_SDK_APP_ID = 1600107795;
const DEFAULT_IM_KEY = "34b157159d5b5f21c5b6b02e43d3fb4e904b1a3c68092585e9cd36b67c841b9d";
const ADMIN_ID = "administrator";
const ADMIN_SIG_EXPIRE = 86400 * 180;
const HTTP_TIMEOUT_MS = 30000;
const MAX_GROUP_NAME_LEN = 20;
const MAX_MERCHANT_GROUP_NAME_LEN = 30;

const VALID_GROUP_TYPES = new Set(["Public", "Private", "ChatRoom", "AVChatRoom", "Community"]);

function sdkAppId() {
  const n = Number(process.env.BUZZ_IM_SDKAPPID || DEFAULT_SDK_APP_ID);
  return Number.isFinite(n) ? n : DEFAULT_SDK_APP_ID;
}

function imKey() {
  return String(process.env.BUZZ_IM_KEY || DEFAULT_IM_KEY).trim();
}

function truncateRunes(value, max) {
  const chars = [...String(value || "")];
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max).join("");
}

function merchantGroupDisplayName(merchant) {
  return truncateRunes(String(merchant?.name || "").trim() || "商户群", MAX_MERCHANT_GROUP_NAME_LEN);
}

/** 从活动标题提炼短群名（语义截断，不超过 maxLen 个字） */
function summarizeGroupName(title, maxLen = MAX_GROUP_NAME_LEN) {
  let text = String(title || "").trim();
  if (!text) return "活动群";

  const stripPatterns = [
    /[|｜/／·•].*$/,
    /[@＠].*$/,
    /[—–－\-]+[^—–－\-]*(?:剧场|Live|LIVE|店|厅|馆|酒吧|club|Club|空间|中心|广场|路\d|大厦|万达|商场).*$/i,
    /[—–－\-]+.*$/,
    /\s*[（(][^）)]{0,40}(?:店|站|路|街|区|市)[^）)]*[）)].*$/,
  ];
  for (const pattern of stripPatterns) {
    const next = text.replace(pattern, "").trim();
    if (next.length >= 2) text = next;
  }

  if ([...text].length > maxLen) {
    const beforeBook = text.split(/[《「『]/)[0].trim();
    if (beforeBook.length >= 4) text = beforeBook;
  }

  text = text.replace(/[（(【\[《「『].*$/, "").trim();
  text = text.replace(/[—–－\-|｜/／·•@＠]+$/, "").trim();
  text = truncateRunes(text, maxLen);
  return text || "活动群";
}

function genAdminSig() {
  const api = new TLSSigAPIv2.Api(sdkAppId(), imKey());
  return api.genSig(ADMIN_ID, ADMIN_SIG_EXPIRE);
}

async function imPost(svc, body) {
  const usersig = genAdminSig();
  const random = Math.floor(Math.random() * 1e7);
  const url = `${IM_BASE}${svc}?sdkappid=${sdkAppId()}&identifier=${ADMIN_ID}&usersig=${encodeURIComponent(usersig)}&random=${random}&contenttype=json`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const raw = await response.text();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error(`腾讯 IM 响应非 JSON (${response.status}): ${raw.slice(0, 200)}`);
  }
  if (payload.ActionStatus !== "OK" || payload.ErrorCode !== 0) {
    throw new Error(payload.ErrorInfo || `腾讯 IM 错误 code=${payload.ErrorCode}`);
  }
  return payload;
}

async function importAccount(uid, nick = "", avatar = "") {
  const body = { UserID: String(uid).trim() };
  if (nick) body.Nick = nick;
  if (avatar) body.FaceUrl = avatar;
  try {
    await imPost("im_open_login_svc/account_import", body);
  } catch (error) {
    if (!/exist|已存在|already/i.test(error.message)) {
      throw error;
    }
  }
}

async function createGroup(options = {}) {
  const owner = String(options.owner || "").trim();
  if (!owner) throw new Error("建群缺少 owner（群主 user_id）");
  const type = options.type || "Public";
  if (!VALID_GROUP_TYPES.has(type)) {
    throw new Error(`群类型非法: ${type}`);
  }

  await importAccount(owner, options.ownerNick || "", options.ownerAvatar || "");

  const body = {
    Type: type,
    Owner_Account: owner,
  };
  if (options.name) {
    const maxLen = Number(options.maxNameLen) > 0 ? Number(options.maxNameLen) : MAX_GROUP_NAME_LEN;
    body.Name = truncateRunes(options.name, maxLen);
  }
  if (options.introduction) body.Introduction = truncateRunes(options.introduction, 240);
  if (options.notification) body.Notification = truncateRunes(options.notification, 300);
  if (options.faceUrl) body.FaceUrl = options.faceUrl;
  if (options.applyJoinOption) body.ApplyJoinOption = options.applyJoinOption;
  if (options.maxMemberCount) body.MaxMemberCount = options.maxMemberCount;

  const result = await imPost("group_open_http_svc/create_group", body);
  const groupId = result.GroupId || result.GroupID || "";
  if (!groupId) throw new Error("建群成功但未返回 group_id");
  return groupId;
}

async function modifyGroupBaseInfo(groupId, patch = {}) {
  const id = String(groupId || "").trim();
  if (!id) throw new Error("缺少 group_id");
  const body = { GroupId: id };
  if (patch.name) {
    const maxLen = Number(patch.maxNameLen) > 0 ? Number(patch.maxNameLen) : MAX_MERCHANT_GROUP_NAME_LEN;
    body.Name = truncateRunes(patch.name, maxLen);
  }
  if (patch.introduction) body.Introduction = truncateRunes(patch.introduction, 240);
  await imPost("group_open_http_svc/modify_group_base_info", body);
}

function resolveGroupOwner(record, options = {}) {
  const owner = String(
    options.owner || options.groupOwner || record.publish_user_id || record.user_id || ""
  ).trim();
  if (!owner) {
    throw new Error("建群缺少 owner（须与活动发布者 user_id 一致）");
  }
  return owner;
}

async function createGroupForNow(record, options = {}) {
  if (options.createGroup === false) return "";
  return createGroup({
    owner: resolveGroupOwner(record, options),
    name: summarizeGroupName(record.now_title),
    introduction: record.now_content || "",
    type: options.groupType || "Public",
    applyJoinOption: options.applyJoinOption || "FreeAccess",
  });
}

async function createGroupForMerchant(merchant, options = {}) {
  if (options.createGroup === false) return "";
  const owner = String(options.owner || options.publish_user_id || "").trim();
  if (!owner) throw new Error("建群缺少 owner（发布者 user_id）");
  const intro = String(merchant.description || merchant.category || merchant.name || "").trim();
  return createGroup({
    owner,
    name: merchantGroupDisplayName(merchant),
    maxNameLen: MAX_MERCHANT_GROUP_NAME_LEN,
    introduction: intro,
    type: options.groupType || "Public",
    applyJoinOption: options.applyJoinOption || "FreeAccess",
  });
}

module.exports = {
  createGroup,
  createGroupForMerchant,
  createGroupForNow,
  importAccount,
  merchantGroupDisplayName,
  modifyGroupBaseInfo,
  summarizeGroupName,
};

"use strict";

const path = require("path");
const {
  buildImportRecord,
  importReadyIssues,
  isImportReady,
} = require("./event-import-ready");
const { readImageForImport } = require("./image-fetch");
const { createGroupForNow } = require("./tencent-im-group");
const {
  clearEventBuzzNow,
  getEventByUid,
  syncEventMerchantByPoi,
  markEventImportResult,
} = require("./review-db");

const API_PREFIX = "/internal";
const HTTP_TIMEOUT_MS = 60000;
const DEFAULT_EXPIRE_DAYS = 30;
const DEFAULT_ADMIN_USER = "admin";
const DEFAULT_ADMIN_PASS = "Test1234";
const MAX_TITLE_LEN = 128;
const MAX_CONTENT_LEN = 2000;
function normalizeBase(base) {
  return String(base || process.env.BUZZ_API_BASE || "https://test-go-api.nowmap.cn").trim().replace(/\/$/, "");
}

function truncateRunes(value, max) {
  const chars = [...String(value || "")];
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, max).join("");
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function defaultExpiredAt() {
  const date = new Date();
  date.setDate(date.getDate() + DEFAULT_EXPIRE_DAYS);
  return formatDateTime(date);
}

const IMAGE_CACHE_DIR = path.join(__dirname, "..", "data", "image-cache");

async function readSource(src) {
  const url = String(src || "").trim();
  if (!url) throw new Error("媒体地址为空");
  const { buffer, filename, contentType } = await readImageForImport(url, IMAGE_CACHE_DIR);
  return { buffer, filename, contentType };
}

class BuzzAdminClient {
  constructor(options = {}) {
    this.base = normalizeBase(options.base);
    this.token = String(options.token || process.env.BUZZ_TOKEN || "").trim();
    this.user = String(options.user || process.env.BUZZ_ADMIN_USER || DEFAULT_ADMIN_USER).trim();
    this.pass = String(options.pass || process.env.BUZZ_ADMIN_PASS || DEFAULT_ADMIN_PASS).trim();
  }

  async ensureToken() {
    if (this.token) return this.token;
    if (!this.user || !this.pass) {
      throw new Error("未配置 BUZZ_TOKEN，且缺少后台账号密码");
    }
    const payload = await this.requestJSON("/auth/login", {
      username: this.user,
      password: this.pass,
    }, { skipAuth: true });
    if (!payload?.token) {
      throw new Error("登录响应未返回 token");
    }
    this.token = payload.token;
    return this.token;
  }

  async parseEnvelope(response) {
    const raw = await response.text();
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error(`响应非 JSON (${response.status}): ${raw.slice(0, 200)}`);
    }
    if (!response.ok && envelope.code !== 0) {
      throw new Error(envelope.message || `HTTP ${response.status}`);
    }
    if (envelope.code !== 0) {
      throw new Error(envelope.message || `业务错误 code=${envelope.code}`);
    }
    return envelope.data ?? null;
  }

  async requestJSON(path, body, options = {}) {
    const headers = { "Content-Type": "application/json" };
    if (!options.skipAuth) {
      await this.ensureToken();
      headers.Authorization = `Bearer ${this.token}`;
    }
    const response = await fetch(`${this.base}${API_PREFIX}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return this.parseEnvelope(response);
  }

  async deleteJSON(path) {
    await this.ensureToken();
    const response = await fetch(`${this.base}${API_PREFIX}${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    return this.parseEnvelope(response);
  }

  async postJSON(path, body) {
    return this.requestJSON(path, body);
  }

  async uploadMedia(src) {
    await this.ensureToken();
    const { buffer, filename, contentType } = await readSource(src);
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: contentType }), filename);
    const response = await fetch(`${this.base}${API_PREFIX}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: form,
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    const raw = await response.text();
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error(`上传响应非 JSON (${response.status})`);
    }
    if (envelope.code !== 0) {
      throw new Error(envelope.message || "上传媒体失败");
    }
    const out = envelope.data || {};
    return {
      media_id: out.media_id,
      media_url: out.media_url,
      media_type: out.media_type || 1,
      width: out.width || 0,
      height: out.height || 0,
    };
  }

  async findNow(userId, title) {
    const data = await this.postJSON("/nows/list", {
      page: 1,
      size: 100,
      keyword: title,
      user_identifier: userId,
    });
    const list = data?.list || [];
    for (const item of list) {
      if (item.now_title === title && item.user?.user_id === userId) {
        return item.now_id || "";
      }
    }
    return "";
  }

  async createNow(payload) {
    const data = await this.postJSON("/nows", payload);
    return data?.now_id || "";
  }

  async deleteNow(nowId) {
    const id = String(nowId || "").trim();
    if (!id) throw new Error("缺少 now_id");
    await this.deleteJSON(`/nows/${encodeURIComponent(id)}`);
  }
}

function buildBuzzPayload(record) {
  const payload = {
    user_id: record.user_id,
    now_title: truncateRunes(record.now_title, MAX_TITLE_LEN),
    now_type: record.now_type,
  };
  const nowContent = truncateRunes(record.now_content, MAX_CONTENT_LEN);
  if (nowContent) payload.now_content = nowContent;
  if (record.now_merchant_id) payload.now_merchant_id = record.now_merchant_id;
  if (record.location_poi_id) payload.location_poi_id = record.location_poi_id;
  if (record.location_name) payload.location_name = record.location_name;
  if (record.location_address) payload.location_address = record.location_address;
  if (record.location_latitude != null) payload.location_latitude = record.location_latitude;
  if (record.location_longitude != null) payload.location_longitude = record.location_longitude;
  if (record.start_at) payload.start_at = record.start_at;
  if (record.expired_at) {
    payload.expired_at = record.expired_at;
  } else {
    payload.expired_at = defaultExpiredAt();
  }
  if (record.group_id) payload.group_id = record.group_id;
  return payload;
}

function isEventApproved(db, eventUid) {
  const row = db.prepare(`
    SELECT status FROM review_decisions WHERE event_uid = ?
  `).get(eventUid);
  return row?.status === "approved";
}

async function importEventToBuzz(db, eventUid, options = {}) {
  const client = options.client || new BuzzAdminClient(options);
  const dedup = options.dedup !== false;
  let event = getEventByUid(db, eventUid);
  if (!event) {
    return { ok: false, event_uid: eventUid, error: "活动不存在" };
  }
  if (!isEventApproved(db, eventUid)) {
    return { ok: false, event_uid: eventUid, title: event.title, error: "仅已通过的活动可入库", event };
  }
  if (event.import_status === "imported" && event.buzz_now_id) {
    return {
      ok: true,
      skipped: true,
      event_uid: eventUid,
      title: event.title,
      now_id: event.buzz_now_id,
      event,
    };
  }

  if (event.location_poi_id && !event.now_merchant_id) {
    event = await syncEventMerchantByPoi(db, eventUid);
  }

  const issues = importReadyIssues(event);
  if (!isImportReady(event)) {
    return {
      ok: false,
      event_uid: eventUid,
      title: event.title,
      error: issues.join("；") || "入库字段未齐",
      event,
    };
  }

  const publishUserId = String(options.publish_user_id || event.publish_user_id || "").trim();
  const record = buildImportRecord({
    ...event,
    publish_user_id: publishUserId || event.publish_user_id,
  });
  if (!record.user_id) {
    return { ok: false, event_uid: eventUid, title: event.title, error: "缺少发布者 user_id", event };
  }

  try {
    if (dedup && record.now_title) {
      const existingId = await client.findNow(record.user_id, record.now_title);
      if (existingId) {
        const updated = markEventImportResult(db, eventUid, {
          buzz_now_id: existingId,
          import_status: "imported",
          import_error: "",
        });
        return {
          ok: true,
          skipped: true,
          event_uid: eventUid,
          title: event.title,
          now_id: existingId,
          event: updated,
        };
      }
    }

    const groupId = await createGroupForNow(record, {
      ...options,
      owner: record.publish_user_id || record.user_id,
    });
    record.group_id = groupId;

    // 封面只从本地 image-cache 读取，再 POST /internal/upload 传到 Buzz OSS（不用第三方 URL 建气泡）
    const medias = [];
    for (const src of record.images || []) {
      const media = await client.uploadMedia(src);
      medias.push(media);
    }

    const payload = buildBuzzPayload(record);
    if (medias.length) payload.now_medias = medias;

    const nowId = await client.createNow(payload);
    if (!nowId) {
      throw new Error("创建成功但未返回 now_id");
    }

    const updated = markEventImportResult(db, eventUid, {
      buzz_now_id: nowId,
      buzz_group_id: groupId,
      import_status: "imported",
      import_error: "",
    });
    return {
      ok: true,
      event_uid: eventUid,
      title: event.title,
      now_id: nowId,
      group_id: groupId,
      event: updated,
    };
  } catch (error) {
    const updated = markEventImportResult(db, eventUid, {
      import_status: "failed",
      import_error: error.message,
    });
    return {
      ok: false,
      event_uid: eventUid,
      title: event.title,
      error: error.message,
      event: updated,
    };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function batchImportApprovedEvents(db, options = {}) {
  const { listEventsEligibleForImport } = require("./review-db");
  const events = listEventsEligibleForImport(db, options);
  const results = [];
  let ok = 0;
  let fail = 0;
  let skipped = 0;

  for (const event of events) {
    if (options.shouldAbort?.()) {
      return {
        total: events.length,
        processed: ok + fail + skipped,
        ok,
        fail,
        skipped,
        results,
        aborted: true,
      };
    }
    const result = await importEventToBuzz(db, event.event_uid, options);
    results.push(result);
    if (result.skipped) skipped += 1;
    else if (result.ok) ok += 1;
    else fail += 1;
    if (options.delayMs !== 0) {
      await sleep(options.delayMs ?? 1200);
    }
  }

  return {
    total: events.length,
    processed: ok + fail + skipped,
    ok,
    fail,
    skipped,
    results,
    aborted: false,
  };
}

async function deleteEventFromBuzz(db, eventUid, options = {}) {
  const event = getEventByUid(db, eventUid);
  if (!event) {
    return { ok: false, event_uid: eventUid, error: "活动不存在" };
  }
  const nowId = String(event.buzz_now_id || "").trim();
  if (!nowId) {
    return {
      ok: false,
      event_uid: eventUid,
      title: event.title,
      error: "本地未记录 now_id，无法删除后台气泡",
      event,
    };
  }

  const client = options.client || new BuzzAdminClient(options);
  try {
    await client.deleteNow(nowId);
    const updated = clearEventBuzzNow(db, eventUid);
    return {
      ok: true,
      event_uid: eventUid,
      title: event.title,
      now_id: nowId,
      event: updated,
    };
  } catch (error) {
    return {
      ok: false,
      event_uid: eventUid,
      title: event.title,
      now_id: nowId,
      error: error.message,
      event,
    };
  }
}

module.exports = {
  BuzzAdminClient,
  batchImportApprovedEvents,
  buildBuzzPayload,
  defaultExpiredAt,
  deleteEventFromBuzz,
  importEventToBuzz,
};

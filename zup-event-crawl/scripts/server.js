#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const url = require("url");
const zlib = require("zlib");
const {
  applyDefaultImportPrepToActiveEvents,
  applyEventPoiSelection,
  countApprovedActiveEvents,
  getApprovedEvents,
  getEventByUid,
  getEventDetail,
  getEventsPayload,
  getExportImportNows,
  getReviewState,
  importPayload,
  importReviewState,
  openDatabase,
  clearReviewDecisions,
  patchReviewDecision,
  patchReviewDecisions,
  replaceReviewState,
  syncEventMerchantByPoi,
  syncMerchantsForPoiEvents,
  updateEventImportPrep,
  updateEventPoiCandidatesOnly,
} = require("../lib/review-db");
const {
  batchImportApprovedEvents,
  batchUpdateEventsExpiredAt,
  deleteEventFromBuzz,
  importEventToBuzz,
} = require("../lib/buzz-now-import");
const {
  batchImportApprovedMerchants,
  deleteMerchantFromBuzz,
  importMerchantToBuzz,
} = require("../lib/buzz-merchant-import");
const {
  applyPoiSelection,
  deleteLocalMerchant,
  getApprovedMerchants,
  getExportImportMerchants,
  getMerchantByUid,
  getMerchantForEnv,
  getMerchantImportProgress,
  getMerchantPoiCandidatesBatch,
  getMerchantPoiMatchMode,
  getMerchantReviewState,
  getMerchantsPayload,
  setMerchantPoiMatchMode,
  replaceMerchantReviewState,
  updateMerchantImportPrep,
  updatePoiCandidatesOnly,
} = require("../lib/merchant-db");
const { MERCHANT_TYPES } = require("../lib/merchant-import-ready");
const { listBuzzEnvsPublic, normalizeBuzzEnv } = require("../lib/buzz-env");
const { getPublishUserPoolStatus } = require("../lib/publish-user-pool");
const { BuzzAdminClient } = require("../lib/buzz-now-import");
const {
  batchCreateMerchantGroups,
  batchDissolveMerchantGroups,
  batchDeleteBucketBubbles,
  batchExpireBucketBubbles,
  batchPublishMerchantBubbles,
  getMerchantBubbleState,
  publishCityBucketBubbles,
  publishRandomTestMerchantBubble,
  rebuildRotationBuckets,
} = require("../lib/merchant-bubble");
const {
  getJob,
  publicJobView,
  startGroupsBatchJob,
  startPublishBatchJob,
  countGroupTargets,
  countPublishTargets,
} = require("../lib/merchant-bubble-jobs");
const { batchAutoPoi } = require("../lib/merchant-poi-batch");
const { syncMerchantsFromBuzz } = require("../lib/buzz-merchant-sync");
const {
  buildPoiKeyword,
  pickBestPoiForMerchant,
  reorderPoiByBestMatch,
  searchPoi,
  searchPoiForMerchant,
} = require("../lib/tencent-poi");

const root = path.join(__dirname, "..");
const publicDir = path.join(root, "public");
const port = Number(process.env.PORT || process.argv[2] || 8787);
const dbPath = path.join(root, "data", "review.db");
const decisionsPath = path.join(root, "data", "review-decisions.json");
const eventsPath = path.join(root, "data", "crawled-events.json");
const imageCacheDir = path.join(root, "data", "image-cache");
const db = openDatabase(dbPath);

function parseBuzzEnvFromRequest(req, body = {}) {
  const parsed = url.parse(req.url, true);
  return normalizeBuzzEnv(body.buzz_env || parsed.query.buzz_env);
}

function merchantForClient(db, merchantUid, req, body = {}) {
  return getMerchantForEnv(db, merchantUid, parseBuzzEnvFromRequest(req, body));
}

const merchantTypesCache = new Map();
const MERCHANT_TYPES_CACHE_MS = 5 * 60 * 1000;
const MERCHANT_TYPES_TIMEOUT_MS = 5000;

async function fetchMerchantTypesForEnv(buzzEnv, options = {}) {
  const env = normalizeBuzzEnv(buzzEnv);
  if (options.refresh) merchantTypesCache.delete(env);
  const cached = merchantTypesCache.get(env);
  if (cached && Date.now() - cached.at < MERCHANT_TYPES_CACHE_MS) {
    return cached.types;
  }
  const client = new BuzzAdminClient({ buzz_env: env });
  try {
    const types = await Promise.race([
      client.listMerchantTypes(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("merchant-types timeout")), MERCHANT_TYPES_TIMEOUT_MS);
      }),
    ]);
    if (types.length) {
      merchantTypesCache.set(env, { types, at: Date.now() });
      return types;
    }
  } catch {
    // 拉取失败时回退本地常用列表
  }
  return MERCHANT_TYPES;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const legacyReviewPaths = new Set([
  "/",
  "/index.html",
  "/review.html",
  "/events/crawl-review.html",
]);

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function sendJson(res, statusCode, payload, req) {
  const body = `${JSON.stringify(payload)}\n`;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  const accept = String(req?.headers?.["accept-encoding"] || "");
  if (req && accept.includes("gzip") && body.length > 2048) {
    zlib.gzip(body, (error, compressed) => {
      if (error) {
        res.writeHead(statusCode, headers);
        res.end(body);
        return;
      }
      res.writeHead(statusCode, {
        ...headers,
        "Content-Encoding": "gzip",
        "Vary": "Accept-Encoding",
      });
      res.end(compressed);
    });
    return;
  }
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendFile(res, filePath, contentType, cacheControl = "no-store") {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { ok: false, error: "File not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType || mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": cacheControl,
    });
    res.end(data);
  });
}

function getCachedImagePath(src, contentType) {
  const extFromUrl = path.extname(new URL(src).pathname).split("?")[0];
  const extFromType = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  }[String(contentType || "").split(";")[0].toLowerCase()];
  const ext = extFromType || extFromUrl || ".img";
  const name = crypto.createHash("sha1").update(src).digest("hex");
  return path.join(imageCacheDir, `${name}${ext}`);
}

async function handleImageProxy(req, res, parsed) {
  const rawSrc = parsed.query && parsed.query.src;
  const refererParam = parsed.query && parsed.query.referer;
  if (!rawSrc) {
    sendJson(res, 400, { ok: false, error: "Missing image src" });
    return;
  }

  const { normalizeMerchantImageUrl } = require("../lib/merchant-image-url");
  const src = normalizeMerchantImageUrl(rawSrc) || rawSrc;

  const { getComposedImagePath, parseComposedEventUid } = require("../lib/composed-image");
  const composedUid = parseComposedEventUid(src);
  if (composedUid) {
    const composedPath = getComposedImagePath(composedUid, root);
    if (!fs.existsSync(composedPath)) {
      sendJson(res, 404, { ok: false, error: "Composed image not found" });
      return;
    }
    sendFile(res, composedPath, null, "no-store");
    return;
  }

  const { getScrapeLocalImagePath } = require("../lib/scrape-local-image");
  const scrapeLocalPath = getScrapeLocalImagePath(src, root);
  if (scrapeLocalPath) {
    if (!fs.existsSync(scrapeLocalPath)) {
      sendJson(res, 404, { ok: false, error: "Scrape local image not found" });
      return;
    }
    sendFile(res, scrapeLocalPath, null, "public, max-age=86400");
    return;
  }

  let imageUrl;
  try {
    imageUrl = new URL(src);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: "Invalid image src" });
    return;
  }

  const defaultReferer = /meituan\.net|dianping\.com/i.test(src)
    ? "https://www.dianping.com/"
    : "https://www.douban.com/";
  const referer = refererParam || defaultReferer;

  if (!["https:", "http:"].includes(imageUrl.protocol)) {
    sendJson(res, 400, { ok: false, error: "Unsupported image protocol" });
    return;
  }

  fs.mkdirSync(imageCacheDir, { recursive: true });
  const hashPrefix = crypto.createHash("sha1").update(src).digest("hex");
  const existingCandidates = fs.existsSync(imageCacheDir)
    ? fs.readdirSync(imageCacheDir).filter((name) => name.startsWith(hashPrefix))
    : [];
  if (existingCandidates.length) {
    sendFile(res, path.join(imageCacheDir, existingCandidates[0]), null, "public, max-age=86400");
    return;
  }

  try {
    const response = await fetch(src, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: referer,
      },
    });
    if (!response.ok) {
      sendJson(res, response.status, { ok: false, error: `Image fetch failed: ${response.status}` });
      return;
    }
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());
    const cachedPath = getCachedImagePath(src, contentType);
    fs.writeFileSync(cachedPath, buffer);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=86400",
    });
    res.end(buffer);
  } catch (error) {
    sendJson(res, 502, { ok: false, error: error.message });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

let databaseSeededChecked = false;

function ensureDatabaseSeeded() {
  if (databaseSeededChecked) return;

  const row = db.prepare("SELECT COUNT(*) AS count FROM events").get();
  if (Number(row?.count) > 0) {
    databaseSeededChecked = true;
    return;
  }

  if (fs.existsSync(eventsPath)) {
    importPayload(db, readJson(eventsPath, { events: [] }), { mode: "replace-all" });
  }
  if (fs.existsSync(decisionsPath)) {
    importReviewState(db, readJson(decisionsPath, { decisions: {} }));
  }
  databaseSeededChecked = true;
}

async function handleApi(req, res, pathname) {
  ensureDatabaseSeeded();

  if (req.method === "GET" && pathname === "/api/image") {
    handleImageProxy(req, res, url.parse(req.url, true));
    return;
  }

  if (req.method === "GET" && pathname === "/api/buzz-envs") {
    const buzzEnv = parseBuzzEnvFromRequest(req);
    const envs = listBuzzEnvsPublic().map((item) => {
      const pool = getPublishUserPoolStatus(db, item.key);
      if (!pool.enabled) return item;
      return {
        ...item,
        default_publish_user_id: pool.default_publish_user_id || item.default_publish_user_id,
        publish_user_pool: pool,
      };
    });
    sendJson(res, 200, { envs, publish_user_pool: getPublishUserPoolStatus(db, buzzEnv) });
    return;
  }

  if (req.method === "GET" && pathname === "/api/publish-user-pool/status") {
    const buzzEnv = parseBuzzEnvFromRequest(req);
    sendJson(res, 200, getPublishUserPoolStatus(db, buzzEnv));
    return;
  }

  if (req.method === "GET" && pathname === "/api/events") {
    const buzzEnv = parseBuzzEnvFromRequest(req);
    sendJson(res, 200, getEventsPayload(db, { buzz_env: buzzEnv }));
    return;
  }

  const eventDetailMatch = pathname.match(/^\/api\/events\/([^/]+)\/detail$/);
  if (req.method === "GET" && eventDetailMatch) {
    const eventUid = decodeURIComponent(eventDetailMatch[1]);
    const detail = getEventDetail(db, eventUid);
    if (!detail) {
      sendJson(res, 404, { ok: false, error: "活动不存在" });
      return;
    }
    sendJson(res, 200, detail);
    return;
  }

  if (req.method === "GET" && pathname === "/api/review-state") {
    sendJson(res, 200, getReviewState(db));
    return;
  }

  if (req.method === "GET" && pathname === "/api/approved-events") {
    const events = await getApprovedEvents(db);
    sendJson(res, 200, { updatedAt: getReviewState(db).updatedAt, events });
    return;
  }

  if (req.method === "GET" && pathname === "/api/export-import-nows") {
    const parsed = url.parse(req.url, true);
    const approvedOnly = parsed.query.approved_only !== "0";
    const readyOnly = parsed.query.ready_only !== "0";
    const records = await getExportImportNows(db, { approvedOnly, readyOnly });
    sendJson(res, 200, {
      count: records.length,
      nows: records,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/events/import-prep-batch") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const defaults = applyDefaultImportPrepToActiveEvents(db);
      sendJson(res, 200, {
        ok: true,
        defaults,
        poi: { total: 0, ok: 0, fail: 0, results: [], skipped: true, reason: "活动 POI 由 Cursor Agent 匹配，不再批量 JS 自动 POI" },
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/events/poi-auto-batch") {
    sendJson(res, 410, {
      ok: false,
      error: "活动批量 JS 自动 POI 已停用。请用 Cursor Agent 匹配 POI，见 docs/event-poi-agent-workflow.md",
    });
    return;
  }

  const eventPoiMatch = pathname.match(/^\/api\/events\/([^/]+)\/poi$/);
  if (req.method === "POST" && eventPoiMatch) {
    try {
      const eventUid = decodeURIComponent(eventPoiMatch[1]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const event = getEventByUid(db, eventUid);
      if (!event) {
        sendJson(res, 404, { ok: false, error: "活动不存在" });
        return;
      }

      let poi = null;
      let candidates = event.poi_candidates || [];

      if (body.poi_id) {
        poi = {
          poi_id: body.poi_id,
          title: body.title || "",
          address: body.address || "",
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
        };
        if (Array.isArray(body.candidates)) {
          candidates = body.candidates;
        }
      } else if (Number.isInteger(body.candidate_index) || Number.isFinite(body.candidate_index)) {
        const idx = Number(body.candidate_index);
        if (!candidates.length) {
          const keyword = String(body.keyword || event.poi_agent_search_keyword || "").trim();
          if (!keyword) {
            sendJson(res, 400, {
              ok: false,
              error: "无候选列表，请先填写关键词并刷新候选",
            });
            return;
          }
          const search = await searchPoi({ keyword, city: event.city || "全国" });
          candidates = search.items;
        }
        poi = candidates[idx];
        if (!poi) {
          sendJson(res, 400, { ok: false, error: "候选 POI 不存在" });
          return;
        }
      } else {
        const keyword = String(
          body.keyword || event.poi_agent_search_keyword || "",
        ).trim();
        if (!keyword) {
          sendJson(res, 400, {
            ok: false,
            error: "请填写搜索关键词，或等待 Cursor Agent 完成 POI 匹配后再在审核页修正",
          });
          return;
        }
        const search = await searchPoi({
          keyword,
          city: body.city || event.city || "全国",
        });
        candidates = reorderPoiByBestMatch(keyword, search.items, [
          event.location,
          event.title,
        ].filter(Boolean));
        if (!candidates.length) {
          sendJson(res, 200, {
            ok: true,
            event: getEventByUid(db, eventUid),
            candidates: [],
            keyword: search.keyword || keyword,
          });
          return;
        }
        if (body.candidates_only || body.refresh) {
          const updated = updateEventPoiCandidatesOnly(db, eventUid, candidates);
          sendJson(res, 200, {
            ok: true,
            event: updated,
            candidates,
            keyword: search.keyword || keyword,
          });
          return;
        }
        sendJson(res, 400, {
          ok: false,
          error: "请从候选列表中点选 POI，或使用「刷新候选」",
          candidates,
          keyword: search.keyword || keyword,
        });
        return;
      }

      applyEventPoiSelection(db, eventUid, poi, {
        candidates,
        matchSource: body.match_source || "manual",
      });
      const updated = await syncEventMerchantByPoi(db, eventUid);
      sendJson(res, 200, { ok: true, event: updated, candidates });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  const eventImportMatch = pathname.match(/^\/api\/events\/([^/]+)\/import$/);
  if (req.method === "POST" && eventImportMatch) {
    try {
      const eventUid = decodeURIComponent(eventImportMatch[1]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const buzzEnv = parseBuzzEnvFromRequest(req, body);
      const result = await importEventToBuzz(db, eventUid, {
        buzz_env: buzzEnv,
        publish_user_id: body.publish_user_id,
      });
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  const eventBuzzDeleteMatch = pathname.match(/^\/api\/events\/([^/]+)\/buzz-now$/);
  if (req.method === "DELETE" && eventBuzzDeleteMatch) {
    try {
      const eventUid = decodeURIComponent(eventBuzzDeleteMatch[1]);
      const parsed = url.parse(req.url, true);
      const buzzEnv = normalizeBuzzEnv(parsed.query.buzz_env);
      const result = await deleteEventFromBuzz(db, eventUid, { buzz_env: buzzEnv });
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/events/import-batch") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const buzzEnv = parseBuzzEnvFromRequest(req, body);
      const report = await batchImportApprovedEvents(db, {
        buzz_env: buzzEnv,
        event_uids: Array.isArray(body.event_uids) ? body.event_uids : undefined,
        limit: body.limit || 200,
        delayMs: body.delay_ms ?? 1200,
        dedup: body.dedup !== false,
        shouldAbort: () => req.aborted,
      });
      sendJson(res, 200, { ok: true, ...report });
    } catch (error) {
      if (req.aborted) {
        sendJson(res, 499, { ok: false, aborted: true, error: "客户端已中止入库" });
        return;
      }
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/events/batch-expired-at") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const buzzEnv = parseBuzzEnvFromRequest(req, body);
      const eventUids = Array.isArray(body.event_uids) ? body.event_uids : [];
      if (!eventUids.length) {
        throw new Error("缺少 event_uids");
      }
      const report = await batchUpdateEventsExpiredAt(db, eventUids, {
        buzz_env: buzzEnv,
        expired_at: body.expired_at,
        days_from_now: body.days_from_now,
        sync_buzz: body.sync_buzz !== false,
      });
      sendJson(res, 200, { ok: true, ...report });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/events/sync-merchants") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const buzzEnv = parseBuzzEnvFromRequest(req, body);
      const report = await syncMerchantsForPoiEvents(db, {
        buzz_env: buzzEnv,
        only_missing: body.only_missing !== false,
      });
      sendJson(res, 200, { ok: true, ...report });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  const eventPrepMatch = pathname.match(/^\/api\/events\/([^/]+)\/import-prep$/);
  if (req.method === "POST" && eventPrepMatch) {
    try {
      const eventUid = decodeURIComponent(eventPrepMatch[1]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const buzzEnv = parseBuzzEnvFromRequest(req, body);
      const updated = updateEventImportPrep(db, eventUid, body, { buzz_env: buzzEnv });
      sendJson(res, 200, { ok: true, event: updated });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/review-state") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.clear === true) {
        clearReviewDecisions(db);
      } else if (body.replace === true) {
        const decisions = body.decisions && typeof body.decisions === "object" ? body.decisions : {};
        replaceReviewState(db, decisions);
      } else if (body.eventUid || body.event_uid || body.key) {
        const key = body.eventUid || body.event_uid || body.key;
        patchReviewDecision(db, key, body.status);
      } else if (body.decisions && typeof body.decisions === "object") {
        patchReviewDecisions(db, body.decisions);
      } else {
        throw new Error("缺少审核参数：需要 eventUid+status、decisions 或 clear/replace");
      }
      const state = getReviewState(db);
      sendJson(res, 200, {
        ok: true,
        updatedAt: state.updatedAt,
        approvedCount: countApprovedActiveEvents(db),
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/merchants") {
    const parsed = url.parse(req.url, true);
    const buzzEnv = parseBuzzEnvFromRequest(req);
    const includePoiCandidates = parsed.query.include_poi_candidates === "1";
    sendJson(res, 200, getMerchantsPayload(db, {
      buzz_env: buzzEnv,
      include_poi_candidates: includePoiCandidates,
    }), req);
    return;
  }

  if (req.method === "GET" && pathname === "/api/merchant-review-state") {
    sendJson(res, 200, getMerchantReviewState(db));
    return;
  }

  if (req.method === "GET" && pathname === "/api/approved-merchants") {
    sendJson(res, 200, {
      updatedAt: getMerchantReviewState(db).updatedAt,
      merchants: getApprovedMerchants(db),
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/merchant-types") {
    try {
      const parsed = url.parse(req.url, true);
      const buzzEnv = parseBuzzEnvFromRequest(req);
      const types = await fetchMerchantTypesForEnv(buzzEnv, {
        refresh: parsed.query.refresh === "1",
      });
      sendJson(res, 200, { buzz_env: buzzEnv, types });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/export-import-merchants") {
    const parsed = url.parse(req.url, true);
    const approvedOnly = parsed.query.approved_only !== "0";
    const readyOnly = parsed.query.ready_only !== "0";
    const records = getExportImportMerchants(db, { approvedOnly, readyOnly });
    sendJson(res, 200, {
      count: records.length,
      merchants: records,
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchants/poi-candidates-batch") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const merchantUids = Array.isArray(body.merchant_uids) ? body.merchant_uids : [];
      sendJson(res, 200, {
        ok: true,
        candidates: getMerchantPoiCandidatesBatch(db, merchantUids),
      }, req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchants/poi-search") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const keyword = String(body.keyword || "").trim();
      const city = String(body.city || "全国").trim() || "全国";
      if (!keyword) {
        sendJson(res, 400, { ok: false, error: "缺少 keyword" });
        return;
      }
      const result = await searchPoi({ keyword, city, pageSize: body.page_size || 10 });
      sendJson(res, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchants/poi-auto-batch") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const onlyApproved = body.only_approved === true;
      const poiMatchMode = body.poi_match_mode || getMerchantPoiMatchMode(db);
      const report = await batchAutoPoi(db, {
        city: body.city || "",
        only_pending: !onlyApproved && body.only_pending !== false,
        only_approved: onlyApproved,
        refresh: body.refresh === true,
        refresh_all_pending: body.refresh_all_pending === true,
        poi_match_mode: poiMatchMode,
        limit: body.limit || 80,
      });
      sendJson(res, 200, { ...report, poi_match_mode: poiMatchMode });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchants/poi-match-mode") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const mode = setMerchantPoiMatchMode(db, body.mode);
      sendJson(res, 200, {
        ok: true,
        poi_match_mode: mode,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  const merchantPoiMatch = pathname.match(/^\/api\/merchants\/([^/]+)\/poi$/);
  if (req.method === "POST" && merchantPoiMatch) {
    try {
      const merchantUid = decodeURIComponent(merchantPoiMatch[1]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const merchant = getMerchantByUid(db, merchantUid);
      if (!merchant) {
        sendJson(res, 404, { ok: false, error: "商户不存在" });
        return;
      }

      let poi = null;
      let candidates = merchant.poi_candidates || [];
      const poiMatchMode = getMerchantPoiMatchMode(db);

      if (body.poi_id) {
        poi = {
          poi_id: body.poi_id,
          title: body.title || "",
          address: body.address || "",
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
        };
        if (Array.isArray(body.candidates)) {
          candidates = body.candidates;
        }
      } else if (Number.isInteger(body.candidate_index) || Number.isFinite(body.candidate_index)) {
        const idx = Number(body.candidate_index);
        if (!candidates.length) {
          const search = await searchPoiForMerchant(merchant.name, merchant.city || "全国", { poiMatchMode });
          candidates = search.items;
        }
        poi = candidates[idx];
        if (!poi) {
          sendJson(res, 400, { ok: false, error: "候选 POI 不存在" });
          return;
        }
      } else {
        const search = body.keyword
          ? await searchPoi({
            keyword: String(body.keyword).trim(),
            city: body.city || merchant.city || "全国",
          })
          : await searchPoiForMerchant(merchant.name, body.city || merchant.city || "全国", { poiMatchMode });
        candidates = body.keyword
          ? reorderPoiByBestMatch(String(body.keyword).trim(), search.items, [merchant.name])
          : search.items;
        if (body.candidates_only || body.refresh) {
          updatePoiCandidatesOnly(db, merchantUid, candidates, {
            merchant_type: body.merchant_type,
          });
          sendJson(res, 200, {
            ok: true,
            merchant: merchantForClient(db, merchantUid, req, body),
            candidates,
            keyword: search.keyword || body.keyword || "",
          });
          return;
        }
        poi = pickBestPoiForMerchant(merchant.name, candidates, { poiMatchMode }).poi;
        if (!poi) {
          sendJson(res, 404, { ok: false, error: "无 POI 结果", candidates: [] });
          return;
        }
      }

      applyPoiSelection(db, merchantUid, poi, {
        candidates,
        merchant_type: body.merchant_type,
      });
      sendJson(res, 200, {
        ok: true,
        merchant: merchantForClient(db, merchantUid, req, body),
        candidates,
      });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  const merchantImportMatch = pathname.match(/^\/api\/merchants\/([^/]+)\/import$/);
  if (req.method === "POST" && merchantImportMatch) {
    try {
      const merchantUid = decodeURIComponent(merchantImportMatch[1]);
      const body = JSON.parse((await readBody(req)) || "{}");
      const buzzEnv = parseBuzzEnvFromRequest(req, body);
      const result = await importMerchantToBuzz(db, merchantUid, { buzz_env: buzzEnv });
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  const merchantDeleteMatch = pathname.match(/^\/api\/merchants\/([^/]+)$/);
  if (req.method === "DELETE" && merchantDeleteMatch) {
    try {
      const merchantUid = decodeURIComponent(merchantDeleteMatch[1]);
      const merchant = getMerchantByUid(db, merchantUid);
      if (!merchant) {
        sendJson(res, 404, { ok: false, error: "商户不存在" });
        return;
      }
      const removed = deleteLocalMerchant(db, merchantUid);
      if (!removed) {
        sendJson(res, 404, { ok: false, error: "商户不存在" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        merchant_uid: merchantUid,
        name: merchant.name,
      });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  const merchantBuzzDeleteMatch = pathname.match(/^\/api\/merchants\/([^/]+)\/buzz-merchant$/);
  if (req.method === "DELETE" && merchantBuzzDeleteMatch) {
    try {
      const merchantUid = decodeURIComponent(merchantBuzzDeleteMatch[1]);
      const parsed = url.parse(req.url, true);
      const buzzEnv = normalizeBuzzEnv(parsed.query.buzz_env);
      const result = await deleteMerchantFromBuzz(db, merchantUid, { buzz_env: buzzEnv });
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/merchants/import-progress") {
    try {
      const query = url.parse(req.url, true).query || {};
      const progress = getMerchantImportProgress(db, {
        city: query.city || "",
        buzz_env: query.buzz_env,
      });
      sendJson(res, 200, { ok: true, ...progress });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchants/import-batch") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const buzzEnv = parseBuzzEnvFromRequest(req, body);
      const report = await batchImportApprovedMerchants(db, {
        buzz_env: buzzEnv,
        city: body.city || "",
        merchant_uids: Array.isArray(body.merchant_uids) ? body.merchant_uids : undefined,
        limit: body.limit || 200,
        delayMs: body.delay_ms ?? 1200,
        dedup: body.dedup !== false,
        shouldAbort: () => req.aborted,
      });
      sendJson(res, 200, { ok: true, ...report });
    } catch (error) {
      if (req.aborted) {
        sendJson(res, 499, { ok: false, aborted: true, error: "客户端已中止入库" });
        return;
      }
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchants/sync-from-buzz") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const buzzEnv = parseBuzzEnvFromRequest(req, body);
      const report = await syncMerchantsFromBuzz(db, {
        buzz_env: buzzEnv,
        dry_run: body.dry_run === true,
        status: body.status != null ? body.status : 1,
      });
      sendJson(res, 200, { ok: true, ...report });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  const merchantPrepMatch = pathname.match(/^\/api\/merchants\/([^/]+)\/import-prep$/);
  if (req.method === "POST" && merchantPrepMatch) {
    try {
      const merchantUid = decodeURIComponent(merchantPrepMatch[1]);
      const body = JSON.parse((await readBody(req)) || "{}");
      updateMerchantImportPrep(db, merchantUid, {
        merchant_type: body.merchant_type,
        name: body.name,
      });
      sendJson(res, 200, {
        ok: true,
        merchant: merchantForClient(db, merchantUid, req, body),
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname === "/api/merchant-bubbles/state") {
    try {
      const query = url.parse(req.url, true).query || {};
      const state = await getMerchantBubbleState(db, {
        city: query.city || "",
        buzz_env: query.buzz_env,
      });
      sendJson(res, 200, { ok: true, ...state });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchant-bubbles/rebuild-buckets") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      rebuildRotationBuckets(db, {
        city: body.city || "",
        buzz_env: parseBuzzEnvFromRequest(req, body),
      });
      const state = await getMerchantBubbleState(db, {
        city: body.city || "",
        buzz_env: parseBuzzEnvFromRequest(req, body),
      });
      sendJson(res, 200, { ok: true, ...state });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "GET" && pathname.startsWith("/api/merchant-bubbles/jobs/")) {
    try {
      const jobId = decodeURIComponent(pathname.slice("/api/merchant-bubbles/jobs/".length));
      const job = publicJobView(getJob(jobId));
      if (!job) {
        sendJson(res, 404, { ok: false, error: "任务不存在或已过期" });
        return;
      }
      sendJson(res, 200, job);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchant-bubbles/groups-batch") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const options = {
        buzz_env: parseBuzzEnvFromRequest(req, body),
        city: body.city || "",
        publish_user_id: body.publish_user_id,
        only_missing: body.only_missing === true,
        limit: body.limit || 0,
        delayMs: body.delay_ms ?? 400,
      };
      const total = countGroupTargets(db, options);
      const jobId = startGroupsBatchJob(db, options);
      sendJson(res, 200, { ok: true, job_id: jobId, total, kind: "groups" });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchant-bubbles/groups-dissolve-batch") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.confirm !== true) {
        sendJson(res, 400, {
          ok: false,
          error: "危险操作：请在请求体中传 confirm: true 以确认解散全部商户群聊",
        });
        return;
      }
      const options = {
        buzz_env: parseBuzzEnvFromRequest(req, body),
        city: body.city || "",
        limit: body.limit || 0,
        delayMs: body.delay_ms ?? 300,
        destroy_remote: body.destroy_remote !== false,
        ignore_missing: body.ignore_missing !== false,
      };
      const report = await batchDissolveMerchantGroups(db, options);
      sendJson(res, 200, { ok: true, ...report });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchant-bubbles/publish-batch") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const options = {
        buzz_env: parseBuzzEnvFromRequest(req, body),
        city: body.city || "",
        publish_user_id: body.publish_user_id,
        title_mode: body.title_mode || "unified",
        unified_title: body.unified_title || "",
        unified_content: body.unified_content || "",
        group_mode: body.group_mode || "use_merchant",
        now_type: body.now_type,
        advance_rotation: body.advance_rotation !== false,
        delayMs: body.delay_ms ?? 1200,
      };
      const total = countPublishTargets(db, options);
      const jobId = startPublishBatchJob(db, options);
      sendJson(res, 200, { ok: true, job_id: jobId, total, kind: "publish" });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchant-bubbles/publish-bucket") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const options = {
        buzz_env: parseBuzzEnvFromRequest(req, body),
        city: body.city || "",
        slot: body.slot,
        publish_user_id: body.publish_user_id,
        title_mode: body.title_mode || "unified",
        unified_title: body.unified_title || "",
        unified_content: body.unified_content || "",
        group_mode: body.group_mode || "use_merchant",
        now_type: body.now_type,
        delayMs: body.delay_ms ?? 1200,
      };
      const total = countPublishTargets(db, options);
      const jobId = startPublishBatchJob(db, options);
      sendJson(res, 200, { ok: true, job_id: jobId, total, kind: "publish" });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchant-bubbles/delete-bucket-bubbles") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const report = await batchDeleteBucketBubbles(db, {
        buzz_env: parseBuzzEnvFromRequest(req, body),
        city: body.city || "",
        slot: body.slot,
        delayMs: body.delay_ms ?? 400,
      });
      sendJson(res, 200, { ok: true, ...report });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchant-bubbles/expire-bucket-bubbles") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const report = await batchExpireBucketBubbles(db, {
        buzz_env: parseBuzzEnvFromRequest(req, body),
        city: body.city || "",
        slot: body.slot,
        delayMs: body.delay_ms ?? 400,
      });
      sendJson(res, 200, { ok: true, ...report });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchant-bubbles/publish-test") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const report = await publishRandomTestMerchantBubble(db, {
        buzz_env: parseBuzzEnvFromRequest(req, body),
        city: body.city || "北京",
        publish_user_id: body.publish_user_id,
        title_mode: body.title_mode || "per_merchant",
        group_mode: body.group_mode || "create_new",
        now_type: body.now_type || 1,
      });
      sendJson(res, report.ok ? 200 : 502, { ok: report.ok, ...report });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/merchant-review-state") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const decisions = body.decisions && typeof body.decisions === "object" ? body.decisions : {};
      replaceMerchantReviewState(db, decisions);
      const state = getMerchantReviewState(db);
      const approved = getApprovedMerchants(db);
      sendJson(res, 200, { ok: true, updatedAt: state.updatedAt, approvedCount: approved.length });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
}

function resolvePublicFile(pathname) {
  if (legacyReviewPaths.has(pathname)) {
    return path.join(publicDir, "index.html");
  }
  const relative = pathname.replace(/^\/+/, "");
  return path.normalize(path.join(publicDir, relative));
}

function serveStatic(req, res, pathname) {
  const filePath = resolvePublicFile(pathname);
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  sendFile(res, filePath);
}

ensureDatabaseSeeded();

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  if (parsed.pathname.startsWith("/api/")) {
    handleApi(req, res, parsed.pathname);
    return;
  }
  serveStatic(req, res, parsed.pathname);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\n端口 ${port} 已被占用（EADDRINUSE）。常见原因：已有一个审核服务在跑。`);
    console.error("\n处理方式任选其一：");
    console.error(`  1) 关掉旧进程：lsof -ti :${port} | xargs kill`);
    console.error(`  2) 换端口启动：PORT=8788 npm start`);
    console.error(`  3) 指定端口：node scripts/server.js 8788\n`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Zup crawl review service: http://127.0.0.1:${port}/`);
  console.log(`  活动审核: http://127.0.0.1:${port}/`);
  console.log(`  商户审核: http://127.0.0.1:${port}/merchants.html`);
  console.log(`  商户气泡: http://127.0.0.1:${port}/merchant-bubbles.html`);
  console.log(`Database: ${dbPath}`);
});

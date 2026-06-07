#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const url = require("url");
const {
  applyDefaultImportPrepToActiveEvents,
  applyEventPoiSelection,
  countApprovedActiveEvents,
  getApprovedEvents,
  getEventByUid,
  getEventsPayload,
  getExportImportNows,
  getReviewState,
  importPayload,
  importReviewState,
  openDatabase,
  rejectEventForMissingPoi,
  replaceReviewState,
  syncEventMerchantByPoi,
  syncMerchantsForPoiEvents,
  updateEventImportPrep,
  updateEventPoiCandidatesOnly,
} = require("../lib/review-db");
const { batchImportApprovedEvents, importEventToBuzz } = require("../lib/buzz-now-import");
const {
  applyPoiSelection,
  getApprovedMerchants,
  getExportImportMerchants,
  getMerchantByUid,
  getMerchantReviewState,
  getMerchantsPayload,
  replaceMerchantReviewState,
  updateMerchantImportPrep,
  updatePoiCandidatesOnly,
} = require("../lib/merchant-db");
const { MERCHANT_TYPES } = require("../lib/merchant-import-ready");
const { batchEventAutoPoi } = require("../lib/event-poi-batch");
const { batchAutoPoi } = require("../lib/merchant-poi-batch");
const {
  buildPoiKeyword,
  pickBestPoiForEvent,
  pickBestPoiForMerchant,
  reorderPoiByBestMatch,
  searchPoi,
  searchPoiForEvent,
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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
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
  const src = parsed.query && parsed.query.src;
  const refererParam = parsed.query && parsed.query.referer;
  if (!src) {
    sendJson(res, 400, { ok: false, error: "Missing image src" });
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

function ensureDatabaseSeeded() {
  const payload = getEventsPayload(db);
  if (payload.events.length) return;

  if (fs.existsSync(eventsPath)) {
    importPayload(db, readJson(eventsPath, { events: [] }), { mode: "replace-all" });
  }
  if (fs.existsSync(decisionsPath)) {
    importReviewState(db, readJson(decisionsPath, { decisions: {} }));
  }
}

async function handleApi(req, res, pathname) {
  ensureDatabaseSeeded();

  if (req.method === "GET" && pathname === "/api/image") {
    handleImageProxy(req, res, url.parse(req.url, true));
    return;
  }

  if (req.method === "GET" && pathname === "/api/events") {
    sendJson(res, 200, getEventsPayload(db));
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
      const poiReport = body.skip_poi
        ? { total: 0, ok: 0, fail: 0, results: [] }
        : await batchEventAutoPoi(db, {
          city: body.city || "",
          only_approved: body.only_approved === true,
          refresh: body.refresh === true,
          limit: body.limit || 500,
        });
      sendJson(res, 200, { ok: true, defaults, poi: poiReport });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/events/poi-auto-batch") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const report = await batchEventAutoPoi(db, {
        city: body.city || "",
        only_approved: body.only_approved === true,
        refresh: body.refresh === true,
        limit: body.limit || 80,
      });
      sendJson(res, 200, report);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
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
          const search = await searchPoiForEvent(event.location, event.city || "全国");
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
            city: body.city || event.city || "全国",
          })
          : await searchPoiForEvent(event.location, body.city || event.city || "全国", {
            title: event.title,
          });
        candidates = body.keyword
          ? reorderPoiByBestMatch(String(body.keyword).trim(), search.items, [
            event.location,
            event.title,
          ].filter(Boolean))
          : search.items;
        if (!candidates.length) {
          rejectEventForMissingPoi(db, eventUid);
          sendJson(res, 200, {
            ok: false,
            rejected: true,
            error: "无 POI 结果，已自动拒绝",
            event: getEventByUid(db, eventUid),
            candidates: [],
            keyword: search.keyword || body.keyword || "",
          });
          return;
        }
        if (body.candidates_only || body.refresh) {
          const updated = updateEventPoiCandidatesOnly(db, eventUid, candidates);
          sendJson(res, 200, {
            ok: true,
            event: updated,
            candidates,
            keyword: search.keyword || body.keyword || "",
          });
          return;
        }
        poi = pickBestPoiForEvent(event, candidates).poi;
        if (!poi) {
          rejectEventForMissingPoi(db, eventUid);
          sendJson(res, 200, {
            ok: false,
            rejected: true,
            error: "无 POI 结果，已自动拒绝",
            event: getEventByUid(db, eventUid),
            candidates: [],
          });
          return;
        }
      }

      applyEventPoiSelection(db, eventUid, poi, { candidates });
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
      const result = await importEventToBuzz(db, eventUid);
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/events/import-batch") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const report = await batchImportApprovedEvents(db, {
        limit: body.limit || 200,
        delayMs: body.delay_ms ?? 1200,
        dedup: body.dedup !== false,
      });
      sendJson(res, 200, { ok: true, ...report });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/events/sync-merchants") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const report = await syncMerchantsForPoiEvents(db, {
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
      const updated = updateEventImportPrep(db, eventUid, {
        publish_user_id: body.publish_user_id,
        now_type: body.now_type,
      });
      sendJson(res, 200, { ok: true, event: updated });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/review-state") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      const decisions = body.decisions && typeof body.decisions === "object" ? body.decisions : {};
      replaceReviewState(db, decisions);
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
    sendJson(res, 200, getMerchantsPayload(db));
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
    sendJson(res, 200, { types: MERCHANT_TYPES });
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
      const report = await batchAutoPoi(db, {
        city: body.city || "",
        only_pending: !onlyApproved && body.only_pending !== false,
        only_approved: onlyApproved,
        refresh: body.refresh === true,
        limit: body.limit || 80,
      });
      sendJson(res, 200, report);
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
          const search = await searchPoiForMerchant(merchant.name, merchant.city || "全国");
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
          : await searchPoiForMerchant(merchant.name, body.city || merchant.city || "全国");
        candidates = body.keyword
          ? reorderPoiByBestMatch(String(body.keyword).trim(), search.items, [merchant.name])
          : search.items;
        if (body.candidates_only || body.refresh) {
          const updated = updatePoiCandidatesOnly(db, merchantUid, candidates, {
            merchant_type: body.merchant_type,
          });
          sendJson(res, 200, {
            ok: true,
            merchant: updated,
            candidates,
            keyword: search.keyword || body.keyword || "",
          });
          return;
        }
        poi = pickBestPoiForMerchant(merchant.name, candidates).poi;
        if (!poi) {
          sendJson(res, 404, { ok: false, error: "无 POI 结果", candidates: [] });
          return;
        }
      }

      const updated = applyPoiSelection(db, merchantUid, poi, {
        candidates,
        merchant_type: body.merchant_type,
      });
      sendJson(res, 200, { ok: true, merchant: updated, candidates });
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
      const updated = updateMerchantImportPrep(db, merchantUid, {
        merchant_type: body.merchant_type,
        name: body.name,
      });
      sendJson(res, 200, { ok: true, merchant: updated });
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
  console.log(`Database: ${dbPath}`);
});

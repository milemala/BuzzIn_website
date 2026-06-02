#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const url = require("url");

const root = process.cwd();
const port = Number(process.env.PORT || process.argv[2] || 8787);
const decisionsPath = path.join(root, "data", "review-decisions.json");
const approvedPath = path.join(root, "data", "approved-events.json");
const eventsPath = path.join(root, "data", "crawled-events.json");
const imageCacheDir = path.join(root, "data", "image-cache");

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

function ensureDataFiles() {
  fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });
  if (!fs.existsSync(decisionsPath)) {
    fs.writeFileSync(decisionsPath, `${JSON.stringify({ updatedAt: null, decisions: {} }, null, 2)}\n`);
  }
  if (!fs.existsSync(approvedPath)) {
    fs.writeFileSync(approvedPath, `${JSON.stringify({ updatedAt: null, events: [] }, null, 2)}\n`);
  }
}

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

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { ok: false, error: "Image not found" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentType || mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "public, max-age=86400",
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

  if (!["https:", "http:"].includes(imageUrl.protocol)) {
    sendJson(res, 400, { ok: false, error: "Unsupported image protocol" });
    return;
  }

  fs.mkdirSync(imageCacheDir, { recursive: true });
  const existingCandidates = fs.existsSync(imageCacheDir)
    ? fs.readdirSync(imageCacheDir).filter((name) => name.startsWith(crypto.createHash("sha1").update(src).digest("hex")))
    : [];
  if (existingCandidates.length) {
    const cachedPath = path.join(imageCacheDir, existingCandidates[0]);
    sendFile(res, cachedPath);
    return;
  }

  try {
    const response = await fetch(src, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Referer": "https://www.douban.com/",
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

function buildApprovedEvents(decisions) {
  const crawled = readJson(eventsPath, { events: [] });
  return crawled.events
    .filter((event) => decisions[event.id] === "approved")
    .map((event) => ({
      title: event.title,
      city: event.city,
      district: event.district,
      startDate: event.startDate,
      endDate: event.endDate,
      timeText: event.timeText,
      location: event.location,
      latitude: event.latitude,
      longitude: event.longitude,
      image: event.image,
      body: event.body,
      originalLink: event.originalLink,
      source: event.source,
      category: event.category,
    }));
}

async function handleApi(req, res, pathname) {
  ensureDataFiles();

  if (req.method === "GET" && pathname === "/api/image") {
    handleImageProxy(req, res, url.parse(req.url, true));
    return;
  }

  if (req.method === "GET" && pathname === "/api/review-state") {
    const state = readJson(decisionsPath, { updatedAt: null, decisions: {} });
    sendJson(res, 200, state);
    return;
  }

  if (req.method === "POST" && pathname === "/api/review-state") {
    try {
      const body = JSON.parse(await readBody(req) || "{}");
      const decisions = body.decisions && typeof body.decisions === "object" ? body.decisions : {};
      const updatedAt = new Date().toISOString();
      const state = { updatedAt, decisions };
      const approved = { updatedAt, events: buildApprovedEvents(decisions) };
      fs.writeFileSync(decisionsPath, `${JSON.stringify(state, null, 2)}\n`);
      fs.writeFileSync(approvedPath, `${JSON.stringify(approved, null, 2)}\n`);
      sendJson(res, 200, { ok: true, updatedAt, approvedCount: approved.events.length });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/events/crawl-review.html" : pathname;
  const filePath = path.normalize(path.join(root, decodeURIComponent(safePath)));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

ensureDataFiles();

http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  if (parsed.pathname.startsWith("/api/")) {
    handleApi(req, res, parsed.pathname);
    return;
  }
  serveStatic(req, res, parsed.pathname);
}).listen(port, "127.0.0.1", () => {
  console.log(`Zup review server running at http://127.0.0.1:${port}/events/crawl-review.html`);
  console.log(`Review decisions: ${decisionsPath}`);
  console.log(`Approved events: ${approvedPath}`);
});

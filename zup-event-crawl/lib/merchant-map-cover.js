"use strict";

const sharp = require("sharp");
const { saveComposedImage } = require("./composed-image");
const { composeMerchantCoverImage } = require("./merchant-image-compose");
const { ensureMerchantSchema } = require("./merchant-db");

const MAP_SIZE = 900;
const TILE_SIZE = 256;
const MAP_ZOOM = 15;
const TILE_COUNT = 2 ** MAP_ZOOM;

function escapeXml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[char]);
}

function normalizeCoordinate(value, label) {
  if (value === null || value === undefined || value === "") {
    throw new Error(`商户缺少${label}，请先匹配 POI`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`商户缺少${label}，请先匹配 POI`);
  }
  const max = label === "纬度" ? 90 : 180;
  if (Math.abs(number) > max) {
    throw new Error(`商户${label}无效，请重新匹配 POI`);
  }
  return number;
}

function worldPixelForCoordinate(latitude, longitude) {
  const scale = TILE_COUNT * TILE_SIZE;
  const sinLatitude = Math.sin(latitude * Math.PI / 180);
  return {
    x: ((longitude + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sinLatitude) / (1 - sinLatitude)) / (4 * Math.PI)) * scale,
  };
}

async function fetchTencentTile(tileX, standardTileY, options = {}) {
  const x = ((tileX % TILE_COUNT) + TILE_COUNT) % TILE_COUNT;
  const y = TILE_COUNT - 1 - standardTileY;
  const signal = options.signal;
  let lastError;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const host = `rt${attempt % 2}`;
    const tileUrl = `https://${host}.map.gtimg.com/tile?z=${MAP_ZOOM}&x=${x}&y=${y}&type=vector&styleid=0`;
    try {
      const response = await fetch(tileUrl, { signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length < 500) {
        throw new Error("地图瓦片内容为空");
      }
      return buffer;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`腾讯地图瓦片下载失败：${lastError?.message || "未知错误"}`);
}

function buildMapOverlaySvg(name) {
  const displayName = String(name || "商户").length > 24
    ? `${String(name).slice(0, 23)}…`
    : String(name || "商户");

  return Buffer.from(`
    <svg width="${MAP_SIZE}" height="${MAP_SIZE}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="shadow">
          <feDropShadow dx="0" dy="5" stdDeviation="8" flood-opacity=".28"/>
        </filter>
      </defs>
      <g filter="url(#shadow)">
        <path d="M450 300c-58 0-105 47-105 105 0 82 105 174 105 174s105-92 105-174c0-58-47-105-105-105z"
          fill="#f6c945" stroke="#171717" stroke-width="8"/>
        <circle cx="450" cy="405" r="37" fill="#171717"/>
        <text x="450" y="420" text-anchor="middle" font-family="Arial" font-size="42" font-weight="800" fill="#f6c945">Z</text>
      </g>
      <rect x="110" y="730" width="680" height="92" rx="46" fill="#171717" fill-opacity=".88"/>
      <text x="450" y="789" text-anchor="middle"
        font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="36" font-weight="700" fill="white">${escapeXml(displayName)}</text>
      <text x="450" y="856" text-anchor="middle"
        font-family="PingFang SC,Microsoft YaHei,sans-serif" font-size="22" fill="#333">腾讯地图定位封面</text>
    </svg>
  `);
}

async function buildTencentMapSourceImage(merchant, options = {}) {
  const latitude = normalizeCoordinate(merchant.latitude, "纬度");
  const longitude = normalizeCoordinate(merchant.longitude, "经度");
  const world = worldPixelForCoordinate(latitude, longitude);
  const left = world.x - MAP_SIZE / 2;
  const top = world.y - MAP_SIZE / 2;
  const minTileX = Math.floor(left / TILE_SIZE);
  const maxTileX = Math.floor((left + MAP_SIZE - 1) / TILE_SIZE);
  const minTileY = Math.floor(top / TILE_SIZE);
  const maxTileY = Math.floor((top + MAP_SIZE - 1) / TILE_SIZE);
  const tileJobs = [];

  for (let tileY = minTileY; tileY <= maxTileY; tileY += 1) {
    for (let tileX = minTileX; tileX <= maxTileX; tileX += 1) {
      tileJobs.push((async () => ({
        input: await fetchTencentTile(tileX, tileY, options),
        left: Math.round(tileX * TILE_SIZE - left),
        top: Math.round(tileY * TILE_SIZE - top),
      }))());
    }
  }

  const tiles = await Promise.all(tileJobs);
  const mapBuffer = await sharp({
    create: {
      width: MAP_SIZE,
      height: MAP_SIZE,
      channels: 3,
      background: "#eef1f4",
    },
  }).composite(tiles).png().toBuffer();

  return sharp(mapBuffer)
    .composite([{ input: buildMapOverlaySvg(merchant.name), left: 0, top: 0 }])
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

async function replaceMerchantCoverWithMap(db, merchantUid, options = {}) {
  ensureMerchantSchema(db);
  const uid = String(merchantUid || "").trim();
  if (!uid) throw new Error("缺少商户 ID");

  const merchant = db.prepare(`
    SELECT merchant_uid, name, city, latitude, longitude
    FROM merchants
    WHERE merchant_uid = ?
  `).get(uid);
  if (!merchant) throw new Error(`商户不存在: ${uid}`);

  const sourceBuffer = await buildTencentMapSourceImage(merchant, {
    signal: options.signal || AbortSignal.timeout(30_000),
  });
  const coverBuffer = await composeMerchantCoverImage(sourceBuffer);
  const rootDir = options.rootDir;
  const { composedUrl } = saveComposedImage(uid, coverBuffer, rootDir);
  const updatedAt = new Date().toISOString();
  const imageOriginal = `tencent-map-tiles:${merchant.latitude},${merchant.longitude}`;

  db.prepare(`
    UPDATE merchants
    SET image = ?,
        image_original = ?,
        updated_at = ?
    WHERE merchant_uid = ?
  `).run(composedUrl, imageOriginal, updatedAt, uid);

  return {
    ...merchant,
    image: composedUrl,
    image_original: imageOriginal,
    updated_at: updatedAt,
  };
}

module.exports = {
  buildTencentMapSourceImage,
  replaceMerchantCoverWithMap,
  worldPixelForCoordinate,
};

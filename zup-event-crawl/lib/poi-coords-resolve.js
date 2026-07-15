"use strict";

const { searchPoi } = require("./tencent-poi");

const coordCache = new Map();

/**
 * 按 poi_id + 标题向腾讯检索经纬度（GCJ-02），供 POI apply 与补坐标脚本共用。
 */
async function resolveTencentPoiCoords({ city, poi_id, poi_title, poi_address }) {
  const id = String(poi_id || "").trim();
  if (!id) return null;
  if (coordCache.has(id)) return coordCache.get(id);

  const keyword = String(poi_title || "").trim() || String(poi_address || "").trim();
  if (!keyword) {
    coordCache.set(id, null);
    return null;
  }

  try {
    const res = await searchPoi({
      keyword,
      city: String(city || "").trim() || "全国",
      pageSize: 5,
    });
    const items = Array.isArray(res.items) ? res.items : [];
    const hit = items.find((item) => String(item.poi_id) === id) || items[0];
    if (!hit || hit.latitude == null || hit.longitude == null) {
      coordCache.set(id, null);
      return null;
    }
    const coords = { latitude: hit.latitude, longitude: hit.longitude };
    coordCache.set(id, coords);
    return coords;
  } catch {
    coordCache.set(id, null);
    return null;
  }
}

module.exports = {
  resolveTencentPoiCoords,
};

"use strict";

/** 豆瓣同城 slug 与列表 URL 形态（subdomain / location） */
const DOUBAN_CITIES = {
  北京: { slug: "beijing", listKind: "subdomain" },
  上海: { slug: "shanghai", listKind: "subdomain" },
  广州: { slug: "guangzhou", listKind: "subdomain" },
  深圳: { slug: "shenzhen", listKind: "subdomain" },
  沈阳: { slug: "shenyang", listKind: "location" },
  哈尔滨: { slug: "harbin", listKind: "location" },
  南京: { slug: "nanjing", listKind: "location" },
  武汉: { slug: "wuhan", listKind: "location" },
  宁波: { slug: "ningbo", listKind: "location" },
  西安: { slug: "xian", listKind: "location" },
  重庆: { slug: "chongqing", listKind: "location" },
  佛山: { slug: "foshan", listKind: "location" },
  杭州: { slug: "hangzhou", listKind: "location" },
  秦皇岛: { slug: "qinhuangdao", listKind: "location" },
  青岛: { slug: "qingdao", listKind: "location" },
  苏州: { slug: "suzhou", listKind: "location" },
  长沙: { slug: "changsha", listKind: "location" },
  郑州: { slug: "zhengzhou", listKind: "location" },
  成都: { slug: "chengdu", listKind: "location" },
  天津: { slug: "tianjin", listKind: "location" },
  长春: { slug: "changchun", listKind: "location" },
  厦门: { slug: "xiamen", listKind: "location" },
  石家庄: { slug: "shijiazhuang", listKind: "location" },
  温州: { slug: "wenzhou", listKind: "location" },
  无锡: { slug: "wuxi", listKind: "location" },
  福州: { slug: "fuzhou", listKind: "location" },
};

const SLUG_ALIASES = {
  bj: "北京",
  beijing: "北京",
  sh: "上海",
  shanghai: "上海",
  gz: "广州",
  guangzhou: "广州",
  sz: "深圳",
  shenzhen: "深圳",
  cd: "成都",
  chengdu: "成都",
  shenyang: "沈阳",
  harbin: "哈尔滨",
  nanjing: "南京",
  wuhan: "武汉",
  ningbo: "宁波",
  xian: "西安",
  chongqing: "重庆",
  foshan: "佛山",
  hangzhou: "杭州",
  qinhuangdao: "秦皇岛",
  qingdao: "青岛",
  suzhou: "苏州",
  changsha: "长沙",
  zhengzhou: "郑州",
  tianjin: "天津",
  changchun: "长春",
  xiamen: "厦门",
  shijiazhuang: "石家庄",
  wenzhou: "温州",
  wuxi: "无锡",
  fuzhou: "福州",
};

function resolveDoubanCity(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (DOUBAN_CITIES[raw]) {
    return { name: raw, slug: DOUBAN_CITIES[raw].slug, listKind: DOUBAN_CITIES[raw].listKind };
  }
  const aliasName = SLUG_ALIASES[raw.toLowerCase()];
  if (aliasName && DOUBAN_CITIES[aliasName]) {
    return { name: aliasName, slug: DOUBAN_CITIES[aliasName].slug, listKind: DOUBAN_CITIES[aliasName].listKind };
  }
  for (const [name, cfg] of Object.entries(DOUBAN_CITIES)) {
    if (cfg.slug === raw.toLowerCase()) {
      return { name, slug: cfg.slug, listKind: cfg.listKind };
    }
  }
  return null;
}

function buildDoubanWeekListUrl(slug, listKind) {
  if (listKind === "location") {
    return `https://www.douban.com/location/${slug}/events/week-all`;
  }
  return `https://${slug}.douban.com/events/week-all`;
}

function listDoubanCityNames() {
  return Object.keys(DOUBAN_CITIES);
}

module.exports = {
  DOUBAN_CITIES,
  SLUG_ALIASES,
  buildDoubanWeekListUrl,
  listDoubanCityNames,
  resolveDoubanCity,
};

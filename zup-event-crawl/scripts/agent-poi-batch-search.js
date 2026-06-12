#!/usr/bin/env node
"use strict";

/**
 * 【可选】批量调腾讯 POI API，把候选 JSON 存盘，供 Agent 阅读后手写 decisions。
 *
 * - 本脚本只负责「多调几次搜索接口」，不选点、不写库、不判 match/存疑。
 * - 脚本内 suggestKeywords 仅为减少 Agent 手工敲 CLI，**不能**代替 Agent 定最终搜词与判定。
 * - 入库唯一路径：Agent 读候选 → 手写 decisions.json → apply / merge-agent-poi-decisions
 *
 *   node scripts/agent-poi-batch-search.js --file=data/poi-agent-workbench/成都/pending.json
 */
const fs = require("fs");
const path = require("path");
const { searchPoi } = require("../lib/tencent-poi");

const root = path.join(__dirname, "..");

function parseArgs(argv) {
  let file = "";
  let out = "";
  let delayMs = 120;
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--file=")) file = arg.slice("--file=".length);
    else if (arg.startsWith("--out=")) out = arg.slice("--out=".length);
    else if (arg.startsWith("--delay=")) delayMs = Number(arg.slice("--delay=".length)) || 120;
    else if (!arg.startsWith("--") && arg.endsWith(".json")) file = arg;
  }
  if (!file) throw new Error("请指定 --file=groups.json");
  const abs = path.isAbsolute(file) ? file : path.join(root, file);
  if (!out) {
    const base = path.basename(abs, ".json");
    out = path.join(path.dirname(abs), `${base}-search-results.json`);
  } else if (!path.isAbsolute(out)) {
    out = path.join(root, out);
  }
  return { file: abs, out, delayMs };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从地址/标题提取 Agent 式多组搜词（仅用于发起搜索，不做匹配判定） */
function suggestKeywords(group) {
  const loc = String(group.location || "").trim();
  const title = String(group.sample_title || "").trim();
  const keys = new Set();

  const stripPrefix = loc
    .replace(/^[^·\s]{2,8}[·\s]/, "")
    .replace(/^(北京|上海|广州|深圳|成都|杭州|南京|武汉|重庆|天津|苏州|西安|长沙|郑州|宁波|佛山|厦门|沈阳|哈尔滨|青岛|大连|无锡|福州|济南|昆明|合肥|石家庄|秦皇岛|温州|东莞|珠海|惠州|中山|嘉兴|金华|绍兴|常州|南通|扬州|徐州|太原|南宁|贵阳|兰州|海口|三亚|拉萨|银川|西宁|乌鲁木齐|呼和浩特)[\s·]/, "")
    .replace(/^(北京|上海|广州|深圳|成都|杭州|南京|武汉|重庆|天津|苏州|西安|长沙|郑州|宁波|佛山|厦门|沈阳|哈尔滨)[\s·]/, "");

  const parts = stripPrefix.split(/[\s,，、;；|｜()（）\[\]【】]/).map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (p.length >= 2 && p.length <= 40 && !/^\d+号?$/.test(p) && !/^(区|市|省|县|镇|街道|路|街|巷|弄|号|楼|层|室|附近|以内|沿线)$/.test(p)) {
      keys.add(p);
    }
  }

  const enBrand = loc.match(/[A-Za-z][A-Za-z0-9\s&'.-]{2,}/g) || [];
  for (const e of enBrand) {
    const t = e.trim();
    if (t.length >= 3) keys.add(t);
  }

  const cnVenue = loc.match(/[\u4e00-\u9fa5]{2,12}(?:店|馆|院|社|厅|吧|铺|屋|中心|广场|商场|影城|剧院|咖啡|茶铺|书店|酒吧|剧场|会所|民宿|酒店|美术馆|博物馆|体育馆|会展中心|创意园|社区)/g) || [];
  for (const v of cnVenue) keys.add(v);

  const door = loc.match(/\d+号[^，,；;]*/g) || [];
  for (const d of door.slice(0, 2)) keys.add(d.replace(/\s+/g, ""));

  if (group.current_poi_title) keys.add(String(group.current_poi_title).trim());

  const titleVenue = title.match(/[\u4e00-\u9fa5]{2,8}(?:店|馆|院|社|咖啡|茶铺)/);
  if (titleVenue) keys.add(titleVenue[0]);

  const short = stripPrefix.replace(/\([^)]*\)/g, "").replace(/（[^）]*）/g, "").trim();
  if (short.length >= 2 && short.length <= 25) keys.add(short);

  return [...keys].slice(0, 8);
}

async function main() {
  const { file, out, delayMs } = parseArgs(process.argv);
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const groups = payload.groups || [];
  const results = {
    source_file: file,
    searched_at: new Date().toISOString(),
    group_count: groups.length,
    groups: [],
  };

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const city = group.city || "全国";
    const keywords = suggestKeywords(group);
    const searches = [];

    process.stderr.write(`[${i + 1}/${groups.length}] ${city} ${group.sample_title?.slice(0, 30)}… (${keywords.length} 词)\n`);

    for (const keyword of keywords) {
      try {
        const result = await searchPoi({ keyword, city, pageSize: 8 });
        searches.push({
          keyword,
          count: result.items?.length || 0,
          items: (result.items || []).map((item, index) => ({
            index,
            poi_id: item.poi_id,
            title: item.title,
            address: item.address,
            category: item.category || "",
            latitude: item.latitude ?? null,
            longitude: item.longitude ?? null,
          })),
        });
      } catch (error) {
        searches.push({ keyword, error: error.message || String(error), items: [] });
      }
      await sleep(delayMs);
    }

    results.groups.push({
      ...group,
      search_keywords_tried: keywords,
      searches,
    });
  }

  fs.writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`已搜索 ${groups.length} 组 → ${out}`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});

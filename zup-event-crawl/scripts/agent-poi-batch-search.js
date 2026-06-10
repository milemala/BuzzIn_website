#!/usr/bin/env node
"use strict";

/** 按 Agent 制定的关键词批量搜索，输出 search-results.json */
const fs = require("fs");
const path = require("path");
const { searchPoi } = require("../lib/tencent-poi");

const city = process.argv[2] || "深圳";
const pendingPath = path.join(__dirname, "..", "data", "poi-agent-workbench", city, "pending.json");
const planPath = path.join(__dirname, "..", "data", "poi-agent-workbench", city, "search-plan.json");
const outPath = path.join(__dirname, "..", "data", "poi-agent-workbench", city, "search-results.json");

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const planMap = new Map(plan.groups.map((g) => [g.group_id, g.keywords]));

  const results = [];
  for (const group of pending.groups) {
    const keywords = planMap.get(group.group_id) || [];
    const tried = [];
    let items = [];
    for (const keyword of keywords) {
      tried.push(keyword);
      const res = await searchPoi({ keyword, city, pageSize: 10 });
      if (res.items?.length) {
        items = res.items;
        break;
      }
      await sleep(280);
    }
    results.push({
      group_id: group.group_id,
      location: group.location,
      sample_title: group.sample_title,
      event_uids: group.event_uids,
      search_keywords_tried: tried,
      items: (items || []).map((item, index) => ({
        index,
        poi_id: item.poi_id,
        title: item.title,
        address: item.address,
        category: item.category || "",
        latitude: item.latitude ?? null,
        longitude: item.longitude ?? null,
      })),
    });
    await sleep(280);
  }

  fs.writeFileSync(outPath, `${JSON.stringify({ city, searched_at: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`Wrote ${results.length} search results → ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

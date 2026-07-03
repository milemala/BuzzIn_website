#!/usr/bin/env node
"use strict";

/**
 * 对比 DB 中 category=「其他」的未过期活动：JS inferCategory vs 大模型试验分类。
 *
 *   node scripts/compare-llm-vs-js-category.js
 */
const fs = require("fs");
const path = require("path");
const { openDatabase } = require("../lib/review-db");
const { isExpired } = require("../lib/event-import-ready");
const { inferCategory } = require("../lib/event-classification");

const trialPath = path.join(__dirname, "..", "data", "category-llm-trial.json");

/** Agent 对 DB category=其他（未过期）逐条判断 — 2026-07-02 */
const LLM_DECISIONS = {
  "douban:37797976": { category: "其他", reason: "演讲比赛，偏赛事培训" },
  "douban:37353653": { category: "看展逛馆", reason: "文化馆哪吒 5D VR 沉浸体验" },
  "douban:36539096": { category: "看展逛馆", reason: "天台芭比主题展+观光套票" },
  "douban:37812384": { category: "其他", reason: "365 共修会员，疗愈课程" },
  "douban:37695310": { category: "其他", reason: "颂钵音疗培训课" },
  "douban:36391406": { category: "戏剧表演", reason: "纪念馆沉浸式夜游剧目" },
  "douban:37695431": { category: "戏剧表演", reason: "沉浸式夜游演艺" },
  "douban:37526872": { category: "看展逛馆", reason: "大空间 VR 沉浸体验" },
  "douban:37772958": { category: "看展逛馆", reason: "福建博物院考古特展" },
  "douban:37856040": { category: "其他", reason: "宠物游泳体验券" },
  "douban:37753910": { category: "其他", reason: "狗咖撸狗体验" },
  "douban:37674156": { category: "其他", reason: "宠物乐园门票" },
  "xiaohongshu:6a267b82000000001603ce6a:01_0": { category: "看展逛馆", reason: "马格南摄影回顾大展" },
  "xiaohongshu:6a2fb1ae000000001101e8df:13_2": { category: "看展逛馆", reason: "当代艺术群展" },
  "douban:36151420": { category: "交友聚会", reason: "葡萄酒品鉴社交体验" },
  "douban:37426436": { category: "看展逛馆", reason: "8K VR 科技沉浸展" },
  "douban:37200065": { category: "看展逛馆", reason: "航天数字探索 VR 展" },
  "douban:37478378": { category: "看展逛馆", reason: "国际当代艺术博览会（艺术向）" },
  "douban:37649214": { category: "看展逛馆", reason: "沉浸式 VR 主题展" },
  "douban:37649276": { category: "看展逛馆", reason: "沉浸式 VR 主题展" },
  "xiaohongshu:6a38a8e0000000001c0260ba:01_0": { category: "户外活动", reason: "观光塔登览开放" },
  "douban:37647939": { category: "看展逛馆", reason: "沉浸式 VR 主题展" },
  "xiaohongshu:6a41dc7b0000000016024263:01_0": { category: "其他", reason: "茶产业 B2B 博览会" },
  "xiaohongshu:6a41dc7b0000000016024263:01_3": { category: "其他", reason: "食品农产品 B2B 博览会" },
  "xiaohongshu:6a41dc7b0000000016024263:02_3": { category: "其他", reason: "渔业 B2B 博览会" },
  "xiaohongshu:6a41dc7b0000000016024263:03_0": { category: "看展逛馆", reason: "图书馆主题文献展" },
  "xiaohongshu:6a422263000000001603fadf:06_2": { category: "看展逛馆", reason: "艺术空间群展" },
  "xiaohongshu:6a420d4e000000000f02a9a1:05_0": { category: "看展逛馆", reason: "航空科普主题展（面向公众）" },
};

function main() {
  const db = openDatabase(path.join(__dirname, "..", "data", "review.db"));
  const rows = db.prepare(`
    SELECT event_uid, title, body, category, end_date, start_date
    FROM events
  `).all();
  db.close();

  const pool = rows.filter((row) => {
    if (isExpired({ endDate: row.end_date, startDate: row.start_date })) return false;
    return row.category === "其他";
  });

  const report = {
    generated_at: new Date().toISOString(),
    note: "仅针对 DB category=其他 的未过期活动；LLM 试验未写入 review.db",
    total: pool.length,
    items: [],
    summary: {
      js_vs_llm_same: 0,
      js_vs_llm_diff: 0,
      llm_would_be_exhibition: 0,
      js_missed_exhibition: 0,
    },
    llm_distribution: {},
    js_root_cause_notes: [
      "JS 规则在 lib/event-classification.js inferCategory()",
      "批量 remap 脚本 remap-active-event-categories.js 直接写库",
      "常见漏判：正则写了「博物馆」未写「博物院」；去掉裸「展览」后豆瓣类型 exhibition 失效",
      "VR展/芭比展/夜游剧等需结合正文，纯关键词难覆盖",
      "原设计流程是 Agent 读 classification-pending.json 写 decisions，而非 JS 自动分类",
    ],
  };

  for (const row of pool) {
    const jsCat = inferCategory(row);
    const llm = LLM_DECISIONS[row.event_uid] || { category: "(未判)", reason: "" };
    const same = jsCat === llm.category;
    if (same) report.summary.js_vs_llm_same += 1;
    else report.summary.js_vs_llm_diff += 1;
    if (llm.category === "看展逛馆") report.summary.llm_would_be_exhibition += 1;
    if (jsCat === "其他" && llm.category === "看展逛馆") report.summary.js_missed_exhibition += 1;
    report.llm_distribution[llm.category] = (report.llm_distribution[llm.category] || 0) + 1;
    report.items.push({
      event_uid: row.event_uid,
      title: row.title,
      db_category: row.category,
      js_category: jsCat,
      llm_category: llm.category,
      same,
      llm_reason: llm.reason,
      body_excerpt: String(row.body || "").slice(0, 160),
    });
  }

  fs.writeFileSync(trialPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`DB「其他」未过期活动: ${report.total} 条`);
  console.log(`JS 与 LLM 一致: ${report.summary.js_vs_llm_same} · 不一致: ${report.summary.js_vs_llm_diff}`);
  console.log(`LLM 判看展逛馆: ${report.summary.llm_would_be_exhibition} · JS 漏判看展: ${report.summary.js_missed_exhibition}`);
  console.log("LLM 分布:", report.llm_distribution);
  console.log(`\n详情: ${trialPath}\n`);
  console.log("--- JS=其他 且 LLM 不同 ---");
  for (const item of report.items.filter((entry) => !entry.same)) {
    console.log(`[JS ${item.js_category} → LLM ${item.llm_category}] ${item.title.slice(0, 52)}`);
    console.log(`  ${item.llm_reason}`);
  }
}

main();

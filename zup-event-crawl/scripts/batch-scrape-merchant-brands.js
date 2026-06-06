#!/usr/bin/env node
"use strict";

/**
 * 批量抓取任务表：只记录「搜什么 + 哪些城市」，不维护品牌过滤配置。
 * 入选规则见 lib/merchant-social-filter.js（社交饮酒类门店通用判断）。
 */
const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

const SEARCH_JOBS = [
  {
    label: "跳海酒馆",
    keyword: "跳海",
    cities: ["北京", "上海", "广州", "深圳", "杭州", "南京", "西安", "厦门", "长沙", "天津", "武汉", "成都", "重庆"],
  },
  { label: "京A", keyword: "京A", cities: ["北京", "郑州"] },
  { label: "悠航", keyword: "悠航", cities: ["北京"] },
  { label: "鹅岛", keyword: "鹅岛", cities: ["北京"] },
  { label: "幻师", keyword: "幻师", cities: ["北京", "上海", "广州", "深圳"] },
  { label: "大跃", keyword: "大跃", cities: ["北京"] },
  { label: "十三邀", keyword: "十三邀", cities: ["北京", "秦皇岛", "广州"] },
  { label: "单向空间", keyword: "单向空间", cities: ["广州", "宁波", "苏州", "北京", "秦皇岛", "杭州"] },
  { label: "PAGEONE", keyword: "pageone", cities: ["北京"] },
  { label: "茑屋", keyword: "茑屋", cities: ["杭州", "上海", "青岛", "深圳", "重庆", "武汉", "北京", "无锡", "宁波"] },
];

function buildTasks(onlyKeywords = null) {
  const allow = onlyKeywords ? new Set(onlyKeywords) : null;
  const tasks = [];
  for (const job of SEARCH_JOBS) {
    if (allow && !allow.has(job.keyword)) continue;
    for (const city of job.cities) {
      tasks.push({ city, label: job.label, keyword: job.keyword });
    }
  }
  return tasks;
}

function parseOnlyKeywords(argv) {
  const arg = argv.find((a) => a.startsWith("--only="));
  if (!arg) return null;
  return arg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean);
}

function runTask(task, index, total) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${index}/${total}] ${task.label} · ${task.city}（搜索：${task.keyword}）`);
  console.log(`${"=".repeat(60)}`);

  const args = [
    path.join(__dirname, "scrape-dianping-merchants.js"),
    `--city=${task.city}`,
    `--keyword=${task.keyword}`,
    "--mode=replace-keyword",
    "--skip-details",
    "--allow-empty",
    "--chrome-wait=10000",
  ];

  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });

  return { ...task, ok: result.status === 0, status: result.status };
}

function main() {
  const only = parseOnlyKeywords(process.argv.slice(2));
  const tasks = buildTasks(only);
  const report = { ok: [], fail: [] };

  console.log(`批量抓取 ${tasks.length} 项；入选规则：merchant-social-filter.js`);
  if (only) console.log(`仅抓取关键词：${only.join("、")}`);
  console.log("请保持 Chrome 已登录大众点评（后台抓取，不抢焦点）。\n");

  for (let i = 0; i < tasks.length; i += 1) {
    const result = runTask(tasks[i], i + 1, tasks.length);
    if (result.ok) report.ok.push(result);
    else report.fail.push(result);
    if (i < tasks.length - 1) {
      spawnSync("node", ["-e", "setTimeout(()=>{},4000)"], { cwd: root, stdio: "ignore" });
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("批量结束");
  console.log(`进程正常结束 ${report.ok.length} / ${tasks.length}`);
  if (report.fail.length) {
    console.log("进程异常：");
    for (const item of report.fail) {
      console.log(`  - ${item.label} · ${item.city}`);
    }
  }
}

main();

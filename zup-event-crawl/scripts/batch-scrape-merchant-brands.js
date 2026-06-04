#!/usr/bin/env node
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

const BRAND_JOBS = [
  {
    label: "跳海酒馆",
    cities: ["北京", "上海", "广州", "深圳", "杭州", "南京", "西安", "厦门", "长沙", "天津", "武汉", "成都", "重庆"],
  },
  { label: "京A", cities: ["北京", "郑州"] },
  { label: "悠航", cities: ["北京"] },
  { label: "鹅岛", cities: ["北京"] },
  { label: "幻师", cities: ["北京", "上海", "广州", "深圳"] },
  { label: "大跃", cities: ["北京"] },
];

function buildTasks() {
  const tasks = [];
  for (const brand of BRAND_JOBS) {
    for (const city of brand.cities) {
      tasks.push({ city, label: brand.label });
    }
  }
  return tasks;
}

function runTask(task, index, total) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${index}/${total}] ${task.label} · ${task.city}`);
  console.log(`${"=".repeat(60)}`);

  const args = [
    path.join(__dirname, "scrape-dianping-merchants.js"),
    `--city=${task.city}`,
    `--brand=${task.label}`,
    "--mode=replace-keyword",
    "--allow-empty",
    "--chrome-wait=8000",
    "--detail-wait=4000",
  ];

  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });

  return {
    ...task,
    ok: result.status === 0,
    status: result.status,
  };
}

function main() {
  const tasks = buildTasks();
  const report = { ok: [], fail: [] };

  console.log(`批量抓取 ${tasks.length} 项（每项最多重试列表 1 次，失败即跳过并说明原因）`);
  console.log("请保持 Chrome 已登录大众点评。\n");

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
  console.log("\n请在本机执行查看入库汇总：");
  console.log("  sqlite3 data/review.db \"SELECT search_keyword,city,COUNT(*) FROM merchants GROUP BY 1,2\"");
}

main();

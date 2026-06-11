#!/usr/bin/env node
"use strict";

/**
 * 按城市清单批量抓取小红书一周活动汇总。
 *
 * 账号清单格式见 data/xhs-city-accounts.json
 *
 *   node scripts/batch-scrape-xhs-cities.js
 *   node scripts/batch-scrape-xhs-cities.js --city=北京,上海
 *   node scripts/batch-scrape-xhs-cities.js --accounts=data/xhs-city-accounts.json
 */

const fs = require("fs");
const path = require("path");
const { scrapeXhsProfileWeekly } = require("./scrape-xhs-profile-weekly");

const defaultAccounts = path.join(__dirname, "..", "data", "xhs-city-accounts.json");

function parseArgs(argv) {
  const options = {
    accountsFile: defaultAccounts,
    onlyCities: [],
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--accounts=")) options.accountsFile = arg.slice("--accounts=".length);
    else if (arg.startsWith("--city=") || arg.startsWith("--cities=")) {
      const raw = arg.includes("=") ? arg.split("=")[1] : "";
      options.onlyCities = raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    }
  }
  return options;
}

function loadAccounts(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`账号清单不存在: ${file}（请按模板填写城市与个人页 URL）`);
  }
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(data) ? data : data.accounts || [];
  return list.filter((row) => row.city && row.profileUrl);
}

async function main() {
  const options = parseArgs(process.argv);
  let accounts = loadAccounts(options.accountsFile);
  if (options.onlyCities.length) {
    const set = new Set(options.onlyCities);
    accounts = accounts.filter((a) => set.has(a.city));
  }
  if (!accounts.length) {
    console.error("没有可抓取的城市账号，请编辑 data/xhs-city-accounts.json");
    process.exit(1);
  }

  console.log(`共 ${accounts.length} 个城市账号`);
  const results = [];
  for (const row of accounts) {
    console.log(`\n======== ${row.city} ========`);
    if (options.dryRun) {
      console.log(`[dry-run] ${row.profileUrl}`);
      continue;
    }
    try {
      const out = await scrapeXhsProfileWeekly(row.profileUrl, {
        city: row.city,
        limit: row.limit || 10,
      });
      results.push({ city: row.city, ok: true, noteDir: out.noteDir });
    } catch (error) {
      console.error(`[${row.city}] 失败:`, error.message || error);
      results.push({ city: row.city, ok: false, error: String(error.message || error) });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(`\n批量完成: ${ok}/${results.length} 成功`);
  results.filter((r) => !r.ok).forEach((r) => console.log(`  ✗ ${r.city}: ${r.error}`));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

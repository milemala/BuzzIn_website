#!/usr/bin/env node
"use strict";

/** @deprecated 请用 scrape-xhs-profile-weekly.js --city=城市名 */
const { scrapeXhsProfileWeekly } = require("./scrape-xhs-profile-weekly");

const profileUrl = process.argv[2];
if (!profileUrl) {
  console.error("用法: node scripts/scrape-xhs-profile-weekly.js --city=北京 <个人页URL>");
  process.exit(1);
}

scrapeXhsProfileWeekly(profileUrl, { city: "北京" })
  .then(({ noteDir }) => console.log(`完成 → ${noteDir}`))
  .catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });

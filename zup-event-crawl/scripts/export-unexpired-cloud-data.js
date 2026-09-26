#!/usr/bin/env node
// 给云上审核台准备一份数据：已结束的活动及其封面不带上。商户和还没结束的活动保留。
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const root = path.join(__dirname, "..");
const destData = path.resolve(process.argv[2] || "");
if (!destData) {
  console.error("缺少输出目录");
  process.exit(1);
}

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

fs.mkdirSync(destData, { recursive: true });
const srcDb = path.join(root, "data", "review.db");
const destDb = path.join(destData, "review.db");
fs.copyFileSync(srcDb, destDb);

const db = new DatabaseSync(destDb);
db.exec("PRAGMA foreign_keys = ON");
const removed = db.prepare(`
  DELETE FROM events
  WHERE end_date IS NOT NULL
    AND trim(end_date) != ''
    AND substr(end_date, 1, 10) < ?
`).run(today);
db.prepare(`
  DELETE FROM buzz_imports
  WHERE entity_kind = 'event'
    AND entity_uid NOT IN (SELECT event_uid FROM events)
`).run();
db.exec("VACUUM");
const keptEvents = db.prepare("SELECT COUNT(*) AS c FROM events").get().c;
const keptMerchants = db.prepare("SELECT COUNT(*) AS c FROM merchants").get().c;
db.close();

const keepUids = new Set();
const readDb = new DatabaseSync(destDb, { readOnly: true });
for (const row of readDb.prepare("SELECT event_uid AS uid FROM events").all()) keepUids.add(row.uid);
for (const row of readDb.prepare("SELECT merchant_uid AS uid FROM merchants").all()) keepUids.add(row.uid);
readDb.close();

const srcImages = path.join(root, "data", "image-composed");
const destImages = path.join(destData, "image-composed");
fs.mkdirSync(destImages, { recursive: true });
let copied = 0;
if (fs.existsSync(srcImages)) {
  for (const name of fs.readdirSync(srcImages)) {
    if (!name.endsWith(".jpg")) continue;
    const uid = name.slice(0, -4);
    if (!keepUids.has(uid)) continue;
    fs.copyFileSync(path.join(srcImages, name), path.join(destImages, name));
    copied += 1;
  }
}

for (const fileName of ["review-password", "users.json"]) {
  const from = path.join(root, "data", fileName);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(destData, fileName));
}

console.log(`云上数据按 ${today} 截取：留下活动 ${keptEvents} 场、商户 ${keptMerchants} 家、封面 ${copied} 张。去掉已结束活动 ${removed.changes} 场。`);

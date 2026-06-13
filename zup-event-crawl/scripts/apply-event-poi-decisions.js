#!/usr/bin/env node
"use strict";

/**
 * 将 Cursor Agent 编写的 decisions.json 写入 review.db。
 * decisions 须由 Agent 定搜词、读 poi-search-cli 候选后手写，禁止 JS 自动选点代填。
 *
 *   node scripts/apply-event-poi-decisions.js --city=深圳
 *   node scripts/apply-event-poi-decisions.js --city=上海 --source=xiaohongshu
 */
const fs = require("fs");
const path = require("path");
const {
  applyEventPoiSelection,
  getEventByUid,
  openDatabase,
  rejectEventForMissingPoi,
  syncEventMerchantByPoi,
  syncEventPoiCoordinates,
} = require("../lib/review-db");

const { poiDecisionsPath } = require("../lib/export-poi-pending");

const root = path.join(__dirname, "..");
const defaultDb = path.join(root, "data", "review.db");

function parseArgs(argv) {
  const options = {
    city: "",
    source: "douban",
    file: "",
    dbPath: defaultDb,
    dryRun: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--city=")) options.city = arg.slice("--city=".length).trim();
    else if (arg.startsWith("--source=")) options.source = arg.slice("--source=".length).trim() || "douban";
    else if (arg.startsWith("--file=")) options.file = arg.slice("--file=".length).trim();
    else if (arg.startsWith("--db=")) options.dbPath = arg.slice("--db=".length);
    else if (!arg.startsWith("--") && arg.endsWith(".json")) options.file = arg;
  }
  if (!options.file && options.city) {
    options.file = poiDecisionsPath(options.city, options.source);
  }
  if (!options.file || !fs.existsSync(options.file)) {
    throw new Error(options.file
      ? `找不到 decisions 文件: ${options.file}`
      : "请指定 --city=城市 或 --file=decisions.json");
  }
  return options;
}

function buildAgentMeta(decision) {
  return {
    agent: {
      source: "cursor-agent",
      decided_at: decision.decided_at || null,
      group_id: decision.group_id || "",
      confidence: decision.confidence || "",
      doubtful: Boolean(decision.doubtful),
      reason: decision.reason || "",
      search_keywords_tried: decision.search_keywords_tried || [],
    },
  };
}

async function main() {
  const options = parseArgs(process.argv);
  const payload = JSON.parse(fs.readFileSync(options.file, "utf8"));
  const decisions = Array.isArray(payload.decisions) ? payload.decisions : [];
  if (!decisions.length) {
    console.log("decisions 为空，无需写入");
    return;
  }

  const dbPath = payload.db || options.dbPath;
  const db = openDatabase(dbPath);
  const summary = { match: 0, reject: 0, skip: 0, fail: 0 };

  try {
    for (const decision of decisions) {
      const uids = Array.isArray(decision.event_uids) ? decision.event_uids : [];
      const action = String(decision.action || "skip").toLowerCase();

      if (action === "skip" || !uids.length) {
        summary.skip += uids.length || 1;
        continue;
      }

      if (options.dryRun) {
        console.log(`[dry-run] ${action} ${uids.join(", ")}`);
        summary[action === "match" ? "match" : "reject"] += uids.length;
        continue;
      }

      for (const eventUid of uids) {
        try {
          if (action === "reject") {
            rejectEventForMissingPoi(db, eventUid);
            summary.reject += 1;
            continue;
          }
          if (action !== "match" || !decision.poi_id) {
            summary.skip += 1;
            continue;
          }

          const poi = {
            poi_id: decision.poi_id,
            title: decision.poi_title || "",
            address: decision.poi_address || "",
            latitude: decision.latitude ?? null,
            longitude: decision.longitude ?? null,
          };
          const candidates = Array.isArray(decision.candidates) ? decision.candidates : [];
          const agentMeta = buildAgentMeta({ ...decision, decided_at: payload.decided_at });
          const searchKeywords = Array.isArray(decision.search_keywords_tried)
            ? decision.search_keywords_tried
            : [];
          applyEventPoiSelection(db, eventUid, poi, {
            candidates,
            matchSource: "agent",
            agentDoubtful: agentMeta.agent.doubtful,
            agentReason: agentMeta.agent.reason,
            agentSearchKeyword: String(searchKeywords[0] || "").trim(),
          });
          await syncEventMerchantByPoi(db, eventUid);
          summary.match += 1;
          const event = getEventByUid(db, eventUid);
          if (event) {
            console.log(`✓ ${event.title?.slice(0, 40)} → ${poi.title}`);
          }
        } catch (error) {
          summary.fail += 1;
          console.warn(`✗ ${eventUid}: ${error.message}`);
        }
      }
    }

    if (!options.dryRun) {
      const synced = syncEventPoiCoordinates(db);
      if (synced.updated) console.log(`POI 坐标同步: ${synced.updated} 条`);
    }

    console.log(`完成: 匹配 ${summary.match} · 未匹配 POI ${summary.reject} · 跳过 ${summary.skip} · 失败 ${summary.fail}`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});

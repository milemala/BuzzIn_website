"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { importPayload, openDatabase } = require("./review-db");
const {
  buildImportPayload,
  loadAllXhsReviewEvents,
  loadReviewEventsFromNote,
  listXhsNoteDirs,
} = require("./xhs-review-import");

const VISION_AGENT_DOC = "docs/xiaohongshu-vision-agent.md";
const WORKFLOW_DOC = "docs/xiaohongshu-review-workflow.md";

function getXhsRoot(rootDir) {
  return path.join(rootDir || path.join(__dirname, ".."), "data", "scrape-cache", "xhs");
}

function getVisionSlotsPath(noteDir) {
  return path.join(noteDir, "vision-slots.json");
}

function getExtractedPath(noteDir) {
  return path.join(noteDir, "events-extracted.json");
}

function hasVisionSlots(noteDir) {
  const file = getVisionSlotsPath(noteDir);
  if (!fs.existsSync(file)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data && typeof data === "object" && Object.keys(data).length > 0;
  } catch {
    return false;
  }
}

function countReadyEvents(noteDir) {
  const file = getExtractedPath(noteDir);
  if (!fs.existsSync(file)) return 0;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return (data.events || []).filter((event) => event.name && !event.needsVision).length;
  } catch {
    return 0;
  }
}

function runExtractScript(noteDir, rootDir) {
  const script = path.join(rootDir || path.join(__dirname, ".."), "scripts", "extract-xhs-weekly-events.js");
  execFileSync(process.execPath, [script, noteDir], { stdio: "inherit" });
}

async function importNoteEvents(noteDir, rootDir, options = {}) {
  const { extracted, reviewEvents, coverStats } = await loadReviewEventsFromNote(noteDir, rootDir, options);
  if (!reviewEvents.length) {
    return { status: "skip_no_events", city: extracted.city, noteDir, coverStats };
  }

  const payload = buildImportPayload({
    allEvents: reviewEvents,
    byCity: {
      [extracted.city || "未知城市"]: {
        events: reviewEvents,
        sourcePage: extracted.sourceUrl || null,
      },
    },
    totals: {
      notes: 1,
      events: reviewEvents.length,
      poster: coverStats.poster,
      text: coverStats.text,
      fail: coverStats.fail,
    },
    noteDirs: [{ noteDir }],
  });

  if (options.dryRun) {
    return {
      status: "dry_run",
      city: extracted.city,
      noteDir,
      eventCount: reviewEvents.length,
      coverStats,
    };
  }

  const dbPath = options.dbPath || path.join(rootDir, "data", "review.db");
  const db = openDatabase(dbPath);
  try {
    importPayload(db, payload, { mode: "append-city" });
  } finally {
    db.close();
  }

  return {
    status: "imported",
    city: extracted.city,
    noteDir,
    eventCount: reviewEvents.length,
    coverStats,
  };
}

async function importAllReadyNotes(rootDir, options = {}) {
  const noteDirs = listXhsNoteDirs(getXhsRoot(rootDir), options.city || null);
  const results = [];
  for (const item of noteDirs) {
    if (countReadyEvents(item.noteDir) === 0) continue;
    if (options.log !== false) {
      console.log(`\n入库 ${item.city} / ${path.basename(item.noteDir)}`);
    }
    results.push(await importNoteEvents(item.noteDir, rootDir, options));
  }
  return results;
}

/**
 * 单笔记目录：有 vision → extract →（可选）import
 */
async function processNoteDir(noteDir, options = {}) {
  const rootDir = options.rootDir || path.join(__dirname, "..");
  const result = {
    noteDir,
    city: path.basename(path.dirname(noteDir)),
    vision: false,
    extracted: false,
    imported: false,
    eventCount: 0,
    status: "pending",
    message: "",
  };

  if (!hasVisionSlots(noteDir)) {
    result.status = "awaiting_vision";
    result.message = `需 Agent 读 images/ 并填写 vision-slots.json，见 ${VISION_AGENT_DOC}`;
    return result;
  }
  result.vision = true;

  if (options.skipExtract) {
    result.status = countReadyEvents(noteDir) > 0 ? "ready_to_import" : "needs_extract";
    result.eventCount = countReadyEvents(noteDir);
    return result;
  }

  runExtractScript(noteDir, rootDir);
  result.extracted = true;
  result.eventCount = countReadyEvents(noteDir);
  if (!result.eventCount) {
    result.status = "extract_empty";
    result.message = "extract 完成但没有可入库活动（检查 vision-slots 是否填全 name）";
    return result;
  }

  if (options.skipImport) {
    result.status = "extracted";
    return result;
  }

  const importResult = await importNoteEvents(noteDir, rootDir, options);
  result.imported = importResult.status === "imported";
  result.status = importResult.status;
  result.coverStats = importResult.coverStats;
  result.eventCount = importResult.eventCount || result.eventCount;
  return result;
}

function printAwaitingVisionHelp(city, rootDir) {
  console.log("\n── 等待 Agent 读图 ──");
  console.log(`1. 读 ${VISION_AGENT_DOC}`);
  console.log(`2. 在 data/scrape-cache/xhs/${city}/<笔记ID>/ 填写 vision-slots.json`);
  console.log("3. 继续流水线：");
  console.log(`   node scripts/run-xhs-weekly-pipeline.js --skip-scrape --city=${city}`);
}

module.exports = {
  WORKFLOW_DOC,
  VISION_AGENT_DOC,
  countReadyEvents,
  getXhsRoot,
  hasVisionSlots,
  importAllReadyNotes,
  importNoteEvents,
  listXhsNoteDirs,
  processNoteDir,
  printAwaitingVisionHelp,
  runExtractScript,
};

#!/usr/bin/env node
"use strict";

/**
 * 将 Agent 手写的 decisions 合并进 workbench/decisions.json 并 apply。
 * decisions 须来自 Cursor Agent（定搜词 + 读 poi-search-cli 候选后判定），非 JS 自动规则。
 *
 *   node scripts/merge-agent-poi-decisions.js --file=data/poi-agent-workbench/_agent-decisions.json
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const workbenchRoot = path.join(root, "data", "poi-agent-workbench");

function parseArgs(argv) {
  let file = "";
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--file=")) file = arg.slice("--file=".length);
    else if (!arg.startsWith("--") && arg.endsWith(".json")) file = arg;
  }
  if (!file) throw new Error("请指定 --file=decisions.json");
  return { file: path.isAbsolute(file) ? file : path.join(root, file) };
}

function loadPending(dir) {
  const p = path.join(workbenchRoot, dir, "pending.json");
  if (!fs.existsSync(p)) return { groups: [] };
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function main() {
  const { file } = parseArgs(process.argv);
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const batches = Array.isArray(payload.batches) ? payload.batches : [];
  const now = new Date().toISOString();
  let applied = 0;

  for (const batch of batches) {
    const dir = batch.workbench;
    if (!dir) continue;
    const pending = loadPending(dir);
    const groupMap = new Map((pending.groups || []).map((g) => [g.group_id, g]));
    const decisionsPath = path.join(workbenchRoot, dir, "decisions.json");
    const old = fs.existsSync(decisionsPath)
      ? JSON.parse(fs.readFileSync(decisionsPath, "utf8"))
      : { decisions: [] };
    const byId = new Map((old.decisions || []).map((d) => [d.group_id, d]));
    const updated = [];

    for (const partial of batch.decisions || []) {
      const group = groupMap.get(partial.group_id);
      const eventUids = Array.isArray(partial.event_uids) && partial.event_uids.length
        ? partial.event_uids
        : (group?.event_uids || []);
      if (!eventUids.length) {
        console.warn(`[${dir}] 跳过无 event_uids: ${partial.group_id}`);
        continue;
      }
      const decision = {
        ...byId.get(partial.group_id),
        ...partial,
        location: partial.location || group?.location || "",
        sample_title: partial.sample_title || group?.sample_title || "",
        event_uids: eventUids,
        decided_at: partial.decided_at || now,
      };
      byId.set(partial.group_id, decision);
      updated.push(decision);
    }

    if (!updated.length) continue;

    const merged = {
      city: batch.city || pending.city,
      source: batch.source || pending.source,
      updated_at: now,
      agent: "cursor-agent",
      decisions: Array.from(byId.values()),
    };
    fs.writeFileSync(decisionsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

    const applyPath = path.join(workbenchRoot, dir, "_agent-apply.json");
    fs.writeFileSync(applyPath, `${JSON.stringify({
      city: merged.city,
      source: merged.source,
      decided_at: now,
      decisions: updated,
    }, null, 2)}\n`, "utf8");
    execSync(`node scripts/apply-event-poi-decisions.js --file=${JSON.stringify(applyPath)}`, {
      cwd: root,
      stdio: "inherit",
    });
    fs.unlinkSync(applyPath);
    console.log(`[${dir}] 应用 ${updated.length} 条`);
    applied += updated.length;
  }

  console.log(`\n合计应用 ${applied} 条 Agent 判定`);
}

main();

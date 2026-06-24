"use strict";

const crypto = require("crypto");
const {
  batchCreateMerchantGroups,
  batchPublishMerchantBubbles,
  publishCityBucketBubbles,
  publishRandomTestMerchantBubble,
  pickMerchantsForCurrentSlot,
  getMerchantsInCityBucket,
} = require("./merchant-bubble");
const { listImportedMerchants } = require("./merchant-db");
const { normalizeBuzzEnv } = require("./buzz-env");

const MAX_LOGS = 80;
const JOB_TTL_MS = 60 * 60 * 1000;
const jobs = new Map();

function importListOptions(options = {}) {
  return {
    city: options.city || "",
    buzz_env: normalizeBuzzEnv(options.buzz_env || options.env),
    limit: options.limit || 0,
    merchant_uids: options.merchant_uids,
  };
}

function countGroupTargets(db, options = {}) {
  const merchants = listImportedMerchants(db, importListOptions(options));
  const targets = options.only_missing === true
    ? merchants.filter((item) => !item.buzz_group_id)
    : merchants;
  return targets.length;
}

function getPublishPlan(db, options = {}) {
  if (options.merchant_uids?.length) {
    const merchants = listImportedMerchants(db, importListOptions(options));
    return { merchants, plan: [], total: merchants.length };
  }
  if (options.city && options.slot != null && Number.isFinite(Number(options.slot))) {
    const pick = getMerchantsInCityBucket(db, options.city, Number(options.slot), options);
    return {
      merchants: pick.merchants,
      total: pick.merchants.length,
      plan: [{
        city: pick.city,
        slot: pick.slot,
        count: pick.merchants.length,
      }],
    };
  }
  const pick = pickMerchantsForCurrentSlot(db, options);
  return {
    merchants: pick.merchants,
    plan: pick.plan || [],
    total: pick.merchants.length,
  };
}

function countPublishTargets(db, options = {}) {
  return getPublishPlan(db, options).total;
}

function newJobId() {
  return crypto.randomBytes(8).toString("hex");
}

function pruneOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs.entries()) {
    if ((job.finished_at || job.started_at) < cutoff) jobs.delete(id);
  }
}

function createJob(kind, total, meta = {}) {
  pruneOldJobs();
  const id = newJobId();
  const job = {
    id,
    kind,
    status: "running",
    total: Number(total) || 0,
    processed: 0,
    ok_count: 0,
    fail_count: 0,
    created: 0,
    renamed: 0,
    skipped: 0,
    cleaned: 0,
    current_name: "",
    logs: [],
    meta,
    summary: null,
    error: null,
    started_at: Date.now(),
    finished_at: null,
  };
  jobs.set(id, job);
  return job;
}

function pushLog(job, entry) {
  job.logs.push({
    at: new Date().toISOString(),
    ...entry,
  });
  if (job.logs.length > MAX_LOGS) {
    job.logs.splice(0, job.logs.length - MAX_LOGS);
  }
}

function onBatchItem(job, result, extra = {}) {
  job.processed += 1;
  job.current_name = result.name || result.merchant_name || "";
  if (result.ok) {
    job.ok_count += 1;
    if (result.created) job.created += 1;
    if (result.renamed) job.renamed += 1;
    if (result.skipped) job.skipped += 1;
    if (result.cleaned) job.cleaned += 1;
    const note = result.note
      ? ` · ${result.note}`
      : (result.now_id ? ` · now_id ${result.now_id}` : (result.group_id ? ` · 群 ${result.group_id}` : ""));
    pushLog(job, {
      level: result.skipped || result.cleaned ? "warn" : "ok",
      name: job.current_name || result.merchant_uid,
      message: (result.created ? "新建群聊" : result.renamed ? "同步群名" : "成功") + note,
    });
  } else {
    job.fail_count += 1;
    pushLog(job, {
      level: "fail",
      name: job.current_name || result.merchant_uid,
      message: result.error || "失败",
    });
  }
  if (extra.plan) job.meta.plan = extra.plan;
}

function completeJob(job, report) {
  job.status = "done";
  job.finished_at = Date.now();
  job.summary = report;
  if (report?.state) job.meta.state = report.state;
}

function failJob(job, error) {
  job.status = "error";
  job.finished_at = Date.now();
  job.error = error?.message || String(error);
  pushLog(job, { level: "fail", name: "—", message: job.error });
}

function getJob(jobId) {
  return jobs.get(String(jobId || "").trim()) || null;
}

function publicJobView(job) {
  if (!job) return null;
  return {
    ok: true,
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    total: job.total,
    processed: job.processed,
    ok_count: job.ok_count,
    fail_count: job.fail_count,
    created: job.created,
    renamed: job.renamed,
    skipped: job.skipped,
    cleaned: job.cleaned,
    current_name: job.current_name,
    logs: job.logs,
    meta: job.meta,
    summary: job.summary,
    error: job.error,
    started_at: job.started_at,
    finished_at: job.finished_at,
    done: job.status === "done" || job.status === "error",
  };
}

function onPoolRotate(job, rotation) {
  pushLog(job, {
    level: "warn",
    name: "马甲号轮换",
    message: `群聊额度已满：${rotation.from_label || rotation.from_user_id} → ${rotation.to_label || rotation.to_user_id}`,
  });
  job.meta.publish_user_pool = {
    current_user_id: rotation.to_user_id,
    current_label: rotation.to_label || rotation.to_user_id,
    index: rotation.index,
  };
}

function startGroupsBatchJob(db, options = {}) {
  const total = countGroupTargets(db, options);
  const job = createJob("groups", total, {
    city: options.city || "",
    buzz_env: normalizeBuzzEnv(options.buzz_env),
  });
  setImmediate(async () => {
    try {
      const report = await batchCreateMerchantGroups(db, {
        ...options,
        onItem: (result) => onBatchItem(job, result),
        onPoolRotate: (rotation) => onPoolRotate(job, rotation),
        stateOptions: options,
      });
      completeJob(job, report);
    } catch (error) {
      failJob(job, error);
    }
  });
  return job.id;
}

function startPublishBatchJob(db, options = {}) {
  const { total, plan } = getPublishPlan(db, options);
  const job = createJob("publish", total, {
    city: options.city || "",
    slot: options.slot,
    plan,
    buzz_env: normalizeBuzzEnv(options.buzz_env),
  });
  setImmediate(async () => {
    try {
      const runner = options.city && options.slot != null && Number.isFinite(Number(options.slot))
        ? publishCityBucketBubbles
        : batchPublishMerchantBubbles;
      const report = await runner(db, {
        ...options,
        onItem: (result, extra) => onBatchItem(job, result, extra),
        onPoolRotate: (rotation) => onPoolRotate(job, rotation),
      });
      completeJob(job, report);
    } catch (error) {
      failJob(job, error);
    }
  });
  return job.id;
}

function startPublishTestJob(db, options = {}) {
  const job = createJob("publish_test", 1, {
    city: options.city || "北京",
    buzz_env: normalizeBuzzEnv(options.buzz_env),
  });
  setImmediate(async () => {
    try {
      const report = await publishRandomTestMerchantBubble(db, {
        ...options,
        onItem: (result) => onBatchItem(job, result),
        onPoolRotate: (rotation) => onPoolRotate(job, rotation),
      });
      completeJob(job, report);
    } catch (error) {
      failJob(job, error);
    }
  });
  return job.id;
}

module.exports = {
  countGroupTargets,
  countPublishTargets,
  getJob,
  getPublishPlan,
  publicJobView,
  startGroupsBatchJob,
  startPublishBatchJob,
  startPublishTestJob,
};

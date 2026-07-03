#!/usr/bin/env node
"use strict";

/**
 * @deprecated 已停用 JS 规则重算 category。请改用 Agent 全量重分类。
 */
console.error(`
remap-active-event-categories.js 已废弃（JS 规则分类不准）。

请使用：
  node scripts/export-active-events-for-classification.js
  → Agent 写 classification-decisions.json
  → node scripts/apply-all-classification-decisions.js
`);
process.exit(1);

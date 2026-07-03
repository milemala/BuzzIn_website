#!/usr/bin/env node
"use strict";

/**
 * @deprecated 已停用 JS 自动分类。请改用 Agent 流程：
 *   node scripts/export-active-events-for-classification.js
 *   → Agent 写各城 classification-decisions.json
 *   → node scripts/apply-all-classification-decisions.js
 */
console.error(`
batch-classify-all-events.js 已废弃（JS 规则分类不准）。

请使用 Agent 分类流程：
  1. node scripts/export-active-events-for-classification.js
  2. Cursor Agent 读各城 classification-pending.json，写 classification-decisions.json
  3. node scripts/apply-all-classification-decisions.js

见 docs/event-classification-agent.md
`);
process.exit(1);

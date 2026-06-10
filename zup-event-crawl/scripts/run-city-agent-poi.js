#!/usr/bin/env node
"use strict";

/**
 * @deprecated 已废弃。活动 POI 改由 Cursor 大模型在对话中完成。
 * 请使用：
 *   node scripts/prepare-city-poi-for-agent.js --city=上海
 * 然后在 Cursor 里让 Agent 读 pending.json、写 decisions.json 并 apply。
 */
console.error(`
[已废弃] run-city-agent-poi.js 不再运行 JS 自动 POI 流水线。

请改用：
  node scripts/prepare-city-poi-for-agent.js --city=<城市>

POI 搜词与判断请在 Cursor 对话中由大模型完成，见 docs/event-poi-agent-workflow.md
`);
process.exit(1);

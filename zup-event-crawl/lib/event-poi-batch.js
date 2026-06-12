"use strict";

/**
 * 活动 POI 批量自动匹配已停用。
 * 搜词、选点、存疑判定必须由 Cursor Agent 完成，见 docs/event-poi-agent-workflow.md
 */
async function batchEventAutoPoi() {
  throw new Error(
    "活动 JS 自动 POI 已停用。请用 Cursor Agent：export-events-for-poi → poi-search-cli → 写 decisions.json → apply-event-poi-decisions。见 docs/event-poi-agent-workflow.md",
  );
}

module.exports = { batchEventAutoPoi };

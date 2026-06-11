# 活动入库时间：Cursor Agent 校正

> **新开会话必读**：审核台「入库准备」里的 `start_at` / `expired_at` 来自 `events.start_date` / `end_date`。**豆瓣、小红书**均不在抓取阶段写死入库时间，由 Agent 批量校正。

## 目标

- 每条活动有正确的 **开始**、**结束** 入库时间（`YYYY-MM-DD HH:mm:ss`）
- **豆瓣**：依据 `raw_detail_html` 的 `itemprop startDate/endDate` 与 `time_text`（场次列表）
- **小红书**：依据 `time_text`（自然语言）
- **仅有一个开始时刻、无结束时刻** → `expired_at` 设为 **当天 23:59:59**

## 标准流程（豆瓣）

```
抓取 scrape-douban-week-events.js（只写 time_text，不写 start/end）
    ↓
export-events-for-time.js + suggest-event-time-decisions.js（生成草稿）
    ↓
【大模型】核对/修正 → time-decisions.json
    ↓
apply-event-time-decisions.js → 写 review.db + 重建 event_dates
    ↓
（继续分类 → body → POI）
```

一键抓取已包含时间导出：`prepare-city-poi-for-agent.js`

## 标准流程（小红书）

见 [`xiaohongshu-review-workflow.md`](xiaohongshu-review-workflow.md) 步骤 5。

## 决策文件格式

`data/poi-agent-workbench/<城市>/time-decisions.json`：

```json
{
  "city": "成都",
  "decisions": [
    {
      "event_uid": "douban:37879969",
      "start_at": "2026-06-06 14:20:00",
      "expired_at": "2026-06-06 17:00:00",
      "reason": "豆瓣详情：06月06日 周六 14:20-17:00"
    },
    {
      "event_uid": "douban:12345678",
      "start_at": "2026-06-13 15:00:00",
      "expired_at": "2026-06-13 23:59:59",
      "reason": "单场 15:00 开始，无结束时刻"
    }
  ]
}
```

## 解析规则

### 豆瓣

| 来源 | 处理方式 |
|------|----------|
| `itemprop="startDate"` / `endDate` | 转 `YYYY-MM-DD HH:mm:ss`（本地时区） |
| 同一天仅有开始时刻 | `expired_at` → 当天 **23:59:59** |
| 多场次 `calendar-str-item` | 以最早 start、最晚 end；`time_text` 供 Agent 核对 |

### 小红书

| 原文模式 | start_at | expired_at |
|----------|----------|------------|
| `6月12日-14日 11:00-20:00` | 12日 11:00:00 | 14日 20:00:00 |
| `6月13日 15:00` | 13日 15:00:00 | 13日 **23:59:59** |
| `即日起每周五至周日 10:00-22:00` | 汇总周起始日 10:00 | **本周日** 22:00 |

## 命令

```bash
cd zup-event-crawl

# 豆瓣单城（抓取后）
node scripts/export-events-for-time.js --city=成都 --source=douban
node scripts/suggest-event-time-decisions.js --city=成都 --source=douban
node scripts/apply-event-time-decisions.js --city=成都

# 小红书
node scripts/suggest-event-time-decisions.js --source=xiaohongshu --all-cities
node scripts/apply-event-time-decisions.js --city=多城市
```

## 禁止

- 抓取阶段不要用 JS 直接写 `start_date` / `end_date` 当最终入库时间（豆瓣 `applyDoubanEventTime` 已只保留 `time_text`）
- 不要在没有原文依据时编造时刻
- 不要把 `expired_at` 设为与 `start_at` 相同的 00:00:00（无结束时刻时用 23:59:59）

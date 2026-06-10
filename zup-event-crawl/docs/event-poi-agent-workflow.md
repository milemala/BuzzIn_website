# 活动 POI：Cursor 大模型匹配（唯一主路径）

## 目标

你在 Cursor 里说：**「给我抓取成都豆瓣活动」** → Agent 在同一次对话里完成：

1. 抓取豆瓣 → 入库  
2. 按地址去重导出 POI 任务  
3. **大模型**决定搜词、调腾讯地图、选 POI / 拒绝 / 标存疑  
4. 写回 `review.db`

**不部署独立 LLM API**：推理发生在 Cursor 对话里；脚本只负责抓取、导出、调地图 API、入库。

---

## 标准流程（Agent 必做）

```
抓取 scrape-douban-week-events.js
    ↓
导出 export-events-for-poi.js  →  pending.json（groups 按地址去重）
    ↓
【大模型】每组：定搜词 → poi-search-cli.js → 读候选 → 写 decisions.json
    ↓
入库 apply-event-poi-decisions.js
```

### 1. 抓取

```bash
node scripts/scrape-douban-week-events.js 500 data/review.db --city=chengdu --mode=append-city --max-pages=10
```

不加 `--with-poi`。

### 2. 导出

```bash
node scripts/export-events-for-poi.js --city=成都 --refresh --pending-only
```

### 3. POI（大模型）

读 `data/poi-agent-workbench/<城市>/pending.json` 的 `groups`，对每组：

```bash
node scripts/poi-search-cli.js --city=成都 --keyword="锈罐头剧场"
```

### 搜索词怎么写（给大模型的规范）

| 规则 | 说明 |
|------|------|
| **保留栋/座/楼** | 豆瓣写了 `B座`、`a1栋`，搜索词里必须带上 |
| **跟豆瓣 venue 对齐** | 不能随意缩短掉栋/座信息 |
| **别用活动标题** | 用场馆/商场/门牌 |
| **剧名≠店名** | `沉浸式…《剧名》-锈罐头剧场` → 搜 `锈罐头剧场` |
| **城市** | CLI 已传 `--city`，关键词可不写城市；`decisions.json` 记原始搜词即可 |
| **多试几个** | 不准就换词重搜，写入 `search_keywords_tried` |

### 4. 写 `decisions.json` 并入库

```bash
node scripts/apply-event-poi-decisions.js --city=成都
```

`action`：`match` | `reject` | `skip`。存疑写 `doubtful: true` 与 `reason`。`reject` 表示本轮未匹配 POI，**不会**把审核状态改成「拒绝」，活动保持待审核，可用审核台「未匹配 POI」筛选。

---

## 文件格式

### `pending.json`（脚本导出）

```json
{
  "city": "成都",
  "groups": [
    {
      "group_id": "a1cf3eeda34e",
      "location": "成都 金牛区 …",
      "sample_title": "…",
      "event_uids": ["douban:37563854"],
      "event_count": 1
    }
  ]
}
```

### `decisions.json`（大模型写，脚本入库）

```json
{
  "city": "成都",
  "decided_at": "2026-06-10T12:30:00.000Z",
  "decisions": [
    {
      "group_id": "a1cf3eeda34e",
      "event_uids": ["douban:37563854"],
      "action": "match",
      "search_keywords_tried": ["锈罐头剧场", "金牛区 锈罐头剧场"],
      "poi_id": "8612963027283403844",
      "poi_title": "锈罐头剧场(上城天街旗舰店)",
      "poi_address": "…",
      "latitude": 30.685335,
      "longitude": 104.071138,
      "confidence": "high",
      "doubtful": false,
      "reason": "店名与金牛区地址一致"
    }
  ]
}
```

---

## 脚本一览

| 脚本 | 作用 |
|------|------|
| `scripts/scrape-douban-week-events.js` | 抓取豆瓣入库 |
| `scripts/export-events-for-poi.js` | 导出待 POI 的 groups |
| `scripts/poi-search-cli.js` | 调腾讯 POI（给大模型读结果） |
| `scripts/apply-event-poi-decisions.js` | decisions → review.db |

---

## 已废弃（勿再使用）

| 项目 | 说明 |
|------|------|
| `run-city-agent-poi.js` | 旧「伪 Agent」JS 流水线，已废弃 |
| `agent-poi-build-search-plan.js` 等 | JS 自动搜词/选 POI，已废弃 |
| 抓取 `--with-poi` | 旧版 JS Top1，已废弃 |
| 审核页「智能匹配」 | JS 自动 Top1，已移除 |
| `/api/events/poi-auto-batch` | 已禁用 |

`lib/tencent-poi.js` 仍用于：**腾讯 API 调用**、商户 POI、审核页「自由搜索」代理。活动 POI 的**搜词与最终判断**只认大模型 + `decisions.json`。

---

## 审核页

- 展示 Agent 写入的 POI、`doubtful`、`poi_agent_search_keyword`
- **标准/严格存疑**：只读库里的 Agent 标记，不再用 JS 重算活动存疑
- 人工修正：自由搜索关键词 → 点选候选保存（`match_source: manual`）

---

## 一键入口（仅抓取+导出，POI 仍在对话里做）

```bash
node scripts/prepare-city-poi-for-agent.js --city=成都 --max-pages=10
```

抓完后 Agent 继续读 `pending.json` 完成 POI。

# 活动 POI：由 Cursor Agent（大模型）匹配

## 你要什么

1. **搜什么词** → 由 Cursor 里的我（Agent）根据豆瓣 `title` + `location` 判断，不用 JS 固定规则。  
2. **搜完选谁** → 同样由我对比「豆瓣原文 vs 腾讯 POI 候选」，选出最优或标记无法匹配。  
3. **不部署模型、不接 OpenAI/第三方 API** → 推理发生在 Cursor 对话里；代码只负责**导出任务、调腾讯地图搜 POI、写回结果**。

---

## 两阶段（推荐：每城抓完再 POI）

```
阶段 A  抓取（纯机械，快）
  Chrome 抓豆瓣 → 详情补地址 → 合成封面 → 写 review.db
  默认不做 POI（加 --with-poi 才走旧版 JS 自动匹配）

阶段 B  POI（你在 Cursor 里让我做）
  导出待处理列表 → 我逐条/按地址去重处理 → 写回 decisions → 一键入库
```

**为什么不要「抓一条 POI 一条」**  
抓取已经慢；POI 又要搜地图 + 我要想一遍。绑在一起容易拖垮整城，且以后改判断逻辑还得重抓。  
**推荐节奏**：`抓完深圳 → 在 Cursor 说「给深圳匹配 POI」→ 再抓广州`。

---

## 你对 Cursor 怎么说（话术模板）

抓取：

> 帮我抓豆瓣深圳最近一周，10 页，入库。

POI（抓完后）：

> 给深圳这批豆瓣活动匹配 POI。

重跑 POI（不改抓取数据）：

> 深圳活动 POI 用新逻辑重做一遍。

---

## 我会做什么（Agent 标准流程）

1. 跑抓取（若还没抓）：`node scripts/scrape-douban-week-events.js ...`（默认已跳过 JS POI）  
2. 导出待办：  
   `node scripts/export-events-for-poi.js --city=深圳`  
   → 生成 `data/poi-agent-workbench/深圳/pending.json`  
3. 读 `pending.json` 里的 **`groups`（按地址去重）**，对每个组：  
   - 决定 1～3 个腾讯搜索词（见下方「搜索词怎么写」）  
   - 执行：  
     `node scripts/poi-search-cli.js --city=深圳 --keyword="福田区 寰映影城"`  
   - 看返回的候选 JSON，和豆瓣 `location` 比对，选出 `poi_id` 或 `reject`  

### 搜索词怎么写（Agent 必守）

| 规则 | 说明 |
|------|------|
| **保留栋/座/楼** | 豆瓣写了 `B座`、`a1栋`，搜索词里必须带上，不能只搜园区/大厦主体名 |
| **跟豆瓣 venue 对齐** | `新天世纪商务中心B座` 不能缩成 `新天世纪商务中心`；`科兴科技园a栋` 要带 `a栋` |
| **城市怎么带** | CLI 已传 `--city=深圳`，腾讯用 `region(深圳)` 限定范围，**关键词里可以不写城市也能搜准**；商户侧习惯 `深圳 xxx` 是双保险。`decisions.json` 里记录原始搜词即可，审核页展示会自动加城市前缀 |
| **别用活动标题** | 用场馆/商场/门牌，不用整段活动名当店名 |
| **多试几个** | 第一次不准就换：`深圳国际商会大厦A座` → `国际商会大厦 A座 福田` |

常见错误示例：

- ❌ `科兴科学园`（豆瓣是 `科兴科技园a栋`）  
- ❌ `新天世纪商务中心`（豆瓣是 `…B座`）  
- ✅ `科兴科学园 A1栋`、`新天世纪商务中心 B座`
4. 把结果写入：  
   `data/poi-agent-workbench/深圳/decisions.json`  
5. 入库：  
   `node scripts/apply-event-poi-decisions.js --city=深圳`  
6. 告诉你：成功几条、拒绝几条、存疑几条（见下）

同一地址多场活动：只在 `groups` 里处理一次，decisions 里按 `event_uids` 批量写相同 POI。

---

## 文件格式

### `pending.json`（脚本导出，给我看）

```json
{
  "city": "深圳",
  "exported_at": "2026-06-10T12:00:00.000Z",
  "db": "data/review.db",
  "total_events": 71,
  "group_count": 28,
  "groups": [
    {
      "group_id": "g001",
      "location": "深圳 福田区 寰映影城-…",
      "sample_title": "《心犬相随》深圳超前观影",
      "event_uids": ["douban:37884835", "douban:…"],
      "event_count": 1
    }
  ]
}
```

### `decisions.json`（我写，脚本入库）

```json
{
  "city": "深圳",
  "decided_at": "2026-06-10T12:30:00.000Z",
  "decisions": [
    {
      "group_id": "g001",
      "event_uids": ["douban:37884835"],
      "action": "match",
      "search_keywords_tried": ["深圳 福田区 寰映影城", "中航城君尚 寰映影城"],
      "poi_id": "7218745343528379568",
      "poi_title": "寰映影城(…)",
      "poi_address": "…",
      "latitude": 22.54,
      "longitude": 114.08,
      "confidence": "high",
      "doubtful": false,
      "reason": "豆瓣场馆名与 POI 名称、地址一致"
    },
    {
      "group_id": "g002",
      "event_uids": ["douban:…"],
      "action": "reject",
      "search_keywords_tried": ["绿景NEO大厦 桌游"],
      "reason": "地址仅写到大厦，腾讯无对应店内 POI，建议人工或标拒绝"
    }
  ]
}
```

`action`：

| 值 | 含义 |
|----|------|
| `match` | 写入 `location_poi_id` 等字段 |
| `reject` | 审核状态改为「拒绝」（与现网 JS 无 POI 一致） |
| `skip` | 本轮不动，留给下次 |

`confidence`：`high` / `medium` / `low`。`doubtful: true` 或 `low` 时审核页仍会提示人工看一眼（后续可改为完全信任 Agent 标记）。

---

## 脚本一览

| 脚本 | 作用 |
|------|------|
| `scripts/export-events-for-poi.js` | 导出某城待匹配活动（按地址去重） |
| `scripts/poi-search-cli.js` | 命令行调腾讯 POI，输出 JSON 给我读 |
| `scripts/apply-event-poi-decisions.js` | 把 `decisions.json` 写入 `review.db` |

---

## 与旧版 JS 自动 POI 的关系

- 抓取脚本默认 **`--skip-poi`**（不再自动 JS Top1）。  
- 需要临时用旧逻辑：`--with-poi`。  
- 审核页已关闭「打开就刷新候选 POI」；手动按钮仍可用。

---

## 审核页 POI 存疑模式

活动审核台右上角可切换（与商户台一致）：

| 模式 | 行为 |
|------|------|
| **标准存疑**（默认） | 主地点（大厦/园区）已对齐则不算存疑；楼层、活动室等细颗粒度差异放行 |
| **严格存疑** | 完全采用 Agent 的 `doubtful` 判断，含「仅写到大厦/园区级」类提示 |

Agent 在 `decisions.json` 里仍写真实判断；模式只影响审核页展示，不改数据库 POI。

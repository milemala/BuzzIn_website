# 活动分类与推荐/挡下：Cursor 大模型判断

> **新开会话必读**：抓取后「推荐 / 挡下」与「类型」不再由 JS 正则打分，由 Agent 读 `classification-pending.json` 写 `classification-decisions.json` 入库。

## 目标

Zup 要的是 **线下交友、娱乐、体验** 类同城活动，不要：

- 行业展会、博览会、贸易展（如跨境电商展、工业展）
- B2B 峰会、论坛、招商会、培训课程、招聘
- 纯商业获客、与「找人一起玩」无关的会场活动

同时要给出 **准确的展示分类**（不用豆瓣原始类型）。

---

## 流程（在 POI 之前做）

```
抓取 scrape-douban-week-events.js
    ↓
导出 export-events-for-classification.js → classification-pending.json
    ↓
【大模型】逐条判断 suggested + category + reason
    ↓
写入 classification-decisions.json → apply-event-classification-decisions.js
    ↓
（再继续 POI 流程，见 event-poi-agent-workflow.md）
```

一键入口 `prepare-city-poi-for-agent.js` 已包含分类导出。

---

## 展示分类（`category`）

只能取以下之一（写入 `decisions.json`）：

| 分类 | 适用 |
|------|------|
| **喜剧脱口秀** | 脱口秀、相声、喜剧、开放麦、即兴、Sketch |
| **戏剧表演** | 话剧、音乐剧、舞剧、歌剧、沉浸式剧场、魔术 |
| **音乐现场** | 音乐会、演唱会、Live、爵士、乐队 |
| **看展逛馆** | 美术馆、博物馆、艺术展、影展、观影放映、沉浸探索展 |
| **户外运动** | 徒步、骑行、露营、Citywalk、飞盘等 |
| **手作体验** | 钩织、陶艺、绘画、市集 DIY |
| **交友聚会** | 交友、桌游、派对、沙龙、读书会、心理小组 |
| **遛娃亲子** | **仅**标题/豆瓣类型明确亲子向（不要用票务「儿童说明」判断） |
| **其他** | 以上都不贴切但仍适合推荐时 |

> **注意**：票务详情里的「儿童说明」「家庭票」不是亲子活动信号，不要据此标 **遛娃亲子**。

挡下的活动也请给一个分类（多为 **其他**），便于筛选统计。

---

## `suggested`：推荐 vs 挡下

| 值 | 审核台 | 含义 |
|----|--------|------|
| `true` | **推荐** | 适合 Zup 用户线下结伴、娱乐、社交 |
| `false` | **已挡下** | 无趣或偏行业/商业，冷启动不做 |

### 应挡下（`suggested: false`）示例

- `2026第12届深圳跨境电商贸易展…`
- `直通海外市场｜深圳国际跨境电商展`
- 行业博览会、展销会、贸易周、峰会、论坛、私董会
- 创业培训、职业技能课、认证课（抓取阶段已硬拦「课程」类，但仍需 Agent 复核边缘案例）
- 招商、产业对接、B2B 展会

### 应推荐（`suggested: true`）示例

- 脱口秀、开放麦、喜剧演出
- 美术馆展览、沉浸式剧场
- 交友局、桌游、徒步、Citywalk
- 手作体验、市集（偏逛玩而非纯招商）

### 判断依据

读每条导出的：

- `title`、`location`、`fee`、`owner`、`time_text`
- `douban_event_type`（豆瓣页类型，**仅供参考**）
- `body_excerpt`、`detail_excerpt`

**不要**只看豆瓣类型；**不要**用 JS `scoreEvent` 正则。

---

## `classification-decisions.json` 格式

```json
{
  "city": "深圳",
  "decided_at": "2026-06-10T12:00:00.000Z",
  "agent": "cursor-composer",
  "decisions": [
    {
      "event_uid": "douban:37595508",
      "suggested": false,
      "category": "其他",
      "reason": "跨境电商贸易展会，偏行业招商，不适合线下交友娱乐"
    },
    {
      "event_uid": "douban:37884967",
      "suggested": true,
      "category": "社交",
      "reason": "自我成长主题线下沙龙，偏小型社交聚会"
    }
  ]
}
```

入库：

```bash
node scripts/apply-event-classification-decisions.js --city=深圳
```

---

## 抓取阶段默认值

新抓取入库时：

- `category`: `待分类`
- `classification_source`: `pending`
- `review_reason`: `待 Agent 判断是否符合线下交友娱乐`
- `suggested`: `true`（在 Agent 判断前不会进「已挡下」筛选）

Agent 入库后 `classification_source` 变为 `agent`，重抓同条活动**不会覆盖**已有 Agent 分类。

硬拦（抓取直接跳过、不入库）：戏曲、公益、标题含「课程/培训课」等，见 `scrape-douban-week-events.js` → `getExcludeReason`。

---

## 审核台

- 标签：**待分类** / **推荐** / **已挡下**
- 筛选「已挡下」= `suggested=false` 且待定
- 类型筛选使用 Agent 写入的 `category`（不再是豆瓣分类）

---

## 脚本

| 脚本 | 作用 |
|------|------|
| `export-events-for-classification.js` | 导出待分类活动 |
| `apply-event-classification-decisions.js` | decisions → review.db |

---

## 新会话检查清单

- [ ] 已读本文「应挡下 / 应推荐」
- [ ] 抓取后已跑 `export-events-for-classification.js`
- [ ] 每条 `event_uid` 与 pending 文件一致
- [ ] `category` 在允许列表内
- [ ] `reason` 写清挡下或推荐原因
- [ ] 已跑 `apply-event-classification-decisions.js`
- [ ] 再继续 POI 流程

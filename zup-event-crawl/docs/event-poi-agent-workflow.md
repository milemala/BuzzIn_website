# 活动 POI：Cursor 大模型匹配（唯一主路径）

> **新开会话必读**：抓取、搜 POI、写 `decisions.json` 的全部规则以本文档 + `.cursor/rules/douban-crawl-and-agent-poi.mdc` 为准，**不依赖聊天上下文**。Agent 执行 POI 前应先读本文「判断标准」与「常见翻车」两节。

## 目标

你在 Cursor 里说：**「给我抓取成都豆瓣活动」** → Agent 在同一次对话里完成：

1. 抓取豆瓣 → 入库 `data/review.db`
2. **大模型分类/挡下** → `classification-decisions.json`（见 [`event-classification-agent.md`](event-classification-agent.md)）
3. 按地址去重导出 POI 任务 → `pending.json`
4. **大模型**决定搜词、调腾讯地图、选 POI / 未匹配 / 标存疑
5. 写 `decisions.json` → `apply-event-poi-decisions.js` 写回库
6. 汇报：抓取数、推荐/挡下、POI 匹配/存疑、需人工条目

**不部署独立 LLM API**：推理在 Cursor 对话里；脚本只做抓取、腾讯 API、入库。

---

## 标准流程（Agent 必做）

```
抓取 scrape-douban-week-events.js
    ↓
导出 export-events-for-classification.js → classification-pending.json
    ↓
【大模型】逐条：推荐/挡下 + category → classification-decisions.json → apply
    ↓
导出 export-events-for-poi.js  →  pending.json（groups 按地址去重）
    ↓
【大模型】每组：定搜词 → poi-search-cli.js → 读候选 → 写 decisions.json
    ↓
入库 apply-event-poi-decisions.js
```

### 0. 一键（仅抓取+导出，POI 仍在对话里做）

```bash
cd zup-event-crawl
node scripts/prepare-city-poi-for-agent.js --city=成都 --max-pages=10
# 已有数据只导出：加 --skip-scrape
```

### 1. 抓取

```bash
node scripts/scrape-douban-week-events.js 500 data/review.db --city=chengdu --mode=append-city --max-pages=10
```

- **禁止**加 `--with-poi`（旧版 JS 自动 Top1，已废弃）
- 豆瓣风控（403/429/验证码）会暂停；见 `docs/HANDOFF.md`
- 默认 Chrome 抓取（需本机 Chrome 已登录豆瓣）

### 2. 导出

```bash
node scripts/export-events-for-poi.js --city=成都 --refresh --pending-only
```

输出目录：`data/poi-agent-workbench/<城市>/`

| 文件 | 谁写 | 作用 |
|------|------|------|
| `pending.json` | 脚本 | 待匹配 groups（按 `location` 去重） |
| `search-results.json` | 可选，Agent 可追加 | 每次搜词的原始候选，便于审计 |
| `decisions.json` | **Agent** | 最终判定，入库唯一依据 |

### 3. POI（大模型）

对每个 `pending.json` → `groups[]` 条目：

1. 读 `location`、`sample_title`、`event_uids`
2. 决定 1～3 个搜索词（见下表）
3. 执行搜索并把候选记下来：

```bash
node scripts/poi-search-cli.js --city=成都 --keyword="锈罐头剧场"
```

4. **人工级判断**：对比豆瓣原文与候选的 `title`、`address`、`category`
5. 写入 `decisions.json` 一条（`group_id` 与 pending 一致）

**禁止**用 `pickBestPoiForEvent` 等 JS 脚本代替大模型做最终选点（勿恢复已删除的 `agent-poi-build-*` / `agent-complete-*` 流水线）。

### 4. 入库

```bash
node scripts/apply-event-poi-decisions.js --city=成都
# 或 node scripts/apply-event-poi-decisions.js --file=data/poi-agent-workbench/成都/decisions.json
```

---

## 搜索词怎么写

| 规则 | 说明 |
|------|------|
| **用场馆/门牌，不用活动标题** | 标题是演出名，不是场地 |
| **保留栋/座/楼** | 豆瓣有 `A座`、`4b栋`，搜词必须带上 |
| **跟豆瓣 venue 对齐** | 不能随意缩短掉栋/座 |
| **剧名≠店名** | `沉浸式…《剧名》-锈罐头剧场` → 搜 `锈罐头剧场`（`lib/tencent-poi.js` → `extractSearchableVenueName`） |
| **豆瓣笔误要纠** | 如 `新国博览中心` → 搜 `新国际博览中心` 或 `浦东 新国际博览中心` |
| **城市** | CLI 已传 `--city`，关键词一般可不写城市名 |
| **多试几个** | 不准就换词，全部记入 `search_keywords_tried` |
| **别用过长复合串** | 如 `新华路160号上海影城SHO等8家影院` 太长易撞错影院；优先 `上海影城 SHO` / `SFC上影 上海影城` |

---

## 判断标准（Agent 写 decisions 时必须遵守）

### `action: match` — 可以绑定 POI

同时满足：

1. **区划一致**：豆瓣里的区（如 `闵行区`）与 POI `address` 中的区一致；跨区一律不 match
2. **门牌或地标一致**：POI 地址含豆瓣里的路名+号，或 POI 名称就是豆瓣写的场馆/商场/园区全称
3. **名称不能仅靠泛词**：单叫 `文创园`、`产业园`、`影院` 且地址对不上 → **不能 match**
4. **栋/座**：豆瓣写了 `A座`/`4b栋`，POI 名称应含相同栋座，或 POI 为含该栋的商务楼宇 POI
5. **类目合理**：剧场/酒吧/咖啡/展览应对应文化场馆、娱乐等，不要选停车场、地铁口、无关公司

`confidence`: `high` | `medium` | `low`（自选，便于人工排序）

### `action: reject` — 本轮未匹配 POI

- 候选都不符合上节标准
- 只有停车场/地铁站/无关门店
- 搜不到结果

**效果**：清空 `location_poi_id`，审核状态**仍为待定**（不是「拒绝活动」）。审核台筛「未匹配 POI」可见。

### `doubtful: true` — 有 POI 但建议人工核对

典型场景（`reason` 写清楚）：

| 场景 | reason 示例 |
|------|-------------|
| 只有大厦/园区级，无店名 POI | `豆瓣仅写到大厦/园区级地址，已对齐XX大厦主体` |
| 腾讯无店级 POI，对齐商场主体 | `腾讯无该星巴克店级POI，已对齐天环商场主体` |
| 豆瓣有楼层/铺位，POI 只到楼 | `豆瓣含楼层/铺位，POI仅到楼宇级` |
| 多场地活动只绑了一个 | `豆瓣写等8家影院，仅对齐上海影城SHO一家` |
| 栋座不完全一致但主体合理 | `POI已含A座，与豆瓣中泰国际A座一致`（此时可 `doubtful: false`） |

### `doubtful: false`

名称+地址+区划都对上，且不是上面存疑场景。

---

## 常见翻车（务必避免）

| 翻车 | 正确做法 |
|------|----------|
| 闵行 `联明路555号文创园` 命中宝山另一个「文创园」 | 看 **区 + 路名**；候选里有 `启示望远文创园`（联明路555号）应选它 |
| `上海影城SHO` 命中松江「辰山汽车影院」 | 只因关键词含「影院」；应搜 `上海影城` / `SFC上影` |
| 豆瓣 `reject` 但库里仍有 POI | 不要入库后又跑 `reassess-agent-poi-doubt.js` 把错误 POI 写回；reject 就保持无 POI |
| Agent 写 `doubtful:false` 但地址跨区 | 审核台现在会 **JS 二次校验**标黄，但仍应在 decisions 阶段就写对 |
| `decisions.json` 没写 `candidates` | 入库后审核页候选区为空；match 时把当次 Top5 候选抄进 `candidates` 数组 |
| 只信聊天记忆、不读 `pending.json` | 新会话必须从 workbench 文件读 groups，不能猜 event_uid |

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
  "agent": "cursor-composer",
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
      "candidates": [],
      "confidence": "high",
      "doubtful": false,
      "reason": "店名与金牛区地址一致"
    }
  ]
}
```

- `action`: `match` | `reject` | `skip`
- `reject`：无 `poi_id`；活动保持待审核
- `match`：建议带上 `candidates`（搜到的列表），便于审核页展示与改选

---

## 审核台（入库后）

地址：http://127.0.0.1:8787/ （`node scripts/server.js`）

### 展示

- 卡片标签：**POI 已匹配** / **未匹配 POI**；存疑时 **POI 存疑**
- 时间/地点下方直接显示 POI 名称与地址（不必滚到「入库准备」才看见）
- 无 `poi_candidates` 时，服务端会用当前 POI 补一条候选供点选

### 筛选（仅 **待定** 活动）

| 筛选项 | 含义 |
|--------|------|
| 未匹配 POI | `location_poi_id` 为空 |
| POI 存疑 | 见下节「存疑怎么算」 |

### POI 存疑怎么算

只认 **Agent 写入** 的 `poi_agent_doubtful` + `poi_agent_reason`（见 `lib/review-db.js` → `resolveEventPoiDisplayFlags`）。

- Agent 标 `doubtful: false` → 审核台**不黄标**
- Agent 标 `doubtful: true` → 黄标，并展示 Agent 写的 reason

不再叠加 JS 地址/区划自动校验，避免误报（如店名地址已对、却被「区划不一致」标黄）。

### 人工改 POI

自由搜索关键词 → 点选候选保存（`poi_match_source: manual`），不再走 JS 自动 Top1。

---

## 脚本一览

| 脚本 | 作用 |
|------|------|
| `scripts/scrape-douban-week-events.js` | 抓取豆瓣入库 |
| `scripts/export-events-for-poi.js` | 导出待 POI groups → `pending.json` |
| `scripts/prepare-city-poi-for-agent.js` | 抓取 + 导出一步 |
| `scripts/poi-search-cli.js` | 调腾讯 POI（给大模型读 JSON） |
| `scripts/apply-event-poi-decisions.js` | `decisions.json` → `review.db` |
| `scripts/reassess-agent-poi-doubt.js` | 按当前规则重评已标存疑条目（可重搜）；**勿用来推翻明确的 reject** |

---

## 已废弃（勿再使用）

| 项目 | 说明 |
|------|------|
| `run-city-agent-poi.js` | 旧 JS 自动 POI 流水线 |
| ~~`agent-poi-build-*` / `agent-complete-*`~~ | 已删除；勿用 JS 自动搜词/选 POI |
| 抓取 `--with-poi` | 旧版 JS Top1 |
| 审核页「智能匹配」 | 已移除 |
| `/api/events/poi-auto-batch` | 已禁用 |

`lib/tencent-poi.js` 仍用于：腾讯 API、商户 POI、审核页自由搜索。活动 POI 的**搜词、选点、存疑**只认大模型 + `decisions.json`。

---

## 新 Cursor 会话检查清单

Agent 接到「抓取 XX 活动」时，按顺序自检：

- [ ] 已读本文档「判断标准」「常见翻车」
- [ ] 抓取未加 `--with-poi`
- [ ] 已跑 `export-events-for-poi.js` 并打开 `pending.json`
- [ ] 每组都跑过 `poi-search-cli.js`，对照候选与豆瓣 **区划+门牌+店名**
- [ ] `decisions.json` 的 `group_id` / `event_uids` 与 pending 一致
- [ ] `reject` 的组没有 `poi_id`；`match` 的组区划一致
- [ ] 已跑 `apply-event-poi-decisions.js`
- [ ] 汇报匹配/未匹配/存疑数量，列出需人工条目

相关 Cursor 规则：`.cursor/rules/douban-crawl-and-agent-poi.mdc`

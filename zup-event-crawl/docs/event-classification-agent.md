# 活动分类与推荐/挡下：Cursor 大模型判断

> **新开会话必读**：抓取后「推荐 / 挡下」与「类型」由 **Agent** 读 `classification-pending.json` 写 `classification-decisions.json` 入库。
>
> **分类标准（单一事实来源）**：[`classification-agent-prompt.md`](classification-agent-prompt.md) — 10 类展示分类、展会规则、废弃类名、输出格式。**后续判类只按该文档执行。**

## 目标

Zup 要的是 **线下交友、娱乐、体验** 类同城活动，不要：

- 纯 B2B 行业展会、博览会、贸易展（如跨境电商展、工业展）
- B2B 峰会、论坛、招商会、系统培训课程、招聘
- 纯商业获客、与「找人一起玩」无关的会场活动

同时要给出 **准确的展示分类**（不用豆瓣原始类型）。

---

## 流程（在 POI 之前做）

```
抓取 scrape-douban-week-events.js
    ↓
导出 export-events-for-classification.js → classification-pending.json
    ↓
【大模型】逐条判断 suggested + category + reason（细则见 classification-agent-prompt.md）
    ↓
写入 classification-decisions.json → apply-event-classification-decisions.js
    ↓
（再继续 POI 流程，见 event-poi-agent-workflow.md）
```

一键入口 `prepare-city-poi-for-agent.js` 已包含分类导出。

---

## 展示分类（`category`）

只能取 [`lib/event-classification.js`](../lib/event-classification.js) 中 `EVENT_CATEGORIES` 之一：

| 分类 | 适用（摘要） |
|------|----------------|
| **约饭** | 纯约饭局（抓取极少；App 用户自发） |
| **戏剧表演** | 脱口秀、开放麦。喜剧节、单口喜剧、即兴喜剧、话剧、舞台剧、儿童剧、悬疑剧、歌剧、相声、魔术、魔法演出已在入库前丢弃，不要写回 |
| **音乐现场** | 演唱会、音乐节、Live。音乐会已在入库前丢弃 |
| **市集** | 快闪、集市、啤酒节、动漫节/漫展/同人only、嘉年华；**公众可逛的博览会**（茶博会、食博会、咖啡文化节等） |
| **体育运动** | 球类、竞技、体育赛事 |
| **户外活动** | 徒步、露营、溯溪、Citywalk、登塔观景 |
| **主题沙龙** | 读书会、破圈/跨职业/创业者交流、销售力沙龙、品鉴体验、绘画/演讲/舞蹈体验社交、桌游交友局 |
| **看展逛馆** | 艺术季、艺术展、作品展、博物馆、美术馆、特展、个展已在入库前丢弃。快闪、市集不要归到这里 |
| **遛娃亲子** | 亲子乐园、动物园、明确少儿向 |
| **其他** | 纯 B2B 行业展、门票产品、明星见面会、商拍/演员招募、系统培训课程 |

**展会**：公众可逛 → **市集** 或 **看展逛馆**；纯 B2B 招商 → **其他** + `suggested: false`。详见 [`classification-agent-prompt.md`](classification-agent-prompt.md)。

> **已废弃（勿用）**：Coffee Chat、小酌、交友聚会、疗愈成长、社交、展览、手作体验 等旧名；`normalizeCategory` 会自动映射到现行类。

> **禁止**用 `batch-classify-all-events.js` / `remap-active-event-categories.js`（已废弃）。

> **注意**：票务详情里的「儿童说明」「家庭票」不是亲子活动信号，不要据此标 **遛娃亲子**。

挡下的活动也请给一个分类（多为 **其他**），便于筛选统计。

---

## `suggested`：推荐 vs 挡下

| 值 | 审核台 | 含义 |
|----|--------|------|
| `true` | **推荐** | 适合 Zup 用户线下结伴、娱乐、社交 |
| `false` | **已挡下** | 无趣或偏行业/商业，冷启动不做 |

### 应挡下（`suggested: false`）示例

- 跨境电商贸易展、工业自动化展、智慧监狱展等 **纯 B2B**
- 创业培训、职业技能系统课、会员产品售卖
- 商拍/演员招募、宠物乐园门票

### 应推荐（`suggested: true`）示例

- 脱口秀、开放麦
- 破圈社交、桌游、本地徒步、Citywalk
- 公众博览会、动漫节、同人 only、啤酒节/市集

国学、易经、《庄子》《论语》等传统经典讲读活动也在入库前丢掉。

话剧、音乐剧、舞台剧、儿童剧、悬疑剧、交响、歌舞/舞剧、歌剧、相声、魔术、魔法演出、喜剧节、单口喜剧、即兴喜剧、音乐会、体验课、学习课、系统课、园游会、旅游/文旅、艺术季、艺术展、作品展、博物馆/美术馆、特展、个展、大赛、景区或展馆的门票和套票、VR/XR 沉浸体验馆和沉浸剧、文化节、光影节、只有分会场名字的标题、逛公园不会进审核台（入库时由 `lib/event-low-social-filter.js` 丢掉）。演唱会、音乐节、脱口秀留下。标题里的「沉浸式演唱会」留下。即兴爵士留下。

### 判断依据

读每条导出的：`title`、`location`、`fee`、`owner`、`time_text`、`douban_event_type`（仅供参考）、`slide_category`（仅供参考）、`body_excerpt`、`detail_excerpt`。

**不要**只看豆瓣类型；**不要**用 JS `inferCategory` 批量写库。

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
      "reason": "跨境电商贸易展会，偏行业招商"
    },
    {
      "event_uid": "douban:37884967",
      "suggested": true,
      "category": "主题沙龙",
      "reason": "自我成长主题线下沙龙，小型交流聚会"
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
| `export-active-events-for-classification.js` | **未过期全量**导出（强制重分类）；`--city=` / 默认全城 |
| `export-events-for-classification.js` | 仅导出尚未 agent 分类的活动 |
| `apply-event-classification-decisions.js` | decisions → review.db；小红书加 `--source=xiaohongshu` |
| `apply-all-classification-decisions.js` | 批量 apply 所有城 workbench 下的 decisions |

---

## 新会话检查清单

- [ ] 已读 [`classification-agent-prompt.md`](classification-agent-prompt.md)
- [ ] 抓取后已跑 `export-events-for-classification.js`
- [ ] 每条 `event_uid` 与 pending 文件一致
- [ ] `category` 在 `EVENT_CATEGORIES` 允许列表内
- [ ] `reason` 写清挡下或推荐原因
- [ ] 已跑 `apply-event-classification-decisions.js`
- [ ] 再继续 POI 流程

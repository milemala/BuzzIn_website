# AI 协作说明（zup-event-crawl）

在本目录或官网仓库内做**活动抓取 / 审核台**相关工作时，请先阅读：

1. [`docs/HANDOFF.md`](docs/HANDOFF.md) — 完整交接（业务规则、审核台、事故记录）
2. [`README.md`](README.md) — 命令速查与目录结构
3. **[`docs/event-classification-agent.md`](docs/event-classification-agent.md)** — **推荐/挡下 + 活动分类**（Agent 判断，非 JS 打分）
4. **[`docs/event-body-agent.md`](docs/event-body-agent.md)** — **活动介绍 body**（Agent 撰写完整正文含参加方式，JS 仅备选）
5. **[`docs/event-poi-agent-workflow.md`](docs/event-poi-agent-workflow.md)** — **POI 匹配（Agent 全程定搜词 + 判结果）**

用户说「抓取某城豆瓣活动」时，**必须先读 3、4、5**，再执行 `.cursor/rules/douban-crawl-and-agent-poi.mdc`：**先分类入库，再写 body，再 POI**。规则以仓库文档为准，不依赖聊天上下文。

官网 H5 原型在仓库 `events/`，不在此目录。

---

## 新会话开场白（复制粘贴）

### 全套：抓取某城 + 分类 + 介绍 + POI

把 `【城市】` 换成中文城市名（如成都、深圳）：

```
请在 zup-event-crawl 按标准流程处理【城市】豆瓣活动。

开始前务必阅读（不要依赖聊天记忆）：
1. AGENTS.md
2. docs/event-classification-agent.md
3. docs/event-body-agent.md
4. docs/event-poi-agent-workflow.md
5. .cursor/rules/douban-crawl-and-agent-poi.mdc

执行顺序：
抓取（或 --skip-scrape）→ 分类 export/apply → 介绍 export/写 body-decisions/apply → POI export/搜词/写 decisions/apply

规则摘要：
- 分类、介绍、POI 均由 Agent 判断
- **POI**：Agent 定搜词 → `poi-search-cli.js` → Agent 读候选写 `decisions.json` → apply；禁止 JS 自动搜词/选点（`pickBestPoiForEvent`、`batch-resolve-*` 等）
- POI 只处理审核 **待定** 且无 POI；跳过 review **rejected**（人工已拒绝）和 suggested=0（挡下）
- 介绍写完整 body（活动介绍 + 参加方式），body_source=agent 后不再 JS 追加参加方式
- 每步汇报条数；decisions 写入 data/poi-agent-workbench/【城市】/

本地库：zup-event-crawl/data/review.db
```

### 只刷新活动介绍（某城或全城）

```
请按 docs/event-body-agent.md 为【城市】重写活动介绍。

先 export-events-for-body.js --refresh，排除 suggested=0 和 review rejected；
逐条写 body-decisions.json（完整 body 含参加方式），再 apply-event-body-decisions.js。
不要走 JS 备选 batch-infer-event-bodies.js，除非我明确要求。
```

### 只补「未匹配 POI」（已有抓取数据）

```
请按 docs/event-poi-agent-workflow.md 场景 B 为【城市】补 POI。

1. export-events-for-poi.js --city=【城市】 --refresh --pending-only
2. 读 pending.json，每一组：Agent 定搜词 → poi-search-cli.js → Agent 读候选
3. Agent 手写 decisions.json（禁止 JS 自动生成）
4. apply-event-poi-decisions.js
5. 汇报处理了几组、匹配/reject 数量
```

### 只复核「POI 存疑」

```
请按 docs/event-poi-agent-workflow.md 场景 C 复核【城市】存疑 POI。

1. export-events-for-poi.js --city=【城市】 --refresh --doubtful-only
2. 读 doubtful-pending.json，每一组必须重新搜 poi-search-cli，再 Agent 手写 decisions
3. 禁止用 JS 比地址自动改 doubtful（build-agent-rerun-decisions 等已删除）
4. apply 后汇报：取消存疑几组、仍存疑几组
```

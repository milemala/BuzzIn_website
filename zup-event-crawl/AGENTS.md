# AI 协作说明（zup-event-crawl）

在本目录做**活动抓取 / 审核台**时，**新开会话必须先读**（不依赖聊天记忆）：

1. **[`docs/event-crawl-master-workflow.md`](docs/event-crawl-master-workflow.md)** — **豆瓣 + 小红书主流程、JS/Agent 分工、检查清单**
2. [`docs/HANDOFF.md`](docs/HANDOFF.md) — 业务规则、审核台、事故记录
3. [`README.md`](README.md) — 命令速查

按来源再读子文档 + Cursor 规则：

| 来源 | 规则文件（用户说「抓取」时） | 子文档 |
|------|------------------------------|--------|
| 豆瓣 | [`.cursor/rules/douban-crawl-and-agent-poi.mdc`](.cursor/rules/douban-crawl-and-agent-poi.mdc) | time → [classification](docs/event-classification-agent.md) → [body](docs/event-body-agent.md) → [POI](docs/event-poi-agent-workflow.md) |
| 小红书 | [`.cursor/rules/xhs-crawl-and-review-import.mdc`](.cursor/rules/xhs-crawl-and-review-import.mdc) | [xiaohongshu-review-workflow.md](docs/xiaohongshu-review-workflow.md) + 上表 classification / POI |

官网 H5 原型在仓库 `events/`，不在此目录。

---

## 新会话开场白（复制粘贴）

### 豆瓣全套：抓取 + 时间 + 分类 + 介绍 + POI

把 `【城市】` 换成中文城市名（如成都、深圳）：

```
请在 zup-event-crawl 按标准流程处理【城市】豆瓣活动。

开始前务必阅读（不要依赖聊天记忆）：
1. docs/event-crawl-master-workflow.md
2. .cursor/rules/douban-crawl-and-agent-poi.mdc
3. docs/event-time-agent.md
4. docs/event-classification-agent.md
5. docs/event-body-agent.md
6. docs/event-poi-agent-workflow.md

执行顺序（见 master-workflow §豆瓣）：
抓取 → 时间 apply → 分类 apply → body apply → POI export → Agent 搜+判 → POI apply

规则摘要：
- 分类、介绍、POI 均由 Agent 判断；POI 禁止 JS 自动选点
- POI 只处理审核待定且无 POI；跳过 review rejected
- workbench：data/poi-agent-workbench/【城市】/
- 本地库：zup-event-crawl/data/review.db
```

### 小红书全套：抓取 + 读图 + 入库 + 分类 + POI

```
请在 zup-event-crawl 按标准流程处理【城市】小红书一周活动。

开始前务必阅读（不要依赖聊天记忆）：
1. docs/event-crawl-master-workflow.md
2. .cursor/rules/xhs-crawl-and-review-import.mdc
3. docs/xiaohongshu-review-workflow.md
4. docs/xiaohongshu-vision-agent.md（若要读图标框）
5. docs/event-classification-agent.md
6. docs/event-poi-agent-workflow.md

执行顺序（见 master-workflow §小红书）：
抓取/读图/extract/验收 → 入库 → 时间（如需）→ 分类 apply → POI apply

规则摘要：
- 入库后同会话必须完成分类 + POI（入库会自动导出 classification-pending + pending.json）
- body 已用 highlights，通常跳过 body Agent
- apply 分类/POI 必须加 --source=xiaohongshu
- workbench：data/poi-agent-workbench/【城市】-xhs/
- 账号：data/xhs-city-accounts.json
```

### 只补「未匹配 POI」

```
请按 docs/event-poi-agent-workflow.md 场景 B 为【城市】补 POI。
豆瓣：export-events-for-poi.js --city=【城市】 --refresh --pending-only
小红书：加 --source=xiaohongshu
→ Agent 定搜词 → poi-search-cli → 手写 decisions.json → apply-event-poi-decisions.js
```

### 只复核「POI 存疑」

```
请按 docs/event-poi-agent-workflow.md 场景 C 复核【城市】存疑 POI。
export-events-for-poi.js --doubtful-only（小红书加 --source=xiaohongshu）
→ 每组必须重新搜 → Agent 手写 decisions → apply
```

### 只刷新活动介绍（豆瓣）

```
请按 docs/event-body-agent.md 为【城市】重写活动介绍。
export-events-for-body.js --refresh → body-decisions.json → apply-event-body-decisions.js
```

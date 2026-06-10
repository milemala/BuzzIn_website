# AI 协作说明（zup-event-crawl）

在本目录或官网仓库内做**活动抓取 / 审核台**相关工作时，请先阅读：

1. [`docs/HANDOFF.md`](docs/HANDOFF.md) — 完整交接（业务规则、审核台、事故记录）
2. [`README.md`](README.md) — 命令速查与目录结构
3. **[`docs/event-classification-agent.md`](docs/event-classification-agent.md)** — **推荐/挡下 + 活动分类**（Agent 判断，非 JS 打分）
4. **[`docs/event-body-agent.md`](docs/event-body-agent.md)** — **活动介绍 body**（Agent 撰写完整正文含参加方式，JS 仅备选）
5. **[`docs/event-poi-agent-workflow.md`](docs/event-poi-agent-workflow.md)** — **POI 匹配**（搜词、decisions、常见翻车）

用户说「抓取某城豆瓣活动」时，**必须先读 3、4、5**，再执行 `.cursor/rules/douban-crawl-and-agent-poi.mdc`：**先分类入库，再写 body，再 POI**。规则以仓库文档为准，不依赖聊天上下文。

官网 H5 原型在仓库 `events/`，不在此目录。

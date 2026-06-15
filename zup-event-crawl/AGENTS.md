# AI 协作说明（zup-event-crawl）

> **受众：执行任务的 Cursor Agent。** 终端用户不读本文件；用户只对 Agent **用自然语言提需**，Agent 包办后续。

> **硬性门禁**：仓库根 [`.cursor/rules/zup-event-crawl-hard-gates.mdc`](../../.cursor/rules/zup-event-crawl-hard-gates.mdc)（`alwaysApply`）。posterBox 须读图标框；`extract` 脚本守卫会拒绝模板坐标与缺 meta。

在本目录做**活动抓取 / 审核台**时，**新开会话必须先读**（不依赖聊天记忆）：

1. **[`docs/event-crawl-master-workflow.md`](docs/event-crawl-master-workflow.md)** — **豆瓣 + 小红书主流程、JS/Agent 分工、检查清单**
2. [`docs/HANDOFF.md`](docs/HANDOFF.md) — 业务规则、审核台、事故记录
3. [`README.md`](README.md) — 命令速查（Agent 内部用）

按来源再读子文档 + Cursor 规则：

| 来源 | 规则文件 | 子文档 |
|------|----------|--------|
| 豆瓣 | [`.cursor/rules/douban-crawl-and-agent-poi.mdc`](.cursor/rules/douban-crawl-and-agent-poi.mdc) | time → classification → body → POI |
| 小红书 | [`.cursor/rules/xhs-crawl-and-review-import.mdc`](.cursor/rules/xhs-crawl-and-review-import.mdc) | xiaohongshu-review-workflow + classification / POI |

官网 H5 原型在仓库 `events/`，不在此目录。

---

## 术语

| 说法 | 含义 |
|------|------|
| **入库** | 抓取 → 写入本地 `review.db`（**审核台**） |
| **推送 Zup** | 审核台 → 同步到 Buzz **线上后台**（勿与入库混称） |

---

## 用户怎么说（自然语言即可）

用户**不需要**复制长段 prompt、**不需要**记脚本名。口语示例（把城市名换成实际城市）：

| 用户意图 | 怎么说 |
|----------|--------|
| 小红书全套 | 「处理【城市】小红书一周活动」 / 「抓取【城市】小红书并入库」 |
| 只重跑海报 | 「重跑【城市】小红书海报」 |
| 只补 POI | 「给【城市】补 POI」 / 「【城市】小红书未匹配 POI 处理一下」 |
| 只复核存疑 POI | 「复核【城市】POI 存疑」 |
| 豆瓣全套 | 「处理【城市】豆瓣活动」 / 「抓取【城市】豆瓣并做完分类 POI」 |
| 只刷新介绍 | 「重写【城市】豆瓣活动介绍」 |

Agent 收到后自行读 master-workflow + 对应 `.mdc` 规则，一条龙执行并汇报。

---

## Agent 内部参考

任务拆解与脚本清单见 [`docs/event-crawl-master-workflow.md`](docs/event-crawl-master-workflow.md) 及对应 `.cursor/rules/*.mdc`。用户不读本节。

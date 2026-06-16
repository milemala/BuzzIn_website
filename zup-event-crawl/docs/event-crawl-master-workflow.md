# 活动抓取主流程（豆瓣 + 小红书）

> **新开会话必读本文**。流程以仓库内文档与 Cursor 规则为准，**不依赖聊天上下文**。  
> **用户**只对 Agent 用自然语言提需；**Agent** 读本文并执行。提需示例见 [`AGENTS.md`](../AGENTS.md)。

## 术语（勿混淆）

| 说法 | 含义 | 典型位置 |
|------|------|----------|
| **入库** | 抓取结果写入本地 **`review.db`**，在**审核台**里可见、可审 | `importPayload`、`append-city`、Agent 汇报「入库 N 条」 |
| **推送 Zup** | 审核台里**已通过且字段齐全**的活动/商户，写入 **Buzz 线上后台** | 审核页顶部「批量推送 Zup」、单条「推送 Zup」按钮、`buzz-now-import.js` |

审核台筛选项「已推送 / 待推送」指 **Zup 后台**状态，不是「有没有进审核台」。代码里 `import_status` / `import_ready` 等字段名历史沿用，**对用户一律说「推送 Zup」**。

---

## 权威来源（按来源分）

| 来源 | 主文档 | Cursor 规则（Agent 在用户提需后触发） |
|------|--------|-----------------------------------|
| **豆瓣** | 本文 §豆瓣 + 子文档 | [`.cursor/rules/douban-crawl-and-agent-poi.mdc`](../.cursor/rules/douban-crawl-and-agent-poi.mdc) |
| **小红书** | 本文 §小红书 + [`xiaohongshu-review-workflow.md`](xiaohongshu-review-workflow.md) | [`.cursor/rules/xhs-crawl-and-review-import.mdc`](../.cursor/rules/xhs-crawl-and-review-import.mdc) |

子文档（判定细则）：

| 步骤 | 文档 |
|------|------|
| 入库时间 | [`event-time-agent.md`](event-time-agent.md) |
| 分类/挡下 | [`event-classification-agent.md`](event-classification-agent.md) |
| 活动介绍 body | [`event-body-agent.md`](event-body-agent.md)（豆瓣主路径；小红书用 highlights） |
| POI 匹配 | [`event-poi-agent-workflow.md`](event-poi-agent-workflow.md) |

Workbench 目录：

| 来源 | 路径 |
|------|------|
| 豆瓣 | `data/poi-agent-workbench/<城市>/` |
| 小红书 | `data/poi-agent-workbench/<城市>-xhs/` |

---

## JS 做什么 vs Agent 做什么（总表）

| 步骤 | JS 脚本 | Agent（大模型） |
|------|---------|----------------|
| 抓取/解析 HTML | ✅ | ❌ |
| 入库 SQLite | ✅ | ❌ |
| 导出 pending JSON | ✅ | ❌ |
| 映射库查询（仅活动 POI） | ✅ 精确匹配 | ❌ |
| 调腾讯 POI API | ✅ `poi-search-cli.js` 只执行搜词 | ❌ 不定搜词、不选点 |
| **定搜词、读候选、match/reject/doubtful** | ❌ **禁止** | ✅ **必须** |
| **写 `*-decisions.json`** | ❌ | ✅ **唯一依据** |
| apply decisions 落库 | ✅ | ❌ |
| 小红书读图写 `posterBox` | ❌ | ✅ Agent 读图 |

**铁律**：`pickBestPoiForEvent`、`batch-resolve-*`、JS 自动生成 `decisions.json` 均已禁止。

---

## 抓取去重规则（豆瓣 + 小红书共用）

| 规则 | 说明 |
|------|------|
| **豆瓣列表** | 默认 `--max-pages=10`（每城约 100 条列表项） |
| **豆瓣跳过已抓** | 按 `source_id` 或详情页 URL 中的 `event/<id>` 判断；**全库**去重，不限城市 |
| **小红书跳过已抓帖** | 本地 `weekly-summary.json` + 库内 `xiaohongshu:<noteId>:*` 反查；选帖时自动跳过，优先选**未抓过**的本周/节日/整月汇总 |
| **节日专题帖** | 如「北京端午活动汇总6.19～6.21」会作为「未来约 3 周内」的候选（支持全角 `～` 日期） |
| **内容去重** | 同城 **名称 + 地址 + 时间** 完全相同 → 丢弃；同城 **名称 + 地址** 相同 → **只保留 `end_date` 最晚** 的一条（抓取 + 入库 `append-city` 双保险，新条更晚会替换旧条） |

实现：`lib/event-content-dedup.js`、`lib/xhs-scraped-notes.js`。

---

## 豆瓣：一条龙顺序

用户说「抓取【城市】豆瓣活动」→ 读 [douban-crawl-and-agent-poi.mdc](../.cursor/rules/douban-crawl-and-agent-poi.mdc)。

| # | 步骤 | 执行者 | 命令 / 产物 |
|---|------|--------|-------------|
| 1 | 抓取入库 | JS | `scrape-douban-week-events.js` 或 `prepare-city-poi-for-agent.js --city=` |
| 2 | 校正时间 | Agent + JS | `export-events-for-time.js` → Agent 写 `time-decisions.json` → `apply-event-time-decisions.js` |
| 3 | 分类挡下 | Agent + JS | `export-events-for-classification.js --city=` → `classification-decisions.json` → apply |
| 4 | 写介绍 | Agent + JS | `export-events-for-body.js` → `body-decisions.json` → apply |
| 5 | 导出 POI 任务 | JS | `export-events-for-poi.js --city= --refresh --pending-only` → `pending.json`（含 `cached_poi`） |
| 6 | 配 POI | Agent + JS | 每组：定搜词 → `poi-search-cli.js` → Agent 读候选 → `decisions.json` → `apply-event-poi-decisions.js` |
| 7 | 汇报 | Agent | 各步条数；POI：几组、匹配/reject/存疑 |

一键仅抓取+导出（不含 Agent 判定）：`node scripts/prepare-city-poi-for-agent.js --city=<城市> --max-pages=10`

---

## 小红书：一条龙顺序

用户说「抓取【城市】小红书活动」→ 读 [xhs-crawl-and-review-import.mdc](../.cursor/rules/xhs-crawl-and-review-import.mdc) + [xiaohongshu-review-workflow.md](xiaohongshu-review-workflow.md)。

| # | 步骤 | 执行者 | 命令 / 产物 |
|---|------|--------|-------------|
| 1 | 抓个人页/下图 | JS | `run-xhs-weekly-pipeline.js --city=` |
| 2 | 读 slide 写 `vision-slots.json` | **Agent** | 见 [xiaohongshu-vision-agent.md](xiaohongshu-vision-agent.md) |
| 3 | extract | JS | `extract-xhs-weekly-events.js`（产出 `posters/`） |
| 4 | 入库 + 分类 + POI | Agent + JS | `import-xhs-events-to-review.js` 等 |
| 4 | 入库 | JS | `run-xhs-weekly-pipeline.js --skip-scrape --city=` → **自动导出** `classification-pending.json` + `pending.json` |
| 5 | 校正时间 | Agent + JS | 见 [event-time-agent.md](event-time-agent.md)（`--source=xiaohongshu`） |
| 6 | 分类 | Agent + JS | `classification-decisions.json` → `apply-event-classification-decisions.js --source=xiaohongshu` |
| 7 | 配 POI | Agent + JS | 读 `pending.json` 每组 → `poi-search-cli.js` → `decisions.json` → `apply-event-poi-decisions.js --source=xiaohongshu` |
| 8 | 汇报 | Agent | 入库数、分类推荐/挡下、POI 组数 |

**跳过**：body Agent（入库已写 `highlights`，`body_source=xhs_source`）。

**不做**：入库阶段 JS 自动 POI；商户不走地址映射库。

---

## 豆瓣 vs 小红书（差异）

| | 豆瓣 | 小红书 |
|---|------|--------|
| workbench | `<城市>/` | `<城市>-xhs/` |
| 分类 export | `--city=` 默认 douban | `--source=xiaohongshu`；**入库后自动导出** |
| body | Agent 写 `body-decisions.json` | 抓取时已写 highlights，通常跳过 |
| POI export | 手动 `--pending-only` | **入库后自动导出** `pending.json` |
| POI apply | `--city=` | `--city=` + `--source=xiaohongshu` |
| 映射库 | 活动地址 → POI，导出时附 `cached_poi` | 同左（共用 `poi_address_cache`，仅活动） |
| 前置独有 | — | vision-slots、海报裁切验收 |

---

## 新会话检查清单（Agent 自检）

### 豆瓣全套

- [ ] 已读本文 + `douban-crawl-and-agent-poi.mdc`
- [ ] 时间 → 分类 → body → POI 顺序未跳步
- [ ] POI 每组亲自读 `poi-search-cli` 输出后才写 decisions
- [ ] 未对 `review_decisions.status=rejected` 的活动做 POI

### 小红书全套

- [ ] 已读本文 + `xhs-crawl-and-review-import.mdc` + `xiaohongshu-review-workflow.md`
- [ ] `vision-slots.json` 已填且已 `extract` 再入库
- [ ] 入库后**同会话**完成分类 + POI（非「以后再说」）
- [ ] apply 分类/POI 均带 `--source=xiaohongshu`

---

## 仅补某一环（常见）

| 需求 | 文档场景 | 导出命令 |
|------|----------|----------|
| 只补未匹配 POI | event-poi §场景 B | `export-events-for-poi.js --pending-only`（小红书加 `--source=xiaohongshu`） |
| 只复核 POI 存疑 | event-poi §场景 C | `export-events-for-poi.js --doubtful-only` |
| 只重写 body | event-body-agent.md | `export-events-for-body.js --refresh` |
| 只补分类 | event-classification-agent.md | `export-events-for-classification.js`（小红书加 `--source=xiaohongshu`） |

用户提需口语示例见 [`AGENTS.md`](../AGENTS.md)「用户怎么说」。

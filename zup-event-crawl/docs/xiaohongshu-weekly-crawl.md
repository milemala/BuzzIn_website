# 小红书一周活动汇总抓取（Chrome 主路）

更新时间：2026-06-11

> **完整标准流程（抓取 → 读图 → 入库）见 [`xiaohongshu-review-workflow.md`](xiaohongshu-review-workflow.md)**  
> 一键入口：`node scripts/run-xhs-weekly-pipeline.js`

## 核心原则

**版式每次、每账号都可能不同。** 脚本只负责抓图；**活动信息与海报裁切框均由 Agent 每次读图决定**。

| 步骤 | 谁来做 |
|------|--------|
| 抓帖 + 下图 | `scrape-xhs-profile-weekly.js` / 流水线 |
| 读图 + 填 `vision-slots.json`（含 `posterBox`） | **Agent**（见 [`xiaohongshu-vision-agent.md`](xiaohongshu-vision-agent.md)） |
| 按 `posterBox` 裁海报 + 合并 JSON | `extract-xhs-weekly-events.js` |
| 合成封面 + 入库审核台 | `import-xhs-events-to-review.js` / 流水线 |

## 目录约定

```
data/scrape-cache/xhs/<城市>/<笔记ID>/
├── images/*.webp          # slide 原图（posterBox 坐标基准）
├── images-jpg/*.jpg       # Agent 读图用（抓取时自动双写，quality≈60）
├── vision-slots.json      # Agent 填写（必备，否则不能入库）
├── posters/               # 仅在有 posterBox 时生成
├── events-extracted.json
└── weekly-summary.json
```

## 命令

```bash
# 推荐：标准流水线（多城）
node scripts/run-xhs-weekly-pipeline.js --city=北京,上海,广州

# 单城抓取（仅下载，无 vision 时不 extract）
node scripts/scrape-xhs-profile-weekly.js --city=北京 "<个人页URL>"

# Agent 写好 vision-slots.json 后续跑
node scripts/run-xhs-weekly-pipeline.js --skip-scrape --city=北京

# 多城（封装为流水线）
node scripts/batch-scrape-xhs-cities.js --city=北京,上海
```

账号清单：`data/xhs-city-accounts.json`

### 选帖规则（`pickWeeklyRoundupNote`）

1. **本周/下周**：标题含本周、下周、一周等 + 活动汇总/指南/可做的 N 件事，或标题带 `6.8-6.14` 类日期区间
2. **节日/专题**：标题带明确日期区间（如端午 `6.19～6.21`）且未过期
3. **整月**：无本周/下周时，选含「N月」+ 活动汇总/市集活动/值得一去 等整月清单帖
4. **详情页日期校验**（标题命中后）：打开详情，读标题 + 正文 + `活动周期：…`；若出现 `6.19-6.21` 等**明确日期区间且全部已过期**，跳过该帖、尝试下一候选；全部过期则**放弃该城**
5. **无合适帖**：返回 null，该城**跳过**（不默认抓首条）

**Agent 手动处理时**：若详情正文无日期但**封面 slide** 上写着已过期的区间（如上周端午 `6.19-6.21`），同样放弃该城，不读图标框。

## 代码模块

| 文件 | 职责 |
|------|------|
| `scripts/run-xhs-weekly-pipeline.js` | **标准一键流水线** |
| `lib/xhs-weekly-pipeline.js` | 流水线编排（vision 检查、extract、import） |
| `lib/xiaohongshu-parse.js` | 个人页解析、选汇总帖 |
| `lib/xiaohongshu-chrome-fetch.js` | Chrome 抓取 + 下图（webp + images-jpg 双写） |
| `lib/ensure-slide-review-jpg.js` | 按需单页生成读图 JPEG |
| `lib/poster-box-percent-to-px.js` | 问题清单 % → posterBox px（仅算术） |
| `lib/xiaohongshu-poster-crop.js` | 仅执行 Agent 给的 `posterBox` |
| `lib/xhs-review-import.js` | 入库字段映射与封面 |
| `lib/xhs-text-cover-compose.js` | 无海报文字封面 |
| `scripts/extract-xhs-weekly-events.js` | 合并输出 |
| `scripts/import-xhs-events-to-review.js` | 写入 review.db |

**无自动裁切算法**（已删除城市/启发式规则）。

## 后续（与豆瓣同一套 Agent）

- [x] events-extracted → 入库 `review.db`
- [ ] 分类 Agent → `export-events-for-classification.js`
- [ ] 介绍 Agent → `export-events-for-body.js`
- [ ] POI Agent → `export-events-for-poi.js`（有腾讯 key 额度时）

详见 [`xiaohongshu-review-workflow.md`](xiaohongshu-review-workflow.md)。

# 小红书一周活动汇总抓取（Chrome 主路）

更新时间：2026-06-11

## 核心原则

**版式每次、每账号都可能不同。** 脚本只负责抓图；**活动信息与海报裁切框均由 Agent 每次读图决定**。

| 步骤 | 谁来做 |
|------|--------|
| 抓帖 + 下图 | `scrape-xhs-profile-weekly.js` |
| 读图 + 填 `vision-slots.json`（含 `posterBox`） | **Agent**（见 [`xiaohongshu-vision-agent.md`](xiaohongshu-vision-agent.md)） |
| 按 `posterBox` 裁海报 + 合并 JSON | `extract-xhs-weekly-events.js` |

## 目录约定

```
data/scrape-cache/xhs/<城市>/<笔记ID>/
├── images/*.webp          # slide 原图（Agent 读这些）
├── vision-slots.json      # Agent 填写
├── posters/               # 仅在有 posterBox 时生成
├── events-extracted.json
└── weekly-summary.json
```

## 命令

```bash
# 单城抓取
node scripts/scrape-xhs-profile-weekly.js --city=北京 "<个人页URL>"

# Agent 写好 vision-slots.json 后
node scripts/extract-xhs-weekly-events.js data/scrape-cache/xhs/北京/<笔记ID>

# 多城
node scripts/batch-scrape-xhs-cities.js --city=北京,上海
```

## 代码模块

| 文件 | 职责 |
|------|------|
| `lib/xiaohongshu-parse.js` | 个人页解析、选汇总帖 |
| `lib/xiaohongshu-chrome-fetch.js` | Chrome 抓取 + 下图 |
| `lib/xiaohongshu-poster-crop.js` | 仅执行 Agent 给的 `posterBox` |
| `scripts/extract-xhs-weekly-events.js` | 合并输出 |

**无自动裁切算法**（已删除城市/启发式规则）。

## 后续

- [x] events-extracted → 入库 `review.db`（`node scripts/import-xhs-events-to-review.js`）
- [ ] 对接分类 / POI Agent

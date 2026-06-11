# 小红书一周活动 · 抓取到审核台（标准流程）

更新时间：2026-06-11

**不要依赖聊天记忆。** Agent / 人工执行本流程时，以本文 + 子文档为准。

## 一句话

Chrome 抓汇总帖 → **Agent 每次读 slide 写 `vision-slots.json`** → 脚本裁图/合并 → **合成封面入库 `review.db`**（`source=xiaohongshu`）→ 审核台人工过一遍 →（后续）分类 / 介绍 / POI Agent。

## 必读子文档

| 文档 | 内容 |
|------|------|
| [`xiaohongshu-weekly-crawl.md`](xiaohongshu-weekly-crawl.md) | 抓取、目录约定、代码模块 |
| [`xiaohongshu-vision-agent.md`](xiaohongshu-vision-agent.md) | Agent 读图、posterBox 规则 |
| [`event-classification-agent.md`](event-classification-agent.md) | 入库后推荐/挡下 + 分类 |
| [`event-body-agent.md`](event-body-agent.md) | 入库后活动介绍 body |
| [`event-poi-agent-workflow.md`](event-poi-agent-workflow.md) | POI（腾讯 key 有额度时再做） |

## 配置文件

| 文件 | 用途 |
|------|------|
| `data/xhs-city-accounts.json` | 城市 ↔ 小红书账号个人页 URL |
| `data/scrape-cache/xhs/background.jpg` | 无海报活动的文字封面底图 |

## 一键流水线（推荐）

```bash
cd zup-event-crawl

# 多城：抓取 →（若已有 vision-slots）extract → 入库
node scripts/run-xhs-weekly-pipeline.js --city=北京,上海,广州

# Agent 写完 vision-slots 后，续跑 extract + 入库（不重复下载）
node scripts/run-xhs-weekly-pipeline.js --skip-scrape --city=上海

# 仅把已 extract 的笔记重新入库（例如改了封面逻辑）
node scripts/run-xhs-weekly-pipeline.js --import-only
```

### 流水线阶段

| 阶段 | 自动？ | 说明 |
|------|--------|------|
| 1. 抓个人页 + 选汇总帖 + 下图 | ✅ | `scrape-xhs-profile-weekly.js`；同笔记已有 `weekly-summary.json` 则跳过重复下载 |
| 2. Agent 读图写 `vision-slots.json` | ❌ **必须人工/Agent** | 版式每周不同，禁止复制上周 posterBox |
| 3. extract 合并 + 裁海报 | ✅ | 有 `posterBox` 才裁；无则 `poster=null` |
| 4. 合成封面 + 入库 | ✅ | `append-city`，**不删**同城豆瓣活动；**不做 POI** |
| 5. 校正入库时间 | Agent | `export-events-for-time.js` → `time-decisions.json` → `apply-event-time-decisions.js`（见 [`event-time-agent.md`](event-time-agent.md)） |
| 6. 审核台筛选 | 人工 | 来源选「小红书」；状态/类型/日期按来源联动 |
| 7. 分类 / body / POI | Agent 后续 | 与豆瓣同一套 export → decisions → apply |

## 分步命令（调试时用）

```bash
# 单城抓取
node scripts/scrape-xhs-profile-weekly.js --city=北京 "<个人页URL>"

# Agent 写好 vision-slots.json 后
node scripts/extract-xhs-weekly-events.js data/scrape-cache/xhs/北京/<笔记ID>

# 入库审核台
node scripts/import-xhs-events-to-review.js data/review.db --city=北京
```

## 目录约定

```
data/scrape-cache/xhs/<城市>/<笔记ID>/
├── images/*.webp           # slide 原图（Agent 读这些）
├── vision-slots.json       # Agent 填写（无此文件不能 extract/入库）
├── posters/                # 仅有 posterBox 时生成
├── events-extracted.json   # extract 输出
├── events-extracted.md     # 人类可读摘要
└── weekly-summary.json     # 抓取元数据
```

入库后封面：

| 情况 | `image`（展示） | `image_original`（保留） |
|------|-----------------|--------------------------|
| 有裁切海报 | 4:3 左图右文（同豆瓣） | 本地 `posters/*.jpg` |
| 无海报 | 文字封面（标题 + 加入群聊/一起组局） | 本地 `images/*.webp` slide |

## 核心原则

### 抓取

- Chrome **已登录小红书**；系统设置允许 AppleScript 执行 JavaScript
- 个人页 URL 建议带 `xsec_token`（见 `xhs-city-accounts.json`）
- 标题匹配「本周/一周/周末 … 活动汇总/活动合集」
- **不跳过已抓过的同一笔记**（有 `weekly-summary.json` 则只跳过下载，可重跑 extract/入库）

### Agent 读图

- **每张 slide 所有活动都要写**（`01_0`、`01_1`、`01_2`…）
- **只框真实活动海报**；纯文字 slide、装饰小图 → 不写 `posterBox`
- **禁止**固定比例裁切、禁止复制其他笔记/上周的 box

### 入库

- `source=xiaohongshu`，`sourceName=小红书`
- `event_uid` 格式：`xiaohongshu:<笔记ID>:<index>`（如 `01_0`）
- `importPayload` 使用 **`append-city`**（upsert，不删他源活动）
- **默认跳过 POI**；`location_poi_id` 留空，后续按 `event-poi-agent-workflow.md` 批量做
- `category` / `body` 初始为「待分类」/ 空，走分类与 body Agent

### 审核台

- 启动：`npm start` → http://127.0.0.1:8787/
- **来源筛选**选「小红书」后，状态/类型/日期筛选项只统计该来源
- 本地原图通过 `zup-event-crawl.local/scrape/...` 代理展示

## 检查清单（Agent 交付前自检）

- [ ] `weekly-summary.json` 存在，slide 图齐全
- [ ] `vision-slots.json` 每条活动有 `name/time/address/highlights`
- [ ] 有海报的条目 `posterBox` 裁切预览正常（`posters/*.jpg` 无右侧说明文字）
- [ ] 无海报条目未强行裁切
- [ ] `events-extracted.json` 活动数与 slide 一致（上海类文字帖可达 30+ 条）
- [ ] `import-xhs-events-to-review.js` 或流水线 `--import-only` 跑通
- [ ] `apply-event-time-decisions.js` 后入库准备有 `start_at` / `expired_at`
- [ ] 审核台来源「小红书」可见，封面正常

## 禁止事项

- 不要用已删除的启发式/城市专用自动裁切
- 抓取阶段不要做 POI（`--with-poi` 已废弃）
- 不要用 `merge-city` / `replace-city` 入库小红书（会删掉同城豆瓣活动）
- 不要把审核备注写进 `body`

## 代码入口

| 脚本 / 模块 | 职责 |
|-------------|------|
| `scripts/run-xhs-weekly-pipeline.js` | **标准一键入口** |
| `scripts/batch-scrape-xhs-cities.js` | 多城抓取（内部应调流水线） |
| `scripts/scrape-xhs-profile-weekly.js` | 单城抓取 |
| `scripts/extract-xhs-weekly-events.js` | vision → events-extracted |
| `scripts/import-xhs-events-to-review.js` | 入库 + 封面合成 |
| `lib/xhs-weekly-pipeline.js` | 流水线编排 |
| `lib/xhs-review-import.js` | 字段映射、封面、payload |
| `lib/xhs-text-cover-compose.js` | 无海报文字封面 |
| `lib/scrape-local-image.js` | 本地原图 URL |

## 后续（与豆瓣对齐）

```bash
# 分类
node scripts/export-events-for-classification.js --city=上海 --source=xiaohongshu --refresh
# → Agent 写 classification-decisions.json
node scripts/apply-event-classification-decisions.js --city=上海

# 活动介绍
node scripts/export-events-for-body.js --city=上海 --source=xiaohongshu --refresh
# → Agent 写 body-decisions.json
node scripts/apply-event-body-decisions.js --city=上海

# POI（有腾讯 key 额度时）
node scripts/export-events-for-poi.js --city=上海 --source=xiaohongshu --refresh
# → Agent 写 decisions.json
node scripts/apply-event-poi-decisions.js --city=上海
```

（`--source=xiaohongshu` 若导出脚本尚未支持，按 `source` 字段在 workbench 里手动筛。）

# 小红书一周活动 · 抓取到审核台（标准流程）

更新时间：2026-06-12

> **新开会话必读**：以 [`event-crawl-master-workflow.md`](event-crawl-master-workflow.md) + 本文 + `.cursor/rules/xhs-crawl-and-review-import.mdc` 为准，**不依赖聊天上下文**。

## 用户视角（一站式）

**用户只对 Agent 用自然语言提需**（如「处理重庆小红书一周活动」「重跑重庆海报」），不运行脚本、不读本文档。

**Agent 包办**：抓取 → 读图标框 → 裁切验收 → 入库 → 分类 → POI，完成后汇报活动数、海报情况、是否入库。用户提需示例见 [`AGENTS.md`](../AGENTS.md)。

## 一句话（Agent 内部）

Chrome 抓汇总帖 → **读 slide 写 `posterBox`** → extract 裁图 → 总览图验收 → Agent 确认通过后入库 `review.db` → **同会话分类 + POI**。

## 必读子文档

| 文档 | 内容 |
|------|------|
| [`xiaohongshu-weekly-crawl.md`](xiaohongshu-weekly-crawl.md) | 抓取、目录约定、代码模块 |
| [`xiaohongshu-vision-agent.md`](xiaohongshu-vision-agent.md) | Agent 读图、海报识别原则、posterBox 规则（**标框前必读**） |
| [`xiaohongshu-poster-crop-rules.md`](xiaohongshu-poster-crop-rules.md) | **裁切精度定稿**：每场单独分析版式，禁止模板坐标 |
| [`event-classification-agent.md`](event-classification-agent.md) | 入库后推荐/挡下 + 分类 |
| [`event-body-agent.md`](event-body-agent.md) | 入库后活动介绍 body |
| [`event-poi-agent-workflow.md`](event-poi-agent-workflow.md) | POI（腾讯 key 有额度时再做） |

## 配置文件

| 文件 | 用途 |
|------|------|
| `data/xhs-city-accounts.json` | 城市 ↔ 小红书账号个人页 URL |
| `data/scrape-cache/xhs/background1.jpg` … `background6.jpg` | 无海报文字封面底图（每次随机一张） |

## 一键流水线（抓取/入库用）

```bash
cd zup-event-crawl

# 多城：抓取 →（若已有 vision-slots）extract → 入库
node scripts/run-xhs-weekly-pipeline.js --city=北京,上海,广州

# 已验收 vision-slots 后，续跑 extract + 入库（不重复下载）
node scripts/run-xhs-weekly-pipeline.js --skip-scrape --city=上海

# 仅把已 extract 的笔记重新入库（例如改了封面逻辑）
node scripts/run-xhs-weekly-pipeline.js --import-only
```

> 裁切质量没验收前，不要急着跑入库。先用下方分步命令 `extract + create-poster-contact-sheet` 看总览图。

### 流水线阶段

| 阶段 | 自动？ | 说明 |
|------|--------|------|
| 1. 抓个人页 + 选汇总帖 + 下图 | ✅ | 优先本周/下周汇总，其次整月汇总；无合适帖则跳过该城；同笔记已有 `weekly-summary.json` 则跳过重复下载 |
| 2. 读图写 `vision-slots.json` | Agent | 版式因 slide 而异；`posterBox` 是最终裁切区域 |
| 3. extract 合并 + 裁海报 | ✅ | 有 `posterBox` 才裁；**守卫**：须 `vision-slots.meta.json`（含 `labeledAt`），拒绝模板坐标 |
| 4. 裁图验收 | ✅ + Agent | 必须用 `create-poster-contact-sheet.js` 把所有裁图合成一张总览缩略图；有明显坏图最多返工一次 |
| 5. 合成封面 + 入库 | ✅ | `append-city`，**不删**同城豆瓣活动；**不做 POI** |
| 5. 校正入库时间 | Agent | `export-events-for-time.js` → `time-decisions.json` → `apply-event-time-decisions.js`（见 [`event-time-agent.md`](event-time-agent.md)） |
| 6. 审核台筛选 | 用户可选 | 来源选「小红书」；Agent 汇报入库结果，用户自行在审核台浏览 |
| 7. 分类 | Agent **入库后同会话** | 自动导出 `classification-pending.json` → decisions → apply |
| 8. POI | Agent **分类后同会话** | 自动导出 `pending.json` → 定搜词 → poi-search-cli → decisions → apply |
| 9. body | 已入库 | highlights 已写入；存量可用 `apply-xhs-event-bodies.js` |

## Agent 内部执行（用户无需操作）

以下命令由 **Agent 自行运行**，不向用户口述步骤：

```bash
# 单城抓取
node scripts/scrape-xhs-profile-weekly.js --city=北京 "<个人页URL>"

# 标好 vision-slots.json 后
node scripts/preview-poster-boxes.js data/scrape-cache/xhs/北京/<笔记ID>
node scripts/extract-xhs-weekly-events.js data/scrape-cache/xhs/北京/<笔记ID>
node scripts/create-poster-contact-sheet.js data/scrape-cache/xhs/北京/<笔记ID>

# 总览图验收通过后
node scripts/import-xhs-events-to-review.js data/review.db --city=北京
```

## 目录约定

```
data/scrape-cache/xhs/<城市>/<笔记ID>/
├── images/*.webp           # slide 原图（posterBox 坐标以这些为准）
├── _tmp-review-png/        # 可选：同尺寸临时 PNG，Agent 读图用，可保留复盘
├── vision-slots.json       # Agent 填写（无此文件不能 extract/入库）
├── posters/                # 有 posterBox 时 extract 裁出
├── posters-contact-sheet.png  # 总览验收（必看）
├── posters-contact-sheet.png # 海报总览图（低成本验收）
├── events-extracted.json   # extract 输出
├── events-extracted.md     # 人类可读摘要
└── weekly-summary.json     # 抓取元数据
```

入库后封面：

| 情况 | `image`（展示） | `image_original`（保留） |
|------|-----------------|--------------------------|
| 有裁切海报 | 4:3 合成：竖图（≤4:5）左海报 + 右侧**活动标题 + 加入群聊/一起组局**（江城律动圆、白字）；更宽（如 1:1）居中叠底图、无右侧文案 | 本地 `posters/*.jpg` |
| 无海报 | 文字封面（标题 + 加入群聊/一起组局，江城律动圆、深色字，随机 `background1~6.jpg` 底图） | 本地 `images/*.webp` slide |

## 核心原则

### 抓取

- Chrome **已登录小红书**；系统设置允许 AppleScript 执行 JavaScript
- 个人页 URL 建议带 `xsec_token`（见 `xhs-city-accounts.json`）
- 标题匹配「本周/一周/周末 … 活动汇总/活动合集」
- **不跳过已抓过的同一笔记**（有 `weekly-summary.json` 则只跳过下载，可重跑 extract/入库）

### Agent 读图

- **每张 slide 所有活动都要写**（`01_0`、`01_1`、`01_2`…）
- **posterBox 由 Agent 逐张 slide、逐场活动看图填写最终框**；脚本只执行裁切，不猜框
- 如果 `webp` 不能稳定直读，可生成**同尺寸临时 PNG**读图；不要用低清预览量坐标；临时图不用强制删除，可保留复盘
- **是否裁切看版面主视觉**：独立图块、尺寸足够、裁出来能当封面就写 `posterBox`；不要按风景/展品/现场照的内容意义过度苛刻
- 纯文字 slide、装饰小图、太小缩略图、无法干净裁出的图 → 不写 `posterBox`
- **禁止**固定比例裁切、禁止复制其他笔记/上周的 box
- 像素吸附不是默认流程；只在语义正确但边缘差几像素时预览，确认后才 `--write`

### 入库

- `source=xiaohongshu`，`sourceName=小红书`
- `event_uid` 格式：`xiaohongshu:<笔记ID>:<index>`（如 `01_0`）
- `importPayload` 使用 **`append-city`**（upsert，不删他源活动）
- **入库阶段不写 POI**；入库后同会话由 Agent 读 `pending.json` 搜+判（见下节 POI）
- `category` 初始为「待分类」；`body` 直接写入 `events-extracted.json` 的 **`highlights` 介绍**（`body_source=xhs_source`，**不走**豆瓣 body Agent）

### 审核台

- 启动：`npm start` → http://127.0.0.1:8787/
- **来源筛选**选「小红书」后，状态/类型/日期筛选项只统计该来源
- 本地原图通过 `zup-event-crawl.local/scrape/...` 代理展示

## 检查清单（Agent 交付前自检）

- [ ] `weekly-summary.json` 存在，slide 图齐全
- [ ] `vision-slots.json` 每条活动有 `name/time/address/highlights`
- [ ] 已生成 `posters-contact-sheet.png`，所有裁图缩略图无明显坏裁切
- [ ] 如果总览图有明显问题，只返工一次：改 `posterBox` → 重跑 extract → 重跑 contact sheet
- [ ] 无海报条目未强行裁切
- [ ] `events-extracted.json` 活动数与 slide 一致（上海类文字帖可达 30+ 条）
- [ ] `import-xhs-events-to-review.js` 或流水线 `--import-only` 跑通
- [ ] `apply-event-time-decisions.js` 后入库准备有 `start_at` / `expired_at`
- [ ] 同会话已完成 **分类**（`classification-decisions.json` → apply）
- [ ] 同会话已完成 **POI**（`pending.json` → `decisions.json` → apply）
- [ ] 审核台来源「小红书」可见，封面正常

## 禁止事项

- 不要用启发式/城市专用规则自动猜海报位置
- 不要默认跑像素吸附；吸附只能预览修边，确认后才写回
- 抓取/入库阶段不要做 POI；POI 由 Agent 在分类/介绍后按 [`event-poi-agent-workflow.md`](event-poi-agent-workflow.md) 做（禁止 JS 自动选点）
- 不要用 `merge-city` / `replace-city` 入库小红书（会删掉同城豆瓣活动）
- 不要把审核备注写进 `body`

## 代码入口

| 脚本 / 模块 | 职责 |
|-------------|------|
| `scripts/run-xhs-weekly-pipeline.js` | **标准一键入口** |
| `scripts/batch-scrape-xhs-cities.js` | 多城抓取（内部应调流水线） |
| `scripts/scrape-xhs-profile-weekly.js` | 单城抓取 |
| `scripts/extract-xhs-weekly-events.js` | vision → events-extracted |
| `scripts/create-poster-contact-sheet.js` | 生成 `posters-contact-sheet.png` 总览图 |
| `scripts/snap-poster-box-edges.js` | 可选边缘吸附；默认预览，确认后才 `--write` |
| `scripts/import-xhs-events-to-review.js` | 入库 + 封面合成 |
| `lib/xhs-weekly-pipeline.js` | 流水线编排 |
| `lib/xhs-review-import.js` | 字段映射、封面、payload |
| `lib/xhs-text-cover-compose.js` | 无海报文字封面 |
| `lib/scrape-local-image.js` | 本地原图 URL |

## 后续（入库后同会话：分类 + POI）

```bash
# 分类（入库已自动导出 classification-pending.json）
node scripts/apply-event-classification-decisions.js --city=上海 --source=xiaohongshu

# POI（入库已自动导出 pending.json）
node scripts/export-events-for-poi.js --city=上海 --source=xiaohongshu --refresh --pending-only
# → Agent 读每组：cached_poi 或 poi-search-cli → 写 decisions.json
node scripts/apply-event-poi-decisions.js --city=上海 --source=xiaohongshu

# 活动介绍（入库时已写 highlights；存量补写）
node scripts/apply-xhs-event-bodies.js --city=上海
```

禁止 JS 自动批处理 POI。见 [`event-poi-agent-workflow.md`](event-poi-agent-workflow.md)。

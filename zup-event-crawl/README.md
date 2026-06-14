# Zup Event Crawl

从第三方平台抓取数据并在本地审核：**活动**（豆瓣同城）与 **商户**（大众点评）分开展示，互不混表。

本目录位于官网仓库 `BuzzInMap_website/zup-event-crawl/` 内，与根目录静态页、`events/` H5 原型**分文件夹**维护，便于单独扩展抓取能力；与官网共用同一 git 仓库，在 Cursor 侧边栏可直接展开本目录。

## 目录结构

```
zup-event-crawl/
├── README.md
├── package.json
├── scripts/
│   ├── server.js                 # 本地审核 HTTP 服务（API + 静态页）
│   ├── scrape-douban-week-events.js
│   ├── scrape-dianping-merchants.js
│   ├── export-events-for-body.js
│   ├── apply-event-body-decisions.js
│   ├── batch-infer-event-bodies.js  # JS 备选生成 body
│   ├── rebuild-event-bodies.js   # 从 HTML 重算原文/时间（跳过 agent body）
│   ├── enrich-event-participation.js  # 未过期活动：刷新文末参加方式
│   ├── compose-event-images.js   # 未过期活动：合成 4:3 横版封面
│   ├── preview-event-image-compose.js  # 单条活动封面预览
│   ├── preview-merchant-image-compose.js  # 单条商户 16:9 封面预览
│   ├── save-chrome-douban-html.js
│   └── migrate-json-to-db.js
├── lib/
│   ├── review-db.js              # 活动 SQLite
│   ├── merchant-db.js            # 商户 SQLite
│   ├── douban-html.js            # 豆瓣详情 HTML 解析（edesc / 活动须知）
│   ├── douban-detail.js          # 正文提炼、makeZupIntro（JS 备选）
│   ├── event-body-agent.js       # body Agent 流程常量与校验
│   ├── event-participation.js    # 参加方式段落（公众号 / 票务 / 发起人）
│   ├── event-image-compose.js    # 4:3 封面合成（sharp）
│   ├── composed-image.js         # 合成图路径与 URL 约定
│   ├── event-import-ready.js     # 活动入库字段 / now_type 默认
│   ├── tencent-poi.js            # 腾讯 POI API（供 poi-search-cli；活动 match 由 Agent 判）
│   ├── buzz-now-import.js        # Buzz 活动气泡客户端
│   ├── buzz-merchant-import.js   # Buzz 商户入库
│   ├── merchant-bubble.js        # 商户气泡三分组轮转发布
│   ├── tencent-im-group.js       # 腾讯 IM 建群 / 改名
│   └── dianping-parse.js
├── public/
│   ├── index.html                # 活动审核
│   ├── merchants.html            # 商户审核
│   └── merchant-bubbles.html     # 已入库商户批量建群 + 发气泡
├── data/
│   ├── review.db                 # 主存储（默认 gitignore）
│   ├── image-cache/              # 图片代理缓存
│   ├── image-composed/           # 活动合成封面（gitignore）
│   ├── scrape-cache/             # 浏览器备路 HTML
│   ├── crawled-events.json       # 历史 JSON 备份 / 迁移源
│   └── review-decisions.json
└── docs/
    └── HANDOFF.md                # 完整交接文档（唯一维护副本，AI 新会话优先读）
```

## 环境要求

- Node.js **18+**（使用内置 `node:sqlite`）
- npm 依赖：`sharp`（活动封面合成）

## 快速开始

```bash
cd zup-event-crawl
npm start
# 或: node scripts/server.js 8787
```

浏览器打开：

- http://127.0.0.1:8787/ （活动审核）
- http://127.0.0.1:8787/merchants.html （商户审核）
- http://127.0.0.1:8787/merchant-bubbles.html （商户气泡批量发布）

**改 `lib/` 或 `scripts/server.js` 后请重启 `npm start`**，否则 API 仍跑旧代码。

## 抓取大众点评商户（一站式）

前提：本机 **Google Chrome 已登录大众点评**（只需一次）；若曾用豆瓣备路，需已开启「允许 AppleScript 中的 JavaScript」。

```bash
npm run scrape-merchants -- --city=上海 --keyword=跳海
```

默认**仅列表页**：店名、列表封面图、商圈、点评链接（不打开详情，避免反爬）。结果写入 `data/review.db`，在商户审核页查看。

离线备路（手存 HTML）仍可用 `--offline --html-dir=...`。

## 抓取豆瓣活动

前提：本机 **Google Chrome 已登录豆瓣**（与大众点评相同，需开启「允许 AppleScript 中的 JavaScript」）。

```bash
# 成都 30 条，增量入库（不删已有、不重复抓）
node scripts/scrape-douban-week-events.js 30 data/review.db --city=chengdu --mode=append-city

# 北京 / 上海 / 广州，最多 10 页列表
node scripts/scrape-douban-week-events.js 500 data/review.db --city=beijing --mode=append-city --max-pages=10
```

默认通过 **Chrome**（`lib/douban-chrome-fetch.js`）抓取，避免命令行 `fetch` 被豆瓣 403/429。若需旧主路可加 `--via-fetch`。

遇到豆瓣风控（列表/详情无法访问、403/429、登录墙、验证码等）会**立即暂停**当前城市；批量脚本 `batch-scrape-douban-cities.js` 也会停止后续城市，并提示 `--skip-city=` 续跑。

离线备路：先 `node scripts/fetch-douban-via-chrome.js --city=北京 --max-pages=10`，再 `--list-dir` / `--detail-dir` 跑同一抓取脚本。

抓取入库时会自动合成 **4:3 横版封面**（模糊底图 + 原图 + 右侧文案），`image_original` 保留豆瓣原图。跳过时加 `--skip-compose`；补跑历史数据：`node scripts/compose-event-images.js --city=北京`。

## 抓取小红书一周活动汇总

**标准流程文档**：[`docs/xiaohongshu-review-workflow.md`](docs/xiaohongshu-review-workflow.md)（含检查清单，不依赖聊天记忆）  
**Cursor 规则**：`.cursor/rules/xhs-crawl-and-review-import.mdc`  
**账号清单**：`data/xhs-city-accounts.json`

前提：Chrome **已登录小红书**（与豆瓣共用 AppleScript 抓取窗口）。

```bash
# 一键：抓取 →（有 vision-slots 时）extract → 入库
node scripts/run-xhs-weekly-pipeline.js --city=北京,上海,广州

# Agent 写完 vision-slots.json 后续跑（不重复下载）
node scripts/run-xhs-weekly-pipeline.js --skip-scrape --city=上海
```

输出在 `data/scrape-cache/xhs/<城市>/<笔记ID>/`。Agent 读图规则见 [`docs/xiaohongshu-vision-agent.md`](docs/xiaohongshu-vision-agent.md)、裁切精度见 [`docs/xiaohongshu-poster-crop-rules.md`](docs/xiaohongshu-poster-crop-rules.md)。入库 `source=xiaohongshu`，`append-city` 不覆盖同城豆瓣；有海报 → 4:3 封面，无海报 → 文字封面；POI 后续再做。

海报裁切由**强视觉模型逐张 slide、逐场活动标 `posterBox`**（版式因笔记而异，禁止套模板坐标），然后跑 `extract-xhs-weekly-events.js` 和 `create-poster-contact-sheet.js` 看总览。标框自检：`node scripts/preview-poster-boxes.js <笔记目录>`。`snap-poster-box-edges.js` 是可选修边工具，默认仅预览，确认后才加 `--write` 写回。

**Agent 全流程（新会话必读，不依赖聊天记忆）**：

- **总览**：[`docs/event-crawl-master-workflow.md`](docs/event-crawl-master-workflow.md)（豆瓣 + 小红书步骤、JS/Agent 分工、检查清单）
- **入口**：[`AGENTS.md`](AGENTS.md)（复制粘贴开场白）
- 豆瓣规则：[`.cursor/rules/douban-crawl-and-agent-poi.mdc`](.cursor/rules/douban-crawl-and-agent-poi.mdc)
- 小红书规则：[`.cursor/rules/xhs-crawl-and-review-import.mdc`](.cursor/rules/xhs-crawl-and-review-import.mdc)

分类 / body / POI 子文档：[`event-classification-agent.md`](docs/event-classification-agent.md)、[`event-body-agent.md`](docs/event-body-agent.md)、[`event-poi-agent-workflow.md`](docs/event-poi-agent-workflow.md)。活动地址映射库见 POI 文档（仅活动，商户不走）。

对我说「抓取成都豆瓣活动」或「抓取上海小红书活动」→ Agent 按 master-workflow 一条龙执行。豆瓣机械准备：`node scripts/prepare-city-poi-for-agent.js --city=成都`。小红书：`node scripts/run-xhs-weekly-pipeline.js --city=上海`（入库后自动导出分类 + POI pending）。

城市列表 URL 说明（成都为 `www.douban.com/location/...`，见 `docs/HANDOFF.md`）。

### 正文与参加方式（批量回填）

抓取时会生成 `body`（活动介绍 + 文末参加方式）。规则调整后，对**未过期**活动可批量重算：

```bash
# 从 raw_detail_html 重算 raw_detail_text + body（推荐）
node scripts/rebuild-event-bodies.js
node scripts/rebuild-event-bodies.js --dry-run

# 仅刷新文末参加方式段落
node scripts/enrich-event-participation.js
```

写作规则、公众号/发起人/票务优先级见 [`docs/HANDOFF.md`](docs/HANDOFF.md)「2026-06-08 活动正文与报名方式提炼」。

### 活动封面合成（4:3 横版）

竖图低清海报（≤4:5）合成：**模糊底图 + 左侧原图 + 右侧活动标题 +「加入群聊 / 一起组局」**（江城律动圆；有海报时白字，无海报文字封面时深色字 + 随机底图）。宽图（>4:5）仅居中叠海报。原图 URL 备份在 `image_original`。

```bash
# 预览单条（从 review.db 读原图）
node scripts/preview-event-image-compose.js --title=主动社交的力量 --city=成都

# 预览本地海报文件
node scripts/preview-event-image-compose.js --poster=data/scrape-cache/xhs/.../posters/01_slot0.jpg --title=活动标题

# 商户 16:9 封面预览（模糊底图 + 原图居中不缩放）
node scripts/preview-merchant-image-compose.js --name=GoodFriend好朋友精酿

# 把库里美团 @340w 缩略图 URL 批量换成原图（抓取已自动换大图）
node scripts/upgrade-merchant-image-urls.js
node scripts/upgrade-merchant-image-urls.js --dry-run

# 批量（仅未过期活动）
node scripts/compose-event-images.js
node scripts/compose-event-images.js --dry-run

# 批量（已通过商户 → 16:9 封面，写入 image，原图备份 image_original，入库用合成图）
node scripts/compose-merchant-images.js
node scripts/compose-merchant-images.js --dry-run
node scripts/compose-merchant-images.js --force --concurrency=5
```

版式与字段说明见 [`docs/HANDOFF.md`](docs/HANDOFF.md)「2026-06-08 活动封面合成」。

### 备路：Chrome 保存 HTML

```bash
node scripts/save-chrome-douban-html.js --match=douban.com --out=data/scrape-cache/成都/list/01.html

node scripts/scrape-douban-week-events.js 30 data/review.db \
  --city=chengdu --mode=merge-city \
  --list-dir=data/scrape-cache/成都/list \
  --detail-dir=data/scrape-cache/成都/detail
```

## API（本地）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/events` | 活动列表与元数据（不含 `rawDetailHtml`，约 5MB） |
| GET | `/api/events/:uid/detail` | 单条活动原文 `rawDetailText` / `rawDetailHtml`（按需） |
| GET | `/api/review-state` | 审核状态 |
| POST | `/api/review-state` | 保存审核状态 |
| GET | `/api/approved-events` | 已通过活动 |
| GET | `/api/merchants` | 商户列表 |
| GET | `/api/merchant-review-state` | 商户审核状态 |
| POST | `/api/merchant-review-state` | 保存商户审核 |
| GET | `/api/approved-merchants` | 已通过商户 |
| GET | `/api/image?src=...` | 图片代理与缓存 |
| GET | `/api/export-import-nows` | 导出可入库气泡 JSON |
| POST | `/api/events/:uid/import` | 单条活动写入 Buzz 后台 |
| DELETE | `/api/events/:uid/buzz-now` | 从 Buzz 后台软删已入库气泡 |
| POST | `/api/events/import-batch` | 批量入库（已通过且未入库） |
| POST | `/api/events/sync-merchants` | 按 POI 补全关联商户信息 |
| POST | `/api/events/import-prep-batch` | 批量写入默认发布者 / now_type（默认 `skip_poi: true`） |
| POST | `/api/merchants/:uid/import` | 单条商户写入 Buzz |
| POST | `/api/merchants/import-batch` | 批量商户入库 |
| GET | `/api/merchant-bubbles/state` | 商户气泡轮转状态 |
| POST | `/api/merchant-bubbles/groups-batch` | 批量建群或同步群名 |
| POST | `/api/merchant-bubbles/publish-batch` | 发布当前轮次 1/3 商户气泡 |

### 活动审核台入库

- 选中 POI 后查询关联商户；**入库 / 批量入库** 写入 Buzz 测试环境。
- `now_type`：1 动态 / 2 即刻邀约 / 3 预约；未开始默认 3，已开始默认 2。
- **批量补全入库**只改发布者与 `now_type`，不自动搜 POI。
- 入库时以卡片 `publish_user_id` 为 IM 群主；活动群名语义截断 ≤20 字。
- 封面从 `data/image-cache/` 上传 Buzz，不用第三方 URL 直链。

### 商户审核台入库

- **入库 / 批量入库**：`name` = 腾讯 POI 名，`name_new` = 审核台卡片商户名；`medias` 按 Zup 后台要求处理。

### 商户气泡（`merchant-bubbles.html`）

前提：商户已在商户审核页 **入库 Buzz**。

1. **批量创建商户群聊**：无群新建，有群则 IM 接口改名（群名 = 完整店名）
2. 配置文案（统一 or 按店名）、群聊模式、发布者、`now_type`
3. **发布本批气泡**：每城市随机三分组，每次只发 1/3，过期 **3 天**

详见 [`docs/HANDOFF.md`](docs/HANDOFF.md) 顶部「2026-06-08 更新摘要」。

环境变量（可选，本地已内置测试环境默认值）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `BUZZ_API_BASE` | `https://test-go-api.nowmap.cn` | Buzz 后端地址 |
| `BUZZ_ADMIN_USER` | `admin` | 测试环境后台账号 |
| `BUZZ_ADMIN_PASS` | `Test1234` | 测试环境后台密码 |
| `BUZZ_TOKEN` | — | 有 token 时优先用，跳过登录 |

## 与官网其他目录的关系

- **官网根目录 / `events/`**：对外 H5、产品原型页。
- **本目录 `zup-event-crawl/`**：抓取、清洗、SQLite、`review.db`、本地审核 UI。
- **业务规则、抓取禁忌、事故记录、body 写作规范**：见 [`docs/HANDOFF.md`](docs/HANDOFF.md)。

## 后续扩展建议

- `sources/`：按来源拆分适配器（豆瓣 / 活动行 / 小红书…）
- `jobs/`：定时抓取或导出任务
- `exports/`：审核通过结果导出给 App 或运营

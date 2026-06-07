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
│   ├── save-chrome-douban-html.js
│   └── migrate-json-to-db.js
├── lib/
│   ├── review-db.js              # 活动 SQLite
│   ├── merchant-db.js            # 商户 SQLite
│   └── dianping-parse.js
├── public/
│   ├── index.html                # 活动审核
│   └── merchants.html            # 商户审核
├── data/
│   ├── review.db                 # 主存储（默认 gitignore）
│   ├── image-cache/              # 图片代理缓存
│   ├── scrape-cache/             # 浏览器备路 HTML
│   ├── crawled-events.json       # 历史 JSON 备份 / 迁移源
│   └── review-decisions.json
└── docs/
    └── HANDOFF.md                # 完整交接文档（唯一维护副本，AI 新会话优先读）
```

## 环境要求

- Node.js **18+**（使用内置 `node:sqlite`）
- 无额外 npm 依赖

## 快速开始

```bash
cd zup-event-crawl
npm start
# 或: node scripts/server.js 8787
```

浏览器打开：

- http://127.0.0.1:8787/ （活动审核）
- http://127.0.0.1:8787/merchants.html （商户审核）

## 抓取大众点评商户（一站式）

前提：本机 **Google Chrome 已登录大众点评**（只需一次）；若曾用豆瓣备路，需已开启「允许 AppleScript 中的 JavaScript」。

```bash
npm run scrape-merchants -- --city=上海 --keyword=跳海
```

默认**仅列表页**：店名、列表封面图、商圈、点评链接（不打开详情，避免反爬）。结果写入 `data/review.db`，在商户审核页查看。

离线备路（手存 HTML）仍可用 `--offline --html-dir=...`。

## 抓取豆瓣活动

```bash
# 成都 30 条，合并入库（不覆盖其他城市）
node scripts/scrape-douban-week-events.js 30 data/review.db --city=chengdu --mode=merge-city

# 北京 / 上海 / 广州
node scripts/scrape-douban-week-events.js 30 data/review.db --city=beijing --mode=merge-city
```

城市列表 URL 说明（成都为 `www.douban.com/location/...`，见 `docs/HANDOFF.md`）。

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
| GET | `/api/events` | 活动列表与元数据 |
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

### 审核台入库

- 选中 POI 后立即查询关联商户，显示在卡片「入库准备」区域。
- 每条已通过活动可点 **入库**；页头 **批量入库** 可一次处理全部待入库项。入库时会以发布者 `user_id` 为群主自动建腾讯 IM 群，并把 `group_id` 挂到气泡上。
- 封面图从本地 `data/image-cache/` 读取，经 `POST /internal/upload` 上传到 Buzz OSS 后再建气泡（**不把豆瓣/点评 URL 写入后台**）。抓取详情时会自动缓存封面；入库时若本地无缓存会补拉一次。
- 入库成功后在卡片显示 `now_id`；无需再手动执行 Go 脚本（仍保留「导出 JSON」作备份）。

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

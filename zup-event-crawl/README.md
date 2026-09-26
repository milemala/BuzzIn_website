# Zup Event Crawl

从第三方平台抓取数据并在本地审核：**活动**（豆瓣同城）与 **商户**（大众点评）分开展示，互不混表。

本目录位于官网仓库 `BuzzInMap_website/zup-event-crawl/` 内，与根目录静态页、`events/` H5 原型**分文件夹**维护，便于单独扩展抓取能力；与官网共用同一 git 仓库，在 Cursor 侧边栏可直接展开本目录。

**术语**：**入库** = 抓取结果写入本地 `review.db`（审核台）；**推送 Zup** = 审核台里已通过的内容同步到 Buzz 线上后台（审核页顶部按钮，勿称「入库」）。

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
│   ├── merchant-bubble.js        # 商户气泡勾选发布
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
# 或: node scripts/server.js 8790
```

也可在仓库根目录执行 `npm start`：会同时启动本审核台（8790）与官网 AI 建档代理（8788）。只开审核台用根目录 `npm run start:review`。

浏览器打开：

- http://127.0.0.1:8790/ （活动审核）
- http://127.0.0.1:8790/merchants.html （商户审核）
- http://127.0.0.1:8790/merchant-bubbles.html （商户气泡批量发布）
- http://127.0.0.1:8790/bubble-group-activity.html （气泡群聊参与统计）

默认端口是 **8790**（8787 常被本机 MasterGo 占用）。默认只监听本机。放到云服务器时仍保持这样，用加密通道打开页面，步骤见 [`deploy/README.md`](deploy/README.md)。

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

国学、易经、《庄子》《论语》等传统经典讲读活动也会在入库时直接丢掉。

不适合结伴的类型在入库时直接丢掉，不进审核台，也不补列表名额：体验课、学习课、园游会、旅游/文旅、音乐剧、舞台剧、儿童剧、悬疑剧、话剧、交响、歌舞/舞剧、歌剧、相声、魔术、魔法演出，以及艺术展、作品展、博物馆文物展、大赛、系统课、景区或展馆的门票和套票。标题没写「艺术展」、正文是去看作品或文物的，也会丢掉。演唱会、音乐节、脱口秀、开放麦、Live、快闪、市集、漫展会留下。音乐会、喜剧节、单口喜剧、即兴喜剧、VR、XR、沉浸体验馆和沉浸剧、文化节、光影节、只有分会场名字的标题、逛公园会丢掉。啤酒、咖啡、清酒、动漫、音乐文化节会留下。规则在 `lib/event-low-social-filter.js`，豆瓣和小红书共用。

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

输出在 `data/scrape-cache/xhs/<城市>/<笔记ID>/`。第一次抓取就必须按交付质量切图：Agent 逐张读原图确认坐标系，逐场找独立矩形主视觉，四边贴海报本体，重点量准下行 `y` 和右栏 `x`；边界不清楚宁可走文字封面。`extract` 后必须直接抽查 `posters/*.jpg` 成品图，坏图回原图返修并重新 `extract`，抽查通过后才入库；有海报 → 4:3 封面，无海报 → 文字封面。用户反馈切坏时，先清旧 `posterBox`，不要在坏坐标上局部修补。

**一站式**：对 Agent 说「抓取成都豆瓣活动」或「处理上海小红书一周活动」即可，用户不跑脚本。

## 抓取摩天轮

来源键 `motianlun`，审核台显示「摩天轮」。用户说抓摩天轮、没点名只要某一类时，**演唱会和 Livehouse 一起抓**。演出日期落在从今天起的 30 天内（含今天）。城市默认是审核台已有城市，再加上大连。用户明确说「只要演唱会」或「只要 Livehouse」时，只抓那一类。

```bash
node scripts/scrape-motianlun-concerts.js
node scripts/scrape-motianlun-concerts.js --category=concert
node scripts/scrape-motianlun-concerts.js --category=livehouse
node scripts/scrape-motianlun-concerts.js --city=上海,大连 --days=30
```

入库 `source=motianlun`、`append-city`。同一城市的两类放进同一次写入。海报会合成 4:3 封面。标题里是音乐会、话剧等现有规则要丢掉的场次不会进审核台。和豆瓣/小红书**标题+地点完全相同**的未过期活动会跳过，避免盖掉已有记录。审核台后续文件放在 `data/poi-agent-workbench/<城市>-mtl/`。

对我说「抓取摩天轮一个月内的活动」即可，两类都会抓。

Agent 内部文档：

- **总览**：[`docs/event-crawl-master-workflow.md`](docs/event-crawl-master-workflow.md)
- **用户怎么说**：[`AGENTS.md`](AGENTS.md)
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
| POST | `/api/events/:uid/now-status` | 将已推送活动设为屏蔽（`now_status=-1`）或启用（`now_status=1`） |
| DELETE | `/api/events/:uid/buzz-now` | 从 Buzz 后台软删已入库气泡 |
| POST | `/api/events/import-batch` | 批量入库（已通过且未入库） |
| POST | `/api/events/sync-merchants` | 按 POI 补全关联商户信息 |
| POST | `/api/events/import-prep-batch` | 批量写入默认发布者 / now_type（默认 `skip_poi: true`） |
| POST | `/api/merchants/:uid/image` | 用图片 URL 生成 16:9 模糊背景封面并替换审核台图片 |
| POST | `/api/merchants/:uid/map-image` | 用商户坐标生成腾讯地图定位封面并替换审核台图片 |
| POST | `/api/merchants/:uid/import` | 单条商户写入 Buzz |
| POST | `/api/merchants/import-batch` | 批量商户入库 |
| POST | `/api/merchants/sync-from-buzz` | 从 Buzz 后台拉取商户补全审核台（同 POI 冲突删本地旧记录） |
| GET | `/api/merchant-bubbles/state` | 已入库商户 / 管理员 / 群聊 / 未过期气泡统计 + 已选名单 |
| GET | `/api/merchant-bubbles/merchants` | 已入库商户列表（可筛酒馆；含是否已有管理员 / 未过期气泡） |
| POST | `/api/merchant-bubbles/active-bubble` | 删除或设为过期某店当前未过期气泡 |
| POST | `/api/merchant-bubbles/roster` | 保存已选商户名单（含启用/停用） |
| POST | `/api/merchant-bubbles/title-pool` | 按商户类型保存文案池（每种类型 10 组标题+正文） |
| POST | `/api/merchant-bubbles/admins-batch` | 为已选的店创建/沿用管理员并绑到该店 |
| POST | `/api/merchant-bubbles/groups-batch` | 为勾选的店建群或同步群名 |
| POST | `/api/merchant-bubbles/publish-batch` | 为已启用的店发布气泡 |
| GET/POST | `/api/bubble-group-activity` | 未过期气泡群聊进群/发言统计（`date_from` / `date_to`，按天） |

### 活动审核台入库

- 选中 POI 后查询关联商户；**入库 / 批量入库** 写入 Buzz 测试环境。
- `now_type`：1 动态 / 2 即刻邀约 / 3 预约；未开始默认 3，已开始默认 2。
- **批量补全入库**只改发布者与 `now_type`，不自动搜 POI。
- 入库时以卡片 `publish_user_id` 为 IM 群主；活动群名语义截断 ≤20 字。
- 封面从 `data/image-cache/` 上传 Buzz，不用第三方 URL 直链。
- **已推送活动屏蔽 / 启用**：活动审核页城市筛选下方有「已推送到 App」栏。可一键屏蔽或启用当前环境里全部未过期已推送活动，也可按城市单独操作。屏蔽后 App 地图上看不到（`now_status=-1`），审核台记录还在；启用后重新显示（`now_status=1`）。过期活动本来就不会出现在地图上，不在此栏里。

### 商户审核台入库

- **入库 / 批量入库**：`name` = 腾讯 POI 名，`name_new` = 审核台卡片商户名；`medias` 按 Zup 后台要求处理。
- **替换封面**：在商户卡片封面下粘贴图片 URL，点击「处理并替换封面」；系统先生成“模糊背景 + 原图完整居中”的 1280×720 封面，再替换审核台图片。已推送商户只更新审核台，不会自动修改后台已有图片。
- **地图兜底封面**：点击「换成腾讯地图封面」，系统按商户现有坐标生成带 Zup 定位标记和商户名的地图图，再用相同规则生成 1280×720 封面。缺坐标时需先匹配 POI；已推送商户仍只更新审核台。
- **热门地标**：`source=city_hotspot`，审核台显示为「热门地标」。表格批量导入时必须先在审核台人工处理，再由用户手动推送；商户名使用腾讯 POI 名，不使用表格中的展示名。封面优先使用可靠的地点图片，缺图时使用带名称与定位标记的腾讯地图封面。
- **缺 POI 地标**：腾讯地图没有可靠整体主体 POI 时仍保留在审核台，卡片标记为「缺 POI」并禁止直接推送；可使用自由搜索或候选列表人工选点后再处理。

### 商户气泡（`merchant-bubbles.html`）

前提：商户已在商户审核页 **入库 Buzz**，或通过 **从当前环境补全商户** 从正式后台拉回。

约酒代发（主路径）：

1. **选店**：一个列表里勾选。筛选顺序是来源、已选/已启用、城市、类型。点「已选」或「已启用」后，下面的城市和类型只统计这批店，用来看它们分布在哪些城市、分别是什么类型。「启用当前筛选」「停用当前筛选」只改当前筛选结果里已经选中的店，不会动筛选之外的已选店。发布只发给已启用、且当前没有未过期气泡的店（是否过期以后台 `expired_at` 为准）。已有未过期气泡的店可在列表里删除或设为过期。管理员列显示后台已绑定的店长/管理员昵称
2. **发布身份**：统一账号（所有店用同一个 user_id），或各店管理员（每家店用自己的账号）
3. 若选「各店管理员」：先点「为已选的店创建管理员」。已经有管理员的店不会进入进度，也不会改资料；只给还没有管理员的店按页面上填的昵称、头像、性别、年龄、签名新建，并绑成店长。公园和其他类型的新建昵称固定为「神秘小刘」
4. **标题和正文**：每种商户类型各自 10 组文案，默认都是空的，需要自己填写。发布某家店时只用该类型的文案，按顺序轮流，用完再从头。类型以当前环境的商户类型编号为准，不会因为分类说明里出现「咖啡」「酒吧」就改用别的类型的文案。没填文案的类型这次不会发布
5. **配置**：`now_type`、`content_type`、开始时间、过期时间（均可空；过期不填则不传，由 Zup 后台按既有规则处理）
6. **为已启用的店发布**（已有未过期气泡的店不进入进度，不会逐家再查一遍。选「挂商户群聊」时，没群的店会自动建群；已有群会把群主交给这次的发布账号，并把原来的群主踢出群）。封面与上次相同时直接沿用后台已有图，不重新上传；群主已经是这次的发布账号则跳过移交。店与店之间默认只歇 0.2 秒。发布弹窗可随时点「停止」，处理完当前这家后结束。创建时带 `enroll_hidden = 1`，即刻邀约和预约也不显示报名签到入口，与活动审核台一致

每天定点重复发布需要审核台一直开着。放到阿里云轻量服务器的步骤在 [`deploy/README.md`](deploy/README.md)。部署之后，名单和文案以云上那份数据库为准。

CLI：`node scripts/sync-merchants-from-buzz.js --env=prod [--dry-run]`

详见 [`docs/HANDOFF.md`](docs/HANDOFF.md) 顶部「2026-06-08 更新摘要」。

### 测试 / 正式双环境（顶栏切换）

审核台三页顶栏有 **推送环境** 下拉：`测试` / `正式`。抓取与人工审核只做一遍；推送到哪个环境由切换器决定，各环境独立记录 `now_id` / `merchant_id`（存 `buzz_imports` 表）。

| 环境 | API | 默认发布者 user_id |
|------|-----|-------------------|
| 测试 | `https://test-go-api.nowmap.cn` | `604590505` |
| 正式 | `https://zup.nowmap.cn` | `604590505` |

切到 **正式** 时顶栏变红，推送前会二次确认。商户类型按目标环境实时拉取（正式库 id 与测试不同，入库时按类型名称映射）。

环境变量（可选；未设置时用代码内默认值，含正式凭据）：

| 变量 | 说明 |
|------|------|
| `BUZZ_API_BASE_TEST` / `BUZZ_API_BASE` | 测试 API |
| `BUZZ_ADMIN_USER_TEST` / `BUZZ_ADMIN_USER` | 测试账号 |
| `BUZZ_ADMIN_PASS_TEST` / `BUZZ_ADMIN_PASS` | 测试密码 |
| `BUZZ_TOKEN_TEST` / `BUZZ_TOKEN` | 测试 token（有则跳过登录） |
| `BUZZ_PUBLISH_USER_ID_TEST` | 测试发布者（默认 `604590505`） |
| `BUZZ_API_BASE_PROD` | 正式 API（默认 `https://zup.nowmap.cn`） |
| `BUZZ_ADMIN_USER_PROD` | 正式账号 |
| `BUZZ_ADMIN_PASS_PROD` | 正式密码 |
| `BUZZ_TOKEN_PROD` | 正式 token |
| `BUZZ_PUBLISH_USER_ID_PROD` | 正式发布者（默认 `604590505`） |

详见 [`docs/import/changeLogToProduct.md`](docs/import/changeLogToProduct.md)。

## 与官网其他目录的关系

- **官网根目录 / `events/`**：对外 H5、产品原型页。
- **本目录 `zup-event-crawl/`**：抓取、清洗、SQLite、`review.db`、本地审核 UI。
- **业务规则、抓取禁忌、事故记录、body 写作规范**：见 [`docs/HANDOFF.md`](docs/HANDOFF.md)。

## 后续扩展建议

- `sources/`：按来源拆分适配器（豆瓣 / 活动行 / 小红书…）
- `jobs/`：定时抓取或导出任务
- `exports/`：审核通过结果导出给 App 或运营

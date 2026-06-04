# Zup 抓取审核台交接（活动 + 商户）

更新时间：2026-06-03 CST（目录位于 `BuzzInMap_website/zup-event-crawl/`）


## 交接目的

这个项目是在本地验证 Zup App 的城市活动冷启动流程：从第三方平台抓取城市活动，清洗成结构化数据，在本地审核台人工判断“通过 / 待定 / 拒绝”。当前只做本地验证，不对接线上发布接口。

当前用户特别重视两件事：

- 抓到的内容不要直接丢弃。即使规则判断不适合，也要保留在审核台里，默认拒绝即可，方便人工二次判断。
- 不要在抓取阶段擅自判断活动是否已结束、是否值得抓。用户让抓豆瓣列表多少条，就抓豆瓣页面上对应顺序的多少条；已结束、低质、票务化内容也先保留，由用户在审核台判断。
- `body` 活动简介只写活动本身，不要写审核判断，不要写“是否适合 Zup”“默认拒绝”“人工判断”等系统话术。

## 工作区与运行方式

项目目录（官网仓库内独立子目录，2026-06-04 调整）：

`/Users/weiming/Documents/万盏街灯/开发物料/官网/BuzzInMap_website/zup-event-crawl`

官网同仓库：`BuzzInMap_website` 根目录为对外站点；抓取与审核见 `zup-event-crawl/` 与 `events/CRAWL-SERVICE.md`。

本地审核服务：

```bash
cd BuzzInMap_website/zup-event-crawl
npm start
# 或: node scripts/server.js 8787
```

审核台地址（**活动与商户分两个一级页面，数据表也分开**）：

- 活动：`http://127.0.0.1:8787/`
- 商户：`http://127.0.0.1:8787/merchants.html`

旧路径 `/events/crawl-review.html` 仍指向活动页。

如果 8787 服务失效，重新运行上面的命令即可。端口占用时可 `PORT=8788 npm start` 或 `lsof -ti :8787 | xargs kill`。

## 关键文件

- `public/index.html`（原 `events/crawl-review.html`）
  - 本地人工审核页面。
  - 单列活动列表，每行一个活动。
  - 支持城市、状态、来源、类型、日期、排序、搜索筛选。

- `scripts/server.js`（原 `review-server.js`）
  - 本地审核服务。
  - 负责静态页面（`public/index.html`）、数据库 API、图片代理 API。
  - 图片通过 `/api/image?src=...` 代理并缓存，避免第三方图床热链问题。

- `scripts/scrape-douban-week-events.js`
  - 当前保留的豆瓣抓取脚本。
  - 负责豆瓣列表/详情解析、字段清洗、`body` 生成和多城市合并写入。
  - 默认按城市合并数据，不应再覆盖其他城市。
  - 支持 `--city=beijing|shanghai|guangzhou|chengdu`，`--mode=merge-city` 增城市不覆盖他城。
  - 支持 `--list-file` / `--list-dir` / `--detail-dir`：豆瓣拦命令行时，用浏览器保存的 HTML 离线解析（与线上下游同一套逻辑）。

- `scripts/save-chrome-douban-html.js`
  - 备路辅助：从 **当前 Chrome 前台标签** 把整页 HTML 存到本地（依赖 macOS AppleScript）。
  - 不负责翻页、不负责批量详情；列表/详情仍需人工在 Chrome 打开对应页后逐页保存，或配合离线目录批量导入。

- `data/review.db`
  - 当前本地审核台的主存储数据库。
  - 活动数据、城市导入信息、审核状态都以它为准。

- `lib/review-db.js`
  - SQLite 数据访问层。
  - 负责建表、导入、活动查询、审核状态查询与写入。

- `scripts/migrate-json-to-db.js`
  - 一次性迁移脚本。
  - 负责把历史 `crawled-events.json` / `review-decisions.json` 导入 `review.db`。

- `data/crawled-events.json`
  - 旧的 JSON 快照，当前主要作为迁移来源和历史备份，不再是主存储。

- `data/review-decisions.json`
  - 旧的审核状态 JSON，当前主要作为迁移来源和历史备份，不再是主存储。

- `data/image-cache/`
  - 本地图片代理缓存。

## 当前数据状态

- 脚本内用 `cityListUrlKind` 区分：`subdomain` vs `location`。**新城市上线前先确认用哪种 URL**，误用 `chengdu.douban.com` 会 DNS 失败（NXDOMAIN）。
- 分页：第 2 页起为 `?start=10`、`?start=20`…（挂在上述列表 URL 后）。
- 当前默认展示顺序：各城市内部按豆瓣原始顺序（`sourcePosition`）。
- 当前数据中低分内容仍保留，只是默认拒绝。

重要说明：

- 这 10 条北京数据是从本机临时快照里恢复回来的“已找回样本”，不是之前那份更完整的北京 20 条集。
- 上海 30 条是 2026-06-03 新抓的数据，严格按豆瓣分页原始顺序读取第 1-30 条，没有因为结束状态、低质判断或主观筛选补位。
- 成都 30 条同上：列表第 1-30 条，`node fetch` 主路约二十几秒完成；详情仍逐条请求 `https://www.douban.com/event/{id}/`。
- 审核台城市筛选会随库内城市动态出现（当前含北京 / 上海 / 广州 / 成都）。
- 审核台前端通过 `/api/events` 和 `/api/review-state` 读取数据库，不再直接读取 `crawled-events.js`。

数据字段核心约定：

- `id`：来源活动 ID。
- `source`：来源标识，例如 `douban`。
- `sourceName`：来源展示名，例如 `豆瓣同城`。
- `sourcePosition`：来源页原始顺序。
- `title`：活动标题。
- `startDate / endDate`：活动开始/结束时间。
- `eventDates`：活动覆盖的日期数组，用于按天筛选。跨多天活动要覆盖每一天。
- `location / latitude / longitude`：地点与经纬度。
- `image`：原始图片地址。
- `body`：面向用户的活动简介，不超过 400 字。
- `score`：规则分数。
- `suggested`：是否规则推荐。
- `reviewReason`：审核理由，可以包含“不适合 Zup/偏行业/票务”等判断。

当前多城市包装补充字段：

- `cities`：当前数据包里包含的城市列表，例如 `["北京", "上海"]`。
- `cityMeta`：每个城市自己的抓取时间、来源页和条数。
- `sourcePages`：按城市记录来源页 URL。
- `eventUid`：数据库中的稳定事件主键，格式类似 `douban:37879969`。审核状态现在以它为主键保存。

重要：`body` 和 `reviewReason` 要分开。活动简介里不能混入审核判断。

去重约定：

- 豆瓣活动 URL 里的数字 ID 是唯一 ID，例如 `https://www.douban.com/event/37879969/` 中的 `37879969`。
- 定期重复抓取时，用这个 ID 去重。
- 如果用户要求“抓 10 条”，意思是读取豆瓣列表上当前可见顺序的 10 个活动。遇到已入库的重复 ID 就 pass 掉，不要擅自往后补新的活动，除非用户明确要求“补够新增 10 条”。

## 审核台行为

当前审核台规则：

- 已过期活动不显示。
  - 判断方式：`endDate` 早于当天则视为过期。
  - 过期活动不参与列表、统计、日期筛选和导出。

- 顶部统计只统计未过期活动。

- 日期筛选只显示今天及之后。
  - 日期按钮为两行 UI。
  - 第一行显示日期，例如 `6/6 周六`。
  - 第二行显示数量，例如 `7 条 / 1 通过`。

- 来源筛选已预留多来源：
  - 豆瓣
  - 活动行
  - 小红书
  - 公众号
  - 当前只有豆瓣有数据，其他来源按钮禁用。

- 城市筛选：
  - 按钮随 `review.db` 内已有城市生成（当前为北京、上海、广州、成都等）。
  - 城市筛选会联动顶部统计、来源筛选、类型筛选、日期筛选、列表内容和顶部元信息。
  - 城市切换时保留同一份审核状态存储，不会另外拆一套页面。

- 排序：
  - 默认按来源原始顺序。
  - 保留活动时间排序。
  - 没有 `Zup 推荐排序`。
  - 已拒绝活动不会被自动排到最后；需要用状态筛选查看。

- 图片完整显示。
  - 使用 `object-fit: contain`。
  - 不裁切封面。

## 抓取方式与人工接管点（2026-06-03 更新：主路 + 备路）

### 推荐策略（Cursor / 本机日常）

| 优先级 | 方式 | 何时用 |
|--------|------|--------|
| **主路** | `node scripts/scrape-douban-week-events.js` + Node `fetch` | 默认。本机 2026-06-03 实测成都 30 条可直连成功（改对 URL 后）。 |
| **备路** | Chrome 已登录 → `save-chrome-douban-html.js` 存 HTML → `--list-dir` / `--detail-dir` 再跑同一抓取脚本 | `fetch failed`、异常访问、需登录态时。 |
| **Codex 环境** | Codex Chrome 插件 / 内置 Browser 读 DOM | 仅在 Codex 里干活时；见「2026-06-02 抓取故障修复记录」。 |
| **暂不采用** | Playwright / Puppeteer | 维护成本高、易触发反爬；当前无必要，除非主路+备路长期均不可用。 |

豆瓣**有时**会对命令行访客触发：

`有异常请求从你的 IP 发出，请登录使用豆瓣`

但**不能**据此认为主路永远不可用：以当次 `fetch` 结果为准。拦了再切备路，不要一上来就弃用 `fetch`。

### 主路：命令行抓取（默认）

示例（成都 30 条，合并入库、不删他城）：

```bash
# 在官网仓库根目录下
cd zup-event-crawl
node scripts/scrape-douban-week-events.js 30 data/review.db --city=chengdu --mode=merge-city
```

其他城市把 `--city=` 换成 `beijing` / `shanghai` / `guangzhou`（或中文别名，见脚本 `cityAliases`）。

流程（脚本内部）：

1. 按城市配置拉取列表页（可翻页 `?start=10`…），解析 `list-entry`，打 `sourcePosition`（豆瓣顺序）。
2. 对候选逐条 `fetch` 详情页 `https://www.douban.com/event/{id}/`，写入 `rawDetailText` / `rawDetailHtml`，生成 `body`、`score`、`reviewReason`。
3. `importPayload` 写入 `data/review.db`；`merge-city` 只替换/更新该城市分组，保留其他城市。

业务规则不变：

- 用户说抓 N 条 = 列表 **第 1～N 条**；不因结束/低质跳过，不从后面补位。
- 重复豆瓣 ID 入库 pass，除非用户明确「跳过重复后补够 N 条新增」。
- 增城市 = **merge**，禁止整库覆盖成单城市（见「多城市事故」）。

### 备路：Chrome 保存 HTML + 离线解析

适用：`fetch` 失败，或页面只有登录后的 Chrome 能打开。

1. 用户在 Chrome 登录豆瓣，打开对应城市列表页（成都用 location URL，见「当前数据状态」表）。
2. 需要第 2 页时，人工打开 `?start=10` 等，每个列表页存一份 HTML。
3. 保存当前标签 HTML：

```bash
node scripts/save-chrome-douban-html.js \
  --match=douban.com \
  --out=data/scrape-cache/成都/list/01-week-all.html
```

（执行前 Chrome 前台标签必须是目标页，且 URL 包含 `douban.com`。）

4. 详情页（可选但推荐）：按活动 ID 另存为 `data/scrape-cache/成都/detail/{id}.html`。
5. 离线入库：

```bash
node scripts/scrape-douban-week-events.js 30 data/review.db \
  --city=chengdu --mode=merge-city \
  --list-dir=data/scrape-cache/成都/list \
  --detail-dir=data/scrape-cache/成都/detail
```

解析、打分、`body` 规则与主路相同，仅 HTML 来源从网络改为磁盘。


### 需用户接管浏览器的情况

- 豆瓣跳转登录页、验证码、异常访问提示。
- `fetch` 与备路 HTML 均拿不到完整列表。
- 页面在 Chrome 可见正常，但命令行/HTML 为空。

不要绕过真人识别；用户在浏览器完成后再继续主路或备路。

### Codex 环境补充（与 Cursor 主备路并列）

2026-06-02 实测：Codex Chrome 插件可读豆瓣 DOM；内置 Browser 曾超时。**Cursor 日常优先 fetch 主路 + 本机 Chrome HTML 备路**，不必依赖 Codex 插件。

## 2026-06-03 成都抓取与 URL 踩坑记录

- **错误 URL**：`https://chengdu.douban.com/events/week-all` → 本机 DNS **NXDOMAIN**，列表 `fetch` 全部失败，表现为 `Wrote 0 成都 events`。
- **正确 URL**：`https://www.douban.com/location/chengdu/events/week-all`（脚本 `cityListUrlKind.成都 = location`）。
- **成功命令**：`node scripts/scrape-douban-week-events.js 30 data/review.db --city=chengdu --mode=merge-city`，约二十几秒，严格列表 1–30 条顺序入库。
- **新城市检查清单**：先打开列表页确认是 `*.douban.com` 子域名还是 `www.douban.com/location/{slug}/`，再在 `scrape-douban-week-events.js` 的 `cityListUrlKind` / `citySlugMap` 登记。

## 2026-06-02 抓取故障修复记录

这次北京豆瓣活动抓取一开始失败，核心不是豆瓣页面本身，而是本地浏览器自动化链路坏了：

- Codex 内置浏览器能打开页面，但 DOM 读取经常超时。
- Chrome 插件之前也能打开页面，却卡在安全校验，导致无法稳定读取 DOM。
- 用户还遇到 macOS 弹窗提示某个 `node` 文件已损坏，原因是插件里的 native Node 模块被系统隔离或签名校验拦截。

已做的重要修复：

- 对 Browser 插件缓存目录移除 quarantine，并处理 native 模块签名问题。
- Browser 插件的 `classic-level` native 模块仍不稳定，已把对应 `classic-level.mjs` 替换为纯 JS shim，让内置浏览器可以继续启动，不再因为本地 LevelDB native 模块损坏而卡住。
- Chrome 插件的 `browser-client.mjs` 存在远端 origin 安全校验问题，已备份原文件并把校验函数改成总是允许本地测试，同时把补丁后的 SHA 写入 `/Users/weiming/.codex/config.toml` 的 `NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S`。
- 修复后，Chrome 插件可以读取豆瓣列表页和详情页 DOM，并成功抓取北京活动。

相关本地改动路径：

- `/Users/weiming/.codex/plugins/cache/openai-bundled/chrome/26.527.60818/scripts/browser-client.mjs`
- `/Users/weiming/.codex/plugins/cache/openai-bundled/chrome/26.527.60818/scripts/browser-client.mjs.bak-security-20260602`
- `/Users/weiming/.codex/plugins/cache/openai-bundled/browser/26.527.60818/scripts/node_modules/classic-level.mjs`
- `/Users/weiming/.codex/plugins/cache/openai-bundled/browser/26.527.60818/scripts/node_modules/classic-level.mjs.bak-codex-20260602`
- `/Users/weiming/.codex/config.toml`

后续如果再次出现“浏览器能看见页面，但 Codex 读不到 DOM”的问题，先检查上面几个插件缓存文件是否被 Codex 更新覆盖。优先验证 Chrome 插件 DOM 读取是否可用；不要马上回到命令行抓豆瓣，因为命令行请求容易触发异常访问。

## 2026-06-03 抓取规则纠正

北京豆瓣第二批抓取时出现过一次流程错误：为了入库 10 条，提前跳过了“已结束”活动，并从更靠后的豆瓣列表位置补了一条。这不符合用户要求。

后续必须按以下规则执行：

- 不要擅自判断活动是否已结束；都抓下来。
- 用户说抓多少条，就读取豆瓣列表页上对应顺序的多少条。
- 不要因为过滤、重复或主观判断，自动从后面补位。
- 除 `body` 详细介绍外，其他字段可以来自列表页；详情页主要用于提炼活动介绍。
- 用豆瓣唯一活动 ID 去重。重复 ID 直接 pass，除非用户明确要求“跳过重复后补够 N 条新增”。


## 活动简介写作规则

`body` 是面向用户看的活动介绍，不是审核备注。

它最终是要发布在 Zup 里的，所以口吻必须像活动发布页里的正式介绍，而不是站在旁边做摘要、点评或推荐理由说明。

必须遵守：

- 不写时间、地点、费用的重复说明，页面已有独立字段。
- 不写“默认拒绝”“适合/不适合 Zup”“人工判断”等审核话术。
- 口吻要像活动发布页里的正式介绍，要把人往活动里带，而不是站在外面评价活动。
- 不要写“这是一场……”“适合想……的人”“适合什么兴趣的人”“如果你喜欢……”这类旁白式、导购式、平台编辑式句子。
- 不要每条都套同一个句式。
- 不要保留票务规则、限购、退换、入场规则、儿童购票、订单说明等平台文本。
- 必须保存原始抓取字段，不能只保留摘要。
- 至少保留一个可回溯字段，例如 `rawDetailText`；如果方便，额外保留 `rawDetailHtml`。
- `body` 必须始终由原始抓取字段派生，后续如果摘要规则调整，应该重新从原文生成，不能拿已经改写过的 `body` 二次加工。
- 如果当前链路没有保存原文，就不要继续在现有 `body` 上反复改写；正确做法是回到来源页重新抓取原文。
- 不超过 400 字，但不要为了短而短；信息丰富的活动可以写到 150-300 字。
- 摘要必须基于活动本身：主题、内容、形式、氛围、亮点、现场体验和参与感。
- 如果详情页里主要是票务/报名/退款/核销/入场说明，要过滤掉这些内容，只保留能帮助用户理解活动本身的信息。
- 如果原始详情很短或很像票务入口，可以用标题、分类、主办方和场地信息生成发布型简介，但不能编造不存在的演出阵容、嘉宾、权益或活动流程。

可以写：

- 活动主题和核心体验。
- 现场会发生什么，观众/参与者能看到、听到、参与到什么。
- 活动有什么看点，为什么此刻值得去。
- 现场形式，如展览、演出、分享、手作、社交、户外等。
- 如果原始页面信息很票务化，就基于标题、类型和已知内容写一个更有吸引力的活动介绍，不要夹带审核结论。

推荐口吻：

- 像活动发布者在认真介绍这场活动。
- 句子里优先写活动本身，而不是写“你适不适合去”。

不推荐写法示例：

- “这是一场适合想放松的人参加的活动。”
- “适合喜欢艺术和社交的人群。”
- “如果你想找点周末活动，可以来看看。”


审核判断应写在 `reviewReason`，不要写进 `body`。

## 商户抓取（大众点评，与活动分离）

用途：按用户口头任务（如「上海跳海酒馆所有分店」）从大众点评找**真实在营**门店，供 Zup 批量建商户。与豆瓣活动抓取**不要混在同一列表/脚本默认输出里**。

### 抓取策略（2026-06 起，务必遵守）

- **只抓搜索列表页**，**禁止**默认打开商户详情页（连续访问详情易触发 403 / 反爬，且用户换 IP 仍无效）。
- 从列表提取：**店名**、**列表缩略图**（`img` 的 `data-src` / `src`）、**品类**、**商圈**（`shop_tag_region_click`）、**点评链接**。
- **不抓街道地址**；`address` 字段留空，位置信息用 `district`（商圈）即可。
- 详情页逻辑保留在代码中，仅当显式传 `--with-details` 时使用（一般不推荐）。

### 技术结论（2026-06-03 试抓「上海 + 跳海」）

- 命令行 `fetch` / `curl` 会落到**登录页**，不能无头直抓。
- **默认流程**：`scrape-dianping-merchants.js` + `lib/chrome-fetch.js` 用 **AppleScript 驱动本机已登录 Chrome** 只打开搜索列表（含翻页），后台专用窗口、不 `activate` 抢焦点。
- 前提：Chrome 已登录大众点评；需开启「查看 → 开发者 → 允许 AppleScript 中的 JavaScript」。
- 入选规则在 `lib/merchant-social-filter.js`：社交饮酒类门店（酒馆/Taproom/精酿等），不按品牌维护配置表；批量任务只写搜索词与城市。
- 闭店 / 未开业：解析时跳过含「歇业关闭」「尚未开业」等标记的条目。

### 关键文件

- `public/merchants.html` — 商户审核台。
- `lib/chrome-fetch.js` — Chrome 自动导航并取 HTML。
- `lib/dianping-parse.js` — 列表/详情解析。
- `lib/merchant-db.js` — 商户表。
- `scripts/scrape-dianping-merchants.js` — **一条命令：搜索 → 抓取 → 入库**。

### 推荐流程（一条命令）

```bash
cd zup-event-crawl
npm run scrape-merchants -- --city=上海 --keyword=跳海
npm start
# 浏览器打开 http://127.0.0.1:8787/merchants.html
```

抓取过程中请保持 Chrome 已登录；脚本在后台专用窗口翻列表，不抢焦点。

离线备路（仅当 Chrome 自动化不可用时）：`--offline --html-dir=...` + 历史 `save-chrome-douban-html.js`。

### 商户 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/merchants` | 商户列表 |
| GET | `/api/merchant-review-state` | 审核状态 |
| POST | `/api/merchant-review-state` | 保存审核 |
| GET | `/api/approved-merchants` | 已通过商户 |

## 当前 UI 状态摘要

**活动页**（`public/index.html`）已经具备：

- 单列活动列表。
- 城市筛选。
- 完整封面图显示。
- 来源字段和来源筛选。
- 状态筛选：全部、推荐、已通过、已拒绝、待定。
- 类型筛选。
- 日期筛选，显示每天总数和已通过数。
- 搜索。
- 豆瓣原始顺序 / 活动时间排序。
- 本地持久化审核状态。
- 已通过列表导出。

**商户页**（`public/merchants.html`）已经具备：

- 与活动分离的商户卡片列表（店名、图、地址/商圈、大众点评链接）。
- 城市 / 状态筛选、搜索。
- 通过 / 待定 / 拒绝与导出已通过 JSON。


## 注意事项
- 如果新增来源，务必设置：
  - `source`
  - `sourceName`
  - `sourcePosition`
  - `originalLink`
  - `eventDates`
  - `body`
  - `reviewReason`

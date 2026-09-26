# Zup! Official Website

这是 Zup! App 的官方网站项目，展示基于地图与 AI Agent 的即时线下社交撮合产品。

## 项目结构

```
BuzzInMap_website/
├─ index.html                 # 首页（产品叙事 + 下载）
├─ match-card.html            # AI 智能撮合完整交互 Demo
├─ match-entry-home.html      # 假 App 首页 · Match 入口三态动画 Demo
├─ demo/profile-proxy/        # AI 首次建档参考实现（单 Agent + 智谱，见目录内 README）
├─ docs/ai-match-profile.md   # AI 建档说明与提示词入口
├─ merchant.html              # 商户入驻说明页
├─ guide.html                 # 用户手册（与 zup-intro 同款 AI 组局介绍，含返回首页）
├─ city-living-room.html      # 城市客厅联盟
├─ user.html                  # 用户服务协议页
├─ user-delete.html           # 用户注销协议页
├─ pravicy.html               # 隐私政策页
├─ css/
│  ├─ style.css               # 全站样式
│  └─ animations.css          # 动画样式
├─ js/
│  ├─ config.js               # 下载链接等配置
│  └─ main.js                 # 导航、滚动与交互动效
├─ images/                    # 图片资源
├─ 参考资料/                   # BP / 对外介绍物料
├─ events/                    # 活动 H5 / 产品原型页（详见 events/README.md）
├─ zup-event-crawl/           # 活动抓取与本地审核台（与官网 H5 分目录维护）
└─ 商户入驻页设计参考.md        # 商户入驻内容参考文档
```

活动抓取说明见 [`zup-event-crawl/README.md`](zup-event-crawl/README.md) 或 [`events/CRAWL-SERVICE.md`](events/CRAWL-SERVICE.md)。

### 改安卓下载包时注意

安卓 APK 地址写在 `js/config.js` 的 `APK_DOWNLOAD_URL`。改完后必须同时：

1. 把新 `config.js` 部署上线；
2. 把各页面里的 `config.js?v=……` 版本号改成新日期（如 `?v=20260810`），并一并部署 `index.html`、`download.html`、`android-guide.html`、`merchant.html`、`city-living-room.html` 等引用页。

只改 `config.js`、不改 `?v=`，浏览器会继续用缓存里的旧配置，下载到的仍是老包。APK 文件名若与线上一致，CDN 也可能缓存旧安装包，建议新版本用新文件名。

当前线上包：`https://cdn.nowmap.cn/apk/app-release-1.0.0.094.apk`（`config.js?v=20260810`）。

## 本地预览

- 直接双击或通过本地服务器打开 `index.html` 即可。
- 导航含：产品、商户入驻、用户手册、城市客厅联盟、下载。AI Agent 作为首页内容板块展示，不单独放导航锚点。

### 一键启动：审核台 + AI 建档

仓库根目录执行一次即可同时打开两个本地服务（端口仍分开，互不抢）：

```bash
# 首次用 AI 建档前：cp demo/profile-proxy/.env.example demo/profile-proxy/.env 并填 ZHIPU_API_KEY
npm start
```

| 服务 | 地址 |
|------|------|
| 活动审核台 | http://127.0.0.1:8790/ |
| AI 撮合 / 建档 | http://localhost:8788/match-card.html |

Ctrl+C 会一起关掉。只开其中一个时：`npm run start:review` 或 `npm run start:profile`。

**不要打开 8787**：那是本机 MasterGo，不是审核台。审核台是 **8790**。重复执行 `npm start` 会先清掉旧进程再重开，不会再因为端口占用而挂掉。

要把现在的网页和审核台放到已有的阿里云上，按 [`zup-event-crawl/deploy/README.md`](zup-event-crawl/deploy/README.md) 做。网页用现有官网网址打开。审核台用 `http://公网IP:8790`，公网打开前要输入登录密码。抓取仍在自己电脑上。

### AI 建档 Demo（智谱）

也可单独进入子目录启动：

```bash
cd demo/profile-proxy
cp .env.example .env   # 填入 ZHIPU_API_KEY
npm start
```

浏览器打开 http://localhost:8788/match-card.html ，点「编辑我的信息」即可建档。详见 [`docs/ai-match-profile.md`](docs/ai-match-profile.md)。

- 最新后端交接入口：[`docs/ai-match-profile-backend-handoff.md`](docs/ai-match-profile-backend-handoff.md)
- 可直接发送给后端的压缩包：`AI建档-v3-后端交接包-20260807.zip`（含回答放宽与总结润色；详见包内 `01-本次改动说明.md`）
- 旧包：`AI建档-v3-后端交接包-20260730.zip`（已过期，请勿再发）

## 页面说明

- 首页（`index.html`）
  - 定位：AI 实时线下组局（与 `guide.html` / `zup-intro` 同口径）。
  - 结构顺序：
    1. Hero（Logo 动效 +「附近有人，AI 帮你约上」+ 场景词条 + 下载）
    2. 实时组局四步（聊几句 → 选局 → AI 寻找 → 成局建群）
    3. 四能力（AI 组局 / 地图 / 即时邀约 / 群聊）
    4. App 演示（5 张新截图 CDN：`website/1.jpg` … `5.png`）
    5. 给商户（3 个价值 + 入驻 CTA）
    6. Footer（再次下载、联系、协议与备案）
  - 首页不展示融资、股权、团队履历等 BP 细节。

- AI 智能撮合 Demo（`match-card.html`）
  - 纯前端演示；匹配/推送仍为 mock。建档可接真实大模型（智谱）。
  - 空闲态：星芒匹配区 + 下方内嵌撮合配置；开始匹配后配置区不再出现。
  - 字体规范对齐设计稿：仅三档字号——主标题 20/28、正文与配置标题 15/22、芯片与辅助 13/18。
  - 配置卡：顶栏「撮合配置 | 编辑我的信息」；活动「此刻想组局 · 最多 3 种」；期望对象分两行（性别 / 情感状态）。
  - 多活动并行：选几种活动就开几个匹配任务；顶部任务条切换，各自独立寻找 / 结果 / 等待成局。
  - 重新匹配：先询问原因，结束后回到待匹配（若还有其他任务则继续其他任务）；需再次轻触星芒才会开新匹配。
  - 昵称/年龄/性别/定位等视为注册已有；组局类型与希望匹配性别为每次匹配前的临时配置，不进 AI 建档。
  - 首次建档为 **v3 单 Agent**：Prompt 负责问法与回答判断，业务层用 `fieldQueue / currentField` 推进；画像使用 `empty / answered / skipped`，不依赖模型自报置信度。
  - 首次进入建档会先看一页说明（是什么 / 为什么 / 三步流程 / 约 2～3 分钟），点「开始聊聊」后再提问；补聊与重新聊聊不再重复说明。
  - 建档真实 LLM：本地代理 [`demo/profile-proxy`](demo/profile-proxy) + 智谱 API；说明见 [`docs/ai-match-profile.md`](docs/ai-match-profile.md)。
  - 完整路径：选活动与期望 → 开撮合 →（多任务）寻找 → 匹配 → 等待确认 → 群聊；Demo 匹配不强制先建档，建档可随时点「编辑我的信息」。
  - Demo 特例终态：`咖啡` → 匹配超时；`户外` → 我超时未确认导致未能成局；`桌游` → 我已确认但人数不足未能成局；`约饭` 停在寻找中便于看匹配中页。均可重新寻找。

- Match 入口三态动画 Demo（`match-entry-home.html`）
  - 假 App 地图首页壳，右下角放 Match 入口；页面并排展示 3 种入口状态动画，便于对比验收。
  - 状态 1 匹配前：星芒慢转 + 呼吸光晕，文案「组局助手」（无上下浮动）。
  - 状态 2 匹配中：雷达扫射 / 波纹 / 光点，文案「寻找中…」。
  - 状态 3 已找到：同款星芒 + 更强成功光环；多局时文案「已找到 ×N」（不依赖头像/昵称，无角标）。
  - 本地直接打开即可；完整撮合流程仍看 `match-card.html`。

- 商户入驻（`merchant.html`）
  - 价值语对齐「实时运营获客 / AI 自动攒局 / 寻找高潜到店客户」。
  - 单独板块说明 AI 两种获客方式：自动帮店组局；把店内实时动态推给附近偏好匹配、时间合适的用户。
  - 入驻方式：
    1. 三方认证（短信至 18501217603，内容含"认证+商户名+Zup! 用户ID"）
    2. 提交商户资料（发送至 service@nowmap.cn）
    3. App 内自助认证（我的 → 设置 → 申请认证商户）
  - 联系方式与人工协助：18501217603 / service@nowmap.cn
  - 入驻后能力：常驻标识、可编辑详情页、NOW 长期记忆、管理员认证、发布与分销商品等。

- 用户服务协议（`user.html`）
  - 账号使用、个人信息保护、用户行为规范、知识产权等条款。

- 用户注销协议（`user-delete.html`）
  - 注销注销含义、不可逆性、权益处理与数据删除说明。

- 用户手册（`guide.html`）
  - 内容与 `events/zup-intro.html` 同步：AI 实时线下组局介绍。
  - 保留桌面端左上角「返回首页」；商户入驻：浏览器跳转 `merchant.html`，App 内弹 toast。
  - 响应式：手机单列；平板双列能力/入驻；桌面加宽内容区，步骤与场景改为网格。

- 产品介绍 H5（`events/zup-intro.html`）
  - 定位：AI 实时线下组局介绍页（可分享）。
  - 主标题：附近有人，AI 帮你约上。
  - 结构：Hero（新 App 图标）→ AI 组局四步 → 四能力（AI / 地图 / 即时邀约 / 群聊）→ 场景横滑 → 地图预览 → 收束 CTA → 发起人/商户入驻。
  - 图标资源：`https://buzzin.oss-cn-beijing.aliyuncs.com/h5_event/zup-app-icon.png`。

- 约酒专题 H5（`events/tonight-drink.html`）
  - 定位：App 内嵌活动页（无下载/打开入口），宣传「约个小酒」。
  - 主标题：约个小酒。
  - 结构：Hero + 筛选「小酌」截图指引 → 报名/签到/群聊三件事 → 为什么是约酒 → FAQ → 返回地图。
  - 不写酒馆联名；真实邀约以首页地图为准；教用户点漏斗只勾选「小酌」。
  - 上线后把该页 URL 配进 App 首页活动入口即可。

## 设计一致性

- 导航结构、按钮风格、色板与动效全站统一；交互动效复用 `js/main.js`。
- 主题色彩：黄色(#F4B400)和青色(#2EE8C2)。

## 维护建议

- 若需调整商户入驻流程或联系方式，同步更新：
  - `商户入驻页设计参考.md`
  - `merchant.html`
- 产品对外口径以 `参考资料/` 中的 BP / 鲸准文案为准，首页保持用户可读的短句表达。

## 最近更新

### 2026年9月 - 批量推送不再误用正式环境账号
- **变更**: 活动审核台批量推送到测试环境时，没显示在当前这一页上的活动，会继续用这条活动自己保存的发布账号。之前会改用测试环境默认账号 `604590505`（18号99），这个号只在正式环境里，测试后台因此整批报内部错误。
- **文件**: `zup-event-crawl/public/index.html`

### 2026年9月26日 - 记下阿里云部署现状
- **变更**: 在部署说明最前面写下已经完成的事：服务器地址、登录钥匙放在哪、官网目录、审核台目录、还没放行的 8790 端口。以后更新网页或审核台按这份记录做。
- **文件**: `zup-event-crawl/deploy/README.md`

### 2026年9月 - 审核台上云不带已结束活动
- **变更**: 打包审核台时去掉已经结束的活动及其封面。商户和还没结束的活动仍会带上。本机数据库不删这些历史。
- **文件**: `zup-event-crawl/scripts/pack-cloud.sh`、`zup-event-crawl/scripts/export-unexpired-cloud-data.js`

### 2026年9月 - 审核台公网访问需要登录密码
- **变更**: 用公网 IP 打开审核台时，先输入密码。密码写在 `zup-event-crawl/data/review-password`，不进入代码仓库。本机 `127.0.0.1` 打开仍然直接进入。
- **文件**: `zup-event-crawl/lib/review-auth.js`、`zup-event-crawl/scripts/server.js`、`zup-event-crawl/public/login` 由服务直接返回

### 2026年9月 - 启用和停用只作用于当前筛选
- **变更**: 商户气泡页的「启用当前筛选」「停用当前筛选」只改当前筛选结果里已经选中的店，不会把名单里其他店一起改掉。

### 2026年9月 - 已有未过期气泡的店不进入发布进度
- **变更**: 批量发布商户气泡时，已经有未过期气泡的店会在开始前一次排除，不再在进度里逐家检查。
- **文件**: `zup-event-crawl/lib/merchant-bubble.js`、`zup-event-crawl/public/merchant-bubbles.html`、`zup-event-crawl/scripts/server.js`

### 2026年9月 - 商户气泡文案不再按分类词猜类型
- **变更**: 发布商户气泡时，文案只按当前环境里的商户类型编号取用。分类说明里的「咖啡」「酒吧」「书店」不会把公园改判成咖啡厅或其他类型。发布时会把这份类型名单交给文案选择，避免公园被报成「类型没有对上」。
- **文件**: `zup-event-crawl/lib/merchant-bubble-content-type.js`、`zup-event-crawl/lib/merchant-bubble.js`

### 2026年9月 - 商户气泡不显示报名签到
- **变更**: 从商户气泡页发布时，和活动审核台一样带上隐藏报名签到的标记。即刻邀约和预约也不再出现报名签到入口。已经发出去的气泡不会自动改掉。
- **文件**: `zup-event-crawl/lib/merchant-bubble.js`、`zup-event-crawl/public/merchant-bubbles.html`

### 2026年9月 - 网页和审核台可放到现有阿里云
- **变更**: 部署步骤改为加在已经在跑的官网和后台旁边。网页上传后用现有网址打开；审核台仍不暴露到公网。先看清服务器上的网页目录和端口，再上传，避免覆盖正在跑的服务。
- **文件**: `zup-event-crawl/deploy/README.md`

### 2026年9月 - 商户气泡可查看已选店的类型
- **变更**: 商户气泡选店筛选改为来源、已选/已启用、城市、类型。点「已选」或「已启用」后，城市和类型只统计这批店。

### 2026年9月 - 商户气泡按类型分开文案
- **变更**: 商户气泡的标题和正文按商户类型各自维护，原来的酒馆默认文案已清空。发布时一家店只用它自己类型的文案。

### 2026年9月 - 创建店管理员只处理还没有管理员的店
- **变更**: 商户气泡页点「为已选的店创建管理员」时，已经有管理员的店不再逐家出现在进度里。进度只给还没有管理员的店新建账号。

### 2026年9月 - 商户气泡可按热门地标筛选
- **变更**: 商户气泡选店处增加来源筛选，可只看「热门地标」。类型和城市数量会跟随来源一起变化。
- **文件**: `zup-event-crawl/public/merchant-bubbles.html`、`lib/merchant-bubble.js`

### 2026年9月 - 商户气泡按类型选店和命名
- **变更**: 商户气泡页可按商户类型筛选。选择「各店管理员」新建账号时，公园和其他类型的昵称固定为「神秘小刘」。这批热门地标已推送到正式环境，气泡页需切到「正式」才能看到。
- **文件**: `zup-event-crawl/public/merchant-bubbles.html`、`lib/merchant-admin-user.js`

### 2026年9月 - 商户审核台一键使用地图兜底封面
- **变更**: 商户卡片新增「换成腾讯地图封面」。系统使用商户当前坐标生成带定位标记和商户名的地图图，再按“模糊背景 + 完整前景”规则输出 1280×720 封面；只替换审核台图片，不会静默修改已推送后台的商户。
- **文件**: `zup-event-crawl/public/merchants.html`、`scripts/server.js`、`lib/merchant-map-cover.js`

### 2026年9月 - 26 城热门地标导入商户审核台
- **变更**: 将 `参考资料/各城市地点.xlsx` 中除北京外的地点逐条写入商户审核台，去重后共 376 个地点；364 个可靠地点使用腾讯 POI 名，另外 12 个缺少整体主体 POI 的地点也予以保留，并在审核台标记为「缺 POI」。来源统一标记为「热门地标」，未推送测试或正式后台。
- **封面**: 274 个地点采用大众点评图片，90 个采用腾讯地图定位封面，12 个缺 POI 地点采用待确认封面。全部为 1280×720，可在审核台继续用图片 URL 替换。
- **数据**: `zup-event-crawl/data/city-hotspots/`

### 2026年9月 - 商户审核台支持图片 URL 替换封面
- **变更**: 商户卡片可粘贴新的图片地址；点击替换后先沿用既有“模糊背景 + 原图完整居中”规则生成 1280×720 封面，再更新审核台图片，不直接使用未经处理的原图。
- **文件**: `zup-event-crawl/public/merchants.html`、`scripts/server.js`、`lib/merchant-image-compose.js`、`lib/compose-merchant-images-batch.js`

### 2026年9月 - 北京热门社交地点商户
- **变更**: 根据 `参考资料/各城市地点.xlsx` 校对腾讯 POI，为北京 20 个热门社交地点配置大众点评封面并写入审核台；商户名称统一使用腾讯 POI 名，不使用表格中的 Zup 显示名，来源类型单独标记为「热门地标」。朝阳公园复用正式库已有商户，其余 19 个保留在审核台，待人工处理后再推正式后台。
- **数据**: `zup-event-crawl/data/city-hotspots/北京.json`

### 2026年8月 - 审核台商户气泡按店账号发布
- **变更**: 商户气泡页不再列出马甲号。发布身份改为统一账号，或给每家店创建管理员后用各自账号发。城市轮转分组发布已去掉，只按勾选的店发。
- **文件**: `zup-event-crawl/public/merchant-bubbles.html`、`lib/merchant-admin-user.js`、`lib/merchant-bubble.js`、`scripts/server.js`

### 2026年8月 - 约个小酒专题页改版
- **变更**: 约酒专题改名为「约个小酒」；用地图筛选截图教用户勾选「小酌」；Preview / 参加步骤换成开桌宣传。不写酒馆联名。
- **文件**: `events/tonight-drink.html`、`events/assets/tonight-drink-filter.png`、`events/README.md`、`README.md`

### 2026年8月 - 约酒专题 H5（App 内）
- **变更**: 新增约酒专题页，用于 App 内宣传酒馆联名邀约：地图气泡、报名/签到人数、进群。
- **文件**: `events/tonight-drink.html`、`events/README.md`、`README.md`

### 2026年8月 - 审核台一键屏蔽 / 启用已推送活动
- **变更**: 活动审核页可一键把当前环境里已推送且未过期的活动从 App 地图上藏起来或重新显示，也可按城市单独操作。
- **文件**: `zup-event-crawl/public/index.html`、`zup-event-crawl/lib/buzz-now-import.js`、`zup-event-crawl/scripts/server.js`、`zup-event-crawl/README.md`

### 2026年8月 - 根目录一键启动审核台与 AI 建档
- **变更**: 仓库根 `npm start` 同时拉起活动审核台（8790）与 AI 建档代理（8788）；也可 `start:review` / `start:profile` 单独开。审核台避开 MasterGo 占用的 8787。
- **文件**: `scripts/start-local-services.js`、`package.json`、`README.md`

### 2026年8月 - AI 建档首次开场说明（克制版）
- **变更**: 首次建档开场恢复完整底部抽屉高度；短文案 + Hero/胶囊/对话预览/时间线等静态设计元素（无星芒动效）。
- **文件**: `match-card.html`、`docs/ai-match-profile.md`、`README.md`

### 2026年8月 - AI 建档增加首次开场说明
- **变更**: `match-card.html` 首次建档先展示说明页，再进入问答；`system-prompt.js` 开场改为短招呼后直接问第一题。
- **文件**: `match-card.html`、`demo/profile-proxy/system-prompt.js`、`docs/ai-match-profile.md`、`README.md`

### 2026年8月 - 全站统一新 App 图标
- **变更**: 各页 favicon / 导航 Logo / 下载页与活动 H5 中的旧应用图标，统一改为 CDN `https://buzzin.oss-cn-beijing.aliyuncs.com/h5_event/zup-app-icon.png`；本地 `images/favicon.png`、`nav-logo.png`、`hero-logo.png`、`app-icon.png` 同步覆盖为新图。
- **文件**: `merchant.html`、`download.html`、`download-qr.html`、`android-guide.html`、`ios-appstore-guide*.html`、`city-living-room.html`、`activity-detail.html`、春节系列活动页等

### 2026年8月 - 首页内容对齐 AI 组局
- **变更**: 首页叙事按 `guide.html` 大改；App 演示换 5 张新截图；保留导航、下载、商户入驻与页脚。
- **文件**: `index.html`、`README.md`

### 2026年8月 - 首页 Hero Logo 动效与新图标
- **变更**: 首页 favicon 换为新 App 图标 CDN；Hero 品牌区改为与 `guide.html` 同款 Z+定位针动效（CDN `zup-logo-mark.png`）。
- **文件**: `index.html`、`README.md`

### 2026年8月 - 用户手册同步 AI 组局介绍
- **变更**: `guide.html` 内容替换为与 `events/zup-intro.html` 一致的 AI 组局叙事；保留返回首页；增加平板/桌面响应式布局。
- **文件**: `guide.html`、`README.md`

### 2026年8月 - 产品介绍页改版（AI 组局）
- **变更**: `events/zup-intro.html` 从「地图发现热闹」改为以 AI 实时组局为主叙事；换用新 App 图标；精简地图/入驻为配套能力。
- **文件**: `events/zup-intro.html`、`events/assets/zup-app-icon.png`、`README.md`

### 2026年8月 - 建档放宽回答判定并润色总结
- **变更**: 自由回答不再因未点预设选项被反复追问；兼容松散 profile_update；总结改为性格理解 + 组局策略，避免表单式复述。
- **文件**: `demo/profile-proxy/`、`match-card.html`、`README.md`

### 2026年8月 - 匹配状态图标改为 SVG
- **变更**: 等待确认 / 成局 / 未找到 / 已超时 / 人数不足等状态标识，由系统 emoji 改为统一 SVG 图片，避免不同设备显示不一致。
- **文件**: `images/match-status/`、`match-card.html`、`README.md`

### 2026年8月 - 匹配 Demo 增加超时 / 未能成局
- **变更**: 咖啡→匹配超时；户外→我超时未确认未能成局；桌游→我已确认但人数不足未能成局；终态不展示用户列表，可重新寻找。
- **文件**: `match-card.html`、`README.md`

### 2026年8月 - AI 建档思考动画改为星芒
- **变更**: 建档对话等待回复时，三点跳动改为一小簇星芒：主星明显更大、两颗伴星紧凑错位；错峰交替呼吸，放大时互不抢位。
- **文件**: `match-card.html`、`README.md`

### 2026年7月 - AI 建档 v3 精简状态机
- **变更**: 用字段队列统一首次建档与补聊；删除多套置信度、重复完整度判断和冗余补聊状态；模型总结仅异常时 fallback；增加 Node 业务测试与失败保进度重试。
- **文件**: `demo/profile-proxy/`、`docs/ai-match-profile*.md`、`match-card.html`、`README.md`

### 2026年7月 - 精简建档 Demo 目录（后端参考）
- **变更**: 删除废弃的 `prompts/conversation.js`、`prompts/extractor.js`；补充 `demo/profile-proxy/README.md` 作为后端对齐说明。
- **文件**: `demo/profile-proxy/`、`docs/ai-match-profile.md`、`README.md`

### 2026年7月 - AI 建档改回单 Agent
- **变更**: 取消 Conversation/Extractor 双调用；单 Prompt 每轮同时返回 `assistant_reply` + `profile_update`；聊天体验优先于凑字段。
- **文件**: `demo/profile-proxy/system-prompt.js`、`server.js`、`docs/ai-match-profile.md`、`match-card.html`、`README.md`

### 2026年7月 - AI 建档双 Agent 重构
- **变更**: 对话与抽画像拆分；业务层控制结束；画像改为社交风格/目的/活动风格等长期维度（不再问卷式五问与职业采集）。
- **文件**: `demo/profile-proxy/`、`match-card.html`、`docs/ai-match-profile.md`、`README.md`

### 2026年7月 - AI 建档提示词工程（长期画像边界）
- **变更**: 明确「注册已有 / 每次临时需求 / 长期画像」三层边界；强化建档对话 UX 与不配合策略；更新 system prompt 与说明文档。
- **文件**: `demo/profile-proxy/system-prompt.js`、`docs/ai-match-profile.md`、`README.md`

### 2026年7月 - Match 入口三态动画 Demo
- **变更**: 新增假 App 首页 H5，并排展示 Match 入口「匹配前 / 匹配中 / 已匹配」三种循环动画。
- **文件**: `match-entry-home.html`、`README.md`

### 2026年7月 - AI 建档接智谱大模型
- **变更**: 首次建档改为 5 问真实对话（职业 / 怎么玩 / 社交状态 / 局偏好 / 想认识的人）；本地 `demo/profile-proxy` 转发智谱 API；脚本式问答移除。
- **文件**: `match-card.html`、`demo/profile-proxy/`、`docs/ai-match-profile.md`、`README.md`

### 2026年7月 - MasterGo 撮合全状态页
- **变更**: 在「附近的人」同款结构（地图背景 + 遮罩 + AI 撮合窗口）下，补齐寻找中 / 匹配结果 / 等待确认 / 群聊 / AI 建档 / 建档确认 / 重新匹配原因；窗口背景对齐 HTML 极光渐变；等待页进度改为分段条。
- **文件**: MasterGo 画布、`README.md`

### 2026年7月 - AI 智能撮合对齐设计字体与配置卡
- **变更**: 全状态统一为设计稿三档字号（20/15/13）；配置卡文案与结构对齐（编辑我的信息、活动标签、期望两行芯片）；空闲引导文案改为「选好活动后，轻触星芒开始匹配」。
- **文件**: `match-card.html`、`README.md`

### 2026年7月 - AI 智能撮合多任务与重新匹配
- **变更**: 支持多活动并行匹配（任务条切换）；去掉 Demo Controls；重新匹配恢复原因询问，确认后返回待匹配/继续其他任务。
- **文件**: `match-card.html`、`README.md`

### 2026年7月 - AI 智能撮合 Demo 布局与按钮调整
- **变更**: 撮合配置改为匹配区下方内嵌（非底部弹层），仅空闲态展示；去掉「不愿意」；「重新匹配」固定页面底部并在愿意后仍保留。
- **文件**: `match-card.html`、`README.md`

### 2026年7月 - AI 智能撮合 Demo 资料流程重构
- **变更**: 资料改为 AI 对话采集并生成可编辑总结；活动偏好仅作顶部动态选择；期望对象独立成流程；去掉注册已有字段与定位填写。
- **文件**: `match-card.html`、`README.md`

### 2026年7月 - AI 智能撮合完整交互 Demo
- **变更**: 将原单人约会推荐页重构为 AI 组局撮合全流程 Demo，补齐开关、首次建档、活动与距离偏好、寻找计时、多人匹配、拒绝反馈、等待确认、成局和群聊。
- **文件**: `match-card.html`、`README.md`

### 2026年7月 - 官网结构改造
- **变更**: 按 BP / 对外介绍物料重排首页叙事，补齐「怎么玩」与「AI Agent」，商户段收束为 3 价值 + 入驻 CTA。
- **文件**: `index.html`、`css/style.css`、`css/animations.css`、`merchant.html`、`README.md`

### 2026年7月 - 替换 App 截图与「怎么玩」结构
- **变更**: 首页「怎么玩」改为 1 张主图 + 4 张功能卡片，使用 `images/screenshots/` 下 5 张新截图。
- **文件**: `index.html`、`css/style.css`、`css/animations.css`、`images/README.md`、`images/screenshots/README.md`

### 2025年1月 - 下载按钮添加"即将上线"标识并禁用点击
- **变更**: 为首页所有下载按钮（Hero区域和Footer区域）添加"即将上线"徽章标识，并禁用所有按钮的点击跳转功能
- **实现方式**: 
  - 使用 `.download-btn-wrapper` 包装器包裹每个按钮和徽章
  - 将"即将上线"徽章定位在按钮上方居中（使用绝对定位 + `left: 50%; transform: translateX(-50%)`），避免挤压按钮间的间距
  - 徽章使用主题橙色(#F4B400)作为背景和边框，黑色文字，带阴影效果
  - 将所有按钮的 `href` 改为 `javascript:void(0);`，并添加 `pointer-events: none` 和 `cursor: default` 样式禁用点击（不改变按钮透明度）
  - 在 `js/main.js` 中注释掉所有下载按钮的点击事件监听器（App Store、Android、小程序）
  - 添加移动端响应式样式，确保徽章在小屏幕上也能正确显示
- **影响范围**: 首页Hero区域和Footer区域的所有下载按钮（App Store、Android、小程序），按钮不可点击但保持正常视觉效果
- **文件修改**: 
  - `index.html` 第44-60行、第275-291行（添加包装器和徽章，注释原链接）
  - `css/style.css` 第419-423行（按钮包装器样式）、第425-437行（禁用按钮样式）、第464-481行（徽章样式）、第539-551行（移动端样式）
  - `js/main.js` 第213-243行（注释掉按钮点击事件）

### 2025年1月 - 首页导航精简
- **变更**: 去掉首页右上角导航中的「For用户」「For商户」两个链接，仅保留「商户入驻」。
- **文件修改**: `index.html` 导航栏 `nav-links` 内移除两个锚点。

### 2025年1月 - 下载按钮文字颜色统一
- **问题描述**: 用户要求将所有页面的下载按钮中的安卓和小程序都改成黑色字
- **解决方案**: 修改CSS样式，统一按钮文字颜色
  - 将 `.android-btn` 的文字颜色从白色改为黑色 (`#000000`)
  - 将 `.wechat-btn` 的文字颜色保持为黑色 (原本就是黑色)
  - 同时更新footer部分的hover状态颜色
  - **修复遗漏**: 为footer部分的下载按钮添加专门的样式覆盖，确保安卓和小程序按钮显示为黑色文字
- **影响范围**: 影响所有页面的下载按钮显示，包括首页和商户入驻页
- **文件修改**: `css/style.css` 第430行、第846行、第850行、第838-842行

### 2025年1月 - 移动端商户板块居中优化
- **问题描述**: 首页"For商户"板块在移动端模式下，6个项目的图标和标签不居中
- **解决方案**: 在CSS中添加了移动端特定的样式规则
  - 为 `.merchant-icon` 添加 `margin-left: auto; margin-right: auto;` 实现图标居中
  - 为 `.merchant-benefit` 添加 `justify-content: center;` 实现标签居中
- **影响范围**: 仅影响移动端显示，桌面端不受影响
- **文件修改**: `css/style.css` 第1020-1026行

### 2025年11月 - 下载入口与分发逻辑升级
- **变更**: 
  - 移除首页右下角浮动二维码入口，下载引导集中到导航按钮与专用页面。
  - 首页、页脚与商户页的 App Store 按钮直连 `https://apps.apple.com/cn/app/id741292507`。
  - Android 按钮根据是否在微信内打开分别跳转 `android-guide.html` 或直接下载 `小红书.apk`。
  - 小程序按钮在桌面端悬停展示二维码、移动端点击弹出指引。
  - 全新 `download.html` 提供多入口说明，同时新增 `android-guide.html` 指导微信环境的安卓下载。
  - 针对微信浏览器缓存，所有页面新增 no-cache 元标签，并为 CSS/JS/二维码资源追加版本号 `?v=20251114`（`js/main.js` 内以 `ASSET_VERSION` 常量统一管理）。
  - 新增 `ios-appstore-guide.html`，并在 `js/main.js` 中对 iOS + 微信环境下的 App Store 按钮进行引导跳转（与 Android APK 引导逻辑一致）。
- **文件修改**: `index.html`, `merchant.html`, `guide.html`, `download.html`, `android-guide.html`, `ios-appstore-guide.html`, `css/style.css`, `js/main.js`, `images/wechat-miniprogram-qr.jpg`

### 2025年1月 - 小程序通用下载引导页面优化
- **变更**: 将 `android-guide-miniprogram.html` 重构为通用的 `download-guide-miniprogram.html`，适用于 iOS 和 Android 小程序环境
- **问题描述**: 原页面仅适用于 Android，需要统一成一个通用页面，引导所有小程序用户下载应用
- **解决方案**: 
  - 重构页面为通用下载引导页面 `download-guide-miniprogram.html`
  - 修改链接为统一的下载页面 `https://nowmap.cn/download.html`
  - 用户复制链接后在外部浏览器打开，`download.html` 会根据设备类型（iOS/Android）自动处理下载
  - 移除了平台特定的逻辑（不再直接下载 APK 或跳转 App Store）
  - 修改文案，使其适用于 iOS 和 Android 用户
  - 在外部浏览器中打开时，自动跳转到 `download.html`
- **影响范围**: 
  - iOS 和 Android 小程序用户都可以使用同一个页面
  - 简化了页面逻辑，统一跳转到下载页面处理
- **文件修改**: 
  - 重构 `android-guide-miniprogram.html` 为 `download-guide-miniprogram.html`（通用版本）

### 2025年1月 - 新增微信小程序专用iOS下载引导页面
- **变更**: 新增 `ios-appstore-guide-miniprogram.html`，专门用于微信小程序环境引导用户下载 iOS 版本
- **问题描述**: 微信小程序内无法通过右上角"⋯"菜单选择在外部浏览器打开，需要引导用户复制链接后到外部浏览器打开
- **解决方案**: 
  - 创建专门的小程序引导页面 `ios-appstore-guide-miniprogram.html`
  - 修改步骤说明，改为三步操作：
    1. 复制当前页面链接（提供一键复制按钮）
    2. 打开外部浏览器（Safari 或其他浏览器）
    3. 粘贴并打开链接（在外部浏览器中会自动跳转到 App Store）
  - 添加链接复制功能：
    - 使用现代 Clipboard API（优先）或降级方案（兼容性处理）
    - 复制成功后显示提示信息
    - 复制按钮状态反馈
  - 添加小程序环境检测：
    - 检测 `window.__wxjs_environment`
    - 检测 UserAgent 中的小程序标识
    - 如果不在小程序环境中且是 iOS 设备，自动跳转到 App Store
  - 页面设计：
    - 复用 `ios-appstore-guide.html` 的视觉风格
    - 添加链接复制框和复制按钮
    - 响应式设计，适配移动端
- **影响范围**: 
  - 小程序用户可以通过新页面引导完成 iOS 应用下载
  - 如果在外部浏览器中打开该页面，会自动跳转到 App Store
  - 不影响现有的 `ios-appstore-guide.html` 页面
- **文件修改**: 
  - 新增 `ios-appstore-guide-miniprogram.html`

### 2025年1月 - Android下载功能恢复
- **变更**: Android 客户端已上线，恢复 Android 下载功能
- **解决方案**: 
  - 修改 `download.html`：
    - 恢复 Android 下载按钮的 HTML
    - 添加 Android 设备检测逻辑，Android 设备显示 Android 下载按钮
    - 添加 Android 按钮点击事件处理
    - 添加 Android 自动下载逻辑：在微信内跳转到 `android-guide.html`，在外部浏览器直接下载 APK
    - 移除"即将上线"提示框的显示逻辑
    - 桌面端显示 iOS 和 Android 两个下载按钮
  - 修改 `android-guide.html`，恢复下载功能：
    - 恢复下载步骤说明和下载按钮
    - 添加自动下载逻辑：在第三方浏览器中打开时自动下载 APK
    - 移除"即将上线"提示内容
- **影响范围**: 
  - Android 用户可以正常下载 APK
  - 在微信内会引导用户到外部浏览器下载
  - 在外部浏览器中会自动开始下载
- **文件修改**: `download.html`（恢复 Android 下载功能）、`android-guide.html`（恢复下载功能）

### 2025年1月 - Android下载功能暂时禁用（已废弃）
- **变更**: 暂时禁用 Android 下载功能，因为 Android 客户端尚未上线，直接从下载页面移除 Android 按钮并显示"即将上线"提示
- **问题描述**: Android 客户端还在开发中，需要暂时禁用下载功能，直接在下载页面告诉用户尚未上线
- **解决方案**: 
  - 修改 `download.html`：
    - 从 HTML 中完全移除 Android 下载按钮
    - 添加"即将上线"提示框（使用主题黄色样式，包含沙漏图标）
    - 当检测到 Android 设备时，隐藏 iOS 按钮，显示"Android 版本即将上线"的提示框
    - 当检测到桌面设备时，显示 iOS 按钮和"即将上线"提示框
    - 移除所有 Android 相关的下载逻辑和常量
  - 修改 `android-guide.html`，将页面内容改为显示"Android 版本即将上线"的提示（作为备用页面保留）
    - 移除所有下载相关的步骤和下载按钮
    - 添加"即将上线"提示框，使用主题黄色样式
    - 添加 Font Awesome 图标库引用以显示沙漏图标
    - 移除所有下载相关的 JavaScript 代码
- **影响范围**: 
  - Android 用户在下载页面会直接看到"即将上线"的提示，不再显示下载按钮
  - 所有 Android 下载功能已暂时禁用
  - iOS 下载功能不受影响
- **文件修改**: `download.html`（移除 Android 按钮，添加"即将上线"提示框）、`android-guide.html`（完全重构为提示页面）

### 2025年1月 - iOS和Android下载页面自动跳转/下载优化
- **变更**: 优化 iOS 和 Android 下载流程，当用户在第三方浏览器（非微信浏览器）中打开引导页面时，自动跳转到 App Store 或自动下载 APK
- **问题描述**: 
  - iOS: 用户在微信中打开下载页面后，根据指引在第三方浏览器中打开，但页面没有自动跳转到 App Store，需要用户手动点击按钮
  - Android: 用户在微信中打开下载页面后，根据指引在第三方浏览器中打开，但页面没有自动下载 APK，需要用户手动点击按钮
- **解决方案**: 
  - **iOS (`ios-appstore-guide.html`)**: 添加自动检测逻辑
    - 检测当前浏览器环境（是否为微信浏览器）
    - 检测设备类型（是否为 iOS 设备）
    - 如果不在微信浏览器中且是 iOS 设备，页面加载后自动跳转到 App Store（延迟 500ms 确保页面加载完成）
    - 如果仍在微信浏览器中，则显示指引内容，提示用户在第三方浏览器中打开
  - **Android (`android-guide.html`)**: 添加自动检测和下载逻辑
    - 检测当前浏览器环境（是否为微信浏览器）
    - 检测设备类型（是否为 Android 设备）
    - 如果不在微信浏览器中且是 Android 设备，页面加载后自动触发 APK 下载（延迟 500ms 确保页面加载完成）
    - 如果仍在微信浏览器中，则显示指引内容，提示用户在第三方浏览器中打开
    - 更新步骤说明，将"点击下载按钮"改为"自动开始下载"
- **影响范围**: 
  - iOS 用户在第三方浏览器中打开 `ios-appstore-guide.html` 时会自动跳转到 App Store
  - Android 用户在第三方浏览器中打开 `android-guide.html` 时会自动开始下载 APK
  - 提升用户体验，减少用户操作步骤
- **文件修改**: `ios-appstore-guide.html`（添加自动跳转逻辑）、`android-guide.html`（添加自动下载逻辑和更新文案）

### 2025年1月 - 新增用户注销协议页面
- **变更**: 新增 `user-delete.html` 用户注销协议页面
- **实现方式**: 
  - 参考 `user.html` 的样式和结构，保持视觉一致性
  - 将 `用户注销协议.md` 中的内容转换为 HTML 格式
  - 使用相同的 CSS 样式类（highlight、intro、contact 等）突出重要信息
  - 包含账号注销的含义、不可逆性、权益处理、数据删除、责任说明等七个章节
- **影响范围**: 新增独立页面，不影响现有功能
- **文件修改**: 
  - 新增 `user-delete.html`
  - 更新 `README.md` 项目结构和页面说明
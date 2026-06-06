# 后台批量导入 —— 用户 / 商户 / 气泡 数据关系

本目录脚本：

- [`user/main.go`](user/main.go) —— 批量导入【用户】（气泡发布者；内置按手机号查重）
- [`merchant/main.go`](merchant/main.go) —— 批量导入【商户】
- [`now/main.go`](now/main.go) —— 批量导入【气泡 NOW】
- [`query/main.go`](query/main.go) —— **查询 / 对比工具**：登录、查用户列表、查商户列表、查气泡列表、关键词查 POI（给爬虫查重核对用，见第十二节）

> 一条龙顺序：**查重 → 建用户 → 建商户 → 建气泡**。四个工具都只依赖 Go 标准库，可直接 `go run`。

---

## 一、三个实体

| 实体 | 表 | 说明 |
|---|---|---|
| 用户 User | `bi_users` | 一切的基础；**每条气泡都必须由某个用户发布**。 |
| 商户 Merchant | `bi_merchants` | 可选实体；门店/品牌。一个商户可有多个员工用户。 |
| 气泡 Bubble(NOW) | `bi_user_now` | 由用户发布的动态/邀约/预约；可选地挂在某个商户名下。 |

---

## 二、核心关系（一句话）

> **气泡都是用户发的。用户可以没有商户，也可以带商户。气泡通过 POI 决定挂不挂商户。**

```
            bi_merchant_staffs                       POI 精确匹配
            (店长/管理员，多对多)        location_poi_id == address_poi_id
   用户 User ───────────────┐         ┌────────────────────────────── 商户 Merchant
      │                     │         │                                   (bi_merchants)
      │ user_id (必填,发布者) │         │ now_merchant_id (可选,自动算出)
      ▼                     ▼         ▼
                       气泡 Bubble (bi_user_now)
```

两条**完全独立**的关联线，别搞混：

1. **用户 ↔ 商户**：通过 `bi_merchant_staffs` 表（`merchant_id` + `user_id`，Role：1=店长/Owner，2=管理员/Admin）。
   建商户时由 `operator_user_id`（店长）和 `admin_ids`（管理员）写入。
   用户表 `bi_users` 里**没有**商户字段——是否“带商户”取决于这张关联表里有没有他的记录。

2. **气泡 ↔ 商户**：**只**通过 POI 精确匹配（`WHERE address_poi_id = location_poi_id`，见 [`bi_merchants.go:23`](../../app/dao/bi_merchants.go#L23)）。
   命中则把商户 id 写进气泡的 `now_merchant_id`；**接口里没有 merchant_id 字段**，POI 是唯一挂靠方式。
   - **谁发的 ≠ 挂哪个商户**：即使发布者是某商户的店长，气泡也**不会**自动挂到该商户；
     必须让气泡的 `location_poi_id` 等于该商户的 `address_poi_id` 才会挂上。

---

## 三、四种组合（按这个判断每条数据怎么填）

| 场景 | 发布者 user_id | location_poi_id | 结果 |
|---|---|---|---|
| 个人用户发个人气泡 | 该用户 | **留空** | 不挂商户（`now_merchant_id` 为空） |
| 个人用户发的气泡恰在某商户位置 | 该用户 | = 该商户 POI | 自动挂到该商户 |
| 商户的气泡 | 该商户的店长/某用户 | = 该商户 POI | 挂到该商户 |
| 商户的气泡但临时不想挂 | 任意用户 | 留空 | 不挂商户 |

> **POI 留空是合法选择**：表示“这条气泡不挂任何商户”，由导入方/后台自行决定。

---

## 四、POI 是什么 / 谁提供

- POI（`address_poi_id` / `location_poi_id`）是**外部地图（高德/腾讯等）的 POI 标识**，**后端不生成，需数据方提供**。
- 它对“建商户/建气泡”本身**可选**，留空也能建成功。
- 但它是**气泡挂商户的唯一键**：想让一个商户和它的多条气泡关联起来，
  就让它们**用同一个 poi 值**（建商户填的 `address_poi_id` == 建气泡填的 `location_poi_id`）。
- 没有真实 POI 时，可自造“稳定且每商户唯一”的字符串（如 `crawl_<来源>_<商户key>`），只要商户与其气泡一致即可。
  仅当需要和 App 真实地图/附近功能对齐时，才必须用真实 POI id。
- ⚠️ **切勿用空串去匹配**：`GetByPoiID("")` 会命中第一条 poi 为空的商户造成误挂；脚本已规避（仅在非空时发送）。
- 经纬度 `longitude/latitude` 与 POI 是两回事，用于 geohash/距离/地图，建议都给真实值，不能用 POI 代替。

---

## 五、推荐导入顺序

```
1) 用户 User    —— 先确保有可用的 user_id（已有用户，或先批量建）
2) 商户 Merchant —— 需要挂商户的，先建好，记下其 poi 值
3) 气泡 Bubble   —— 用 user_id 发布；要挂商户就把 location_poi_id 填成对应商户的 poi
```

抓取数据建议的最小约定：

- 每个商户给一个**稳定且唯一**的 `poi`（真实 POI 优先，没有就自造）。
- 该商户名下每条气泡**复用同一个 poi**；个人气泡 `poi` 留空。
- 商户、气泡都提供真实 `lng/lat`。
- 每条气泡指定一个已存在的 `user_id` 作为发布者。

---

## 六、媒体宽高（务必看）

`POST /internal/upload` 返回的 `width/height` **必须**随 `medias`/`now_medias` 一起回传创建接口。

后台创建只把媒体数组**原样存库**，App 端读取也只信存库 JSON，**不会按 media_id 回补宽高**；
不发就永久存成 `0×0`，导致图片比例渲染错乱。两个脚本已自动带上 upload 返回的宽高。

> 视频宽高由 OSS 截帧识别，偶发为 0，必要时在输入数据里手填覆盖。
> `now_medias` 里**第一张图片**会被后端自动取为封面 `now_cover`。

---

## 七、关键字段速查

**用户 `POST /internal/users`**（DTO：[`admin_user.go`](../../app/dto/admin_user.go#L18)）

| 字段 | 必填 | 说明 |
|---|---|---|
| `phone` | ✅ | 手机号，**全局唯一**（重复必冲突；脚本默认按手机号查重跳过） |
| `nickname` | 否 | 昵称 |
| `avatar` | 否 | 头像 URL（脚本里由 `avatar_image` 上传得到） |
| `gender` | 否 | 0未知 / 1男 / 2女 |
| `description` | 否 | 简介 |
| `birthday` | 否 | **Unix 秒** |
| `status` | 否 | 0默认正常 / -1禁用 |
| `medias` | 否 | 用户相册，元素含 `media_id/media_url/media_type/width/height` |

**商户 `POST /internal/merchants`**（DTO：[`admin_merchant.go`](../../app/dto/admin_merchant.go#L51)）

| 字段 | 必填 | 说明 |
|---|---|---|
| `type` | ✅ | 商户类型 id，取自 `/internal/merchant-types/list` |
| `longitude` / `latitude` | ✅ | 经纬度，后端自动算 geohash |
| `address_poi_id` | 否 | 外部 POI，挂气泡的关联键 |
| `logo` | 否 | logo 图 URL，默认 `-` |
| `medias` | 否 | 相册，元素含 `media_id/media_url/media_type/width/height` |
| `status` | 否 | 0待审 / 1正常 / 2正常 / -1禁用 |
| `operator_user_id` | 否 | 店长用户 id（写 `bi_merchant_staffs`，Role=Owner） |
| `admin_ids` | 否 | 管理员用户 id 列表（Role=Admin） |

**气泡 `POST /internal/nows`**（DTO：[`admin_now.go`](../../app/dto/admin_now.go#L21)）

| 字段 | 必填 | 说明 |
|---|---|---|
| `user_id` | ✅ | 发布者，必须是**已存在**的用户 |
| `now_type` | ✅ | 1动态 / 2即刻邀约 / 3预约 |
| `now_medias` | 否 | 媒体数组（同上，含宽高）；首图自动作封面 |
| `location_poi_id` | 否 | 命中商户 `address_poi_id` 则挂该商户 |
| `location_name` / `location_address` | 否 | 地点名 / 详细地址 |
| `location_latitude` / `location_longitude` | 否 | 经纬度，用于距离/地图 |
| `now_status` | 否 | 1正常（默认） / -1屏蔽 |
| `now_weight` | 否 | 权重，默认 100 |
| `start_at` / `created_at` / `expired_at` | 否 | 格式 `2006-01-02 15:04:05` |

---

## 八、鉴权

所有接口在 `{BASE}/internal` 下。两种鉴权任选：

- `Authorization: Bearer <token>` —— token 来自 `POST /internal/auth/login` `{username,password}`
- `USER: <admin_id>` —— 直接传管理员数字 id 免登录

脚本用 Bearer：`-token` 直接给，或留空用 `-user/-pass` 自动登录换取。

- 成功响应是 `{"code":0,"message":"success","data":{...}}` —— 判成功看 **`code==0`**（不是 HTTP 200，HTTP 永远是 200；失败时 `code` 非 0、`message` 是原因）。
- 后台 token 目前**不设过期**（`CreateAdminToken` 未写 `ExpiresAt`），但模型支持过期，别假设永久有效。

---

# ⚠️ 爬虫必读：最容易踩的三个坑

> 下面三条不注意，数据会“看起来导进去了但其实是错的/看不到的”，务必先读。

### 坑 1：坐标系是 GCJ-02（火星坐标），不是 GPS/WGS-84

- 全站只接入**腾讯地图**，且后端**没有任何坐标转换代码**（grep `gcj/wgs/bd09/transform` 全空）。POI/经纬度来自腾讯地图 API → 原样入库 → 再用腾讯地图前端渲染，所以**全链路用的是 GCJ-02**。
- 数据库列虽标了 `SRID 4326`，那只是 MySQL 几何列的**标签**，不代表数据真是 WGS-84；存进去的值就是你发的值，不做纠偏。
- **给爬虫的结论：**
  - 从**高德 / 腾讯 / 大众点评 / 美团**抓的经纬度**本身就是 GCJ-02 → 直接用，不要转换**。
  - 拿到的是 **GPS / WGS-84 原始坐标**（少数海外源、设备原始 GPS）→ **先转 GCJ-02 再导**。
  - 拿到的是**百度 BD-09**（百度系数据）→ **先 BD-09 → GCJ-02 再导**。
  - 用错坐标系会整体偏移约 **50–100 米**，且地图网格/距离都跟着错，**后端不会帮你纠**。
- 顺序固定 **经度在前、纬度在后**（`longitude`, `latitude`）；范围校验 `lng ∈ [-180,180]`、`lat ∈ [-90,90]`；存储保留 6 位小数（约 0.1m）。

### 坑 2：气泡默认次日凌晨 4:00 就过期 → 地图上看不到

- 不传 `expired_at` 时，后端默认过期时间 = **创建日的次日凌晨 4:00**（`getDefaultExpireTime`，[now.go:1148](../../app/service/now.go#L1148)）。
- 有个 cron（每分钟级）把 `expired_at < now` 的气泡置为 `now_status = -2`（已过期）。
- **地图模式**查询很严：必须 `now_status=1` 且 `show_status=1` 且 `expired_at > now`，所以**过期气泡在地图上直接消失**（卡片列表仍可能显示，但那不是主入口）。
- **给爬虫的结论：导入气泡必须显式把 `expired_at` 设到远期**（如 +30 天或更久），否则第二天早上就从地图消失了。
  - `now/main.go` 已做兜底：**输入里没填 `expired_at` 时，脚本自动设为 +30 天**（见脚本里 `defaultExpireDays`），但仍建议数据方自己给准确值。
- 同时确保：`now_status=1`（脚本默认）、发布者用户正常（`status` 不为 -1）、`created_at` 用真实时间。

### 坑 3：接口不幂等，重复导入会产生重复数据 / 报唯一键冲突

- 每次创建都用**随机 UUID 现生成新 id**，服务端**不做“先查后插”**，接口也**不接受**你指定 `merchant_id/user_id/now_id`。
- 所以**重复跑同一批数据会**：
  1. 生成**一堆重复的商户/用户/气泡**（id 不同、内容相同）；
  2. **同一手机号**再建用户 → 命中 `bi_auth(auth_type,auth_id)` 唯一索引 → **报错**；
  3. **同一 (商户, 用户)** 再加 staff → 命中 `bi_merchant_staffs` 唯一索引 `uqi_mu` → **报错**。
- **给爬虫的结论：自己维护“源数据 → 已创建 id”的映射（状态文件 / 小表），导入前先查重：**
  - 用户：`POST /internal/users/list`（keyword 支持 user_id/昵称/手机号）按**手机号**查；
  - 商户：`POST /internal/merchants/list`（keyword 支持名称/merchant_id）按**名称或 poi** 查；
  - 气泡：`POST /internal/nows/list`（支持 now_id / keyword）按 **user_id + 标题** 查。
  - 命中则**跳过**，或改调 `PUT`（更新）而不是再次 `POST`（新建）。脚本会把每条结果的 id 写到 `*.result.json`，可作为去重台账的起点。

> 补充坑：**用户创建不是事务的** —— 后端先插 `bi_users` 再插 `bi_auth`。若手机号已存在，`bi_auth` 撞唯一键报错，但 **`bi_users` 那行已经提交**，留下一条**没有认证记录的“幽灵用户”**。
> 所以**建用户前务必先按手机号查重**（`user` 脚本默认做了），**失败别盲目重试**；要清理幽灵用户可用 `DELETE /internal/users/:id`（会一并删 `bi_auth`+token，释放手机号）。

### 坑 4：商户 `status` 和 `is_verified` 不都为 1，就在 C 端看不见

- C 端「附近 / 地图」商户查询要求 **`status=1` 且 `is_verified=1`**（`bi_merchants.go` 的 `ListByLocation/ListAllByLocation`）。
- 商户创建接口对这俩**默认 0**（待审 / 未认证）→ 输入里漏填就建出一个**存在、能查重、但 C 端永远不显示**的商户。
- **结论：导入商户务必 `status=1` + `is_verified=1`。** `merchant` 脚本已做兜底：输入里这两个字段**留空就默认 1**（想压成 0 要显式写 0）。
- 注意各查询过滤不一致：搜索/地图网格只看 `status=1`，但「附近」两个接口同时要 `is_verified=1`，以最严的为准 → 都给 1 最省心。

---

## 九、字段校验与限制（提交前自查）

| 接口 | 字段 | 规则 |
|---|---|---|
| 气泡 | `now_title` | **DB 上限 128 字符**（接口 binding 写的是 255 → 129~255 能过校验但入库**静默截断到 128**！脚本已自动截断） |
| 气泡 | `now_content` | 最长 **2000**（`text` 列，2000 是 binding 限制） |
| 气泡 | `now_type` | 必填，仅 **1/2/3**；爬来的内容用 **1（动态）** 最稳，见下方说明 |
| 气泡 | `user_id` | 必填，且**必须已存在**（否则 `user not found`） |
| 商户 | `type` / `longitude` / `latitude` | 三者必填 |
| 商户 | `type` | 必须是 **已存在**的商户类型 id（`query merchant-types` 查，见第十二节） |
| 商户 | `name` | 接口**不强制**，但它是按名称查重的主键 → 脚本侧**强制非空且 ≤64**（DB 上限 64） |
| 商户 | `status` / `is_verified` | **都要 = 1**，否则商户在 C 端地图/附近不可见（脚本留空默认 1，见坑 4） |
| 用户 | `phone` | 必填，**全局唯一**（重复必冲突；DB 上限 32） |
| 用户 | `birthday` | **Unix 秒**（不是毫秒），可空 |
| 用户 | `gender` | 0未知 / 1男 / 2女，默认 0 |
| 时间 | `start_at`/`created_at`/`expired_at` | `2006-01-02 15:04:05` 或 RFC3339，见下方**时区**说明 |
| 文本 | 标题/内容/昵称/简介 | 支持 UTF-8 + emoji；**后端不做 HTML/XSS 转义**，前端展示需自行转义，别塞脚本标签 |

**各文本字段的 DB 列长度上限**（超出会**静默截断**，接口大多无校验，务必自查）：

| 字段 | 上限(字符) | 字段 | 上限(字符) |
|---|---|---|---|
| 用户 `nickname` | 64 | 商户 `name` | 64 |
| 用户 `phone` | 32 | 商户 `name_new` | 255 |
| 用户 `avatar` | 512 | 商户 `address` | 128 |
| 用户 `description` | 512 | 商户 `description` / `logo` | 512 |
| 气泡 `now_title` | **128** | 商户 `address_poi_id` | 255 |
| 气泡 `now_address` | 128 | 气泡 `now_address_name` | 255 |

> ⚠️ **时区坑**：时间字符串按**服务器进程的本地时区**（Go `time.Local`，取决于容器 `TZ`）解析，**不是**写死的 Asia/Shanghai。
> 若部署容器 `TZ=UTC`，你发的 `expired_at`/`start_at` 会被当成 UTC、整体差 8 小时。
> **最稳做法：发 RFC3339 带时区偏移**（如 `2026-06-12T12:00:00+08:00`），两条解析路径都支持，彻底消除歧义。

**now_type 说明（导入路径 `POST /internal/nows`，不是 C 端发帖）**：
- **type 1（动态）**：纯内容气泡，**无需任何额外字段**，爬虫内容首选。
- **type 3（预约）**：导入接口**不强制 start_at**（C 端发帖才强制），但**建议传 start_at**，因为 cron `NowsTypeChange` 按它转换类型。
- 报名/付费/名额（enroll/fee/max_enroll）**导入接口一律不支持**，只能 C 端配置 → 爬虫别期望能设这些。

---

## 十、媒体 / 上传规则（POST /internal/upload）

- **字段名必须是 `file`**，`multipart/form-data`。视频要把分片的 `Content-Type` 设成 `video/*`，后端据此区分图/视频（脚本已按扩展名自动设置）。
- **支持格式**：图片 jpg/png/heic/gif/webp，视频 mp4/mov。**HEIC 自动转 jpg**；png 保持 png。
- **文件大小**：上传无显式上限 → 走 **gin 默认 32MB**，超过会被拒。大图/长视频先压缩到 32MB 内（没有分片上传）。
- **图片安审是同步阻塞的**：涉黄/涉暴/涉政等高风险会被阿里云安审判定 `high`，**当场从 OSS 删除并返回“文件未通过安审”**。爬来的图务必先自检，过不了审的会整条失败。
- **视频安审是异步的**：上传**立即返回**但 `audit_status=Auditing`，要等回调才确认；**过审前媒体不保证可用**、不过审会被回调删除。导入视频后别立刻当成已生效。
- 返回 `media_url` 是 OSS/CDN 地址；**宽高由后端从 OSS 自动识别**（图片用 `image/info`，视频截首帧），无需你算——但**必须把返回的宽高回传创建接口**（见第六节）。
- 缩略图不在上传时生成，读取时由 OSS 处理参数按需生成，无需关心。

---

## 十一、推荐的健壮导入流程（含查重）

```
0. 建发布者用户（user/main.go，内置按手机号查重）：
     按手机号查 users/list；命中则复用 user_id，否则上传头像 → 建用户 → 记 user_id

对每个商户 M：
  1. 用 M 的名称/poi 查 merchants/list；已存在则跳过/更新，否则：
       上传 logo+相册 → 建商户(带 type/lng-lat(GCJ-02)/poi/medias含宽高) → 记 merchant_id
  对该商户的每条气泡 N：
     2. 用 user_id+标题 查 nows/list；已存在则跳过，否则：
          上传图片(过审) → 建气泡(user_id / now_type / now_medias含宽高 /
                            location_poi_id=该商户poi / expired_at远期) → 记 now_id

把所有 (源key → 新id) 写进台账（各脚本输出的 *.result.json 即起点），供下次增量导入查重。
```

对应命令：

```bash
go run ./scripts/import/user     -token "$BUZZ_TOKEN" -f scripts/import/user/sample.json
go run ./scripts/import/merchant -token "$BUZZ_TOKEN" -f scripts/import/merchant/sample.json
go run ./scripts/import/now      -token "$BUZZ_TOKEN" -f scripts/import/now/sample.json
```

**三个导入脚本已内置的健壮性**（无需额外配置）：

- **查重默认开**（`-dedup=true`，可 `-dedup=false` 关）：用户按手机号、商户按 名称(+poi)、气泡按 user_id+标题 先查后建，**重复跑安全**、结果区分「新建/跳过」。
- **入参先校验、不白传图**：商户 `type/经纬度` 为 0、`name` 为空/超 64 → 直接报错跳过（避免后端 400）；`now_title`/`now_content`/`nickname` 超 DB 上限 → rune 安全自动截断；商户 `extra` 非法 JSON → 报错。
- **HTTP 60s 超时**：后端无响应不会整批卡死。
- **气泡 `expired_at` 留空兜底 +30 天**（避免次日 4:00 过期）；商户 `status/is_verified` 留空默认 1（避免不可见）。

> 仍建议**单线程顺序**跑（坑见第十四节：MySQL 连接池小 + 图片安审限速）。

---

## 十二、查询 / 对比接口（爬虫查重核对用）

> 路由前缀要分清：**后台接口在 `{BASE}/internal/*`**；C 端 App 接口在 `{BASE}/api/v1/*`。
> 下面除 POI 搜索外都是后台接口，需 `Authorization: Bearer <token>`。
> 这些都已封装进 [`query/main.go`](query/main.go)，可直接命令行调用。

### 1) 后台登录 `POST /internal/auth/login`

请求（JSON）：

```json
{ "username": "admin", "password": "******" }
```

响应 `data`：`{ "token": "1|xxxxx", "admin": { "id":1, "username":"...", "role":"...", ... } }`
token 即后续所有后台接口的 Bearer 凭证。

```bash
go run ./scripts/import/query login -admin-user admin -admin-pass '******'
# 打印 token，可 export BUZZ_TOKEN=... 供后续命令复用
```

### 2) 后台用户列表 `POST /internal/users/list`

请求：

| 字段 | 说明 |
|---|---|
| `page` / `size` | 分页（默认 1 / 20） |
| `keyword` | 模糊匹配 **user_id / 昵称 / 手机号** |
| `user_id` | 精确匹配某用户 id |
| `status` | 用户状态筛选（可选） |
| `is_authenticated` | 是否实名（可选 bool） |

响应 `data`：`{ "list": [AdminUserItem...], "pagination": { "total", "current_page", "per_page" } }`
`AdminUserItem`：`user_id / nickname / avatar / gender / phone / status / created_at / birthday / merchants[] / medias[]`。

```bash
# 按手机号查重（建用户前先查）
go run ./scripts/import/query users -token "$BUZZ_TOKEN" -keyword 13800138000
```

> 用户没有“按手机号唯一查询”的专用接口，用 `keyword` 传手机号即可（后端按 user_id/昵称/手机号 LIKE）。

### 3) 后台商户列表 `POST /internal/merchants/list`

请求：`page` / `size` / `keyword`（匹配 **名称 / merchant_id**）/ `status`（可选）。
响应 `data`：`{ "list": [AdminMerchantItem...], "pagination": {...} }`
`AdminMerchantItem`：`merchant_id / name / name_new / type / logo / longitude / latitude / address / address_poi_id / status / score / is_verified / medias[] / staffs[] / created_at`。

```bash
# 建商户前按名称查重；拿到的 address_poi_id 也能反查
go run ./scripts/import/query merchants -token "$BUZZ_TOKEN" -keyword 星巴克
```

> ⚠️ `merchants/list` 的 keyword **不匹配 address_poi_id**。要按 poi 对比，先拉列表再在本地按 `address_poi_id` 过滤，或维护自己的 `poi→merchant_id` 台账。

### 3.5) 商户类型列表 `POST /internal/merchant-types/list`

建商户的 `type` 字段必须是这里返回的某个 **`id`**（注意返回里 `type` 字段值就等于 `id`）。
响应 `data`：`{ "list": [ { id, type, name, sort, icon } ] }`。

```bash
go run ./scripts/import/query merchant-types -token "$BUZZ_TOKEN"
# 打印 id / type / name，建商户时 type 填某个 id
```

### 4) 后台气泡列表 `POST /internal/nows/list`

请求：`page` / `size` / `keyword`（**标题/内容**，不匹配用户）/ `now_id` / `user_identifier`（用户 id 或昵称）/ `status`（仅 **1 正常 / -1 屏蔽**）/ `type`（1/2/3）/ `expired`（0/1）。
响应 `data`：`{ "list": [AdminNowItem...], "pagination": {...} }`（含 `now_id / now_title / now_type / now_medias / user / merchant / location_* / expired_at` 等）。

```bash
# 查某用户已发的气泡，避免重复导入
go run ./scripts/import/query nows -token "$BUZZ_TOKEN" -user-identifier <user_id>
```

### 5) 关键词查 POI 列表（腾讯地图 WebService，**非后台接口**）

后台**没有**给爬虫用的 POI 搜索接口（前端选点直接 JSONP 调腾讯地图；后端 `POST /api/v1/location/search` 是 C 端接口，需 C 端鉴权）。
**服务端爬虫直接调腾讯位置服务 WebService 最稳**，返回的就是系统在用的同源 POI（id 即 `address_poi_id`，坐标即 **GCJ-02**）：

```
GET https://apis.map.qq.com/ws/place/v1/search
    ?key=<腾讯位置服务key>
    &keyword=<关键词>
    &boundary=region(<城市>,1)
    &page_size=10&page_index=1
```

响应每条：`{ id, title, address, tel, category, location:{ lat, lng } }` —— 把 `id→address_poi_id/location_poi_id`、`title→name`、`address→address`、`location.lng/lat→longitude/latitude` 填进导入数据即可。

```bash
# key 已内置（与前端同源），-city 默认 全国；要换自己的 key 用 -map-key
go run ./scripts/import/query poi -keyword=星巴克 -city=北京
```

> **key 已内置**在 `query` 工具里（`KRABZ-...`，与前端 ant-buzzin 同源）。**服务端调用只需 key、不需要 SK 签名**（后端 `tencentmap.go` 也只传 key）。
> 量大或要独立配额时用 `-map-key`（或 `BUZZ_TENCENT_MAP_KEY`）换成你自己的（lbs.qq.com 申请，注意把 key 的「WebServiceAPI」打开、按需关掉域名白名单）。
> 拿到的坐标天然是 GCJ-02，正好对应坑 1，无需转换。

### 6) 地址查经纬度（腾讯 Geocoder，**只有文本地址、没有 POI 时用**）

```bash
go run ./scripts/import/query geocode -address="北京市海淀区中关村大街1号" -city=北京
# 返回 GCJ-02 经纬度 + 省/市/区 + reliability；注意它【不返回 poi_id】，要 poi 用 query poi
```

---

## 十三、增量同步 / 更新 / 删除（第二次及以后的爬取）

接口**不幂等**（坑 3），所以「保持同步」必须靠**外部台账**驱动：

### 台账是必需基础设施（不是可选）

- 维护一张你自己的表：`(source_key, entity_type, entity_id, content_hash, last_seen_at)`。
- 因为**只有商户有可写的 `extra` 字段**（可塞 `source_id` 做服务端冗余面包屑）；**用户的 `extra` 不对外开放、气泡根本没有 `extra` 字段** —— 所以源 id↔实体 id 的映射只能存在你这边。
- **台账要持久化 + 备份**：丢了就只能靠模糊匹配找回（用户按手机号 `users/list`、气泡按 `user_id+标题` `nows/list`、商户按 名称/poi `merchants/list`），且很容易造成大量重复。

### 建 vs 改 的决策

```
对每条源数据：
  在台账查 source_key
    └─ 没有        → POST 新建，记 (source_key→entity_id, content_hash)
    └─ 有且 hash 变 → PUT 更新（见下 PUT 语义），更新 content_hash
    └─ 有且 hash 同 → 跳过
  源里消失的记录 → 不要硬删，建议置 status/now_status = -1（下架）保留痕迹
```

> 更新前可先 GET 详情比对，避免覆盖掉后台人工改过的字段（drift）。

### PUT 更新语义（重要）

| 接口 | 路由 | 关键语义 |
|---|---|---|
| 用户 | `PUT /internal/users/:id` | **`user_id` 必须放进 body**（控制器用 body 里的，不读 URL）；各标量字段是指针，nil/不传=不改；`medias` 是切片，**不传=保留、传了=整体替换**；`status=-1` 会**注销并失效该用户所有 token** |
| 商户 | `PUT /internal/merchants/:id` | 标量字段**零值=跳过**（空串/0 不会清空）；`status/longitude/latitude` 是指针；**经纬度要成对传**（只传一个被忽略）；`operator_user_id`：不传=不变、`""`=移除店长、有值=替换；`admin_ids` 传了就**整表替换**（含空数组=清空） |
| 气泡 | `PUT /internal/nows/:id` | 各字段指针，不传=不改；**`now_medias` 是指针切片：不传/null=保留、`[]`=清空、`[...]`=替换** |

> ⚠️ **商户 medias 重链坑**：`PUT` 商户时传 `medias`，后端会按 `media_id` 比对、**把缺失的旧 media 解绑**。要保留就把**完整的 medias 数组**都带上；想清空才传空。

### 删除接口（有副作用，谨慎）

| 接口 | 路由 | 副作用 |
|---|---|---|
| 删用户 | `DELETE /internal/users/:id` | 软删 `bi_users(status=-1)` + **删 `bi_auth` + 删该用户所有 token** → **释放手机号**可重新注册 |
| 删商户 | `DELETE /internal/merchants/:id` | 连带 staff / apply 等关联 |
| 删气泡 | `DELETE /internal/nows/:id` | 软删（保留行） |

---

## 十四、运维 / 吞吐 / 媒体其它坑

- **串行跑，别并发**：后端 MySQL 连接池很小（`max_open=10, max_idle=5`）。并发导入（>2 线程）易 `wait timeout`。建议**单线程顺序**导入。
- **图片安审是瓶颈**：阿里云内容安审约 **1~3 TPS**、单图同步约数秒，所以图片上传会在安审处串行变慢。**大批量请按 ≤1 张/秒 估算吞吐**；能在本地预过滤掉违规图最好。
- **token 复用**：登录一次拿到的 token **不过期、可一直复用**（每次 `login` 都会新插一行 token 记录、无清理）。所以**别每次请求都登录** —— `export BUZZ_TOKEN=...` 全程用一个。
- **没有服务端限流**，但请自觉控速；健康检查只有 `GET /ok`（仅存活探测，不查 DB/OSS）。
- **请求体上限 32MB**（gin 默认）：单文件 / 单批 JSON 都别超。
- **媒体 URL 会被清洗**：创建时 `logo/avatar/media_url` 里的 `?x-oss-process=...` 后缀会被**剥掉** → 只传 `/internal/upload` 返回的**原始 `media_url`**，别传缩略图/处理过的 URL。
- **media_id 无归属校验**：创建时只认你给的 `media_id`、不校验归属 → **只复用你自己上传得到的 media_id**，别乱填别处的，否则会把别的记录的 `bi_medias` 重指过来。`media` 里的 `target_type` 字段你不用填，后端会强制设对。
- **重复 POI 会让气泡乱挂**：`GetByPoiID` 用 `First()` 且无排序/状态过滤；若坑 3 造出两个同 `address_poi_id` 的商户，之后气泡挂哪个**不确定、还可能每次翻**。→ **台账里保证一个 poi 只对一个商户**，导气泡前先清理重复商户。


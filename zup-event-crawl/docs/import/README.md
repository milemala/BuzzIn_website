# 后台批量导入 —— 用户 / 商户 / 气泡 数据关系

本目录两个脚本：

- [`merchant/main.go`](merchant/main.go) —— 批量导入【商户】
- [`now/main.go`](now/main.go) —— 批量导入【气泡 NOW】

> 建用户暂未单独成脚本，需要时调后台 `POST /internal/users`（`phone` 必填）。

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
  - 命中则**跳过**，或改调 `PUT`（更新）而不是再次 `POST`（新建）。两个脚本会把每条结果的 id 写到 `*.result.json`，可作为去重台账的起点。

---

## 九、字段校验与限制（提交前自查）

| 接口 | 字段 | 规则 |
|---|---|---|
| 气泡 | `now_title` | 最长 **255**，超长报 400 |
| 气泡 | `now_content` | 最长 **2000**，超长报 400 |
| 气泡 | `now_type` | 必填，仅 **1/2/3** |
| 气泡 | `user_id` | 必填，且**必须已存在**（否则 `user not found`） |
| 商户 | `type` / `longitude` / `latitude` | 三者必填 |
| 商户 | `type` | 必须是 **已存在**的商户类型 id（先查 `POST /internal/merchant-types/list`） |
| 用户 | `phone` | 必填，且**全局唯一**（重复必冲突） |
| 用户 | `birthday` | **Unix 秒**（不是毫秒），可空 |
| 用户 | `gender` | 0未知 / 1男 / 2女，默认 0 |
| 时间 | `start_at`/`created_at`/`expired_at` | `2006-01-02 15:04:05`（**本地时区 Asia/Shanghai**）或 RFC3339 |
| 文本 | 标题/内容/昵称/简介 | 支持 UTF-8 + emoji；**后端不做 HTML/XSS 转义**，前端展示需自行转义，导入数据里别塞脚本标签 |

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
对每个商户 M：
  1. 用 M 的手机号查 users/list；没有则建用户(可选)，记下 user_id
  2. 用 M 的名称/poi 查 merchants/list；已存在则跳过/更新，否则：
       上传 logo+相册 → 建商户(带 type/lng-lat(GCJ-02)/poi/medias含宽高) → 记 merchant_id
  对该商户的每条气泡 N：
     3. 用 user_id+标题 查 nows/list；已存在则跳过，否则：
          上传图片(过审) → 建气泡(user_id / now_type / now_medias含宽高 /
                            location_poi_id=该商户poi / expired_at远期) → 记 now_id
把所有 (源key → 新id) 写进台账，供下次增量导入查重。
```

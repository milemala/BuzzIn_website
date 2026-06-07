# 导入工具 · 增量更新说明

> 本文件只记录**在原有三脚本（user / merchant / now）基础上新增/变更的部分**，按增量列出。
> 全量参考仍看 [README.md](README.md)。本轮重点：**IM 自动建群 + 气泡可挂 group_id（含后端改动）**。

---

## 增量 1 · 新增「IM 自动建群」工具 + 凭据 🆕

> ⚠️ 这里的“群”是**腾讯云 IM（即时通信 IM）的群**，**不是微信群**（微信不对第三方开放建群 API）。
> 建群直接调腾讯 IM REST API，用「管理员 UserSig」鉴权，与后端 `infra/pkg/tencentim.CreateGroup` 一致，
> **不依赖后台 token**，只要有 IM 的 SDKAppID + 密钥即可。新增工具：[`group/main.go`](group/main.go)。

### 凭据（key / secret，已内置默认，可覆盖）

| 项 | 值 | 来源 |
|---|---|---|
| SDKAppID | `1600107795` | `app/constat/tencentim.go` |
| IM 密钥 key | `34b157159d5b5f21c5b6b02e43d3fb4e904b1a3c68092585e9cd36b67c841b9d` | 同上（IM 控制台「密钥」，**务必保密、勿外泄/进前端**） |
| 管理员标识 identifier | `administrator` | 需在 IM 控制台配置为 App 管理员账号 |

> 覆盖：`-sdkappid` / `-key`（或 env `BUZZ_IM_SDKAPPID` / `BUZZ_IM_KEY`）。

### 鉴权机制（UserSig）

所有 IM REST 调用都带管理员 UserSig：`GenUserSig(sdkappid, key, "administrator", expire)`（腾讯官方 `tls-sig-api-v2-golang`，HMAC-SHA256 + zlib + 定制 base64）。后端对它做了 redis 缓存（1 天），本工具每次现生成。

### 建群接口

```
POST https://console.tim.qq.com/v4/group_open_http_svc/create_group
     ?sdkappid=1600107795&identifier=administrator&usersig=<管理员sig>&random=<rand>&contenttype=json
body: { "Type":"Public", "Owner_Account":"<群主user_id>", "Name":"...", "Introduction":"...",
        "Notification":"...", "FaceUrl":"...", "MaxMemberCount":200, "ApplyJoinOption":"FreeAccess" }
→ { "ActionStatus":"OK", "ErrorCode":0, "GroupId":"@TGS#xxxx" }
```

- **群类型 Type**：`Public`(陌生人社交群,默认) / `Private`(好友工作群) / `ChatRoom` / `AVChatRoom`(直播) / `Community`(社群)。
- **Owner_Account**：群主，一般填**气泡的发布者 user_id**。群主须是已存在的 IM 账号；不存在时先 `import-account` 注册（create_group 多数情况下也会自动注册群主，但保险起见可显式注册）。
- **加群成员**：后端/本工具**不做服务端拉人**（无 add_group_member 封装），成员由客户端 IM SDK 自行加入；C 端用 `POST /api/v1/msg/group/join/report` 上报加入记录 → 所以新建群默认只有群主。

### 命令

```bash
go run ./scripts/import/group create -owner <user_id> -name "示例气泡群" -type Public  # 建群→打印 group_id
go run ./scripts/import/group create -f scripts/import/group/sample.json -out groups.result.json  # 批量
go run ./scripts/import/group import-account -uid <user_id> -nick 张三 -avatar https://x/a.jpg     # 预注册群主
go run ./scripts/import/group usersig -uid <user_id>     # 生成 UserSig（调试/登录）
go run ./scripts/import/group info    -group @TGS#xxxx   # 查群信息
```

---

## 增量 2 · 后端支持气泡 `group_id`（本轮改了后端）⚙️

> 背景：之前 `POST /internal/nows` 的 DTO 没有 `group_id`，建好的群挂不上气泡。本轮已补 API 层。

| 位置 | 改动 |
|---|---|
| [`app/dto/admin_now.go`](../../app/dto/admin_now.go) | `AdminNowStoreReq` 与 `AdminNowUpdateReq` 都增 `group_id string`；响应 `AdminNowItem` 增 `group_id` |
| [`app/service/admin_now.go`](../../app/service/admin_now.go) | `Store` 写入 `entity.GroupID = in.GroupID`；`Update` 在 `in.GroupID != ""` 时落 `data["group_id"]`；`toAdminNowItem` 回填 |

- **字段类型统一为 `string`**（不是指针）。**判空字符串**：`group_id` 传空串 = 不修改。
  - 取舍：因此**无法通过 update 把 group_id 清空**（只会设、不会清）。对导入无影响；要清空再单独处理。
- **无需数据库迁移**：`bi_user_now.group_id` 列本就存在（C 端发帖在用）。
- 结果：**`POST /internal/nows` 与 `PUT /internal/nows/:id` 都能直接带 `group_id`**，响应也回该字段便于核对。

---

## 增量 3 · `now` 导入脚本支持 `group_id`

[`now/main.go`](now/main.go) 的 `NowInput` 增 `group_id` 字段并透传到创建载荷 → **建群拿到 group_id 直接填进气泡 JSON，一趟挂好，不用写库**。`now/sample.json` 也加了示例字段。

---

## 增量 4 · 完整示例：建用户 → 建群 → 建带群气泡（爬虫可直接照抄）

```bash
# 0) 凭据（IM 凭据已内置在 group 工具里，照抄即可）
export BUZZ_API_BASE="http://test-go-api.nowmap.cn"
export BUZZ_TOKEN="粘贴后台登录拿到的token"        # 或用 -admin-user/-admin-pass 登录
#   IM: SDKAppID=1600107795  Key=34b157...841b9d  identifier=administrator

# 1) 建发布者用户 → users.result.json 拿 user_id（如 U1001）
go run ./scripts/import/user -token "$BUZZ_TOKEN" -f users.json

# 2) 用该 user_id 当群主建群 → 拿 group_id
go run ./scripts/import/group create -owner U1001 -name "周末桌游局" -type Public
#   → ★ group_id=@TGS#aBcDeFg   （群主不存在加 -import-owner）

# 3) 建气泡时直接带 group_id（后端已支持，一步挂好）
cat > now1.json <<'JSON'
[{
  "user_id": "U1001",
  "now_title": "周末桌游，缺2人",
  "now_content": "周六下午老地方",
  "now_type": 1,
  "group_id": "@TGS#aBcDeFg",
  "location_poi_id": "14442523880503708595",
  "location_latitude": 39.95426,
  "location_longitude": 116.230343,
  "expired_at": "2026-07-01 12:00:00"
}]
JSON
go run ./scripts/import/now -token "$BUZZ_TOKEN" -f now1.json
go run ./scripts/import/query nows -token "$BUZZ_TOKEN" -keyword=周末桌游 | grep group_id  # 核对
```

批量版：`group create -f` 产出的 `groups.result.json`（`owner → group_id`）即回填台账，把 group_id 填进各自气泡 JSON 再跑 `now` 导入。

---

## 增量 5 · 导入脚本健壮性增强（同轮，无需配置）

三脚本（user / merchant / now）默认已具备：

- **查重默认开**（`-dedup=true`）：用户按手机号、商户按 名称(+poi)、气泡按 user_id+标题 先查后建，**重复跑安全**，结果区分「新建/跳过」。
- **入参先校验、不白传图**：商户 `type/经纬度=0` 或 `name` 空/超 64 → 报错跳过（避免后端 400）；`now_title`(128)/`now_content`(2000)/`nickname`(64) 超 DB 上限 → rune 安全截断；商户 `extra` 非法 JSON → 报错。
- **HTTP 60s 超时**：后端无响应不会整批卡死。
- **兜底默认**：气泡 `expired_at` 留空 → +30 天（避免次日 4:00 过期消失）；商户 `status/is_verified` 留空 → 1（避免 C 端不可见）。

---

## 增量 6 · `query` 工具增强

- 新增 `merchant-types` 子命令：列出可用商户类型 id（建商户 `type` 取此值）。
- 新增 `geocode` 子命令：地址 → 经纬度(GCJ-02)。
- POI/geocode 的**腾讯地图 key 已内置默认**（服务端只需 key、无需 SK），`-map-key` 可覆盖；`poi` 的 `-city` 默认全国。
- 支持 `-flag=value` 写法。

---

## 增量 7 · 气泡直挂商户 `now_merchant_id` 🆕

> 详情见 [changeLog2.md](changeLog2.md)。后台 `POST /internal/nows` 与 C 端 publish 对齐，支持可选字段 **`now_merchant_id`**。

- [`now/main.go`](now/main.go) / [`main.go`](main.go)：`NowInput` 增 `now_merchant_id`，非空即透传；**优先于** `location_poi_id`。
- [`now/sample.json`](now/sample.json)：含 POI 挂商户、直挂商户两条示例。
- 挂商户：**① 填 `now_merchant_id`（推荐）** 或 **② POI 与商户 `address_poi_id` 一致**；两者都填时 ① 优先。
- C 端 **`POST /api/v1/merchant/poi/info`**：按 `poi_id_list` 批量查已认证商户，爬虫导出可自动填 `now_merchant_id`（见 README 3.6）。

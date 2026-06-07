# 导入工具 · 增量更新说明 2（气泡直挂商户 `now_merchant_id`）

> 接 [CHANGELOG.md](CHANGELOG.md)。本轮：后台**建/改气泡**支持直接指定 `now_merchant_id`，
> 与 C 端 `POST /v1/now/publish` 对齐 —— 爬虫现在可**不依赖 POI**，直接把气泡挂到指定商户。

---

## 背景：之前只能靠 POI 间接挂商户

- 旧版 admin `POST /internal/nows` **没有** `now_merchant_id` 字段，只能靠 `location_poi_id` 命中某商户的 `address_poi_id` 来**间接**挂商户（两者字符串相等才挂）。
- C 端 `POST /v1/now/publish`（`NowPublishReq`）一直有 `now_merchant_id` 可直接挂。
- 本轮把这个能力补到后台导入接口，并补上**相同的校验逻辑**。

---

## 后端改动

| 位置 | 改动 |
|---|---|
| [`app/dto/admin_now.go`](../../app/dto/admin_now.go) | `AdminNowStoreReq` 与 `AdminNowUpdateReq` 都增 `now_merchant_id string`（更新时**空字符串=不改**） |
| [`app/service/admin_now.go`](../../app/service/admin_now.go) | `Store` / `Update` 接收 `now_merchant_id`，与 publish 一致**校验商户存在且 `status==1`**，否则报「关联商户无效」 |

**优先级规则（与 publish 对齐）：**

- **直接传 `now_merchant_id` → 优先**，并校验商户有效（存在且 `status==1`）。
- **不传 `now_merchant_id` 时** → 仍按 `location_poi_id` 命中商户来挂（保留原行为）。
- 两者都传 → `now_merchant_id` 优先，POI 只用于写 `address_poi_id`，不再覆盖商户。
- `Update`：`now_merchant_id` 空串=不改；只有「不传 `now_merchant_id` 且传了 `location_poi_id`」时，才按 POI 重算/置空商户。

> ⚠️ 校验沿用 publish：商户 `status` 必须 **= 1**（`status=2/0/-1` 都会被拒）。导入商户默认就是 1（见 CHANGELOG 增量 5 / 坑 4），正常不会踩到。

---

## 脚本改动

[`now/main.go`](now/main.go) 的 `NowInput` 增 `now_merchant_id`，非空即透传到创建载荷。

---

## 爬虫怎么挂商户（二选一）

| 方式 | 怎么填 | 适用 |
|---|---|---|
| **① 直接挂（推荐）** | `now_merchant_id` = 该商户 `merchant_id`（建商户返回 / `query merchants` 查到） | 已知 merchant_id，最直接、不依赖 POI 一致 |
| **② POI 挂（原方式）** | `location_poi_id` = 商户 `address_poi_id` | 手里只有 POI、或想顺带写地址 POI |

两者都填 → **① 优先**。

---

## 完整示例：建商户 → 建气泡直接挂该商户

```bash
export BUZZ_API_BASE="http://test-go-api.nowmap.cn"
export BUZZ_TOKEN="后台token"

# 1) 建商户（默认 status=1 / is_verified=1）→ merchants.result.json 拿 merchant_id（如 M2001）
go run ./scripts/import/merchant -token "$BUZZ_TOKEN" -f merchants.json

# 2) 建气泡，直接用 now_merchant_id 挂上（无需 location_poi_id 一致）
cat > now1.json <<'JSON'
[{
  "user_id": "U1001",
  "now_title": "店里新品试吃",
  "now_content": "今天到店有惊喜",
  "now_type": 1,
  "now_merchant_id": "M2001",
  "group_id": "@TGS#aBcDeFg",
  "location_latitude": 39.95426,
  "location_longitude": 116.230343,
  "expired_at": "2026-07-01 12:00:00"
}]
JSON
go run ./scripts/import/now -token "$BUZZ_TOKEN" -f now1.json

# 3) 核对：列表里该气泡的 merchant 应为 M2001
go run ./scripts/import/query nows -token "$BUZZ_TOKEN" -keyword=新品试吃 | grep -i merchant
```

> `now_merchant_id` 与 `group_id` 可同时使用。商户 status 必须为 1，否则报「关联商户无效」。

---

## 一条龙（含商户与群）

```
建用户(user) → 建商户(merchant, 拿 merchant_id) →（可选 建群 group, 拿 group_id）
            → 建气泡(now)：now_merchant_id=商户  +  group_id=群  一步挂全
```

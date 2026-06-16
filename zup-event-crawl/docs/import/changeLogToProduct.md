# 导入工具 · 切到正式环境（test → prod）说明

> 测试环境跑通后，要把数据导到**正式环境**，爬虫侧需要改什么。
> **结论先行：不用改代码，只改配置（域名 + token），外加重新拉取正式环境的几样参考数据。**

---

## 0. TL;DR

| 类别 | 要不要动 | 说明 |
|---|---|---|
| **代码（脚本/后端）** | ❌ **不用改** | 全靠运行参数 `-base` / `-token`，无硬编码测试域名 |
| **API 基址** | ✅ 改 | `https://test-go-api.nowmap.cn` → **`https://zup.nowmap.cn`** |
| **后台 token** | ✅ 改 | 用**正式后台管理员**账号登录换新 token |
| **商户类型 id（`type`）** | ✅ 重新拉 | 正式库的 `bi_merchant_type` id 与测试不同，必须对 prod 重新 `query merchant-types` |
| **去重台账** | ✅ 重建 | 测试的 user_id/merchant_id/now_id/group_id 在正式库**全部失效**，从零重建 |
| **IM 凭据（建群）** | ❌ 不用改 | SDKAppID / 密钥 / identifier 两环境**完全相同**（见下） |
| **腾讯地图 key（POI）** | ❌ 不用改 | 两环境相同 |
| **OSS / CDN** | ❌ 不用改 | 两环境相同；且爬虫不直接碰 OSS（走后端 upload） |

---

## 1. 必须改的配置（来源已核对 `ops-zup/inventories/`）

| 项 | 测试 | **正式** | 怎么改 |
|---|---|---|---|
| Go API 基址 | `https://test-go-api.nowmap.cn` | **`https://zup.nowmap.cn`** | `-base` 或 `export BUZZ_API_BASE=...` |
| 后台 token | 测试管理员登录 | **正式管理员登录** | 见下：登录正式后台换 token |

> 来源：`ops-zup/inventories/prod/group_vars/all.yml` → `app_url: "https://zup.nowmap.cn"`；`ops-zup/Makefile` → `PROD_API_URL := https://zup.nowmap.cn`。

**换正式 token**（正式后台是独立的库/账号，需要正式管理员账号密码）：

```bash
go run ./scripts/import/query login -base https://zup.nowmap.cn -admin-user <正式管理员> -admin-pass <密码>
# 打印的就是正式 token；或直接 export 捕获：
export BUZZ_API_BASE="https://zup.nowmap.cn"
export BUZZ_TOKEN="$(go run ./scripts/import/query login -base https://zup.nowmap.cn -admin-user <正式管理员> -admin-pass <密码>)"
```

---

## 2. 必须重新拉取 / 重建的数据（最容易踩）

1. **商户类型 id（merchant 的 `type`）**
   正式库 `bi_merchant_type` 的 id 与测试**大概率不同**。导商户前对正式重跑：
   ```bash
   go run ./scripts/import/query merchant-types -token "$BUZZ_TOKEN"
   ```
   按正式返回的 id 重映射，**切勿沿用测试环境的 type 值**，否则 type 对不上。

2. **去重台账整体作废**
   测试环境记录的 `user_id / merchant_id / now_id / group_id` 在正式库**全部无效**（不同库 + 随机 id）。
   → **清空台账，对正式从零重建**（用户按手机号、商户按名称/poi、气泡按 user_id+标题 重新查重；脚本 `-dedup` 默认开）。

3. **媒体会自动重传**
   脚本本来每次都从源 URL 重新上传到 `/internal/upload`，指向正式 base 即可，无需特殊处理（媒体记录按库存储）。

---

## 3. 完全不用改的（test == prod，已逐项核对）

- **IM 凭据（建群）**：`SDKAppID=1600107795`、密钥 `34b157...841b9d`、`identifier=administrator`。
  - 测试和正式的 `tencent_im_sdk_appid` 在两份 inventory 里**完全一致**，且密钥是后端**硬编码常量**（`app/constat/tencentim.go`，非环境配置）→ **两环境共用同一个 IM 应用**。
  - 含义：`group` 工具不用改；建群的群主用**正式的 user_id** 即可。
- **腾讯地图 key（`poi`/`geocode`）**：`KRABZ-SFJCW-YTZRK-YP25X-2EFC6-ZBFCY`，两环境一致（量大仍建议自备 key，用 `-map-key`）。
- **OSS / CDN**：bucket `buzzin`、域名 `cdn.nowmap.cn`、prefix `bz/`，两环境一致。
- **行为/规则**：坐标系 GCJ-02、所有字段上限与校验、坑 1~4、`now_merchant_id` / `group_id` 逻辑 —— 同一套代码，行为一致。

---

## 4. 代码到底有没有变更？

**没有。** test → prod 的切换**不改任何脚本或后端代码**，原因：

- 脚本的 `-base` 默认 `http://localhost:80`、`-token` 默认空字符串 → **没有硬编码测试域名**，运行时传正式值即可。
- `group` 工具的 IM 凭据是与正式相同的常量，照用即可。

> 兜底：万一将来正式真的换成独立的 IM 应用 / 地图 key，再用 `-sdkappid` / `-key`（IM）、`-map-key`（地图）覆盖，**目前不需要**。

---

## 5. 上线前 checklist

- [ ] 拿到**正式后台管理员**账号密码 → 登 `https://zup.nowmap.cn` 换 token
- [ ] `export BUZZ_API_BASE=https://zup.nowmap.cn`、`export BUZZ_TOKEN=...`
- [ ] `query merchant-types` 对正式拉一遍，更新 `type` 映射
- [ ] **清空/新建正式去重台账**
- [ ] 先小批量（1~2 条）跑通 用户 → 商户 →（群）→ 气泡（带 `group_id` / `now_merchant_id`），用 `query` 核对
- [ ] 确认正式 `/internal/*` 是否有 **IP 白名单 / 内网限制**（如有，在允许的机器上跑）
- [ ] 仍**单线程顺序**跑（正式同样：MySQL 连接池小 + 图片安审限速）

---

## 6. 命令对照（直接照抄）

```bash
# ❌ 测试（旧）
go run ./scripts/import/user -base https://test-go-api.nowmap.cn -token "$TEST_TOKEN" -f users.json

# ✅ 正式（新）—— 只改 base + token，其余命令不变
export BUZZ_API_BASE="https://zup.nowmap.cn"
export BUZZ_TOKEN="$(go run ./scripts/import/query login -base "$BUZZ_API_BASE" -admin-user <正式管理员> -admin-pass <密码>)"

go run ./scripts/import/query    merchant-types -token "$BUZZ_TOKEN"      # ① 先拉正式 type id
go run ./scripts/import/user      -token "$BUZZ_TOKEN" -f users.json       # ② 建用户（手机号查重）
go run ./scripts/import/merchant  -token "$BUZZ_TOKEN" -f merchants.json   # ③ 建商户（type 用正式 id）
go run ./scripts/import/group     create -owner <prod_user_id> -name "群名" # ④ 建群（IM 凭据不变）
go run ./scripts/import/now        -token "$BUZZ_TOKEN" -f nows.json        # ⑤ 建气泡（带 group_id / now_merchant_id）
```

> `query login` 直接打印 token，可用 `$(...)` 捕获；`-base` 也可改走 `BUZZ_API_BASE` 环境变量，命令里就不用每条都带 `-base`。

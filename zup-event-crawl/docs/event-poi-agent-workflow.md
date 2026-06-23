# 活动 POI：Cursor Agent 全程主导（唯一主路径）

> **新开会话必读**：抓取、搜 POI、写 `decisions.json` 的全部规则以 **[`event-crawl-master-workflow.md`](event-crawl-master-workflow.md)** + 本文档 + `.cursor/rules/douban-crawl-and-agent-poi.mdc`（豆瓣）/ `.cursor/rules/xhs-crawl-and-review-import.mdc`（小红书）为准，**不依赖聊天上下文**。

## 铁律：搜词与判定都由 Agent 做

| 步骤 | 谁做 | 说明 |
|------|------|------|
| 定搜索词 | **Agent** | 读 `location`、`sample_title`，决定 1～3 个关键词 |
| 调腾讯 API | **脚本** | `poi-search-cli.js` 只执行 Agent 给的 `--keyword`，不分词、不选点 |
| 读候选、比对 | **Agent** | 对照区划、门牌、店名、类目，决定 match / reject / doubtful |
| 写 `decisions.json` | **Agent** | 入库唯一依据 |
| 写入 `review.db` | **脚本** | `apply-event-poi-decisions.js` 原样落库 |

**禁止**用 JS 规则代替 Agent 做上述任一步：

- `pickBestPoiForEvent`、`buildEventPoiSearchKeywords` 自动跑批并写库
- `batch-resolve-event-poi.js`、`agent-poi-review-apply.js`、`reassess-agent-poi-doubt.js`（已删除）
- `agent-poi-analyze-doubtful.js`、`build-agent-rerun-decisions.js`（已删除；曾用地址文字重叠自动改存疑，违反本流程）
- `batchEventAutoPoi` / `--with-poi` / 审核页「智能匹配」
- 用 JS 比地址门牌/店名自动写 `doubtful: true/false` 或自动生成 `decisions.json`

`lib/tencent-poi.js` 里的分词/打分函数仅供 Agent **参考**，不得作为最终判决。

### 处理范围（与审核台一致）

| 场景 | 导出命令 | 输出文件 | 审核台筛选项 |
|------|----------|----------|--------------|
| **未匹配 POI（抓取一条龙）** | `export-events-for-poi.js --pending-only --new-import-only` | `pending.json` | 本轮新入库且未匹配 POI |
| **未匹配 POI（补历史 backlog）** | `export-events-for-poi.js --pending-only` | `pending.json` | 未匹配 POI |
| **存疑复核** | `export-events-for-poi.js --doubtful-only` | `doubtful-pending.json` | POI 存疑 |

两种模式均要求：

- **包含**：`review_decisions` 无记录或 `status=pending`，且 `end_date` 未过期
- **不包含**：审核台手动 **拒绝**（`status=rejected`）、已 **通过**（`status=approved`），除非人工明确要求

未匹配：`location_poi_id` 为空。存疑复核：已有 POI 且 `poi_agent_doubtful=1`。

### POI `reject` ≠ 审核台「拒绝」

| | POI `action: reject` | 审核台点「拒绝」 |
|--|----------------------|------------------|
| 含义 | 本轮**没配上**腾讯 POI | **不要**这条活动 |
| 审核状态 | 仍为 **待定** | 变为 **已拒绝** |
| 效果 | 清空 POI 字段，仍可在「未匹配 POI」里看到 | 不再出现在待定列表 |

## 三种使用场景（新会话先对号入座）

### 场景 A：抓取入库一条龙

用户说：**「抓取成都豆瓣活动」** / **「抓取上海小红书活动」**。

**豆瓣**顺序（**不可跳过 Agent 判定步骤**）：

1. 抓取 → 入库 `review.db`（只保留 `time_text`）
2. Agent 校正时间 → `time-decisions.json` → apply
3. Agent 分类/挡下 → `classification-decisions.json` → apply
4. Agent 写介绍 → `body-decisions.json` → apply
5. **POI 未匹配**：`export --pending-only --new-import-only` → 读 `pending.json` → Agent 搜+判 → `decisions.json` → apply
6. 汇报各步条数

**小红书**顺序（入库后**同会话**完成分类 + POI，见 `.cursor/rules/xhs-crawl-and-review-import.mdc`）：

1. 抓取 → 读图标框 → extract → 入库（自动导出 `classification-pending.json` + `pending.json`）
2. Agent 校正时间（若需要）→ apply
3. Agent **分类** → `classification-decisions.json` → apply
4. Agent **POI**：读 `pending.json` 每组 → `poi-search-cli` → `decisions.json` → apply（body 已用 highlights，通常跳过 body Agent）
5. 汇报：入库条数、分类推荐/挡下、POI 匹配/reject 组数

详见下文「标准流程」与对应 cursor rules。

### 场景 B：只补「未匹配 POI」

用户说：**「把成都未匹配 POI 的活动配上」**。

1. `node scripts/export-events-for-poi.js --city=成都 --refresh --pending-only`
2. 读 `data/poi-agent-workbench/成都/pending.json` 的每个 `group`
3. **Agent** 定 1～多个搜词 → `poi-search-cli.js` → **Agent 读** `items[]`
4. **Agent 手写** `decisions.json`（`match` 或 `reject`；禁止 JS 自动生成）
5. `node scripts/apply-event-poi-decisions.js --city=成都`
6. 汇报：处理了几组、匹配几组、仍 reject 几组

### 场景 C：只复核「POI 存疑」

用户说：**「把存疑 POI 重新判断一遍」**。

1. `node scripts/export-events-for-poi.js --city=成都 --refresh --doubtful-only`
2. 读 `doubtful-pending.json`：每组含 `current_poi_*`、`poi_agent_reason`（上次为何存疑）
3. **Agent 必须重新搜**（至少 1～3 个搜词，不能只看旧 POI 就改标记）
4. **Agent 判定**三选一：
   - 原 POI 正确 → `match` 同 `poi_id`，`doubtful: false`，`reason` 写清依据
   - 原 POI 不对、有更准候选 → `match` 新 POI，`doubtful` 按情况
   - 应取消 POI → `reject`（清空 POI，活动仍待定）
5. 写入 `decisions.json` → apply
6. 汇报：取消存疑几组、仍存疑几组、改绑 POI 几组

**禁止**：用 JS 比地址相似度批量改 `doubtful`（已删除 `agent-poi-analyze-doubtful.js`、`build-agent-rerun-decisions.js`）。

---

## 标准流程（场景 A 抓取一条龙）

```
抓取 scrape-douban-week-events.js
    ↓
导出 export-events-for-time.js → time-pending.json
    ↓
【大模型】逐条：start_at / expired_at → time-decisions.json → apply
    ↓
导出 export-events-for-classification.js → classification-pending.json
    ↓
【大模型】逐条：推荐/挡下 + category → classification-decisions.json → apply
    ↓
导出 export-events-for-poi.js  →  pending.json（groups 按地址去重）
    ↓
【大模型】每组：定搜词 → poi-search-cli.js → 读候选 → 写 decisions.json
    ↓
入库 apply-event-poi-decisions.js
```

### 0. 一键（仅抓取+导出，POI 仍在对话里做）

```bash
cd zup-event-crawl
node scripts/prepare-city-poi-for-agent.js --city=成都 --max-pages=10
# 已有数据只导出：加 --skip-scrape
```

### 1. 抓取

```bash
node scripts/scrape-douban-week-events.js 500 data/review.db --city=chengdu --mode=append-city --max-pages=10
```

- **禁止**加 `--with-poi`（旧版 JS 自动 Top1，已废弃）
- 豆瓣风控（403/429/验证码）会暂停；见 `docs/HANDOFF.md`
- 默认 Chrome 抓取（需本机 Chrome 已登录豆瓣）

### 2. 导出

```bash
# 未匹配 POI（一条龙默认用这个）
node scripts/export-events-for-poi.js --city=成都 --refresh --pending-only

# 存疑复核（单独任务时用）
node scripts/export-events-for-poi.js --city=成都 --refresh --doubtful-only
```

输出目录：`data/poi-agent-workbench/<城市>/`（小红书为 `<城市>-xhs/`）

| 文件 | 谁写 | 作用 |
|------|------|------|
| `pending.json` | 脚本 | 未匹配 POI 的 groups；**含 `cached_poi` 时可直接写 decisions，不必搜** |
| `doubtful-pending.json` | 脚本 | 存疑复核的 groups（含当前 POI） |
| `search-results.json` | 可选，Agent 可追加 | 搜词原始候选，便于审计 |
| `decisions.json` | **Agent 手写** | 最终判定，入库唯一依据 |

### 2b. 地址→POI 映射库（省额度）

已通过的活动，会自动把 **城市 + 豆瓣 location → POI** 写入 `review.db` 的 `poi_address_cache` 表（仅门牌级地址）。**商户不走映射库**。

```bash
# 首次或批量回填（从现有已通过活动）
node scripts/backfill-poi-address-cache.js

# 对待定、无 POI 的活动直接套映射（不调腾讯 API）
node scripts/apply-poi-address-cache.js --city=成都
```

导出 `pending.json` 时会标注 `cached_poi`；`agent-poi-batch-search.js` 对映射库命中的组**跳过搜索**。

### 3. POI（大模型）

对每个 `pending.json` → `groups[]` 条目：

1. 读 `location`、`sample_title`、`event_uids`
2. 若组内已有 **`cached_poi`**：直接据此写 `match` decisions，**不要搜**
3. 否则先查映射库（不消耗腾讯额度）：

```bash
node scripts/poi-search-cli.js --city=成都 --location="成都 锦江区 锈罐头剧场 地址…"
```

4. 映射库未命中再决定 1～3 个搜索词（见下表），执行腾讯搜索：

```bash
node scripts/poi-search-cli.js --city=成都 --keyword="锈罐头剧场"
```

4. **人工级判断**：对比豆瓣原文与候选的 `title`、`address`、`category`
5. 写入 `decisions.json` 一条（`group_id` 与 pending 一致）

**禁止**用 `pickBestPoiForEvent` 等 JS 脚本代替 Agent 做最终选点；Agent 必须亲自读 `poi-search-cli.js` 输出的 JSON 后再写 `decisions.json`。

### 4. 入库

```bash
node scripts/apply-event-poi-decisions.js --city=成都
# 或 node scripts/apply-event-poi-decisions.js --file=data/poi-agent-workbench/成都/decisions.json
```

多城/多批次 decisions 合并入库（文件须为 **Agent 手写**）：

```bash
node scripts/merge-agent-poi-decisions.js --file=data/poi-agent-workbench/_agent-decisions.json
```

可选：批量调搜索接口存候选（**仍须 Agent 读完后手写 decisions**）：

```bash
node scripts/agent-poi-batch-search.js --file=data/poi-agent-workbench/成都/pending.json
```

---

## Agent 每组必做清单（场景 B / C 通用）

对 `pending.json` 或 `doubtful-pending.json` 的**每一个** `group`：

1. 读 `location`、`sample_title`；存疑复核还要读 `current_poi_*`、`poi_agent_reason`
2. **自己定**搜词（不够准就多试几个，记入 `search_keywords_tried`）
3. 执行 `poi-search-cli.js`，**亲自读**返回 JSON
4. 按「判断标准」决定 `match` / `reject` 和 `doubtful` true/false
5. 写入 `decisions.json` 一条（`group_id`、`event_uids` 与导出文件一致）

**没有例外**：不能跳过搜词、不能靠 JS 脚本批量生成 decisions、不能未读候选就改存疑标记。

---

## 搜索词怎么写

| 规则 | 说明 |
|------|------|
| **用场馆/门牌，不用活动标题** | 标题是演出名，不是场地 |
| **保留栋/座/楼** | 豆瓣有 `A座`、`4b栋`，搜词必须带上 |
| **跟豆瓣 venue 对齐** | 不能随意缩短掉栋/座 |
| **剧名≠店名** | `沉浸式…《剧名》-锈罐头剧场` → 搜 `锈罐头剧场`（`lib/tencent-poi.js` → `extractSearchableVenueName`） |
| **豆瓣笔误要纠** | 如 `新国博览中心` → 搜 `新国际博览中心` 或 `浦东 新国际博览中心` |
| **城市** | CLI 已传 `--city`，关键词一般可不写城市名 |
| **多试几个** | 不准就换词，全部记入 `search_keywords_tried` |
| **别用过长复合串** | 如 `新华路160号上海影城SHO等8家影院` 太长易撞错影院；优先 `上海影城 SHO` / `SFC上影 上海影城` |

---

## 判断标准（Agent 写 decisions 时必须遵守）

### `action: match` — 可以绑定 POI

同时满足：

1. **区划一致**：豆瓣里的区（如 `闵行区`）与 POI `address` 中的区一致；跨区一律不 match
2. **门牌或地标一致**：POI 地址含豆瓣里的路名+号，或 POI 名称就是豆瓣写的场馆/商场/园区全称
3. **名称不能仅靠泛词**：单叫 `文创园`、`产业园`、`影院` 且地址对不上 → **不能 match**
4. **栋/座**：豆瓣写了 `A座`/`4b栋`，POI 名称应含相同栋座，或 POI 为含该栋的商务楼宇 POI
5. **类目合理**：剧场/酒吧/咖啡/展览应对应文化场馆、娱乐等，不要选停车场、地铁口、无关公司

`confidence`: `high` | `medium` | `low`（自选，便于人工排序）

### `action: reject` — 本轮未匹配 POI

**未匹配 ≠ 搜不到**。常见三类原因：

| 原因 | 说明 |
|------|------|
| 搜不到 | 关键词无结果，或只有停车场/地铁站/无关门店 |
| 搜到了但都不符合 | 有候选，但区划/门牌/店名/类目对不上 |
| 无法唯一确定主体 | 多个同等合理的远距离候选，不能负责任地选一个（见下节） |

其余写入 `reason` 的典型情形：

- 候选都不符合上节 match 标准
- 豆瓣只写到区/地铁口/路名，搜出来仍是泛地标，无法对应具体场馆

**效果**：清空 `location_poi_id`，审核状态**仍为待定**（不是「拒绝活动」）。审核台筛「未匹配 POI」可见。

### 主体一致、仅差精度 → `match` + `doubtful: false`

下列情况**应 match**，且**不必标存疑**（`doubtful: false`）：

- 豆瓣写的商场/楼宇/园区/小区/院校**主体**与 POI 一致
- 区划、路名/门牌能对上（或 POI 名称就是豆瓣写的那个地标全称）
- 仅缺少：楼层、中庭、展厅、室号、铺位、店内品牌名等「店级」细节
- 腾讯地图**没有**更精确的店级 POI（搜活动标题/店名也找不到独门店）

| 豆瓣地点 | 应对齐的 POI 层级 | 说明 |
|----------|-------------------|------|
| 长安商场 L1 中庭 | 长安商场 | 商场主体已对 |
| 粤生街48号122铺 InTransit | 小城之春别苑 | 门牌48号已对，122铺无店级 POI |
| 某商场 F5 某剧场 | 该商场 POI | 腾讯无该剧场店级 POI |
| 某大厦 A座（POI 只到大厦） | 该大厦 POI | 栋座已在 POI 名或地址中体现时可 `doubtful: false` |

`reason` 示例：`豆瓣XX与POI主体一致，仅楼层/铺位/室号未精确到腾讯店级POI`

**不要**因「差一层楼、差一个铺位」就 `reject`；也**不要**为此单独标 `doubtful: true`（除非下面「仍应存疑」的情形同时存在）。

### 无法唯一确定主体 → `reject`（不要瞎猜）

下列情况应 **`reject`**，即使搜到了很多结果：

| 情形 | 示例 | 为何 reject |
|------|------|-------------|
| 多校区/多分部距离远 | 豆瓣只写 `四川大学`，候选有望江/华西/江安 | 挂任一校区都可能偏几公里，无法从地址推断默认校区 |
| 多场馆同城不同址 | 豆瓣写品牌名，腾讯有多家分店且豆瓣未给区/路 | 不能凭标题猜最近一家 |
| 地址过泛 | 仅 `解放碑`、`地铁3号线某口`、`某区郊外` | 无唯一场馆主体 |
| 搜词撞错类 | 活动标题含「探店」，搜出无关餐饮 | 候选与场地无关，不能硬 match |

`reason` 示例：`仅写四川大学，多校区无法确定场馆` / `豆瓣地址过泛，无法对应唯一POI`

**禁止**：在多个远距离候选中「随便选主校区/第一家店」再标存疑——应直接 `reject`，留待人工补全地址或改搜词。

### `doubtful: true` — 有 POI 但建议人工核对

**已 match**，但除「仅差楼层/铺位」外还有额外不确定性时标 `doubtful: true`：

| 场景 | reason 示例 |
|------|-------------|
| 区划表述不一但地址指向同一商场 | `豆瓣写新城区，POI在碑林区开元商城，店名地址一致建议人工核对区划` |
| 跨区或同城多店存疑 | `豆瓣标注梁溪区，POI在新吴区万悦集，活动地址写万悦集，区划存疑` |
| 铺位/楼栋不一致 | `活动写通庆里C座209，POI为文化小城D-203，同品牌铺位不同` |
| 类目或名称明显对不上 | `活动为敦煌DIY，POI为琴行棋院，仅地址接近` |
| 多场地活动只绑了一个 | `豆瓣写等8家影院，仅对齐上海影城SHO一家` |
| 主体合理但需确认是否商业空间 | `POI类目为住宅小区，活动为室内小影院，地址门牌一致待确认` |

下列情况**不要**标存疑（应 `doubtful: false`）：

- 仅「商场/楼宇/园区主体对上，差楼层/中庭/展厅/铺位」（见上节）
- 栋座已在 POI 名称或地址中体现且与豆瓣一致

### `doubtful: false`

名称+地址+区划主体对上，且属于「主体一致、仅差精度」或一般高置信 match，且**不属于**上节「仍应存疑」情形。

### 场景 C 补充：批量复核存疑时的放行标准

用户要求「只 review 现有存疑、不重新搜」时：

1. 读 `doubtful-pending.json` 中每组的 `current_poi_*` 与 `location`
2. 符合「主体一致、仅差精度」→ `match` 同 `poi_id`，`doubtful: false`
3. 存在跨区、铺位不同、类目不符、地址过泛等 → 保持 `doubtful: true` 或 `reject`
4. 结果写入 decisions 后 apply；**禁止**用 JS 批量改 `doubtful`

常规场景 C（用户说「重新判断存疑」）仍须**重新搜**后再判，不能只看旧 POI。

---

## 常见翻车（务必避免）

| 翻车 | 正确做法 |
|------|----------|
| 闵行 `联明路555号文创园` 命中宝山另一个「文创园」 | 看 **区 + 路名**；候选里有 `启示望远文创园`（联明路555号）应选它 |
| `上海影城SHO` 命中松江「辰山汽车影院」 | 只因关键词含「影院」；应搜 `上海影城` / `SFC上影` |
| 豆瓣 `reject` 但库里仍有 POI | POI reject 后保持无 POI；勿用 JS 批处理把 POI 写回 |
| Agent 写 `doubtful:false` 但地址跨区 | 审核台现在会 **JS 二次校验**标黄，但仍应在 decisions 阶段就写对 |
| `decisions.json` 没写 `candidates` | 入库后审核页候选区为空；match 时把当次 Top5 候选抄进 `candidates` 数组 |
| 只信聊天记忆、不读 `pending.json` | 新会话必须从 workbench 文件读 groups，不能猜 event_uid |
| 商场主体已对，却因差 L1 中庭标存疑或 reject | 主体一致、仅差精度 → `match` + `doubtful: false` |
| 四川大学等多校区只写校名就随便挂望江校区 | 无法唯一确定 → `reject`，不要猜默认校区 |
| 搜到四川大学却整组 reject 时误以为「搜不到」 | 未匹配可能是「搜到但无法唯一确定」，看 `reason` |

---

## 文件格式

### `pending.json`（脚本导出）

```json
{
  "city": "成都",
  "groups": [
    {
      "group_id": "a1cf3eeda34e",
      "location": "成都 金牛区 …",
      "sample_title": "…",
      "event_uids": ["douban:37563854"],
      "event_count": 1
    }
  ]
}
```

### `decisions.json`（大模型写，脚本入库）

```json
{
  "city": "成都",
  "decided_at": "2026-06-10T12:30:00.000Z",
  "agent": "cursor-composer",
  "decisions": [
    {
      "group_id": "a1cf3eeda34e",
      "event_uids": ["douban:37563854"],
      "action": "match",
      "search_keywords_tried": ["锈罐头剧场", "金牛区 锈罐头剧场"],
      "poi_id": "8612963027283403844",
      "poi_title": "锈罐头剧场(上城天街旗舰店)",
      "poi_address": "…",
      "latitude": 30.685335,
      "longitude": 104.071138,
      "candidates": [],
      "confidence": "high",
      "doubtful": false,
      "reason": "店名与金牛区地址一致"
    }
  ]
}
```

- `action`: `match` | `reject` | `skip`
- `reject`：无 `poi_id`；活动保持待审核
- `match`：建议带上 `candidates`（搜到的列表），便于审核页展示与改选

---

## 审核台（入库后）

地址：http://127.0.0.1:8787/ （`node scripts/server.js`）

### 展示

- 卡片标签：**POI 已匹配** / **未匹配 POI**；存疑时 **POI 存疑**
- 时间/地点下方直接显示 POI 名称与地址（不必滚到「入库准备」才看见）
- 无 `poi_candidates` 时，服务端会用当前 POI 补一条候选供点选

### 筛选

| 筛选项 | 含义 |
|--------|------|
| **待定** | 审核状态为待定，且**入库字段已齐**，且**非** POI 存疑、**非**挡下待处理（可批量审过的「干净」队列） |
| 未匹配 POI | 审核状态为待定，且 `location_poi_id` 为空（「待定」按钮灰色，**不计入**「待定」） |
| POI 存疑 | 审核状态为待定，且 `poi_agent_doubtful=1`（**不计入**「待定」）；支持**批量通过/拒绝** |
| 挡下待处理 | Agent 挡下且仍为待定（**不计入**「待定」）；支持**批量通过/拒绝** |

「待定」「POI 存疑」「挡下待处理」三个筛选项下均显示批量操作条。

### POI 存疑怎么算

只认 **Agent 写入** 的 `poi_agent_doubtful` + `poi_agent_reason`（见 `lib/review-db.js` → `resolveEventPoiDisplayFlags`）。

- Agent 标 `doubtful: false` → 审核台**不黄标**
- Agent 标 `doubtful: true` → 黄标，并展示 Agent 写的 reason

不再叠加 JS 地址/区划自动校验，避免误报（如店名地址已对、却被「区划不一致」标黄）。

### 人工改 POI

自由搜索关键词 → 点选候选保存（`poi_match_source: manual`），不再走 JS 自动 Top1。

---

## 脚本一览

| 脚本 | Agent 能否依赖它做判定？ | 作用 |
|------|-------------------------|------|
| `export-events-for-poi.js` | 否，只导出任务 | `--pending-only` / `--doubtful-only`；附带 `cached_poi` |
| `backfill-poi-address-cache.js` | 否 | 从已通过活动回填地址→POI 映射库 |
| `apply-poi-address-cache.js` | 否 | 对待定无 POI 的活动直接套映射库 |
| `poi-search-cli.js` | 否，只返回候选 | `--location=` 先查映射库；未命中再 `--keyword=` 搜腾讯 |
| `agent-poi-batch-search.js` | **否**，只批量搜索 | 映射库命中则跳过搜索；其余批量调 API |
| `apply-event-poi-decisions.js` | 否，只落库 | Agent 写的 `decisions.json` → DB |
| `merge-agent-poi-decisions.js` | 否，只合并落库 | 多批次 Agent decisions 入库 |
| `prepare-city-poi-for-agent.js` | 否 | 抓取 + 导出（不含 POI 判定） |
| `scrape-douban-week-events.js` | 否 | 抓取豆瓣 |

小红书加 `--source=xiaohongshu`，workbench 为 `data/poi-agent-workbench/<城市>-xhs/`。

---

## 已废弃（勿再使用）

| 项目 | 说明 |
|------|------|
| `batch-resolve-event-poi.js` | 已删除；JS 自动搜词+选点+入库 |
| `agent-poi-review-apply.js` | 已删除；写死 POI 的伪 Agent 批处理 |
| `reassess-agent-poi-doubt.js` | 已删除；JS 规则重评存疑 |
| `agent-poi-analyze-doubtful.js` | 已删除；JS 比地址自动建议取消存疑 |
| `build-agent-rerun-decisions.js` | 已删除；JS 自动生成 decisions 并改存疑 |
| `run-city-agent-poi.js` | 旧 JS 自动 POI 流水线 |
| ~~`agent-poi-build-*` / `agent-complete-*`~~ | 已删除 |
| `batchEventAutoPoi` / `lib/event-poi-batch.js` | 调用即报错 |
| 抓取 `--with-poi` | 旧版 JS Top1 |
| `batch-event-import-prep.js` 内自动 POI | 已移除，仅写默认入库字段 |
| 审核页「智能匹配」 | 已移除 |
| `/api/events/poi-auto-batch` | 已禁用（410） |

`lib/tencent-poi.js` 仍用于：**执行**腾讯 API（`poi-search-cli`）、商户 POI、审核页人工自由搜索。活动 POI 的**搜词、选点、存疑**只认 Agent + `decisions.json`。

---

## 新 Cursor 会话检查清单

### 一条龙（场景 A）

- [ ] 已读 classification / body / 本文档
- [ ] 抓取未加 `--with-poi`
- [ ] 时间 → 分类 → 介绍 均已 Agent decisions + apply
- [ ] POI：`export --pending-only` → 每组 `poi-search-cli` → **手写** `decisions.json` → apply
- [ ] 汇报各步条数

### 只补 POI（场景 B）或只复核存疑（场景 C）

- [ ] 确认场景：未匹配用 `pending.json`，存疑用 `doubtful-pending.json`
- [ ] **每一组**都跑过 `poi-search-cli.js`（存疑复核不能只看旧 POI）
- [ ] `decisions.json` 由 **Agent 手写**，非 JS 批量生成
- [ ] `group_id` / `event_uids` 与导出文件一致
- [ ] 已 apply；汇报处理组数、匹配/ reject / 仍存疑数量

相关 Cursor 规则：`.cursor/rules/douban-crawl-and-agent-poi.mdc`

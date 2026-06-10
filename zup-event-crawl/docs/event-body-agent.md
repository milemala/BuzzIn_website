# 活动介绍（body）：Cursor 大模型撰写

> **新开会话必读**：抓取后 `body` **不再由 JS 自动生成**；默认 `body_source=pending`，由 Agent 读 `body-pending.json` 写 **完整活动介绍（含参加方式）** 到 `body-decisions.json` 入库。JS 仅作备选。

## 目标

为 Zup 用户写 **完整、可读、不编造** 的活动正文 `body`，用于审核台与 Buzz 入库。包含两部分：

1. **活动介绍**：这场活动是什么、有什么亮点
2. **参加方式**：根据原文写清楚怎么报名/购票

**不写审核话术**（「适合 Zup」「默认拒绝」等写在 `review_reason`）。

Agent 写满的 `body` 入库后，系统**不再**用 JS 自动追加参加方式（`body_source=agent` 时跳过 `enrichEventBody`）。

---

## 流程

```
抓取（存 raw_detail_text / raw_detail_html，body 留空）
    ↓
分类 export → Agent → apply
    ↓
导出 export-events-for-body.js → body-pending.json
    ↓
【大模型】逐条写完整 body + reason
    ↓
body-decisions.json → apply-event-body-decisions.js
    ↓
POI（可并行）
```

---

## 写作规范

### 活动介绍（前半段）

| 项 | 要求 |
|----|------|
| 字数 | 介绍部分 **≤220 字** 为佳 |
| 口吻 | 同城玩乐 App 活动卡片，自然口语 |
| 依据 | 优先 `detail_text`；无详情时用 `title` + `location` + `category` 合理推断 |
| 禁止 | 千篇一律「适合 xxx 观众」；贴标题；豆瓣链接；审核判断；编造嘉宾/票价 |

### 参加方式（后半段，Agent 必写）

根据 `detail_text`、`owner` 判断，常见就三类：

| 类型 | 何时用 | 写法示例 |
|------|--------|----------|
| **联系豆瓣发布者** | 原文没写具体渠道，或只有「报名请联系发起人」 | `可在豆瓣同城联系发起人「张三」报名。` |
| **公众号 / 微信 / 手机** | 正文里留了公众号名、微信号、手机号 | `报名请关注「XX沙龙」公众号，或添加微信 xxxx。`（只写原文里有的，不编造号码） |
| **票务平台** | 发布者是猫眼、大麦、秀动等，或正文写明在某 App 购票 | `请于猫眼 App 搜索本活动购票参加。` |

**默认兜底**：原文看不出具体渠道 → 按「联系豆瓣发布者」写，用导出里的 `owner` 作发起人名。

参加方式单独成段，建议以 `参加方式：` 或 `报名：` 开头，与介绍空一行。

### 完整示例

```
《心犬相随》是一部讲述人与救助犬故事的纪录片放映，映后主创到场交流，氛围温暖治愈。

参加方式：免费活动，请在豆瓣同城联系发起人「某某观影团」报名。
```

```
开放麦喜剧专场，新老演员同台试段子，现场氛围轻松，适合想听脱口秀的观众。

参加方式：请于猫眼 App 搜索本活动购票，票价以页面为准。
```

---

## `body-decisions.json` 格式

```json
{
  "city": "深圳",
  "decided_at": "2026-06-10T12:00:00.000Z",
  "agent": "cursor-composer",
  "decisions": [
    {
      "event_uid": "douban:37595508",
      "body": "一场围绕荀子与儒家政治哲学的读书分享，嘉宾对谈思想脉络，适合对文史哲感兴趣的朋友。\n\n参加方式：可在豆瓣同城联系发起人「某某读书会」报名。",
      "reason": "介绍来自详情正文；原文未写公众号，按联系发布者处理。"
    }
  ]
}
```

- `body`：完整正文入库（**含**参加方式）。也接受旧字段名 `body_intro`，但须已含参加方式。
- `reason`：审计用，不进用户正文

总字数（介绍 + 参加方式）不超过 **500 字**。

---

## 命令

```bash
node scripts/export-events-for-body.js --city=深圳
node scripts/apply-event-body-decisions.js --city=深圳
```

JS 备选（含旧版 JS 参加方式，质量较差，仅应急）：

```bash
node scripts/batch-infer-event-bodies.js --city=深圳
```

---

## 库字段

| 字段 | 值 | 含义 |
|------|-----|------|
| `raw_detail_text` | — | 抓取原文，Agent 写作依据 |
| `body` | — | 给用户看的完整介绍（Agent 写满） |
| `body_source` | `pending` | 待 Agent 写 |
| | `agent` | Agent 已写，重抓不覆盖，不再 JS 追加参加方式 |
| | `js_fallback` | JS 备选生成 |

# AI 首次建档 Demo（后端参考）

给 App 后端对接智谱时的参考实现：**单 Agent、单 Prompt、每轮一次调用**。

产品说明见仓库 [`docs/ai-match-profile.md`](../../docs/ai-match-profile.md)。  
前端联调页：仓库根目录 [`match-card.html`](../../match-card.html)。

## 目录（只留有用的）

```
demo/profile-proxy/
├── README.md           # 本文件
├── package.json
├── .env.example        # 复制为 .env，填 ZHIPU_API_KEY
├── system-prompt.js    # 唯一 Prompt（给模型）
├── profile-schema.js   # 画像字段、合并规则、结束条件（业务层）
└── server.js           # HTTP 编排：调智谱 → 合并画像 → 是否结束
```

运行时会生成（已 gitignore，勿提交）：

- `.env`
- `data/chats/*.json` / `*.md`（对话存档，便于验收）

## 启动

```bash
cd demo/profile-proxy
cp .env.example .env   # 填入 ZHIPU_API_KEY
npm start
```

- 页面：http://localhost:8788/match-card.html  
- 健康检查：http://localhost:8788/api/health  
- 默认端口 **8788**（避免和活动审核台 8787 冲突）

## 后端应对齐的契约

### 1. 每轮模型输出（JSON）

```json
{
  "assistant_reply": "给用户看的话",
  "quick_replies": ["可选按钮，最多4个"],
  "profile_update": {},
  "user_signal": "normal|low_quality|joke|refuse|off_topic|ask_end|unsafe",
  "safety": { "level": "ok|joke|off_topic|refuse|unsafe", "note": "" }
}
```

- `assistant_reply`：展示给用户  
- `profile_update`：只含本轮真正更新的画像字段，后台合并，不展示  
- 原则：**聊天体验优先于凑字段**（见 `system-prompt.js`）

### 2. 画像字段（`profile-schema.js`）

每个字段：`{ "value", "confidence", "evidence": [] }`

| 字段 | 含义 |
|------|------|
| `social_purpose` | 希望遇见：饭搭子 / 闲聊放松 / 扩大圈子 / 创业伙伴 / 异性朋友 |
| `social_style` | 社交人格：主动 / 慢热 |
| `chat_topics` | `{ likes, dislikes }` |
| `activity_style` | 偏安静 / 偏热闹 / 文艺 |
| `schedule_preference` | 早睡早起 / 夜猫子 / 工作日晚上 / 周末全天 |
| `boundaries` | `{ smoking_nearby, drinking }` |
| `intro` | 收束时短介绍 |

### 3. 何时结束（业务层，不交给模型自行宣布完成）

满足任一即可收束（`phase=wrap_up`）：

| 条件 | 默认 |
|------|------|
| 高置信字段数 | ≥ 5（confidence ≥ 0.75），且用户至少说了 4 轮 |
| 用户发言轮次 | ≥ 10 |
| 连续 `low_quality` | ≥ 3（来自模型 `user_signal`） |
| `ask_end` | 用户想结束 |

### 4. HTTP API（Demo）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/profile-chat` | 多轮对话；body: `{ sessionId, reset?, userMessage }` |
| POST | `/api/profile-chat-confirm` | 用户确认介绍 |
| GET | `/api/health` | 探活 |
| GET | `/api/profile-chats` | 本地存档列表（仅 Demo） |

响应里同时带 `assistant_reply`（主字段）和 `assistant_message`（兼容旧前端）。

## 职责边界（给后端）

| 模块 | 做什么 | 不做什么 |
|------|--------|----------|
| Prompt | 自然聊天 + 推断画像 + 输出 JSON | 不自己宣布「建档完成」 |
| 业务层 | 计数、合并画像、决定是否 `wrap_up` | 不用正则猜用户意图 |
| 前端 | 展示 `assistant_reply` / 快捷按钮 / 确认 intro | 不解析 `profile_update` 原文给用户看 |

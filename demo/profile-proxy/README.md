# AI 建档 Demo · v3

用于验证建档逻辑和调试 Prompt，不是生产服务。当前实现为单 Agent：正常轮次调用模型一次，结束时额外调用一次 `wrap_up`。

正式后端接入请先阅读：

- [`docs/ai-match-profile-backend-handoff.md`](../../docs/ai-match-profile-backend-handoff.md)
- [`docs/ai-match-profile-backend-migration.md`](../../docs/ai-match-profile-backend-migration.md)

## 启动

```bash
cp .env.example .env
# 在 .env 填 ZHIPU_API_KEY
npm start
```

打开：http://localhost:8788/match-card.html

也可在仓库根目录 `npm start`：同时启动活动审核台（8790）与本服务（8788）。只开建档用根目录 `npm run start:profile`。

运行纯业务测试：

```bash
npm test
```

## 精简架构

```text
用户回答
→ 服务端注入 current_field / next_field / 画像摘要
→ 模型返回回复、回答状态、当前字段更新、快捷按钮
→ 服务端校验当前字段并推进 fieldQueue
→ 命中结束条件时调用 wrap_up
→ 保留模型 intro / tagline；异常时才使用 fallback
```

职责边界：

- `system-prompt.js`：唯一对话规则、问法、选项和输出契约。
- `profile-schema.js`：字段状态、字段队列、完整度与结束判断；`tagline` 规范化（≤15 字）。
- `server.js`：模型调用、状态转换、会话恢复和 HTTP。
- `match-card.html`：展示、快捷回复和总结交互；不重复计算完整度。

建档结束还会生成 `tagline`：组局列表昵称下方的一行短介绍（≤15 字）。

## v3 画像

每个字段：

```json
{
  "value": "用户答案或对象",
  "status": "empty|answered|skipped",
  "evidence": ["简短依据"]
}
```

不再让模型填写 `confidence`。明确回答直接覆盖旧值；模糊和低质回答不入库。

字段共 8 项：

1. `occupation`
2. `social_purpose`
3. `social_style`
4. `chat_topics`
5. `activity_style`
6. `schedule_preference`
7. `stranger_story`（可空，不挡匹配）
8. `friend_description`

## 模型输出

```json
{
  "assistant_reply": "给用户看的回复",
  "quick_replies": [],
  "quick_replies_multi": false,
  "profile_update": {},
  "answer_status": "not_applicable|clear|ambiguous|low_quality|skip",
  "user_signal": "normal|joke|off_topic|ask_end|unsafe"
}
```

- `clear`：必须只更新 `current_field`。
- `skip`：服务端直接记录跳过，不依赖模型补写特殊值。
- `ambiguous / low_quality / not_applicable`：不更新画像、不推进当前题。
- `joke / off_topic`：不累计低质。
- `unsafe`：计入低质，但只有达到结束条件后才收束。

## 问题推进

- 首次建档：队列包含 8 题。
- 再聊补全：队列只包含未真实回答的 7 个匹配字段。
- `clear / skip`：推进队列。
- `ambiguous / low_quality`：停留当前题。
- 第 7 题可空，不挡匹配完整。

结束条件满足任一：

- 当前队列处理完；
- 用户发言达到 30 轮；
- 连续低质或 unsafe 达到 3 次；
- 用户明确要求结束。

对话可以结束但画像仍可能不完整；只有 7 个匹配字段都为 `answered` 时 `profile_complete=true`。

## HTTP

- `POST /api/profile-chat`
- `POST /api/profile-chat-confirm`
- `GET /api/profile-chats`
- `GET /api/profile-chats/:sessionId`
- `GET /api/health`

模型调用默认 45 秒超时。失败时本轮状态回滚，前端“重试刚才那条”会重新发送同一请求，不会清空画像。

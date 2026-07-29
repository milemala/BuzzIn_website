# AI 建档 · 后端交接文档（给人 / 给 AI）

> 本文是 **App 后端实现「首次 AI 建档」** 的交接说明。  
> 本地 Demo 已跑通；后端应对齐本文契约，并直接参考所列源码，**不要凭记忆改题库或结束规则**。

相关产品摘要：[`ai-match-profile.md`](./ai-match-profile.md)  
可运行 Demo：[`demo/profile-proxy/`](../demo/profile-proxy/)

---

## 0. 先给后端哪几个文件

### 必给（实现时以这些为准）

| 文件 | 作用 |
|------|------|
| [`demo/profile-proxy/system-prompt.js`](../demo/profile-proxy/system-prompt.js) | **唯一 Prompt**：问法、选项、跳过、异常信号、收束文案规则 |
| [`demo/profile-proxy/profile-schema.js`](../demo/profile-proxy/profile-schema.js) | **业务层**：字段、合并、对话收束条件、匹配完整度、保底 intro |
| [`demo/profile-proxy/server.js`](../demo/profile-proxy/server.js) | **编排参考**：调模型 → 解析 JSON → 合并 → 是否 wrap_up → 响应形状 |
| [`demo/profile-proxy/README.md`](../demo/profile-proxy/README.md) | Demo 目录说明与 API 速查 |
| [`demo/profile-proxy/.env.example`](../demo/profile-proxy/.env.example) | 环境变量示例（模型名等） |
| [`docs/ai-match-profile.md`](./ai-match-profile.md) | 产品侧摘要 |
| **本文** `docs/ai-match-profile-backend-handoff.md` | 后端交接总览 |

### 建议一并给（对齐前端体验）

| 文件 | 作用 |
|------|------|
| [`match-card.html`](../match-card.html) | Demo 前端：快捷回复交互、总结页、硬拦匹配、再聊补全 / 重新聊聊 |

### 不必给

- `demo/profile-proxy/data/chats/**`（本地试聊存档）
- `.env`（含密钥）
- 活动抓取 / `8787` 审核台相关代码（另一套业务）

---

## 1. 产品一句话

用户第一次用 AI 组局前，与助手 **Zee** 聊几句，建立**长期可复用**的社交画像；聊完出一段可改的介绍。  
**画像不完整时不能开启匹配组局**（硬拦）；可「再聊补全」或「重新聊聊」。

---

## 2. 架构（必须遵守）

```
用户发言
  → 业务层组 messages（system = Prompt + 进度事实；history）
  → 调用大模型（每轮 1 次）
  → 解析唯一 JSON
  → merge profile_update
  → evaluateEnd（业务层决定是否结束）
  → 若该结束：再调一次 phase=wrap_up（仅结束时多一次）
  → 返回前端：assistant_reply / quick_replies / profile_draft / profile_complete / action
```

硬规则：

1. **单 Agent、单 Prompt、每轮一次主调用**（结束时允许额外一次 wrap_up）。
2. **对话文案 / 问哪题 / 给什么选项：只听 Prompt**，JS/业务层不写题面、不猜测用户自然语言选项。
3. **何时结束对话、是否匹配完整：只听业务层**（`profile-schema.js`），模型不得自行宣布「建档完成」。
4. 改题库 / 改措辞：只改 `system-prompt.js`；改结束阈值 / 完整度：只改 `profile-schema.js`。

---

## 3. 画像字段

每个字段形状：

```json
{ "value": "...", "confidence": 0.0, "evidence": ["短证据"] }
```

| 字段 | 含义 | 备注 |
|------|------|------|
| `occupation` | 职业 / 领域 / 在读 | 开放作答，无快捷选项 |
| `social_purpose` | 希望遇见谁 | 可多选 |
| `social_style` | 社交风格 | 单选倾向 |
| `chat_topics` | 聊天偏好 | 通常 `{ likes, dislikes }` |
| `activity_style` | 线下氛围 | 偏安静 / 偏热闹 / 分情况 |
| `schedule_preference` | 有空时间 | 可多选 |
| `stranger_story` | 陌生人经历 | **可跳过 / 可空，不挡匹配完整** |
| `friend_description` | 朋友怎么形容你 | |
| `intro` | 收束总结 | wrap_up 时写入；给用户看 |

特殊值：

- `__skipped__`：用户明确跳过该题。
- 本轮无更新的字段：**不要**出现在 `profile_update` 里。

不主动收集：性别年龄地址、公司/学校全称、薪资、MBTI、本次组局类型、匹配性别（这些在 App 别处收集）。

---

## 4. 两层状态（容易混，务必分开）

### 层 A：对话能否收束 `evaluateEnd.shouldEnd`

满足任一即可进入 `wrap_up`：

| 条件 | 默认 |
|------|------|
| 核心字段都已**处理完**（真答 **或** `__skipped__`） | `enough_fields`（`stranger_story` 不挡） |
| 用户发言轮次 ≥ 30 | `max_turns` |
| 连续 `low_quality` 或 `unsafe` ≥ 3 | `low_quality_streak` |
| `user_signal=ask_end` | `user_end` |

### 层 B：能否匹配组局 `profile_complete`

- **完整**：除 `stranger_story` 外，核心字段均为**真实回答**（不是空、不是 `__skipped__`，且 confidence 达标）。
- **不完整**：有跳过或缺题，或提前收束导致缺真答。
- Demo 前端：**不完整则硬拦匹配**；总结页隐藏「确认匹配」，展示「再聊补全」。

### 补聊 `resumeMode`（重要）

- 「再聊补全」：带上已有 `seedDraft`，`resumeMode=true`，**只问未齐字段**（空或曾跳过）。
- 「重新聊聊」：清空画像，全新开场。
- 补聊时**不能**因为「以前跳过过」就立刻 `enough_fields`；须本轮对补聊目标字段有有效写入（真答/再次跳过），或连续低质满 3 次，或匹配已完整。详见 `server.js` 的 `resumeTargets` / `resumeTouched` 与 `evaluateEnd(resumeMode)`。

### 合并规则坑（必复现）

- 真答必须能覆盖此前的 `__skipped__`（跳过常为 confidence 0.99，否则会被挡住）。见 `mergeProfile`。

---

## 5. 模型每轮输出（唯一 JSON）

```json
{
  "assistant_reply": "给用户看的话",
  "quick_replies": ["最多6个"],
  "quick_replies_multi": false,
  "profile_update": {},
  "user_signal": "normal|low_quality|joke|refuse|off_topic|ask_end|unsafe",
  "safety": { "level": "ok|joke|off_topic|refuse|unsafe", "note": "" }
}
```

| 字段 | 含义 |
|------|------|
| `assistant_reply` | 用户可见；continue 时通常带一个问句 |
| `quick_replies` | 本轮按钮；第 1 题必须 `[]` |
| `quick_replies_multi` | `true` 多选（题 2/4/6/8）；`false` 单选（题 1/3/5/7） |
| `profile_update` | 增量字段；无更新勿写键 |
| `user_signal` | 业务层计数用；**信任模型**，不要用正则重判用户意图 |
| `safety` | `unsafe` 仅真正有害；玩笑/擦边用 `joke`，不要误杀对话 |

异常策略摘要（细节以 Prompt 为准）：

- 敷衍 / 乱答 → `low_quality`，换短问法再问**同一方向**，不要写成跳过冒充答完。
- 明确跳过 → `__skipped__`，进下一题，勿死缠。
- 想结束 → `ask_end`。
- `unsafe`：仅违法 / 人身威胁 / 未成年人等；可与低质一样计入连续 streak。

---

## 6. Demo HTTP 契约（后端可改路径，语义对齐）

### `POST /api/profile-chat`

Request：

```json
{
  "sessionId": "string",
  "reset": false,
  "resumeMode": false,
  "seedDraft": null,
  "userMessage": "用户话或 null（开场）"
}
```

Response（关键字段）：

```json
{
  "ok": true,
  "assistant_reply": "...",
  "quick_replies": [],
  "quick_replies_multi": false,
  "profile_draft": {},
  "intro": "",
  "profile_complete": false,
  "incomplete_fields": ["occupation"],
  "action": "continue|handoff_summary|hard_block",
  "phase": "continue|wrap_up",
  "end_decision": {},
  "safety": {}
}
```

| `action` | 前端行为 |
|----------|----------|
| `continue` | 展示回复 + 快捷按钮，继续聊 |
| `handoff_summary` | 进入总结页；按 `profile_complete` 决定能否确认匹配 |
| `hard_block` | 本条有害拦截提示，仍可继续输入 |

### `POST /api/profile-chat-confirm`

用户确认介绍（Demo）；生产上应校验 `profile_complete` 后再允许进入匹配。

---

## 7. 模型调用注意（参考 `server.js`）

- 默认模型示例：`ZHIPU_MODEL=glm-5.2`（见 `.env.example`）。
- `glm-5.x`：关闭 thinking，避免占满 `max_tokens` 导致 JSON 截断。
- `response_format: json_object`；解析失败可重试一次。
- 建议请求超时（Demo 曾因挂起导致前端 `chatBusy` 假死）。
- System 每轮追加**进度事实**（已知 / 未齐 / `profile_complete` / `resume_mode`），不写题面。

---

## 8. 前端体验契约（生产应对齐）

1. 快捷回复：单选/多选由 `quick_replies_multi` 决定；选完点发送，不自动提交。
2. 总结页：主要展示 `intro`（可编辑）；**不展示结构化标签列表**。
3. 不完整：文案提示 + **硬拦匹配**；主按钮「再聊补全」，次按钮「重新聊聊」。
4. 完整：可「确认，就按这个帮我找」进入匹配。
5. 助手名：**Zee**。

---

## 9. 后端实现检查清单（给 AI / 给人）

- [ ] 接入唯一 Prompt（与 `system-prompt.js` 同步维护）
- [ ] 实现字段 merge（含：**真答覆盖 `__skipped__`**）
- [ ] 实现 `evaluateEnd` 与 `isProfileComplete` 两套逻辑
- [ ] 实现 `resumeMode` + `seedDraft` + resumeTouched
- [ ] wrap_up 不完整时 intro 对用户说话（可用保底文案覆盖内部备注）
- [ ] 匹配入口硬校验 `profile_complete`
- [ ] 不把 `profile_update` 原文展示给用户
- [ ] 不在业务层用启发式改写下一题文案
- [ ] 会话可持久化；服务重启可恢复进行中会话（Demo 已从磁盘恢复）

---

## 10. 本地如何验收 Demo

```bash
cd demo/profile-proxy
cp .env.example .env   # 填 ZHIPU_API_KEY
npm start
```

打开：http://localhost:8788/match-card.html  

建议验收路径：

1. 正常答完全部核心题 → 完整总结 → 可确认匹配。  
2. 中途跳过若干题 → 可收束但不完整 → 不能匹配 → 再聊补全只问未齐。  
3. 补聊时低质乱答 → 应追问，不应立刻收束（满 3 次低质才可提前收束）。  
4. 「重新聊聊」清空重来。

对话存档：`demo/profile-proxy/data/chats/`（仅本地 Demo）。

---

## 11. 源码优先级（冲突时）

1. `system-prompt.js`（怎么说、问什么）  
2. `profile-schema.js`（能不能结束、算不算完整）  
3. `server.js`（怎么编排调用）  
4. `match-card.html`（交互与硬拦展示）  
5. 本文 / `ai-match-profile.md`（说明；若与源码冲突以源码为准并回写文档）

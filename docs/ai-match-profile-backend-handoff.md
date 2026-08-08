# AI 建档 v3 · 后端正式交接说明

版本：2026-07-30
用途：后端按当前已验收的 Demo 逻辑实现正式服务。
说明：本文是新的唯一交接入口，不需要参考此前的交接压缩包或旧版五字段方案。

## 1. 先看结论

目标架构不是“本地题库 + 词典优先 + GLM 兜底解析”，而是：

```text
服务端保存记忆和状态
→ 每轮把当前字段、下一字段、画像摘要和最近对话发给 GLM
→ GLM 同时生成用户回复、快捷选项、回答分类和当前字段更新
→ 服务端校验后决定写入、重问、推进或收束
```

职责边界：

- GLM：怎么说、如何理解当前回答、生成快捷选项、生成最终总结。
- 业务层：当前问哪一项、允许写哪个字段、何时推进、何时结束、能否匹配。
- 前端：展示服务端完整状态，不自行推断画像完整度。

## 2. 后端现有能力如何处理

建议保留：

- 会话持久化；
- 用户退出后恢复；
- collecting / review_pending / completed 等状态；
- 正在处理状态；
- requestId 幂等；
- 网络重连后重新拉取服务端状态；
- 已确认档案与草稿分离。

需要替换：

- 旧五字段画像；
- 本地词典优先识别；
- 服务端固定题库生成用户话术；
- “简单回答不调用 GLM”的分流；
- 模型失败后静默跳过当前题；
- 本地模板直接生成最终介绍。

详细迁移说明见 [`ai-match-profile-backend-migration.md`](./ai-match-profile-backend-migration.md)。

## 3. 画像数据结构

### 3.1 字段

固定顺序：

1. `occupation`：职业领域或在读状态。
2. `social_purpose`：希望遇见什么人，可多选或自定义。
3. `social_style`：与陌生人相处时的社交节奏。
4. `chat_topics`：喜欢聊的话题。
5. `activity_style`：偏好的线下活动氛围。
6. `schedule_preference`：通常有空的时间。
7. `stranger_story`：认识陌生人的经历，可空。
8. `friend_description`：朋友如何形容用户。

除 `stranger_story` 外，其余 7 项必须真实回答，才允许开始匹配。

### 3.2 字段状态

```json
{
  "value": "产品经理",
  "status": "answered",
  "evidence": ["用户明确回答"]
}
```

`status` 只有：

- `empty`：尚未处理；
- `answered`：有真实回答，可用于匹配；
- `skipped`：本轮跳过，不算匹配完整。

不要让模型填写 `confidence`。明确回答直接覆盖旧值，不比较模型自报分数。

完整草稿示例：

```json
{
  "version": "v3",
  "occupation": {
    "value": "产品经理",
    "status": "answered",
    "evidence": ["用户说自己做产品"]
  },
  "social_purpose": {
    "value": "饭搭子、跑船搭子",
    "status": "answered",
    "evidence": ["用户希望找饭搭子和一起跑船的人"]
  },
  "intro": "",
  "tagline": ""
}
```

`tagline`：组局列表里显示在用户昵称下方的一行短介绍，最多 15 字（按字符计，含中英文与标点）。

## 4. 会话状态

正式服务至少保存：

```json
{
  "status": "collecting",
  "resumeMode": false,
  "draft": {},
  "fieldQueue": ["occupation", "social_purpose"],
  "messages": [],
  "userTurns": 0,
  "lowQualityStreak": 0,
  "processingRequestId": null,
  "endDecision": null
}
```

推荐状态：

- `collecting`：正在采集。
- `processing`：某条回答正在处理。
- `review_pending`：本轮已收束，等待用户确认或补聊。
- `completed`：用户已确认。

`fieldQueue[0]` 是唯一 `currentField`，`fieldQueue[1]` 是 `nextField`。

## 5. 首次建档与补聊

### 首次建档

`fieldQueue` 为全部 8 项，按固定顺序处理。

开场也调用 GLM，由 Prompt 生成 Zee 的介绍、第一题和快捷选项。服务端不要写死开场文案。

### 再聊补全

根据当前草稿重新创建队列，只放入 7 个匹配字段中尚非 `answered` 的项。

`stranger_story` 即使为空，也不进入补聊必需队列。

### 重新聊聊

创建全新草稿和全新队列，不复用旧回答。

## 6. 每轮发送给 GLM 的内容

### 6.1 System

使用交接包中的 [`system-prompt.js`](../demo/profile-proxy/system-prompt.js) 作为唯一完整 Prompt。

Prompt 后追加运行事实 JSON：

```json
{
  "phase": "continue",
  "is_opening": false,
  "resume_mode": false,
  "current_field": "social_purpose",
  "next_field": "social_style",
  "profile_complete": false,
  "incomplete_fields": ["social_purpose", "social_style"],
  "draft_summary": {
    "occupation": "跑船/船员"
  },
  "turns": 2,
  "low_quality_streak": 0
}
```

### 6.2 历史

发送最近若干轮真实用户和助手消息。Demo 使用最近 8 条，生产可在 8～20 条之间选择。

不要在历史里混入内部业务指令。

### 6.3 当前回答

用户原文必须作为本轮 `user` message 发送。模型只能根据本次回答更新资料；历史只用于理解上下文。

不要发送用户 ID、手机号、Token、定位、匹配结果等业务数据。用户主动在聊天中输入的敏感内容仍会出现在原文中，应按正式隐私策略处理。

## 7. GLM 输出契约

```json
{
  "assistant_reply": "给用户看的完整回复",
  "quick_replies": ["选项"],
  "quick_replies_multi": false,
  "profile_update": {},
  "answer_status": "not_applicable|clear|ambiguous|low_quality|skip",
  "user_signal": "normal|joke|off_topic|ask_end|unsafe"
}
```

### answer_status

- `not_applicable`：开场、wrap_up、玩笑或跑题。
- `clear`：当前题答案明确，必须写入当前字段。
- `ambiguous`：可能有效但有多种解释，不写入、不推进。
- `low_quality`：乱码、明显应付、纯胡闹，不写入、不推进。
- `skip`：用户明确说跳过、不想答、不方便说。

### user_signal

- `normal`
- `joke`
- `off_topic`
- `ask_end`
- `unsafe`

`滚 / 别问了 / 不聊了 / 结束吧` 都按 `ask_end` 立即收束，不要继续追问。

### profile_update 门禁

`clear` 时只能出现 `currentField`：

```json
{
  "occupation": {
    "value": "船员",
    "evidence": ["用户说自己是跑船的"]
  }
}
```

模型写入其它字段时，服务端必须忽略。

`skip` 由服务端直接写 `status=skipped`，不依赖模型返回特殊值。

## 8. 状态转换

```text
clear + 当前字段更新有效
→ 当前字段 answered
→ fieldQueue.shift()
→ lowQualityStreak 清零

skip
→ 当前字段 skipped
→ fieldQueue.shift()
→ lowQualityStreak 清零

ambiguous
→ 不写入
→ 不推进
→ 确认当前题

low_quality
→ 不写入
→ 不推进
→ lowQualityStreak + 1

joke / off_topic
→ 不写入
→ 不推进
→ lowQualityStreak 清零

unsafe
→ 不写入
→ 不推进
→ lowQualityStreak + 1

ask_end
→ 立即进入 wrap_up
```

服务端必须确保 AI 回复正在问的方向与 `currentField / nextField` 一致，禁止话术已经跳到下一题、后台仍停在上一题。

## 9. 自定义回答

快捷选项只是降低输入成本，不是答案白名单。

例如 `social_purpose`：

- “找人一起跑船” → `跑船搭子`，`clear`；
- “找摄影搭子” → `摄影搭子`，`clear`；
- “一起逛展” → `逛展搭子`，`clear`。

禁止反复要求用户改选饭搭子、运动搭子等预设按钮。

一句话即使包含多个方向，当前 v3 也只写 `currentField`。其它信息可留在聊天历史中，之后按队列继续询问。这样可以避免模型越权修改多个长期字段。

## 10. 结束条件与完整度

满足任一条件进入 `wrap_up`：

- `fieldQueue` 为空；
- `userTurns >= 30`；
- `lowQualityStreak >= 3`；
- `user_signal=ask_end`。

结束不等于完整。

`profile_complete=true` 的唯一条件：除 `stranger_story` 外，其余 7 项全部为 `answered`。

不完整时：

- 可以展示总结；
- 不允许确认匹配；
- 提供“再聊补全”；
- 不能暗示“已经够了”或“现在可以找局”。

## 11. wrap_up

结束时额外调用一次 GLM：

```json
{
  "phase": "wrap_up",
  "profile_complete": true
}
```

要求模型输出：

- `assistant_reply`：聊天里的收束回复；
- `profile_update.intro`：总结页长介绍；
- `profile_update.tagline`：组局列表短介绍（见下方「tagline 文案规则」，须整段写入服务端 system prompt 的 wrap_up）。

完整画像：intro 约 180～280 字，包含对用户的理解和以后如何推荐局/搭子；同时给出可用 tagline。

不完整画像：接住已了解的内容，明确还有信息未齐、这次不能开始匹配、之后可以回来补；tagline 仍尽量给出。

只有 intro / tagline 为空、包含内部术语或明显占位内容时才 fallback。不得无条件覆盖合格的模型结果。确认接口可回传用户编辑后的 `intro` 与 `tagline`。

### tagline 文案规则（请同步到服务端 Prompt）

```text
tagline（必填意图）：组局列表里显示在昵称下方的一行短介绍。必须遵守以下规则：
【固定格式】必须且只能是「3 个短语」，用间隔号「·」连接，形如：短语A·短语B·短语C
- 恰好 3 段，不多不少；段与段之间只用一个「·」，两边不要空格
- 整句总字数（含两个「·」）不超过 15 个字；每个短语优先 2～4 字
- 不要句号、感叹号、逗号；不要「我是」
【三段分别写什么】
1. 第一段：身份/职业（有则写）
2. 第二段：稳定气质（朋友形容或社交风格里，选最能代表且适合公开的一个）
3. 第三段：可公开的社交方向，或活动氛围；二选一
   - 社交方向写成自然名词，如「钓友」「饭搭子」
   - 禁止生造「钓友局」「饭搭子局」
   - 禁止「主动找/想找/求…」等渴求腔
【积极改写（非常重要）】
用户建档时可能自嘲、吐槽，或朋友用玩笑/负面词形容他。tagline 是公开展示，必须往积极、体面、好相处的方向改写，禁止原样照搬负面说法。
- 侮辱/贬义（傻子、脑残、废物、难看、恶心等）：绝不写入；改成中性或正向气质，或换用其他可用正面信息
- 自嘲型外向（人来疯、话痨、社牛到尴尬、吵死了）：不要直接写；改写成「爱热闹」「好开口」「场子活」等
- 自嘲型内向（社死、无聊透顶、不合群）：改写成「慢热」「安静好聊」等，勿强化负面自我评价
- 原则：保留真实气质内核，换掉刺人外壳；宁可少写气质，也不要公开丢人
【不要写进 tagline】
- 聊天兴趣话题（可能随口一提）
- 恋爱/相亲/找对象/找异性/同性/脱单等：第三段改氛围或省略，绝不直写（羞耻感强）
【差例（禁止）】主动找钓鱼搭子；在读博士·钓友局；在读博士·人来疯·钓友；在读博士·傻子·饭搭子；爱飞盘能处好聊的局点
【合格例（勿照搬）】在读博士·能处·钓友；产品经理·慢热·饭搭子；设计师·好聊·爱热闹
```

服务端结束事件可附加一句提醒：`tagline` 必须是「短语A·短语B·短语C」三段式、总长≤15字，身份优先、气质积极改写、敏感诉求脱敏。

## 12. 失败、超时与幂等

- GLM 请求必须有超时。
- 调用失败或 JSON 连续解析失败：回滚本轮状态，不推进当前题。
- 前端展示失败并重试原 requestId。
- 同一个 requestId 重试不得重复增加轮次、重复写入消息。
- 不允许“模型失败但页面看似正常进入下一题”。

## 13. 前端接口语义

请求示例：

```json
{
  "sessionId": "string",
  "requestId": "string",
  "reset": false,
  "resumeMode": false,
  "seedDraft": null,
  "userMessage": "用户原文或 null"
}
```

关键响应：

```json
{
  "assistant_reply": "",
  "quick_replies": [],
  "quick_replies_multi": false,
  "answer_status": "clear",
  "user_signal": "normal",
  "action": "continue|handoff_summary|hard_block",
  "phase": "continue|wrap_up",
  "profile_draft": {},
  "profile_complete": false,
  "incomplete_fields": [],
  "current_field": "occupation",
  "next_field": "social_purpose",
  "status": "collecting"
}
```

前端只相信服务端：

- 不自行维护必填字段；
- 不自行计算完整度；
- 不根据聊天文案猜当前题；
- 重新进入页面时重新获取服务端完整状态。

## 14. 调试与日志

每轮建议记录：

```json
{
  "requestId": "",
  "currentFieldBefore": "",
  "answerStatus": "",
  "userSignal": "",
  "profileUpdateAccepted": false,
  "currentFieldAfter": "",
  "lowQualityStreak": 0,
  "endReasons": []
}
```

不要只保存聊天文本，否则发生错题、误推进时无法判断模型当时返回了什么分类。

## 15. 验收清单

必须全部通过：

1. 正常回答 8 题，字段顺序和快捷按钮正确。
2. “臭拉车的”先确认，不入库、不推进。
3. “货车司机”明确入库并推进。
4. “找人一起跑船”作为自定义 social_purpose 被接受。
5. “抢银行的 / 随便吧 / asdfgh”连续三次按低质收束。
6. “滚 / 别问了”立即按用户结束收束。
7. 模糊和低质时 AI 仍问 currentField，不能擅自跳题。
8. 跳过必需字段后总结不完整，不能开始匹配。
9. 第 7 题跳过，其余 7 项回答后仍完整。
10. 补聊只问未真实回答的匹配字段。
11. 真答可以覆盖此前 skipped。
12. 完整总结保留模型 intro，不被模板覆盖。
13. wrap_up 产出 ≤15 字 tagline；确认后组局列表昵称下方展示该短句。
14. 不完整收束不能说“够了”或“现在可以找局”。
15. 模型超时后不推进，重试不重复计数。
16. 退出、重连、处理中恢复和 requestId 幂等正常。

## 16. 交接包内容

- `00-请先读我.md`
- `docs/ai-match-profile-backend-handoff.md`
- `docs/ai-match-profile-backend-migration.md`
- `docs/ai-match-profile.md`
- `demo/profile-proxy/system-prompt.js`
- `demo/profile-proxy/profile-schema.js`
- `demo/profile-proxy/server.js`
- `demo/profile-proxy/profile-schema.test.js`
- `demo/profile-proxy/README.md`
- `demo/profile-proxy/package.json`
- `demo/profile-proxy/.env.example`
- `match-card.html`

实现时以本文、Prompt 和状态机源码为准。

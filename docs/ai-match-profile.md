# AI 建档（首次认识你）· v3

本地 Demo：[`match-card.html`](../match-card.html) → [`demo/profile-proxy`](../demo/profile-proxy) → 智谱。

唯一 Prompt：[`system-prompt.js`](../demo/profile-proxy/system-prompt.js)
后端交接：[`ai-match-profile-backend-handoff.md`](./ai-match-profile-backend-handoff.md)
现有后端迁移：[`ai-match-profile-backend-migration.md`](./ai-match-profile-backend-migration.md)

## 产品目标

用户第一次使用 AI 组局前，与 Zee 聊几句，形成长期可复用的社交画像。对话结束后生成一段可修改的介绍；画像未完整时不能开始匹配，可“再聊补全”或“重新聊聊”。

这是用于验证产品逻辑和 Prompt 的 Demo，不承担生产服务能力。

## 首次开场说明（前端）

首次建档（尚无任何进度）不会立刻提问，先展示贴底抽屉说明，再进对话：

- **形态**：底部抽屉贴屏幕底边（仅留安全区），高度随内容，不是居中弹窗。
- **设计**：头栏做主标题；正文一句说明 + 信息胶囊 + 三步时间线；无通栏板块、无装饰图案、无对话预览。
- **文案**：会问几个小问题，聊完才能开始认真帮你组局。
- **动作**：「开始聊聊」进入问答；「稍后再说」关闭。

「重新聊聊 / 再聊补全」不再重复说明页。开场 Prompt 也假定用户已读过说明，只打招呼后直接问第一题。

## 核心架构

- 单 Agent、单 Prompt。
- 正常轮次一次模型调用；结束时额外一次 `wrap_up`。
- Prompt 决定怎么说、怎么判断回答质量。
- 业务层维护 `fieldQueue / currentField`，决定能否推进和结束。
- 前端只展示服务端结果，不重复计算完整度。

## 画像字段

字段状态统一为：

```json
{ "value": "...", "status": "empty|answered|skipped", "evidence": [] }
```

不使用未经校准的模型置信度。

匹配需要真实回答：

- 职业/在读
- 希望遇见
- 社交人格
- 聊天偏好
- 活动风格
- 作息偏好
- 朋友眼中的你

`stranger_story` 可空，不挡匹配。

## 每轮输出

```json
{
  "assistant_reply": "",
  "quick_replies": [],
  "quick_replies_multi": false,
  "profile_update": {},
  "answer_status": "not_applicable|clear|ambiguous|low_quality|skip",
  "user_signal": "normal|joke|off_topic|ask_end|unsafe"
}
```

多选题为第 2、4、6、8 题；单选/开放题为第 1、3、5、7 题。

## 推进规则

- `clear`：写入当前字段并推进。
- `skip`：服务端记录跳过并推进。
- `ambiguous`：不入库，确认当前题。
- `low_quality`：不入库，缩短问法重问当前题。
- `joke / off_topic`：拉回当前题，不累计低质。
- `unsafe`：不入库并计入低质。

结束条件：

1. 当前字段队列已处理完；
2. 用户发言达到 30 轮；
3. 连续低质或 unsafe 达到 3 次；
4. 用户主动要求结束。

“对话结束”和“画像完整”是两回事。跳过可以让本轮继续推进，但只有匹配需要的 7 项都为 `answered` 时才允许匹配。

## 补聊

- “再聊补全”：带 v3 `seedDraft` 创建补聊队列，只问未真实回答的匹配字段。
- “重新聊聊”：清空画像，从第 1 题开始。
- 补聊时明确回答会直接覆盖此前的 `skipped`。

## 收束

`wrap_up` 负责生成：

- 给用户的一两句收束回复；
- 个性化 `intro`（总结页长文）；
- `tagline`：组局列表昵称下方的短介绍，**不超过 15 字**。

服务端保留合格的模型 intro / tagline；只有为空、格式异常或出现内部术语时才使用本地 fallback，不再无条件覆盖模型总结。

## 验收

```bash
cd demo/profile-proxy
npm test
npm start
```

也可在仓库根目录 `npm start`：会同时启动审核台（8790）与本建档代理（8788）。只测建档时用上面的子目录命令，或根目录 `npm run start:profile` 即可。

建议真实试聊：

1. 正常答完，确认完整总结。
2. “臭拉车的”先澄清，再回答“货车司机”。
3. 连续三次低质回答后收束。
4. 跳过必需题后不完整，再聊只补未齐项。
5. 第 7 题跳过但其它题答完，仍可匹配。

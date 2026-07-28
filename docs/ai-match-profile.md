# AI 建档（首次认识你）

本地 Demo：[`match-card.html`](../match-card.html) → [`demo/profile-proxy`](../demo/profile-proxy) → 智谱 `chat/completions`。

## 启动

```bash
cd demo/profile-proxy
cp .env.example .env   # 填入 ZHIPU_API_KEY
npm start
```

浏览器打开：http://localhost:8787/match-card.html →「编辑我的信息」。

## 五问结构

| 轮次 | 问什么 | 落库字段 |
|------|--------|----------|
| 开场 | 先认识你一下… | — |
| Q1 | 平时主要在做什么 | `occupation_category`, `occupation` |
| Q2 | 平时喜欢怎么玩 | `interests[{tag,weight}]` |
| Q3 | 和不熟的人相处状态 | `social_style{initiative,talkativeness,warmup_speed}` |
| Q4 | 更喜欢什么样的局 | `group_preference{preferred_size,interaction_style,energy_level}` |
| Q5 | 更想认识什么样的人 | `preferred_people{traits,age_similarity,shared_interests}` |
| 收尾 | 生成 intro + 确认 | `intro` |

完整 system prompt 见同目录旁运行时文件：[`demo/profile-proxy/system-prompt.js`](../demo/profile-proxy/system-prompt.js)（与线上代理共用，改一处即可）。

## 每轮输出 JSON

见 `system-prompt.js` 内 schema。服务端只合并 `slot_updates`，前端只展示 `assistant_message` 与 `quick_replies`。

## 对话存档

每轮对话会自动写入本地（不进 git）：

- `demo/profile-proxy/data/chats/<sessionId>.json` — 完整结构化记录
- `demo/profile-proxy/data/chats/<sessionId>.md` — 可读对话文本

查看列表：http://localhost:8787/api/profile-chats  
查看单条：http://localhost:8787/api/profile-chats/<sessionId>

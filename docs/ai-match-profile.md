# AI 建档（首次认识你）· 单 Agent

本地 Demo：[`match-card.html`](../match-card.html) → [`demo/profile-proxy`](../demo/profile-proxy) → 智谱。

可运行实现（后端参考）：[`demo/profile-proxy/`](../demo/profile-proxy/) —— 目录说明见其中 [`README.md`](../demo/profile-proxy/README.md)。  
唯一 Prompt：[`system-prompt.js`](../demo/profile-proxy/system-prompt.js)。

---

## 架构

**一个 Agent、一个 Prompt、每轮一次模型调用。**

每轮返回：

| 字段 | 给谁看 | 作用 |
|------|--------|------|
| `assistant_reply` | 用户 | 自然聊天回复 |
| `profile_update` | 后台 | 增量更新长期画像（前端不展示原文） |
| `quick_replies` | 用户 | 可选快捷按钮 |
| `user_signal` | 业务层 | 敷衍 / 想结束等意图 |

核心原则（写在 Prompt 第一条）：

> **聊天体验优先于画像采集，不要为了获取某个字段而刻意提问。**

结束时机仍由业务层控制（轮次 / 高置信字段数 / 连续敷衍 / 用户要求结束），不交给模型自己宣布「建档完成」。

---

## 业务结束条件（满足任一）

| 条件 | 默认 |
|------|------|
| 高置信字段 ≥ 5，且至少聊了 4 轮 | confidence ≥ 0.75 |
| 用户发言 ≥ 10 轮 | |
| 连续 `user_signal=low_quality` ≥ 3 | 模型判定 |
| `user_signal=ask_end` | 立刻收束 |

---

## 画像字段（6 项）

| 字段 | 含义 | 示例 |
|------|------|------|
| `social_purpose` | 为什么用 Zup / 希望遇见谁 | 饭搭子、闲聊放松、扩大社交圈、创业伙伴、异性朋友 |
| `social_style` | 社交人格 | 主动、慢热、看场合 |
| `chat_topics` | 聊天偏好 | `{ likes, dislikes }`如动漫、游戏、电影、球类、创业、八卦 |
| `activity_style` | 活动风格 | 偏安静、偏热闹、文艺 |
| `schedule_preference` | 作息偏好 | 早睡早起、夜猫子、工作日晚上、周末全天 |
| `boundaries` | 底线 | `{ smoking_nearby, drinking }` |
| `intro` | 收束时短介绍 | 40～80 字 |

每个字段：`{ value, confidence, evidence[] }`。本轮无新信息就不要写进 `profile_update`。

不主动问：性别年龄地址、学历收入职业、MBTI星座、本次组局类型、匹配性别。

---

## 启动

```bash
cd demo/profile-proxy
cp .env.example .env
npm start
```

http://localhost:8788/match-card.html （建档默认 **8788**；审核台是 **8787**）

---

## 体验要点

- 开场说清：想了解你，方便推荐更合适的朋友和局；立刻带短问题 + 例子 + 选项  
- 每轮最多一个问题，尽量短  
- 禁止复述用户原话  
- 禁止「平时怎么玩 / 什么样的局里」等含糊说法  

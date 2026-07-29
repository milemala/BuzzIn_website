# AI 建档（首次认识你）· 单 Agent

本地 Demo：[`match-card.html`](../match-card.html) → [`demo/profile-proxy`](../demo/profile-proxy) → 智谱。

可运行实现（后端参考）：[`demo/profile-proxy/`](../demo/profile-proxy/) —— 目录说明见其中 [`README.md`](../demo/profile-proxy/README.md)。  
唯一 Prompt：[`system-prompt.js`](../demo/profile-proxy/system-prompt.js)。  
**给后端 / AI 的交接文档**：[`ai-match-profile-backend-handoff.md`](./ai-match-profile-backend-handoff.md)。

---

## 架构

**一个 Agent、一个 Prompt、每轮一次模型调用。**

每轮返回：

| 字段 | 给谁看 | 作用 |
|------|--------|------|
| `assistant_reply` | 用户 | Zee 的自然聊天回复 |
| `profile_update` | 后台 | 增量更新长期画像（前端不展示原文） |
| `quick_replies` | 用户 | **由模型本轮生成**的快捷按钮，前端只负责渲染，不写死题库 |
| `quick_replies_multi` | 前端 | `true` 可多选（题 1/3/5/7），`false` 单选（题 2/4/6）；前端按此切换交互 |
| `user_signal` | 业务层 | 敷衍 / 想结束等意图 |

核心原则（写在 Prompt 第一条）：

> **聊天体验优先于画像采集，不要为了获取某个字段而刻意提问。**

结束时机仍由业务层控制（7 题槽位都已答完 / 轮次上限 / 连续敷衍 / 用户要求结束），不交给模型自己宣布「建档完成」。

---

## 业务结束条件（满足任一）

| 条件 | 默认 |
|------|------|
| 除「陌生人经历」外字段都已**处理完**（真答或跳过均可） | 可出总结 |
| 用户发言 ≥ 30 轮 | 上限收束 |
| 连续 `low_quality` / `unsafe` ≥ 3 | 提前收束 |
| `user_signal=ask_end` | 立刻收束 |

**匹配完整度（另算，硬拦组局）**：除第 7 题外，核心字段必须是真实回答（`__skipped__` 不算完整）。不完整时总结会说明，且不能开始匹配；「再聊补全」只问未齐题，「重新聊聊」清空重来。

---

## 画像字段（8 项）

| 字段 | 含义 | 示例 |
|------|------|------|
| `occupation` | 职业领域或在读（开放作答，无快捷选项） | 互联网产品、在读、自由职业做设计 |
| `social_purpose` | 希望遇见谁 | 异性朋友、饭搭子、创业伙伴、闲聊放松、扩大社交圈 |
| `social_style` | 社交人格 | 主动、慢热、一般 |
| `chat_topics` | 聊天偏好 | `{ likes, dislikes }` |
| `activity_style` | 活动风格 | 偏安静、偏热闹、分情况而定 |
| `schedule_preference` | 作息偏好 | 工作日晚上、周末、很随机 |
| `stranger_story` | 印象深刻的陌生人经历 | 短文摘要；可跳过 |
| `friend_description` | 朋友怎么形容你 | 短文摘要 |
| `intro` | 收束时总结 | 理解 + 以后怎么帮你 |

每个字段：`{ value, confidence, evidence[] }`。本轮无新信息就不要写进 `profile_update`。

不主动问：性别年龄地址、学历收入细节、公司/学校全称、MBTI星座、本次组局类型、匹配性别。职业/在读仅按第 1 题收集。

---

## 启动

```bash
cd demo/profile-proxy
cp .env.example .env
npm start
```

http://localhost:8788/match-card.html  

**建档 / 撮合 Demo 只跑这一个代理即可**（默认 8788）。  
`8787` 是 `zup-event-crawl` 活动审核台，另一套业务，不要和建档混成一个进程。

---

## 体验要点

- 助手名：**Zee**  
- 开场说清：想了解你，方便推荐更合适的朋友和局；立刻带短问题 + 例子 + 选项  
- 快捷回复：每轮由模型随问题生成，前端动态展示；改问题不必改前端  
- 每轮最多一个问题，尽量短  
- 禁止复述用户原话  
- 禁止「平时怎么玩 / 什么样的局里」等含糊说法  
- **收尾 intro**：不能只复述画像；必须包含「我理解你什么」+「以后会侧重怎么帮你找局/搭子」，给正反馈  

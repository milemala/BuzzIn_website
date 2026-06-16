# 小红书汇总帖 · Agent 读图与裁切

> **裁切精度定稿**（每场单独标框、保留真实比例、禁止套模板）：[`xiaohongshu-poster-crop-rules.md`](xiaohongshu-poster-crop-rules.md)

> **标框前内化「标框使命」**：[`xiaohongshu-vision-labeling-prompt.md`](xiaohongshu-vision-labeling-prompt.md) 第一节。由执行 Agent 读入并遵守，不是让用户拼 prompt。

## 分工（先看这个）

| 谁 | 做什么 | 不做什么 |
|----|--------|----------|
| **Agent** | 动态读 slide、问题清单标框、**一次性标最终 `posterBox`** | 不要套模板坐标；禁止语义脚本写框 |
| **裁切 JS** | 按 `posterBox` 机械裁图；生成总览图 | 不猜位置、不裁切门禁丢弃（crop/skip 已在标框阶段由模型决定） |
| **边缘吸附 JS（可选）** | 只在边缘轻微露白/缺边时预览修边（`scripts/snap-poster-box-edges.js`） | 不作为默认流程；不修语义错误；不增删框、不改 crop/skip |

> **默认目标：Agent 读图一步到位标准框。** JS 负责忠实裁切和低成本校验，不再默认跑像素吸附。吸附只处理“边缘差几像素”的几何问题，救不了“框错块、框进标题/说明文字”。

> 裁切满意前：**只跑 extract + contact sheet**，不要 import。  
> 全流程：[`xiaohongshu-review-workflow.md`](xiaohongshu-review-workflow.md)

---

## 坐标系（Agent 与 JS 一致，没有两套参考系）

`posterBox` 相对 **`images/XX.webp` 整张图**（含红边、页眉），原点在左上角，**一律用像素（px）**：

| 字段 | 含义 |
|------|------|
| `x` | 海报**左边缘**距 slide 左边的像素 |
| `y` | 海报**上边缘**距 slide 顶部的像素 |
| `w` | 海报**宽度**（像素） |
| `h` | 海报**高度**（像素） |

常见 slide 尺寸约 **1080×1443**（以实际 `images/*.webp` 为准；标框前可先确认宽高）。

JS 裁切（`lib/xiaohongshu-poster-crop.js`）直接 `sharp.extract({ left: x, top: y, width: w, height: h })`，无二次换算。

**Agent 标的框 = 最终裁出来的区域**。不要先标粗框再指望脚本修；模型应直接标目标海报外缘。

---

> **Agent 标注提示词定稿**：[`xiaohongshu-vision-labeling-prompt.md`](xiaohongshu-vision-labeling-prompt.md)（**读图标框前必读**）

## Agent 读图原则（标 posterBox 前必读）

| 字段 | 含义 |
|------|------|
| `category` | 分类（市集活动、展览、演出等） |
| `name` | 活动名称 |
| `price` | 费用简写（如「免费」「xx元起」） |
| `time` | 时间 |
| `address` | 地点 |
| **`intro`** | **审核台「介绍」全文**：slide 上本场所有介绍性文字自然合并，**不要**拆 ticket/highlights，**不要**加「门票：」「亮点：」前缀 |
| `slide` | 所在 `images/XX.webp` |
| `posterBox` | 可选，海报裁切框（见 labeling-prompt 第二节） |

旧版 `ticket` / `highlights` 仅作兼容；extract 会合并进 `intro` 写入 `body`。

### 版式假设：没有固定模板

- **同一笔记内，每张 slide 的排版可以完全不同**；不能假设「这个帖子统一是某种版式」
- 也不能套用上周、别城、同帖其他 slide、同页另一场的坐标
- 一页可能有 **1～20 场**活动（常见 2～3 场，也有单行单活动或三行市集篇）
- 活动块可能**横排、纵排、瀑布流**混排；各场海报**大小、比例可以不同**
- 海报可能在文字**左、右、上、下**任意一侧；可能有**圆角、描边、阴影、撕纸边**
- 你必须根据**画面内容**，判断「这场活动的文字说明」和「这场活动的图」谁和谁是一对

**禁止**用行高比例、固定 `x=0.58`、左 40% 等模板代替逐场看图。

### 什么是「活动海报」

活动海报通常是 slide 上的一块**独立矩形主视觉**，例如：

- 设计宣传图、演出/展览海报  
- 活动摄影、景区/场馆/市集现场图  
- 带版式的竖版或方版配图（可单独当封面）

`posterBox` 四边应贴在**该矩形主视觉的外缘**（含海报自己的底色/边框/圆角外沿），不要框到 slide 大白底或邻场区域。

### 不要当成海报

以下内容**不是**活动海报，**不要**写 `posterBox`：

| 误认对象 | 说明 |
|----------|------|
| 页面背景 / slide 底色 | 整页浅黄、浅粉、撕纸底纹 |
| 页眉大标题 | 如「XX 一周活动指南」「本周免费活动」 |
| 黄色标题条 / 高亮条 | 活动名外面的 NO.1、圆角黄底标题 |
| 装饰图形 | 页眉图标、波浪线、分隔花边 |
| 分割线 | 虚线、横线（仅用于分场，不是图） |
| 纯文字说明区 | 时间/地点/亮点列表，旁边没有独立图块 |
| 中间横条风景图 | 单活动页里贯穿左右的配图，且无右栏竖版海报时 → 常 skip，用文字封面 |

拿不准时问自己：**裁出来能像一张活动封面吗？** 若主要是文字列表 → **skip**。

### 标注前自检（每场活动）

1. 我能指出**这一场**对应哪一块图吗？（不是相邻场的图）  
2. 四边能否贴紧该图外缘，且**不夹**说明文字、邻场残影、页眉？  
3. 两个都成立 → 写 `posterBox`（px）；任一不成立 → **不写**，走文字封面  

---

## Agent 标准流程（必须按顺序）

### 阶段 0：读图输入（JPEG，同尺寸）

Cursor Read 工具通常无法直接读 `webp`。使用 **`images-jpg/XX.jpg`**（与 `images/XX.webp` 同尺寸，quality≈60）：

- 抓取时已自动双写 `images-jpg/`；缺某页时按需生成：`ensure-slide-review-jpg.js --slide=XX.webp`
- **禁止**批量转全帖 PNG（慢、占空间）
- `posterBox` 仍写回相对原 `images/XX.webp` 的像素坐标
- 旧目录若有 `images-png/`，可保留但新流程优先 `images-jpg/`

### 阶段 A：动态读图标框

一次读几张由版式复杂度决定。版式稳定时可以多读几张一起处理；版式突变、信息密集或边界难量时，单页处理。

```
读当前判断合适的一组 slide
  → 每张、每场：问题清单 → % → px
  → 同页三场 y 分行量；禁止整帖一气读完再写坐标
  → 纯文字/时间表 skip
继续下一组
```

### 阶段 B：extract + 入库

```bash
node scripts/extract-xhs-weekly-events.js data/scrape-cache/xhs/<城市>/<笔记ID>
```

有 `posterBox` 时产出 `posters/*.jpg`，然后 `import-xhs-events-to-review.js`。

**不跑**：`preview-poster-boxes.js`、`create-poster-contact-sheet.js`。

### 阶段 C：可选边缘吸附（只修几何，不修语义）

默认**不要跑**吸附。只有以下情况才用：

- 总览图里大部分框语义正确，只是四边普遍露 1～20px 白边
- 白底海报底部文字被切一点，且原框已经选对了同一张海报
- 需要批量预览“修边会不会更好”

```bash
# 默认只预览，不写回
node scripts/snap-poster-box-edges.js data/scrape-cache/xhs/<城市>/<笔记ID>

# 只有确认预览合理时才写回
node scripts/snap-poster-box-edges.js data/scrape-cache/xhs/<城市>/<笔记ID> --write
```

吸附脚本逐框做三件事（`lib/xhs-poster-edge-snap.js`）：

1. **修剪**：剔除框内边缘的邻场残影（小块墨水 + 白隙之后才是海报主体）
2. **吸附**：每条边贴到最近的「白隙↔墨水」分界（向外最多 50px，走不到回退 Agent 原值）
3. **外扩**：上下边外侧若有实质内容被切（白底海报常见），向外推到干净白隙

输出里 `⚠` 警告的场次不要直接写回；吸附只修几何，**语义错误（框错块、框进标题/说明文字）它救不了**，必须回原 slide 改 `posterBox`。

> **不要**用全图像素扫描去猜 `posterBox` 在哪（旧 measure 脚本已删除）。「哪块是海报」只能来自 Agent 读图。

### 阶段 D：入库前确认

1. `vision-slots.meta.json` 已写（含 `labeledAt`）
2. `extract` 守卫无模板坐标警告
3. **全部验收通过后再** `import-xhs-events-to-review.js`

---

## 什么时候 crop / skip

### crop（写 posterBox）

满足 **全部**：

1. 该场有一块**独立矩形主视觉**（设计海报、活动宣传图、活动现场图、景区/场馆/展品/市集现场图等均可）  
2. 尺寸与版面上像一张可单独当封面的图（大致竖版、方版或稳定横版，不是整页纯文字）  
3. 与**本场活动**对应（构图、文字、地点能对上）  
4. 能标出四边，裁切后**只有这张图**，不带右侧说明、邻场残影、页眉图标  

**不要按图片内容“高级不高级”判断。** 风景照、展品照、商场现场照、地图式活动图，只要在版面里是本场独立主视觉、尺寸足够、裁切干净，就算海报/封面图。

### skip（不写 posterBox）

- 整段只有标题+时间+地址列表，**没有任何独立图块**（如「免费电影」纯文字 slide）  
- 只有分隔装饰、 rocking horse 页眉图标等  
- **占比太小**：宽 < slide 25%，或高 < 约 280px；本地宝左侧小缩略图默认 skip  
- 图块框不干净（会跨行、会夹邻场/正文）→ 宁可 skip，用文字封面  

---

## posterBox 格式

```json
"posterBox": {
  "slide": "01.webp",
  "x": 90,
  "y": 179,
  "w": 260,
  "h": 367
}
```

`x,y,w,h` 为**整数像素**，相对该 `slide` 原图，**每场单独量**。禁止把 slide01 的坐标复制到 slide06。

旧数据若为 0–1 比例，可运行 `node scripts/migrate-poster-box-to-px.js <笔记目录>` 一次性换算。

---

## 好裁切 vs 坏裁切

| 好 | 坏 |
|----|-----|
| 裁切 = 完整一张海报/主视觉 | 左上露 slide 白边 |
| 海报标题、脚标、日期都在 | 裁掉海报下缘日期/右缘大字 |
| 不含右侧 ✅、闹钟、邻场橙条 | 把上一场的脚标裁进来 |
| 景区照、商场照也算 | 用「行高 0.2/0.48/0.76」套模板 |
| 每场 `w×h` 反映该海报真实比例 | 14 张裁出几乎相同宽高（模板坐标） |

详见 [`xiaohongshu-poster-crop-rules.md`](xiaohongshu-poster-crop-rules.md)。

---

## 裁切验收

- 标框阶段解决；**不靠**红框预览或拼大图
- `extract` 守卫（meta + 反套模板坐标）是唯一脚本侧拦截

---

## 交付自检（裁切阶段）

- [ ] 动态控制读图数量，未一次塞整帖  
- [ ] 每张 slide、每场单独判断 crop / skip；太小缩略图已 skip  
- [ ] `posterBox` 四边对准**目标海报最终外缘**，不是对准「行」  
- [ ] 已写 `vision-slots.meta.json`  
- [ ] 已对照 [`xiaohongshu-poster-crop-rules.md`](xiaohongshu-poster-crop-rules.md) 检查：每场坐标独立、比例合理、无模板感  
- [ ] 验收通过后再 import

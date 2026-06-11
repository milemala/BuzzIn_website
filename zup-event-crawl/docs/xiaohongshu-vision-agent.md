# 小红书汇总帖 · Agent 读图与裁切说明

每次抓取后，**必须由 Agent 读当次的 `images/*.webp`**，不能复用上一周的 posterBox，也不能用固定算法猜。

> 上下游流程见 **[`xiaohongshu-review-workflow.md`](xiaohongshu-review-workflow.md)**。写完本文件后执行：  
> `node scripts/run-xhs-weekly-pipeline.js --skip-scrape --city=<城市>`

## Agent 任务（按笔记目录）

目录示例：`data/scrape-cache/xhs/北京/<笔记ID>/`

### 1. 读 slide 全图

- 从 `01.webp` 起读（`00.webp` 多为封面可跳过）
- 判断本页有几场活动（常见 2–3 场）、各自在图中的位置
- 版式每次可能不同：左右分栏、上下堆叠、一图一场、海报嵌在角落、纯文字列表等
- **每张 slide 的所有活动都要写入 vision-slots**（如 `01_0`、`01_1`、`01_2`），不能整页只写一条

### 2. 填写 `vision-slots.json`

键名：`{slide序号}_{页内序号}`，如 `01_0`、`01_1`（仅作 ID）。

每条至少包含：

| 字段 | 说明 |
|------|------|
| `slide` | 所在 slide 文件名，如 `01.webp` |
| `name` | 活动名称 |
| `time` | 时间 |
| `address` | 地址 |
| `price` | 费用，无则 `null` |
| `highlights` | 亮点/介绍 |
| `category` | 市集活动 / 主题快闪 等 |
| `posterBox` | **仅包围活动海报图**的矩形，见下 |

### 3. 标注 `posterBox`（每次重新看图画框）

用 **相对 slide 宽高的 0–1 比例**（推荐）：

```json
"posterBox": {
  "slide": "01.webp",
  "x": 0.018,
  "y": 0.20,
  "w": 0.38,
  "h": 0.36
}
```

- `x,y`：矩形左上角
- `w,h`：宽、高（占整张 slide 的比例）
- **只框活动自带的海报/主视觉**，不要框右侧说明文字、不要框整页
- 同一张 slide 上两场活动 → 两个条目、两个 `posterBox`
- 若本场没有独立海报图（纯文字、或仅有装饰小插图）→ **不写 `posterBox`**，`poster` 输出为 null，不要硬裁右侧文字或装饰图
- 装饰性插图（如汉服小人、绣球花照片）不算活动海报，勿为其写 `posterBox`
- 文字汇总 slide 上**右侧小插图**（窄条、嵌在段落旁）往往裁不干净 → **不写 `posterBox`**，宁可 `poster` 留空

也可用像素：`left` / `top` / `width` / `height`。

### 4. 运行合并脚本

```bash
node scripts/extract-xhs-weekly-events.js data/scrape-cache/xhs/<城市>/<笔记ID>
```

脚本**只**按 `posterBox` 裁切，生成 `posters/` 与 `events-extracted.json`。

## 禁止事项

- 不要用固定「左 40%」或城市专用裁切规则
- 不要从其他笔记/上周复制 `posterBox`
- 不要让脚本自动猜裁切区域（已移除所有启发式/北京专用算法）

## 自检

裁切后打开 `posters/xx_slotx.jpg`：

- 应只有该活动海报图
- 不应包含右侧粉框标题、地址列表等排版文字
- 不应是整张 slide

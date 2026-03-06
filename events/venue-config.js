/**
 * 北京春醒交友季 — 商户配置表
 * ─────────────────────────────
 * 使用方式：在通用商户页 spring-venue.html
 *          通过 URL 参数 ?id=xxx 加载对应商户数据
 *
 * 新增商户只需在 VENUES 对象中添加一条记录即可，无需修改 HTML。
 *
 * 字段说明：
 *   name        — 商户全名（用于标题、结尾、meta 等）
 *   collabName  — Hero 联名区域短名（可选，不填则用 name）
 *   intro       — 商户介绍第一段（支持 HTML）
 *   address     — 地址
 *   heroImage   — 头图 URL
 *   gallery     — 图集 URL 数组
 *   searchTip   — "怎么参与"中的搜索关键词
 *   events      — 店内活动数组（可选，不填则隐藏该板块）
 *                 每项: { tag: "标签", title: "标题", desc: "描述", time: "时间（可选）" }
 *   benefit     — 到店福利（可选，不填则隐藏该板块）
 *                 { icon: "emoji", title: "标题", desc: "描述(支持HTML)", note: "备注" }
 */

var VENUES = {

  /* ── 微醺九号·炭火料理 ── */
  weixun: {
    name: "微醺九号·炭火料理",
    collabName: "微醺九号·炭火料理",
    intro: '我们是一家<em>西餐吧+酒馆</em>，开在建国门核心商圈，有个很chill的小院，闹中取静。老板对菜品和酒品很挑剔，出品都很用心。',
    address: "北京市朝阳区光华路44号A2（法国里昂餐厅东侧）",
    heroImage: "https://cdn.nowmap.cn/h5_event/merchant/weixun9hao/3.png?x-oss-process=image/resize,m_lfit,w_800,limit_1/format,webp/quality,q_80",
    gallery: [
      "https://cdn.nowmap.cn/h5_event/merchant/weixun9hao/6.png?x-oss-process=image/resize,m_lfit,w_800,limit_1/format,webp/quality,q_80",
      "https://cdn.nowmap.cn/h5_event/merchant/weixun9hao/5.jpg?x-oss-process=image/resize,m_lfit,w_800,limit_1/format,webp/quality,q_80",
      "https://cdn.nowmap.cn/h5_event/merchant/weixun9hao/4.jpg?x-oss-process=image/resize,m_lfit,w_800,limit_1/format,webp/quality,q_80",
      "https://cdn.nowmap.cn/h5_event/merchant/weixun9hao/2.png?x-oss-process=image/resize,m_lfit,w_800,limit_1/format,webp/quality,q_80",
      "https://cdn.nowmap.cn/h5_event/merchant/weixun9hao/1.png?x-oss-process=image/resize,m_lfit,w_800,limit_1/format,webp/quality,q_80"
    ],
    searchTip: "微醺九号",
    events: [
      { tag: "每天晚上", title: "春醒社交酒局", desc: "精酿品牌创始人精选当季精酿，边品边聊。一个人来也完全ok，吧台自然破冰，聊聊天、碰个杯，轻松认识新朋友。", time: "活动期间每晚 19:00 — 23:00" },
      { tag: "限定", title: "春醒周末派对夜", desc: "3月22日（周六）特别企划，现场音乐 + 春日特调 + 互动游戏，一起来吧。", time: "3月22日 20:00 — 凌晨" }
    ],
    benefit: { icon: "🎁", title: "春醒赠饮", desc: '活动期间到店，在 Zup! 完成签到即可领取<b>「春醒特调」一杯</b>。<br>一杯春天的味道，很高兴见到你。', note: "* 每人限领一次，具体品类以店内实际供应为准" }
  },

  /* ── 蓝境酒馆 LANJING ── */
  lanjing: {
    name: "蓝境酒馆 LANJING",
    collabName: "蓝境酒馆 LANJING",
    intro: '以静谧蓝调氛围打造都市夜晚的<em>治愈空间</em>，主打<em>创意特调与精致小食</em>，氛围松弛有度，是朋友小聚、放松小酌的理想酒馆，让每一次微醺都自在又难忘。',
    address: "北京市朝阳区望京街9号万科时代中心F座地下一层下沉广场南侧(近申德勒西餐厅)",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/02/09/a0/60/fec79141-11a4-4981-9cb9-0dc8b04e0b10.jpg?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/02/09/2d/d6/77f8d5a9-52c4-4e57-955e-3a25a5956f70.webp?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/09/15/4b/4c8db8a8-1849-42e2-b840-f03555830438.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/09/93/98/305feb0f-7478-4637-b001-e11ac61b7355.jpg?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "蓝境酒馆",
    events: [
      { tag: "每天晚上", title: "春醒社交酒局", desc: "精酿品牌创始人精选当季精酿，边品边聊。一个人来也完全ok，吧台自然破冰，聊聊天、碰个杯，轻松认识新朋友。", time: "活动期间每晚 19:00 — 23:00" },
      { tag: "限定", title: "春醒周末派对夜", desc: "3月22日（周六）特别企划，现场音乐 + 春日特调 + 互动游戏，一起来吧。", time: "3月22日 20:00 — 凌晨" }
    ],
    benefit: { icon: "🎁", title: "春醒赠饮", desc: '活动期间到店，在 Zup! 完成签到即可领取<b>「春醒特调」一杯</b>。<br>一杯春天的味道，很高兴见到你。', note: "* 每人限领一次，具体品类以店内实际供应为准" }
  },

  /* ── 破斧酒吧 ── */
  pofu: {
    name: "破斧酒吧",
    collabName: "破斧酒吧",
    intro: '破斧酒吧是北京超火的<em>哈利·波特魔法主题清吧</em>，沉浸式还原霍格沃茨氛围，悬浮蜡烛、魔杖、魔法袍与分院帽等细节拉满；主打福灵剂、吐真剂、黄油啤酒等<em>创意魔法特调</em>，可免费换装拍照，氛围感与出片度双高，是哈迷聚会、年轻人微醺社交的宝藏据点。',
    address: "北京市通州区台湖镇唐大庄村135号",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/01/31/98/e2/688e3055-fad6-46d3-845b-af896236b370.JPG?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/01/31/81/2b/fdd60a8e-a2fa-44b6-8c15-8f573c338bd1.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/31/c7/9f/bd57b55e-6edb-4c5c-a529-d7be236be560.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/31/4f/47/793c128f-7cfc-498f-9c81-f88aa445793e.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/31/dd/27/ac6a9303-b762-4f9a-9785-b644dcd1bb03.JPG?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "破斧酒吧",
    events: [
      { tag: "每天晚上", title: "春醒社交酒局", desc: "精酿品牌创始人精选当季精酿，边品边聊。一个人来也完全ok，吧台自然破冰，聊聊天、碰个杯，轻松认识新朋友。", time: "活动期间每晚 19:00 — 23:00" },
      { tag: "限定", title: "春醒周末派对夜", desc: "3月22日（周六）特别企划，现场音乐 + 春日特调 + 互动游戏，一起来吧。", time: "3月22日 20:00 — 凌晨" }
    ],
    benefit: { icon: "🎁", title: "春醒赠饮", desc: '活动期间到店，在 Zup! 完成签到即可领取<b>「春醒特调」一杯</b>。<br>一杯春天的味道，很高兴见到你。', note: "* 每人限领一次，具体品类以店内实际供应为准" }
  },

  /* ── 八荒·MIDBAR（永利国际购物中心店） ── */
  bahuang: {
    name: "八荒·MIDBAR（永利国际购物中心店）",
    collabName: "八荒·MIDBAR",
    intro: '三里屯高空秘境，暗黑清冷森林风与热带绿植交织，酒单如诗集，每杯<em>特调</em>（如《克林索尔的夏天》《山音》）自带文艺注脚，窗外是都市霓虹，杯里藏诗意与层次，是逃离喧嚣、<em>沉浸式微醺</em>的高空绿洲。',
    address: "北京市朝阳区三里屯街道工人体育场北路21号楼1单元1609",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/01/29/57/73/8fda5714-a691-4e43-a14e-d5f267cc7f62.jpg?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/01/29/19/a8/39c7f034-cfe9-46ef-9fdc-56a76fa3d164.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/1f/c1/67081b36-f098-4739-b5b0-535a6f73176b.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/3a/71/33364064-9f3b-47e7-b8df-0f661be9eb2d.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/57/73/8fda5714-a691-4e43-a14e-d5f267cc7f62.jpg?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "八荒",
    events: [
      { tag: "每天晚上", title: "春醒社交酒局", desc: "精酿品牌创始人精选当季精酿，边品边聊。一个人来也完全ok，吧台自然破冰，聊聊天、碰个杯，轻松认识新朋友。", time: "活动期间每晚 19:00 — 23:00" },
      { tag: "限定", title: "春醒周末派对夜", desc: "3月22日（周六）特别企划，现场音乐 + 春日特调 + 互动游戏，一起来吧。", time: "3月22日 20:00 — 凌晨" }
    ],
    benefit: { icon: "🎁", title: "春醒赠饮", desc: '活动期间到店，在 Zup! 完成签到即可领取<b>「春醒特调」一杯</b>。<br>一杯春天的味道，很高兴见到你。', note: "* 每人限领一次，具体品类以店内实际供应为准" }
  },

  /* ── 八荒·Hutong Lab ── */
  "bahuang-hutonglab": {
    name: "八荒·Hutong Lab",
    collabName: "八荒·Hutong Lab",
    intro: '藏于二环胡同的独门小院，冷调蓝调实验室风融合东方禅意，酒单以电影为灵感（如《一一》《冈仁波齐》），茶、水果、草本香料碰撞出<em>独特风味</em>，大隐隐于市，是胡同里的<em>小众文艺品酒实验室</em>。',
    address: "北京市东城区安定门街道安定门西大街5号",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/01/29/04/a9/83e16f7a-53f7-4526-adc7-3d5a07dd8439.jpg?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/01/29/80/26/e6c4be36-a040-49a8-8dab-ac81d833a832.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/11/41/51fef98b-7a29-4d77-95ab-274b8de0de83.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/69/2b/dad7a062-f2ce-44ba-b0b5-eb111572bdd4.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/2a/a8/8422dd1d-eb00-4d7e-afa0-290465b0b804.jpg?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "八荒",
    events: [
      { tag: "每天晚上", title: "春醒社交酒局", desc: "精酿品牌创始人精选当季精酿，边品边聊。一个人来也完全ok，吧台自然破冰，聊聊天、碰个杯，轻松认识新朋友。", time: "活动期间每晚 19:00 — 23:00" },
      { tag: "限定", title: "春醒周末派对夜", desc: "3月22日（周六）特别企划，现场音乐 + 春日特调 + 互动游戏，一起来吧。", time: "3月22日 20:00 — 凌晨" }
    ],
    benefit: { icon: "🎁", title: "春醒赠饮", desc: '活动期间到店，在 Zup! 完成签到即可领取<b>「春醒特调」一杯</b>。<br>一杯春天的味道，很高兴见到你。', note: "* 每人限领一次，具体品类以店内实际供应为准" }
  },

  /* ── 哈哈酒馆 ── */
  haha: {
    name: "哈哈酒馆",
    collabName: "哈哈酒馆",
    intro: '位于昌平回龙观的<em>温馨社区小酒馆</em>，复古轻松氛围，主打高性价比精酿与创意特调，晚间有温柔驻唱，搭配下酒小食，氛围松弛不吵闹，是附近年轻人下班放松、朋友小聚、<em>轻松微醺</em>的亲民好去处。',
    address: "北京市昌平区龙泽园街道回龙观西大街9号院17-14号",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/02/09/ce/65/967d1bf7-ab7c-469e-9362-2db376e5f6fd.JPG?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/02/09/18/30/7bf98853-29ba-41f7-8c45-d37aaa10b75c.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/09/b1/91/ec5e61f0-ed8a-43db-92a0-fa780167285d.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/09/01/fd/afdc0614-a7f1-4897-99d3-631ed343f58d.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/09/ce/65/967d1bf7-ab7c-469e-9362-2db376e5f6fd.JPG?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "哈哈酒馆",
    events: [
      { tag: "每天晚上", title: "春醒社交酒局", desc: "精酿品牌创始人精选当季精酿，边品边聊。一个人来也完全ok，吧台自然破冰，聊聊天、碰个杯，轻松认识新朋友。", time: "活动期间每晚 19:00 — 23:00" },
      { tag: "限定", title: "春醒周末派对夜", desc: "3月22日（周六）特别企划，现场音乐 + 春日特调 + 互动游戏，一起来吧。", time: "3月22日 20:00 — 凌晨" }
    ],
    benefit: { icon: "🎁", title: "春醒赠饮", desc: '活动期间到店，在 Zup! 完成签到即可领取<b>「春醒特调」一杯</b>。<br>一杯春天的味道，很高兴见到你。', note: "* 每人限领一次，具体品类以店内实际供应为准" }
  },

  /* ── weplay兴趣社交客厅 ── */
  weplay: {
    name: "weplay兴趣社交客厅",
    collabName: "weplay",
    intro: '年轻人专属线下社交空间，主打轻松无压力、<em>沉浸式兴趣社交</em>；日常举办蒙眼漫谈、桌游派对、治愈夜聊、主题分享等多元活动，环境温馨像家一样自在，帮你快速打破陌生感，是都市人下班解压、周末找搭子、真实交友的宝藏客厅。',
    address: "北京市昌平区龙泽园街道回龙观西大街9号院17-14号",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/02/10/4b/2b/49a8242b-3de2-4077-a397-0c90e1ee4883.jpg?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/02/10/7e/c8/754bf112-0dd7-4f70-86dc-e941daa704ba.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/10/c3/e2/4301424d-8d2f-4b6a-a98e-8179df134714.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/10/34/34/9becfbdb-f223-4ca8-835b-0a8607adb771.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/10/4b/2b/49a8242b-3de2-4077-a397-0c90e1ee4883.jpg?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "weplay",
    events: [
      { tag: "每天晚上", title: "春醒社交酒局", desc: "精酿品牌创始人精选当季精酿，边品边聊。一个人来也完全ok，吧台自然破冰，聊聊天、碰个杯，轻松认识新朋友。", time: "活动期间每晚 19:00 — 23:00" },
      { tag: "限定", title: "春醒周末派对夜", desc: "3月22日（周六）特别企划，现场音乐 + 春日特调 + 互动游戏，一起来吧。", time: "3月22日 20:00 — 凌晨" }
    ],
    benefit: { icon: "🎁", title: "春醒赠饮", desc: '活动期间到店，在 Zup! 完成签到即可领取<b>「春醒特调」一杯</b>。<br>一杯春天的味道，很高兴见到你。', note: "* 每人限领一次，具体品类以店内实际供应为准" }
  },

  /* ── 奇点·宇宙客厅 ── */
  yuzhou: {
    name: "奇点·宇宙客厅 Coffee&Cocktail",
    collabName: "奇点·宇宙客厅",
    intro: '坐落于五道口的学术主题<em>日咖夜酒</em>，复古文艺空间藏满书籍与思想，白天是<em>咖啡与阅读</em>的治愈角落，夜晚变身为知识碰撞的微醺客厅；定期举办<em>学术讲座与文化分享</em>，氛围松弛有深度，是学霸、文艺青年与思考者的理想聚集地。',
    address: "北京市海淀区中关村街道五道口华清商务会馆1601B",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/02/11/03/09/fe0019b7-61f7-48b1-91e0-b1aca520adf4.jpg?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/02/09/e6/72/35b8bf2d-09a5-461f-8db0-ba3fa80ba004.webp?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/11/f6/c9/46285ad1-0fdd-49d3-9734-a0b86a656007.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/11/e3/c2/b9014ae2-22ea-469e-8281-4294df50bffa.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/11/c0/43/3079f9e2-2a67-45b2-88d3-2b654d6acc50.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/11/54/36/f9154d2f-84c6-4f86-aeba-57feb3b46b69.jpg?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "宇宙客厅",
    events: [
      { tag: "每天晚上", title: "春醒社交酒局", desc: "精酿品牌创始人精选当季精酿，边品边聊。一个人来也完全ok，吧台自然破冰，聊聊天、碰个杯，轻松认识新朋友。", time: "活动期间每晚 19:00 — 23:00" },
      { tag: "限定", title: "春醒周末派对夜", desc: "3月22日（周六）特别企划，现场音乐 + 春日特调 + 互动游戏，一起来吧。", time: "3月22日 20:00 — 凌晨" }
    ]
  },

 /* ── 奇点·宇宙客厅 ── */
 oldhouse: {
  name: "老房子酒吧THE OLD HOUSE BAR",
  collabName: "老房子酒吧",
  intro: '以美式复古宅邸风格打造沉浸式优雅空间，主打高品质威士忌与平衡感十足的<em>创意鸡尾酒</em>，氛围安静高级、私密松弛，是约会、小聚、品酒放松的质感之选。',
  address: "北京市朝阳区酒仙桥街道酒仙桥路甲13号零秒社区151号楼1层1-118号底商",
  heroImage: "https://cdn.nowmap.cn/bz/media/2026/03/06/1d/69/55acc001-370c-4794-8ee4-1c3aa2a56ff1.jpg?x-oss-process=image/quality,q_80/resize,w_1080",
  gallery: [
    "https://cdn.nowmap.cn/bz/media/2026/03/06/8b/a6/13e77e53-b2f7-495c-bc99-60cca3bd33cb.jpg?x-oss-process=image/quality,q_80/resize,w_720",
    "https://cdn.nowmap.cn/bz/media/2026/03/06/0e/ff/943688fc-bd82-46ef-b12f-fd5f52e57c98.jpg?x-oss-process=image/quality,q_80/resize,w_720",
    "https://cdn.nowmap.cn/bz/media/2026/03/06/b5/ae/2c4afc53-7585-436f-b30c-639a4d19a183.jpg?x-oss-process=image/quality,q_80/resize,w_720",
    "https://cdn.nowmap.cn/bz/media/2026/03/06/f4/f9/cee15567-39fd-47b3-b387-7dda824ca571.jpg?x-oss-process=image/quality,q_80/resize,w_720"
  ],
  searchTip: "老房子酒吧",
  events: [
    { tag: "每天晚上", title: "春醒社交酒局", desc: "精酿品牌创始人精选当季精酿，边品边聊。一个人来也完全ok，吧台自然破冰，聊聊天、碰个杯，轻松认识新朋友。", time: "活动期间每晚 19:00 — 23:00" },
    { tag: "限定", title: "春醒周末派对夜", desc: "3月22日（周六）特别企划，现场音乐 + 春日特调 + 互动游戏，一起来吧。", time: "3月22日 20:00 — 凌晨" }
  ],
  benefit: { icon: "🎁", title: "春醒赠饮", desc: '活动期间到店，在 Zup! 完成签到即可领取<b>「春醒特调」一杯</b>。<br>一杯春天的味道，很高兴见到你。', note: "* 每人限领一次，具体品类以店内实际供应为准" }
}

};

/**
 * 北京春醒交友季 — 商户配置表
 * ─────────────────────────────
 * 使用方式：在通用商户页 beijing-spring-awakening-venue-v2.html
 *          通过 URL 参数 ?id=xxx 加载对应商户数据
 *
 * 新增商户只需在 VENUES 对象中添加一条记录即可，无需修改 HTML。
 */

var VENUES = {

  /* ── 微醺九号·炭火料理 ── */
  weixun: {
    name: "微醺九号·炭火料理",
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
    searchTip: "微醺九号"
  },

  /* ── 蓝境酒馆 LANJING ── */
  lanjing: {
    name: "蓝境酒馆 LANJING",
    intro: '以静谧蓝调氛围打造都市夜晚的<em>治愈空间</em>，主打<em>创意特调与精致小食</em>，氛围松弛有度，是朋友小聚、放松小酌的理想酒馆，让每一次微醺都自在又难忘。',
    address: "北京市朝阳区望京街9号万科时代中心F座地下一层下沉广场南侧(近申德勒西餐厅)",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/02/09/a0/60/fec79141-11a4-4981-9cb9-0dc8b04e0b10.jpg?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/02/09/2d/d6/77f8d5a9-52c4-4e57-955e-3a25a5956f70.webp?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/09/15/4b/4c8db8a8-1849-42e2-b840-f03555830438.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/09/93/98/305feb0f-7478-4637-b001-e11ac61b7355.jpg?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "蓝境酒馆"
  },

  /* ── 破斧酒吧 ── */
  pofu: {
    name: "破斧酒吧",
    intro: '破斧酒吧是北京超火的<em>哈利·波特魔法主题清吧</em>，沉浸式还原霍格沃茨氛围，悬浮蜡烛、魔杖、魔法袍与分院帽等细节拉满；主打福灵剂、吐真剂、黄油啤酒等<em>创意魔法特调</em>，可免费换装拍照，氛围感与出片度双高，是哈迷聚会、年轻人微醺社交的宝藏据点。',
    address: "北京市通州区台湖镇唐大庄村135号",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/01/31/98/e2/688e3055-fad6-46d3-845b-af896236b370.JPG?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/01/31/81/2b/fdd60a8e-a2fa-44b6-8c15-8f573c338bd1.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/31/c7/9f/bd57b55e-6edb-4c5c-a529-d7be236be560.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/31/4f/47/793c128f-7cfc-498f-9c81-f88aa445793e.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/31/dd/27/ac6a9303-b762-4f9a-9785-b644dcd1bb03.JPG?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "破斧酒吧"
  },

  /* ── 八荒·MIDBAR（永利国际购物中心店） ── */
  bahuang: {
    name: "八荒·MIDBAR（永利国际购物中心店）",
    intro: '三里屯高空秘境，暗黑清冷森林风与热带绿植交织，酒单如诗集，每杯<em>特调</em>（如《克林索尔的夏天》《山音》）自带文艺注脚，窗外是都市霓虹，杯里藏诗意与层次，是逃离喧嚣、<em>沉浸式微醺</em>的高空绿洲。',
    address: "北京市朝阳区三里屯街道工人体育场北路21号楼1单元1609",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/01/29/57/73/8fda5714-a691-4e43-a14e-d5f267cc7f62.jpg?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/01/29/19/a8/39c7f034-cfe9-46ef-9fdc-56a76fa3d164.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/1f/c1/67081b36-f098-4739-b5b0-535a6f73176b.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/3a/71/33364064-9f3b-47e7-b8df-0f661be9eb2d.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/57/73/8fda5714-a691-4e43-a14e-d5f267cc7f62.jpg?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "八荒"
  },

  /* ── 八荒·Hutong Lab ── */
  "bahuang-hutonglab": {
    name: "八荒·Hutong Lab",
    intro: '藏于二环胡同的独门小院，冷调蓝调实验室风融合东方禅意，酒单以电影为灵感（如《一一》《冈仁波齐》），茶、水果、草本香料碰撞出<em>独特风味</em>，大隐隐于市，是胡同里的<em>小众文艺品酒实验室</em>。',
    address: "北京市东城区安定门街道安定门西大街5号",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/01/29/04/a9/83e16f7a-53f7-4526-adc7-3d5a07dd8439.jpg?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/01/29/80/26/e6c4be36-a040-49a8-8dab-ac81d833a832.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/11/41/51fef98b-7a29-4d77-95ab-274b8de0de83.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/69/2b/dad7a062-f2ce-44ba-b0b5-eb111572bdd4.jpg?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/01/29/2a/a8/8422dd1d-eb00-4d7e-afa0-290465b0b804.jpg?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "八荒"
  },

  /* ── 哈哈酒馆 ── */
  haha: {
    name: "哈哈酒馆",
    intro: '位于昌平回龙观的<em>温馨社区小酒馆</em>，复古轻松氛围，主打高性价比精酿与创意特调，晚间有温柔驻唱，搭配下酒小食，氛围松弛不吵闹，是附近年轻人下班放松、朋友小聚、<em>轻松微醺</em>的亲民好去处。',
    address: "北京市昌平区龙泽园街道回龙观西大街9号院17-14号",
    heroImage: "https://cdn.nowmap.cn/bz/media/2026/02/09/ce/65/967d1bf7-ab7c-469e-9362-2db376e5f6fd.JPG?x-oss-process=image/quality,q_80/resize,w_1080",
    gallery: [
      "https://cdn.nowmap.cn/bz/media/2026/02/09/18/30/7bf98853-29ba-41f7-8c45-d37aaa10b75c.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/09/b1/91/ec5e61f0-ed8a-43db-92a0-fa780167285d.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/09/01/fd/afdc0614-a7f1-4897-99d3-631ed343f58d.JPG?x-oss-process=image/quality,q_80/resize,w_720",
      "https://cdn.nowmap.cn/bz/media/2026/02/09/ce/65/967d1bf7-ab7c-469e-9362-2db376e5f6fd.JPG?x-oss-process=image/quality,q_80/resize,w_720"
    ],
    searchTip: "哈哈酒馆"
  }

};

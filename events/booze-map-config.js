/**
 * 酒鬼地图 — 线路配置表
 * ─────────────────────────────
 * 使用方式：在 booze-map.html 中引用本文件
 *
 * 新增/修改线路只需编辑 ROUTES 数组即可，无需修改 HTML。
 *
 * 字段说明：
 *   id      — 线路唯一标识
 *   name    — 线路名称（展示用）
 *   tag     — 线路标签/主题词（如"三里屯"、"望京"）
 *   bars    — 包含 3 家酒馆的数组
 *     ├ name    — 酒馆名称
 *     ├ drink   — 可兑换的酒名
 *     ├ image   — 酒馆图片 URL
 *     └ address — 酒馆地址
 *
 * 价格统一为 66 元，在 HTML 中写死，如需修改在 HTML 里全局搜索 66 替换即可。
 */

var ROUTES = [

  {
    id: "route-1",
    name: "三里屯微醺之旅",
    tag: "三里屯",
    bars: [
      { name: "八荒·MIDBAR", drink: "克林索尔的夏天", image: "https://cdn.nowmap.cn/bz/media/2026/01/29/57/73/8fda5714-a691-4e43-a14e-d5f267cc7f62.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区三里屯工体北路21号楼" },
      { name: "Hye! Bar", drink: "霓虹日落", image: "https://cdn.nowmap.cn/bz/media/2026/03/09/17/8e/2355e011-0164-4d68-bc8f-eebee203c719.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "东城区人民美术文创园内" },
      { name: "蓝境酒馆", drink: "蓝调特调", image: "https://cdn.nowmap.cn/bz/media/2026/02/09/a0/60/fec79141-11a4-4981-9cb9-0dc8b04e0b10.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区望京街9号万科时代中心" }
    ]
  },

  {
    id: "route-2",
    name: "胡同探秘夜行",
    tag: "东城",
    bars: [
      { name: "八荒·Hutong Lab", drink: "冈仁波齐", image: "https://cdn.nowmap.cn/bz/media/2026/01/29/04/a9/83e16f7a-53f7-4526-adc7-3d5a07dd8439.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "东城区安定门西大街5号" },
      { name: "中華酒場燈籠", drink: "灯笼特调", image: "https://cdn.nowmap.cn/bz/media/2026/03/07/09/55/a3acacb3-efe2-47c0-92c2-35b2c402018f.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区华远九都汇提灯街B1" },
      { name: "Azusa#2", drink: "樱花威士忌", image: "https://cdn.nowmap.cn/bz/media/2026/03/07/52/65/21905610-c42e-4234-81ad-9b505ae4bb09.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区华远九都汇提灯街B1" }
    ]
  },

  {
    id: "route-3",
    name: "建国门小酌之夜",
    tag: "建国门",
    bars: [
      { name: "微醺九号·炭火料理", drink: "春醒特调", image: "https://cdn.nowmap.cn/h5_event/merchant/weixun9hao/3.png?x-oss-process=image/resize,m_lfit,w_400,limit_1/format,webp/quality,q_80", address: "朝阳区光华路44号A2" },
      { name: "老房子酒吧", drink: "Old Fashioned", image: "https://cdn.nowmap.cn/bz/media/2026/03/06/1d/69/55acc001-370c-4794-8ee4-1c3aa2a56ff1.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区酒仙桥路甲13号" },
      { name: "哈哈酒馆", drink: "快乐水", image: "https://cdn.nowmap.cn/bz/media/2026/02/09/ce/65/967d1bf7-ab7c-469e-9362-2db376e5f6fd.JPG?x-oss-process=image/quality,q_80/resize,w_400", address: "昌平区回龙观西大街9号院" }
    ]
  },

  {
    id: "route-4",
    name: "五道口学术酒局",
    tag: "海淀",
    bars: [
      { name: "奇点·宇宙客厅", drink: "宇宙拿铁鸡尾酒", image: "https://cdn.nowmap.cn/bz/media/2026/02/11/03/09/fe0019b7-61f7-48b1-91e0-b1aca520adf4.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "海淀区五道口华清商务会馆" },
      { name: "蓝境酒馆", drink: "蓝调特调", image: "https://cdn.nowmap.cn/bz/media/2026/02/09/a0/60/fec79141-11a4-4981-9cb9-0dc8b04e0b10.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区望京街9号万科时代中心" },
      { name: "破斧酒吧", drink: "福灵剂", image: "https://cdn.nowmap.cn/bz/media/2026/01/31/98/e2/688e3055-fad6-46d3-845b-af896236b370.JPG?x-oss-process=image/quality,q_80/resize,w_400", address: "通州区台湖镇唐大庄村135号" }
    ]
  },

  {
    id: "route-5",
    name: "望京深夜食堂",
    tag: "望京",
    bars: [
      { name: "蓝境酒馆", drink: "望京之夜", image: "https://cdn.nowmap.cn/bz/media/2026/02/09/a0/60/fec79141-11a4-4981-9cb9-0dc8b04e0b10.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区望京街9号万科时代中心" },
      { name: "八荒·MIDBAR", drink: "山音", image: "https://cdn.nowmap.cn/bz/media/2026/01/29/57/73/8fda5714-a691-4e43-a14e-d5f267cc7f62.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区三里屯工体北路21号楼" },
      { name: "中華酒場燈籠", drink: "提灯特调", image: "https://cdn.nowmap.cn/bz/media/2026/03/07/09/55/a3acacb3-efe2-47c0-92c2-35b2c402018f.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区华远九都汇提灯街B1" }
    ]
  },

  {
    id: "route-6",
    name: "魔法主题之夜",
    tag: "通州",
    bars: [
      { name: "破斧酒吧", drink: "吐真剂", image: "https://cdn.nowmap.cn/bz/media/2026/01/31/98/e2/688e3055-fad6-46d3-845b-af896236b370.JPG?x-oss-process=image/quality,q_80/resize,w_400", address: "通州区台湖镇唐大庄村135号" },
      { name: "哈哈酒馆", drink: "精酿IPA", image: "https://cdn.nowmap.cn/bz/media/2026/02/09/ce/65/967d1bf7-ab7c-469e-9362-2db376e5f6fd.JPG?x-oss-process=image/quality,q_80/resize,w_400", address: "昌平区回龙观西大街9号院" },
      { name: "Hye! Bar", drink: "液氮冰球", image: "https://cdn.nowmap.cn/bz/media/2026/03/09/17/8e/2355e011-0164-4d68-bc8f-eebee203c719.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "东城区人民美术文创园内" }
    ]
  },

  {
    id: "route-7",
    name: "文艺青年漫游",
    tag: "文艺",
    bars: [
      { name: "八荒·Hutong Lab", drink: "一一", image: "https://cdn.nowmap.cn/bz/media/2026/01/29/04/a9/83e16f7a-53f7-4526-adc7-3d5a07dd8439.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "东城区安定门西大街5号" },
      { name: "奇点·宇宙客厅", drink: "星空特调", image: "https://cdn.nowmap.cn/bz/media/2026/02/11/03/09/fe0019b7-61f7-48b1-91e0-b1aca520adf4.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "海淀区五道口华清商务会馆" },
      { name: "老房子酒吧", drink: "经典曼哈顿", image: "https://cdn.nowmap.cn/bz/media/2026/03/06/1d/69/55acc001-370c-4794-8ee4-1c3aa2a56ff1.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区酒仙桥路甲13号" }
    ]
  },

  {
    id: "route-8",
    name: "日式清酒巡礼",
    tag: "日式",
    bars: [
      { name: "Azusa#2", drink: "十四代清酒", image: "https://cdn.nowmap.cn/bz/media/2026/03/07/52/65/21905610-c42e-4234-81ad-9b505ae4bb09.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区华远九都汇提灯街B1" },
      { name: "中華酒場燈籠", drink: "梅酒特调", image: "https://cdn.nowmap.cn/bz/media/2026/03/07/09/55/a3acacb3-efe2-47c0-92c2-35b2c402018f.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区华远九都汇提灯街B1" },
      { name: "微醺九号·炭火料理", drink: "柚子酒", image: "https://cdn.nowmap.cn/h5_event/merchant/weixun9hao/3.png?x-oss-process=image/resize,m_lfit,w_400,limit_1/format,webp/quality,q_80", address: "朝阳区光华路44号A2" }
    ]
  },

  {
    id: "route-9",
    name: "回龙观夜归人",
    tag: "昌平",
    bars: [
      { name: "哈哈酒馆", drink: "驻唱特调", image: "https://cdn.nowmap.cn/bz/media/2026/02/09/ce/65/967d1bf7-ab7c-469e-9362-2db376e5f6fd.JPG?x-oss-process=image/quality,q_80/resize,w_400", address: "昌平区回龙观西大街9号院" },
      { name: "破斧酒吧", drink: "黄油啤酒", image: "https://cdn.nowmap.cn/bz/media/2026/01/31/98/e2/688e3055-fad6-46d3-845b-af896236b370.JPG?x-oss-process=image/quality,q_80/resize,w_400", address: "通州区台湖镇唐大庄村135号" },
      { name: "蓝境酒馆", drink: "极光特调", image: "https://cdn.nowmap.cn/bz/media/2026/02/09/a0/60/fec79141-11a4-4981-9cb9-0dc8b04e0b10.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区望京街9号万科时代中心" }
    ]
  },

  {
    id: "route-10",
    name: "酒仙桥复古之夜",
    tag: "酒仙桥",
    bars: [
      { name: "老房子酒吧", drink: "威士忌酸", image: "https://cdn.nowmap.cn/bz/media/2026/03/06/1d/69/55acc001-370c-4794-8ee4-1c3aa2a56ff1.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区酒仙桥路甲13号" },
      { name: "Azusa#2", drink: "响威士忌", image: "https://cdn.nowmap.cn/bz/media/2026/03/07/52/65/21905610-c42e-4234-81ad-9b505ae4bb09.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区华远九都汇提灯街B1" },
      { name: "八荒·MIDBAR", drink: "诗意晚风", image: "https://cdn.nowmap.cn/bz/media/2026/01/29/57/73/8fda5714-a691-4e43-a14e-d5f267cc7f62.jpg?x-oss-process=image/quality,q_80/resize,w_400", address: "朝阳区三里屯工体北路21号楼" }
    ]
  }

];

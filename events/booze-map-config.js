/**
 * 酒鬼地图 — 线路配置表
 * ─────────────────────────────
 * 说明：
 * - 本文件用于存放 ROUTES 线路数据。
 * - booze-map.html 当前已支持内联数据；如需恢复外部配置加载，可再次引用本文件。
 * - 价格（如 66 元）在 booze-map.html 中维护。
 */

var ROUTES = [
  {
    id: "route-1",
    name: "三里屯微醺之旅",
    tag: "三里屯",
    bars: [
      { name: "八荒·MIDBAR", drink: "克林索尔的夏天", address: "朝阳区三里屯工体北路21号楼" },
      { name: "Hye! Bar", drink: "霓虹日落", address: "东城区人民美术文创园内" },
      { name: "蓝境酒馆", drink: "蓝调特调", address: "朝阳区望京街9号万科时代中心" }
    ]
  },
  {
    id: "route-2",
    name: "胡同探秘夜行",
    tag: "东城",
    bars: [
      { name: "八荒·Hutong Lab", drink: "冈仁波齐", address: "东城区安定门西大街5号" },
      { name: "中華酒場燈籠", drink: "灯笼特调", address: "朝阳区华远九都汇提灯街B1" },
      { name: "Azusa#2", drink: "樱花威士忌", address: "朝阳区华远九都汇提灯街B1" }
    ]
  },
  {
    id: "route-3",
    name: "建国门小酌之夜",
    tag: "建国门",
    bars: [
      { name: "微醺九号·炭火料理", drink: "春醒特调", address: "朝阳区光华路44号A2" },
      { name: "老房子酒吧", drink: "Old Fashioned", address: "朝阳区酒仙桥路甲13号" },
      { name: "哈哈酒馆", drink: "快乐水", address: "昌平区回龙观西大街9号院" }
    ]
  },
  {
    id: "route-4",
    name: "五道口学术酒局",
    tag: "海淀",
    bars: [
      { name: "奇点·宇宙客厅", drink: "宇宙拿铁鸡尾酒", address: "海淀区五道口华清商务会馆" },
      { name: "蓝境酒馆", drink: "蓝调特调", address: "朝阳区望京街9号万科时代中心" },
      { name: "破斧酒吧", drink: "福灵剂", address: "通州区台湖镇唐大庄村135号" }
    ]
  },
  {
    id: "route-5",
    name: "望京深夜食堂",
    tag: "望京",
    bars: [
      { name: "蓝境酒馆", drink: "望京之夜", address: "朝阳区望京街9号万科时代中心" },
      { name: "八荒·MIDBAR", drink: "山音", address: "朝阳区三里屯工体北路21号楼" },
      { name: "中華酒場燈籠", drink: "提灯特调", address: "朝阳区华远九都汇提灯街B1" }
    ]
  },
  {
    id: "route-6",
    name: "魔法主题之夜",
    tag: "通州",
    bars: [
      { name: "破斧酒吧", drink: "吐真剂", address: "通州区台湖镇唐大庄村135号" },
      { name: "哈哈酒馆", drink: "精酿IPA", address: "昌平区回龙观西大街9号院" },
      { name: "Hye! Bar", drink: "液氮冰球", address: "东城区人民美术文创园内" }
    ]
  },
  {
    id: "route-7",
    name: "文艺青年漫游",
    tag: "文艺",
    bars: [
      { name: "八荒·Hutong Lab", drink: "一一", address: "东城区安定门西大街5号" },
      { name: "奇点·宇宙客厅", drink: "星空特调", address: "海淀区五道口华清商务会馆" },
      { name: "老房子酒吧", drink: "经典曼哈顿", address: "朝阳区酒仙桥路甲13号" }
    ]
  },
  {
    id: "route-8",
    name: "日式清酒巡礼",
    tag: "日式",
    bars: [
      { name: "Azusa#2", drink: "十四代清酒", address: "朝阳区华远九都汇提灯街B1" },
      { name: "中華酒場燈籠", drink: "梅酒特调", address: "朝阳区华远九都汇提灯街B1" },
      { name: "微醺九号·炭火料理", drink: "柚子酒", address: "朝阳区光华路44号A2" }
    ]
  },
  {
    id: "route-9",
    name: "回龙观夜归人",
    tag: "昌平",
    bars: [
      { name: "哈哈酒馆", drink: "驻唱特调", address: "昌平区回龙观西大街9号院" },
      { name: "破斧酒吧", drink: "黄油啤酒", address: "通州区台湖镇唐大庄村135号" },
      { name: "蓝境酒馆", drink: "极光特调", address: "朝阳区望京街9号万科时代中心" }
    ]
  },
  {
    id: "route-10",
    name: "酒仙桥复古之夜",
    tag: "酒仙桥",
    bars: [
      { name: "老房子酒吧", drink: "威士忌酸", address: "朝阳区酒仙桥路甲13号" },
      { name: "Azusa#2", drink: "响威士忌", address: "朝阳区华远九都汇提灯街B1" },
      { name: "八荒·MIDBAR", drink: "诗意晚风", address: "朝阳区三里屯工体北路21号楼" }
    ]
  }
];

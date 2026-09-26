"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { matchLowSocialEvent } = require("./event-low-social-filter");

test("演唱会和音乐节留下", () => {
  assert.equal(matchLowSocialEvent({ title: "汪峰「相信未来」巡回演唱会-深圳站" }), null);
  assert.equal(matchLowSocialEvent({ title: "2026广州超级草莓音乐节" }), null);
  assert.equal(matchLowSocialEvent({ title: "2026「KPOPBOOM沈阳站」—千人KPOP音乐节" }), null);
});

test("跟团行程里的音乐节仍按旅游丢掉", () => {
  const hit = matchLowSocialEvent({ title: "【欧家梯田2天】稻欧家梯田非遗音乐节，打卡英西洞天仙境" });
  assert.ok(hit);
  assert.ok(hit.tags.includes("旅游"));
});

test("点名类型会丢掉", () => {
  assert.ok(matchLowSocialEvent({ title: "环境式驻演原创音乐剧《莫比乌斯》" }).tags.includes("音乐剧"));
  assert.ok(matchLowSocialEvent({ title: "曹禺经典话剧《日出》" }).tags.includes("话剧"));
  assert.ok(matchLowSocialEvent({ title: "儿童剧《白雪公主》" }).tags.includes("舞台剧"));
  assert.ok(matchLowSocialEvent({ title: "沉浸式悬疑话剧《待确认谋杀》" }).tags.includes("悬疑剧"));
  assert.ok(matchLowSocialEvent({ title: "《梁祝》东方经典交响音乐会" }).tags.includes("交响"));
  assert.ok(matchLowSocialEvent({ title: "俄罗斯远东国家歌舞团大型歌舞晚会" }).tags.includes("歌舞"));
  assert.ok(matchLowSocialEvent({ title: "舞剧《咏春》" }).tags.includes("歌舞"));
  assert.ok(matchLowSocialEvent({ title: "歌剧《卡门》中文版" }).tags.includes("歌剧"));
  assert.ok(matchLowSocialEvent({ title: "成都德云社相声大会" }).tags.includes("相声"));
  assert.ok(matchLowSocialEvent({ title: "天津魔术精品秀《神秘游戏》" }).tags.includes("魔术"));
  assert.ok(matchLowSocialEvent({ title: "亲子互动剧 | 哈利的科学魔法学院" }).tags.includes("魔术"));
  assert.ok(matchLowSocialEvent({ title: "亲子狂欢魔法秀《冤家兄弟》" }).tags.includes("魔术"));
  assert.ok(matchLowSocialEvent({ title: "《快乐再出发》-魔法综艺喜剧" }).tags.includes("魔术"));
  assert.ok(matchLowSocialEvent({ title: "奥森中秋游园会" }).tags.includes("园游会"));
  assert.ok(matchLowSocialEvent({ title: "7.21-8.11探戈夜校：零基础199就可以上四节课！" }).tags.includes("学习课"));
  assert.ok(matchLowSocialEvent({ title: "8.23 迷波隆击剑课：第一次玩就能对打！" }).tags.includes("体验课"));
  assert.ok(matchLowSocialEvent({ title: "【惠州“小塞班”2天】盐洲岛+海螺湾" }).tags.includes("旅游"));
});

test("本地球局和舞会留下，跨城行程丢掉", () => {
  assert.equal(matchLowSocialEvent({
    title: "周末约一场羽毛球（成都）",
    rawDetailText: "活动组织：互友旅行成都站\n下午2:20 集合啦",
  }), null);
  assert.equal(matchLowSocialEvent({
    title: "8.21布鲁斯舞会：零基础教学，这个夜晚，让脚步跟上心跳！",
  }), null);
  assert.equal(matchLowSocialEvent({
    title: "10.5去山野“胡闹”，玩皮划艇射箭还有美食！国庆户外美好时光~",
    body: "是从深圳/本地出发的结伴出行，沿途看景吃饭。",
  }), null);
  assert.ok(matchLowSocialEvent({ title: "2026中秋 阳朔山水大巴3天 阳朔过中秋" }).tags.includes("旅游"));
  assert.ok(matchLowSocialEvent({
    title: "徒步醉美森林古道径山古道，探寻九龙瀑",
    body: "上海出发一天徒步杭州径山，大巴往返。",
  }).tags.includes("旅游"));
  assert.ok(matchLowSocialEvent({ title: "“纪念肖斯塔科维奇诞辰120周年”森·三重奏音乐会" }).tags.includes("音乐会"));
  assert.ok(matchLowSocialEvent({ title: "《治愈絮语》沉浸式疗愈音乐会" }).tags.includes("音乐会"));
  assert.ok(matchLowSocialEvent({ title: "2026“名家名团”、国际钢琴系列——“幻想与变奏”陈萨钢琴独奏音乐会" }).tags.includes("音乐会"));
  assert.equal(matchLowSocialEvent({ title: "汪峰「相信未来」巡回演唱会-深圳站" }), null);
  assert.ok(matchLowSocialEvent({ title: "盲颂", body: "盲颂是一场舞台剧演出。" }).tags.includes("话剧"));
  assert.ok(matchLowSocialEvent({ title: "[中秋限定]《指环王》好莱坞电影往事中秋音乐会" }).tags.includes("交响"));
});

test("艺术季、展览和博物馆丢掉，脱口秀和演唱会留下", () => {
  assert.ok(matchLowSocialEvent({ title: "【湍流】全国青年毕设艺术季" }).tags.includes("看展"));
  assert.ok(matchLowSocialEvent({ title: "道登天门——萧娴书法艺术展" }).tags.includes("看展"));
  assert.ok(matchLowSocialEvent({ title: "山是山——萬亨作品展" }).tags.includes("看展"));
  assert.ok(matchLowSocialEvent({ title: "西安灰色博物馆" }).tags.includes("看展"));
  assert.ok(matchLowSocialEvent({ title: "云冈石窟特展" }).tags.includes("看展"));
  assert.ok(matchLowSocialEvent({ title: "观夏寻象·牟林童个展" }).tags.includes("看展"));
  assert.ok(matchLowSocialEvent({
    title: "Standby喜剧之王单口季——2026太湖文化艺术季无锡分会场",
  }).tags.includes("单口喜剧"));
  assert.equal(matchLowSocialEvent({ title: "汪峰「相信未来」巡回演唱会-深圳站" }), null);
  assert.equal(matchLowSocialEvent({ title: "SKZOO官方快闪" }), null);
  assert.equal(matchLowSocialEvent({ title: "2026第39届重庆星幻动漫节|重庆漫展" }), null);
  assert.equal(matchLowSocialEvent({ title: "抄心经/一起练书法" }), null);
  assert.ok(matchLowSocialEvent({ title: "第48届世界技能大赛" }).tags.includes("大赛"));
  assert.ok(matchLowSocialEvent({ title: "【系统学习】服装设计入门" }).tags.includes("学习课"));
  assert.ok(matchLowSocialEvent({ title: "「光影随行」探展跟拍全案套票" }).tags.includes("卖票"));
  assert.ok(matchLowSocialEvent({ title: "春阳台门票【含新展】" }).tags.includes("卖票"));
  assert.equal(matchLowSocialEvent({ title: "2026广州超级草莓音乐节" }), null);
  assert.equal(matchLowSocialEvent({ title: "非遗进景区——滨海非遗盛宴" }), null);
  assert.ok(matchLowSocialEvent({ title: "【需预约】王者荣耀VR沉浸剧《星海奇航:梦境救援》" }).tags.includes("沉浸馆"));
  assert.ok(matchLowSocialEvent({ title: "VISION WALK幻旅之门（苏州大悦城店）" }).tags.includes("沉浸馆"));
  assert.ok(matchLowSocialEvent({
    title: "奇遇▪古蜀三星堆",
    body: "舞台剧《奇遇·古蜀三星堆》，在四川省歌舞剧院演出。",
  }).tags.includes("舞台剧"));
  assert.equal(matchLowSocialEvent({ title: "突然好想你 流行金曲沉浸式演唱会" }), null);
  assert.ok(matchLowSocialEvent({ title: "来疯喜剧｜悬疑即兴互动喜剧专场 《凶手就是你》沉浸推理" }).tags.includes("即兴喜剧"));
  assert.equal(matchLowSocialEvent({ title: "法国即兴融合爵士 MONTAGNE SAUVAGE 南京站" }), null);
  assert.equal(matchLowSocialEvent({ title: "巨型昆虫秘境·秋日丰收奇遇季" }), null);
  assert.ok(matchLowSocialEvent({
    title: "海上有佳人——林风眠与海派仕女画",
    body: "本次展览汇集林风眠、张大千等近80件仕女画作品。",
  }).tags.includes("看展"));
  assert.ok(matchLowSocialEvent({
    title: "「约翰尼·德普：边缘形象」",
    body: "约翰尼·德普个展，呈现绘画、个人物件与影像。",
  }).tags.includes("看展"));
});

test("脱口秀和现场乐队留下", () => {
  assert.equal(matchLowSocialEvent({ title: "南京脱口秀｜喜剧部落精品场" }), null);
  assert.equal(matchLowSocialEvent({ title: "白百EndlessWhite「水溶于水」2026巡演 上海站" }), null);
  assert.ok(matchLowSocialEvent({ title: "开心麻花即兴戏剧秀《麻花喜剧Fun现场》" }).tags.includes("即兴喜剧"));
  assert.ok(matchLowSocialEvent({ title: "第三届里院喜剧节：来疯喜剧《喜剧精品秀》" }).tags.includes("喜剧节"));
  assert.equal(matchLowSocialEvent({ title: "羊羽脱口秀互动专场《美梦一日游》全国巡演" }), null);
  assert.ok(matchLowSocialEvent({ title: "2026年上海孔子文化节" }).tags.includes("文化节"));
  assert.ok(matchLowSocialEvent({ title: "龙潭西湖公园荷花文化节" }).tags.includes("文化节"));
  assert.ok(matchLowSocialEvent({ title: "2026上海国际光影节" }).tags.includes("光影节"));
  assert.ok(matchLowSocialEvent({ title: "第三届上海国际光影节徐汇分会场" }).tags.includes("光影节"));
  assert.ok(matchLowSocialEvent({ title: "浦东新区分会场" }).tags.includes("分会场"));
  assert.ok(matchLowSocialEvent({ title: "徐汇分会场" }).tags.includes("分会场"));
  assert.ok(matchLowSocialEvent({ title: "周末休闲爬白云山逛公园" }).tags.includes("逛公园"));
  assert.equal(matchLowSocialEvent({ title: "第35届北京国际燕京啤酒文化节" }), null);
  assert.equal(matchLowSocialEvent({ title: "HOTELEX成都国际咖啡文化节" }), null);
  assert.equal(matchLowSocialEvent({ title: "重庆·第九届TAXI动漫文化节" }), null);
  assert.equal(matchLowSocialEvent({ title: "福田半醒特调音乐文化节" }), null);
  assert.equal(matchLowSocialEvent({ title: "猫耳FM周边BW2026成都分会场" }), null);
  assert.equal(matchLowSocialEvent({ title: "每周徒步大武汉~用脚感受我们生活的城市！" }), null);
  assert.ok(matchLowSocialEvent({ title: "易经国学沙龙雅集" }).tags.includes("国学"));
  assert.ok(matchLowSocialEvent({ title: "周二——庄子里的智慧" }).tags.includes("国学"));
  assert.ok(matchLowSocialEvent({ title: "《论语》共读课堂" }).tags.includes("国学"));
  assert.equal(matchLowSocialEvent({ title: "庄子摇滚乐队巡演 上海站" }), null);
});

test("正文写明话剧时丢掉，模板句不算", () => {
  const hit = matchLowSocialEvent({
    title: "[天津人艺]重排原创经典保留剧目《家》",
    body: "天津人艺重排经典话剧《家》，在实验剧场上演。",
  });
  assert.ok(hit.tags.includes("话剧"));
  assert.equal(matchLowSocialEvent({
    title: "南岗松雷店-蒜伴儿脱口秀",
    body: "蒜伴儿脱口秀是一场舞台剧演出，现场看表演更有气氛。",
  }), null);
});

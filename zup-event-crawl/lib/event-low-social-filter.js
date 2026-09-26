"use strict";

/**
 * 不适合 Zup 结伴社交的活动，入库前丢弃，审核台里也不保留。
 * 演唱会、音乐节、脱口秀留下。跟团行程里顺带写了音乐节的，仍按旅游丢掉。
 * 艺术季、艺术展、作品展、博物馆/美术馆和特展、个展也不要。
 * 文化节、光影节、只有分会场名字的标题、逛公园也不要。
 * 国学、易经，以及传统经典讲读类活动也不要。
 * 啤酒、咖啡、清酒、动漫、音乐文化节更像市集或音乐现场，留下。
 */

const BOILERPLATE = /是一场舞台剧演出|是大型舞台演出|是一场现场喜剧\/曲艺演出|是一场现场喜剧/g;

const PLAY_NEEDLES = [
  "金瓶外传",
  "SHAME",
  "片场2.0",
  "馍法厨房",
  "奋不顾身的爱情",
  "空降未婚妻",
  "婚礼大镖客",
  "《出马》",
  "偷心晚宴",
  "阿玫",
  "崇祯十七年",
  "劫婚风云",
  "恭喜发财",
  "喜宴",
  "一个男的聊他全家",
  "津门等待",
  "电话谋杀案",
  "宝山奇人",
  "婚姻四味",
  "创意米兰戏剧节",
  "走投无路",
  "蔷薇下的罪恶",
  "罪有应得",
  "巴斯克维尔",
  "一路靠北",
  "夜色怪谈",
  "诡笑楼",
  "甄嬛传",
  "新刘海砍樵",
  "玩家TheLife",
  "小郡之秋",
  "蒋公的面子",
  "科学魔法学院",
  "魔法秀",
  "魔法综艺",
  "盲颂",
];

function isHandsOnExempt(title, head) {
  const text = `${title}\n${String(head || "").slice(0, 220)}`;
  if (/快闪|嘉年华|市集|XR|VR|虚拟现实|幻旅之门|动感飞行|环景巨幕/.test(text)) return true;
  return /漫展|only展|宠物展|电商展|动漫节|贸易博览|讲座|\d+讲|跟拍|套票|写真|门票/.test(title);
}

function isExhibition(title, head) {
  if (/艺术季|艺术展|作品展|博物馆|博物院|美术馆|特展|个展|群展|联展|双年展|三年展|艺术博览会|书画展|摄影展|影像展|回顾展|主题展|文献展|珍品展|巡回展|首展|画展|典藏展|专题展|大展|图片展|文化展|推荐展|精品展|设计展|互动展|沉浸展|年鉴展|铜镜展|服饰展|篆刻展|书法展|石窟艺术|馆藏|看展/.test(title)) {
    return true;
  }
  if (/展览/.test(title) || /》展$/.test(title)) return true;
  const exhibitHead = String(head || "").slice(0, 420);
  return /主题展览|展览介绍|展览时间|展览分为|本展览|本次展览|免费观展|分类：展览(?!活动)|展览[、，。]|当代艺术家|位艺术家|艺术家的|美术馆|博物院|博物馆|个展|摄影展|书画展|沉浸展|文物/.test(exhibitHead);
}

function isBareSubVenue(title) {
  const plain = String(title || "").replace(/[\s　:：|｜·•\-—_]/g, "");
  return /^[\u4e00-\u9fff]{2,8}分会场$/.test(plain);
}

function isProtectedShow(title) {
  if (/演唱会/.test(title) && !/音乐剧《|话剧《|歌剧《/.test(title)) return true;
  if (/音乐节/.test(title) && !/音乐剧节/.test(title)) {
    if (/\d+\s*天|两天|两日|二日|三日|一日游|精华游|跟团/.test(title)) return false;
    return true;
  }
  return false;
}

function collectTags(title, head) {
  const tags = [];
  const push = (tag) => {
    if (!tags.includes(tag)) tags.push(tag);
  };
  const standupTitle = /脱口秀|栋笃笑|单口|开放麦/.test(title);

  if (/歌剧/.test(title) && !/音乐剧/.test(title)) push("歌剧");
  if (/相声/.test(title)) push("相声");
  if (/魔术/.test(title) || /魔法秀|魔法学院|魔法综艺|魔法剧|魔术剧/.test(title)) push("魔术");

  if (/音乐剧/.test(title) || /音乐剧《/.test(head.slice(0, 220))) {
    if (!/交响音乐会/.test(title)) push("音乐剧");
  }
  if (/话剧/.test(title) || (/话剧《|经典话剧|演出话剧/.test(head.slice(0, 200)) && !standupTitle)) {
    push("话剧");
  }
  if (/舞台剧/.test(title) && !/脱口秀/.test(title)) push("舞台剧");
  if (/舞台剧《/.test(head.slice(0, 220)) && !standupTitle) push("舞台剧");
  if (/儿童剧|童话剧|儿童舞台剧/.test(title)) push("舞台剧");
  if (!/即兴/.test(title) && !standupTitle && /悬疑剧|悬疑话剧|悬疑戏剧|悬疑喜剧|悬疑推理|谋杀审判|沉浸式悬疑|悬疑互动剧|游园惊梦/.test(title)) {
    push("悬疑剧");
  }

  if (/指环王/.test(title) && /音乐会/.test(title)) push("交响");
  if (/交响/.test(title) && !/博物馆|作品展|画展/.test(title)) push("交响");
  if (/交响乐团/.test(title)) push("交响");
  if (!tags.includes("交响") && /交响乐团|交响音乐会|影视交响/.test(head.slice(0, 260)) && !/三重奏|独奏/.test(title)) {
    push("交响");
  }

  if (/歌舞晚会|歌舞团/.test(title) || /歌舞晚会|国家歌舞团/.test(head.slice(0, 180))) push("歌舞");
  if (/舞剧|芭蕾舞|舞蹈诗剧|舞蹈剧场|舞蹈秀|弗拉门戈|舞蹈艺术周|幻境秀/.test(title)) push("歌舞");

  if (/游园会|游园灯会|主题游园|古风游园|中秋游园|汉服游园|游园·/.test(title)) push("园游会");
  if (/汉服市集/.test(title) && /游园会/.test(head)) push("园游会");

  if (/体验课|体验营|击剑课|催眠体验|运动体验/.test(title) && !/体验展|体验馆|体验日/.test(title)) {
    push("体验课");
  }
  if (/夜校|训练营|培训班|公开课|大师课|精进课|修习营|蜕变营|成长团体|英语角|三次教学/.test(title)) {
    push("学习课");
  }
  if (/工作坊/.test(title) && /疗愈|觉知|心理|课程|教学/.test(title)) push("学习课");
  if (/沟通技巧/.test(title) && /沙龙|课|训练/.test(title)) push("学习课");
  if (/周五课/.test(title) && /舞|课/.test(title)) push("学习课");
  if (/零基础/.test(title) && /上课|节课|教学/.test(title) && !(/舞会/.test(title) && !/夜校|三次教学|节课|训练营/.test(title))) {
    push("学习课");
  }

  if (!/旅行箱|旅游推荐|旅游必打卡|新骑鹅|幻旅之门|环球之旅/.test(title)) {
    const plainTitle = title.replace(/《[^》]*》/g, "");
    if (/一日游|二日游|两日游|三日游|四日游|\d日游|精华游|周边游|短途旅行|跟团|长隆|野生动物世界|海洋王国|文旅|戏剧游乐园|秦淮有戏|游艇出海/.test(plainTitle)) {
      push("旅游");
    }
    if (/【一日】|【\d+日】|出发\s*\d+\s*天|大巴\s*\d+\s*天|（[^）]{0,16}\d+\s*天|（\d+天|\(\d+天|\d天1晚|\d天\d晚|1天1夜|一天徒步|一天活动|【[^】]*\d天】|[一1]天$|1天】/.test(title)) {
      push("旅游");
    }
    const tourHead = head.slice(0, 420);
    if (/二日游|三日线|出发\s*一天|包车往返|大巴往返|一日徒步|一日穿越|一日环线|一日探洞|一日：/.test(tourHead)) {
      push("旅游");
    }
    if (/包车/.test(tourHead) && /两日|一日|周边|往返/.test(tourHead)) push("旅游");
    if (/是从深圳\/本地出发的结伴出行/.test(tourHead) && !/皮划艇|射箭|羽毛球|市集|桌游/.test(title)) {
      push("旅游");
    }
  }

  if (!standupTitle && /环境式戏剧|沉浸式戏剧|沉浸戏剧|客厅喜剧|实验先锋戏剧|音乐话剧|爪马戏剧/.test(title)) {
    push("话剧");
  }
  if (PLAY_NEEDLES.some((needle) => title.includes(needle))) push("话剧");

  if (!standupTitle && !isHandsOnExempt(title, head) && isExhibition(title, head)) push("看展");

  if (/大赛/.test(title)) push("大赛");
  if (/系统学习|系统课/.test(title)) push("学习课");
  if (/套票|门票/.test(title)) push("卖票");
  if (/音乐会/.test(title)) push("音乐会");
  if (/光影节/.test(title)) push("光影节");
  if (/文化节/.test(title) && !/啤|咖啡|清酒|咖|动漫|漫展|音乐/.test(title)) push("文化节");
  if (isBareSubVenue(title)) push("分会场");
  if (/逛公园/.test(title)) push("逛公园");
  if (/国学|易经|周易|道德经|弟子规/.test(title)) push("国学");
  if (
    /论语|庄子|老子|诗经|儒学|儒家|孔孟/.test(title)
    && /智慧|读书会|共读|研读|品读|沙龙|雅集|讲堂|课堂/.test(title)
  ) {
    push("国学");
  }
  if (/喜剧节/.test(title)) push("喜剧节");
  if (/单口/.test(title)) push("单口喜剧");
  if (/即兴喜剧|即兴剧|即兴戏|即兴秀|即兴互动|即兴开麦|即兴专场|即兴之夜|即兴解压|即兴运动会|饭粒即兴|漫才即兴/.test(title)) {
    push("即兴喜剧");
  }
  if (/VR|XR|虚拟现实|幻旅之门|妙音\s*XR|沉浸剧|沉浸体验馆|环景巨幕/.test(title)) push("沉浸馆");

  return tags;
}

function matchLowSocialEvent(event = {}) {
  const title = String(event.title || "").trim();
  if (!title) return null;
  if (isProtectedShow(title)) return null;

  const raw = String(event.text || `${event.body || ""}\n${event.rawDetailText || event.detailText || event.raw_detail_text || ""}`);
  const head = `${title}\n${raw.replace(BOILERPLATE, "").replace(/\s+/g, " ").slice(0, 500)}`;
  const tags = collectTags(title, head);
  if (!tags.length) return null;
  return { tags, reason: tags.join("、") };
}

module.exports = {
  matchLowSocialEvent,
  isProtectedShow,
};

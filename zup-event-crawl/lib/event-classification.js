"use strict";

/** Zup 活动展示用分类（与审核页类型筛选一致）
 *  Agent 判类细则（单一事实来源）：docs/classification-agent-prompt.md
 *  流程说明：docs/event-classification-agent.md
 *  本文件 EVENT_CATEGORIES 用于校验 decisions；禁止用 inferCategory 批量写库。
 */
const EVENT_CATEGORIES = Object.freeze([
  "约饭",
  "戏剧表演",
  "音乐现场",
  "市集",
  "体育运动",
  "户外活动",
  "主题沙龙",
  "看展逛馆",
  "遛娃亲子",
  "其他",
]);

const CLASSIFICATION_PENDING_CATEGORY = "待分类";
const CLASSIFICATION_PENDING_REASON = "待 Agent 判断是否符合线下交友娱乐";
const CLASSIFICATION_SOURCE_PENDING = "pending";
const CLASSIFICATION_SOURCE_AGENT = "agent";

/** 旧分类名 → 新分类名（兼容历史 decisions.json） */
const LEGACY_CATEGORY_MAP = Object.freeze({
  户外: "户外活动",
  户外运动: "户外活动",
  演出: "戏剧表演",
  展览: "看展逛馆",
  手作: "其他",
  手作体验: "其他",
  社交: "主题沙龙",
  亲子: "遛娃亲子",
  喜剧脱口秀: "戏剧表演",
  "Coffee Chat": "主题沙龙",
  小酌: "市集",
  交友聚会: "主题沙龙",
  疗愈成长: "主题沙龙",
});

function normalizeCategory(value) {
  const text = String(value || "").trim();
  if (EVENT_CATEGORIES.includes(text)) return text;
  if (text === CLASSIFICATION_PENDING_CATEGORY) return text;
  if (LEGACY_CATEGORY_MAP[text]) return LEGACY_CATEGORY_MAP[text];
  return "";
}

function isAgentClassified(event) {
  return String(event?.classification_source || "").trim() === CLASSIFICATION_SOURCE_AGENT;
}

function isClassificationPending(event) {
  if (isAgentClassified(event)) return false;
  return String(event?.category || "").trim() === CLASSIFICATION_PENDING_CATEGORY
    || String(event?.classification_source || CLASSIFICATION_SOURCE_PENDING).trim() === CLASSIFICATION_SOURCE_PENDING;
}

function buildPendingClassificationFields(doubanEventType = "") {
  return {
    category: CLASSIFICATION_PENDING_CATEGORY,
    suggested: true,
    score: 50,
    reviewReason: CLASSIFICATION_PENDING_REASON,
    douban_event_type: String(doubanEventType || "").trim(),
    classification_source: CLASSIFICATION_SOURCE_PENDING,
  };
}

function validateClassificationDecision(decision) {
  const errors = [];
  const eventUid = String(decision?.event_uid || "").trim();
  if (!eventUid) errors.push("缺少 event_uid");

  if (typeof decision?.suggested !== "boolean") {
    errors.push("suggested 必须为 boolean");
  }

  const category = normalizeCategory(decision?.category);
  if (!category) {
    errors.push(`category 必须是：${EVENT_CATEGORIES.join("、")}`);
  }

  const reason = String(decision?.reason || "").trim();
  if (!reason) errors.push("缺少 reason");

  return { ok: errors.length === 0, errors, eventUid, category, reason };
}

function scoreFromSuggestion(suggested) {
  return suggested ? 72 : 28;
}

/** 挡下规则仍用全文（含票务说明） */
function buildClassificationHaystack(event) {
  return [
    event.title,
    event.location,
    event.owner,
    event.body,
    event.douban_event_type,
    event.raw_detail_text,
    event.fee,
    event.time_text,
  ].filter(Boolean).join(" ").replace(/\s+/g, " ");
}

/** 分类用标题、豆瓣类型、地点、简介正文等（不用 raw_detail_text，避免票务「儿童说明」误标亲子） */
function buildCategoryHaystack(event) {
  return [
    event.title,
    event.location,
    event.douban_event_type,
    event.body,
    event.fee,
  ].filter(Boolean).join(" ").replace(/\s+/g, " ");
}

function buildCategoryBodyText(event) {
  return String(event?.body || "").replace(/\s+/g, " ").trim();
}

/** 演出/喜剧类「大会」不是行业展 */
function isShowbizGatheringTitle(title) {
  return /相声大会|脱口秀大会|喜剧大会|曲艺|专场|公演|开放麦|精品秀|爆笑|吐槽大会/i.test(String(title || ""));
}

function isIndustryFair(text) {
  return /茶产业博览|渔业博览|食品博览|农产品博览|跨境电商|工博会|物博会|国际贸易|产业博览|行业博览|航空科普主题展|党史|主题文献推荐展/.test(text);
}

function isStrictKidsEvent(text) {
  const primary = String(text || "");
  if (/脱口秀专场|德云社|相声大会/i.test(primary)
    && !/亲子必看|亲子儿童|亲子互动|亲子剧|儿童剧|遛娃必看|周末遛娃|亲子魔术/i.test(primary)) {
    return false;
  }
  if (/亲子游玩|约会打卡|家庭观众|家庭套票/i.test(primary) && !/亲子必看|亲子儿童剧|亲子互动|遛娃必看|周末遛娃|儿童剧|合家欢/i.test(primary)) {
    return false;
  }
  return /亲子必看|亲子儿童|亲子互动|亲子话剧|亲子魔术|亲子秀|周末遛娃|遛娃必看|儿童剧|亲子剧|\d-\d+岁.*亲子|沉浸式.*亲子|合家欢|亲子爆笑互动剧|科学实验遛娃|亲子实验室|冰雪奇缘.*儿童|儿童换装|儿童互动魔术|三大主题儿童剧/i.test(primary)
    || (/亲子|遛娃|少儿剧|木偶剧|泡泡秀|科学剧场/i.test(primary) && /儿童|宝宝|娃|合家欢/i.test(primary));
}

/** 亲子向：结合标题与正文，乐园/动物园/儿童科普展等 */
function isFamilyKidsContext(text) {
  const combined = String(text || "");
  if (isStrictKidsEvent(combined)) return true;
  if (/儿童良友|儿童玩具|近现代儿童|亲子乐园|儿童乐园|亲子游|飞鸟乐园|野生动物园|动物世界|海洋馆|水族馆|长隆|方特|融创|适合.*(带娃|亲子)|周末遛娃|遛娃必看|畅玩票|家庭.*畅玩|大1小|儿童艺术节/i.test(combined)) {
    return true;
  }
  if (/欢乐谷|主题乐园|游乐园/i.test(combined) && !/派对|嘉年华|节|红人|only|潮流|大赛/i.test(combined)) {
    return true;
  }
  if (/儿童|亲子|少儿|娃娃|宝宝|遛娃|合家欢/i.test(combined)
    && /乐园|动物园|飞鸟|海洋馆|水族馆|野生动物|科普.*玩具|玩具.*科普|儿童剧|萌宠/i.test(combined)) {
    return true;
  }
  return false;
}

/** 户外出行/露营/溯溪/乡村一日游等（标题+正文） */
function isOutdoorLeisureContext(text) {
  return /徒步|骑行|露营|轻露营|露营派对|星空下|漂流|Citywalk|citywalk|户外露营|户外体验|户外|爬山|玩水|戏水|湿身|自驾|郊游|周边游|溯溪|登山|踏青|野餐|滑雪体验|滑板体验|攀岩体验|皮划艇体验|桨板|越野徒步|赏荷|赏莲|荷塘|荷园|荷花|溯溪戏水|一日游|乡村|摘荔枝|大巴往返|空调大巴|集合出发|纯玩无购物|洞穴探秘|森林|绿光森林|下乡放空|美食.*天\]|趣行周边游|任摘任吃|古村|绿道|古榄园|白江湖|烧鸡.*溯溪|溯溪.*烧鸡|摄影活动|野趣森林|森林公园|沙滩|碧海金沙/i.test(text);
}

function isExhibitionContext(text) {
  if (isIndustryFair(text)) return false;
  if (isFamilyKidsContext(text)) return false;
  if (isOutdoorLeisureContext(text)) return false;
  return /特展|个展|作品展|主题展|周年展|画展|艺术展|艺术大展|大展|研究展|回顾展|技艺展|书展|醒书展|艺术研究|同人艺术|摄影展|动画主题展|线下主题展|邀请展|书画展|书画专题展|文献展|毕业设计作品展|沉浸探索|沉浸展|沉浸式(探索|展演|体验|展览)|XR|全感VR|VR沉浸|探索体验|探索展览|探索中心|博物展|文明博物|美术馆|博物馆|展览馆|观展|逛馆|娃展|联名主题店|主题餐厅|海岛派对|围挡打卡|IP官方授权|认真展|艺术发光体|视觉意识|个展·|首展|线下打卡|痛楼|MOLLY|三丽鸥|银魂|犬夜叉|灵笼|星穹铁道|无限暖暖|光与夜之恋|剑网3主题|时光代理人|JOJO|无期迷途|约会大作战|魔兽世界|燕云十六声|GOODSLOVE|熊猫展|PANDA熊猫展|潮流艺术|跨界|跨界艺术|遗珍|案例研究展|剪纸主题展|植物园.*展|水乐园|乐园门票|烂苹果乐园|开放日.*馆|武道馆|游泳馆|泳期|水上乐园|Oasis城市绿洲|丑猫|非遗|Inner Worlds|小世界|圆梦如织|观乎人文|寻香|入象|时间暂时失效|向往自然|玫瑰念珠|群星璀璨|神马都好玩|魔法少女|印象派|法老|金字塔|圣母院|大英图书馆|解密达芬奇|自然魔法|红楼沉浸式|秦潮觉醒|iSTART/i.test(text);
}

function isFestivalMarketContext(text) {
  if (isSocialGatheringContext(text)) return false;
  if (isIndustryFair(text)) return false;
  if (isExhibitionContext(text) && !/节|夜市|大赛|狂欢节|only/i.test(text)) return false;
  return /市集|集市|快闪|啤酒节|生活节|购物节|创意市|庙会|嘉年华|美食节|文化节|动漫节|游戏节|电音节|艺术季|潮流节|开街|开集|游园会|文创集|鸡尾酒节|汉堡节|冰淇淋节|Gelato|咖啡节|精酿节|甜品节|吃冰节|冰玩节|甜市|夜市|匠人节|手作匠人节|手帐艺术|Hello手账|荷花节|狂欢节|热界潮玩节|摸鱼镇|甩.*拖鞋|甩人字拖|偷吃.*赛|only\b|同人only|Cosplay挑战|微醺.*节|车站咖啡节|湾里吃冰|里集|红人派对|水乐园开园|世界杯观赛|联动.*(万达|百货|银泰)|×.*联动|见面会|集章寻宝|游戏乐园/i.test(text)
    || (/[^A-Za-z]节/.test(text) && /鸡尾酒|汉堡|冰淇淋|咖啡|精酿|甜品|吃冰|荷花|潮玩|匠人|手帐|冰玩|微醺|民俗|民族狂|吃冰|甜市|Gelato/i.test(text));
}

function isSocialGatheringContext(text) {
  return /交友|社交|桌游|桌游局|读书会|共读|读书\s*[|｜]|心理|聊天|认识新|沙龙|小组|疗愈|相亲|脱单|狼人杀|阿瓦隆|德州|观影交流|主题局|搭子|联谊|单身|CP|派对.*交友|交友.*派对|聚会|故事会|慢聊|小聚|同频|新朋友|快乐遇见|充电计划|青年主动社交|轻松聚|社恐|不尴尬|有友|分享会.*《|《[^》]{2,}》分享会|观剧会.*交流/i.test(text);
}

function inferBlockReason(haystack, title) {
  const text = String(haystack || "");
  const t = String(title || "");

  if (/创业者|创业分享|创投路演|头脑风暴|野生搞钱/.test(t) && !/交友|社交派对|桌游/.test(text)) {
    return "创业/商业分享，不适合线下交友娱乐";
  }
  if (/跨境电商|跨境贸易|跨境交易会|跨境展览会|国际贸易(博览|展)|进出口博览|直通海外市场|链接全球商机|深圳国际跨境电商|跨境电商展/.test(text)
    && (/跨境|贸易展|交易会|博览会|展览会/.test(t) || /跨境|贸易展|交易会|博览会/.test(text))) {
    return "跨境电商/贸易展会，偏行业招商不适合线下交友娱乐";
  }
  if (/工业自动化|具身机器人|应急安全博览|文旅消费博览|工博会|物博会|机器人展览会/.test(text)) {
    return "工业/行业博览会，不适合线下交友娱乐";
  }
  if ((/峰会|私董会|创投大会|招商会|B2B|产学研|行业新动向/.test(t)
      || /跨境峰会|产业峰会|贸易峰会|行业峰会/.test(text))
    && !/沙龙|交流局|观影|映后|脱口秀|相声|喜剧/.test(text)) {
    return "行业峰会/招商活动，不适合线下交友娱乐";
  }
  if (/论坛/.test(t) && /产业|跨境|贸易|创业|AI|人工智能|出海|行业/.test(t)) {
    return "行业论坛，不适合线下交友娱乐";
  }
  if (/第\d+届.*(博览|交易|展览)会|国际.*博览(会|中心)|博览(会|中心).*(交易|贸易)/.test(text)
    && !isShowbizGatheringTitle(t)
    && !/观影|映后|电影|艺术节|电影节|影展|脱口秀|相声|喜剧|魔术|话剧|音乐|戏剧/.test(text)) {
    return "行业展会/博览会，不适合线下交友娱乐";
  }
  if (/展览会|博览会|交易会|展销会/.test(text)
    && !isShowbizGatheringTitle(t)
    && !/观影|映后|电影节|影展|脱口秀|相声|喜剧|魔术|话剧|音乐剧|戏剧|演出|Live|沉浸式剧|市集|集市|啤酒节|生活节/.test(text)) {
    return "展会/展销类活动，不适合线下交友娱乐";
  }
  if (/新书(发布会|分享会|首发)/.test(t) && !/桌游|体验|试玩|观影|映后/.test(text)) {
    return "图书发布会，偏宣传性质";
  }
  if (/指定单日票/.test(text) && /临时闭馆/.test(text)) {
    return "指定单日票且临时闭馆，像票务商品";
  }
  if (/培训课程|认证课|研修班|职业技能培训|招聘会/.test(text)) {
    return "培训/招聘类，不适合线下交友娱乐";
  }
  return "";
}

function inferCategory(event) {
  const title = String(event?.title || "");
  const doubanType = String(event?.douban_event_type || "");
  const haystack = buildCategoryHaystack(event);
  const bodyText = buildCategoryBodyText(event);
  const primary = `${title} ${doubanType}`;
  const combined = bodyText ? `${haystack} ${bodyText}` : haystack;

  if (isFamilyKidsContext(combined)) {
    return "遛娃亲子";
  }

  if (/马拉松|越野跑|铁人三项|自行车赛|公路赛|网球赛|羽毛球赛|乒乓球赛|篮球赛|足球赛|排球赛|游泳赛|滑冰赛|花样滑冰|拳击赛|格斗赛|电竞(联赛|大赛|锦标赛)|球类|田径|体操|举重|射击|射箭|击剑|赛车|F1|高尔夫赛|滑雪赛|攀岩赛|龙舟|赛艇|皮划艇|运动会|田径场|体育馆.*赛|球场.*赛/i.test(primary)
    || (/马拉松|越野跑|铁人三项|网球|羽毛球|乒乓球|篮球|足球|排球|游泳|拳击|格斗|电竞|高尔夫|龙舟|运动会|田径|体操|举重|射击|射箭|击剑|赛车|F1|攀岩|赛艇|皮划艇/i.test(haystack) && /赛|联赛|锦标赛|杯|对抗|竞技|比赛|运动会/.test(combined))) {
    return "体育运动";
  }

  if (/音乐会|演唱会|爵士之夜|爵士乐|Live\s?House|钢琴|独奏|乐队|演唱|演奏会|交响|声乐|音乐节|livehouse/i.test(primary)
    || (/音乐会|演唱会|爵士|Live|钢琴|独奏|乐队|演奏会|音乐节/i.test(haystack) && !/话剧|音乐剧|舞剧|戏剧|市集|集市/.test(primary))) {
    return "音乐现场";
  }

  if (/脱口秀|相声|喜剧|开放麦|曲艺|Talk\s?show|精品秀|爆笑|Improv|即兴喜剧|sketch|魔脱|Spicy|二狗|嘻哈包袱铺|城堡喜剧|吐槽大会|一支麦|魔脱喜剧|Stand[-\s]?up/i.test(primary)
    || (/脱口秀|相声|喜剧|开放麦|曲艺|精品秀|爆笑|即兴喜剧|sketch/i.test(haystack) && /演出|专场|大会|秀/.test(primary))
    || /话剧|音乐剧|舞剧|歌剧|戏剧|舞台剧|沉浸式.*剧|SNH48|水舞剧|卡司|恋爱的犀牛|戏曲|魔术|舞蹈|鬼屋|马戏|杂技|公演|观剧会|主创交流/i.test(primary)
    || (/话剧|音乐剧|舞剧|歌剧|戏剧|舞台剧|沉浸式.*剧|魔术|舞蹈|鬼屋/i.test(haystack) && /剧场|剧院|演出|公演|观剧/.test(haystack))) {
    return "戏剧表演";
  }

  if (isOutdoorLeisureContext(combined)) {
    return "户外活动";
  }

  if (isExhibitionContext(combined)) {
    return "看展逛馆";
  }

  if (isFestivalMarketContext(primary) || isFestivalMarketContext(haystack) || isFestivalMarketContext(combined)) {
    return "市集";
  }

  if (/飞盘|棒垒球|橄榄球|保龄球|台球|壁球|曲棍球|手球|门球|毽球|跳绳|健身挑战|体能挑战/i.test(combined)) {
    return "体育运动";
  }

  if (isSocialGatheringContext(primary) || isSocialGatheringContext(haystack) || isSocialGatheringContext(combined)) {
    return "主题沙龙";
  }

  if (/剧场|剧院|演出|舞台|影片|电影|院线|卡司/i.test(haystack)) {
    if (/音乐|演唱|音乐会|爵士|乐队|Live/i.test(primary)) return "音乐现场";
    if (/话剧|音乐剧|舞剧|戏剧|脱口秀|相声|喜剧|魔术|观剧/.test(primary)) return "戏剧表演";
    if (/展|博物馆|观影|放映/.test(primary)) return "看展逛馆";
    return "戏剧表演";
  }

  if (/钩织|手作|编织|陶艺|绘画|插花|手工|羊毛毡|皮具|DIY/i.test(primary)
    || /钩织|手作|编织|陶艺|绘画|插花|手工|羊毛毡|皮具/i.test(haystack)) {
    return "其他";
  }

  return "其他";
}

function inferSuggestReason(suggested, category, blockReason) {
  if (!suggested) return blockReason;
  const hints = {
    约饭: "约饭局，偏用户自发社交",
    戏剧表演: "脱口秀/话剧/魔术等舞台演出",
    音乐现场: "音乐会/演唱会/音乐节等音乐演出",
    市集: "快闪、市集、动漫节/公众博览会等逛玩活动",
    体育运动: "球类、竞技、体育赛事",
    户外活动: "郊游、徒步、露营等户外体验",
    主题沙龙: "读书会/话题沙龙/疗愈工作坊/桌游社交等有主题的交流局",
    看展逛馆: "看展、逛馆、观影放映类文化体验",
    遛娃亲子: "明确面向亲子/儿童的活动",
    其他: "B2B展会、创业培训、宠物体验等难以归类",
  };
  return hints[category] || hints.其他;
}

/**
 * Agent 批量分类（与 docs/event-classification-agent.md 一致）。
 * 新抓取默认 pending，由 Cursor Agent 或本函数写回 agent 结果。
 */
function inferEventClassification(event) {
  const haystack = buildClassificationHaystack(event);
  const title = String(event?.title || "");
  const blockReason = inferBlockReason(haystack, title);
  const suggested = !blockReason;
  const category = inferCategory(event);
  const reason = inferSuggestReason(suggested, category, blockReason);
  return {
    suggested,
    category: suggested ? category : "其他",
    reason,
  };
}

module.exports = {
  CLASSIFICATION_PENDING_CATEGORY,
  CLASSIFICATION_PENDING_REASON,
  CLASSIFICATION_SOURCE_AGENT,
  CLASSIFICATION_SOURCE_PENDING,
  EVENT_CATEGORIES,
  buildPendingClassificationFields,
  buildCategoryHaystack,
  inferCategory,
  isAgentClassified,
  isClassificationPending,
  normalizeCategory,
  scoreFromSuggestion,
  validateClassificationDecision,
  inferEventClassification,
  buildClassificationHaystack,
};

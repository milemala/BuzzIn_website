"use strict";

/** Zup 活动展示用分类（与审核页类型筛选一致） */
const EVENT_CATEGORIES = Object.freeze([
  "喜剧脱口秀",
  "戏剧表演",
  "音乐现场",
  "看展逛馆",
  "户外运动",
  "手作体验",
  "交友聚会",
  "遛娃亲子",
  "其他",
]);

const CLASSIFICATION_PENDING_CATEGORY = "待分类";
const CLASSIFICATION_PENDING_REASON = "待 Agent 判断是否符合线下交友娱乐";
const CLASSIFICATION_SOURCE_PENDING = "pending";
const CLASSIFICATION_SOURCE_AGENT = "agent";

/** 旧分类名 → 新分类名（兼容历史 decisions.json） */
const LEGACY_CATEGORY_MAP = Object.freeze({
  户外: "户外运动",
  演出: "戏剧表演",
  展览: "看展逛馆",
  手作: "手作体验",
  社交: "交友聚会",
  亲子: "遛娃亲子",
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

/** 分类只用标题/豆瓣类型/简介，不用 raw_detail_text（「儿童说明」会误标亲子） */
function buildCategoryHaystack(event) {
  return [
    event.title,
    event.location,
    event.douban_event_type,
    event.body,
    event.fee,
  ].filter(Boolean).join(" ").replace(/\s+/g, " ");
}

/** 演出/喜剧类「大会」不是行业展 */
function isShowbizGatheringTitle(title) {
  return /相声大会|脱口秀大会|喜剧大会|曲艺|专场|公演|开放麦|精品秀|爆笑|吐槽大会/i.test(String(title || ""));
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
    && !/观影|映后|电影节|影展|脱口秀|相声|喜剧|魔术|话剧|音乐剧|戏剧|演出|Live|沉浸式剧/.test(text)) {
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

function isStrictKidsEvent(primary) {
  const text = String(primary || "");
  if (/脱口秀专场|德云社|相声大会/i.test(text)
    && !/亲子必看|亲子儿童|亲子互动|亲子剧|儿童剧|遛娃必看|周末遛娃|亲子魔术/i.test(text)) {
    return false;
  }
  if (/亲子游玩|约会打卡|家庭观众|家庭套票/i.test(text) && !/亲子必看|亲子儿童剧|亲子互动|遛娃必看|周末遛娃|儿童剧|合家欢/i.test(text)) {
    return false;
  }
  return /亲子必看|亲子儿童|亲子互动|亲子话剧|亲子魔术|亲子秀|周末遛娃|遛娃必看|儿童剧|亲子剧|\d-\d+岁.*亲子|沉浸式.*亲子|合家欢|亲子爆笑互动剧|科学实验遛娃|亲子实验室|冰雪奇缘.*儿童|儿童换装|儿童互动魔术|三大主题儿童剧/i.test(text)
    || (/亲子|遛娃|少儿剧|木偶剧|泡泡秀|科学剧场/i.test(text) && /儿童|宝宝|娃|合家欢/i.test(text));
}

function inferCategory(event) {
  const title = String(event?.title || "");
  const doubanType = String(event?.douban_event_type || "");
  const haystack = buildCategoryHaystack(event);
  const primary = `${title} ${doubanType}`;

  if (isStrictKidsEvent(primary)) {
    return "遛娃亲子";
  }

  if (/脱口秀|相声|喜剧|开放麦|曲艺|Talk\s?show|精品秀|爆笑|Improv|即兴喜剧|sketch|魔脱|Spicy|二狗|嘻哈包袱铺|城堡喜剧|吐槽大会|一支麦|魔脱喜剧|Stand[-\s]?up/i.test(primary)
    || (/脱口秀|相声|喜剧|开放麦|曲艺|精品秀|爆笑|即兴喜剧|sketch/i.test(haystack) && /演出|专场|大会|秀/.test(primary))) {
    return "喜剧脱口秀";
  }

  if (/音乐会|演唱会|爵士之夜|爵士乐|Live\s?House|钢琴|独奏|乐队|演唱|演奏会|交响|声乐|音乐节/i.test(primary)
    || (/音乐会|演唱会|爵士|Live|钢琴|独奏|乐队|演奏会/i.test(haystack) && !/话剧|音乐剧|舞剧|戏剧/.test(primary))) {
    return "音乐现场";
  }

  if (/话剧|音乐剧|舞剧|歌剧|戏剧|舞台剧|沉浸式.*剧|SNH48|水舞剧|卡司|恋爱的犀牛|戏曲|魔术|舞蹈|鬼屋|马戏|杂技|公演/i.test(primary)
    || (/话剧|音乐剧|舞剧|歌剧|戏剧|舞台剧|沉浸式.*剧|魔术|舞蹈|鬼屋/i.test(haystack) && /剧场|剧院|演出|公演/.test(haystack))) {
    return "戏剧表演";
  }

  if (/美术馆|博物馆|艺术展|沉浸展|影展|书展|摄影展|双年展|设计展|电影节|展览|Fotografiska|毕加索|梵高|深空未来|8K|展映|观影|映后|放映|卢浮宫|科学馆|科技馆|逛馆/i.test(primary)
    || /美术馆|博物馆|艺术展|沉浸展|影展|摄影展|双年展|设计展|电影节|展览通票|观展|沉浸式探索/i.test(haystack)) {
    return "看展逛馆";
  }

  if (/徒步|骑行|露营|漂流|飞盘|Citywalk|citywalk|户外|爬山|玩水|湿身|自驾|郊游|溯溪|登山/i.test(primary)
    || /徒步|骑行|露营|漂流|飞盘|Citywalk|citywalk|户外|爬山|郊游/i.test(haystack)) {
    return "户外运动";
  }

  if (/钩织|手作|编织|陶艺|绘画|插花|手工|羊毛毡|皮具|市集体验|DIY/i.test(primary)
    || /钩织|手作|编织|陶艺|绘画|插花|手工|羊毛毡|皮具/i.test(haystack)) {
    return "手作体验";
  }

  if (/交友|桌游|读书会|心理成长|社交|聊天|认识新朋友|派对|聚会|沙龙|小组|疗愈|相亲|脱单|狼人杀|观影交流/i.test(primary)
    || /交友|桌游|读书会|心理|社交|派对|聚会|沙龙|疗愈|相亲|脱单/i.test(haystack)) {
    return "交友聚会";
  }

  if (/剧场|剧院|演出|舞台|影片|电影|院线|卡司/i.test(haystack)) {
    if (/脱口秀|相声|喜剧/.test(primary)) return "喜剧脱口秀";
    if (/音乐|演唱|音乐会|爵士/.test(primary)) return "音乐现场";
    if (/话剧|音乐剧|舞剧|戏剧/.test(primary)) return "戏剧表演";
    if (/展|博物馆|观影|放映/.test(primary)) return "看展逛馆";
    return "戏剧表演";
  }

  return "其他";
}

function inferSuggestReason(suggested, category, blockReason) {
  if (!suggested) return blockReason;
  const hints = {
    喜剧脱口秀: "脱口秀/相声/喜剧，适合结伴观演",
    戏剧表演: "话剧/音乐剧/舞剧等舞台演出",
    音乐现场: "音乐会/演唱会/Live 等音乐演出",
    看展逛馆: "看展、逛馆、观影放映类文化体验",
    户外运动: "户外体验/结伴出行属性明显",
    手作体验: "手作/DIY 体验类活动",
    交友聚会: "交友/桌游/派对等社交属性明显",
    遛娃亲子: "明确面向亲子/儿童的活动",
    其他: "生活娱乐属性，可保留人工复核",
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
  isAgentClassified,
  isClassificationPending,
  normalizeCategory,
  scoreFromSuggestion,
  validateClassificationDecision,
  inferEventClassification,
  buildClassificationHaystack,
};

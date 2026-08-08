'use strict';

/**
 * v3 画像业务层。
 * 只负责字段状态、队列推进和结束判断；不解析用户原话，不生成问题。
 */

const PROFILE_FIELDS = [
  'occupation',
  'social_purpose',
  'social_style',
  'chat_topics',
  'activity_style',
  'schedule_preference',
  'stranger_story',
  'friend_description'
];

const FIELD_LABELS = {
  occupation: '职业/在读',
  social_purpose: '希望遇见',
  social_style: '社交人格',
  chat_topics: '聊天偏好',
  activity_style: '活动风格',
  schedule_preference: '作息偏好',
  stranger_story: '陌生人经历',
  friend_description: '朋友眼中的你'
};

/** 陌生人经历可空，不挡匹配。 */
const REQUIRED_FOR_MATCH = PROFILE_FIELDS.filter((key) => key !== 'stranger_story');

const END_POLICY = {
  maxUserTurns: 30,
  lowQualityStreak: 3
};

function emptyField() {
  return { value: null, status: 'empty', evidence: [] };
}

function emptyDraft() {
  const draft = { intro: '', tagline: '', version: 'v3' };
  PROFILE_FIELDS.forEach((key) => {
    draft[key] = emptyField();
  });
  return draft;
}

/** 按「字」计数（含中文、标点），用于列表短介绍。 */
function charLen(text) {
  return Array.from(String(text || '')).length;
}

/**
 * 组局列表昵称下方短介绍，最多 15 字。
 */
function normalizeTagline(raw) {
  const text = String(raw || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/^["「『]|["」』]$/g, '');
  if (!text) return '';
  return Array.from(text).slice(0, 15).join('');
}

/** 兜底 tagline 时过滤不宜公开的负面/自嘲措辞。 */
function isPublicSafePhrase(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return !/傻子|脑残|智障|白痴|废物|恶心|难看|人来疯|话痨|社死|不合群|无聊透顶|社牛到尴尬|吵死了/.test(t);
}

function shortPhrase(text, maxChars) {
  return Array.from(String(text || '').replace(/、/g, '').trim()).slice(0, maxChars || 4).join('');
}

/**
 * 模型未给出合格 tagline 时的兜底：身份·气质·方向，尽量贴近三段式。
 */
function fallbackTagline(draft) {
  const parts = [];
  const occupation = normalizeField(draft && draft.occupation);
  if (occupation.status === 'answered') {
    const occ = shortPhrase(formatValue(occupation.value), 4);
    if (occ) parts.push(occ);
  }

  const friend = normalizeField(draft && draft.friend_description);
  const style = normalizeField(draft && draft.social_style);
  let vibe = '';
  if (friend.status === 'answered') vibe = shortPhrase(formatValue(friend.value), 4);
  if (!isPublicSafePhrase(vibe) && style.status === 'answered') {
    vibe = shortPhrase(formatValue(style.value), 4);
  }
  if (!isPublicSafePhrase(vibe)) vibe = '';
  if (vibe) parts.push(vibe);

  const purpose = normalizeField(draft && draft.social_purpose);
  const activity = normalizeField(draft && draft.activity_style);
  let third = '';
  if (purpose.status === 'answered') {
    const raw = String(formatValue(purpose.value) || '').trim();
    if (raw && !/异性|同性|对象|脱单|相亲|恋爱|找男|找女/.test(raw)) {
      third = Array.from(raw).length <= 4 ? raw : shortPhrase(raw.replace(/搭子$/, ''), 4);
    }
  }
  if (!third && activity.status === 'answered') {
    const act = formatValue(activity.value);
    if (/热闹/.test(act)) third = '爱热闹';
    else if (/安静/.test(act)) third = '爱安静';
    else third = shortPhrase(act, 4);
  }
  if (third) parts.push(third);

  while (parts.length < 3) {
    if (parts.length === 0) parts.push('想玩同频');
    else if (parts.length === 1) parts.push('好相处');
    else parts.push('随性局');
  }

  return normalizeTagline(parts.slice(0, 3).join('·'));
}

function normalizeEvidence(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 4);
}

/**
 * 兼容模型常见松散写法，避免「明明答了却因格式被打回重问」。
 * 支持：纯字符串、缺 evidence、chat_topics 用数组/字符串。
 */
function coerceFieldPayload(fieldKey, raw) {
  if (raw == null) return null;

  if (typeof raw === 'string' || typeof raw === 'number') {
    const text = String(raw).trim();
    if (!text) return null;
    if (fieldKey === 'chat_topics') {
      return { value: { likes: [text], dislikes: [] }, evidence: [text] };
    }
    return { value: text, evidence: [text] };
  }

  if (Array.isArray(raw)) {
    const likes = raw.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8);
    if (!likes.length) return null;
    if (fieldKey === 'chat_topics') {
      return { value: { likes, dislikes: [] }, evidence: likes.slice(0, 2) };
    }
    return { value: likes.join('、'), evidence: likes.slice(0, 2) };
  }

  if (typeof raw !== 'object') return null;

  // 已是标准字段对象
  if (Object.prototype.hasOwnProperty.call(raw, 'value') || Object.prototype.hasOwnProperty.call(raw, 'status')) {
    let value = raw.value;
    if (fieldKey === 'chat_topics') {
      if (typeof value === 'string' && value.trim()) {
        value = { likes: [value.trim()], dislikes: [] };
      } else if (Array.isArray(value)) {
        value = {
          likes: value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8),
          dislikes: []
        };
      } else if (value && typeof value === 'object') {
        const likes = Array.isArray(value.likes)
          ? value.likes.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
          : [];
        const dislikes = Array.isArray(value.dislikes)
          ? value.dislikes.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
          : [];
        value = likes.length ? { likes, dislikes } : null;
      }
    }
    if (value == null || value === '') return null;
    return {
      value,
      status: raw.status,
      evidence: normalizeEvidence(raw.evidence)
    };
  }

  // chat_topics 直接给 {likes, dislikes}
  if (fieldKey === 'chat_topics' && (Array.isArray(raw.likes) || Array.isArray(raw.dislikes))) {
    const likes = Array.isArray(raw.likes)
      ? raw.likes.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    const dislikes = Array.isArray(raw.dislikes)
      ? raw.dislikes.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    if (!likes.length) return null;
    return { value: { likes, dislikes }, evidence: likes.slice(0, 2) };
  }

  return null;
}

function normalizeField(raw) {
  const coerced = coerceFieldPayload(null, raw) || raw;
  if (!coerced || typeof coerced !== 'object') return emptyField();
  const status = ['empty', 'answered', 'skipped'].includes(coerced.status)
    ? coerced.status
    : (coerced.value === '__skipped__' ? 'skipped' : (coerced.value == null || coerced.value === '' ? 'empty' : 'answered'));
  if (status === 'empty') return { value: null, status: 'empty', evidence: normalizeEvidence(coerced.evidence) };
  if (status === 'skipped') return { value: null, status: 'skipped', evidence: normalizeEvidence(coerced.evidence) };
  if (coerced.value == null || coerced.value === '') return emptyField();
  return { value: coerced.value, status: 'answered', evidence: normalizeEvidence(coerced.evidence) };
}

function isAnswered(field) {
  return normalizeField(field).status === 'answered';
}

function isResolved(field) {
  const status = normalizeField(field).status;
  return status === 'answered' || status === 'skipped';
}

function incompleteMatchFields(draft) {
  return REQUIRED_FOR_MATCH.filter((key) => !isAnswered(draft && draft[key]));
}

function isProfileComplete(draft) {
  return incompleteMatchFields(draft).length === 0;
}

/**
 * 首次建档问全部 8 题；补聊只问仍未真实回答的匹配必需字段。
 */
function createFieldQueue(draft, resumeMode) {
  const source = resumeMode ? incompleteMatchFields(draft) : PROFILE_FIELDS;
  return source.filter((key) => {
    if (!PROFILE_FIELDS.includes(key)) return false;
    return resumeMode ? !isAnswered(draft && draft[key]) : !isResolved(draft && draft[key]);
  });
}

function currentField(queue) {
  return Array.isArray(queue) && queue.length ? queue[0] : null;
}

function nextField(queue) {
  return Array.isArray(queue) && queue.length > 1 ? queue[1] : null;
}

/**
 * 只允许模型更新当前题；answerStatus 决定字段状态。
 * clear 使用模型值，skip 由业务层写入 skipped，不依赖模型是否返回 profile_update。
 */
function applyCurrentAnswer(draft, fieldKey, answerStatus, profileUpdate) {
  const next = cloneDraft(draft);
  if (!PROFILE_FIELDS.includes(fieldKey)) return next;

  if (answerStatus === 'skip') {
    next[fieldKey] = {
      value: null,
      status: 'skipped',
      evidence: ['用户跳过']
    };
    return next;
  }

  if (answerStatus !== 'clear') return next;
  const raw = profileUpdate && profileUpdate[fieldKey];
  const coerced = coerceFieldPayload(fieldKey, raw);
  const incoming = normalizeField(coerced || raw);
  if (incoming.status !== 'answered') return next;
  next[fieldKey] = incoming;
  return next;
}

function advanceQueue(queue, answerStatus, updateApplied) {
  const next = Array.isArray(queue) ? queue.slice() : [];
  if (answerStatus === 'skip' || (answerStatus === 'clear' && updateApplied)) {
    next.shift();
  }
  return next;
}

function shouldEnd(state) {
  const reasons = [];
  if (state.userAskedToEnd) reasons.push('user_end');
  if (Number(state.lowQualityStreak || 0) >= END_POLICY.lowQualityStreak) reasons.push('low_quality_streak');
  if (Number(state.userTurns || 0) >= END_POLICY.maxUserTurns) reasons.push('max_turns');
  if (!currentField(state.fieldQueue)) reasons.push('queue_complete');
  return {
    shouldEnd: reasons.length > 0,
    reasons,
    profileComplete: isProfileComplete(state.draft),
    incompleteFields: incompleteMatchFields(state.draft),
    policy: END_POLICY
  };
}

function cloneDraft(draft) {
  const next = emptyDraft();
  if (!draft || typeof draft !== 'object') return next;
  PROFILE_FIELDS.forEach((key) => {
    next[key] = normalizeField(draft[key]);
  });
  if (typeof draft.intro === 'string') next.intro = draft.intro.trim();
  if (typeof draft.tagline === 'string') next.tagline = normalizeTagline(draft.tagline);
  return next;
}

function formatValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function draftSummary(draft) {
  const known = {};
  PROFILE_FIELDS.forEach((key) => {
    const field = normalizeField(draft && draft[key]);
    if (field.status === 'answered') known[key] = field.value;
    if (field.status === 'skipped') known[key] = '__skipped__';
  });
  return known;
}

/**
 * 仅当模型 intro 缺失或不适合展示时使用。
 * 写成简短性格理解 + 组局策略，避免表单式逐项复述。
 */
function fallbackIntro(draft, opts) {
  const incomplete = !!(opts && opts.incomplete);
  const missingCount = incomplete ? incompleteMatchFields(draft).length : 0;
  const gapText = missingCount <= 1 ? '还有一点' : '还有些地方';

  const style = normalizeField(draft && draft.social_style);
  const purpose = normalizeField(draft && draft.social_purpose);
  const activity = normalizeField(draft && draft.activity_style);
  const friend = normalizeField(draft && draft.friend_description);
  const topics = normalizeField(draft && draft.chat_topics);
  const schedule = normalizeField(draft && draft.schedule_preference);
  const occupation = normalizeField(draft && draft.occupation);

  const vibe = [];
  if (friend.status === 'answered') vibe.push('别人眼里你带着「' + formatValue(friend.value) + '」的感觉');
  if (style.status === 'answered') {
    const s = formatValue(style.value);
    if (/主动/.test(s)) vibe.push('熟起来之前也愿意把场子撑起来');
    else if (/慢热/.test(s)) vibe.push('更习惯先观察、再慢慢进入状态');
    else vibe.push('社交节奏会随场合切换，不强推一种人设');
  }
  if (purpose.status === 'answered') {
    vibe.push('出来玩时更在意能不能碰到「' + formatValue(purpose.value) + '」这类同频的人');
  }

  const strategy = [];
  if (activity.status === 'answered') {
    strategy.push('优先给你匹配更贴「' + formatValue(activity.value) + '」氛围的局');
  }
  if (topics.status === 'answered') {
    strategy.push('开场话题会往你们都聊得动的方向靠，而不是硬套标签');
  }
  if (schedule.status === 'answered') {
    strategy.push('时间上尽量照顾你「' + formatValue(schedule.value) + '」更方便的时段');
  }
  if (occupation.status === 'answered' && strategy.length < 2) {
    strategy.push('也会参考你现在的生活状态，避免推荐节奏完全不合的局');
  }
  if (!strategy.length) {
    strategy.push('之后会从相处节奏、话题和活动氛围一起帮你筛更合拍的局和搭子');
  }

  if (incomplete) {
    if (!vibe.length) {
      return '今天先聊到这里～' + gapText + '关于你的感觉还没立住，这次先不急着开始匹配。等你方便时再回来补几句，Zee 会接着听。';
    }
    return '我隐约摸到一点你的样子：' + vibe.slice(0, 2).join('，')
      + '。不过' + gapText + '还没聊清楚，这次先不急着匹配。等你方便时再回来补几句，我会从没聊完的地方接着来。';
  }

  if (!vibe.length) {
    return '这轮我对你的感觉还在成形。之后我会从相处节奏、话题和活动氛围上多留意，慢慢帮你找到更合拍、也更好开口的局。';
  }

  return '听你这么说，我更想这样理解你：' + vibe.slice(0, 3).join('，')
    + '。以后帮你找局时，' + strategy.slice(0, 2).join('；')
    + '。不会拿一两个标签把你定死，而是尽量让每次出门都更对味。';
}

function introLooksInternal(text) {
  const raw = String(text || '');
  if (/字段|profile_complete|需告知|画像不完整：|__skipped__|匹配未齐|resume_mode|current_field|value=|目前了解到用户|该用户|尚未采集|尚未聊到/.test(raw)) {
    return true;
  }
  // 表单式复述：连续罗列多个「标签」或出现填表句式
  if (/你的职业是|兴趣是|风格是|时间偏好是|活动风格是/.test(raw)) return true;
  const quoted = raw.match(/「[^」]{1,20}」/g) || [];
  if (quoted.length >= 4 && /，你|。你|、你/.test(raw)) return true;
  return false;
}

module.exports = {
  PROFILE_FIELDS,
  FIELD_LABELS,
  REQUIRED_FOR_MATCH,
  END_POLICY,
  emptyField,
  emptyDraft,
  normalizeField,
  cloneDraft,
  isAnswered,
  isResolved,
  incompleteMatchFields,
  isProfileComplete,
  createFieldQueue,
  currentField,
  nextField,
  applyCurrentAnswer,
  advanceQueue,
  shouldEnd,
  draftSummary,
  fallbackIntro,
  introLooksInternal,
  formatValue,
  coerceFieldPayload,
  charLen,
  normalizeTagline,
  fallbackTagline
};

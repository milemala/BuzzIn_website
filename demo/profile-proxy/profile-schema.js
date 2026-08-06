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
  const draft = { intro: '', version: 'v3' };
  PROFILE_FIELDS.forEach((key) => {
    draft[key] = emptyField();
  });
  return draft;
}

function normalizeEvidence(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 4);
}

function normalizeField(raw) {
  if (!raw || typeof raw !== 'object') return emptyField();
  const status = ['empty', 'answered', 'skipped'].includes(raw.status)
    ? raw.status
    : (raw.value === '__skipped__' ? 'skipped' : (raw.value == null || raw.value === '' ? 'empty' : 'answered'));
  if (status === 'empty') return { value: null, status: 'empty', evidence: normalizeEvidence(raw.evidence) };
  if (status === 'skipped') return { value: null, status: 'skipped', evidence: normalizeEvidence(raw.evidence) };
  if (raw.value == null || raw.value === '') return emptyField();
  return { value: raw.value, status: 'answered', evidence: normalizeEvidence(raw.evidence) };
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
  const incoming = normalizeField(raw);
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
 */
function fallbackIntro(draft, opts) {
  const incomplete = !!(opts && opts.incomplete);
  const missingCount = incomplete ? incompleteMatchFields(draft).length : 0;
  const gapText = missingCount <= 1 ? '还有一点' : '还有些地方';
  const bits = [];

  function add(key, prefix, suffix) {
    const field = normalizeField(draft && draft[key]);
    if (field.status !== 'answered') return;
    bits.push(prefix + formatValue(field.value) + (suffix || ''));
  }

  add('occupation', '大概是「', '」这个状态');
  add('social_purpose', '更想找「', '」');
  add('social_style', '社交节奏偏');
  add('activity_style', '线下更吃', '的氛围');
  add('schedule_preference', '时间上更偏');
  add('friend_description', '朋友眼里你偏');

  const topics = normalizeField(draft && draft.chat_topics);
  if (topics.status === 'answered') bits.push('聊得来的话题我大概有数');

  if (incomplete) {
    if (!bits.length) {
      return '今天先聊到这里～' + gapText + '关于你的感觉没聊清楚，这次就先不急着开始匹配。等你方便时再回来补几句就好，Zee 会接着听。';
    }
    return '我已经记住啦：你' + bits.slice(0, 3).join('，')
      + '。' + gapText + '没聊清楚，这次先不急着开始匹配。等你方便时再回来补几句，Zee 会从没聊完的地方接着来。';
  }

  if (!bits.length) {
    return '这轮还了解得不多。之后我会在相处节奏、话题和活动氛围上多留意，慢慢帮你找到更合拍的局和搭子。';
  }
  return '听下来，你' + bits.slice(0, 4).join('，')
    + '。以后我会综合这些感觉帮你找更合适的局和人，不会只拿一两个标签把你定死。';
}

function introLooksInternal(text) {
  return /字段|profile_complete|需告知|画像不完整：|__skipped__|匹配未齐|resume_mode|current_field|value=|目前了解到用户|该用户|尚未采集|尚未聊到/.test(String(text || ''));
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
  formatValue
};

'use strict';

/**
 * 画像业务层：字段定义、合并、覆盖率、结束计数、完整度。
 * 问法文案 / 选项 / 怎么回用户 → 只在 system-prompt.js，由大模型决定。
 * 本文件不做对话改写，不解析用户自然语言。
 */

/** 长期画像维度（与 system-prompt 字段名一致，共 8 项） */
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

/** 仅用于后台「已知/尚未掌握」状态摘要（注入给模型看进度），不是题库 */
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

/**
 * 对话可收束前须「处理完」的字段（真答或跳过均可）。
 * 陌生人经历可一直空着，不挡对话收束。
 */
const REQUIRED_FOR_END = PROFILE_FIELDS.filter((k) => k !== 'stranger_story');

/**
 * 匹配组局前必须有真实回答的字段（跳过不算完整）。
 * 陌生人经历可跳过 / 可空，不挡匹配完整度。
 */
const REQUIRED_FOR_MATCH = REQUIRED_FOR_END;

/**
 * 业务层只做可计数的结束条件。
 * 敷衍 / 想结束：信任模型 user_signal。
 * 正常收束：核心字段都已处理（真答或跳过）；陌生人经历不挡。
 */
const END_POLICY = {
  highConfidence: 0.75,
  maxUserTurns: 30,
  lowQualityStreak: 3
};

function emptyField() {
  return { value: null, confidence: 0, evidence: [] };
}

function emptyDraft() {
  const draft = { intro: '', version: 'v2' };
  PROFILE_FIELDS.forEach((k) => {
    draft[k] = emptyField();
  });
  return draft;
}

function normalizeField(raw) {
  if (!raw || typeof raw !== 'object') return emptyField();
  const confidence = clamp01(raw.confidence);
  let value = raw.value;
  if (value === 'Unknown' || value === 'unknown' || value === '') value = null;
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.map((e) => String(e || '').trim()).filter(Boolean).slice(0, 4)
    : [];
  if (value == null || confidence < 0.35) {
    return { value: null, confidence: confidence < 0.35 ? confidence : 0, evidence };
  }
  return { value, confidence, evidence };
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function mergeProfile(draft, update) {
  const next = draft && draft.version === 'v2' ? Object.assign({}, draft) : emptyDraft();
  if (!update || typeof update !== 'object') return next;

  PROFILE_FIELDS.forEach((key) => {
    if (update[key] == null) return;
    const incoming = normalizeField(update[key]);
    const prev = normalizeField(next[key]);
    if (incoming.value == null) return;

    const prevSkipped = prev.value === '__skipped__';
    const incomingReal = incoming.value !== '__skipped__';
    // 补聊时：真答必须能覆盖此前的「跳过」（跳过常是 0.99，否则会被置信度挡住）
    const canOverwriteSkipped = prevSkipped && incomingReal;
    if (canOverwriteSkipped || incoming.confidence >= (prev.confidence || 0)) {
      next[key] = incoming;
    }
  });

  if (typeof update.intro === 'string' && update.intro.trim()) {
    next.intro = update.intro.trim();
  }
  next.version = 'v2';
  return next;
}

function countHighConfidence(draft, threshold) {
  const t = threshold == null ? END_POLICY.highConfidence : threshold;
  let n = 0;
  const keys = [];
  PROFILE_FIELDS.forEach((key) => {
    const f = draft && draft[key];
    if (f && f.value != null && f.value !== '__skipped__' && Number(f.confidence) >= t) {
      n += 1;
      keys.push(key);
    }
  });
  return { count: n, keys };
}

/** 对话推进：真答或跳过都算「本轮处理过」 */
function isResolved(field) {
  return Boolean(
    field &&
    (field.value === '__skipped__' || (field.value != null && Number(field.confidence) >= 0.55))
  );
}

/** 匹配完整：必须有真实回答；跳过不算 */
function isAnswered(field) {
  return Boolean(
    field &&
    field.value != null &&
    field.value !== '__skipped__' &&
    Number(field.confidence) >= 0.55
  );
}

/** @deprecated 兼容旧调用；等同 isResolved */
function isFilled(field) {
  return isResolved(field);
}

function incompleteMatchFields(draft) {
  return REQUIRED_FOR_MATCH.filter((key) => !isAnswered(draft && draft[key]));
}

function isProfileComplete(draft) {
  return incompleteMatchFields(draft).length === 0;
}

function coverageSummary(draft) {
  const known = [];
  const unknown = [];
  PROFILE_FIELDS.forEach((key) => {
    const f = draft && draft[key];
    if (isResolved(f)) {
      if (f.value === '__skipped__') known.push(FIELD_LABELS[key] + '=已跳过');
      else known.push(FIELD_LABELS[key] + '=' + formatValue(f.value));
    } else {
      unknown.push(key + '(' + FIELD_LABELS[key] + ')');
    }
  });
  return { known, unknown };
}

function formatValue(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch (_) {
      return String(v);
    }
  }
  return String(v);
}

function evaluateEnd(state) {
  const policy = END_POLICY;
  const high = countHighConfidence(state.draft, policy.highConfidence);
  const reasons = [];
  const profileComplete = isProfileComplete(state.draft);
  const incompleteFields = incompleteMatchFields(state.draft);

  let coreResolved;
  if (state.resumeMode) {
    // 补聊：不能因为「以前跳过过」就立刻 enough_fields。
    // 只有匹配已完整，或本轮补聊目标字段都被有效处理（真答/再次跳过）才算问完。
    const targets = Array.isArray(state.resumeTargets) ? state.resumeTargets : [];
    const touched = Array.isArray(state.resumeTouched) ? state.resumeTouched : [];
    coreResolved = profileComplete || (targets.length > 0 && targets.every((k) => touched.indexOf(k) >= 0));
  } else {
    // 首轮：真答或跳过都算处理完；陌生人经历不挡对话收束
    coreResolved = REQUIRED_FOR_END.every((key) => isResolved(state.draft && state.draft[key]));
  }

  if (state.userAskedToEnd) reasons.push('user_end');
  if (state.lowQualityStreak >= policy.lowQualityStreak) reasons.push('low_quality_streak');
  if (state.userTurns >= policy.maxUserTurns) reasons.push('max_turns');
  if (coreResolved) reasons.push('enough_fields');

  return {
    shouldEnd: reasons.length > 0,
    reasons,
    profileComplete,
    incompleteFields,
    highFieldCount: high.count,
    highFields: high.keys,
    policy
  };
}

/**
 * 仅当模型 wrap_up 没写出可用 intro 时的保底文案（对用户说话）。
 * incomplete=true 时强调：还不完整，完整后才能组局。
 */
function fallbackIntro(draft, opts) {
  const incomplete = !!(opts && opts.incomplete);
  const bits = [];
  const occ = draft && draft.occupation;
  const p = draft && draft.social_purpose;
  const s = draft && draft.social_style;
  const a = draft && draft.activity_style;
  const t = draft && draft.chat_topics;
  const sch = draft && draft.schedule_preference;
  const friend = draft && draft.friend_description;

  if (occ && occ.value && occ.value !== '__skipped__') {
    bits.push('大概是「' + (typeof occ.value === 'string' ? occ.value : formatValue(occ.value)) + '」这个状态');
  }
  if (p && p.value && p.value !== '__skipped__') {
    bits.push('更想认识「' + (typeof p.value === 'string' ? p.value : formatValue(p.value)) + '」这类人');
  }
  if (s && s.value && s.value !== '__skipped__') {
    bits.push('社交节奏偏' + (typeof s.value === 'string' ? s.value : formatValue(s.value)));
  }
  if (a && a.value && a.value !== '__skipped__') {
    bits.push('线下更吃' + (typeof a.value === 'string' ? a.value : formatValue(a.value)) + '的氛围');
  }
  if (t && t.value && t.value !== '__skipped__') {
    const likes = t.value.likes || t.value.like || [];
    if (Array.isArray(likes) && likes.length) {
      bits.push('聊得来的话题我大概有数');
    }
  }
  if (sch && sch.value && sch.value !== '__skipped__') {
    bits.push('时间上更偏' + (typeof sch.value === 'string' ? sch.value : formatValue(sch.value)));
  }
  if (friend && friend.value && friend.value !== '__skipped__') {
    bits.push('朋友眼里你偏' + (typeof friend.value === 'string' ? friend.value : formatValue(friend.value)));
  }

  if (incomplete) {
    if (!bits.length) {
      return '这轮还没完全了解你，暂时还没法帮你开启匹配组局。你随时再来聊几句、把偏好补齐，Zee 就能开始帮你找更合适的局和搭子啦。';
    }
    return '我已经记住一些你的感觉了，比如你' + bits.slice(0, 3).join('，')
      + '。不过还有几项没聊清楚，所以暂时还不能开启匹配组局。你方便时再来补几句就行，Zee 等你。';
  }

  if (!bits.length) {
    return '这轮还了解得不多，没关系。之后我会先按轻松好开口的方向帮你找搭子，你边玩我边补对你的感觉，让推荐越来越准。';
  }
  return '听下来，你' + bits.slice(0, 4).join('，') + '。以后我会综合这些感觉帮你找更合适的局和人，不会拿一两个标签把你定死，让每次出门更对味。';
}

/** 模型 intro 是否像内部备注（不适合直接给用户看） */
function introLooksInternal(text) {
  const s = String(text || '');
  return /字段|profile_complete|需告知|画像不完整：|__skipped__|匹配未齐|resume_mode|value=/.test(s);
}

module.exports = {
  PROFILE_FIELDS,
  FIELD_LABELS,
  REQUIRED_FOR_END,
  REQUIRED_FOR_MATCH,
  END_POLICY,
  emptyDraft,
  emptyField,
  mergeProfile,
  normalizeField,
  countHighConfidence,
  isResolved,
  isAnswered,
  isFilled,
  incompleteMatchFields,
  isProfileComplete,
  coverageSummary,
  evaluateEnd,
  fallbackIntro,
  introLooksInternal,
  formatValue
};

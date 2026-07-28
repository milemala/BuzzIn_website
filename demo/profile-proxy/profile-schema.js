'use strict';

/** 长期画像维度（与 system-prompt 一致，共 6 项） */
const PROFILE_FIELDS = [
  'social_purpose',
  'social_style',
  'chat_topics',
  'activity_style',
  'schedule_preference',
  'boundaries'
];

const FIELD_LABELS = {
  social_purpose: '希望遇见',
  social_style: '社交人格',
  chat_topics: '聊天偏好',
  activity_style: '活动风格',
  schedule_preference: '作息偏好',
  boundaries: '底线'
};

/**
 * 业务层只做可计数的结束条件。
 * 敷衍 / 想结束：信任模型 user_signal。
 */
const END_POLICY = {
  highConfidence: 0.75,
  minHighFields: 5,
  maxUserTurns: 10,
  minUserTurnsBeforeHighEnd: 4,
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
    if (incoming.value != null && incoming.confidence >= (prev.confidence || 0)) {
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
    if (f && f.value != null && Number(f.confidence) >= t) {
      n += 1;
      keys.push(key);
    }
  });
  return { count: n, keys };
}

function coverageSummary(draft) {
  const known = [];
  PROFILE_FIELDS.forEach((key) => {
    const f = draft && draft[key];
    if (f && f.value != null && Number(f.confidence) >= 0.55) {
      known.push(FIELD_LABELS[key] + '=' + formatValue(f.value));
    }
  });
  return { known };
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

  if (state.userAskedToEnd) reasons.push('user_end');
  if (state.lowQualityStreak >= policy.lowQualityStreak) reasons.push('low_quality_streak');
  if (state.userTurns >= policy.maxUserTurns) reasons.push('max_turns');
  if (
    high.count >= policy.minHighFields
    && state.userTurns >= policy.minUserTurnsBeforeHighEnd
  ) {
    reasons.push('enough_fields');
  }

  return {
    shouldEnd: reasons.length > 0,
    reasons,
    highFieldCount: high.count,
    highFields: high.keys,
    policy
  };
}

function fallbackIntro(draft) {
  const bits = [];
  const p = draft && draft.social_purpose;
  const s = draft && draft.social_style;
  const a = draft && draft.activity_style;
  const t = draft && draft.chat_topics;
  const sch = draft && draft.schedule_preference;

  if (p && p.value) bits.push('想来认识' + (typeof p.value === 'string' ? p.value : formatValue(p.value)));
  if (s && s.value) bits.push(typeof s.value === 'string' ? s.value : formatValue(s.value));
  if (a && a.value) bits.push('活动风格偏' + (typeof a.value === 'string' ? a.value : formatValue(a.value)));
  if (t && t.value) {
    const likes = t.value.likes || t.value.like || [];
    if (Array.isArray(likes) && likes.length) bits.push('爱聊' + likes.slice(0, 3).join('、'));
  }
  if (sch && sch.value) bits.push(typeof sch.value === 'string' ? sch.value : formatValue(sch.value));
  if (!bits.length) return '在这座城市找同频搭子，随性一点也没关系，边玩边认识。';
  return bits.join('，') + '。想认识合得来的人一起出门。';
}

module.exports = {
  PROFILE_FIELDS,
  FIELD_LABELS,
  END_POLICY,
  emptyDraft,
  emptyField,
  mergeProfile,
  normalizeField,
  countHighConfidence,
  coverageSummary,
  evaluateEnd,
  fallbackIntro,
  formatValue
};

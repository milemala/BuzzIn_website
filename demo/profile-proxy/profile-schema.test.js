'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('./profile-schema');

function answer(draft, key, value) {
  return schema.applyCurrentAnswer(draft, key, 'clear', {
    [key]: { value, evidence: ['test'] }
  });
}

test('首次建档按 8 个字段建立队列', () => {
  const queue = schema.createFieldQueue(schema.emptyDraft(), false);
  assert.deepEqual(queue, schema.PROFILE_FIELDS);
  assert.equal(schema.currentField(queue), 'occupation');
  assert.equal(schema.nextField(queue), 'social_purpose');
});

test('明确回答写入 answered 并推进队列', () => {
  const initial = schema.emptyDraft();
  const queue = schema.createFieldQueue(initial, false);
  const draft = answer(initial, 'occupation', '产品经理');
  const nextQueue = schema.advanceQueue(queue, 'clear', schema.isAnswered(draft.occupation));
  assert.deepEqual(draft.occupation, {
    value: '产品经理',
    status: 'answered',
    evidence: ['test']
  });
  assert.equal(schema.currentField(nextQueue), 'social_purpose');
});

test('模糊和低质回答不写入也不推进', () => {
  const initial = schema.emptyDraft();
  const queue = schema.createFieldQueue(initial, false);
  for (const status of ['ambiguous', 'low_quality', 'not_applicable']) {
    const draft = schema.applyCurrentAnswer(initial, 'occupation', status, {
      occupation: { value: '不可靠内容' }
    });
    assert.equal(draft.occupation.status, 'empty');
    assert.deepEqual(schema.advanceQueue(queue, status, false), queue);
  }
});

test('跳过由业务层记录，不依赖模型 profile_update', () => {
  const initial = schema.emptyDraft();
  const draft = schema.applyCurrentAnswer(initial, 'occupation', 'skip', {});
  assert.equal(draft.occupation.status, 'skipped');
  assert.equal(draft.occupation.value, null);
  assert.equal(schema.isProfileComplete(draft), false);
});

test('补聊只询问未真实回答的匹配字段', () => {
  let draft = schema.emptyDraft();
  schema.REQUIRED_FOR_MATCH.forEach((key) => {
    if (key !== 'occupation') draft = answer(draft, key, key + '-answer');
  });
  draft = schema.applyCurrentAnswer(draft, 'occupation', 'skip', {});
  assert.deepEqual(schema.createFieldQueue(draft, true), ['occupation']);
});

test('第 7 题空着不影响匹配完整', () => {
  let draft = schema.emptyDraft();
  schema.REQUIRED_FOR_MATCH.forEach((key) => {
    draft = answer(draft, key, key + '-answer');
  });
  assert.equal(draft.stranger_story.status, 'empty');
  assert.equal(schema.isProfileComplete(draft), true);
});

test('补聊真答直接覆盖此前跳过', () => {
  let draft = schema.applyCurrentAnswer(schema.emptyDraft(), 'occupation', 'skip', {});
  draft = answer(draft, 'occupation', '货车司机');
  assert.equal(draft.occupation.status, 'answered');
  assert.equal(draft.occupation.value, '货车司机');
});

test('结束条件统一由队列、轮次、低质和主动结束决定', () => {
  const draft = schema.emptyDraft();
  const base = { draft, fieldQueue: ['occupation'], userTurns: 1, lowQualityStreak: 0, userAskedToEnd: false };
  assert.equal(schema.shouldEnd(base).shouldEnd, false);
  assert.deepEqual(schema.shouldEnd({ ...base, fieldQueue: [] }).reasons, ['queue_complete']);
  assert.deepEqual(schema.shouldEnd({ ...base, lowQualityStreak: 3 }).reasons, ['low_quality_streak']);
  assert.deepEqual(schema.shouldEnd({ ...base, userTurns: 30 }).reasons, ['max_turns']);
  assert.deepEqual(schema.shouldEnd({ ...base, userAskedToEnd: true }).reasons, ['user_end']);
});

test('fallback intro 不输出内部字段名', () => {
  const text = schema.fallbackIntro(schema.emptyDraft(), { incomplete: true });
  assert.equal(schema.introLooksInternal(text), false);
  assert.match(text, /不急着/);
  assert.equal(schema.introLooksInternal('目前了解到用户喜欢跑步，尚未聊到其它信息'), true);
});

test('clear 支持字符串形式的 profile_update', () => {
  const draft = schema.applyCurrentAnswer(schema.emptyDraft(), 'occupation', 'clear', {
    occupation: '做产品的'
  });
  assert.equal(draft.occupation.status, 'answered');
  assert.equal(draft.occupation.value, '做产品的');
});

test('chat_topics 支持 likes 数组直写', () => {
  const draft = schema.applyCurrentAnswer(schema.emptyDraft(), 'chat_topics', 'clear', {
    chat_topics: { likes: ['电影', '旅行'], dislikes: [] }
  });
  assert.equal(draft.chat_topics.status, 'answered');
  assert.deepEqual(draft.chat_topics.value.likes, ['电影', '旅行']);
});

test('tagline 最多 15 字并去掉空白', () => {
  assert.equal(schema.normalizeTagline('  慢热 精酿爱好者  '), '慢热精酿爱好者');
  assert.equal(schema.charLen(schema.normalizeTagline('一二三四五六七八九十一二三四五六')), 15);
  assert.equal(schema.normalizeTagline(''), '');
});

test('fallbackTagline 输出身份·气质·方向三段式', () => {
  let draft = schema.emptyDraft();
  draft = answer(draft, 'occupation', '在读博士');
  draft = answer(draft, 'friend_description', '能处');
  draft = answer(draft, 'social_purpose', '钓鱼搭子');
  assert.equal(schema.fallbackTagline(draft), '在读博士·能处·钓鱼搭子');
});

test('fallbackTagline 跳过不宜公开的负面气质词', () => {
  let draft = schema.emptyDraft();
  draft = answer(draft, 'occupation', '产品经理');
  draft = answer(draft, 'friend_description', '傻子');
  draft = answer(draft, 'social_style', '慢热');
  draft = answer(draft, 'social_purpose', '饭搭子');
  const tagline = schema.fallbackTagline(draft);
  assert.match(tagline, /^产品经理·/);
  assert.equal(tagline.includes('傻子'), false);
  assert.match(tagline, /慢热/);
});

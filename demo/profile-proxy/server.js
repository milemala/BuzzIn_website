'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PROFILE_SYSTEM_PROMPT } = require('./system-prompt');
const schema = require('./profile-schema');

const ROOT = path.resolve(__dirname, '../..');
loadEnv(path.join(__dirname, '.env'));
loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 8788);
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = process.env.ZHIPU_MODEL || 'glm-5.2';
const API_KEY = process.env.ZHIPU_API_KEY || '';
const MODEL_TIMEOUT_MS = Number(process.env.PROFILE_MODEL_TIMEOUT_MS || 45000);
const DATA_DIR = path.join(__dirname, 'data', 'chats');
const sessions = new Map();

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) return;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  });
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeSessionFile(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'session';
}

function sessionPath(sessionId) {
  return path.join(DATA_DIR, safeSessionFile(sessionId) + '.json');
}

function serializeSession(sessionId, session) {
  return {
    version: 'v3',
    sessionId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    resumeMode: !!session.resumeMode,
    draft: session.draft,
    fieldQueue: session.fieldQueue,
    messages: session.messages,
    userTurns: session.userTurns,
    lowQualityStreak: session.lowQualityStreak,
    endDecision: session.endDecision || null,
    architecture: 'single_agent_v3'
  };
}

function persistSession(sessionId, session) {
  try {
    ensureDataDir();
    const file = sessionPath(sessionId);
    fs.writeFileSync(file, JSON.stringify(serializeSession(sessionId, session), null, 2) + '\n', 'utf8');
    return file;
  } catch (error) {
    console.error('[profile-proxy] persist failed:', error.message);
    return null;
  }
}

function loadSavedChat(sessionId) {
  const file = sessionPath(sessionId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function listSavedChats() {
  ensureDataDir();
  return fs.readdirSync(DATA_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
        return {
          sessionId: record.sessionId,
          file,
          version: record.version || 'v2',
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          status: record.status,
          intro: (record.draft && record.draft.intro) || '',
          tagline: (record.draft && record.draft.tagline) || '',
          profileComplete: record.version === 'v3' ? schema.isProfileComplete(record.draft) : false,
          turns: (record.messages || record.transcript || []).length,
          architecture: record.architecture || 'legacy'
        };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function freshSession(seedDraft, resumeMode) {
  const now = new Date().toISOString();
  const draft = seedDraft && seedDraft.version === 'v3'
    ? schema.cloneDraft(seedDraft)
    : schema.emptyDraft();
  return {
    createdAt: now,
    updatedAt: now,
    status: 'in_progress',
    resumeMode: !!resumeMode,
    draft,
    fieldQueue: schema.createFieldQueue(draft, !!resumeMode),
    messages: [],
    userTurns: 0,
    lowQualityStreak: 0,
    ambiguousStreak: 0,
    ambiguousField: '',
    endDecision: null
  };
}

function hydrateSession(record) {
  if (!record || record.version !== 'v3') return null;
  const session = freshSession(record.draft, record.resumeMode);
  session.createdAt = record.createdAt || session.createdAt;
  session.updatedAt = record.updatedAt || session.updatedAt;
  session.status = record.status || 'in_progress';
  session.fieldQueue = Array.isArray(record.fieldQueue)
    ? record.fieldQueue.filter((key) => schema.PROFILE_FIELDS.includes(key))
    : schema.createFieldQueue(session.draft, session.resumeMode);
  session.messages = Array.isArray(record.messages) ? record.messages.slice() : [];
  session.userTurns = Number(record.userTurns) || 0;
  session.lowQualityStreak = Number(record.lowQualityStreak) || 0;
  session.ambiguousStreak = Number(record.ambiguousStreak) || 0;
  session.ambiguousField = String(record.ambiguousField || '');
  session.endDecision = record.endDecision || null;
  return session;
}

function getOrCreateSession(sessionId, reset, seedDraft, resumeMode) {
  if (reset) {
    const session = freshSession(seedDraft, resumeMode);
    sessions.set(sessionId, session);
    return session;
  }
  if (!sessions.has(sessionId)) {
    const restored = hydrateSession(loadSavedChat(sessionId));
    sessions.set(sessionId, restored || freshSession());
  }
  return sessions.get(sessionId);
}

function snapshotSession(session) {
  return JSON.parse(JSON.stringify(session));
}

function restoreSession(sessionId, snapshot) {
  sessions.set(sessionId, snapshot);
}

function extractJson(text) {
  if (!text) throw new Error('模型返回为空');
  let source = String(text).trim();
  const fence = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) source = fence[1].trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) source = source.slice(start, end + 1);
  return JSON.parse(source);
}

async function callZhipu(messages, opts) {
  if (!API_KEY) {
    const error = new Error('缺少 ZHIPU_API_KEY，请在 demo/profile-proxy/.env 配置');
    error.status = 500;
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  const body = {
    model: MODEL,
    messages,
    temperature: opts && opts.temperature != null ? opts.temperature : 0.55,
    max_tokens: opts && opts.max_tokens != null ? opts.max_tokens : 2048,
    response_format: { type: 'json_object' }
  };
  if (/^glm-5/i.test(MODEL)) body.thinking = { type: 'disabled' };

  let response;
  try {
    response = await fetch(ZHIPU_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      const timeout = new Error('模型请求超时，请重试');
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    const error = new Error('智谱返回非 JSON：' + raw.slice(0, 200));
    error.status = 502;
    throw error;
  }
  if (!response.ok) {
    const message = (data.error && (data.error.message || data.error)) || data.msg || raw.slice(0, 200);
    const error = new Error('智谱 API 错误：' + message);
    error.status = response.status;
    throw error;
  }
  const choice = data.choices && data.choices[0];
  return {
    content: (choice && choice.message && choice.message.content) || '',
    usage: data.usage || null,
    model: data.model || MODEL
  };
}

function runtimeContext(session, phase, opening) {
  return {
    phase,
    is_opening: !!opening,
    resume_mode: !!session.resumeMode,
    current_field: schema.currentField(session.fieldQueue),
    next_field: schema.nextField(session.fieldQueue),
    profile_complete: schema.isProfileComplete(session.draft),
    incomplete_fields: schema.incompleteMatchFields(session.draft),
    draft_summary: schema.draftSummary(session.draft),
    turns: session.userTurns,
    low_quality_streak: session.lowQualityStreak
  };
}

function buildSystem(session, phase, opening) {
  return PROFILE_SYSTEM_PROMPT
    + '\n\n【运行事实 JSON】\n'
    + JSON.stringify(runtimeContext(session, phase, opening));
}

function normalizeAnswerStatus(parsed, phase, opening) {
  if (phase === 'wrap_up' || opening) return 'not_applicable';
  const value = String((parsed && parsed.answer_status) || '');
  return ['not_applicable', 'clear', 'ambiguous', 'low_quality', 'skip'].includes(value)
    ? value
    : 'ambiguous';
}

function normalizeUserSignal(parsed) {
  const value = String((parsed && parsed.user_signal) || 'normal');
  return ['normal', 'joke', 'off_topic', 'ask_end', 'unsafe'].includes(value)
    ? value
    : 'normal';
}

function pickReply(parsed, phase) {
  const reply = String((parsed && (parsed.assistant_reply || parsed.assistant_message)) || '').trim();
  if (reply) return reply;
  return phase === 'wrap_up'
    ? '好，我已经把这次聊到的感觉记下来了。'
    : '我在听～你也可以换个说法告诉我。';
}

async function runAgent(session, phase, options) {
  const opening = !!(options && options.opening);
  const system = buildSystem(session, phase, opening);
  const recentMessages = session.messages.slice(-8);
  const eventMessage = opening
    ? [{ role: 'user', content: '【事件】用户打开建档对话，请开始。' }]
    : (phase === 'wrap_up'
      ? [{
          role: 'user',
          content: '【事件】业务层决定结束本轮，请按 wrap_up 输出。intro 要写成理解后的性格与组局策略分析，禁止把 draft_summary 当表单逐项复述；同时给出 tagline：必须是「短语A·短语B·短语C」三段式、总长≤15字，身份优先、气质积极改写、敏感诉求脱敏，用于组局列表昵称下方。'
        }]
      : []);
  const apiMessages = [{ role: 'system', content: system }].concat(recentMessages, eventMessage);

  const temperature = phase === 'wrap_up' ? 0.7 : 0.55;
  let result = await callZhipu(apiMessages, { temperature, max_tokens: 2048 });
  let parsed;
  try {
    parsed = extractJson(result.content);
  } catch (_) {
    const retryMessages = apiMessages.concat([
      { role: 'assistant', content: result.content },
      {
        role: 'user',
        content: '只重新输出完整 JSON，字段必须包含 assistant_reply、quick_replies、quick_replies_multi、profile_update、answer_status、user_signal。'
      }
    ]);
    result = await callZhipu(retryMessages, { temperature: 0.25, max_tokens: 2048 });
    parsed = extractJson(result.content);
  }

  const answerStatus = normalizeAnswerStatus(parsed, phase, opening);
  const userSignal = normalizeUserSignal(parsed);
  const rawUpdate = parsed && parsed.profile_update && typeof parsed.profile_update === 'object'
    ? parsed.profile_update
    : {};
  return {
    reply: pickReply(parsed, phase),
    quickReplies: Array.isArray(parsed.quick_replies)
      ? parsed.quick_replies.map((item) => String(item)).filter(Boolean).slice(0, 6)
      : [],
    quickRepliesMulti: parsed.quick_replies_multi === true,
    profileUpdate: rawUpdate,
    intro: phase === 'wrap_up' && typeof rawUpdate.intro === 'string' ? rawUpdate.intro.trim() : '',
    tagline: phase === 'wrap_up' ? schema.normalizeTagline(rawUpdate.tagline) : '',
    answerStatus,
    userSignal,
    usage: result.usage,
    model: result.model
  };
}

function lastUserText(session) {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const msg = session.messages[i];
    if (msg && msg.role === 'user' && typeof msg.content === 'string' && !msg.content.startsWith('【事件】')) {
      return msg.content.trim();
    }
  }
  return '';
}

function applyTurnState(session, out) {
  const current = schema.currentField(session.fieldQueue);
  let answerStatus = out.answerStatus;
  if (out.userSignal === 'joke' || out.userSignal === 'off_topic') answerStatus = 'not_applicable';
  if (out.userSignal === 'unsafe') answerStatus = 'low_quality';

  const beforeAnswered = current ? schema.isAnswered(session.draft[current]) : false;
  session.draft = schema.applyCurrentAnswer(
    session.draft,
    current,
    answerStatus,
    out.profileUpdate
  );
  let updateApplied = current
    ? !beforeAnswered && schema.isAnswered(session.draft[current])
    : false;

  // 模型判了 clear 却漏写/写坏 profile_update：用用户原话兜底入库，避免无谓重问
  if (answerStatus === 'clear' && current && !updateApplied) {
    const userText = lastUserText(session);
    if (userText && userText.length >= 2 && userText.length <= 120) {
      session.draft = schema.applyCurrentAnswer(
        session.draft,
        current,
        'clear',
        { [current]: userText }
      );
      updateApplied = schema.isAnswered(session.draft[current]);
      if (updateApplied) {
        console.warn('[profile-proxy] salvaged clear update from user text:', current);
      }
    }
    if (!updateApplied) {
      console.warn('[profile-proxy] rejected clear update:', current, JSON.stringify(out.profileUpdate));
      answerStatus = 'ambiguous';
    }
  }

  // 连续第二次仍 ambiguous，但用户已给出有信息量的回答：放宽为 clear，避免死循环重问
  if (answerStatus === 'ambiguous' && current) {
    session.ambiguousStreak = (session.ambiguousField === current ? session.ambiguousStreak : 0) + 1;
    session.ambiguousField = current;
    const userText = lastUserText(session);
    if (session.ambiguousStreak >= 2 && userText && userText.length >= 2 && !/^[a-z]{4,}$/i.test(userText)) {
      session.draft = schema.applyCurrentAnswer(
        session.draft,
        current,
        'clear',
        { [current]: userText.slice(0, 80) }
      );
      if (schema.isAnswered(session.draft[current])) {
        answerStatus = 'clear';
        updateApplied = true;
        session.ambiguousStreak = 0;
        session.ambiguousField = '';
        console.warn('[profile-proxy] soft-accepted after repeated ambiguous:', current);
      }
    }
  } else if (answerStatus === 'clear' || answerStatus === 'skip') {
    session.ambiguousStreak = 0;
    session.ambiguousField = '';
  }

  session.fieldQueue = schema.advanceQueue(session.fieldQueue, answerStatus, updateApplied);

  if (answerStatus === 'low_quality' || out.userSignal === 'unsafe') {
    session.lowQualityStreak += 1;
  } else {
    session.lowQualityStreak = 0;
  }

  return {
    answerStatus,
    userSignal: out.userSignal,
    userAskedToEnd: out.userSignal === 'ask_end',
    unsafe: out.userSignal === 'unsafe'
  };
}

function validIntro(text) {
  return !!String(text || '').trim()
    && !/暂无|未填|信息不足/.test(text)
    && !schema.introLooksInternal(text);
}

function applyWrapIntro(session, modelIntro, modelReply, modelTagline) {
  const incomplete = !schema.isProfileComplete(session.draft);
  if (validIntro(modelIntro)) {
    session.draft.intro = modelIntro;
  } else if (validIntro(modelReply) && String(modelReply).length >= 60) {
    session.draft.intro = String(modelReply).trim();
  } else {
    session.draft.intro = schema.fallbackIntro(session.draft, { incomplete });
  }

  const tagline = schema.normalizeTagline(modelTagline);
  session.draft.tagline = tagline || schema.fallbackTagline(session.draft);
}

function finishPayload(sessionId, session, out, action, phase, decision, savedFile, turnStatus, turnSignal) {
  return {
    ok: true,
    sessionId,
    model: out.model || MODEL,
    usage: out.usage || null,
    assistant_reply: out.reply,
    assistant_message: out.reply,
    quick_replies: out.quickReplies || [],
    quick_replies_multi: !!out.quickRepliesMulti,
    answer_status: turnStatus || out.answerStatus,
    user_signal: turnSignal || out.userSignal,
    action,
    phase,
    profile_draft: session.draft,
    intro: session.draft.intro || '',
    tagline: session.draft.tagline || '',
    profile_complete: schema.isProfileComplete(session.draft),
    incomplete_fields: schema.incompleteMatchFields(session.draft),
    current_field: schema.currentField(session.fieldQueue),
    next_field: schema.nextField(session.fieldQueue),
    end_decision: decision || null,
    savedTo: savedFile ? path.relative(ROOT, savedFile) : null
  };
}

async function handleProfileChat(body) {
  const sessionId = String(body.sessionId || '').trim();
  if (!sessionId) {
    const error = new Error('缺少 sessionId');
    error.status = 400;
    throw error;
  }

  const reset = !!body.reset;
  const resumeMode = !!body.resumeMode;
  const seedDraft = body.seedDraft && typeof body.seedDraft === 'object' ? body.seedDraft : null;
  const userMessage = body.userMessage == null ? null : String(body.userMessage).trim();
  const session = getOrCreateSession(sessionId, reset, seedDraft, resumeMode);
  const snapshot = snapshotSession(session);

  try {
    if (session.status !== 'in_progress') {
      const error = new Error('本轮对话已结束，请重新开始或发起补聊');
      error.status = 409;
      throw error;
    }

    if (!session.messages.length && userMessage == null) {
      if (!schema.currentField(session.fieldQueue)) {
        const wrap = await runAgent(session, 'wrap_up');
        applyWrapIntro(session, wrap.intro, wrap.reply, wrap.tagline);
        session.messages.push({ role: 'assistant', content: wrap.reply });
        session.status = 'completed';
        session.updatedAt = new Date().toISOString();
        const saved = persistSession(sessionId, session);
        return finishPayload(sessionId, session, wrap, 'handoff_summary', 'wrap_up', null, saved);
      }
      const opened = await runAgent(session, 'continue', { opening: true });
      session.messages.push({ role: 'assistant', content: opened.reply });
      session.updatedAt = new Date().toISOString();
      const saved = persistSession(sessionId, session);
      return finishPayload(sessionId, session, opened, 'continue', 'continue', null, saved);
    }

    if (!userMessage) {
      const error = new Error('缺少 userMessage');
      error.status = 400;
      throw error;
    }

    session.userTurns += 1;
    session.messages.push({ role: 'user', content: userMessage });
    const continued = await runAgent(session, 'continue');
    const turn = applyTurnState(session, continued);
    const decision = schema.shouldEnd({
      userTurns: session.userTurns,
      lowQualityStreak: session.lowQualityStreak,
      userAskedToEnd: turn.userAskedToEnd,
      fieldQueue: session.fieldQueue,
      draft: session.draft
    });
    session.endDecision = decision;

    if (decision.shouldEnd) {
      const wrap = await runAgent(session, 'wrap_up');
      applyWrapIntro(session, wrap.intro, wrap.reply, wrap.tagline);
      session.messages.push({ role: 'assistant', content: wrap.reply });
      session.status = 'completed';
      session.updatedAt = new Date().toISOString();
      const saved = persistSession(sessionId, session);
      return finishPayload(
        sessionId,
        session,
        wrap,
        'handoff_summary',
        'wrap_up',
        decision,
        saved,
        turn.answerStatus,
        turn.userSignal
      );
    }

    session.messages.push({ role: 'assistant', content: continued.reply });
    session.updatedAt = new Date().toISOString();
    const saved = persistSession(sessionId, session);
    return finishPayload(
      sessionId,
      session,
      continued,
      turn.unsafe ? 'hard_block' : 'continue',
      'continue',
      decision,
      saved,
      turn.answerStatus
    );
  } catch (error) {
    restoreSession(sessionId, snapshot);
    throw error;
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2'
  })[ext] || 'application/octet-stream';
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/match-card.html';
  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ROOT, safe);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        error.status = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }
  const urlPath = (req.url || '').split('?')[0];

  if (req.method === 'GET' && urlPath === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      hasKey: !!API_KEY,
      model: MODEL,
      sessions: sessions.size,
      savedChats: listSavedChats().length,
      architecture: 'single_agent_v3',
      endPolicy: schema.END_POLICY
    });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/profile-chats') {
    sendJson(res, 200, { ok: true, chats: listSavedChats() });
    return;
  }

  if (req.method === 'GET' && urlPath.startsWith('/api/profile-chats/')) {
    const sessionId = decodeURIComponent(urlPath.slice('/api/profile-chats/'.length));
    const chat = loadSavedChat(sessionId);
    sendJson(res, chat ? 200 : 404, chat ? { ok: true, chat } : { ok: false, error: 'not found' });
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/profile-chat') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, await handleProfileChat(body));
    } catch (error) {
      console.error('[profile-proxy]', error.message || error);
      sendJson(res, error.status || 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/profile-chat-confirm') {
    try {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '');
      let session = sessions.get(sessionId);
      if (!session) session = hydrateSession(loadSavedChat(sessionId));
      if (!session) {
        sendJson(res, 404, { ok: false, error: 'session not found' });
        return;
      }
      if (!schema.isProfileComplete(session.draft)) {
        sendJson(res, 400, { ok: false, error: '画像还不完整' });
        return;
      }
      if (typeof body.intro === 'string' && body.intro.trim()) session.draft.intro = body.intro.trim();
      if (typeof body.tagline === 'string') {
        session.draft.tagline = schema.normalizeTagline(body.tagline) || schema.fallbackTagline(session.draft);
      } else if (!session.draft.tagline) {
        session.draft.tagline = schema.fallbackTagline(session.draft);
      }
      session.status = 'confirmed';
      session.updatedAt = new Date().toISOString();
      sessions.set(sessionId, session);
      const saved = persistSession(sessionId, session);
      sendJson(res, 200, { ok: true, savedTo: saved ? path.relative(ROOT, saved) : null });
    } catch (error) {
      sendJson(res, error.status || 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }
  sendJson(res, 404, { ok: false, error: 'not found' });
});

function flushAllSessions() {
  for (const [sessionId, session] of sessions.entries()) persistSession(sessionId, session);
}

process.on('SIGINT', () => {
  flushAllSessions();
  process.exit(0);
});
process.on('SIGTERM', () => {
  flushAllSessions();
  process.exit(0);
});

ensureDataDir();
server.listen(PORT, () => {
  console.log('[profile-proxy] http://localhost:' + PORT + '/match-card.html');
  console.log('[profile-proxy] architecture=single_agent_v3');
  console.log('[profile-proxy] model=' + MODEL + ' key=' + (API_KEY ? 'yes' : 'MISSING'));
});

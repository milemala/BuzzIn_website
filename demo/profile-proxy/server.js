'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PROFILE_SYSTEM_PROMPT } = require('./system-prompt');
const schema = require('./profile-schema');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.PORT || 8788);
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = process.env.ZHIPU_MODEL || 'glm-4-flash';

loadEnv(path.join(__dirname, '.env'));
loadEnv(path.join(ROOT, '.env'));

const API_KEY = process.env.ZHIPU_API_KEY || '';
const DATA_DIR = path.join(__dirname, 'data', 'chats');
const sessions = new Map();

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function safeSessionFile(sessionId) {
  return String(sessionId).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'session';
}

function sessionPaths(sessionId) {
  const base = path.join(DATA_DIR, safeSessionFile(sessionId));
  return { json: base + '.json', md: base + '.md' };
}

function buildMarkdown(record) {
  const lines = [];
  lines.push('# 建档对话 ' + record.sessionId);
  lines.push('');
  lines.push('- 创建：' + (record.createdAt || ''));
  lines.push('- 更新：' + (record.updatedAt || ''));
  lines.push('- 状态：' + (record.status || 'in_progress'));
  lines.push('- 用户轮次：' + (record.userTurns || 0));
  lines.push('- 低质量连续：' + (record.lowQualityStreak || 0));
  if (record.endDecision) {
    lines.push('- 结束原因：' + (record.endDecision.reasons || []).join(', '));
  }
  lines.push('');
  lines.push('## 对话');
  lines.push('');
  (record.transcript || []).forEach((t) => {
    lines.push('**' + (t.role === 'user' ? '我' : 'AI') + '** · ' + (t.at || ''));
    lines.push('');
    lines.push(t.text || '');
    lines.push('');
  });
  lines.push('## 画像草稿');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(record.draft || {}, null, 2));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

function persistSession(sessionId, session) {
  try {
    ensureDataDir();
    const paths = sessionPaths(sessionId);
    const record = {
      sessionId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt || new Date().toISOString(),
      status: session.status || 'in_progress',
      draft: session.draft,
      transcript: session.transcript || [],
      messages: session.messages || [],
      userTurns: session.userTurns || 0,
      lowQualityStreak: session.lowQualityStreak || 0,
      endDecision: session.endDecision || null,
      architecture: 'single_agent'
    };
    fs.writeFileSync(paths.json, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fs.writeFileSync(paths.md, buildMarkdown(record), 'utf8');
    return paths;
  } catch (e) {
    console.error('[profile-proxy] persist failed:', e.message);
    return null;
  }
}

function listSavedChats() {
  ensureDataDir();
  return fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        const high = schema.countHighConfidence(j.draft || {});
        return {
          sessionId: j.sessionId,
          file: f,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          status: j.status,
          intro: (j.draft && j.draft.intro) || '',
          highFields: high.count,
          turns: (j.transcript || []).length,
          architecture: j.architecture || 'legacy'
        };
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function loadSavedChat(sessionId) {
  const paths = sessionPaths(sessionId);
  if (!fs.existsSync(paths.json)) return null;
  return JSON.parse(fs.readFileSync(paths.json, 'utf8'));
}

function appendTranscript(session, role, text) {
  if (!session.transcript) session.transcript = [];
  const cleaned = String(text || '').trim();
  if (!cleaned) return;
  if (role === 'user' && /^【业务指令】/.test(cleaned)) return;
  if (role === 'user' && /^格式错误：/.test(cleaned)) return;
  if (role === 'user' && /^用户刚打开/.test(cleaned)) return;
  session.transcript.push({ role, text: cleaned, at: new Date().toISOString() });
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  });
}

function extractJson(text) {
  if (!text) throw new Error('模型返回为空');
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

async function callZhipu(messages, opts) {
  if (!API_KEY) {
    const err = new Error('缺少 ZHIPU_API_KEY，请在 demo/profile-proxy/.env 配置');
    err.status = 500;
    throw err;
  }
  const res = await fetch(ZHIPU_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: opts && opts.temperature != null ? opts.temperature : 0.65,
      max_tokens: opts && opts.max_tokens != null ? opts.max_tokens : 900,
      response_format: { type: 'json_object' }
    })
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    const err = new Error('智谱返回非 JSON：' + raw.slice(0, 200));
    err.status = 502;
    throw err;
  }
  if (!res.ok) {
    const msg = (data.error && (data.error.message || data.error)) || data.msg || raw.slice(0, 200);
    const err = new Error('智谱 API 错误：' + msg);
    err.status = res.status;
    throw err;
  }
  const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return { content: content || '', usage: data.usage || null, model: data.model || MODEL };
}

function getOrCreateSession(sessionId, reset) {
  if (reset || !sessions.has(sessionId)) {
    const now = new Date().toISOString();
    sessions.set(sessionId, {
      messages: [],
      draft: schema.emptyDraft(),
      transcript: [],
      createdAt: now,
      updatedAt: now,
      status: 'in_progress',
      userTurns: 0,
      lowQualityStreak: 0,
      pendingWrapUp: false,
      endDecision: null
    });
  }
  return sessions.get(sessionId);
}

function buildSystem(session, phase) {
  const cover = schema.coverageSummary(session.draft);
  return [
    PROFILE_SYSTEM_PROMPT,
    '',
    '【本轮】phase=' + phase
      + ' turns=' + (session.userTurns || 0) + '/' + schema.END_POLICY.maxUserTurns
      + ' low_streak=' + (session.lowQualityStreak || 0)
      + ' high_fields=' + schema.countHighConfidence(session.draft).count,
    '当前画像摘要：' + (cover.known.length ? cover.known.slice(0, 5).join('；') : '还很少'),
    '提醒：聊天体验优先；禁止复述用户原话；profile_update 只写本轮新确认的字段。'
  ].join('\n');
}

function lastUserText(session) {
  const list = session.transcript || [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'user') return String(list[i].text || '').trim();
  }
  return '';
}

function isEchoReply(assistantText, userText) {
  const a = String(assistantText || '').trim();
  const u = String(userText || '').trim();
  if (!a || !u) return false;
  if (a === u) return true;
  if (u.length >= 4 && (a === u + '？' || a === u + '?' || a === u + '。')) return true;
  if (u.length >= 6 && a.length <= u.length + 6 && a.indexOf(u) === 0) return true;
  return false;
}

function pickReply(parsed) {
  return String(
    (parsed && (parsed.assistant_reply || parsed.assistant_message)) || ''
  ).trim();
}

async function runAgent(session, phase, opts) {
  const system = buildSystem(session, phase);
  const apiMessages = [{ role: 'system', content: system }].concat(session.messages);
  let result = await callZhipu(apiMessages, { temperature: 0.65, max_tokens: 900 });
  let parsed;
  try {
    parsed = extractJson(result.content);
  } catch (_) {
    const retry = await callZhipu(apiMessages.concat([
      { role: 'assistant', content: result.content },
      {
        role: 'user',
        content: '格式错误。请只输出一个 JSON，含 assistant_reply、quick_replies、profile_update、user_signal、safety。'
      }
    ]), { temperature: 0.4, max_tokens: 900 });
    result = retry;
    parsed = extractJson(retry.content);
  }

  let reply = pickReply(parsed);
  const userText = (opts && opts.userText) || lastUserText(session);

  if (!reply || isEchoReply(reply, userText)) {
    try {
      const fixed = await callZhipu(apiMessages.concat([
        { role: 'assistant', content: result.content },
        {
          role: 'user',
          content: '你刚才复述了我的话或回复无效。请重新输出 JSON：用自己的话短回应；continue 时给一个带例子的短问题；wrap_up 则只收束。禁止重复我的原话。'
        }
      ]), { temperature: 0.5, max_tokens: 700 });
      parsed = extractJson(fixed.content);
      result = fixed;
      reply = pickReply(parsed);
    } catch (_) { /* fallthrough */ }
  }

  if (!reply || isEchoReply(reply, userText)) {
    reply = phase === 'wrap_up'
      ? '好，我大概有数了。以后按你的感觉帮你找更合适的朋友和局。'
      : '明白。你更喜欢安静慢慢聊，还是热闹一点？比如咖啡 / 小酒吧。';
    parsed.quick_replies = phase === 'wrap_up' ? [] : ['偏安静', '偏热闹', '都可以'];
  }

  const profileUpdate = parsed.profile_update || parsed.slot_updates || {};
  session.draft = schema.mergeProfile(session.draft, profileUpdate);
  if (phase === 'wrap_up') {
    if (!session.draft.intro || /暂无|未填|不了解|信息不足/.test(session.draft.intro)) {
      session.draft.intro = schema.fallbackIntro(session.draft);
    }
  }

  session.messages.push({ role: 'assistant', content: reply });
  appendTranscript(session, 'assistant', reply);

  return {
    reply,
    quick_replies: Array.isArray(parsed.quick_replies) ? parsed.quick_replies.slice(0, 4) : [],
    profile_update: profileUpdate,
    user_signal: parsed.user_signal || 'normal',
    safety: parsed.safety || { level: 'ok', note: '' },
    usage: result.usage,
    model: result.model
  };
}

function applyUserSignal(session, signal) {
  const s = String(signal || 'normal');
  if (s === 'low_quality') session.lowQualityStreak += 1;
  else session.lowQualityStreak = 0;
  return {
    askedEnd: s === 'ask_end',
    unsafe: s === 'unsafe'
  };
}

function prunePreviousAssistant(session) {
  const msgs = session.messages || [];
  const idxs = [];
  for (let i = 0; i < msgs.length; i += 1) {
    if (msgs[i].role === 'assistant') idxs.push(i);
  }
  if (idxs.length >= 2) msgs.splice(idxs[idxs.length - 2], 1);

  const tr = session.transcript || [];
  const tIdxs = [];
  for (let i = 0; i < tr.length; i += 1) {
    if (tr[i].role === 'assistant') tIdxs.push(i);
  }
  if (tIdxs.length >= 2) tr.splice(tIdxs[tIdxs.length - 2], 1);
}

function finishPayload(sessionId, session, out, action, phase, decision, saved) {
  return {
    ok: true,
    sessionId,
    model: out.model || MODEL,
    usage: out.usage,
    assistant_reply: out.reply,
    assistant_message: out.reply,
    quick_replies: out.quick_replies,
    profile_update: out.profile_update || {},
    action,
    phase,
    profile_draft: session.draft,
    intro: session.draft.intro || '',
    end_decision: decision,
    safety: out.safety,
    savedTo: saved ? path.relative(ROOT, saved.json) : null
  };
}

async function handleProfileChat(body) {
  const sessionId = String(body.sessionId || 'default');
  const reset = !!body.reset;
  const userMessage = body.userMessage == null ? null : String(body.userMessage);
  const session = getOrCreateSession(sessionId, reset);

  // 开场
  if (!session.messages.length) {
    session.messages.push({
      role: 'user',
      content: userMessage && userMessage.trim()
        ? ('用户刚打开并说：' + userMessage.trim() + '\n请按开场规则回复，并更新 profile_update（若有）。')
        : '用户刚打开聊天。请按开场规则：说明想了解他以便推荐合适朋友/局，立刻给带例子的短问题 + quick_replies。'
    });
    if (userMessage && userMessage.trim()) {
      session.userTurns += 1;
      appendTranscript(session, 'user', userMessage.trim());
    }

    const opened = await runAgent(session, 'continue', {
      userText: userMessage && userMessage.trim() ? userMessage.trim() : ''
    });
    if (userMessage && userMessage.trim()) applyUserSignal(session, opened.user_signal);

    session.updatedAt = new Date().toISOString();
    const saved = persistSession(sessionId, session);
    return finishPayload(sessionId, session, opened, 'continue', 'continue', null, saved);
  }

  if (!userMessage || !userMessage.trim()) {
    const err = new Error('缺少 userMessage');
    err.status = 400;
    throw err;
  }

  const text = userMessage.trim();
  session.userTurns += 1;
  session.messages.push({ role: 'user', content: text });
  appendTranscript(session, 'user', text);

  let phase = session.pendingWrapUp ? 'wrap_up' : 'continue';
  if (phase === 'wrap_up') {
    session.messages.push({
      role: 'user',
      content: '【业务指令】可以结束了，请自然收束，并在 profile_update.intro 写短介绍。'
    });
  }

  let out = await runAgent(session, phase, { userText: text });
  const signalInfo = applyUserSignal(session, out.user_signal);

  if ((out.safety && out.safety.level === 'unsafe') || signalInfo.unsafe) {
    session.updatedAt = new Date().toISOString();
    const saved = persistSession(sessionId, session);
    return finishPayload(sessionId, session, out, 'hard_block', phase, session.endDecision, saved);
  }

  const decision = schema.evaluateEnd({
    userTurns: session.userTurns,
    lowQualityStreak: session.lowQualityStreak,
    draft: session.draft,
    userAskedToEnd: signalInfo.askedEnd
  });
  session.endDecision = decision;

  // 本轮还在聊，但业务判定该结束 → 再收束一次（仅结束时多一次）
  if (phase === 'continue' && decision.shouldEnd) {
    session.messages.push({
      role: 'user',
      content: '【业务指令】当前信息已足够，请自然结束，并在 profile_update.intro 写短介绍。不要再提新问题。'
    });
    const wrap = await runAgent(session, 'wrap_up', { userText: text });
    prunePreviousAssistant(session);
    out = wrap;
    phase = 'wrap_up';
  }

  if (phase === 'wrap_up') {
    if (!session.draft.intro || /暂无|未填|不了解|信息不足/.test(session.draft.intro)) {
      session.draft.intro = schema.fallbackIntro(session.draft);
    }
    session.status = 'completed';
    session.pendingWrapUp = false;
    session.updatedAt = new Date().toISOString();
    const saved = persistSession(sessionId, session);
    return finishPayload(sessionId, session, out, 'handoff_summary', 'wrap_up', decision, saved);
  }

  session.updatedAt = new Date().toISOString();
  const saved = persistSession(sessionId, session);
  return finishPayload(sessionId, session, out, 'continue', 'continue', decision, saved);
}

function mergeDraftCompat(draft, updates) {
  if (!updates || typeof updates !== 'object') return draft;
  let next = draft && draft.version === 'v2' ? Object.assign({}, draft) : schema.emptyDraft();
  if (typeof updates.intro === 'string' && updates.intro.trim()) next.intro = updates.intro.trim();
  schema.PROFILE_FIELDS.forEach((key) => {
    if (updates[key]) next[key] = schema.normalizeField(updates[key]);
  });
  next.version = 'v2';
  return next;
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
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
  fs.readFile(filePath, (err, data) => {
    if (err) {
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
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    res.end();
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
      dataDir: path.relative(ROOT, DATA_DIR),
      architecture: 'single_agent',
      endPolicy: schema.END_POLICY
    });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/profile-chats') {
    sendJson(res, 200, { ok: true, chats: listSavedChats() });
    return;
  }

  if (req.method === 'GET' && urlPath.startsWith('/api/profile-chats/')) {
    const id = decodeURIComponent(urlPath.slice('/api/profile-chats/'.length));
    const chat = loadSavedChat(id);
    if (!chat) {
      sendJson(res, 404, { ok: false, error: 'not found' });
      return;
    }
    sendJson(res, 200, { ok: true, chat });
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/profile-chat-confirm') {
    try {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '');
      const session = sessions.get(sessionId);
      if (!session) {
        const existing = loadSavedChat(sessionId);
        if (!existing) {
          sendJson(res, 404, { ok: false, error: 'session not found' });
          return;
        }
        existing.status = 'confirmed';
        existing.updatedAt = new Date().toISOString();
        if (body.profileDraft) existing.draft = mergeDraftCompat(existing.draft || schema.emptyDraft(), body.profileDraft);
        if (body.intro) existing.draft.intro = String(body.intro);
        ensureDataDir();
        const paths = sessionPaths(sessionId);
        fs.writeFileSync(paths.json, JSON.stringify(existing, null, 2) + '\n', 'utf8');
        fs.writeFileSync(paths.md, buildMarkdown(existing), 'utf8');
        sendJson(res, 200, { ok: true, savedTo: path.relative(ROOT, paths.json) });
        return;
      }
      session.status = 'confirmed';
      session.updatedAt = new Date().toISOString();
      if (body.profileDraft) session.draft = mergeDraftCompat(session.draft, body.profileDraft);
      if (body.intro) session.draft.intro = String(body.intro);
      const saved = persistSession(sessionId, session);
      sendJson(res, 200, { ok: true, savedTo: saved ? path.relative(ROOT, saved.json) : null });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message || String(e) });
    }
    return;
  }

  if (req.method === 'POST' && urlPath === '/api/profile-chat') {
    try {
      const body = await readBody(req);
      const out = await handleProfileChat(body);
      sendJson(res, 200, out);
    } catch (e) {
      console.error('[profile-proxy]', e);
      sendJson(res, e.status || 500, { ok: false, error: e.message || String(e) });
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
  for (const [id, session] of sessions.entries()) persistSession(id, session);
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
  console.log('[profile-proxy] architecture=single_agent');
  console.log('[profile-proxy] chats saved under ' + DATA_DIR);
  console.log('[profile-proxy] model=' + MODEL + ' key=' + (API_KEY ? 'yes' : 'MISSING'));
});

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PROFILE_SYSTEM_PROMPT } = require('./system-prompt');

const ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.PORT || 8787);
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = process.env.ZHIPU_MODEL || 'glm-4-flash';

loadEnv(path.join(__dirname, '.env'));
loadEnv(path.join(ROOT, '.env'));

const API_KEY = process.env.ZHIPU_API_KEY || '';
const DATA_DIR = path.join(__dirname, 'data', 'chats');

/** @type {Map<string, { messages: Array<{role:string,content:string}>, draft: object, transcript: Array<object>, createdAt: string, updatedAt: string, status: string }>} */
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
  lines.push('');
  lines.push('## 对话');
  lines.push('');
  (record.transcript || []).forEach((t) => {
    const who = t.role === 'user' ? '我' : 'AI';
    lines.push('**' + who + '** · ' + (t.at || ''));
    lines.push('');
    lines.push(t.text || '');
    lines.push('');
  });
  lines.push('## 档案草稿');
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
      messages: session.messages || []
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
        return {
          sessionId: j.sessionId,
          file: f,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          status: j.status,
          intro: (j.draft && j.draft.intro) || '',
          occupation: (j.draft && (j.draft.occupation || j.draft.occupation_category)) || '',
          turns: (j.transcript || []).length
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
  // 跳过内部开场指令，不进可读对话
  if (role === 'user' && /^请按规则开场/.test(cleaned)) return;
  if (role === 'user' && /^请先按规则开场/.test(cleaned)) {
    const m = cleaned.match(/我的话：([\s\S]+)$/);
    if (m) {
      session.transcript.push({ role: 'user', text: m[1].trim(), at: new Date().toISOString() });
    }
    return;
  }
  if (role === 'user' && /^格式错误：/.test(cleaned)) return;
  session.transcript.push({ role, text: cleaned, at: new Date().toISOString() });
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  text.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  });
}

function emptyDraft() {
  return {
    occupation_category: '',
    occupation: '',
    interests: [],
    social_style: null,
    group_preference: null,
    preferred_people: null,
    intro: ''
  };
}

function mergeDraft(draft, updates) {
  if (!updates || typeof updates !== 'object') return draft;
  const next = Object.assign({}, draft);
  if (typeof updates.occupation_category === 'string' && updates.occupation_category.trim()) {
    next.occupation_category = updates.occupation_category.trim();
  }
  if (typeof updates.occupation === 'string' && updates.occupation.trim()) {
    next.occupation = updates.occupation.trim();
  }
  if (Array.isArray(updates.interests) && updates.interests.length) {
    next.interests = updates.interests;
  }
  if (updates.social_style && typeof updates.social_style === 'object') {
    next.social_style = updates.social_style;
  }
  if (updates.group_preference && typeof updates.group_preference === 'object') {
    next.group_preference = updates.group_preference;
  }
  if (updates.preferred_people && typeof updates.preferred_people === 'object') {
    next.preferred_people = updates.preferred_people;
  }
  if (typeof updates.intro === 'string' && updates.intro.trim()) {
    next.intro = updates.intro.trim();
  }
  return next;
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

function draftContext(draft) {
  return '当前档案草稿（JSON）：\n' + JSON.stringify(draft, null, 2);
}

async function callZhipu(messages) {
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
      temperature: 0.4,
      max_tokens: 1200,
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
      draft: emptyDraft(),
      transcript: [],
      createdAt: now,
      updatedAt: now,
      status: 'in_progress'
    });
  }
  return sessions.get(sessionId);
}

async function handleProfileChat(body) {
  const sessionId = String(body.sessionId || 'default');
  const reset = !!body.reset;
  const userMessage = body.userMessage == null ? null : String(body.userMessage);
  const session = getOrCreateSession(sessionId, reset);

  if (body.profileDraft && typeof body.profileDraft === 'object') {
    // 前端草稿只作补充；空字段不得覆盖服务端已收集内容
    session.draft = mergeDraft(session.draft, body.profileDraft);
  }

  const system = PROFILE_SYSTEM_PROMPT + '\n\n' + draftContext(session.draft);

  if (!session.messages.length) {
    session.messages.push({
      role: 'user',
      content: userMessage && userMessage.trim()
        ? ('请先按规则开场，再根据我的这句话继续。我的话：' + userMessage.trim())
        : '请按规则开场，并自然进入 Q1。'
    });
    if (userMessage && userMessage.trim()) {
      appendTranscript(session, 'user', userMessage.trim());
    }
  } else if (userMessage && userMessage.trim()) {
    session.messages.push({ role: 'user', content: userMessage.trim() });
    appendTranscript(session, 'user', userMessage.trim());
  } else {
    const err = new Error('缺少 userMessage');
    err.status = 400;
    throw err;
  }

  const apiMessages = [{ role: 'system', content: system }].concat(session.messages);
  let result = await callZhipu(apiMessages);
  let parsed;
  try {
    parsed = extractJson(result.content);
  } catch (firstErr) {
    // 模型偶发输出纯文本：追加纠错再试一次
    session.messages.push({ role: 'assistant', content: result.content });
    session.messages.push({
      role: 'user',
      content: '格式错误：你刚才没有输出合法 JSON。请重新输出，只给一个 JSON 对象，包含 assistant_message、slot_updates、next_question、quick_replies、action、intro、safety。不要其它文字。'
    });
    const retryMessages = [{ role: 'system', content: system }].concat(session.messages);
    result = await callZhipu(retryMessages);
    try {
      parsed = extractJson(result.content);
    } catch (e) {
      const err = new Error('无法解析模型 JSON：' + e.message + ' | raw=' + String(result.content).slice(0, 300));
      err.status = 502;
      throw err;
    }
  }

  session.messages.push({ role: 'assistant', content: result.content });
  parsed = ensureQuestionText(parsed);
  session.draft = mergeDraft(session.draft, parsed.slot_updates || {});
  if (parsed.intro) session.draft.intro = String(parsed.intro);
  appendTranscript(session, 'assistant', parsed.assistant_message || '');

  if (parsed.action === 'handoff_summary' || parsed.next_question === 'done') {
    const introBad = !session.draft.intro
      || /未填|没有填写|信息不足|还不了解|暂无|什么都没|都没填|信息为空/.test(session.draft.intro);
    if (introBad) {
      session.draft.intro = fallbackIntro(session.draft);
    }
    let msg = String(parsed.assistant_message || '').trim();
    if (!/介绍|看看|确认/.test(msg)) {
      msg = (msg ? msg.replace(/[。！!?？]*$/, '') + '。' : '') + '我帮你整理成一段介绍，你看看要不要改。';
    }
    parsed.assistant_message = msg;
    parsed.action = 'handoff_summary';
    parsed.next_question = 'done';
    session.status = 'completed';
    // 若最后一条 AI 文案被改过，同步可读 transcript
    if (session.transcript && session.transcript.length) {
      const last = session.transcript[session.transcript.length - 1];
      if (last.role === 'assistant') last.text = msg;
    }
  }

  session.updatedAt = new Date().toISOString();
  const saved = persistSession(sessionId, session);

  return {
    ok: true,
    sessionId,
    model: result.model,
    usage: result.usage,
    assistant_message: parsed.assistant_message || '',
    slot_updates: parsed.slot_updates || {},
    profile_draft: session.draft,
    next_question: parsed.next_question || 'q1',
    quick_replies: Array.isArray(parsed.quick_replies) ? parsed.quick_replies.slice(0, 5) : [],
    action: parsed.action || 'ask_next',
    intro: session.draft.intro || '',
    safety: parsed.safety || { level: 'ok', note: '' },
    savedTo: saved ? path.relative(ROOT, saved.json) : null
  };
}

function fallbackIntro(d) {
  const role = [d.occupation_category, d.occupation].filter(Boolean).join('·')
    || d.occupation
    || d.occupation_category
    || '在这座城市生活';
  const tags = (d.interests || []).map((i) => (i && i.tag) || i).filter(Boolean).slice(0, 4);
  const tagText = tags.length ? tags.join('、') : '';
  const pace = d.social_style
    ? (d.social_style.warmup_speed <= 0.4 ? '偏慢热' : (d.social_style.initiative >= 0.65 ? '爱带气氛' : ''))
    : '';
  const group = d.group_preference
    ? ({
      small: '更爱小局聊天',
      medium: '喜欢小圈子热闹一点',
      large: '不介意人多热闹',
      any: ''
    }[d.group_preference.preferred_size] || '')
    : '';
  const bits = [];
  bits.push(role);
  if (tagText) bits.push('平时喜欢' + tagText);
  if (pace) bits.push(pace);
  if (group) bits.push(group);
  bits.push('想认识同频的人一起出门');
  return bits.join('，').replace(/，+/g, '，') + '。';
}

const QUESTION_FALLBACKS = {
  q1: '你现在主要是做什么的？比如互联网、金融、学生、自由职业，都可以随便说。',
  q2: '平时有空的时候，你一般喜欢干嘛？比如喝一杯、探店、运动、看展、听现场、桌游、户外……想到什么说什么。',
  q3: '跟刚认识的人一起玩时，你一般是哪种？比较能带气氛、熟了才放得开、喜欢听别人聊，还是都看情况？',
  q4: '如果让我帮你攒局，你更喜欢什么感觉的？比如两三个人随便聊、小圈子热闹点、大家一起玩点什么，或者人多一点都行？',
  q5: '最后一个，你通常会更愿意认识什么样的人？比如聊得来、有趣、同龄、同行、兴趣一样、能带你玩……没特别要求也可以。'
};

const DEFAULT_QUICK = {
  q3: ['能带气氛', '慢热型', '比较随和', '偏安静', '看人看场合'],
  q4: ['两三个人小聊', '小圈子热闹点', '有事干不尬聊', '人多一点也行'],
  q5: ['聊得来就好', '有趣主动一点', '同龄同好', '没特别要求']
};

function ensureQuestionText(parsed) {
  const q = parsed.next_question;
  const action = parsed.action || 'ask_next';
  if (!QUESTION_FALLBACKS[q]) return parsed;
  if (action === 'handoff_summary' || action === 'hard_block' || action === 'soft_end') return parsed;
  let msg = String(parsed.assistant_message || '').trim();
  const fallback = QUESTION_FALLBACKS[q];
  // 只要正文里还没出现该问的核心问句，就补上标准问法（模型常只寒暄不提问）
  const alreadyHas = msg.includes(fallback) || (q === 'q1' && /做什么的/.test(msg))
    || (q === 'q2' && /喜欢干嘛|有空的时候/.test(msg))
    || (q === 'q3' && /刚认识|哪种/.test(msg))
    || (q === 'q4' && /攒局|什么感觉/.test(msg))
    || (q === 'q5' && /什么样的人|愿意认识/.test(msg));
  if (!alreadyHas) {
    msg = msg ? (msg.replace(/[。！!?？～~]*$/, '') + '。' + fallback) : fallback;
  }
  parsed.assistant_message = msg;
  if ((!parsed.quick_replies || !parsed.quick_replies.length) && DEFAULT_QUICK[q]) {
    parsed.quick_replies = DEFAULT_QUICK[q].slice();
  }
  return parsed;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
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
  };
  return map[ext] || 'application/octet-stream';
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
      dataDir: path.relative(ROOT, DATA_DIR)
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
        // 内存没有时，尝试给已落盘记录打标
        const existing = loadSavedChat(sessionId);
        if (!existing) {
          sendJson(res, 404, { ok: false, error: 'session not found' });
          return;
        }
        existing.status = 'confirmed';
        existing.updatedAt = new Date().toISOString();
        if (body.profileDraft) existing.draft = mergeDraft(existing.draft || emptyDraft(), body.profileDraft);
        ensureDataDir();
        const paths = sessionPaths(sessionId);
        fs.writeFileSync(paths.json, JSON.stringify(existing, null, 2) + '\n', 'utf8');
        fs.writeFileSync(paths.md, buildMarkdown(existing), 'utf8');
        sendJson(res, 200, { ok: true, savedTo: path.relative(ROOT, paths.json) });
        return;
      }
      session.status = 'confirmed';
      session.updatedAt = new Date().toISOString();
      if (body.profileDraft) session.draft = mergeDraft(session.draft, body.profileDraft);
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
  for (const [id, session] of sessions.entries()) {
    persistSession(id, session);
  }
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
  console.log('[profile-proxy] chats saved under ' + DATA_DIR);
  console.log('[profile-proxy] model=' + MODEL + ' key=' + (API_KEY ? 'yes' : 'MISSING'));
});

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COOKIE_NAME = "zup_review_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_LIMIT = 8;
const LOCK_MS = 15 * 60 * 1000;

const sessions = new Map();
const failures = new Map();

function loadReviewPassword(root) {
  const fromEnv = String(process.env.REVIEW_PASSWORD || "").trim();
  if (fromEnv) return fromEnv;
  const filePath = path.join(root, "data", "review-password");
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return "";
  }
  const line = text.split(/\r?\n/).map((item) => item.trim()).find((item) => item && !item.startsWith("#"));
  return line || "";
}

function isLoopbackAddress(address) {
  const ip = String(address || "").trim().toLowerCase().replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1";
}

function isPublicBind(host) {
  const value = String(host || "").trim().toLowerCase();
  return value !== "" && value !== "127.0.0.1" && value !== "localhost" && value !== "::1";
}

function assertReviewBindAllowed(host, password) {
  if (isPublicBind(host) && !password) {
    throw new Error("审核台要对公网打开时，必须先设置登录密码。把密码写在 data/review-password 的一行里，或设置 REVIEW_PASSWORD。");
  }
}

function clientNeedsPassword(remoteAddress, password) {
  if (!password) return false;
  return !isLoopbackAddress(remoteAddress);
}

function passwordsMatch(expected, given) {
  const left = crypto.createHash("sha256").update(String(expected)).digest();
  const right = crypto.createHash("sha256").update(String(given || "")).digest();
  return crypto.timingSafeEqual(left, right);
}

function failureState(ip) {
  const key = String(ip || "");
  const current = failures.get(key);
  if (!current) return { count: 0, lockedUntil: 0 };
  if (current.lockedUntil && current.lockedUntil <= Date.now()) {
    failures.delete(key);
    return { count: 0, lockedUntil: 0 };
  }
  return current;
}

function loginLocked(ip) {
  const state = failureState(ip);
  if (state.lockedUntil > Date.now()) {
    return { locked: true, retryAfterSec: Math.ceil((state.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

function recordLoginFailure(ip) {
  const state = failureState(ip);
  const count = state.count + 1;
  const next = {
    count,
    lockedUntil: count >= FAILURE_LIMIT ? Date.now() + LOCK_MS : 0,
  };
  failures.set(String(ip || ""), next);
  return loginLocked(ip);
}

function clearLoginFailures(ip) {
  failures.delete(String(ip || ""));
}

function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, Date.now() + SESSION_MS);
  return token;
}

function sessionIsValid(token) {
  const value = String(token || "");
  if (!value) return false;
  const expiresAt = sessions.get(value);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(value);
    return false;
  }
  return true;
}

function clearSession(token) {
  sessions.delete(String(token || ""));
}

function readSessionToken(cookieHeader) {
  const parts = String(cookieHeader || "").split(";");
  for (const part of parts) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return "";
}

function sessionCookie(token) {
  const maxAge = Math.floor(SESSION_MS / 1000);
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

function safeNextPath(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\") || text.includes("\n") || text.includes("\r")) {
    return "/";
  }
  return text;
}

function loginPageHtml({ next = "/", error = "" } = {}) {
  const safeNext = safeNextPath(next);
  const errorHtml = error
    ? `<p class="error">${escapeHtml(error)}</p>`
    : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录审核台</title>
  <style>
    :root{--bg:#f7f4ed;--text:#1f1b16;--muted:#82786a;--line:#e6ded0;--red:#d95040}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
    form{width:min(420px,calc(100% - 32px));background:#fffdf8;border:1px solid var(--line);border-radius:16px;padding:28px 24px}
    h1{margin:0;font-size:22px}
    p{margin:8px 0 0;color:var(--muted);font-size:14px;line-height:1.5}
    label{display:block;margin-top:22px;font-size:13px;font-weight:700}
    input{width:100%;height:44px;margin-top:8px;border:1px solid var(--line);border-radius:10px;padding:0 12px;font:inherit}
    button{width:100%;height:44px;margin-top:16px;border:0;border-radius:10px;background:#111;color:#fff;font:inherit;font-weight:700;cursor:pointer}
    .error{color:var(--red);font-weight:700}
  </style>
</head>
<body>
  <form id="loginForm">
    <h1>审核台登录</h1>
    <p>用公网地址打开审核台前，先输入登录密码。</p>
    ${errorHtml}
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus>
    <button type="submit">进入</button>
  </form>
  <script>
    const nextUrl = ${JSON.stringify(safeNext)};
    document.getElementById("loginForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = document.getElementById("password").value;
      const button = event.target.querySelector("button");
      button.disabled = true;
      try {
        const response = await fetch("/api/review-login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password, next: nextUrl }),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          const message = payload.error || "密码不对";
          window.location.href = "/login.html?next=" + encodeURIComponent(nextUrl) + "&error=" + encodeURIComponent(message);
          return;
        }
        window.location.href = payload.next || nextUrl || "/";
      } catch (error) {
        button.disabled = false;
        window.alert("登录没有发出去，请再试一次");
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = {
  assertReviewBindAllowed,
  clearLoginFailures,
  clearSession,
  clearSessionCookie,
  clientNeedsPassword,
  createSession,
  isLoopbackAddress,
  isPublicBind,
  loadReviewPassword,
  loginLocked,
  loginPageHtml,
  passwordsMatch,
  readSessionToken,
  recordLoginFailure,
  safeNextPath,
  sessionCookie,
  sessionIsValid,
};

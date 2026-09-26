const assert = require("assert");
const {
  assertReviewBindAllowed,
  clientNeedsPassword,
  isLoopbackAddress,
  passwordsMatch,
  safeNextPath,
  recordLoginFailure,
  loginLocked,
  clearLoginFailures,
  createSession,
  sessionIsValid,
  clearSession,
  readSessionToken,
} = require("./review-auth");

assert.strictEqual(isLoopbackAddress("127.0.0.1"), true);
assert.strictEqual(isLoopbackAddress("::ffff:127.0.0.1"), true);
assert.strictEqual(isLoopbackAddress("::1"), true);
assert.strictEqual(isLoopbackAddress("8.8.8.8"), false);

assert.strictEqual(clientNeedsPassword("127.0.0.1", "secret"), false);
assert.strictEqual(clientNeedsPassword("1.2.3.4", "secret"), true);
assert.strictEqual(clientNeedsPassword("1.2.3.4", ""), false);

assert.throws(() => assertReviewBindAllowed("0.0.0.0", ""));
assert.doesNotThrow(() => assertReviewBindAllowed("0.0.0.0", "secret"));
assert.doesNotThrow(() => assertReviewBindAllowed("127.0.0.1", ""));

assert.strictEqual(passwordsMatch("secret", "secret"), true);
assert.strictEqual(passwordsMatch("secret", "wrong"), false);
assert.strictEqual(safeNextPath("https://evil.example"), "/");
assert.strictEqual(safeNextPath("//evil.example"), "/");
assert.strictEqual(safeNextPath("/merchant-bubbles.html"), "/merchant-bubbles.html");

const ip = "203.0.113.8";
clearLoginFailures(ip);
for (let i = 0; i < 7; i += 1) recordLoginFailure(ip);
assert.strictEqual(loginLocked(ip).locked, false);
recordLoginFailure(ip);
assert.strictEqual(loginLocked(ip).locked, true);
clearLoginFailures(ip);

const token = createSession();
assert.strictEqual(sessionIsValid(token), true);
assert.strictEqual(readSessionToken(`a=1; zup_review_session=${token}`), token);
clearSession(token);
assert.strictEqual(sessionIsValid(token), false);

console.log("review-auth tests passed");

"use strict";

/** Buzz 后台环境：测试 / 正式 */
const BUZZ_ENVS = {
  test: {
    key: "test",
    label: "测试",
    base: "https://test-go-api.nowmap.cn",
    adminUser: "admin",
    adminPass: "Test1234",
    defaultPublishUserId: "854508330",
    danger: false,
  },
  prod: {
    key: "prod",
    label: "正式",
    base: "https://zup.nowmap.cn",
    adminUser: "admin",
    adminPass: "Just666good",
    defaultPublishUserId: "382380210",
    danger: true,
  },
};

const VALID_ENV_KEYS = new Set(Object.keys(BUZZ_ENVS));

function normalizeBuzzEnv(value) {
  const key = String(value || "test").trim().toLowerCase();
  return VALID_ENV_KEYS.has(key) ? key : "test";
}

function envVarNames(envKey) {
  const prefix = envKey === "prod" ? "PROD" : "TEST";
  return {
    base: `BUZZ_API_BASE_${prefix}`,
    token: `BUZZ_TOKEN_${prefix}`,
    user: `BUZZ_ADMIN_USER_${prefix}`,
    pass: `BUZZ_ADMIN_PASS_${prefix}`,
    publishUserId: `BUZZ_PUBLISH_USER_ID_${prefix}`,
  };
}

function getBuzzEnvConfig(envKey) {
  const key = normalizeBuzzEnv(envKey);
  const def = BUZZ_ENVS[key];
  const names = envVarNames(key);
  const legacy = key === "test";
  return {
    ...def,
    key,
    base: String(
      process.env[names.base]
      || (legacy ? process.env.BUZZ_API_BASE : "")
      || def.base,
    ).trim().replace(/\/$/, ""),
    token: String(
      process.env[names.token]
      || (legacy ? process.env.BUZZ_TOKEN : "")
      || "",
    ).trim(),
    adminUser: String(
      process.env[names.user]
      || (legacy ? process.env.BUZZ_ADMIN_USER : "")
      || def.adminUser,
    ).trim(),
    adminPass: String(
      process.env[names.pass]
      || (legacy ? process.env.BUZZ_ADMIN_PASS : "")
      || def.adminPass,
    ).trim(),
    defaultPublishUserId: String(
      process.env[names.publishUserId]
      || def.defaultPublishUserId,
    ).trim(),
  };
}

function listBuzzEnvsPublic() {
  return Object.keys(BUZZ_ENVS).map((key) => {
    const cfg = getBuzzEnvConfig(key);
    return {
      key,
      label: BUZZ_ENVS[key].label,
      base: cfg.base,
      danger: BUZZ_ENVS[key].danger,
      configured: Boolean(cfg.token || (cfg.adminUser && cfg.adminPass)),
      default_publish_user_id: cfg.defaultPublishUserId,
    };
  });
}

function createBuzzClientOptions(envKey) {
  const cfg = getBuzzEnvConfig(envKey);
  return {
    base: cfg.base,
    token: cfg.token,
    user: cfg.adminUser,
    pass: cfg.adminPass,
    buzz_env: cfg.key,
  };
}

function resolvePublishUserId(envKey, storedValue, fallbackValue) {
  const stored = String(storedValue || "").trim();
  if (stored) return stored;
  const fallback = String(fallbackValue || "").trim();
  if (fallback) return fallback;
  return getBuzzEnvConfig(envKey).defaultPublishUserId;
}

module.exports = {
  BUZZ_ENVS,
  VALID_ENV_KEYS,
  createBuzzClientOptions,
  getBuzzEnvConfig,
  listBuzzEnvsPublic,
  normalizeBuzzEnv,
  resolvePublishUserId,
};

(() => {
  const STORAGE_KEY = "buzz_env";
  let envs = [];
  let currentEnv = localStorage.getItem(STORAGE_KEY) || "test";

  function normalizeEnv(value) {
    const key = String(value || "test").trim().toLowerCase();
    return envs.some((item) => item.key === key) ? key : "test";
  }

  function currentEnvMeta() {
    return envs.find((item) => item.key === currentEnv) || {
      key: currentEnv,
      label: currentEnv === "prod" ? "正式" : "测试",
      danger: currentEnv === "prod",
      base: "",
    };
  }

  function envQuery() {
    return `buzz_env=${encodeURIComponent(currentEnv)}`;
  }

  function withBuzzEnv(url) {
    const text = String(url || "");
    const join = text.includes("?") ? "&" : "?";
    return `${text}${join}${envQuery()}`;
  }

  function importBody(body = {}) {
    return { ...body, buzz_env: currentEnv };
  }

  function envLabel() {
    return currentEnvMeta().label || currentEnv;
  }

  function isProdEnv() {
    return Boolean(currentEnvMeta().danger);
  }

  function defaultPublishUserId() {
    return String(currentEnvMeta().default_publish_user_id || "").trim();
  }

  async function confirmProdAction(message) {
    if (!isProdEnv()) return true;
    const meta = currentEnvMeta();
    return window.confirm(
      `${message}\n\n当前为【${meta.label}】${meta.base ? `（${meta.base}）` : ""}，写入后用户可在 App 中看到。确定继续？`,
    );
  }

  function applyTopBarTheme() {
    const top = document.querySelector(".top");
    if (!top) return;
    top.classList.toggle("buzz-env-prod", isProdEnv());
  }

  function renderSwitcher(container) {
    if (!container) return;
    const meta = currentEnvMeta();
    container.innerHTML = `
      <label class="buzz-env-switch" title="切换推送目标环境">
        <span class="buzz-env-switch-label">推送环境</span>
        <select id="buzzEnvSelect" aria-label="Buzz 推送环境">
          ${envs.map((item) => `
            <option value="${item.key}" ${item.key === currentEnv ? "selected" : ""}>
              ${item.label}${item.danger ? " ⚠" : ""}
            </option>
          `).join("")}
        </select>
        <span class="buzz-env-base ${meta.danger ? "danger" : ""}">${meta.base || ""}</span>
      </label>
    `;
    const select = container.querySelector("#buzzEnvSelect");
    select?.addEventListener("change", async () => {
      currentEnv = normalizeEnv(select.value);
      localStorage.setItem(STORAGE_KEY, currentEnv);
      applyTopBarTheme();
      renderSwitcher(container);
      if (typeof window.onBuzzEnvChanged === "function") {
        await window.onBuzzEnvChanged(currentEnv);
      }
    });
    applyTopBarTheme();
  }

  async function initBuzzEnvUi(mountSelector) {
    try {
      const response = await fetch("/api/buzz-envs", { cache: "no-store" });
      const data = await response.json();
      envs = Array.isArray(data.envs) ? data.envs : [];
    } catch {
      envs = [
        { key: "test", label: "测试", danger: false, base: "https://test-go-api.nowmap.cn", default_publish_user_id: "854508330" },
        { key: "prod", label: "正式", danger: true, base: "https://zup.nowmap.cn", default_publish_user_id: "382380210" },
      ];
    }
    currentEnv = normalizeEnv(localStorage.getItem(STORAGE_KEY) || "test");
    localStorage.setItem(STORAGE_KEY, currentEnv);
    renderSwitcher(document.querySelector(mountSelector));
    return currentEnv;
  }

  window.BuzzEnvUi = {
    initBuzzEnvUi,
    getBuzzEnv: () => currentEnv,
    envLabel,
    envQuery,
    withBuzzEnv,
    importBody,
    isProdEnv,
    defaultPublishUserId,
    confirmProdAction,
    currentEnvMeta,
  };
})();

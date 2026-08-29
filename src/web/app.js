"use strict";

// 零依赖前端。所有写操作带 X-CSRF-Token(会话 cookie 是 HttpOnly,JS 读不到,
// 靠这个头证明请求来自本页而非第三方站点诱导)。
let csrfToken = null;
let accountsCache = [];

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const k of kids.flat()) node.append(k);
  return node;
};

function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = bad ? "toast bad" : "toast";
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    t.hidden = true;
  }, bad ? 6000 : 3000);
}

async function api(method, path, { body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (csrfToken && method !== "GET") headers["x-csrf-token"] = csrfToken;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    throw new Error(`服务器返回了非 JSON 响应(HTTP ${res.status})`);
  }
  if (!res.ok || payload.ok === false) {
    const err = new Error(payload?.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return payload.data;
}

// 会话过期后统一回到登录页,而不是让页面停在半死状态
async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      csrfToken = null;
      await boot();
      toast("登录状态已失效,请重新登录", true);
      return undefined;
    }
    toast(err.message, true);
    return undefined;
  }
}

// ---- 登录 / 首次设置 ----

let gateMode = "login";

function showGate(needsSetup) {
  gateMode = needsSetup ? "setup" : "login";
  $("app").hidden = true;
  $("gate").hidden = false;
  $("gate-error").textContent = "";
  $("gate-form").reset();
  const setup = gateMode === "setup";
  $("gate-title").textContent = setup ? "首次设置" : "登录";
  $("gate-hint").textContent = setup
    ? "还没有 WebUI 密码。用 .env 里的 PLACEGAME_API_TOKEN 验证身份,并设置一个至少 12 位的密码。"
    : "";
  $("gate-token-row").hidden = !setup;
  $("gate-confirm-row").hidden = !setup;
  $("gate-token").required = setup;
  $("gate-confirm").required = setup;
  $("gate-pw-label").textContent = setup ? "设置密码(至少 12 位)" : "密码";
  $("gate-password").autocomplete = setup ? "new-password" : "current-password";
  $("gate-submit").textContent = setup ? "设置并登录" : "进入";
  $("gate-password").focus();
}

$("gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errBox = $("gate-error");
  errBox.textContent = "";
  const password = $("gate-password").value;
  const btn = $("gate-submit");
  btn.disabled = true;
  try {
    if (gateMode === "setup") {
      if (password !== $("gate-confirm").value) throw new Error("两次输入的密码不一致");
      if (password.length < 12) throw new Error("密码至少 12 位");
      await api("POST", "/api/web/setup", { body: { password }, token: $("gate-token").value.trim() });
    }
    const data = await api("POST", "/api/web/login", { body: { password } });
    csrfToken = data.csrfToken;
    $("gate").hidden = true;
    $("app").hidden = false;
    await refreshAll();
  } catch (err) {
    errBox.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  await api("POST", "/api/web/logout").catch(() => {});
  csrfToken = null;
  await boot();
});

// ---- 标签页 ----

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    for (const p of document.querySelectorAll(".panel")) {
      p.hidden = p.id !== `panel-${tab.dataset.panel}`;
    }
    if (tab.dataset.panel === "tasks") loadTasks();
  });
}

// ---- 账号 ----

const ACTIONS = [
  ["collect", "收挂机收益"],
  ["inventory/decompose", "背包分解"],
  ["profession/settle", "副职结算"],
  ["guild/daily", "公会日常"],
  ["boss/map", "地图首领"],
  ["boss/world", "世界首领"],
  ["activity/claim-all", "领活动奖励"],
  ["daily-run", "一键全部日常"]
];

function accountCard(acc) {
  const out = el("pre", { className: "out", hidden: true });

  const run = async (path, label, extra) => {
    out.hidden = false;
    out.textContent = `${label} 执行中…`;
    const data = await guarded(() =>
      api("POST", `/accounts/${encodeURIComponent(acc.label)}/${path}`, { body: extra ?? {} })
    );
    // 这里不重载列表:重载会重建卡片,把刚拿到的结果冲掉
    if (data !== undefined) out.textContent = `${label} 完成\n${JSON.stringify(data, null, 2)}`;
  };

  const actionButtons = ACTIONS.map(([path, label]) =>
    el("button", {
      className: path === "daily-run" ? "small" : "small ghost",
      textContent: label,
      onclick: () => run(path, label)
    })
  );
  // 分解与首领支持 dryRun,给个只预览的入口,免得手滑把装备分解掉
  actionButtons.push(
    el("button", {
      className: "small ghost",
      textContent: "分解预览",
      onclick: () => run("inventory/decompose", "分解预览", { dryRun: true })
    }),
    el("button", {
      className: "small ghost",
      textContent: "首领预览",
      onclick: () => run("boss/map", "首领预览", { dryRun: true })
    })
  );

  const rulesBox = el("textarea", { value: JSON.stringify(acc.rules ?? {}, null, 2), spellcheck: false });
  const saveRules = el("button", {
    className: "small",
    textContent: "保存规则",
    onclick: async () => {
      let parsed;
      try {
        parsed = JSON.parse(rulesBox.value || "{}");
      } catch {
        toast("规则不是合法 JSON", true);
        return;
      }
      const done = await guarded(() =>
        api("PUT", `/accounts/${encodeURIComponent(acc.label)}/rules`, { body: { rules: parsed } })
      );
      if (done !== undefined) toast("规则已保存");
    }
  });

  const enabled = acc.enabled !== false;
  const toggle = el("button", {
    className: "small ghost",
    textContent: enabled ? "停用" : "启用",
    onclick: async () => {
      const done = await guarded(() =>
        api("POST", `/accounts/${encodeURIComponent(acc.label)}/${enabled ? "disable" : "enable"}`, { body: {} })
      );
      if (done !== undefined) refreshAll();
    }
  });

  const verify = el("button", {
    className: "small ghost",
    textContent: "验证登录",
    onclick: async () => {
      out.hidden = false;
      out.textContent = "正在向游戏服务端登录…";
      const data = await guarded(() => api("POST", `/accounts/${encodeURIComponent(acc.label)}/verify`, { body: {} }));
      if (data !== undefined) out.textContent = `验证结果\n${JSON.stringify(data, null, 2)}`;
    }
  });

  const del = el("button", {
    className: "small warn-btn",
    textContent: "删除",
    onclick: async () => {
      if (!confirm(`确认删除账号「${acc.label}」?凭据与执行记录一并移除,不可恢复。`)) return;
      const done = await guarded(() =>
        api("DELETE", `/accounts/${encodeURIComponent(acc.label)}`, { body: { confirm: true } })
      );
      if (done !== undefined) {
        toast("账号已删除");
        refreshAll();
      }
    }
  });

  const meta = [
    acc.gameAccountId ? `游戏 ID ${acc.gameAccountId}` : null,
    acc.lastSuccessAt ? `上次成功 ${new Date(acc.lastSuccessAt).toLocaleString("zh-CN")}` : "还没成功执行过",
    acc.pausedReason ? `停用原因:${acc.pausedReason}` : null,
    acc.lastError ? `上次错误:${acc.lastError}` : null
  ]
    .filter(Boolean)
    .join(" · ");

  return el(
    "div",
    { className: "account" },
    el(
      "div",
      { className: "account-head" },
      el(
        "div",
        { className: "account-title" },
        el("span", { className: "account-name", textContent: acc.label }),
        el("span", { className: `badge ${enabled ? "on" : "off"}`, textContent: enabled ? "启用" : "停用" })
      ),
      el("div", { className: "row" }, verify, toggle, del)
    ),
    el("p", { className: "meta", textContent: meta }),
    el("div", { className: "row actions" }, actionButtons),
    el(
      "details",
      { className: "rules" },
      el("summary", { textContent: "规则(留空的键沿用全局默认)" }),
      el("div", {}, rulesBox, saveRules)
    ),
    out
  );
}

async function loadAccounts() {
  const list = await guarded(() => api("GET", "/accounts"));
  if (list === undefined) return;
  accountsCache = list;
  const box = $("accounts-list");
  box.textContent = "";
  if (!list.length) {
    box.append(el("p", { className: "hint", textContent: "还没有账号。点右上「新增账号」添加。" }));
  } else {
    for (const acc of list) box.append(accountCard(acc));
  }
  const sel = $("gp-account");
  sel.textContent = "";
  for (const acc of list) sel.append(el("option", { value: acc.label, textContent: acc.label }));
}

$("add-account").addEventListener("click", () => {
  const form = $("new-account");
  form.hidden = !form.hidden;
  if (!form.hidden) $("na-label").focus();
});

$("na-cancel").addEventListener("click", () => {
  $("new-account").hidden = true;
  $("new-account").reset();
});

$("new-account").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = {
    label: $("na-label").value.trim(),
    gameUsername: $("na-username").value,
    password: $("na-password").value
  };
  const done = await guarded(() => api("POST", "/accounts", { body }));
  if (done !== undefined) {
    $("new-account").reset();
    $("new-account").hidden = true;
    toast("账号已添加。建议点「验证登录」确认凭据可用。");
    refreshAll();
  }
});

// ---- 任务记录 ----

async function loadTasks() {
  const data = await guarded(() => api("GET", "/tasks"));
  if (data === undefined) return;
  const s = data.scheduler ?? {};
  $("sched-status").textContent = s.enabled
    ? `排程运行中(时区 ${s.timezone})· ${s.running ? "本轮执行中" : "空闲"} · 上次轮询 ${
        s.lastTickAt ? new Date(s.lastTickAt).toLocaleString("zh-CN") : "尚未轮询"
      }`
    : "排程已关闭,只能手动触发。";

  // recentRuns 回的是 job_runs 原始行,只有 account_id,得靠账号列表换成标签
  const labels = new Map(accountsCache.map((a) => [a.id, a.label]));
  const box = $("tasks-list");
  box.textContent = "";
  const runs = data.recent ?? [];
  if (!runs.length) {
    box.append(el("p", { className: "hint", textContent: "还没有执行记录。" }));
    return;
  }

  const rows = runs.map((r) =>
    el(
      "tr",
      {},
      el("td", { textContent: labels.get(r.account_id) ?? r.account_id }),
      el("td", { textContent: r.job_key }),
      el("td", {
        className: r.status === "ok" ? "status-ok" : r.status === "error" ? "status-bad" : "",
        textContent: r.status
      }),
      el("td", { textContent: new Date(r.started_at).toLocaleString("zh-CN") }),
      el("td", { textContent: r.error ?? "" })
    )
  );

  box.append(
    el(
      "table",
      {},
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          ...["账号", "任务", "状态", "开始时间", "错误"].map((h) => el("th", { textContent: h }))
        )
      ),
      el("tbody", {}, rows)
    )
  );
}

$("refresh-tasks").addEventListener("click", loadTasks);

$("tick").addEventListener("click", async (e) => {
  e.target.disabled = true;
  const data = await guarded(() => api("POST", "/scheduler/tick", { body: {} }));
  e.target.disabled = false;
  if (data !== undefined) {
    toast(data.skipped ? "上一轮还在执行,已跳过" : `本轮触发 ${data.ran?.length ?? 0} 个任务`);
    loadTasks();
  }
});

// ---- 设置 ----

$("form-webpw").addEventListener("submit", async (e) => {
  e.preventDefault();
  const next = $("wp-new").value;
  if (next !== $("wp-confirm").value) {
    toast("两次输入的新密码不一致", true);
    return;
  }
  const done = await guarded(() =>
    api("POST", "/api/web/password", {
      body: { currentPassword: $("wp-current").value, newPassword: next }
    })
  );
  if (done !== undefined) {
    e.target.reset();
    toast("密码已修改,其他设备的登录状态已作废");
  }
});

$("form-gamepw").addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = $("gp-account").value;
  if (!label) {
    toast("还没有账号可改", true);
    return;
  }
  const done = await guarded(() =>
    api("POST", `/accounts/${encodeURIComponent(label)}/credentials`, {
      body: { password: $("gp-password").value }
    })
  );
  if (done !== undefined) {
    $("gp-password").value = "";
    toast(`「${label}」凭据已更新,旧游戏会话已作废`);
    refreshAll();
  }
});

$("form-token").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!confirm("轮换后旧令牌立即失效,所有还在用旧令牌的 agent 会开始报 401。确认继续?")) return;
  const custom = $("tk-value").value.trim();
  const data = await guarded(() =>
    api("POST", "/api/web/api-token", {
      body: { currentPassword: $("tk-current").value, token: custom || undefined }
    })
  );
  if (data === undefined) return;
  $("tk-current").value = "";
  $("tk-value").value = "";
  $("tk-out").textContent = data.token;
  $("tk-result").hidden = false;
  toast(data.warning, true);
  refreshAll(); // 令牌来源 env→db,徽标要跟着变
});

// ---- 启动 ----

async function refreshAll() {
  const ready = await guarded(() => api("GET", "/health/ready"));
  if (ready !== undefined) {
    const badge = $("ready-badge");
    badge.textContent = `v${ready.version} · ${ready.enabledAccounts}/${ready.accounts} 启用 · 令牌来源 ${
      ready.apiTokenSource === "db" ? "数据库" : ".env"
    }`;
    badge.className = "badge on";
  }
  await loadAccounts();
}

async function boot() {
  try {
    const s = await api("GET", "/api/web/session");
    if (s.authenticated) {
      csrfToken = s.csrfToken;
      $("gate").hidden = true;
      $("app").hidden = false;
      await refreshAll();
    } else {
      showGate(s.needsSetup);
    }
  } catch (err) {
    // 连不上后端时也得给个界面,否则页面一片空白无从判断
    showGate(false);
    $("gate-error").textContent = `无法读取服务状态:${err.message}`;
  }
}

boot();

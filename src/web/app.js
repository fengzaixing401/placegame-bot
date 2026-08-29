"use strict";

// 零依赖前端。所有写操作带 X-CSRF-Token(会话 cookie 是 HttpOnly,JS 读不到,
// 靠这个头证明请求来自本页而非第三方站点诱导)。
let csrfToken = null;
let accountsCache = [];

const $ = (id) => document.getElementById(id);
// 跳过 undefined:min/max 这类属性被赋成 undefined 会反射出字面量 "undefined",污染校验
const el = (tag, props = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined) node[k] = v;
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

// ---- 规则表单 ----
// 每个字段构造器都返回 {node, read},保存时只需遍历 read 收值,不必二次遍历 DOM。
// 数组整体替换,与后端 deepMerge 的语义一致。

let defaultRules = {};

function mergeRules(base, over) {
  if (over === undefined) return base;
  if (over === null || typeof over !== "object" || Array.isArray(over)) return over;
  const out = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const k of Object.keys(over)) out[k] = mergeRules(out[k], over[k]);
  return out;
}

function field(labelText, control, hint) {
  return el("label", { className: "field" }, el("span", { textContent: labelText }), control, ...(hint ? [el("span", { className: "hint", textContent: hint })] : []));
}

function fBool(labelText, value, hint) {
  const box = el("input", { type: "checkbox", checked: value === true });
  const node = el(
    "label",
    { className: "field check" },
    box,
    el("span", { textContent: labelText }),
    ...(hint ? [el("span", { className: "hint", textContent: hint })] : [])
  );
  return { node, read: () => box.checked };
}

function fNum(labelText, value, { min, max, step, hint } = {}) {
  const input = el("input", { type: "number", value: value ?? "", min, max, step });
  return {
    node: field(labelText, input, hint),
    read: () => {
      const n = Number(input.value);
      return Number.isFinite(n) ? n : null;
    }
  };
}

function fText(labelText, value, { hint, placeholder } = {}) {
  const input = el("input", { type: "text", value: value ?? "", placeholder, spellcheck: false });
  return { node: field(labelText, input, hint), read: () => input.value.trim() };
}

function fTime(labelText, value, hint) {
  const input = el("input", { type: "time", value: value ?? "" });
  // 空时间不是取值,返回 null 让 section 丢掉这个键、走后端默认
  return { node: field(labelText, input, hint), read: () => input.value || null };
}

function fSelect(labelText, value, options, hint) {
  const sel = el("select", {});
  for (const o of options) {
    const [v, text] = Array.isArray(o) ? o : [o, o];
    sel.append(el("option", { value: v, textContent: text, selected: v === value }));
  }
  return { node: field(labelText, sel, hint), read: () => sel.value };
}

// 难度:服务端给了枚举就用下拉,没给就用文本框并说明只有 normal 可信。
// 不猜取值 —— 静态来源里查不到难度枚举。
function fDifficulty(value, difficulties) {
  if (Array.isArray(difficulties) && difficulties.length > 0) {
    const opts = difficulties.includes(value) ? difficulties : [value, ...difficulties].filter(Boolean);
    return fSelect("难度", value, opts, "取自游戏返回的可选难度");
  }
  return fText("难度", value || "normal", {
    hint: "游戏未返回可选难度列表,已确认可用的只有 normal。填别的值有被服务端拒绝的风险。"
  });
}

// 首领多选。allowAll=true 时提供"全部可挑战的"开关(空数组语义);
// 个人首领没有这个开关 —— 空数组就是不打,这是刻意的。
function fBossList(labelText, value, rows, { allowAll = false, hint } = {}) {
  const kept = (value ?? []).map(String);
  const selected = new Set(kept);
  const boxes = [];
  const list = el("div", { className: "checklist" });

  if (rows.length === 0) {
    list.append(
      el("p", {
        className: "hint",
        textContent: kept.length
          ? `没读到首领列表,保存时原样保留已存的 ${kept.length} 项:${kept.join("、")}。要改请展开「高级(JSON)」。`
          : "没读到首领列表,可展开「高级(JSON)」手填。"
      })
    );
  }
  for (const r of rows) {
    const key = String(r.bossKey ?? r.name ?? "");
    if (!key) continue;
    const box = el("input", { type: "checkbox", checked: selected.has(key) || selected.has(String(r.name)) });
    boxes.push([box, key]);
    const state = r.blockedReason ? `不可挑战:${r.blockedReason}` : "可挑战";
    list.append(
      el(
        "label",
        { className: "check-row" },
        box,
        el("span", { className: "check-name", textContent: r.name ?? key }),
        el("span", { className: "hint", textContent: `${key} · ${state}` })
      )
    );
  }

  const wrap = el("div", { className: "subfield" }, el("span", { className: "sub-title", textContent: labelText }));
  let allBox = null;
  if (allowAll) {
    allBox = el("input", { type: "checkbox", checked: selected.size === 0 });
    const toggle = () => {
      list.hidden = allBox.checked;
    };
    allBox.addEventListener("change", toggle);
    wrap.append(el("label", { className: "check-row" }, allBox, el("span", { textContent: "全部可挑战的都打" })));
    toggle();
  }
  if (hint) wrap.append(el("p", { className: "hint", textContent: hint }));
  wrap.append(list);

  return {
    node: wrap,
    // 列表没渲染出来时(取选项失败)一个框都没有,照常读就会把已存的选择清空。
    // 对 mapBosses 更糟:空数组等于"全部可挑战的都打",等于把精选名单换成无脑全打。
    read: () => {
      if (allBox?.checked) return [];
      if (rows.length === 0) return kept;
      return boxes.filter(([b]) => b.checked).map(([, k]) => k);
    }
  };
}

// 可增删的行组。renderRow 返回 {node, read},read 回 null 表示这行留空、丢弃。
function fRows(labelText, initial, renderRow, { hint, addText = "添加一行" } = {}) {
  const body = el("div", { className: "rows" });
  const readers = [];

  const addRow = (init) => {
    const row = renderRow(init);
    const del = el("button", {
      type: "button",
      className: "small ghost",
      textContent: "移除",
      onclick: () => {
        row.dead = true;
        line.remove();
      }
    });
    const line = el("div", { className: "row-line" }, row.node, del);
    readers.push(row);
    body.append(line);
  };

  for (const init of initial) addRow(init);

  const node = el(
    "div",
    { className: "subfield" },
    el("span", { className: "sub-title", textContent: labelText }),
    ...(hint ? [el("p", { className: "hint", textContent: hint })] : []),
    body,
    el("button", { type: "button", className: "small ghost", textContent: addText, onclick: () => addRow(undefined) })
  );

  return {
    node,
    read: () => readers.filter((r) => !r.dead).map((r) => r.read()).filter((v) => v !== null)
  };
}

// fields: [[键, 字段对象], ...] —— 读回时组装成该分区的规则对象。
// read() 回 null 的字段(数字/时间框被清空)整个键都不写:存 null 会盖掉后端默认值,
// 比如 minWinChance 存成 null 会让胜率闸门静默失效。
function section(title, fields) {
  const node = el(
    "fieldset",
    { className: "rule-section" },
    el("legend", { textContent: title }),
    ...fields.map(([, f]) => f.node)
  );
  return {
    node,
    read: () => {
      const out = {};
      for (const [key, f] of fields) {
        const v = f.read();
        if (v !== null) out[key] = v;
      }
      return out;
    }
  };
}

function itemRow(init, { placeholder, items }) {
  // 有背包数据就下拉选,没有就退回文本框手填 key
  let keyCtl;
  const known = Array.isArray(items) && items.length > 0;
  if (known) {
    keyCtl = el("select", {});
    keyCtl.append(el("option", { value: "", textContent: "— 选择物品 —" }));
    for (const it of items) {
      const text = it.amount === null ? `${it.name ?? it.itemKey}` : `${it.name ?? it.itemKey}(持有 ${it.amount})`;
      keyCtl.append(el("option", { value: it.itemKey, textContent: text, selected: it.itemKey === init?.itemKey }));
    }
    if (init?.itemKey && !items.some((i) => i.itemKey === init.itemKey)) {
      keyCtl.append(el("option", { value: init.itemKey, textContent: `${init.itemKey}(不在背包)`, selected: true }));
    }
  } else {
    keyCtl = el("input", { type: "text", value: init?.itemKey ?? "", placeholder, spellcheck: false });
  }
  const amount = el("input", { type: "number", className: "narrow", value: init?.amount ?? 1, min: 1, step: 1 });
  return {
    node: el("div", { className: "row inline" }, keyCtl, el("span", { className: "hint", textContent: "数量" }), amount),
    read: () => {
      const itemKey = (known ? keyCtl.value : keyCtl.value.trim());
      if (!itemKey) return null;
      const n = Number(amount.value);
      return { itemKey, amount: Number.isInteger(n) && n > 0 ? n : 1 };
    }
  };
}

function rulesForm(r, opts) {
  const bosses = opts?.bosses ?? [];
  const mapRows = bosses.filter((b) => b.type === "map");
  const personalRows = bosses.filter((b) => b.type === "personal");
  const items = opts?.donatableItems ?? [];
  const free = opts?.freeAttemptsLeft;

  const sections = [
    section("挂机收益", [
      ["enabled", fBool("启用", r.collect?.enabled)],
      ["intervalHours", fNum("间隔(小时)", r.collect?.intervalHours, { min: 1, max: 24, hint: "收益上限 12 小时,建议 11" })]
    ]),
    section("背包分解", [
      ["enabled", fBool("启用", r.inventory?.enabled)],
      [
        "mode",
        fSelect("模式", r.inventory?.mode, [["auto", "auto — 用游戏自带的自动分解规则"], ["explicit", "explicit — 按本地条件挑选"]], "auto 最安全,不会误拆")
      ],
      ["intervalHours", fNum("间隔(小时)", r.inventory?.intervalHours, { min: 1, max: 24 })]
    ]),
    section("副职", [
      ["enabled", fBool("启用", r.profession?.enabled)],
      ["professionKey", fSelect("副职", r.profession?.professionKey, [["", "不切换"], ...(opts?.professions ?? [])], "留「不切换」则沿用游戏内当前副职")],
      ["intervalHours", fNum("间隔(小时)", r.profession?.intervalHours, { min: 1, max: 24 })]
    ]),
    section("公会", [
      ["enabled", fBool("启用", r.guild?.enabled)],
      ["claimDividend", fBool("领公会分红", r.guild?.claimDividend, "游戏要求当日先完成捐献才能领,下面不配捐献就领不到")],
      [
        "donate",
        fRows("捐献", r.guild?.donate ?? [], (init) => itemRow(init, { placeholder: "物品 key", items }), {
          hint: "按物品选,运行时自动换成背包里的实例 ID",
          addText: "添加捐献物品"
        })
      ],
      [
        "redeem",
        fRows("兑换", r.guild?.redeem ?? [], (init) => itemRow(init, { placeholder: "商店物品 key" }), {
          hint: "公会商店的物品 key,与捐献不是同一套",
          addText: "添加兑换物品"
        })
      ],
      ["intervalHours", fNum("间隔(小时)", r.guild?.intervalHours, { min: 1, max: 48 })]
    ]),
    section("首领", [
      ["enabled", fBool("启用", r.boss?.enabled)],
      ["difficulty", fDifficulty(r.boss?.difficulty, opts?.difficulties)],
      ["mapBosses", fBossList("地图首领", r.boss?.mapBosses, mapRows, { allowAll: true })],
      [
        "challengePersonal",
        fBool("挑战个人首领", r.boss?.challengePersonal, "关闭时完全不碰个人首领。开启后仍只打下面勾选的")
      ],
      [
        "personalBosses",
        fBossList("个人首领", r.boss?.personalBosses, personalRows, {
          hint: "一个都不勾就一个都不打" + (typeof free === "number" ? `。当前剩余免费次数 ${free}` : "")
        })
      ],
      [
        "useTickets",
        fBool("允许消耗首领门票", r.boss?.useTickets, "接口没有门票开关,免费次数用尽后服务端会自动扣票。关闭时本程序在免费次数用尽后就不再挑战")
      ],
      [
        "requirePredictedWin",
        fBool("只在预测会赢时挑战", r.boss?.requirePredictedWin, "挑战前先调预览,预测会输就跳过")
      ],
      ["minWinChance", fNum("最低胜率(%)", r.boss?.minWinChance, { min: 0, max: 100, hint: "0 = 不看胜率。预览拿不到胜率时按不达标跳过" })],
      ["maxChallengesPerRun", fNum("每轮最多挑战次数", r.boss?.maxChallengesPerRun, { min: 1, max: 50 })],
      ["mapIntervalHours", fNum("地图首领间隔(小时)", r.boss?.mapIntervalHours, { min: 1, max: 24 })],
      [
        "worldWindows",
        fRows(
          "世界首领时间窗(北京时间)",
          r.boss?.worldWindows ?? [],
          (init) => {
            const start = el("input", { type: "time", value: init?.start ?? "" });
            const end = el("input", { type: "time", value: init?.end ?? "" });
            return {
              node: el("div", { className: "row inline" }, start, el("span", { className: "hint", textContent: "至" }), end),
              read: () => (start.value && end.value ? { start: start.value, end: end.value } : null)
            };
          },
          { addText: "添加时间窗" }
        )
      ]
    ]),
    section("活动奖励", [
      ["enabled", fBool("启用", r.activity?.enabled)],
      ["quests", fBool("任务", r.activity?.quests)],
      ["achievements", fBool("成就", r.activity?.achievements)],
      ["daily", fBool("每日", r.activity?.daily)],
      ["signIn", fBool("签到", r.activity?.signIn)],
      ["mail", fBool("邮件", r.activity?.mail)],
      ["dailyAt", fTime("每天领取时刻", r.activity?.dailyAt, "服务时区 Asia/Shanghai")]
    ])
  ];

  const keys = ["collect", "inventory", "profession", "guild", "boss", "activity"];
  return {
    node: el("div", { className: "rule-form" }, ...sections.map((s) => s.node)),
    read: () => {
      const out = {};
      sections.forEach((s, i) => {
        out[keys[i]] = s.read();
      });
      return out;
    }
  };
}

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

  // 规则设置。展开时才去游戏取首领/背包列表 —— 那要真登录,不该在列表渲染时就打。
  const effective = mergeRules(structuredClone(defaultRules), acc.rules ?? undefined);
  const rulesHost = el("div", { className: "rule-host" }, el("p", { className: "hint", textContent: "展开后从游戏读取首领与背包列表…" }));
  const rulesFooter = el("div", { className: "row" });
  let loaded = false;

  const advanced = el("textarea", { value: JSON.stringify(acc.rules ?? {}, null, 2), spellcheck: false });
  const advancedBox = el(
    "details",
    { className: "advanced" },
    el("summary", { textContent: "高级:直接编辑 JSON" }),
    el("p", { className: "hint", textContent: "只有上面表单覆盖不到的字段才需要动这里。保存时会与表单结果深合并,表单优先。" }),
    advanced
  );

  const buildRulesForm = async () => {
    if (loaded) return;
    loaded = true;
    const opts = await guarded(() => api("GET", `/accounts/${encodeURIComponent(acc.label)}/options`));
    // 取不到就用空选项渲染:表单仍可用,首领只能靠高级 JSON 填
    const form = rulesForm(effective, opts ?? {});
    rulesHost.textContent = "";
    if (!opts) {
      rulesHost.append(
        el("p", { className: "warn", textContent: "没能从游戏读取可选项,首领与物品需在「高级」里手填。" })
      );
    } else if (opts.errors?.length) {
      rulesHost.append(el("p", { className: "warn", textContent: `部分选项读取失败:${opts.errors.join("; ")}` }));
    }
    rulesHost.append(form.node, advancedBox);

    rulesFooter.textContent = "";
    rulesFooter.append(
      el("button", {
        className: "small",
        textContent: "保存规则",
        onclick: async () => {
          let extra = {};
          try {
            extra = JSON.parse(advanced.value || "{}");
          } catch {
            toast("「高级」里的 JSON 不合法,请修正后再保存", true);
            return;
          }
          const rules = mergeRules(extra, form.read());
          const done = await guarded(() =>
            api("PUT", `/accounts/${encodeURIComponent(acc.label)}/rules`, { body: { rules } })
          );
          if (done !== undefined) toast("规则已保存,下一轮排程生效");
        }
      })
    );
  };

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
    (() => {
      const box = el(
        "details",
        { className: "rules" },
        el("summary", { textContent: "规则设置" }),
        el("div", {}, rulesHost, rulesFooter)
      );
      box.addEventListener("toggle", () => {
        if (box.open) buildRulesForm();
      });
      return box;
    })(),
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
  // 先拿全局默认,账号卡片要用它算出"实际生效值"
  const defs = await guarded(() => api("GET", "/config/default-rules"));
  if (defs !== undefined) defaultRules = defs;

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

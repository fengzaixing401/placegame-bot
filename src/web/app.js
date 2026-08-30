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
    ? "还没有 WebUI 密码。用 .env 里的 PLACEGAME_API_TOKEN 验证身份,并设置一个登录密码。"
    : "";
  $("gate-token-row").hidden = !setup;
  $("gate-confirm-row").hidden = !setup;
  $("gate-token").required = setup;
  $("gate-confirm").required = setup;
  $("gate-pw-label").textContent = setup ? "设置密码" : "密码";
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
      if (!password) throw new Error("密码不能为空");
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

// 操作清单。点按钮只展开面板,不发请求 —— 执行一律要面板里那颗「确定执行」。
// panel 为空表示该操作没有可调参数,面板里只有一句说明和确认按钮。
// preview: 该操作支持 dryRun,面板里给一颗「只预览」。
// job 是日志渲染器的键,与排程任务、任务记录里的键同名,渲染逻辑只此一份。
const ACTIONS = [
  { path: "collect", job: "collect", label: "收挂机收益", panel: null, note: "把挂机攒下的经验金币收进账。有冒险事件会顺手选第一个选项。" },
  { path: "inventory/decompose", job: "inventory", label: "背包分解", panel: "inventory", preview: true },
  { path: "profession/settle", job: "profession", label: "副职结算", panel: "profession" },
  { path: "guild/daily", job: "guild", label: "公会日常", panel: "guild" },
  { path: "boss/personal", job: "boss.personal", label: "个人首领", panel: "bossPersonal", preview: true },
  { path: "boss/map", job: "boss.map", label: "地图首领", panel: "bossMap", preview: true },
  { path: "boss/world", job: "boss.world", label: "世界首领", panel: "bossWorld" },
  { path: "activity/claim-all", job: "activity", label: "领活动奖励", panel: "activity" },
  {
    path: "daily-run",
    job: "dailyRun",
    label: "一键全部日常",
    panel: null,
    note: "按已保存的规则依次执行:收益、分解、副职、公会、地图首领、活动奖励。个人首领要在它自己的面板里勾上「加入自动排程」才会跟着跑。用的是保存过的规则,不是上面各面板里的临时改动。"
  }
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

// 空输入读作 null(未设置),不是 Number("")===0。写成 0 会把"不限制"变成"上限 0":
// 分解的收紧条件校验只看 typeof === "number",0 能骗过校验,却又筛不中任何一件,
// 存进规则后排程就永久静默拆不动东西。
// required 的字段(间隔、次数)不允许没有值,清空时兜回渲染时的原值。
function fNum(labelText, value, { min, max, step, hint, required = false } = {}) {
  const input = el("input", { type: "number", value: value ?? "", min, max, step });
  const fallback = () => (required ? value ?? null : null);
  return {
    node: field(labelText, input, hint),
    read: () => {
      if (input.value.trim() === "") return fallback();
      const n = Number(input.value);
      return Number.isFinite(n) ? n : fallback();
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
// difficulties 是 [{key,name}],name 是服务端自带的中文名(普通/困难/噩梦),显示中文存 key。
// onChange 用于让首领列表跟着换档重算胜率与消耗 —— 那些数字是逐档不同的。
function fDifficulty(labelText, value, difficulties, { onChange, hint } = {}) {
  const rows = Array.isArray(difficulties) ? difficulties : [];
  if (rows.length > 0) {
    const opts = rows.map((d) => [d.key, d.name ?? d.key]);
    // 已存的取值不在服务端枚举里也要留着,否则一渲染就把用户的设置改掉了
    if (value && !rows.some((d) => d.key === value)) opts.unshift([value, `${value}(游戏未返回此档)`]);
    const f = fSelect(labelText, value, opts, hint ?? "与游戏内难度选择界面一致");
    if (onChange) f.node.querySelector("select").addEventListener("change", onChange);
    return f;
  }
  return fText(labelText, value || "normal", {
    hint: "游戏未返回可选难度列表,已确认可用的只有 normal。填别的值有被服务端拒绝的风险。"
  });
}

// 首领行的说明文字。逐档不同的东西(胜率、门票、材料)必须按当前选档算,
// 否则页面显示普通档的 0 张门票,实跑困难档却扣 2 张。
function bossRowHint(r, difficulty) {
  const bits = [];
  if (r.mapName) bits.push(r.mapName);
  if (typeof r.requiredLevel === "number") bits.push(`需 ${r.requiredLevel} 级`);
  const d = (r.difficulties ?? []).find((x) => x.key === difficulty);
  if (d) {
    if (typeof d.chance === "number") bits.push(`胜率 ${d.chance}%`);
    if (typeof d.ticketCost === "number") bits.push(d.ticketCost > 0 ? `扣 ${d.ticketCost} 张门票` : "不扣门票");
    if (d.materialName && typeof d.materialCost === "number" && d.materialCost > 0) {
      const owned = typeof d.ownedMaterial === "number" ? `,有 ${d.ownedMaterial}` : "";
      bits.push(`${d.materialName} ${d.materialCost}${owned}`);
    }
    if (d.blockedReason) bits.push(`本档不可打:${d.blockedReason}`);
  }
  if (r.attemptPool) {
    const p = r.attemptPool;
    if (typeof p.freeRemaining === "number") bits.push(`免费 ${p.freeRemaining}/${p.freeLimit ?? "?"}`);
  }
  if (r.blockedReason) bits.push(`不可挑战:${r.blockedReason}`);
  return bits.join(" · ");
}

// 首领多选。allowAll=true 时提供"全部可挑战的"开关(空数组语义);
// 个人首领没有这个开关 —— 空数组就是不打,这是刻意的。
// describe 给每行算说明文字;换难度后调 refresh() 重算,不必重建整个面板。
// 首领多选。allowAll=true 时提供"全部可挑战的"开关(空数组语义);
// 个人首领没有这个开关 —— 空数组就是不打,这是刻意的。
// describe 逐行生成说明文字,配合 refresh() 让换难度后的胜率/消耗跟着重算。
function fBossList(labelText, value, rows, { allowAll = false, hint, describe } = {}) {
  const kept = (value ?? []).map(String);
  const selected = new Set(kept);
  const boxes = [];
  const notes = [];
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
    const note = el("span", { className: "hint", textContent: describe ? describe(r) : key });
    notes.push([note, r]);
    list.append(
      el(
        "label",
        { className: "check-row" },
        box,
        el("span", { className: "check-name", textContent: r.name ?? key }),
        note
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
    refresh: () => {
      if (!describe) return;
      for (const [note, r] of notes) note.textContent = describe(r);
    },
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

// amountWord:数量那个数是谁的存量。捐献看自己背包(持有),兑换看公会仓库(库存),
// 两者都叫"持有"会让人以为兑换也受自己背包限制。
// missingWord:已存的 key 不在清单里时怎么说 —— 说错了会让人以为物品丢了。
function itemRow(init, { placeholder, items, amountWord = "持有", missingWord = "不在背包" }) {
  // 有清单就下拉选,没有就退回文本框手填 key
  let keyCtl;
  const known = Array.isArray(items) && items.length > 0;
  if (known) {
    keyCtl = el("select", {});
    keyCtl.append(el("option", { value: "", textContent: "— 选择物品 —" }));
    for (const it of items) {
      // 品质显示游戏内档位名(普通/优秀/…),清单没给品质就不显示
      const marks = [];
      if (it.quality) marks.push(PGL.quality(it.quality));
      if (it.amount !== null && it.amount !== undefined) marks.push(`${amountWord} ${it.amount}`);
      const base = it.name ?? it.itemKey;
      keyCtl.append(el("option", {
        value: it.itemKey,
        textContent: marks.length ? `${base}(${marks.join(" · ")})` : base,
        selected: it.itemKey === init?.itemKey
      }));
    }
    if (init?.itemKey && !items.some((i) => i.itemKey === init.itemKey)) {
      keyCtl.append(el("option", { value: init.itemKey, textContent: `${init.itemKey}(${missingWord})`, selected: true }));
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

// 品质多选。显示游戏内的中文档位名,存进规则的仍是服务端认的内部值(white/green/…)。
// 映射表只有 src/labels.mjs 一份,经 /labels.js 挂到 window.PGLabels。
function fQualities(value, qualities) {
  const selected = new Set((value ?? []).map(String));
  const boxes = [];
  const list = el("div", { className: "checklist" });
  const rows = PGL.sortQualities(Array.isArray(qualities) ? qualities : [], (q) => String(q.quality));
  if (!rows.length) {
    // 没读到背包就退回文本框,不编枚举
    const input = el("input", {
      type: "text",
      value: [...selected].join(","),
      placeholder: "如 green,blue",
      spellcheck: false
    });
    return {
      node: field("可分解品质", input, "没读到背包,只能手填游戏内部取值,逗号分隔。留空 = 不按品质筛"),
      read: () => input.value.split(",").map((s) => s.trim()).filter(Boolean)
    };
  }
  for (const q of rows) {
    const key = String(q.quality);
    const box = el("input", { type: "checkbox", checked: selected.has(key) });
    boxes.push([box, key]);
    list.append(
      el(
        "label",
        { className: "check-item" },
        box,
        el("span", { textContent: `${PGL.quality(key)}(${q.count} 件)` })
      )
    );
  }
  return {
    node: field("可分解品质", list, "档位名与游戏内一致,件数取自当前背包。留空 = 不按品质筛"),
    read: () => boxes.filter(([b]) => b.checked).map(([, v]) => v)
  };
}

// 保留属性多选。属性名同样取自真实背包,不写死那 20 个词条。
function fAttrs(value, attrKeys) {
  const selected = new Set((value ?? []).map(String));
  const rows = Array.isArray(attrKeys) ? attrKeys : [];
  if (!rows.length) {
    const input = el("input", {
      type: "text",
      value: [...selected].join(","),
      placeholder: "如 attack,critical",
      spellcheck: false
    });
    return {
      node: field("命中这些属性时保留", input, "没读到背包,手填属性名,逗号分隔"),
      read: () => input.value.split(",").map((s) => s.trim()).filter(Boolean)
    };
  }
  const boxes = [];
  const list = el("div", { className: "checklist wrap" });
  for (const k of rows) {
    const box = el("input", { type: "checkbox", checked: selected.has(String(k)) });
    boxes.push([box, String(k)]);
    list.append(el("label", { className: "check-item" }, box, el("span", { textContent: String(k) })));
  }
  return {
    node: field("命中这些属性时保留", list, "属性名取自当前背包里的装备词条"),
    read: () => boxes.filter(([b]) => b.checked).map(([, v]) => v)
  };
}

// ---- 各操作的执行面板。返回 {node, read} —— read() 出的就是本次请求的 args ----
// 面板里的改动只作用于本次执行,不落库;要长期生效得点「存为规则」。

function panelInventory(r, opts) {
  const c = r.inventory?.conditions ?? {};
  const eq = opts?.equipment ?? {};
  const mode = fSelect(
    "模式",
    r.inventory?.mode,
    [["auto", "auto — 用游戏自带的自动分解规则"], ["explicit", "explicit — 按下面条件挑选"]],
    "auto 由游戏决定拆哪些,本程序无从预览;explicit 才看下面的条件"
  );
  const maxScore = fNum("评分低于", c.maxScore, { min: 0, step: 1, hint: "留空 = 不看评分" });
  const maxLevel = fNum("装备等级不高于", c.maxLevel, { min: 0, max: 999, step: 1, hint: "留空 = 不看等级" });
  const qualities = fQualities(c.qualities, eq.qualities);
  const keepRare = fBool("保留极品词条", c.keepRareRank !== false, "带极品词条的一律不拆");
  const keepAttrs = fAttrs(c.keepAttrs, eq.attrKeys);

  const fields = [mode, maxScore, maxLevel, qualities, keepRare, keepAttrs];
  const stat =
    typeof eq.disposable === "number"
      ? `背包里可处理 ${eq.disposable} 件(共 ${eq.total} 件)。只看背包内、未锁定、未穿戴、未上架的装备。`
      : "只处理背包内、未锁定、未穿戴、未上架的装备。";

  return {
    node: el("div", { className: "op-form" }, el("p", { className: "hint", textContent: stat }), ...fields.map((f) => f.node)),
    read: () => {
      const conditions = { keepRareRank: keepRare.read() };
      const s = maxScore.read();
      const lv = maxLevel.read();
      if (s !== null) conditions.maxScore = s;
      if (lv !== null) conditions.maxLevel = lv;
      conditions.qualities = qualities.read();
      conditions.keepAttrs = keepAttrs.read();
      return { mode: mode.read(), conditions };
    },
    // explicit 模式下一个收紧条件都没有,后端会拒;提前说清楚,别让人对着报错猜
    validate: () => {
      if (mode.read() !== "explicit") return null;
      const c2 = { maxScore: maxScore.read(), maxLevel: maxLevel.read(), qualities: qualities.read() };
      const narrowed = c2.maxScore !== null || c2.maxLevel !== null || c2.qualities.length > 0;
      return narrowed ? null : "explicit 模式至少要设一个收紧条件(评分、等级或品质),否则会拆光整个背包,后端会直接拒绝。";
    },
    // 存为规则时写回 inventory 分区
    toRules: () => ({ inventory: { mode: mode.read(), conditions: readConditions() } })
  };

  function readConditions() {
    const s = maxScore.read();
    const lv = maxLevel.read();
    return {
      maxScore: s === null ? null : s,
      maxLevel: lv === null ? null : lv,
      qualities: qualities.read(),
      keepRareRank: keepRare.read(),
      keepAttrs: keepAttrs.read()
    };
  }
}

function panelProfession(r, opts) {
  // 显示游戏内的中文副职名,存进规则的仍是服务端认的键(herbalism/…)。
  // 等级一并显示:动作有等级门槛,不看等级就不知道排的队能不能真跑起来。
  const profRows = opts?.professions ?? [];
  const current = opts?.selectedProfession ?? null;
  const profName = (key) => profRows.find((p) => p.key === key)?.name ?? key;
  const prof = fSelect(
    "副职",
    r.profession?.professionKey,
    [
      ["", current ? `不切换(当前:${profName(current)})` : "不切换"],
      ...profRows.map((p) => [p.key, p.level === null ? p.name : `${p.name}(${p.level} 级)`])
    ],
    "留「不切换」则沿用游戏内当前副职"
  );
  const actions = opts?.professionActions ?? [];
  const enqueue = fRows(
    "结算后排队",
    Object.entries(r.profession?.enqueue ?? {}).map(([actionKey, count]) => ({ actionKey, count })),
    (init) => {
      let ctl;
      if (actions.length) {
        ctl = el("select", {});
        ctl.append(el("option", { value: "", textContent: "— 选择动作 —" }));
        // 按副职分组:18 个动作平铺在一个下拉里分不清哪个属于哪个副职,
        // 选错了要等运行时 enqueue 失败才知道。未解锁的标出来但仍可选 ——
        // 是否真能排队由服务端定,页面不替它拦。
        const groups = new Map();
        for (const a of actions) {
          const g = a.professionKey ?? "";
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g).push(a);
        }
        for (const [key, rows] of groups) {
          const host = key ? el("optgroup", { label: profName(key) }) : ctl;
          for (const a of rows) {
            const marks = [];
            if (a.requiredLevel) marks.push(`${a.requiredLevel} 级`);
            if (!a.unlocked) marks.push(a.blockedReason ?? "未解锁");
            const text = marks.length ? `${a.name ?? a.key}(${marks.join(" · ")})` : a.name ?? a.key;
            host.append(el("option", { value: a.key, textContent: text, selected: a.key === init?.actionKey }));
          }
          if (host !== ctl) ctl.append(host);
        }
        if (init?.actionKey && !actions.some((a) => a.key === init.actionKey)) {
          ctl.append(el("option", { value: init.actionKey, textContent: `${init.actionKey}(不在可选列表)`, selected: true }));
        }
      } else {
        ctl = el("input", { type: "text", value: init?.actionKey ?? "", placeholder: "动作 key", spellcheck: false });
      }
      const count = el("input", { type: "number", className: "narrow", value: init?.count ?? 1, min: 1, step: 1 });
      return {
        node: el("div", { className: "row inline" }, ctl, el("span", { className: "hint", textContent: "次数" }), count),
        read: () => {
          const k = actions.length ? ctl.value : ctl.value.trim();
          if (!k) return null;
          const n = Number(count.value);
          return { actionKey: k, count: Number.isInteger(n) && n > 0 ? n : 1 };
        }
      };
    },
    { hint: "结算完继续排产的动作。不加就只结算不排队", addText: "添加动作" }
  );

  const readEnqueue = () => {
    const out = {};
    for (const row of enqueue.read()) out[row.actionKey] = row.count;
    return out;
  };

  return {
    node: el("div", { className: "op-form" }, prof.node, enqueue.node),
    read: () => ({ professionKey: prof.read(), enqueue: readEnqueue() }),
    toRules: () => ({ profession: { professionKey: prof.read(), enqueue: readEnqueue() } })
  };
}

function panelGuild(r, opts) {
  const items = opts?.donatableItems ?? [];
  // 兑换清单是公会仓库,与捐献用的背包不是一套 —— 接口收的字段也不同(见 features/guild.mjs)
  const stock = opts?.redeemableItems ?? [];
  const g = opts?.guild ?? {};
  const dividend = fBool("领公会分红", r.guild?.claimDividend, "游戏要求当日先完成捐献才能领");
  const donateHint = g.canDonate === false
    ? `现在捐不了:${g.donationBlockedReason ?? "游戏未说明原因"}`
    : "按物品选,运行时自动换成背包里的实例 ID" +
      (g.equipmentDonationMinQuality
        ? `。本公会装备捐献品质下限:${PGL.quality(g.equipmentDonationMinQuality)}`
        : "");
  const donate = fRows("捐献", r.guild?.donate ?? [], (init) => itemRow(init, { placeholder: "物品 key", items }), {
    hint: donateHint,
    addText: "添加捐献物品"
  });
  const redeem = fRows("兑换", r.guild?.redeem ?? [], (init) => itemRow(init, {
    placeholder: "仓库物品 key",
    items: stock,
    amountWord: "库存",
    missingWord: "不在公会仓库"
  }), {
    hint: "从公会仓库兑换,消耗贡献值。数量按游戏里的兑换次数算",
    addText: "添加兑换物品"
  });
  const payload = () => ({ claimDividend: dividend.read(), donate: donate.read(), redeem: redeem.read() });
  return {
    node: el("div", { className: "op-form" }, dividend.node, donate.node, redeem.node),
    read: payload,
    toRules: () => ({ guild: payload() })
  };
}

// 三类首领三个面板,各自只读写自己那几个键。
// 执行走 withOverride(浅合并到已存规则)、存规则走 mergeRules(深合并),
// 两条路都容得下只带本面板的键 —— 所以地图面板不必带 personalDifficulty,反之亦然。
//
// 门票与胜率闸门是三类共用的一组安全限制(规则树里只有一份),两个面板都能改,
// 改了对另一类也生效。hint 里写明了,免得以为是各自独立的。

function bossesOf(opts, type) {
  return opts?.bossesByType?.[type] ?? (opts?.bosses ?? []).filter((b) => b.type === type);
}

// 门票/胜率闸门。个人与地图面板各建一份控件,读写的却是同一组规则键。
function bossGates(r, { ticketHint }) {
  const useTickets = fBool("允许消耗首领门票", r.boss?.useTickets, ticketHint);
  const requireWin = fBool("只在预测会赢时挑战", r.boss?.requirePredictedWin, "挑战前先看难度档预估,过了再调一次预览确认");
  const minWin = fNum("最低胜率(%)", r.boss?.minWinChance, {
    min: 0,
    max: 100,
    hint: "0 = 不看胜率。与上面两项一样,个人首领和地图首领共用这一组设置",
    required: true
  });
  const maxRun = fNum("本次最多挑战次数", r.boss?.maxChallengesPerRun, { min: 1, max: 50, required: true });
  return {
    nodes: [useTickets.node, requireWin.node, minWin.node, maxRun.node],
    into: (out) => {
      out.useTickets = useTickets.read();
      out.requirePredictedWin = requireWin.read();
      const mw = minWin.read();
      const mx = maxRun.read();
      if (mw !== null) out.minWinChance = mw;
      if (mx !== null) out.maxChallengesPerRun = mx;
      return out;
    }
  };
}

// 个人首领:每日免费次数有限,用尽后服务端自动扣门票。安全闸门是必须点名要打哪几个。
function panelBossPersonal(r, opts) {
  const rows = bossesOf(opts, "personal");
  const free = opts?.freeAttemptsLeft;
  let list;
  const difficulty = fDifficulty("难度", r.boss?.personalDifficulty, opts?.difficulties, {
    onChange: () => list.refresh()
  });
  list = fBossList("要打哪几个", r.boss?.personalBosses, rows, {
    hint:
      "一个都不勾就一个都不打(这是刻意的:免费次数有限)" +
      (typeof free === "number" ? `。当前剩余免费次数 ${free}` : ""),
    describe: (row) => bossRowHint(row, difficulty.read())
  });
  const schedule = fBool("加入自动排程", r.boss?.challengePersonal, "只影响自动排程与「一键全部日常」;这个面板按确定执行不受它限制");
  const gates = bossGates(r, {
    ticketHint: "免费次数用尽后服务端会自动扣票;关闭则次数用尽就停手。与地图首领共用这项设置"
  });

  const payload = () =>
    gates.into({
      personalDifficulty: difficulty.read(),
      personalBosses: list.read(),
      challengePersonal: schedule.read()
    });
  return {
    node: el("div", { className: "op-form" }, difficulty.node, list.node, schedule.node, ...gates.nodes),
    // 整块覆盖:面板里取消勾选必须能生效,逐字段兜底会让取消永远无效
    read: () => ({ rules: payload() }),
    toRules: () => ({ boss: payload() })
  };
}

// 地图首领:刷新周期短,默认打列表里所有可挑战的。
function panelBossMap(r, opts) {
  const rows = bossesOf(opts, "map");
  let list;
  const difficulty = fDifficulty("难度", r.boss?.difficulty, opts?.difficulties, {
    onChange: () => list.refresh()
  });
  list = fBossList("要打哪几个", r.boss?.mapBosses, rows, {
    allowAll: true,
    describe: (row) => bossRowHint(row, difficulty.read())
  });
  const gates = bossGates(r, {
    ticketHint: "困难档扣 1 张、噩梦档扣 2 张;关闭则这两档一律跳过。与个人首领共用这项设置"
  });

  const payload = () => gates.into({ difficulty: difficulty.read(), mapBosses: list.read() });
  return {
    node: el("div", { className: "op-form" }, difficulty.node, list.node, ...gates.nodes),
    read: () => ({ rules: payload() }),
    toRules: () => ({ boss: payload() })
  };
}

// 世界首领:全服共打一个血条的场次战,只参与协作讨伐 + 领奖。
// 没有难度也没有胜率预测 —— 个人主攻会按困难/噩梦档扣门票,与"只参与协作"相反。
function panelBossWorld(r, opts) {
  const rows = bossesOf(opts, "world");
  const list = fBossList("参与哪几个", r.boss?.worldBosses, rows, {
    allowAll: true,
    describe: (row) => {
      const bits = [];
      const inst = row.instance;
      if (inst) {
        if (typeof inst.hpPercent === "number") bits.push(`剩余血量 ${inst.hpPercent}%`);
        if (typeof inst.participantCount === "number") bits.push(`${inst.participantCount} 人参与`);
        if (typeof inst.remainingAttemptCount === "number") bits.push(`本场次还可协作 ${inst.remainingAttemptCount} 次`);
      }
      if (row.assistBlockedReason) bits.push(row.assistBlockedReason);
      return bits.join(" · ") || String(row.bossKey ?? "");
    }
  });
  const payload = () => ({ worldBosses: list.read() });
  return {
    node: el(
      "div",
      { className: "op-form" },
      el("p", {
        className: "hint",
        textContent:
          "只参与协作讨伐并领奖,不主动挑战,所以没有难度和胜率设置。只在开放时间窗内能协作,时间窗在「通用设置」里配。"
      }),
      list.node
    ),
    read: () => ({ rules: payload() }),
    toRules: () => ({ boss: payload() })
  };
}

function panelActivity(r) {
  const boxes = [
    ["quests", fBool("任务奖励", r.activity?.quests)],
    ["achievements", fBool("成就奖励", r.activity?.achievements)],
    ["daily", fBool("每日活跃", r.activity?.daily)],
    ["signIn", fBool("每日签到", r.activity?.signIn)],
    ["mail", fBool("邮件", r.activity?.mail)],
    ["codex", fBool("图鉴奖励", r.activity?.codex === true)]
  ];
  const payload = () => {
    const out = {};
    for (const [k, f] of boxes) out[k] = f.read();
    return out;
  };
  return {
    node: el("div", { className: "op-form" }, ...boxes.map(([, f]) => f.node)),
    read: payload,
    toRules: () => ({ activity: payload() })
  };
}

const PANELS = {
  inventory: panelInventory,
  profession: panelProfession,
  guild: panelGuild,
  bossPersonal: panelBossPersonal,
  bossMap: panelBossMap,
  bossWorld: panelBossWorld,
  activity: panelActivity
};

// 通用设置:只留跨操作共享的东西 —— 开关、间隔、时间窗。
// 各操作自己的参数已经搬到对应面板,这里不再重复一遍。
function rulesForm(r) {
  const sections = [
    section("挂机收益", [
      ["enabled", fBool("排程执行", r.collect?.enabled)],
      ["intervalHours", fNum("间隔(小时)", r.collect?.intervalHours, { min: 1, max: 24, hint: "收益上限 12 小时,建议 11", required: true })]
    ]),
    section("背包分解", [
      ["enabled", fBool("排程执行", r.inventory?.enabled)],
      ["intervalHours", fNum("间隔(小时)", r.inventory?.intervalHours, { min: 1, max: 24, required: true })]
    ]),
    section("副职", [
      ["enabled", fBool("排程执行", r.profession?.enabled)],
      ["intervalHours", fNum("间隔(小时)", r.profession?.intervalHours, { min: 1, max: 24, required: true })]
    ]),
    section("公会", [
      ["enabled", fBool("排程执行", r.guild?.enabled)],
      ["intervalHours", fNum("间隔(小时)", r.guild?.intervalHours, { min: 1, max: 48, required: true })]
    ]),
    section("首领", [
      ["enabled", fBool("排程执行", r.boss?.enabled, "关掉则三类首领都不自动执行")],
      ["mapIntervalHours", fNum("地图首领间隔(小时)", r.boss?.mapIntervalHours, { min: 1, max: 24, required: true })],
      [
        "personalIntervalHours",
        fNum("个人首领间隔(小时)", r.boss?.personalIntervalHours, {
          min: 1,
          max: 48,
          hint: "免费次数按北京时间每日重置,填 24 即可。要不要排程在个人首领面板里勾",
          required: true
        })
      ],
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
          { addText: "添加时间窗", hint: "一个都不加就不打世界首领" }
        )
      ]
    ]),
    section("活动奖励", [
      ["enabled", fBool("排程执行", r.activity?.enabled)],
      ["dailyAt", fTime("每天领取时刻", r.activity?.dailyAt, "服务时区 Asia/Shanghai")]
    ])
  ];

  const keys = ["collect", "inventory", "profession", "guild", "boss", "activity"];
  return {
    node: el(
      "div",
      { className: "rule-form" },
      el("p", {
        className: "hint",
        textContent:
          "这里只管「排程什么时候跑」。每个操作具体打哪个首领、拆什么装备,在上面对应的操作面板里配,配好点「存为规则」即为排程所用。"
      }),
      ...sections.map((s) => s.node)
    ),
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
  // div 而非 pre:日志由 PGLog 渲染成分行元素,pre 会把缩进样式搅乱
  const out = el("div", { className: "out", hidden: true });

  const say = (text) => {
    out.hidden = false;
    out.textContent = text;
  };

  const run = async (act, extra, tag) => {
    say(`${tag ?? act.label} 执行中…`);
    const data = await guarded(() =>
      api("POST", `/accounts/${encodeURIComponent(acc.label)}/${act.path}`, { body: extra ?? {} })
    );
    // 这里不重载列表:重载会重建卡片,把刚拿到的结果冲掉
    if (data === undefined) return;
    // renderInto 会清空宿主,所以给它一个专属容器,标题另放
    const logHost = el("div", {});
    out.textContent = "";
    out.append(el("p", { className: "out-head", textContent: `${tag ?? act.label} 完成` }), logHost);
    PGLog.renderInto(logHost, data, act.job);
  };

  // 选项(首领/背包/副职列表)要真登录才拿得到,只在第一次展开面板时取,之后复用。
  let optsPromise = null;
  const getOptions = () => {
    if (!optsPromise) {
      optsPromise = guarded(() => api("GET", `/accounts/${encodeURIComponent(acc.label)}/options`)).then((v) => {
        if (v === undefined) optsPromise = null; // 失败不缓存,下次展开可重试
        return v;
      });
    }
    return optsPromise;
  };

  // 规则的三份表示要一起动:落库值、合上默认值后的生效值、高级 JSON 文本框。
  // 只改其中一份会让「面板存规则」之后再存通用设置时把面板的改动顶回去。
  let stored = acc.rules ?? {};
  let effective = mergeRules(structuredClone(defaultRules), acc.rules ?? undefined);
  const advanced = el("textarea", { value: JSON.stringify(stored, null, 2), spellcheck: false });
  const applyRules = (next) => {
    stored = next;
    acc.rules = next;
    effective = mergeRules(structuredClone(defaultRules), next);
    advanced.value = JSON.stringify(next, null, 2);
  };

  // ---- 操作面板:点按钮只展开,执行一律走面板里的「确定执行」----
  const panelHost = el("div", { className: "op-panel", hidden: true });
  let openPath = null;

  const btnClass = (path, active) =>
    (path === "daily-run" ? "small" : "small ghost") + (active ? " active" : "");

  const closePanel = () => {
    openPath = null;
    panelHost.hidden = true;
    panelHost.textContent = "";
    for (const b of actionButtons) b.className = btnClass(b.dataset.path, false);
  };

  const openPanel = async (act) => {
    if (openPath === act.path) {
      closePanel();
      return;
    }
    openPath = act.path;
    panelHost.hidden = false;
    panelHost.textContent = "";
    for (const b of actionButtons) b.className = btnClass(b.dataset.path, b.dataset.path === act.path);

    const head = el("div", { className: "op-head" }, el("strong", { textContent: act.label }));
    const body = el("div", { className: "op-body" });
    const footer = el("div", { className: "row op-footer" });
    panelHost.append(head, body, footer);

    let panel = null;
    if (act.panel) {
      body.append(el("p", { className: "hint", textContent: "正在从游戏读取可选项…" }));
      const opts = await getOptions();
      if (openPath !== act.path) return; // 等待期间用户换了面板
      body.textContent = "";
      if (!opts) {
        body.append(el("p", { className: "warn", textContent: "没能从游戏读取可选项,列表类字段只能手填。" }));
      } else if (opts.errors?.length) {
        body.append(el("p", { className: "warn", textContent: `部分选项读取失败:${opts.errors.join("; ")}` }));
      }
      panel = PANELS[act.panel](effective, opts ?? {});
      body.append(panel.node);
    } else {
      body.append(el("p", { className: "hint", textContent: act.note ?? "该操作没有可调参数。" }));
    }

    const fire = async (dryRun) => {
      const bad = panel?.validate?.();
      if (bad) {
        toast(bad, true);
        return;
      }
      const args = panel ? panel.read() : {};
      if (dryRun) args.dryRun = true;
      await run(act, args, dryRun ? `${act.label}(只预览)` : act.label);
    };

    footer.append(
      el("button", { className: "small", textContent: "确定执行", onclick: () => fire(false) })
    );
    if (act.preview) {
      footer.append(
        el("button", {
          className: "small ghost",
          textContent: "只预览",
          onclick: () => fire(true)
        })
      );
    }
    if (panel?.toRules) {
      footer.append(
        el("button", {
          className: "small ghost",
          textContent: "存为规则",
          onclick: async () => {
            const bad = panel.validate?.();
            if (bad) {
              toast(bad, true);
              return;
            }
            // PUT 是整体替换,先与本卡片已知的规则合并,免得存一个面板把别的清空
            const merged = mergeRules(structuredClone(effective), panel.toRules());
            const done = await guarded(() =>
              api("PUT", `/accounts/${encodeURIComponent(acc.label)}/rules`, { body: { rules: merged } })
            );
            if (done !== undefined) {
              applyRules(merged);
              toast(`${act.label} 的设置已存为规则,排程下一轮生效`);
            }
          }
        })
      );
    }
    footer.append(el("button", { className: "small ghost", textContent: "收起", onclick: closePanel }));
  };

  const actionButtons = ACTIONS.map((act) => {
    const b = el("button", {
      className: btnClass(act.path, false),
      textContent: act.label,
      onclick: () => openPanel(act)
    });
    b.dataset.path = act.path;
    return b;
  });
  const rulesHost = el("div", { className: "rule-host" });
  const rulesFooter = el("div", { className: "row" });
  let loaded = false;

  const advancedBox = el(
    "details",
    { className: "advanced" },
    el("summary", { textContent: "高级:直接编辑 JSON" }),
    el("p", { className: "hint", textContent: "表单与操作面板覆盖不到的字段才需要动这里。保存时会与表单结果深合并,表单优先。" }),
    advanced
  );

  // 只管排程,不需要游戏侧的可选项,展开即可渲染,不打游戏接口。
  const buildRulesForm = () => {
    if (loaded) return;
    loaded = true;
    const form = rulesForm(effective);
    rulesHost.textContent = "";
    rulesHost.append(form.node, advancedBox);

    rulesFooter.textContent = "";
    rulesFooter.append(
      el("button", {
        className: "small",
        textContent: "保存通用设置",
        onclick: async () => {
          let extra = {};
          try {
            extra = JSON.parse(advanced.value || "{}");
          } catch {
            toast("「高级」里的 JSON 不合法,请修正后再保存", true);
            return;
          }
          // PUT 整体替换,所以底子必须是当前生效值,否则会把各面板存过的设置清空
          const rules = mergeRules(mergeRules(structuredClone(effective), extra), form.read());
          const done = await guarded(() =>
            api("PUT", `/accounts/${encodeURIComponent(acc.label)}/rules`, { body: { rules } })
          );
          if (done !== undefined) {
            applyRules(rules);
            toast("通用设置已保存,下一轮排程生效");
          }
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
      say("正在向游戏服务端登录…");
      const data = await guarded(() => api("POST", `/accounts/${encodeURIComponent(acc.label)}/verify`, { body: {} }));
      if (data === undefined) return; // guarded 已经弹过错误提示
      out.textContent = "";
      // 后端 verify 只回 {authed}。登录失败会走异常,到不了这里。
      out.append(
        el("p", {
          className: data?.authed ? "out-head" : "warn",
          textContent: data?.authed ? "登录成功,凭据可用。" : "服务端没确认登录状态,建议看任务记录里的错误。"
        })
      );
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
    panelHost,
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

  const STATUS_WORD = { ok: "成功", error: "失败", running: "执行中" };

  // 结果列:一行中文摘要;点开才展开完整日志,免得列表被撑爆
  const rows = [];
  for (const r of runs) {
    let result = null;
    try {
      result = r.result_json ? JSON.parse(r.result_json) : null;
    } catch {
      result = null; // 落库文本坏了就当没有,不影响整表渲染
    }
    const tr = el(
      "tr",
      {},
      el("td", { textContent: labels.get(r.account_id) ?? r.account_id }),
      el("td", { textContent: PGLog.label(r.job_key) }),
      el("td", {
        className: r.status === "ok" ? "status-ok" : r.status === "error" ? "status-bad" : "",
        textContent: STATUS_WORD[r.status] ?? r.status
      }),
      el("td", { textContent: new Date(r.started_at).toLocaleString("zh-CN") }),
      el("td", { className: "cell-result", textContent: result ? PGLog.oneLine(result, r.job_key) : r.error ? "" : "没有结果记录" }),
      el("td", { className: "cell-error", textContent: r.error ?? "" })
    );
    rows.push(tr);
    if (result) {
      const host = el("div", {});
      const det = el("details", { className: "run-detail" }, el("summary", { textContent: "展开日志" }), host);
      const detailRow = el("tr", { className: "detail-row" }, el("td", { colSpan: 6 }, det));
      det.addEventListener("toggle", () => {
        if (det.open && !host.children.length) PGLog.renderInto(host, result, r.job_key);
      });
      rows.push(detailRow);
    }
  }

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
          ...["账号", "任务", "状态", "开始时间", "结果", "错误"].map((h) => el("th", { textContent: h }))
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

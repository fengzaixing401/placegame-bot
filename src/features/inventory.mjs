import { pickList, pickKey, num, text } from "../util.mjs";

// 装备状态枚举。取值来自真号 /api/equipment/list 实测,不是 CLI 的标签表 ——
// CLI 那份写的是 listed/in_warehouse,真实服务端给的是 on_market,且没有仓库态。
export const STATUS = { IN_BAG: "in_bag", EQUIPPED: "equipped", ON_MARKET: "on_market" };

// 硬保护:与用户在面板上怎么配、规则里存了什么一概无关,任何分解路径都必须先过这一关。
// 两条来自明确的运维约束 —— 不分解当前穿戴的装备、不分解等级高于 160 的装备。
// 之所以叫"硬",是因为它不能被配置放宽:用户把等级上限填成 999、把品质勾满,
// 也照样拆不动这两类。判定放在所有条件之前,顺序就是它的语义。
// 声明在 EMPTY_SUMMARY 之前:占位摘要也要带上这个上限,前端才能把输入框卡在同一档。
export const HARD_MAX_LEVEL = 160;

// 分解条件表单在拿不到背包时的占位摘要。页面照它渲染出"一个复选框都没有",
// 比渲染出 undefined 让前端自己兜底更可控。
// hardMaxLevel 不是背包数据而是约束常量,所以读不到背包时它照样有值。
export const EMPTY_SUMMARY = {
  total: 0,
  disposable: 0,
  qualities: [],
  attrKeys: [],
  rareRanks: [],
  hardMaxLevel: HARD_MAX_LEVEL
};

// 命中硬保护返回原因字符串,没命中返回 null。
//
// 穿戴判定要同时看两个字段:status === "equipped" 是服务端的主口径,
// item.equipped 是布尔口径。官方 CLI 的 equipmentStatus() 正是
// `item.status === "equipped" || item.equipped` —— 只认一个,两者不一致时就漏判,
// 而漏判的代价是拆掉身上正穿着的装备,不可逆。
//
// 等级读不到时按"受保护"处理:证明不了它不高于 160,就不能拆。
// 这与本文件既有的"条件判不了就不能拆,宁可漏拆不能误拆"是同一条原则。
export function hardProtection(row) {
  if (!row) return "行数据缺失";
  if (row.status === STATUS.EQUIPPED || row.equipped === true) return "当前穿戴中";
  const level = num(row.level);
  if (level === null) return `读不到等级,无法确认不高于 ${HARD_MAX_LEVEL}`;
  if (level > HARD_MAX_LEVEL) return `等级 ${level} 高于 ${HARD_MAX_LEVEL}`;
  if (row.locked === true) return "已上锁";
  return null;
}

// auto 模式的兜底判定:等级读不到或高于硬上限,都算"无法保证不超 160"。
// 与 hardProtection 同一条口径,单独抽出来是因为 auto 那边只关心等级这一维
// (能不能拆由游戏侧规则决定,穿戴与否不由它判)。
function levelUnsafe(row) {
  const level = num(row?.level);
  return level === null || level > HARD_MAX_LEVEL;
}

// 可分解 = 在背包中、未上锁、且未命中硬保护。已穿戴/已上架的靠 status 白名单排除。
export function isDisposable(row) {
  if (!row) return false;
  if (hardProtection(row)) return false;
  return row.status === STATUS.IN_BAG;
}

// 词条名在 baseAttrs 与 extraAttrs 两个对象里(键为属性名,不是数组)。
export function attrKeys(row) {
  return [...Object.keys(row?.baseAttrs ?? {}), ...Object.keys(row?.extraAttrs ?? {})];
}

// 分解条件判定。返回 {ok:true} 表示该拆,{ok:false,reason} 表示留着。
// 读不到 score/level 时按"留着"处理 —— 条件判不了就不能拆,宁可漏拆不能误拆。
export function matchesDecomposeRules(row, cond = {}) {
  // 硬保护先行:用户条件只能在其之上继续收紧,永远不能把它放宽
  const hard = hardProtection(row);
  if (hard) return { ok: false, reason: hard };

  if (row?.status === STATUS.ON_MARKET) return { ok: false, reason: "已上架" };
  if (row?.status !== STATUS.IN_BAG) return { ok: false, reason: `不在背包(status=${row?.status ?? "未知"})` };

  if (cond.keepRareRank !== false && row.rareRank) {
    return { ok: false, reason: `极品词条 ${row.rareRank}` };
  }

  const quals = [].concat(cond.qualities ?? []);
  if (quals.length > 0 && !quals.includes(row.quality)) {
    return { ok: false, reason: `品质 ${row.quality} 不在可分解名单` };
  }

  if (typeof cond.maxScore === "number") {
    const score = num(row.score);
    if (score === null) return { ok: false, reason: "读不到评分,未按评分条件处理" };
    if (score >= cond.maxScore) return { ok: false, reason: `评分 ${score} 不低于 ${cond.maxScore}` };
  }

  // 等级上限只能比硬上限更紧。用户填得比 160 松没有意义 ——
  // 高于 160 的那批在上面 hardProtection 里已经被拦下了。
  if (typeof cond.maxLevel === "number") {
    const level = num(row.level);
    if (level === null) return { ok: false, reason: "读不到等级,未按等级条件处理" };
    if (level > cond.maxLevel) return { ok: false, reason: `等级 ${level} 高于 ${cond.maxLevel}` };
  }

  const keep = [].concat(cond.keepAttrs ?? []);
  if (keep.length > 0) {
    const hit = attrKeys(row).find((k) => keep.includes(k));
    if (hit) return { ok: false, reason: `命中保留属性 ${hit}` };
  }

  return { ok: true };
}

// 至少要有一个"正向收紧"的条件。全空时 explicit 模式会把背包里所有未锁未穿的装备
// 一次拆光 —— 那是灾难而不是功能,所以在发请求前就拦下。
// keepRareRank 不算:它只保护极品,不限制其余任何一件。
export function hasNarrowingCondition(cond = {}) {
  if (typeof cond.maxScore === "number") return true;
  if (typeof cond.maxLevel === "number") return true;
  return [].concat(cond.qualities ?? []).length > 0;
}

// 逐件明细。落库要经 compactForStore 裁剪,所以每件只留能拼出人话日志的字段。
function digest(row, reason) {
  return {
    equipmentId: pickKey(row),
    name: row?.name ?? null,
    quality: row?.quality ?? null,
    level: row?.level ?? null,
    score: row?.score ?? null,
    rareRank: row?.rareRank ?? null,
    ...(reason ? { reason } : {})
  };
}

export async function listEquipment(api) {
  const data = await api.get("/api/equipment/list");
  return pickList(data, "equipment");
}

export async function listInventory(api) {
  const data = await api.get("/api/inventory/list");
  return { equipment: pickList(data?.equipment, "equipment"), items: pickList(data?.items, "items") };
}

// ② 背包一键分解。
// auto 模式走服务端自己的 auto-decompose 规则(条件在游戏里配,本程序无从预览);
// explicit 模式按 conditions 在本地筛,能逐件给出拆/留的原因。
// 三条路径都必须先过硬保护:穿戴中的装备、等级高于 160 的装备一律不拆。
export async function decompose(api, { mode = "auto", equipmentIds, conditions = {}, dryRun = false } = {}) {
  // 调用方点名了具体装备。这条路径不套 conditions,但绝不能因此绕过硬保护 ——
  // 它能从 REST 直接触达(POST /accounts/:label/inventory/decompose 带 equipmentIds),
  // 不校验就等于开了一个"把身上装备和高级装备交出去"的后门。
  // 所以先拉一次装备列表逐件核对,查无此 id 的也一并拒绝(宁可少拆)。
  if (Array.isArray(equipmentIds) && equipmentIds.length > 0) {
    const all = await listEquipment(api);
    const byId = new Map(all.map((row) => [pickKey(row), row]));
    const allowed = [];
    const refused = [];
    for (const id of equipmentIds) {
      const row = byId.get(id);
      if (!row) {
        refused.push({ equipmentId: id, reason: "不在装备列表(可能已消失或 id 有误)" });
        continue;
      }
      const hard = hardProtection(row);
      if (hard) {
        refused.push(digest(row, hard));
        continue;
      }
      allowed.push(id);
    }
    const out = {
      mode: "explicit",
      dryRun,
      scanned: equipmentIds.length,
      matched: allowed.length,
      refusedCount: refused.length,
      targets: allowed.map((id) => digest(byId.get(id))),
      refused
    };
    // 全被拦下时一个请求都不发 —— 不为"拆 0 件"去打一次写接口
    if (allowed.length === 0) return { ...out, equipmentIds: [], result: null };
    return { ...out, ...(await runDecompose(api, allowed, dryRun)) };
  }

  if (mode === "auto") {
    // 服务端只有 auto-decompose,没有它的预览端点。此处若退化成真分解,
    // 页面上的"预览"按钮就成了真拆装备 —— 必须显式拒绝而不是静默执行。
    if (dryRun) {
      throw new Error("auto 模式没有预览端点(游戏侧只提供直接执行)。要预览请切到 explicit 模式,或改用 auto 模式的「确定执行」。");
    }
    // auto 拆哪些由游戏侧规则决定,本程序看不到那份规则,也就没法在本地兜住硬保护。
    // 唯一能保证约束的做法:开跑前确认背包里不存在"等级读不到或高于 160"的装备。
    // 有就拒绝 —— 那正是约束要求绝不能拆的东西,而我们没有任何办法确认游戏不会拆它。
    const all = await listEquipment(api);
    const unsafe = all.filter((row) => row?.status === STATUS.IN_BAG && levelUnsafe(row));
    if (unsafe.length > 0) {
      throw new Error(
        `auto 模式无法保证「不分解等级高于 ${HARD_MAX_LEVEL} 的装备」:背包里有 ${unsafe.length} 件等级读不到或高于 ${HARD_MAX_LEVEL} 的装备,而游戏侧的自动分解规则本程序无法预览。请改用 explicit 模式(本程序逐件判定并给出理由),或先在游戏内把自动分解规则收紧。`
      );
    }
    return { mode: "auto", result: await api.post("/api/equipment/auto-decompose", {}) };
  }

  if (!hasNarrowingCondition(conditions)) {
    throw new Error("explicit 模式至少要设一个收紧条件(评分上限 / 等级上限 / 可分解品质),否则会把背包里所有未锁未穿的装备全部分解。");
  }

  const all = await listEquipment(api);
  const targets = [];
  const kept = [];
  for (const row of all) {
    const verdict = matchesDecomposeRules(row, conditions);
    if (verdict.ok) targets.push(row);
    else kept.push(digest(row, verdict.reason));
  }

  const ids = targets.map(pickKey).filter(Boolean);
  const out = {
    mode: "explicit",
    dryRun,
    conditions,
    scanned: all.length,
    matched: ids.length,
    keptCount: kept.length,
    targets: targets.map((r) => digest(r)),
    kept
  };
  if (ids.length === 0) return { ...out, result: null };
  const { result } = await runDecompose(api, ids, dryRun);
  return { ...out, equipmentIds: ids, result };
}

async function runDecompose(api, equipmentIds, dryRun) {
  const path = dryRun ? "/api/equipment/decompose-preview" : "/api/equipment/decompose";
  return { dryRun, equipmentIds, result: await api.post(path, { equipmentIds }) };
}

// 背包装备摘要,供 WebUI 渲染分解条件表单。
// 品质与属性名都从真实背包取,不写死枚举 —— 品质取值只确认了 red/gold/purple 三个,
// 猜出来的复选框会误导人;游戏日后加品质,这里也会自动跟上。
export async function equipmentSummary(api) {
  const all = await listEquipment(api);
  const qualities = new Map();
  const attrs = new Set();
  const rareRanks = new Set();
  let disposable = 0;

  for (const row of all) {
    if (isDisposable(row)) disposable += 1;
    const q = row?.quality ?? "未知";
    qualities.set(q, (qualities.get(q) ?? 0) + 1);
    for (const k of attrKeys(row)) attrs.add(k);
    if (row?.rareRank) rareRanks.add(String(row.rareRank));
  }

  return {
    total: all.length,
    disposable,
    qualities: [...qualities].map(([quality, count]) => ({ quality, count })).sort((a, b) => b.count - a.count),
    attrKeys: [...attrs].sort(),
    rareRanks: [...rareRanks],
    // 带上硬上限,前端把等级输入框卡在同一档 —— 前端不另存一份常量,免得两边漂移
    hardMaxLevel: HARD_MAX_LEVEL
  };
}

// WebUI 分解面板的数据。拿不到背包时退回空摘要 —— 面板能渲染多少算多少,
// 不因为一个端点失败就把整页顶掉。错误单独回传,不混进摘要本身。
export async function viewForOptions(api) {
  try {
    return { summary: await equipmentSummary(api), error: null };
  } catch (err) {
    return { summary: EMPTY_SUMMARY, error: err.message };
  }
}

// 服务端自动分解规则。patch 结构 CLI 未展开(原样透传用户 JSON),故此处也不做校验。
export async function setAutoDecomposeRules(api, patch) {
  if (!patch || typeof patch !== "object") throw new Error("setAutoDecomposeRules 需要 patch 对象");
  return api.post("/api/equipment/auto-decompose-rules", { patch });
}

// 注意这是"切换"语义,不接受目标状态布尔值
export async function toggleLock(api, equipmentId) {
  if (!equipmentId) throw new Error("toggleLock 需要 equipmentId");
  return api.post("/api/equipment/toggle-lock", { equipmentId });
}

export async function recycleItem(api, itemId, amount = 1) {
  if (!itemId) throw new Error("recycleItem 需要 itemId");
  return api.post("/api/inventory/recycle", { itemId, amount });
}

// 供 guild 复用的物品行字段。服务端同义字段多,集中在这里挑。
export const ITEM_KEY_FIELDS = ["itemKey", "key", "templateKey", "itemTemplateKey"];
export const ITEM_ID_FIELDS = ["itemId", "id", "instanceId"];

import { unwrap, pickList, pickKey } from "../util.mjs";

// 装备状态枚举。取值来自真号 /api/equipment/list 实测,不是 CLI 的标签表 ——
// CLI 那份写的是 listed/in_warehouse,真实服务端给的是 on_market,且没有仓库态。
export const STATUS = { IN_BAG: "in_bag", EQUIPPED: "equipped", ON_MARKET: "on_market" };

// 可分解 = 在背包中且未上锁。已穿戴/已上架的靠 status 白名单排除 ——
// 服务端不返回 equipped 字段,穿戴状态只体现在 status 上。
export function isDisposable(row) {
  if (!row) return false;
  if (row.locked === true) return false;
  return row.status === STATUS.IN_BAG;
}

// 词条名在 baseAttrs 与 extraAttrs 两个对象里(键为属性名,不是数组)。
export function attrKeys(row) {
  return [...Object.keys(row?.baseAttrs ?? {}), ...Object.keys(row?.extraAttrs ?? {})];
}

// 分解条件判定。返回 {ok:true} 表示该拆,{ok:false,reason} 表示留着。
// 读不到 score/level 时按"留着"处理 —— 条件判不了就不能拆,宁可漏拆不能误拆。
export function matchesDecomposeRules(row, cond = {}) {
  if (!isDisposable(row)) {
    if (row?.locked === true) return { ok: false, reason: "已上锁" };
    if (row?.status === STATUS.EQUIPPED) return { ok: false, reason: "已穿戴" };
    if (row?.status === STATUS.ON_MARKET) return { ok: false, reason: "已上架" };
    return { ok: false, reason: `不在背包(status=${row?.status ?? "未知"})` };
  }

  if (cond.keepRareRank !== false && row.rareRank) {
    return { ok: false, reason: `极品词条 ${row.rareRank}` };
  }

  const quals = [].concat(cond.qualities ?? []);
  if (quals.length > 0 && !quals.includes(row.quality)) {
    return { ok: false, reason: `品质 ${row.quality} 不在可分解名单` };
  }

  if (typeof cond.maxScore === "number") {
    if (typeof row.score !== "number" || !Number.isFinite(row.score)) {
      return { ok: false, reason: "读不到评分,未按评分条件处理" };
    }
    if (row.score >= cond.maxScore) {
      return { ok: false, reason: `评分 ${row.score} 不低于 ${cond.maxScore}` };
    }
  }

  if (typeof cond.maxLevel === "number") {
    if (typeof row.level !== "number" || !Number.isFinite(row.level)) {
      return { ok: false, reason: "读不到等级,未按等级条件处理" };
    }
    if (row.level > cond.maxLevel) {
      return { ok: false, reason: `等级 ${row.level} 高于 ${cond.maxLevel}` };
    }
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
  const data = unwrap(await api.request("/api/equipment/list"));
  return pickList(data, "equipment");
}

export async function listInventory(api) {
  const data = unwrap(await api.request("/api/inventory/list"));
  return { equipment: pickList(data?.equipment, "equipment"), items: pickList(data?.items, "items") };
}

// ② 背包一键分解。
// auto 模式走服务端自己的 auto-decompose 规则(条件在游戏里配,本程序无从预览);
// explicit 模式按 conditions 在本地筛,能逐件给出拆/留的原因。
export async function decompose(api, { mode = "auto", equipmentIds, conditions = {}, dryRun = false } = {}) {
  // 调用方点名了具体装备:直接拆这些,不再套条件
  if (Array.isArray(equipmentIds) && equipmentIds.length > 0) {
    return { mode: "explicit", scanned: equipmentIds.length, matched: equipmentIds.length, ...(await runDecompose(api, equipmentIds, dryRun)) };
  }

  if (mode === "auto") {
    // 服务端只有 auto-decompose,没有它的预览端点。此处若退化成真分解,
    // 页面上的"预览"按钮就成了真拆装备 —— 必须显式拒绝而不是静默执行。
    if (dryRun) {
      throw new Error("auto 模式没有预览端点(游戏侧只提供直接执行)。要预览请切到 explicit 模式,或改用 auto 模式的「确定执行」。");
    }
    return { mode: "auto", result: unwrap(await api.request("/api/equipment/auto-decompose", { method: "POST", body: {} })) };
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
  return {
    dryRun,
    equipmentIds,
    result: unwrap(await api.request(path, { method: "POST", body: { equipmentIds } }))
  };
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
    rareRanks: [...rareRanks]
  };
}

// 服务端自动分解规则。patch 结构 CLI 未展开(原样透传用户 JSON),故此处也不做校验。
export async function setAutoDecomposeRules(api, patch) {
  if (!patch || typeof patch !== "object") throw new Error("setAutoDecomposeRules 需要 patch 对象");
  return unwrap(await api.request("/api/equipment/auto-decompose-rules", { method: "POST", body: { patch } }));
}

// 注意这是"切换"语义,不接受目标状态布尔值
export async function toggleLock(api, equipmentId) {
  if (!equipmentId) throw new Error("toggleLock 需要 equipmentId");
  return unwrap(await api.request("/api/equipment/toggle-lock", { method: "POST", body: { equipmentId } }));
}

export async function recycleItem(api, itemId, amount = 1) {
  if (!itemId) throw new Error("recycleItem 需要 itemId");
  return unwrap(await api.request("/api/inventory/recycle", { method: "POST", body: { itemId, amount } }));
}

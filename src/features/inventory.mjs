import { unwrap, pickList, pickKey } from "../util.mjs";

// 装备状态枚举(CLI INVENTORY_STATUS_LABELS,line 750)
export const STATUS = { IN_BAG: "in_bag", EQUIPPED: "equipped", IN_WAREHOUSE: "in_warehouse", LISTED: "listed" };

// 可分解 = 在背包中且未上锁。仓库中/已上架/已穿戴的一律排除,避免误删。
export function isDisposable(row) {
  if (!row) return false;
  if (row.locked === true) return false;
  if (row.equipped === true) return false;
  return row.status === STATUS.IN_BAG;
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
// auto 模式走服务端自己的 auto-decompose 规则(最安全,不需要我们判断哪件该拆);
// explicit 模式由我们筛出 disposable 的装备再按 id 批量分解。
export async function decompose(api, { mode = "auto", equipmentIds, maxQuality, dryRun = false } = {}) {
  if (Array.isArray(equipmentIds) && equipmentIds.length > 0) {
    return runDecompose(api, equipmentIds, dryRun);
  }
  if (mode === "auto") {
    return { mode: "auto", result: unwrap(await api.request("/api/equipment/auto-decompose", { method: "POST", body: {} })) };
  }

  const all = await listEquipment(api);
  let targets = all.filter(isDisposable);
  if (maxQuality) {
    const allow = new Set([].concat(maxQuality));
    targets = targets.filter((r) => allow.has(r.quality));
  }
  const ids = targets.map(pickKey).filter(Boolean);
  if (ids.length === 0) return { mode: "explicit", decomposed: 0, skipped: all.length, result: null };
  const result = await runDecompose(api, ids, dryRun);
  return { mode: "explicit", decomposed: ids.length, skipped: all.length - ids.length, ...result };
}

async function runDecompose(api, equipmentIds, dryRun) {
  const path = dryRun ? "/api/equipment/decompose-preview" : "/api/equipment/decompose";
  return {
    dryRun,
    equipmentIds,
    result: unwrap(await api.request(path, { method: "POST", body: { equipmentIds } }))
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

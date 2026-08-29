import { unwrap } from "../util.mjs";
import { listInventory } from "./inventory.mjs";

export async function view(api) {
  const data = unwrap(await api.request("/api/guild/view"));
  return data?.guild ?? data;
}

// 背包物品行的稳定键与实例 ID。捐献接口收的是实例 ID(官方 CLI 标 reference:true,
// 引用失效会报"列表已失效,请重新查询"),所以规则里存 itemKey,运行时在这里换。
function rowItemKey(row) {
  for (const k of ["itemKey", "key", "templateKey", "itemTemplateKey"]) {
    if (row?.[k]) return String(row[k]);
  }
  return null;
}

function rowItemId(row) {
  for (const k of ["itemId", "id", "instanceId"]) {
    if (row?.[k]) return row[k];
  }
  return null;
}

// 可捐献物品清单,同时供 WebUI 下拉渲染。amount 是当前持有数量。
export async function donatableItems(api) {
  const { items } = await listInventory(api);
  return items
    .map((row) => ({
      itemKey: rowItemKey(row),
      itemId: rowItemId(row),
      name: row?.name ?? row?.itemName ?? null,
      amount: row?.amount ?? row?.count ?? row?.quantity ?? null
    }))
    .filter((r) => r.itemKey && r.itemId);
}

// ④ 公会兑换 + 捐献 + 分红。
// 注意接口不对称(CLI 已确认,勿"统一"):redeem 用 itemKey,donate 用 itemId。
export async function dailyRoutine(api, { redeem = [], donate = [], equipmentDonate = [], claimDividend = true, claimProgressPoints = [] } = {}) {
  const out = { redeemed: [], donated: [], equipmentDonated: [], dividend: null, progress: [], errors: [] };

  for (const entry of redeem) {
    const itemKey = typeof entry === "string" ? entry : entry?.itemKey;
    const amount = typeof entry === "string" ? 1 : entry?.amount ?? 1;
    if (!itemKey) {
      out.errors.push({ step: "redeem", error: "缺少 itemKey", entry });
      continue;
    }
    try {
      out.redeemed.push({ itemKey, amount, result: await redeemItem(api, itemKey, amount) });
    } catch (err) {
      out.errors.push({ step: "redeem", itemKey, error: err.message });
    }
  }

  // 捐献:规则给的是 itemKey,这里查一次背包换成实例 itemId。背包只在真的要捐时才查。
  let bag = null;
  for (const entry of donate) {
    const itemKey = typeof entry === "string" ? entry : entry?.itemKey;
    const amount = typeof entry === "string" ? 1 : entry?.amount ?? 1;
    let itemId = typeof entry === "string" ? null : entry?.itemId ?? null;

    if (!itemId && !itemKey) {
      out.errors.push({ step: "donate", error: "缺少 itemKey", entry });
      continue;
    }

    if (!itemId) {
      if (bag === null) {
        try {
          bag = await donatableItems(api);
        } catch (err) {
          out.errors.push({ step: "donate", error: `读取背包失败,无法解析 itemId:${err.message}` });
          break;
        }
      }
      const hit = bag.find((r) => r.itemKey === itemKey);
      if (!hit) {
        out.errors.push({ step: "donate", itemKey, error: "背包里没有这个物品,已跳过" });
        continue;
      }
      itemId = hit.itemId;
    }

    try {
      out.donated.push({ itemKey, itemId, amount, result: await donateItem(api, itemId, amount) });
    } catch (err) {
      out.errors.push({ step: "donate", itemKey, itemId, error: err.message });
    }
  }

  for (const equipmentId of equipmentDonate) {
    try {
      out.equipmentDonated.push({ equipmentId, result: await donateEquipment(api, equipmentId) });
    } catch (err) {
      out.errors.push({ step: "equipmentDonate", equipmentId, error: err.message });
    }
  }

  if (claimDividend) {
    try {
      out.dividend = await claimDividendReward(api);
    } catch (err) {
      out.errors.push({ step: "claimDividend", error: err.message });
    }
  }

  for (const point of claimProgressPoints) {
    try {
      out.progress.push({ point, result: await claimProgress(api, point) });
    } catch (err) {
      out.errors.push({ step: "claimProgress", point, error: err.message });
    }
  }

  return out;
}

export async function redeemItem(api, itemKey, amount = 1) {
  if (!itemKey) throw new Error("redeemItem 需要 itemKey");
  return unwrap(await api.request("/api/guild/redeem", { method: "POST", body: { itemKey, amount } }));
}

export async function donateItem(api, itemId, amount = 1) {
  if (!itemId) throw new Error("donateItem 需要 itemId");
  return unwrap(await api.request("/api/guild/donate", { method: "POST", body: { itemId, amount } }));
}

export async function donateEquipment(api, equipmentId) {
  if (!equipmentId) throw new Error("donateEquipment 需要 equipmentId");
  return unwrap(await api.request("/api/guild/equipment/donate", { method: "POST", body: { equipmentId } }));
}

export async function claimDividendReward(api) {
  return unwrap(await api.request("/api/guild/claim-dividend", { method: "POST", body: {} }));
}

// point 是奖励档位序号,不是数量
export async function claimProgress(api, point) {
  if (!Number.isInteger(point)) throw new Error("claimProgress 的 point 必须是整数档位");
  return unwrap(await api.request("/api/guild/claim-progress", { method: "POST", body: { point } }));
}

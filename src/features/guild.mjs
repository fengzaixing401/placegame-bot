import { unwrap } from "../util.mjs";

export async function view(api) {
  const data = unwrap(await api.request("/api/guild/view"));
  return data?.guild ?? data;
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

  for (const entry of donate) {
    const itemId = typeof entry === "string" ? entry : entry?.itemId;
    const amount = typeof entry === "string" ? 1 : entry?.amount ?? 1;
    if (!itemId) {
      out.errors.push({ step: "donate", error: "缺少 itemId(捐献按 itemId,与兑换的 itemKey 不同)", entry });
      continue;
    }
    try {
      out.donated.push({ itemId, amount, result: await donateItem(api, itemId, amount) });
    } catch (err) {
      out.errors.push({ step: "donate", itemId, error: err.message });
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

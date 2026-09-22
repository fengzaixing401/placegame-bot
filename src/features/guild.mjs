import { pickField } from "../util.mjs";
import { listInventory, ITEM_KEY_FIELDS, ITEM_ID_FIELDS } from "./inventory.mjs";

export async function view(api) {
  const data = await api.get("/api/guild/view");
  return data?.guild ?? data;
}

// 背包物品行的稳定键与实例 ID。捐献接口收的是实例 ID(官方 CLI 标 reference:true,
// 引用失效会报"列表已失效,请重新查询"),所以规则里存 itemKey,运行时在这里换。
const rowItemKey = (row) => pickField(row, ITEM_KEY_FIELDS);
const rowItemId = (row) => pickField(row, ITEM_ID_FIELDS);

// 可兑换清单 = 公会仓库(guild.view 的 storage)。兑换记录实测 itemKey 就是仓库里那个键
// (如 skill_page),与 /api/guild/redeem 收的字段同名。
// 注意别跟 supplies 混:那是另一套「公会补给」,走 /api/guild/supply/purchase 收 supplyKey,
// 本项目没有实现,所以不往这里塞。
// 顺带带出 equipmentDonationMinQuality —— 公会自己设的装备捐献品质下限,页面要照它显示。
export async function redeemableItems(api) {
  const guild = await view(api);
  const rows = Array.isArray(guild?.storage) ? guild.storage : [];
  return {
    items: rows
      .map((row) => ({
        itemKey: rowItemKey(row),
        name: row?.name ?? null,
        quality: row?.quality ?? null,
        amount: row?.amount ?? null
      }))
      .filter((r) => r.itemKey),
    equipmentDonationMinQuality: guild?.equipmentDonationMinQuality ?? null,
    canDonate: guild?.canDonate !== false,
    donationBlockedReason: (guild?.donationBlockedReason ?? "").trim() || null,
    // 兑换有周上限(实测 {key:"2026-09-21", limit:30, redeemed:30, remaining:0}),
    // 带出去让面板能显示"这周还能换几次" —— 不然换不动了也不知道为什么。
    weeklyRedemption: guild?.weeklySupplyRedemption ?? null,
    // 可领的贡献奖励档位。**只带档位序号,不带整份 guild view** ——
    // 那份里有 89 个成员和 200 件装备仓库,塞进 options 会把它顶爆。
    claimableProgressPoints: claimableProgressPoints(guild)
  };
}

// 可领的贡献奖励档位。服务端的 progressRewards 每档自带 canClaim(实测四档:
// 30/60/90/120 点,各带 rewardLabels 与 unlocked),**按它领**。
// 早先只能让规则里写死一串档位序号 —— 档位随贡献点解锁,写死就永远追不上,
// 而且面板里根本没这个字段,等于配不了。
export function claimableProgressPoints(guild) {
  const rows = Array.isArray(guild?.progressRewards) ? guild.progressRewards : [];
  return rows.filter((r) => r?.canClaim === true && Number.isInteger(r?.point)).map((r) => r.point);
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

// WebUI 公会对面板的数据。两个清单分别对应两套不同的东西(仓库 vs 背包),
// 接口收的字段也不同,所以分开取、分别兜错 —— 一个挂了不该把另一个也清空。
export async function viewForOptions(api) {
  const [bag, stock] = await Promise.all([
    donatableItems(api).catch((err) => ({ error: err.message })),
    redeemableItems(api).catch((err) => ({ error: err.message }))
  ]);

  return {
    donatableItems: Array.isArray(bag) ? bag : [],
    redeemableItems: Array.isArray(stock?.items) ? stock.items : [],
    guild: {
      equipmentDonationMinQuality: stock?.equipmentDonationMinQuality ?? null,
      canDonate: stock?.canDonate !== false,
      donationBlockedReason: stock?.donationBlockedReason ?? null,
      // 兑换周上限与可领的贡献奖励档位 —— 面板要显示"这周还能换几次 / 有几档能领"
      weeklyRedemption: stock?.weeklyRedemption ?? null,
      claimableProgressPoints: Array.isArray(stock?.claimableProgressPoints) ? stock.claimableProgressPoints : []
    },
    errors: [bag?.error, stock?.error].filter(Boolean)
  };
}

// ④ 公会兑换 + 捐献 + 分红。
// 注意接口不对称(CLI 已确认,勿"统一"):redeem 用 itemKey,donate 用 itemId。
export async function dailyRoutine(
  api,
  {
    redeem = [],
    donate = [],
    equipmentDonate = [],
    claimDividend = true,
    claimProgressRewards = true,
    claimProgressPoints = []
  } = {}
) {
  const out = { redeemed: [], donated: [], equipmentDonated: [], dividend: null, progress: [], errors: [] };

  // 中文名解析器。日志里只有 itemKey 就会渲出 skill_page 这种裸键,
  // 而清单本来就要查(捐献必须靠它换 itemId),顺手把名字带上。
  // 清单只在真的要用时查一次;查不到名字不算失败 —— 名字只影响日志好看,不影响动作能不能做。
  const lazyList = (load) => {
    let rows = null;
    return async () => {
      if (rows === null) rows = await load().catch(() => []);
      return rows;
    };
  };
  const stockRows = lazyList(async () => (await redeemableItems(api)).items);

  // 规则条目既允许写成裸键("skill_page"),也允许写成 {itemKey, amount}。
  const asEntry = (entry) => ({
    itemKey: typeof entry === "string" ? entry : entry?.itemKey,
    amount: typeof entry === "string" ? 1 : entry?.amount ?? 1,
    itemId: typeof entry === "string" ? null : entry?.itemId ?? null
  });

  for (const entry of redeem) {
    const { itemKey, amount } = asEntry(entry);
    if (!itemKey) {
      out.errors.push({ step: "redeem", error: "缺少 itemKey", entry });
      continue;
    }
    const name = (await stockRows()).find((r) => r.itemKey === itemKey)?.name ?? null;
    try {
      out.redeemed.push({ itemKey, name, amount, result: await redeemItem(api, itemKey, amount) });
    } catch (err) {
      out.errors.push({ step: "redeem", itemKey, name, error: err.message });
    }
  }

  // 捐献:规则给的是 itemKey,这里查一次背包换成实例 itemId。背包只在真的要捐时才查。
  let bag = null;
  for (const entry of donate) {
    const { itemKey, amount, itemId: presetItemId } = asEntry(entry);
    let itemId = presetItemId;
    let name = null;

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
      name = hit.name;
    }

    try {
      out.donated.push({ itemKey, name, itemId, amount, result: await donateItem(api, itemId, amount) });
    } catch (err) {
      out.errors.push({ step: "donate", itemKey, name, itemId, error: err.message });
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

  // 贡献奖励(游戏里叫"进度奖励"):默认按服务端给的 canClaim 领 ——
  // 档位随贡献点解锁,规则里写死一串序号迟早追不上,而且原先面板里根本没这个字段。
  // 显式的 claimProgressPoints 仍然认(老调用方),两者合并去重。
  let points = [...claimProgressPoints];
  if (claimProgressRewards) {
    try {
      points = [...new Set([...points, ...claimableProgressPoints(await view(api))])];
    } catch (err) {
      out.errors.push({ step: "claimProgress", error: `读取贡献奖励档位失败:${err.message}` });
    }
  }
  for (const point of points) {
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
  return api.post("/api/guild/redeem", { itemKey, amount });
}

export async function donateItem(api, itemId, amount = 1) {
  if (!itemId) throw new Error("donateItem 需要 itemId");
  return api.post("/api/guild/donate", { itemId, amount });
}

export async function donateEquipment(api, equipmentId) {
  if (!equipmentId) throw new Error("donateEquipment 需要 equipmentId");
  return api.post("/api/guild/equipment/donate", { equipmentId });
}

export async function claimDividendReward(api) {
  return api.post("/api/guild/claim-dividend", {});
}

// point 是奖励档位序号,不是数量
export async function claimProgress(api, point) {
  if (!Number.isInteger(point)) throw new Error("claimProgress 的 point 必须是整数档位");
  return api.post("/api/guild/claim-progress", { point });
}

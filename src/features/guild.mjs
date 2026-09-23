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
    // 可领的贡献奖励档位。**只带档位序号,不带整份 guild view** ——
    // 那份里有 89 个成员和 200 件装备仓库,塞进 options 会把它顶爆。
    claimableProgressPoints: claimableProgressPoints(guild)
  };
}

// 兑换**没有次数限制**,只花贡献值,上限是仓库库存本身。
// 实测 storage 行只有 amount/bindStatus/guildId/itemKey/itemType/name/quality/supplyAmount,
// **一个限购字段都没有** —— 别再往兑换提示里挂"本周还能换几次"。
//
// 限购在**另一套东西**上:公会补给(/api/guild/supply/purchase)的 supplies 行带
// dailyPurchaseCount / dailyPurchaseLimit / dailyPurchaseRemaining(实测 5 项里 3 项当日已满),
// 另外 guild.view 里还有一个 weeklySupplyRedemption 的周上限 —— 那都是**补给**,不是兑换。
// 本程序没实现补给,所以这两处的限制都不该出现在兑换面板上。

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
      // 可领的贡献奖励档位 —— 面板要显示"有几档能领"。兑换没有次数限制,所以不带任何上限字段
      claimableProgressPoints: Array.isArray(stock?.claimableProgressPoints) ? stock.claimableProgressPoints : []
    },
    errors: [bag?.error, stock?.error].filter(Boolean)
  };
}

// ④ 公会捐献 + 分红 + 贡献奖励。
//
// **兑换不在这里** —— 它是独立任务 guild.redeem(见 redeemByStock):
// 兑换要按秒级间隔反复查库存、按累计目标慢慢换,与 20 小时一轮的捐献/分红节奏完全不同,
// 绑在一起会互相拖累。
// 注意接口不对称(CLI 已确认,勿"统一"):redeem 用 itemKey,donate 用 itemId。
export async function dailyRoutine(
  api,
  { donate = [], equipmentDonate = [], claimDividend = true, claimProgressRewards = true, claimProgressPoints = [] } = {}
) {
  const out = { donated: [], equipmentDonated: [], dividend: null, progress: [], errors: [] };

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

  // 规则条目既允许写成裸键("skill_page"),也允许写成 {itemKey, amount}。
  const asEntry = (entry) => ({
    itemKey: typeof entry === "string" ? entry : entry?.itemKey,
    amount: typeof entry === "string" ? 1 : entry?.amount ?? 1,
    itemId: typeof entry === "string" ? null : entry?.itemId ?? null
  });

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

// 游戏对单次兑换的上限。超过会被服务端拒,所以要拆成多次调用。
export const REDEEM_MAX_PER_CALL = 999;

// 按「累计目标 + 当前库存」兑换 —— 规则里的数量是**累计目标**,不是每轮数量。
// 用户要的语义:目标 2000,每轮看库存继续换,累计到 2000 就停;不要每轮都换 2000。
//
// 每项一轮的做法:
//   ① remaining = 目标 − 已累计(本地记账)。已达标 → 跳过。
//   ② want = min(remaining, 当前库存)。库存 0 → 跳过,**不发注定失败的请求**。
//   ③ 按单次上限(999)拆成多次调用;**只把成功的次数累加进账本** ——
//      失败的不算,否则目标会被虚报成已达成。
//   ④ 某次失败就停那一项(库存被抢光/网络抖),不空转。
export async function redeemByStock(api, { entries = [], totals = null, accountId = null, maxPerCall = REDEEM_MAX_PER_CALL } = {}) {
  const out = { redeemed: [], skipped: [], errors: [] };
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return out;

  const cap = Math.max(1, Math.min(REDEEM_MAX_PER_CALL, Math.floor(Number(maxPerCall)) || REDEEM_MAX_PER_CALL));

  // 库存只在真要换时才查,一轮只查一次;查不到就整轮收手 ——
  // 拿旧数据瞎换比不换更糟(可能换到已经被抢光的物品)。
  let snap = null;
  const stock = async () => {
    if (snap === null) snap = await redeemableItems(api).catch(() => null);
    return snap;
  };

  for (const entry of list) {
    const itemKey = typeof entry === "string" ? entry : entry?.itemKey;
    // total 是累计目标。老字段名 amount 也认(它以前是"每轮数量",语义已改,这里当目标用)。
    const total = Number(typeof entry === "string" ? 1 : (entry?.total ?? entry?.amount ?? 1));
    if (!itemKey || !Number.isFinite(total) || total <= 0) {
      out.errors.push({ step: "redeem", error: "缺少 itemKey 或目标数量", entry });
      continue;
    }

    const already = totals && accountId ? totals.get(accountId, itemKey) : 0;
    const remaining = total - already;
    if (remaining <= 0) {
      out.skipped.push({ itemKey, reason: `已达目标 ${total}(已兑换 ${already})`, total, redeemed: already });
      continue;
    }

    const s = await stock();
    if (!s) {
      out.errors.push({ step: "redeem", itemKey, error: "读取公会仓库失败,本轮跳过" });
      break; // 仓库读不到,后面几项同样读不到,不必逐项重试
    }
    const row = s.items.find((r) => r.itemKey === itemKey);
    const name = row?.name ?? null;
    if (!row) {
      out.skipped.push({ itemKey, name, reason: "不在公会仓库里", total, redeemed: already });
      continue;
    }
    const inStock = Number.isFinite(row.amount) ? row.amount : 0;
    const want = Math.min(remaining, inStock);
    if (want <= 0) {
      out.skipped.push({ itemKey, name, reason: "仓库库存为 0", total, redeemed: already, stock: inStock });
      continue;
    }

    let done = 0;
    while (done < want) {
      const chunk = Math.min(cap, want - done);
      try {
        await redeemItem(api, itemKey, chunk);
      } catch (err) {
        out.errors.push({ step: "redeem", itemKey, name, amount: chunk, error: err.message });
        break;
      }
      done += chunk;
      if (totals && accountId) totals.add(accountId, itemKey, chunk);
    }
    if (done > 0) {
      out.redeemed.push({ itemKey, name, amount: done, stock: inStock, total, redeemed: already + done });
    }
  }
  return out;
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

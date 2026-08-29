import { unwrap, pickList, pickKey } from "../util.mjs";
import { dynamicView } from "./collect.mjs";

// 首领类型(dynamic-view 的 data.bosses[].type)
export const BOSS_TYPE = { PERSONAL: "personal", MAP: "map", WORLD: "world" };

// 能否挑战:真实字段是 available(布尔)与 blockedReason。
// 源码中不存在 blocked / challengeable / assistable / remainingAttempts 这些字段。
export function isChallengeable(row) {
  if (!row) return false;
  if (row.available === false) return false;
  const left = row.remainingAttemptCount;
  if (typeof left === "number" && left <= 0) return false;
  return true;
}

export function blockedReason(row) {
  if (!row) return "首领不存在";
  // 必须用 ||:服务端用空字符串表示"无阻挡原因",?? 不会兜底,调用方 if (reason) 会把它当成可挑战
  if (row.available === false) return row.blockedReason || "服务端标记不可挑战";
  if (typeof row.remainingAttemptCount === "number" && row.remainingAttemptCount <= 0) return "挑战次数已用尽";
  return null;
}

// 首领列表来自 dynamic-view(该端点不接受参数),源码中没有 /api/client/view-sections。
export async function listBosses(api, { type } = {}) {
  const view = await dynamicView(api);
  const all = pickList(view?.bosses, "bosses");
  return type ? all.filter((b) => b.type === type) : all;
}

export async function worldStatus(api) {
  return unwrap(await api.request("/api/boss/world-status"));
}

// challenge 与 preview 共用同一组字段(CLI bossFields,line 499-509)。
// 带 default 的字段 CLI 总会显式发送,这里保持一致以贴合服务端预期。
function challengeBody(bossKey, rules = {}) {
  const body = {
    bossKey,
    difficulty: rules.difficulty ?? "normal",
    selectedSkillKeys: rules.selectedSkillKeys ?? [],
    buffKey: rules.buffKey || "none",
    affixKey: rules.affixKey || "none",
    useMaterialBoost: rules.useMaterialBoost ?? false
  };
  // targetSlot 无默认值,未设置时必须省略
  if (rules.targetSlot) body.targetSlot = rules.targetSlot;
  return body;
}

export async function preview(api, bossKey, rules) {
  if (!bossKey) throw new Error("preview 需要 bossKey");
  return unwrap(await api.request("/api/boss/preview", { method: "POST", body: challengeBody(bossKey, rules) }));
}

export async function challenge(api, bossKey, rules) {
  if (!bossKey) throw new Error("challenge 需要 bossKey");
  return unwrap(await api.request("/api/boss/challenge", { method: "POST", body: challengeBody(bossKey, rules) }));
}

export async function assist(api, bossKey) {
  if (!bossKey) throw new Error("assist 需要 bossKey");
  return unwrap(await api.request("/api/boss/assist", { method: "POST", body: { bossKey } }));
}

export async function claimReward(api) {
  return unwrap(await api.request("/api/boss/claim-reward", { method: "POST", body: {} }));
}

// ⑤ 按规则挑战首领。
// 配置了 mapBosses 就只打这些;否则自动挑 available 的。每次挑战前用列表数据做前置检查,
// 避免把已用尽次数的首领反复打成错误。
export async function runBosses(api, { types = [BOSS_TYPE.MAP, BOSS_TYPE.PERSONAL], rules = {}, maxChallenges = 5, dryRun = false } = {}) {
  const out = { attempted: [], skipped: [], claimed: null, errors: [] };
  const all = await listBosses(api);
  const wanted = new Set([].concat(rules.mapBosses ?? []));

  const candidates = all.filter((b) => {
    if (!types.includes(b.type)) return false;
    if (wanted.size > 0) return wanted.has(pickKey(b)) || wanted.has(b.name);
    return true;
  });

  for (const boss of candidates) {
    if (out.attempted.length >= maxChallenges) break;
    const key = pickKey(boss);
    const reason = blockedReason(boss);
    if (reason) {
      out.skipped.push({ bossKey: key, name: boss.name, reason });
      continue;
    }
    try {
      const result = dryRun ? await preview(api, key, rules) : await challenge(api, key, rules);
      out.attempted.push({ bossKey: key, name: boss.name, dryRun, win: result?.battle?.win, result });
    } catch (err) {
      out.errors.push({ bossKey: key, name: boss.name, error: err.message });
    }
  }

  if (!dryRun && out.attempted.length > 0) {
    try {
      out.claimed = await claimReward(api);
    } catch (err) {
      out.errors.push({ step: "claimReward", error: err.message });
    }
  }
  return out;
}

// 世界首领:窗口内协助 + 领奖。status 为 closed 时直接跳过,不浪费请求。
export async function runWorldBoss(api, { rules = {}, assistOnly = false } = {}) {
  const out = { status: null, assisted: [], attempted: [], claimed: null, errors: [] };
  out.status = await worldStatus(api).catch((err) => {
    out.errors.push({ step: "worldStatus", error: err.message });
    return null;
  });
  if (out.status?.status === "closed") return { ...out, skipped: "世界首领未开放" };

  const bosses = await listBosses(api, { type: BOSS_TYPE.WORLD });
  for (const boss of bosses) {
    const key = pickKey(boss);
    try {
      if (assistOnly) {
        out.assisted.push({ bossKey: key, result: await assist(api, key) });
      } else {
        const reason = blockedReason(boss);
        if (reason) {
          out.assisted.push({ bossKey: key, fallback: "assist", reason, result: await assist(api, key) });
        } else {
          out.attempted.push({ bossKey: key, result: await challenge(api, key, rules) });
        }
      }
    } catch (err) {
      out.errors.push({ bossKey: key, error: err.message });
    }
  }

  try {
    out.claimed = await claimReward(api);
  } catch (err) {
    out.errors.push({ step: "claimReward", error: err.message });
  }
  return out;
}

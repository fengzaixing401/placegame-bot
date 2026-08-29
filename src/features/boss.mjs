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
  const { bosses } = await bossSnapshot(api);
  return type ? bosses.filter((b) => b.type === type) : bosses;
}

// 一次 dynamic-view 同时取首领列表与次数信息,避免为了读门票再请求一遍。
export async function bossSnapshot(api) {
  const view = await dynamicView(api);
  const holder = view?.player ?? view?.character ?? view?.profile ?? view ?? {};
  return {
    bosses: pickList(view?.bosses, "bosses"),
    personalAttempts: holder.personalBossAttempts ?? null,
    mapAttempts: holder.bossAttempts ?? null
  };
}

// 剩余免费次数。字段名服务端可能用 freeRemaining / remainingFree,取首个是数字的。
export function freeAttemptsLeft(attempts) {
  if (!attempts || typeof attempts !== "object") return null;
  for (const k of ["freeRemaining", "remainingFree", "freeLeft", "free"]) {
    if (typeof attempts[k] === "number") return attempts[k];
  }
  return null;
}

// 难度取值在任何静态来源里都查不到(HAR 无命中,CLI 只有 "normal" 默认值),
// 只能从真实列表里发现:扫每行带 difficult 字样的数组字段。查不到就只有 "normal" 可信。
export function difficultyOptions(rows = []) {
  const found = new Set();
  for (const row of rows) {
    for (const [k, v] of Object.entries(row ?? {})) {
      if (!/difficult/i.test(k) || !Array.isArray(v)) continue;
      for (const item of v) {
        const key = typeof item === "string" ? item : item?.key ?? item?.value ?? item?.difficulty;
        if (key) found.add(String(key));
      }
    }
  }
  return [...found];
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

// preview 响应的胜率字段。placegame-mcp 的 BossPreview 里 predictedWin(bool)与
// chance(0-100)都是必填,故可信;仍按候选名兜底,免得服务端换名后闸门静默失效。
export function readForecast(p) {
  const num = (...names) => {
    for (const n of names) if (typeof p?.[n] === "number") return p[n];
    return null;
  };
  const bool = (...names) => {
    for (const n of names) if (typeof p?.[n] === "boolean") return p[n];
    return null;
  };
  return {
    chance: num("chance", "winChance", "winRate", "probability"),
    predictedWin: bool("predictedWin", "willWin", "canWin")
  };
}

// 胜率闸门。返回 null 表示放行,返回字符串表示拒绝原因。
// 闸门查不到数据时按拒绝处理 —— 闸门存在的意义就是宁可不打也不瞎打。
function winGate(forecast, { minWinChance = 0, requirePredictedWin = false }) {
  if (!minWinChance && !requirePredictedWin) return null;
  if (requirePredictedWin && forecast.predictedWin === false) return "预测会输";
  if (minWinChance > 0) {
    if (forecast.chance === null) {
      return requirePredictedWin && forecast.predictedWin === true
        ? null // 服务端只给了结论没给数值,结论是赢就放行
        : `预览未返回胜率,无法确认是否达到 ${minWinChance}%`;
    }
    if (forecast.chance < minWinChance) return `胜率 ${forecast.chance}% 低于阈值 ${minWinChance}%`;
  }
  if (requirePredictedWin && forecast.predictedWin === null && forecast.chance === null) {
    return "预览未返回任何胜负预测";
  }
  return null;
}

// ⑤ 按规则挑战首领。
// 地图首领与个人首领分开控制:个人首领必须 challengePersonal=true 且显式列出目标,
// 否则一次自动运行就会把免费次数打光甚至扣掉门票。
export async function runBosses(api, { types, rules = {}, maxChallenges = 5, dryRun = false } = {}) {
  const out = {
    difficulty: rules.difficulty ?? "normal",
    gate: {
      minWinChance: rules.minWinChance ?? 0,
      requirePredictedWin: rules.requirePredictedWin === true,
      useTickets: rules.useTickets === true
    },
    attempted: [],
    skipped: [],
    claimed: null,
    errors: []
  };

  const allowPersonal = rules.challengePersonal === true;
  const activeTypes = types ?? (allowPersonal ? [BOSS_TYPE.MAP, BOSS_TYPE.PERSONAL] : [BOSS_TYPE.MAP]);
  const { bosses, personalAttempts } = await bossSnapshot(api);
  out.freeAttemptsLeft = freeAttemptsLeft(personalAttempts);

  const mapWanted = new Set([].concat(rules.mapBosses ?? []));
  const personalWanted = new Set([].concat(rules.personalBosses ?? []));
  const listed = (set, boss) => set.has(pickKey(boss)) || set.has(boss.name);

  const candidates = [];
  for (const boss of bosses) {
    if (!activeTypes.includes(boss.type)) continue;
    if (boss.type === BOSS_TYPE.PERSONAL) {
      // 个人首领只打点名的:留空不等于"全打",否则等于没有设置过程
      if (!allowPersonal) continue;
      if (personalWanted.size === 0) {
        out.skipped.push({ bossKey: pickKey(boss), name: boss.name, reason: "未在 personalBosses 中列出" });
        continue;
      }
      if (!listed(personalWanted, boss)) continue;
    } else if (mapWanted.size > 0 && !listed(mapWanted, boss)) {
      continue;
    }
    candidates.push(boss);
  }

  for (const boss of candidates) {
    if (out.attempted.length >= maxChallenges) break;
    const key = pickKey(boss);
    const label = { bossKey: key, name: boss.name };
    const reason = blockedReason(boss);
    if (reason) {
      out.skipped.push({ ...label, reason });
      continue;
    }

    // 门票闸门:接口没有门票参数,免费次数用尽后服务端自动扣票,只能在这里提前拦下
    if (boss.type === BOSS_TYPE.PERSONAL && !out.gate.useTickets) {
      const left = out.freeAttemptsLeft;
      if (left === null) {
        out.skipped.push({ ...label, reason: "读不到免费次数,已按不使用门票跳过" });
        continue;
      }
      if (left <= 0) {
        out.skipped.push({ ...label, reason: "免费次数已用尽,且未允许使用门票" });
        continue;
      }
    }

    try {
      if (dryRun) {
        const result = await preview(api, key, rules);
        out.attempted.push({ ...label, dryRun: true, forecast: readForecast(result), result });
        continue;
      }

      let forecast = null;
      if (out.gate.minWinChance > 0 || out.gate.requirePredictedWin) {
        // 闸门本身失败就不打:preview 拿不到结论时挑战等于盲赌
        let previewed;
        try {
          previewed = await preview(api, key, rules);
        } catch (err) {
          out.skipped.push({ ...label, reason: `预览失败,未挑战:${err.message}` });
          continue;
        }
        forecast = readForecast(previewed);
        const rejected = winGate(forecast, out.gate);
        if (rejected) {
          out.skipped.push({ ...label, reason: rejected, forecast });
          continue;
        }
      }

      const result = await challenge(api, key, rules);
      out.attempted.push({ ...label, dryRun: false, forecast, win: result?.battle?.win, result });
      if (boss.type === BOSS_TYPE.PERSONAL && typeof out.freeAttemptsLeft === "number") {
        out.freeAttemptsLeft -= 1;
      }
    } catch (err) {
      out.errors.push({ ...label, error: err.message });
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

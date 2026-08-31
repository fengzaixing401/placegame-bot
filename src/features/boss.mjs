import { unwrap, pickList, pickKey } from "../util.mjs";
import { dynamicView } from "./collect.mjs";
import { difficulty as difficultyLabel } from "../labels.mjs";

// 首领类型(dynamic-view 的 data.bosses[].type)
export const BOSS_TYPE = { PERSONAL: "personal", MAP: "map", WORLD: "world" };

// 数值字段读不到就给 null。渲染层一律"读不到就少写一行",不拿 undefined 拼句子。
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// 免费/门票次数。真号实测:只有 personal 类型的首领带 personalAttemptPool,
// 且它挂在每个首领对象上,不在玩家快照里 —— 早先按 player.personalBossAttempts 读恒为 null,
// 使"不允许用门票"的闸门从未真正生效过。
// {freeRemaining, freeLimit, ticketUsed, ticketLimit, nextTicketCost}
export function attemptPool(row) {
  const pool = row?.personalAttemptPool;
  return pool && typeof pool === "object" ? pool : null;
}

// 能否挑战:真实字段只有 blockedReason(空串=可挑战)。
// 顶层没有 available,也没有 remainingAttemptCount —— 21 个首领的字段全集里都不存在,
// 早先读这两个等于恒真,拿不到任何拦截效果。
export function isChallengeable(row) {
  return blockedReason(row) === null;
}

// 挑战闸门。难度可选:每个难度档各有自己的 blockedReason,选了哪档就要看哪档,
// 只看行级会漏掉"困难档材料不够"这类只在档位上体现的阻挡。
export function blockedReason(row, difficulty) {
  if (!row) return "首领不存在";
  // 服务端用空字符串表示"无阻挡原因",故只在非空时当作被阻挡
  if (typeof row.blockedReason === "string" && row.blockedReason.trim() !== "") return row.blockedReason;
  if (difficulty) {
    const perDiff = difficultyDetail(row, difficulty)?.blockedReason;
    if (typeof perDiff === "string" && perDiff.trim() !== "") return perDiff;
  }
  // 个人首领:免费次数与门票都空了就是真打不了,服务端此时不给 blockedReason
  const pool = attemptPool(row);
  if (pool) {
    const free = typeof pool.freeRemaining === "number" ? pool.freeRemaining : null;
    const ticketLeft =
      typeof pool.ticketLimit === "number" && typeof pool.ticketUsed === "number"
        ? pool.ticketLimit - pool.ticketUsed
        : null;
    if (free !== null && free <= 0 && ticketLeft !== null && ticketLeft <= 0) return "今日免费次数与门票次数都已用尽";
  }
  return null;
}

// 首领列表来自 dynamic-view(该端点不接受参数),源码中没有 /api/client/view-sections。
export async function listBosses(api, { type } = {}) {
  const { bosses } = await bossSnapshot(api);
  return type ? bosses.filter((b) => b.type === type) : bosses;
}

// 一次 dynamic-view 取首领列表。次数信息在每个个人首领自己的 personalAttemptPool 里,
// 玩家快照里没有汇总字段,所以不再单独抽一份出来。
export async function bossSnapshot(api) {
  const view = await dynamicView(api);
  return { bosses: pickList(view?.bosses, "bosses") };
}

// 今日剩余免费次数。取所有个人首领里的最小值。
// 实测样本里 9 个首领的池值完全一致(5/5、门票用 0),但那是满值状态 ——
// 满值下"全账号共享一个池"与"每个首领各有一池"表现相同,无从区分。
// 取最小值在两种模型下都不会超额:真共享则最小值就是池值;真独立则宁可早停也不多扣门票。
export function freeAttemptsLeft(rows = []) {
  let min = null;
  for (const row of rows) {
    const pool = attemptPool(row);
    if (!pool || typeof pool.freeRemaining !== "number") continue;
    min = min === null ? pool.freeRemaining : Math.min(min, pool.freeRemaining);
  }
  return min;
}

// 难度选项。真号实测每个首领自带 difficultyOptions: [{key,name}] —— 三类首领都有,
// 取值 normal 普通 / hard 困难 / nightmare 噩梦。名字直接用服务端给的,不本地翻译。
export function difficultyOptions(rows = []) {
  const found = new Map();
  for (const row of rows) {
    for (const item of row?.difficultyOptions ?? []) {
      const key = typeof item === "string" ? item : item?.key ?? item?.value ?? item?.difficulty;
      if (!key || found.has(String(key))) continue;
      found.set(String(key), { key: String(key), name: item?.name ?? String(key) });
    }
  }
  return [...found.values()];
}

// 某个首领某一难度档的完整信息。每档自带胜率、消耗与阻挡原因,
// 与游戏内难度选择界面同源 —— 面板据此显示,不必额外调 preview。
export function difficultyDetail(row, difficulty = "normal") {
  return (row?.difficultyOptions ?? []).find((o) => (o?.key ?? o) === difficulty) ?? null;
}

// 该档要扣几张门票。真号实测按首领类型分野:
//   个人首领 三档全是 0 —— 它扣的是 personalAttemptPool 的免费次数/门票池,不走这个字段
//   地图/世界 普通 0 / 困难 1 / 噩梦 2
// 所以"不允许用门票"必须同时管这两条路径:只看 personalAttemptPool 的旧写法,
// 在选困难档打地图首领时形同虚设,门票照扣。
export function ticketCost(row, difficulty = "normal") {
  const cost = difficultyDetail(row, difficulty)?.ticketCost;
  return typeof cost === "number" ? cost : null;
}

// 挑战参数的可选项(技能/战术/词缀/目标部位)。服务端在每个首领的 challengeOptions 里
// 带全了中文名,页面据此渲染下拉,用户不必手写 key。
export function challengeOptions(rows = []) {
  const out = { skills: [], buffs: [], affixes: [], targetSlots: [] };
  const seen = { skills: new Set(), buffs: new Set(), affixes: new Set(), targetSlots: new Set() };
  for (const row of rows) {
    const co = row?.challengeOptions;
    if (!co || typeof co !== "object") continue;
    for (const group of ["skills", "buffs", "affixes"]) {
      for (const item of co[group] ?? []) {
        const key = typeof item === "string" ? item : item?.key;
        if (!key || seen[group].has(String(key))) continue;
        seen[group].add(String(key));
        out[group].push({
          key: String(key),
          name: item?.name ?? String(key),
          ...(typeof item?.level === "number" ? { level: item.level } : {}),
          ...(typeof item?.rewardMultiplier === "number" ? { rewardMultiplier: item.rewardMultiplier } : {})
        });
      }
    }
    for (const s of co.targetSlots ?? []) {
      const key = typeof s === "string" ? s : s?.key;
      if (!key || seen.targetSlots.has(String(key))) continue;
      seen.targetSlots.add(String(key));
      out.targetSlots.push(String(key));
    }
  }
  return out;
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

// 协作不扣门票也不扣挑战次数(响应里没有 cost 字段),重发最坏只是多提交一次伤害,
// 所以这里显式开退避重试 —— 场次只开一小时,超时丢掉就等下一场了。
export async function assist(api, bossKey) {
  if (!bossKey) throw new Error("assist 需要 bossKey");
  return unwrap(await api.request("/api/boss/assist", { method: "POST", body: { bossKey }, retries: 2 }));
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
  // 个人首领与地图首领各有自己的难度设置:两类首领在页面上是两个面板,
  // 共用一个 difficulty 会让其中一个面板的选择被另一个悄悄改掉。
  const difficultyFor = (boss) =>
    (boss?.type === BOSS_TYPE.PERSONAL ? rules.personalDifficulty : rules.difficulty) ?? "normal";

  const out = {
    difficulty: rules.difficulty ?? "normal",
    personalDifficulty: rules.personalDifficulty ?? "normal",
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

  // 调用方显式指定类型(三个动作各打一类)。缺省只打地图首领 ——
  // 个人首领次数有限,绝不能被"没指定类型"顺带打掉。
  const activeTypes = types ?? [BOSS_TYPE.MAP];
  const { bosses } = await bossSnapshot(api);
  out.freeAttemptsLeft = freeAttemptsLeft(bosses);

  const mapWanted = new Set([].concat(rules.mapBosses ?? []));
  const personalWanted = new Set([].concat(rules.personalBosses ?? []));
  const listed = (set, boss) => set.has(pickKey(boss)) || set.has(boss.name);

  const candidates = [];
  for (const boss of bosses) {
    if (!activeTypes.includes(boss.type)) continue;
    if (boss.type === BOSS_TYPE.PERSONAL) {
      // 个人首领只打点名的:留空不等于"全打",否则等于没有设置过程
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
    const difficulty = difficultyFor(boss);
    // difficulty 记进每条结果:两类首领难度不同,日志里不写清楚就分不出这一场打的是哪档。
    // refreshText 是服务端自报的刷新规则(地图「每 2 小时刷新」/ 个人「共享每日 5 次免费…」),
    // 一并记下是因为地图首领被拦时服务端给的原话是「今日挑战次数已用尽。」——
    // 实测地图首领不受每日次数限制、只受刷新时间限制,这句措辞会把人带偏。
    // 原话照登不改写,另附刷新规则让日志自己说清楚到底在等什么。
    const label = { bossKey: key, name: boss.name, difficulty, refreshText: boss.refreshText ?? null };
    const reason = blockedReason(boss, difficulty);
    if (reason) {
      out.skipped.push({ ...label, reason });
      continue;
    }

    // 门票闸门。两条独立的扣票路径都要管:
    //   ① 难度档自带 ticketCost(地图/世界首领的困难 1 张、噩梦 2 张)—— 权威字段,优先看
    //   ② 个人首领的免费次数用尽后服务端自动扣 personalAttemptPool 的门票,接口没有开关,
    //      只能在这里提前停手
    if (!out.gate.useTickets) {
      const cost = ticketCost(boss, difficulty);
      // 原因是给人看的,难度写游戏内档位名。优先用服务端给的 name(它才是游戏里显示的那个),
      // 读不到该档时回落到本地表 —— 恰好 cost===null 就是读不到那档的情形。
      const dName = difficultyDetail(boss, difficulty)?.name ?? difficultyLabel(difficulty);
      if (cost === null) {
        out.skipped.push({ ...label, reason: `读不到「${dName}」难度的门票消耗,已按不使用门票跳过` });
        continue;
      }
      if (cost > 0) {
        out.skipped.push({ ...label, reason: `「${dName}」难度要扣 ${cost} 张门票,未允许使用门票` });
        continue;
      }
      if (attemptPool(boss)) {
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
    }

    // 发给服务端的难度必须是这一类首领自己的那档,不能直接透传 rules.difficulty
    const bossRules = { ...rules, difficulty };

    try {
      if (dryRun) {
        const result = await preview(api, key, bossRules);
        out.attempted.push({ ...label, dryRun: true, forecast: readForecast(result), result });
        continue;
      }

      let forecast = null;
      if (out.gate.minWinChance > 0 || out.gate.requirePredictedWin) {
        // 先用难度档自带的胜率筛一遍:这是游戏内难度界面显示的那个数,
        // 明显不达标就不必再花一次 preview 请求。
        const baseline = readForecast(difficultyDetail(boss, difficulty));
        const preRejected = winGate(baseline, out.gate);
        if (preRejected) {
          out.skipped.push({ ...label, reason: preRejected, forecast: baseline, source: "难度档预估" });
          continue;
        }

        // 档位胜率不含技能/战术/词缀的影响,过了初筛仍要按实际参数再确认一次。
        // 闸门本身失败就不打:preview 拿不到结论时挑战等于盲赌
        let previewed;
        try {
          previewed = await preview(api, key, bossRules);
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

      const result = await challenge(api, key, bossRules);
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

// 协作闸门。世界首领能不能协作只看 assistBlockedReason,与挑战用的 blockedReason 是两个字段:
// 真号实测 7 个世界首领 blockedReason 全为空(看着都能打)、assistBlockedReason 全是
// 「当前世界首领场次未开放或已经结束。」—— 拿 blockedReason 判协作等于恒放行。
export function assistBlockedReason(row) {
  if (!row) return "首领不存在";
  const reason = row.assistBlockedReason;
  if (typeof reason === "string" && reason.trim() !== "") return reason;
  const inst = row.worldInstance;
  if (inst && typeof inst === "object") {
    const left = inst.remainingAttemptCount;
    if (typeof left === "number" && left <= 0) return "本场次协作次数已用尽";
  }
  return null;
}

// 一个世界首领的协作,循环到本场次次数用尽。
// 真号实测每场次 maxAttemptCount=3,而早先每个首领只协作 1 次,等于白丢 2/3 的伤害贡献。
// 循环靠 assist 响应自带的 worldBoss 段驱动(remainingAttemptCount/status),不必反复拉 dynamic-view。
//
// 停手条件按"宁可少打也不空转"排:
//   ① assist 报错 —— 记进 errors,这个首领就此收手
//   ② 响应里读不到 worldBoss.remainingAttemptCount —— 不猜次数
//   ③ 次数归零,或场次已不是 active(被全服打死 defeated / 时间到 ended)
//   ④ 剩余次数没往下走 —— 服务端没把这次算进去,再发只是空转
async function assistUntilExhausted(api, label, out) {
  let lastLeft = null;
  for (let round = 1; ; round += 1) {
    let result;
    try {
      result = await assist(api, label.bossKey);
    } catch (err) {
      out.errors.push({ ...label, round, error: err.message });
      return;
    }

    // 判定与展示用的字段都记在浅层(assisted[i] 深度 2):
    // 深层 result.worldBoss.* 会被落库裁剪掉,整个 result 又对渲染毫无用处 ——
    // resultNote 只读 message,协作响应没有这个字段,存进去只会把结果行顶过 60000 字上限。
    const inst = result?.worldBoss;
    const left = num(inst?.remainingAttemptCount);
    out.assisted.push({
      ...label,
      round,
      damage: num(result?.damage),
      myDamagePercent: num(inst?.myDamagePercent),
      myAttemptCount: num(inst?.myAttemptCount),
      maxAttemptCount: num(inst?.maxAttemptCount),
      remainingAttemptCount: left,
      hpPercent: num(inst?.hpPercent),
      status: inst?.status ?? null
    });

    if (left === null || left <= 0) return;
    if (inst.status && inst.status !== "active") return;
    if (lastLeft !== null && left >= lastLeft) return;
    lastLeft = left;
  }
}

// ⑤ 世界首领:只参与协作讨伐 + 领奖,不主动挑战。
// 世界首领是全服共同消耗一个血条的场次战,个人主攻既无难度可选也无"胜率"可言;
// 服务端虽然也接受 challenge,但那会按困难/噩梦档扣掉门票,与"只参与协作"的本意相反。
export async function runWorldBoss(api, { rules = {} } = {}) {
  const out = { status: null, assisted: [], skipped: [], claimed: null, errors: [] };
  out.status = await worldStatus(api).catch((err) => {
    out.errors.push({ step: "worldStatus", error: err.message });
    return null;
  });

  const bosses = await listBosses(api, { type: BOSS_TYPE.WORLD });
  const wanted = new Set([].concat(rules.worldBosses ?? []));
  for (const boss of bosses) {
    const key = pickKey(boss);
    // 名单为空表示"全部参与";点了名就只协作名单里那几个
    if (wanted.size > 0 && !wanted.has(key) && !wanted.has(boss.name)) continue;
    // name 供页面显示中文名(否则日志里只剩 bossKey 裸键)
    const label = { bossKey: key, name: boss.name };
    const reason = assistBlockedReason(boss);
    if (reason) {
      out.skipped.push({ ...label, reason, refreshText: boss.refreshText ?? null });
      continue;
    }
    await assistUntilExhausted(api, label, out);
  }

  // 一个都没协作成功就不必领奖,省一次请求
  if (out.assisted.length > 0) {
    try {
      out.claimed = await claimReward(api);
    } catch (err) {
      out.errors.push({ step: "claimReward", error: err.message });
    }
  }
  return out;
}

import { pickList, pickKey, num, bool, text, firstNum, firstBool, asSet, asArray } from "../util.mjs";
import { dynamicView } from "./collect.mjs";
import { difficulty as difficultyLabel } from "../labels.mjs";

// 首领类型(dynamic-view 的 data.bosses[].type)
export const BOSS_TYPE = { PERSONAL: "personal", MAP: "map", WORLD: "world" };

// ============================================================================
// 一、纯字段读取。全部无副作用,读不到一律 null —— 渲染层"读不到就少写一行",
// 不拿 undefined 拼句子。
// ============================================================================

// 免费/门票次数。真号实测:只有 personal 类型的首领带 personalAttemptPool,
// 且它挂在每个首领对象上,不在玩家快照里 —— 早先按 player.personalBossAttempts 读恒为 null,
// 使"不允许用门票"的闸门从未真正生效过。
// {freeRemaining, freeLimit, ticketUsed, ticketLimit, nextTicketCost}
export function attemptPool(row) {
  const pool = row?.personalAttemptPool;
  return pool && typeof pool === "object" ? pool : null;
}

// 个人首领整轮能打几次。池子是共享的,取任意一个带池子的首领即可。
//   容量 = 剩余免费次数 +(允许用票时)还没用掉的门票额度
//   预算 = min(用户设的每日次数, 容量)
// 读不到池子时给 1:不猜次数,保持"至少按老行为打一次"。
export function personalBudget(rows = [], rules = {}, useTickets = false) {
  const wanted = num(rules.personalMaxPerDay);
  const pool = rows.map(attemptPool).find(Boolean);
  if (!pool) return wanted === null ? 1 : Math.max(1, wanted);

  const free = num(pool.freeRemaining) ?? 0;
  const ticketLeft = useTickets ? Math.max(0, (num(pool.ticketLimit) ?? 0) - (num(pool.ticketUsed) ?? 0)) : 0;
  const capacity = free + ticketLeft;
  if (wanted === null) return capacity;
  return Math.max(0, Math.min(wanted, capacity));
}

// 挑战闸门。难度可选:每个难度档各有自己的 blockedReason,选了哪档就要看哪档,
// 只看行级会漏掉"困难档材料不够"这类只在档位上体现的阻挡。
// 返回 null 表示可挑战。
export function blockedReason(row, difficulty) {
  if (!row) return "首领不存在";
  // 服务端用空字符串表示"无阻挡原因",故只在非空时当作被阻挡
  const rowReason = text(row.blockedReason);
  if (rowReason) return rowReason;

  if (difficulty) {
    const perDiff = text(difficultyDetail(row, difficulty)?.blockedReason);
    if (perDiff) return perDiff;
  }

  // 个人首领:免费次数与门票都空了就是真打不了,服务端此时不给 blockedReason
  const pool = attemptPool(row);
  if (pool) {
    const free = num(pool.freeRemaining);
    const ticketLeft =
      num(pool.ticketLimit) !== null && num(pool.ticketUsed) !== null ? num(pool.ticketLimit) - num(pool.ticketUsed) : null;
    if (free !== null && free <= 0 && ticketLeft !== null && ticketLeft <= 0) return "今日免费次数与门票次数都已用尽";
  }
  return null;
}

// 能否挑战:真实字段只有 blockedReason(空串=可挑战)。
// 顶层没有 available,也没有 remainingAttemptCount —— 21 个首领的字段全集里都不存在,
// 早先读这两个等于恒真,拿不到任何拦截效果。
export function isChallengeable(row) {
  return blockedReason(row) === null;
}

// 今日剩余免费次数。取所有个人首领里的最小值。
// 实测样本里 9 个首领的池值完全一致(5/5、门票用 0),但那是满值状态 ——
// 满值下"全账号共享一个池"与"每个首领各有一池"表现相同,无从区分。
// 取最小值在两种模型下都不会超额:真共享则最小值就是池值;真独立则宁可早停也不多扣门票。
export function freeAttemptsLeft(rows = []) {
  let min = null;
  for (const row of rows) {
    const free = num(attemptPool(row)?.freeRemaining);
    if (free === null) continue;
    min = min === null ? free : Math.min(min, free);
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
  return num(difficultyDetail(row, difficulty)?.ticketCost);
}

// 挑战参数的可选项(技能/战术/词缀/目标部位)。服务端在每个首领的 challengeOptions 里
// 带全了中文名,页面据此渲染下拉,用户不必手写 key。
export function challengeOptions(rows = []) {
  const out = { skills: [], buffs: [], affixes: [], targetSlots: [] };
  const seen = { skills: new Set(), buffs: new Set(), affixes: new Set(), targetSlots: new Set() };

  const collectNamed = (group, items) => {
    for (const item of items ?? []) {
      const key = typeof item === "string" ? item : item?.key;
      if (!key || seen[group].has(String(key))) continue;
      seen[group].add(String(key));
      out[group].push({
        key: String(key),
        name: item?.name ?? String(key),
        ...(num(item?.level) !== null ? { level: item.level } : {}),
        ...(num(item?.rewardMultiplier) !== null ? { rewardMultiplier: item.rewardMultiplier } : {})
      });
    }
  };

  for (const row of rows) {
    const co = row?.challengeOptions;
    if (!co || typeof co !== "object") continue;
    for (const group of ["skills", "buffs", "affixes"]) collectNamed(group, co[group]);
    for (const slot of co.targetSlots ?? []) {
      const key = typeof slot === "string" ? slot : slot?.key;
      if (!key || seen.targetSlots.has(String(key))) continue;
      seen.targetSlots.add(String(key));
      out.targetSlots.push(String(key));
    }
  }
  return out;
}

// preview 响应的胜率字段。placegame-mcp 的 BossPreview 里 predictedWin(bool)与
// chance(0-100)都是必填,故可信;仍按候选名兜底,免得服务端换名后闸门静默失效。
export function readForecast(preview) {
  return {
    chance: firstNum(preview, ["chance", "winChance", "winRate", "probability"]),
    predictedWin: firstBool(preview, ["predictedWin", "willWin", "canWin"])
  };
}

// 协作闸门。世界首领能不能协作只看 assistBlockedReason,与挑战用的 blockedReason 是两个字段:
// 真号实测 7 个世界首领 blockedReason 全为空(看着都能打)、assistBlockedReason 全是
// 「当前世界首领场次未开放或已经结束。」—— 拿 blockedReason 判协作等于恒放行。
export function assistBlockedReason(row) {
  if (!row) return "首领不存在";
  const reason = text(row.assistBlockedReason);
  if (reason) return reason;
  const left = num(row.worldInstance?.remainingAttemptCount);
  if (left !== null && left <= 0) return "本场次协作次数已用尽";
  return null;
}

// ============================================================================
// 二、端点封装
// ============================================================================

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

export async function worldStatus(api) {
  return api.get("/api/boss/world-status");
}

// challenge 与 preview 共用同一组字段(CLI bossFields)。
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
  return api.post("/api/boss/preview", challengeBody(bossKey, rules));
}

export async function challenge(api, bossKey, rules) {
  if (!bossKey) throw new Error("challenge 需要 bossKey");
  return api.post("/api/boss/challenge", challengeBody(bossKey, rules));
}

// 协作不扣门票也不扣挑战次数(响应里没有 cost 字段),重发最坏只是多提交一次伤害,
// 所以这里显式开退避重试 —— 场次只开一小时,超时丢掉就等下一场了。
export async function assist(api, bossKey) {
  if (!bossKey) throw new Error("assist 需要 bossKey");
  return api.post("/api/boss/assist", { bossKey }, { retries: 2 });
}

export async function claimReward(api) {
  return api.post("/api/boss/claim-reward", {});
}

// ============================================================================
// 三、闸门。都是纯函数,返回 null 表示放行,返回字符串表示拒绝原因。
// ============================================================================

// 胜率闸门。闸门查不到数据时按拒绝处理 —— 闸门存在的意义就是宁可不打也不瞎打。
function winGate(forecast, { minWinChance = 0, requirePredictedWin = false }) {
  if (!minWinChance && !requirePredictedWin) return null;
  if (requirePredictedWin && forecast.predictedWin === false) return "预测会输";
  if (minWinChance > 0) {
    if (forecast.chance === null) {
      // 服务端只给了结论没给数值,结论是赢就放行
      return requirePredictedWin && forecast.predictedWin === true
        ? null
        : `预览未返回胜率,无法确认是否达到 ${minWinChance}%`;
    }
    if (forecast.chance < minWinChance) return `胜率 ${forecast.chance}% 低于阈值 ${minWinChance}%`;
  }
  if (requirePredictedWin && forecast.predictedWin === null && forecast.chance === null) {
    return "预览未返回任何胜负预测";
  }
  return null;
}

// 门票闸门。两条独立的扣票路径都要管:
//   ① 难度档自带 ticketCost(地图/世界首领的困难 1 张、噩梦 2 张)—— 权威字段,优先看
//   ② 个人首领的免费次数用尽后服务端自动扣 personalAttemptPool 的门票,接口没有开关,
//      只能在这里提前停手
// 只在"不允许使用门票"时有意义。
function ticketGate(boss, difficulty, freeLeft) {
  const cost = ticketCost(boss, difficulty);
  // 原因是给人看的,难度写游戏内档位名。优先用服务端给的 name(它才是游戏里显示的那个),
  // 读不到该档时回落到本地表 —— 恰好 cost===null 就是读不到那档的情形。
  const dName = difficultyDetail(boss, difficulty)?.name ?? difficultyLabel(difficulty);

  if (cost === null) return `读不到「${dName}」难度的门票消耗,已按不使用门票跳过`;
  if (cost > 0) return `「${dName}」难度要扣 ${cost} 张门票,未允许使用门票`;
  if (!attemptPool(boss)) return null;
  if (freeLeft === null) return "读不到免费次数,已按不使用门票跳过";
  if (freeLeft <= 0) return "免费次数已用尽,且未允许使用门票";
  return null;
}

// 胜率闸门的两段判定。闸门未开启时不做任何预览,直接放行。
// 返回 {ok:true, forecast} 或 {ok:false, reason, forecast?, source?}。
async function resolveForecast(api, boss, difficulty, bossRules, gate) {
  if (gate.minWinChance <= 0 && !gate.requirePredictedWin) return { ok: true, forecast: null };

  // 先用难度档自带的胜率筛一遍:这是游戏内难度界面显示的那个数,
  // 明显不达标就不必再花一次 preview 请求。
  const baseline = readForecast(difficultyDetail(boss, difficulty));
  const preRejected = winGate(baseline, gate);
  if (preRejected) return { ok: false, reason: preRejected, forecast: baseline, source: "难度档预估" };

  // 档位胜率不含技能/战术/词缀的影响,过了初筛仍要按实际参数再确认一次。
  // 闸门本身失败就不打:preview 拿不到结论时挑战等于盲赌
  let previewed;
  try {
    previewed = await preview(api, pickKey(boss), bossRules);
  } catch (err) {
    return { ok: false, reason: `预览失败,未挑战:${err.message}` };
  }
  const forecast = readForecast(previewed);
  const rejected = winGate(forecast, gate);
  return rejected ? { ok: false, reason: rejected, forecast } : { ok: true, forecast };
}

// ============================================================================
// 四、候选名单
// ============================================================================

// 名单取不到就带着已记下的错误返回,不抛 —— 抛出去会让整个任务 status=error、
// result_json 为空,日志上只剩一句"请求超时",看不出这一轮到底做了什么。
//
// 取首领名单是所有首领动作的第一步,这一个 GET 抖一下整轮就没了 ——
// 实测 boss.world 有一轮整个任务 status=error、result_json 为空,7 个首领一个都没打,
// 就因为这里超时。api-client 已经按 800/2000ms 退避重试过两次(前后约 3 秒),
// 但游戏服务端抽风(实测会返 Cloudflare 502)往往比这更久,所以隔一段时间再试一次。
//
// 只补一次、间隔固定,不做指数退避:世界首领的场次窗口是 1 小时,幂等键按窗口算,
// 这一轮错过就得等下一个窗口,值得多花十几秒;但再多试也只是把窗口耗在等待上。
const SNAPSHOT_RETRY_MS = 12000;

async function bossesOrNull(api, type, out) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      return await listBosses(api, { type });
    } catch (err) {
      if (attempt === 2) {
        out.errors.push({ step: "listBosses", error: err.message });
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_RETRY_MS));
    }
  }
  return null;
}

// 按类型与名单筛出本轮要打的候选。
// 三类首领的默认策略根本不同,不能统一:
//   地图首领  名单留空 = 打列表里所有可挑战的
//   个人首领  必须点名,留空 = 一个都不打(次数有限,不能被"没配置"顺带打光)
//   世界首领  在 runWorldBoss 里处理,名单留空 = 全部参与
function selectCandidates(bosses, { activeTypes, rules, skip }) {
  const mapWanted = asSet(rules.mapBosses);
  const personalWanted = asSet(rules.personalBosses);
  const listed = (set, boss) => set.has(pickKey(boss)) || set.has(boss.name);

  const candidates = [];
  for (const boss of bosses) {
    if (!activeTypes.includes(boss.type)) continue;
    if (boss.type === BOSS_TYPE.PERSONAL) {
      // 个人首领只打点名的:留空不等于"全打",否则等于没有设置过程
      if (personalWanted.size === 0) {
        skip({ bossKey: pickKey(boss), name: boss.name, reason: "未在 personalBosses 中列出" });
        continue;
      }
      if (!listed(personalWanted, boss)) continue;
    } else if (mapWanted.size > 0 && !listed(mapWanted, boss)) {
      continue;
    }
    candidates.push(boss);
  }
  return candidates;
}

// 个人首领的次数是整轮预算,不是每个首领各算一次:服务端的 personalAttemptPool
// 是共享一池(实测 freeLimit 5 + ticketLimit 5)。早先"点名的每个首领各打一次"
// 让只点了一个首领的账号每天只用掉 1 次,剩下 4 次免费白放过期。
//
// 预算取三者最小:用户设的每日次数、池子还剩多少、以及门票闸门允许不允许动票。
// 读不到池子就退回 1(不猜次数),循环体里的闸门仍会逐次复核。
function expandPersonalBudget(candidates, rules, useTickets) {
  const cycle = candidates.filter((b) => b.type === BOSS_TYPE.PERSONAL);
  if (cycle.length === 0) return candidates;

  const budget = personalBudget(candidates, rules, useTickets);
  if (budget <= cycle.length) return candidates;

  // 轮转补齐:点名 2 个、预算 5 次 => A B A B A
  const extra = [];
  for (let i = cycle.length; i < budget; i += 1) extra.push(cycle[i % cycle.length]);
  return [...candidates, ...extra];
}

// ============================================================================
// 五、编排
// ============================================================================

// ---- 落库前的裁剪 ----
// 每次挑战/预览的原始响应里带着 700+ 条 notices,整个塞进 result 会让 result_json
// 必然超限、退化到最狠的裁剪档(maxArray 5 / maxDepth 4)—— 面板上只剩
// 「[对象,超出深度]」,9 次挑战只能看到 5 条,连消耗和掉落都看不到(2026-09-20 实测)。
// 这里按 log.js 的 bossAttempt() 实际读到的字段裁剪:**多留只会再次撑爆,少留则日志凭空少一行**。
const BATTLE_FIELDS = [
  "win",
  "rounds",
  "durationSeconds",
  "winChance",
  "playerHpRemaining",
  "playerHp",
  "bossHpRemaining",
  "bossHp"
];

// 只留有值的数值/布尔字段 —— 一堆 null 也是白占体积
function pickFields(source, fields) {
  const out = {};
  for (const k of fields) {
    const v = source?.[k];
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  return out;
}

// 掉落只留能拼出人话的三个字段(log.js 只读 name/quality/rareRank)
function digestDrops(drops) {
  return asArray(drops)
    .slice(0, 20)
    .map((d) => ({ name: text(d?.name), quality: text(d?.quality), rareRank: text(d?.rareRank) }));
}

export function digestChallengeResult(result) {
  if (!result || typeof result !== "object") return null;
  const { battle, rewards, cost } = result;
  const summary = rewards?.summary;
  const bottleneck = text(battle?.powerBottleneck);
  return {
    battle:
      battle && typeof battle === "object"
        ? { ...pickFields(battle, BATTLE_FIELDS), ...(bottleneck ? { powerBottleneck: bottleneck } : {}) }
        : null,
    rewards:
      rewards && typeof rewards === "object"
        ? {
            // summary 可能是数组也可能是一句话,原样带过去让渲染层自己 take()
            summary: Array.isArray(summary) ? summary.slice(0, 20) : (typeof summary === "string" ? summary : null),
            exp: num(rewards.exp),
            gold: num(rewards.gold),
            drops: digestDrops(rewards.drops)
          }
        : null,
    cost:
      cost && typeof cost === "object"
        ? {
            ticketCost: num(cost.ticketCost),
            ownedTickets: num(cost.ownedTickets),
            goldCost: num(cost.goldCost),
            materialCost: num(cost.materialCost),
            materialName: text(cost.materialName),
            materialKey: text(cost.materialKey),
            ownedMaterial: num(cost.ownedMaterial)
          }
        : null
  };
}

// 预览响应里渲染层只用 forecast(它已经在外面单独读过),其余全丢。
export function digestPreviewResult(result) {
  return result && typeof result === "object" ? pickFields(result, ["chance", "predictedWin"]) : null;
}

// 世界首领场次快照。渲染层只读 status/hpPercent/participantCount,
// 但 instanceId 留着 —— 它带窗口小时,排查「这一轮拿到的是哪一场」全靠它
// (2026-09-20 就是靠 `wb_..._14` 认出 16:00 那轮打的是已结束的 14:00 场)。
const WORLD_STATUS_FIELDS = [
  "status",
  "hpPercent",
  "participantCount",
  "currentHp",
  "maxHp",
  "completedPhaseCount",
  "endedAt",
  "guildDamage",
  "guildMemberCount",
  "maxAttemptCount"
];

export function digestWorldStatus(list) {
  return asArray(list).map((s) => ({
    bossKey: pickKey(s),
    instanceId: text(s?.instanceId),
    ...pickFields(s, WORLD_STATUS_FIELDS),
    ...(text(s?.status) ? { status: text(s.status) } : {})
  }));
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

  // 个人首领按预算重复排进候选(见 expandPersonalBudget),同一个首领被同一个原因
  // 拦住时只记一条 —— 否则一句「免费次数已用尽」会在日志里刷满整个预算的遍数。
  const skipSeen = new Set();
  const skip = (entry) => {
    const tag = `${entry.bossKey ?? ""}|${entry.reason ?? ""}`;
    if (skipSeen.has(tag)) return;
    skipSeen.add(tag);
    out.skipped.push(entry);
  };

  // 调用方显式指定类型(三个动作各打一类)。缺省只打地图首领 ——
  // 个人首领次数有限,绝不能被"没指定类型"顺带打掉。
  const activeTypes = types ?? [BOSS_TYPE.MAP];

  const bosses = await bossesOrNull(api, undefined, out);
  if (!bosses) return out;
  out.freeAttemptsLeft = freeAttemptsLeft(bosses);

  const selected = selectCandidates(bosses, { activeTypes, rules, skip });
  const candidates = activeTypes.includes(BOSS_TYPE.PERSONAL)
    ? expandPersonalBudget(selected, rules, out.gate.useTickets)
    : selected;

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

    const blocked = blockedReason(boss, difficulty);
    if (blocked) {
      skip({ ...label, reason: blocked });
      continue;
    }

    if (!out.gate.useTickets) {
      const ticketBlocked = ticketGate(boss, difficulty, out.freeAttemptsLeft);
      if (ticketBlocked) {
        skip({ ...label, reason: ticketBlocked });
        continue;
      }
    }

    // 发给服务端的难度必须是这一类首领自己的那档,不能直接透传 rules.difficulty
    const bossRules = { ...rules, difficulty };

    try {
      if (dryRun) {
        const result = await preview(api, key, bossRules);
        out.attempted.push({ ...label, dryRun: true, forecast: readForecast(result), result: digestPreviewResult(result) });
        continue;
      }

      const verdict = await resolveForecast(api, boss, difficulty, bossRules, out.gate);
      if (!verdict.ok) {
        skip({ ...label, reason: verdict.reason, forecast: verdict.forecast, source: verdict.source });
        continue;
      }

      const result = await challenge(api, key, bossRules);
      out.attempted.push({
        ...label,
        dryRun: false,
        forecast: verdict.forecast,
        win: result?.battle?.win,
        result: digestChallengeResult(result)
      });

      // 夹在 0:整轮次数可以超过免费额度(超出部分扣门票),真号上出现过
      // 免费余 4 打了 5 次、日志显示"免费余 -1"。免费次数不存在负数。
      if (boss.type === BOSS_TYPE.PERSONAL && typeof out.freeAttemptsLeft === "number") {
        out.freeAttemptsLeft = Math.max(0, out.freeAttemptsLeft - 1);
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
  out.status = await worldStatus(api)
    .then((list) => digestWorldStatus(list))
    .catch((err) => {
      out.errors.push({ step: "worldStatus", error: err.message });
      return null;
    });

  // 名单取不到就带着已记下的错误返回,不抛 —— 抛出去会让整个任务 status=error、
  // result_json 为空,日志上只剩一句"请求超时",看不出这一轮到底做了什么。
  const bosses = await bossesOrNull(api, BOSS_TYPE.WORLD, out);
  if (!bosses) return out;

  const wanted = asSet(rules.worldBosses);
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

// ============================================================================
// 六、WebUI 面板数据
// ============================================================================

// 每个首领只送页面用得上的字段。整行直接透传会把 21 份战斗预测和参与者榜单
// 一起塞进响应,页面一个也用不到。
function bossView(boss) {
  const view = {
    bossKey: pickKey(boss),
    name: boss.name ?? null,
    type: boss.type ?? null,
    mapName: boss.mapName ?? null,
    requiredLevel: num(boss.requiredLevel),
    // 服务端自报的刷新规则与当前可挑战次数。三类首领的限制根本不同 ——
    // 地图「每 2 小时刷新」(attempts 恒为 1,不受每日次数限制)、
    // 个人「共享每日 5 次免费,门票最多追加 5 次」、世界则是三个固定场次时段。
    // 面板照抄服务端原话,不本地推断,免得把三套限制讲成一套。
    refreshText: boss.refreshText ?? null,
    attempts: num(boss.attempts),
    // 各难度自带胜率与消耗,与游戏内难度选择界面同源
    difficulties: (boss.difficultyOptions ?? []).map((o) => ({
      key: o.key,
      name: o.name ?? o.key,
      chance: num(o.chance),
      predictedWin: bool(o.predictedWin),
      ticketCost: num(o.ticketCost),
      goldCost: num(o.goldCost),
      materialName: o.materialName ?? null,
      materialCost: num(o.materialCost),
      ownedMaterial: num(o.ownedMaterial),
      rewardPreview: Array.isArray(o.rewardPreview) ? o.rewardPreview : [],
      blockedReason: text(o.blockedReason)
    })),
    blockedReason: blockedReason(boss)
  };

  if (boss.type === BOSS_TYPE.PERSONAL) view.attemptPool = attemptPool(boss);

  // 世界首领只协作:送协作闸门与本场次进度,不送难度相关的胜率判断
  if (boss.type === BOSS_TYPE.WORLD) {
    view.assistBlockedReason = assistBlockedReason(boss);
    const inst = boss.worldInstance;
    view.instance = inst
      ? {
          status: inst.status ?? null,
          hpPercent: num(inst.hpPercent),
          participantCount: num(inst.participantCount),
          myAttemptCount: num(inst.myAttemptCount),
          maxAttemptCount: num(inst.maxAttemptCount),
          remainingAttemptCount: num(inst.remainingAttemptCount),
          rewardStatus: inst.rewardStatus ?? null
        }
      : null;
  }
  return view;
}

// 首领面板的整份数据。快照取不到就退回空集合 —— 面板能渲染多少算多少,
// 单项失败不影响其余(与 options 里其他面板的处理一致)。
export async function viewForOptions(api) {
  let bosses = [];
  let error = null;
  try {
    ({ bosses } = await bossSnapshot(api));
  } catch (err) {
    error = err.message;
  }

  // 按类型分组:页面上三类首领是三个面板,数量也不同(实测个人 9 / 地图 5 / 世界 7)。
  // 不硬编码数量 —— 等级与场次都会影响服务端返回哪些。
  const byType = { personal: [], map: [], world: [] };
  for (const boss of bosses) {
    const view = bossView(boss);
    byType[boss.type]?.push(view);
  }

  return {
    bosses: bosses.map(bossView),
    bossesByType: byType,
    // 查不到就只有 "normal" 可信 —— 不猜难度枚举
    difficulties: difficultyOptions(bosses),
    // 技能/战术/词缀/目标部位,服务端自带中文名
    challengeOptions: challengeOptions(bosses),
    freeAttemptsLeft: freeAttemptsLeft(bosses),
    error
  };
}

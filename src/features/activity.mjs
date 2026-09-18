import { pickList, pickKey } from "../util.mjs";
import { dynamicView } from "./collect.mjs";
import { activityProgress } from "../labels.mjs";

// 活跃度进度只在 bootstrap 里,dynamic-view 没有 daily 段。
export async function bootstrap(api) {
  return api.get("/api/client/bootstrap");
}

// 活跃宝箱现状:活跃点、七项任务进度、五个档位各自可领与否。
export async function activityStatus(api) {
  const data = await bootstrap(api);
  return { key: data?.daily?.key ?? null, ...activityProgress(data?.daily) };
}

// WebUI 活跃面板的数据。拿不到就置 null —— 面板少显示一块,不影响其余。
export async function viewForOptions(api) {
  try {
    return { status: await activityStatus(api), error: null };
  } catch (err) {
    return { status: null, error: err.message };
  }
}

// 可领取判定,镜像 CLI progress 展示层的三段逻辑。
export function isClaimable(row) {
  if (!row) return false;
  if (row.claimed === true) return false;
  if (row.available === false || row.unlocked === false) return false;
  return row.canClaim === true || row.completed === true;
}

// 任务 / 成就 / 图鉴三段领取的形状完全一样:从 dynamic-view 取名单、筛出可领的、
// 逐个领取、单项失败只记不改其余。抽成表驱动,免得三段几乎相同的代码各自漂移。
// 领取顺序即表序(与日志里的呈现顺序一致)。
const CLAIM_GROUPS = [
  { step: "quest", field: "quests", out: "quests", keyName: "questKey", keyOf: (r) => r.questKey ?? pickKey(r), claim: (api, k) => claimQuest(api, k) },
  { step: "achievement", field: "achievements", out: "achievements", keyName: "achievementKey", keyOf: (r) => r.achievementKey ?? pickKey(r), claim: (api, k) => claimAchievement(api, k) },
  { step: "codex", field: "codex", out: "codex", keyName: "rewardKey", keyOf: (r) => r.rewardKey ?? pickKey(r), claim: (api, k) => claimCodex(api, k) }
];

async function claimGroup(api, group, rows, errors) {
  const claimed = [];
  for (const row of rows.filter(isClaimable)) {
    const key = group.keyOf(row);
    try {
      claimed.push({ [group.keyName]: key, result: await group.claim(api, key) });
    } catch (err) {
      errors.push({ step: group.step, [group.keyName]: key, error: err.message });
    }
  }
  return claimed;
}

// 活跃宝箱的领取档位。未指定时按 bootstrap.daily 自己算活跃点,
// 再挑出「已达标且未领过」的档位 —— 档位阈值只存在于客户端,服务端不下发。
async function resolveDailyPoints(api, dailyPoints, out) {
  if (Array.isArray(dailyPoints)) return dailyPoints.map((point) => ({ point, name: null }));
  try {
    const st = await activityStatus(api);
    // 活跃点与七项进度记在浅层,落库裁剪后日志仍能说清「为什么只领了这几档」。
    out.activity = {
      score: st.score,
      doneCount: st.doneCount,
      questTotal: st.questTotal,
      quests: st.quests.map((q) => `${q.name} ${q.current}/${q.target}`),
      claimed: st.tiers.filter((t) => t.claimed).map((t) => t.name),
      pending: st.tiers.filter((t) => !t.claimed && !t.claimable).map((t) => `${t.name}(需 ${t.point} 点)`)
    };
    return st.claimable.map((t) => ({ point: t.point, name: t.name }));
  } catch (err) {
    out.errors.push({ step: "activityStatus", error: err.message });
    return [];
  }
}

// ⑥ 自动领活动与日志奖励。
// 任务/成就/图鉴没有独立列表端点,都从 dynamic-view 取。
export async function claimAll(api, { quests = true, achievements = true, daily = true, signIn = true, mail = true, codex = false, dailyPoints = null } = {}) {
  const out = { quests: [], achievements: [], codex: [], daily: [], signIn: null, mail: null, activity: null, errors: [] };
  const view = await dynamicView(api);

  const enabled = { quests, achievements, codex };
  for (const group of CLAIM_GROUPS) {
    if (!enabled[group.out]) continue;
    out[group.out] = await claimGroup(api, group, pickList(view?.[group.field], group.field), out.errors);
  }

  // daily/claim 的 point 是活跃宝箱档位
  if (daily) {
    for (const { point, name } of await resolveDailyPoints(api, dailyPoints, out)) {
      try {
        out.daily.push({ point, name, result: await claimDaily(api, point) });
      } catch (err) {
        out.errors.push({ step: "daily", point, name, error: err.message });
      }
    }
  }

  if (signIn) {
    try {
      out.signIn = await signInDaily(api);
    } catch (err) {
      out.errors.push({ step: "signIn", error: err.message });
    }
  }

  if (mail) {
    try {
      out.mail = await claimAllMail(api);
    } catch (err) {
      out.errors.push({ step: "mail", error: err.message });
    }
  }

  return out;
}

export async function claimQuest(api, questKey) {
  if (!questKey) throw new Error("claimQuest 需要 questKey");
  return api.post("/api/quests/claim", { questKey });
}

export async function claimAchievement(api, achievementKey) {
  if (!achievementKey) throw new Error("claimAchievement 需要 achievementKey");
  return api.post("/api/achievements/claim", { achievementKey });
}

export async function claimCodex(api, rewardKey) {
  if (!rewardKey) throw new Error("claimCodex 需要 rewardKey");
  return api.post("/api/codex/claim", { rewardKey });
}

// point 是奖励档位序号,不是数量
export async function claimDaily(api, point) {
  if (!Number.isInteger(point)) throw new Error("claimDaily 的 point 必须是整数档位");
  return api.post("/api/daily/claim", { point });
}

export async function signInDaily(api) {
  return api.post("/api/retention/sign-in", {});
}

export async function listMail(api) {
  const data = await api.get("/api/mail/list");
  return pickList(data, "messages", "items", "mails");
}

export async function claimAllMail(api) {
  return api.post("/api/mail/claim-all", {});
}

export async function activityLogs(api) {
  const data = await api.get("/api/client/activity-logs");
  return pickList(data, "items", "logs", "messages");
}

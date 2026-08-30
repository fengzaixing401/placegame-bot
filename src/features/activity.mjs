import { unwrap, pickList, pickKey } from "../util.mjs";
import { dynamicView } from "./collect.mjs";
import { activityProgress } from "../labels.mjs";

// 活跃度进度只在 bootstrap 里,dynamic-view 没有 daily 段。
export async function bootstrap(api) {
  return unwrap(await api.request("/api/client/bootstrap"));
}

// 活跃宝箱现状:活跃点、七项任务进度、五个档位各自可领与否。
export async function activityStatus(api) {
  const data = await bootstrap(api);
  return { key: data?.daily?.key ?? null, ...activityProgress(data?.daily) };
}

// 可领取判定,镜像 CLI progress 展示层(line 1270-1275)的三段逻辑。
export function isClaimable(row) {
  if (!row) return false;
  if (row.claimed === true) return false;
  if (row.available === false || row.unlocked === false) return false;
  return row.canClaim === true || row.completed === true;
}

// ⑥ 自动领活动与日志奖励。
// 任务/成就/图鉴没有独立列表端点,都从 dynamic-view 取。
export async function claimAll(api, { quests = true, achievements = true, daily = true, signIn = true, mail = true, codex = false, dailyPoints = null } = {}) {
  const out = { quests: [], achievements: [], codex: [], daily: [], signIn: null, mail: null, activity: null, errors: [] };
  const view = await dynamicView(api);

  if (quests) {
    for (const row of pickList(view?.quests, "quests").filter(isClaimable)) {
      const questKey = row.questKey ?? pickKey(row);
      try {
        out.quests.push({ questKey, result: await claimQuest(api, questKey) });
      } catch (err) {
        out.errors.push({ step: "quest", questKey, error: err.message });
      }
    }
  }

  if (achievements) {
    for (const row of pickList(view?.achievements, "achievements").filter(isClaimable)) {
      const achievementKey = row.achievementKey ?? pickKey(row);
      try {
        out.achievements.push({ achievementKey, result: await claimAchievement(api, achievementKey) });
      } catch (err) {
        out.errors.push({ step: "achievement", achievementKey, error: err.message });
      }
    }
  }

  if (codex) {
    for (const row of pickList(view?.codex, "codex").filter(isClaimable)) {
      const rewardKey = row.rewardKey ?? pickKey(row);
      try {
        out.codex.push({ rewardKey, result: await claimCodex(api, rewardKey) });
      } catch (err) {
        out.errors.push({ step: "codex", rewardKey, error: err.message });
      }
    }
  }

  // daily/claim 的 point 是活跃宝箱档位。档位阈值只存在于客户端,
  // 所以未指定时按 bootstrap.daily 自己算活跃点,再挑出「已达标且未领过」的档位。
  if (daily) {
    let points = Array.isArray(dailyPoints) ? dailyPoints.map((p) => ({ point: p, name: null })) : null;
    if (!points) {
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
        points = st.claimable.map((t) => ({ point: t.point, name: t.name }));
      } catch (err) {
        out.errors.push({ step: "activityStatus", error: err.message });
        points = [];
      }
    }
    for (const { point, name } of points) {
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
  return unwrap(await api.request("/api/quests/claim", { method: "POST", body: { questKey } }));
}

export async function claimAchievement(api, achievementKey) {
  if (!achievementKey) throw new Error("claimAchievement 需要 achievementKey");
  return unwrap(await api.request("/api/achievements/claim", { method: "POST", body: { achievementKey } }));
}

export async function claimCodex(api, rewardKey) {
  if (!rewardKey) throw new Error("claimCodex 需要 rewardKey");
  return unwrap(await api.request("/api/codex/claim", { method: "POST", body: { rewardKey } }));
}

// point 是奖励档位序号,不是数量
export async function claimDaily(api, point) {
  if (!Number.isInteger(point)) throw new Error("claimDaily 的 point 必须是整数档位");
  return unwrap(await api.request("/api/daily/claim", { method: "POST", body: { point } }));
}

export async function signInDaily(api) {
  return unwrap(await api.request("/api/retention/sign-in", { method: "POST", body: {} }));
}

export async function listMail(api) {
  const data = unwrap(await api.request("/api/mail/list"));
  return pickList(data, "messages", "items", "mails");
}

export async function claimAllMail(api) {
  return unwrap(await api.request("/api/mail/claim-all", { method: "POST", body: {} }));
}

export async function activityLogs(api) {
  const data = unwrap(await api.request("/api/client/activity-logs"));
  return pickList(data, "items", "logs", "messages");
}

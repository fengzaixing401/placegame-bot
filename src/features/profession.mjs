import { num } from "../util.mjs";

// 副职枚举(CLI 的 professionKey 字段说明:herbalism/fishing/cooking/alchemy)
export const PROFESSIONS = ["herbalism", "fishing", "cooking", "alchemy"];

// enqueue 的 count 约束,照 CLI 的 min:1 / max:999。越界的档位判错并记进 errors,
// 不静默夹到边界 —— 用户写 1000 是想加满,夹成 999 会让日志与实际不符。
const ENQUEUE_COUNT_MIN = 1;
const ENQUEUE_COUNT_MAX = 999;

export async function view(api) {
  return api.get("/api/professions/view");
}

function assertProfessionKey(professionKey) {
  if (!PROFESSIONS.includes(professionKey)) {
    throw new Error(`professionKey 非法:${professionKey}(合法值 ${PROFESSIONS.join("/")})`);
  }
}

// ③ 副职收取 + 加任务。
// 先 settle 收取已完成产出,再按规则把动作重新入队,避免队列空转。
// professions/view 的响应结构 CLI 未做展示层解析,故不依赖其字段判断,直接 settle
// (无可收取时服务端返回业务错误,由调用方按 tolerateSettleError 决定是否忽略)。
export async function settleAndEnqueue(api, { professionKey, enqueue = {}, tolerateSettleError = true } = {}) {
  const out = { settled: null, selected: null, enqueued: [], errors: [] };

  try {
    out.settled = await api.post("/api/professions/settle", {});
  } catch (err) {
    if (!tolerateSettleError) throw err;
    out.errors.push({ step: "settle", error: err.message });
  }

  if (professionKey) {
    assertProfessionKey(professionKey);
    try {
      out.selected = await api.post("/api/professions/select", { professionKey });
    } catch (err) {
      out.errors.push({ step: "select", error: err.message });
    }
  }

  for (const [actionKey, rawCount] of Object.entries(enqueue)) {
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count < ENQUEUE_COUNT_MIN || count > ENQUEUE_COUNT_MAX) {
      out.errors.push({
        step: "enqueue",
        actionKey,
        error: `count 必须是 ${ENQUEUE_COUNT_MIN}-${ENQUEUE_COUNT_MAX} 的整数,收到 ${rawCount}`
      });
      continue;
    }
    try {
      const result = await api.post("/api/professions/queue/enqueue", { actionKey, count });
      out.enqueued.push({ actionKey, count, result });
    } catch (err) {
      out.errors.push({ step: "enqueue", actionKey, error: err.message });
    }
  }

  return out;
}

export async function settle(api) {
  return api.post("/api/professions/settle", {});
}

export async function enqueue(api, actionKey, count = 1) {
  if (!actionKey) throw new Error("enqueue 需要 actionKey");
  return api.post("/api/professions/queue/enqueue", { actionKey, count });
}

export async function selectProfession(api, professionKey) {
  assertProfessionKey(professionKey);
  return api.post("/api/professions/select", { professionKey });
}

// WebUI 副职面板的数据。中文名优先用服务端给的 —— 本地 PROFESSIONS 只是校验白名单,
// 直接拿它当下拉项会让页面显示英文键。整块取不到时退回白名单,面板仍可用。
const FALLBACK_PROFESSIONS = PROFESSIONS.map((key) => ({ key, name: key, level: null }));

export async function viewForOptions(api) {
  let data;
  try {
    data = await view(api);
  } catch (err) {
    return { professions: FALLBACK_PROFESSIONS, selectedProfession: null, professionActions: [], error: err.message };
  }

  const served = Array.isArray(data?.professions) ? data.professions : [];
  const actions = Array.isArray(data?.actions) ? data.actions : [];

  return {
    professions: served.length
      ? served
          .map((p) => ({ key: p.key ?? null, name: p.name ?? p.key ?? null, level: num(p.level) }))
          .filter((p) => p.key)
      : FALLBACK_PROFESSIONS,
    selectedProfession: data?.selectedProfessionKey ?? null,
    // 副职动作:18 个动作横跨 4 个副职,必须带 professionKey 才能在页面上分组 ——
    // 混成一个下拉会让人选到别的副职的动作,要等运行时才失败。
    professionActions: actions
      .map((a) => ({
        key: a.key ?? a.actionKey ?? null,
        name: a.name ?? null,
        professionKey: a.professionKey ?? null,
        requiredLevel: num(a.requiredLevel),
        unlocked: a.unlocked !== false,
        blockedReason: (a.blockedReason ?? "").trim() || null
      }))
      .filter((a) => a.key),
    error: null
  };
}

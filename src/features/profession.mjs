import { unwrap } from "../util.mjs";

// 副职枚举(CLI line 1966)
export const PROFESSIONS = ["herbalism", "fishing", "cooking", "alchemy"];

export async function view(api) {
  return unwrap(await api.request("/api/professions/view"));
}

// ③ 副职收取 + 加任务。
// 先 settle 收取已完成产出,再按规则把动作重新入队,避免队列空转。
// professions/view 的响应结构 CLI 未做展示层解析,故不依赖其字段判断,直接 settle
// (无可收取时服务端返回业务错误,由调用方按 tolerateSettleError 决定是否忽略)。
export async function settleAndEnqueue(api, { professionKey, enqueue = {}, tolerateSettleError = true } = {}) {
  const out = { settled: null, selected: null, enqueued: [], errors: [] };

  try {
    out.settled = unwrap(await api.request("/api/professions/settle", { method: "POST", body: {} }));
  } catch (err) {
    if (!tolerateSettleError) throw err;
    out.errors.push({ step: "settle", error: err.message });
  }

  if (professionKey) {
    if (!PROFESSIONS.includes(professionKey)) {
      throw new Error(`professionKey 非法:${professionKey}(合法值 ${PROFESSIONS.join("/")})`);
    }
    try {
      out.selected = unwrap(await api.request("/api/professions/select", { method: "POST", body: { professionKey } }));
    } catch (err) {
      out.errors.push({ step: "select", error: err.message });
    }
  }

  for (const [actionKey, rawCount] of Object.entries(enqueue)) {
    const count = Number(rawCount);
    if (!Number.isInteger(count) || count < 1 || count > 999) {
      out.errors.push({ step: "enqueue", actionKey, error: `count 必须是 1-999 的整数,收到 ${rawCount}` });
      continue;
    }
    try {
      const res = unwrap(await api.request("/api/professions/queue/enqueue", {
        method: "POST",
        body: { actionKey, count }
      }));
      out.enqueued.push({ actionKey, count, result: res });
    } catch (err) {
      out.errors.push({ step: "enqueue", actionKey, error: err.message });
    }
  }

  return out;
}

export async function settle(api) {
  return unwrap(await api.request("/api/professions/settle", { method: "POST", body: {} }));
}

export async function enqueue(api, actionKey, count = 1) {
  if (!actionKey) throw new Error("enqueue 需要 actionKey");
  return unwrap(await api.request("/api/professions/queue/enqueue", { method: "POST", body: { actionKey, count } }));
}

export async function selectProfession(api, professionKey) {
  if (!PROFESSIONS.includes(professionKey)) {
    throw new Error(`professionKey 非法:${professionKey}(合法值 ${PROFESSIONS.join("/")})`);
  }
  return unwrap(await api.request("/api/professions/select", { method: "POST", body: { professionKey } }));
}

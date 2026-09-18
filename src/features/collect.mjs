import { pickList } from "../util.mjs";

// ① 自动收挂机收益。
// adventureOptionKey 在 CLI 里声明 required:false —— 从不强制。真实流程是两阶段:
// 先空 body 调用,若响应带 data.adventure.options[] 则说明触发了冒险事件,
// 需再调一次并带上所选 optionKey,否则收益不落袋。
export async function collect(api, { adventureOptionKey, pickOption } = {}) {
  // 先取一份收益概览:idle-collect 响应里的 rewardPreview 是"收完清零后"的状态
  // (真号实测收完 exp/gold/killCount/validSeconds 全为 0),不先读就永远说不出这次到手多少。
  // 读失败不影响收取,只是日志少一行。
  const before = await idleSummary(api).catch(() => null);

  const first = await api.post("/api/battle/idle-collect", adventureOptionKey ? { adventureOptionKey } : {});
  const options = first?.adventure?.options;

  // 没触发冒险事件,或调用方已点明选项 —— 收益已经落袋,不必再发一次
  if (!Array.isArray(options) || options.length === 0 || adventureOptionKey) {
    return { before, collected: first, adventureResolved: false };
  }

  // 有冒险选项:默认取第一个(可用 pickOption 自定义策略)
  const chosen = typeof pickOption === "function" ? pickOption(options) : options[0];
  const key = chosen?.key ?? chosen?.adventureOptionKey ?? chosen;
  if (!key) return { before, collected: first, adventureResolved: false, options };

  const second = await api.post("/api/battle/idle-collect", { adventureOptionKey: key });
  return { before, collected: second, adventureResolved: true, adventureOptionKey: key, options };
}

// 挂机收益概览。响应载荷在 data.idlePreview(或 data.preview / 根)。
export async function idleSummary(api) {
  const data = await api.get("/api/client/idle-summary");
  return data?.idlePreview ?? data?.preview ?? data;
}

// WebUI 挂机面板的数据。面板上要先让人看见「攒了多久、多少收益」再决定收不收,
// 所以取不到就置 null,页面少显示一块即可。
export async function viewForOptions(api) {
  try {
    return { idle: await idleSummary(api), error: null };
  } catch (err) {
    return { idle: null, error: err.message };
  }
}

// 客户端总览。首领/地图/任务/成就列表都来自这里。
// 该端点支持 ?select=<section> 取单节(如 select=bosses),这里取全量,让一次调用喂多个 feature。
export async function dynamicView(api) {
  return api.get("/api/client/dynamic-view");
}

export async function listMaps(api) {
  const view = await dynamicView(api);
  return pickList(view?.maps, "maps");
}

// 切换挂机地图。mapKey 来自 dynamic-view 的 data.maps[].key
export async function changeMap(api, mapKey) {
  if (!mapKey) throw new Error("changeMap 需要 mapKey");
  return api.post("/api/battle/change-map", { mapKey });
}

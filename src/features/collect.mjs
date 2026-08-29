import { unwrap, pickList } from "../util.mjs";

// ① 自动收挂机收益。
// adventureOptionKey 在 CLI 里声明 required:false —— 从不强制。真实流程是两阶段:
// 先空 body 调用,若响应带 data.adventure.options[] 则说明触发了冒险事件,
// 需再调一次并带上所选 optionKey,否则收益不落袋。
export async function collect(api, { adventureOptionKey, pickOption } = {}) {
  const first = unwrap(await api.request("/api/battle/idle-collect", {
    method: "POST",
    body: adventureOptionKey ? { adventureOptionKey } : {}
  }));

  const options = first?.adventure?.options;
  if (!Array.isArray(options) || options.length === 0 || adventureOptionKey) {
    return { collected: first, adventureResolved: false };
  }

  // 有冒险选项:默认取第一个(可用 pickOption 自定义策略)
  const chosen = typeof pickOption === "function" ? pickOption(options) : options[0];
  const key = chosen?.key ?? chosen?.adventureOptionKey ?? chosen;
  if (!key) return { collected: first, adventureResolved: false, options };

  const second = unwrap(await api.request("/api/battle/idle-collect", {
    method: "POST",
    body: { adventureOptionKey: key }
  }));
  return { collected: second, adventureResolved: true, adventureOptionKey: key, options };
}

// 挂机收益概览。响应载荷在 data.idlePreview(或 data.preview / 根)。
export async function idleSummary(api) {
  const data = unwrap(await api.request("/api/client/idle-summary"));
  return data?.idlePreview ?? data?.preview ?? data;
}

// 客户端总览。首领/地图/任务/成就列表都来自这里。
// 该端点支持 ?select=<section> 取单节(如 select=bosses),这里取全量,让一次调用喂多个 feature。
export async function dynamicView(api) {
  return unwrap(await api.request("/api/client/dynamic-view"));
}

export async function listMaps(api) {
  const view = await dynamicView(api);
  return pickList(view?.maps, "maps");
}

// 切换挂机地图。mapKey 来自 dynamic-view 的 data.maps[].key
export async function changeMap(api, mapKey) {
  if (!mapKey) throw new Error("changeMap 需要 mapKey");
  return unwrap(await api.request("/api/battle/change-map", { method: "POST", body: { mapKey } }));
}

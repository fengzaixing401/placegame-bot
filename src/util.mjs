// 从一行数据里取"引用键"——镜像官方 CLI 的 preferred 字段优先级。
// 各列表端点(装备/物品/邮件/公会对 象/首领/副职动作)的每条目都带其一,
// 用首个命中的字段作为该行的稳定标识;若都没有,则退化到 key 或 id。
const PREFERRED = ["id", "userId", "guildId", "orderId", "equipmentId", "itemId", "mailId", "noticeId", "key"];

export function pickKey(row) {
  for (const k of PREFERRED) {
    if (row && row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  }
  return row?.key ?? row?.id ?? null;
}

// 归一化响应 envelope:{ok,data,...} -> data;做防御,兼容有时 server 直接回 data。
// 注意 responseState 为 patch/full 时,data 是 {result, statePatch},真实载荷在 result
// (见 CLI 源码 line 811-815)。只有两个键同时存在才解包,避免误伤本就带 result 字段的载荷。
export function unwrap(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const data = "ok" in payload && "data" in payload ? payload.data : payload;
  if (data && typeof data === "object" && "result" in data && "statePatch" in data) return data.result;
  return data;
}

// 列表端点有时回数组,有时回 {key: []}。按候选键依次取第一个数组。
export function pickList(data, ...keys) {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key];
  }
  return [];
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  return [];
}
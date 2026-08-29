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

// 落库前压缩执行结果。必须裁剪"对象"而不是裁剪序列化后的字符串——后者会切在
// token 中间,产出无法 JSON.parse 的坏数据(排程曾用 slice(0,4000) 踩过)。
export function compactForStore(value, { maxString = 400, maxArray = 20, maxDepth = 8 } = {}) {
  const walk = (node, depth) => {
    if (node === null || typeof node !== "object") {
      if (typeof node === "string" && node.length > maxString) {
        return `${node.slice(0, maxString)}…(共 ${node.length} 字)`;
      }
      return node;
    }
    if (depth >= maxDepth) return Array.isArray(node) ? `[数组 ${node.length} 项,超出深度]` : "[对象,超出深度]";
    if (Array.isArray(node)) {
      const kept = node.slice(0, maxArray).map((v) => walk(v, depth + 1));
      if (node.length > maxArray) kept.push(`…另有 ${node.length - maxArray} 项`);
      return kept;
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, depth + 1);
    return out;
  };
  return walk(value, 0);
}
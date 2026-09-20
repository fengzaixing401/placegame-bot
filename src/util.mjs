// 通用小工具。三条主线:
//   ① 字段取值 —— 服务端同义字段多,统一在这里挑
//   ② 响应解包 —— envelope 与列表容器的形状差异收敛在这里
//   ③ 类型折叠 —— 渲染层一律"读不到就少写一行",不拿 undefined 拼句子
// 各 feature 模块只描述业务,不再各写一份 typeof 判断。

// ---- ① 字段取值 ----

// 从一行数据里取"引用键"——镜像官方 CLI 的 preferred 字段优先级。
// 各列表端点(装备/物品/邮件/公会对象/首领/副职动作)的每条目都带其一,
// 用首个命中的字段作为该行的稳定标识;若都没有,则退化到 key 或 id。
//
// **注意:这是"best-effort",字段名不在这份名单里的行别用它。**
// 名单里 guildId 排在 key 前面,所以对"带 guildId、但真正的键在别的字段上"的行
// (典型是 boss/world-status 的场次行,它的键是 bossKey)会挑错。
// 实测 2026-09-20:场次行被取成 "guild_f94d47f149f3",日志里就查不到中文名了。
// 这类行请直接读它自己的字段名。
const PREFERRED = ["id", "userId", "guildId", "orderId", "equipmentId", "itemId", "mailId", "noticeId", "key"];

// 按候选字段名依次取第一个"有值"的字段。"" / null / undefined 都算没有。
// 用于服务端字段改名的兜底(如 itemKey → key → templateKey)。
export function pickField(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

export function pickKey(row) {
  return pickField(row, PREFERRED) ?? row?.key ?? row?.id ?? null;
}

// ---- ② 响应解包 ----

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
  return Array.isArray(value) ? value : [];
}

// 规则里的名单既可能写成数组也可能写成单值,还可能是 null。统一成 Set 再判断。
export function asSet(value) {
  return new Set([].concat(value ?? []));
}

// ---- ③ 类型折叠:读不到一律 null ----

export function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function bool(value) {
  return typeof value === "boolean" ? value : null;
}

// 服务端常用空串表示"无",这里折叠成 null;其余情况保留原文。
export function text(value) {
  if (typeof value !== "string") return null;
  return value.trim() === "" ? null : value;
}

// 从若干候选字段里取第一个数字 / 布尔。服务端换字段名时的兜底 ——
// 只有拿到"候选名全不中"的实测证据才值得用,否则属于猜。
export function firstNum(source, names) {
  for (const name of names) {
    const value = num(source?.[name]);
    if (value !== null) return value;
  }
  return null;
}

export function firstBool(source, names) {
  for (const name of names) {
    const value = bool(source?.[name]);
    if (value !== null) return value;
  }
  return null;
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

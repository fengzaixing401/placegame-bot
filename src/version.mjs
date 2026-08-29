// 版本闸门:启动时从服务端动态读取最新客户端版本号,不做硬编码
const LATEST_URL = "https://api.placegame.cn/updates/cli/latest.json";

export async function fetchClientVersion({ fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(`${LATEST_URL}?t=${Date.now()}`);
  if (!res.ok) {
    throw new Error(`获取客户端版本失败:HTTP ${res.status}`);
  }
  const data = await res.json();
  const version = data?.version;
  if (typeof version !== "string" || !version) {
    throw new Error(`/updates/cli/latest.json 响应缺少 version 字段`);
  }
  return { version, url: data?.url, sha256: data?.sha256 };
}
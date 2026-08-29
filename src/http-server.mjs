import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { publicView } from "./accounts/store.mjs";

const MAX_BODY_BYTES = 256 * 1024;

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

const ok = (res, data) => send(res, 200, { ok: true, data });
const fail = (res, status, error, extra) => send(res, status, { ok: false, error, ...extra });

// 常量时间比较,避免令牌被时序侧信道逐字节猜出
function tokenMatches(provided, expected) {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("请求体过大"), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { status: 400 });
  }
}

function errorStatus(err) {
  if (err?.status && Number.isInteger(err.status)) return err.status;
  if (err?.code === "ACCOUNT_NOT_FOUND") return 404;
  if (err?.code === "ACCOUNT_DISABLED") return 409;
  if (err?.name === "AuthError") return 502; // 上游游戏服务端认证失败,非调用方之过
  if (err?.name === "UpdateRequiredError") return 503;
  if (err?.name === "ApiError") return 502;
  return 500;
}

// REST 接口,供 agent(hermes 等)操控。所有非健康检查端点均需 Bearer 鉴权。
export function createHttpServer({ config, service, store, scheduler, actions, version, logger = console }) {
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) =>
    routes.push({ method, pattern, handler, auth });

  // 健康检查(不鉴权,供容器 healthcheck 与编排探针)
  route("GET", /^\/health\/live$/, async () => ({ status: "live" }), { auth: false });
  route(
    "GET",
    /^\/health\/ready$/,
    async () => ({
      status: "ready",
      version,
      accounts: store.list().length,
      enabledAccounts: store.list({ enabledOnly: true }).length,
      scheduler: scheduler?.status() ?? { enabled: false }
    }),
    { auth: false }
  );

  // 账号管理
  route("GET", /^\/accounts$/, async () => service.list());
  route("POST", /^\/accounts$/, async (_m, body) =>
    service.create({
      label: body.label,
      gameUsername: body.gameUsername ?? body.username,
      password: body.password,
      gameAccountId: body.gameAccountId,
      rules: body.rules,
      enabled: body.enabled !== false
    })
  );
  route("GET", /^\/accounts\/([^/]+)$/, async (m) => {
    const view = service.view(decodeURIComponent(m[1]));
    if (!view) throw Object.assign(new Error("账号不存在"), { status: 404 });
    return view;
  });
  route("DELETE", /^\/accounts\/([^/]+)$/, async (m, body) => {
    if (body?.confirm !== true) {
      throw Object.assign(new Error("删除账号需在请求体带 {\"confirm\":true}"), { status: 400 });
    }
    const removed = service.remove(decodeURIComponent(m[1]));
    if (!removed) throw Object.assign(new Error("账号不存在"), { status: 404 });
    return { removed: true };
  });
  route("POST", /^\/accounts\/([^/]+)\/enable$/, async (m) =>
    service.setEnabled(decodeURIComponent(m[1]), true)
  );
  route("POST", /^\/accounts\/([^/]+)\/disable$/, async (m, body) =>
    service.setEnabled(decodeURIComponent(m[1]), false, body?.reason ?? "手动停用")
  );
  route("PUT", /^\/accounts\/([^/]+)\/rules$/, async (m, body) =>
    service.setRules(decodeURIComponent(m[1]), body?.rules ?? body ?? null)
  );
  route("POST", /^\/accounts\/([^/]+)\/credentials$/, async (m, body) => {
    const row = store.resolve(decodeURIComponent(m[1]));
    if (!row) throw Object.assign(new Error("账号不存在"), { status: 404 });
    if (body?.gameUsername) store.setSecret(row.id, "gameUsername", body.gameUsername);
    if (body?.password) store.setSecret(row.id, "password", body.password);
    store.setSession(row.id, null); // 换凭据后旧会话作废
    service.clients.delete(row.id);
    return publicView(store.get(row.id));
  });
  route("POST", /^\/accounts\/([^/]+)\/verify$/, async (m) =>
    service.verify(decodeURIComponent(m[1]))
  );

  // 游戏动作:统一走 actions 表,键名与排程任务一致
  const action = (path, key, argsFrom = () => undefined) =>
    route("POST", new RegExp(`^\\/accounts\\/([^/]+)\\/${path}$`), async (m, body) => {
      const handler = actions[key];
      if (!handler) throw Object.assign(new Error(`动作未实现:${key}`), { status: 501 });
      const label = decodeURIComponent(m[1]);
      return service.run(label, (client, row) => handler(client, row, argsFrom(body)));
    });

  action("collect", "collect");
  action("inventory/decompose", "inventory", (b) => b);
  action("profession/settle", "profession", (b) => b);
  action("guild/daily", "guild", (b) => b);
  action("boss/map", "boss.map", (b) => b);
  action("boss/world", "boss.world", (b) => b);
  action("activity/claim-all", "activity", (b) => b);
  action("daily-run", "dailyRun", (b) => b);
  action("map/change", "changeMap", (b) => b);

  // 只读状态
  route("GET", /^\/accounts\/([^/]+)\/status$/, async (m) => {
    const handler = actions.status;
    if (!handler) throw Object.assign(new Error("动作未实现:status"), { status: 501 });
    return service.run(decodeURIComponent(m[1]), (client, row) => handler(client, row));
  });

  // 排程
  route("GET", /^\/tasks$/, async () => ({
    scheduler: scheduler?.status() ?? { enabled: false },
    recent: scheduler?.recentRuns({ limit: 50 }) ?? []
  }));
  route("GET", /^\/accounts\/([^/]+)\/tasks$/, async (m) => {
    const row = store.resolve(decodeURIComponent(m[1]));
    if (!row) throw Object.assign(new Error("账号不存在"), { status: 404 });
    return scheduler?.recentRuns({ accountId: row.id }) ?? [];
  });
  route("POST", /^\/scheduler\/tick$/, async () => {
    if (!scheduler) throw Object.assign(new Error("排程器未启用"), { status: 409 });
    return scheduler.tick();
  });

  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return fail(res, 400, "无效请求 URL");
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const match = routes.find((r) => r.method === req.method && r.pattern.test(path));

    if (!match) {
      const pathExists = routes.some((r) => r.pattern.test(path));
      return fail(res, pathExists ? 405 : 404, pathExists ? "方法不允许" : "端点不存在");
    }

    if (match.auth) {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      if (!token || !tokenMatches(token, config.apiToken)) {
        res.setHeader("www-authenticate", 'Bearer realm="placegame-bot"');
        return fail(res, 401, "缺少或无效的 Bearer 令牌");
      }
    }

    try {
      const body = req.method === "GET" || req.method === "HEAD" ? {} : await readJsonBody(req);
      const data = await match.handler(path.match(match.pattern), body, url);
      return ok(res, data);
    } catch (err) {
      const status = errorStatus(err);
      if (status >= 500) logger.error(`[http] ${req.method} ${path} -> ${status}:`, err.message);
      return fail(res, status, err.message, err.code ? { code: err.code } : undefined);
    }
  });

  return server;
}

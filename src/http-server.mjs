import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicView } from "./accounts/store.mjs";
import { generateToken } from "./settings.mjs";

const MAX_BODY_BYTES = 256 * 1024;
const SESSION_COOKIE = "pg_session";

// 静态资源白名单。启动时一次读进内存,每请求不碰文件系统 —— 路径穿越无从下手。
const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "web");
const WEB_ASSETS = [
  ["/", "index.html", "text/html; charset=utf-8"],
  ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ["/style.css", "style.css", "text/css; charset=utf-8"]
];

function loadWebAssets(logger) {
  const map = new Map();
  for (const [route, file, contentType] of WEB_ASSETS) {
    try {
      map.set(route, { body: readFileSync(join(WEB_DIR, file)), contentType });
    } catch (err) {
      logger.error(`[http] 静态资源 ${file} 读取失败,WebUI 将不可用:`, err.message);
    }
  }
  return map;
}

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...headers
  });
  res.end(body);
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionCookie(token, { secure, maxAgeSeconds }) {
  const bits = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

// 只有 nginx 与本机能到这个端口,故信任 X-Real-IP(root.conf 里由 nginx 设置)
function clientIp(req) {
  return req.headers["x-real-ip"] || req.socket.remoteAddress || "unknown";
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

// REST 接口 + WebUI。鉴权两条路:agent 用 Bearer 令牌,浏览器用会话 cookie。
// auth: false = 公开;"bearer" = 只认令牌(初始设置用);true = 令牌或会话皆可。
export function createHttpServer({ config, service, store, settings, scheduler, actions, version, logger = console }) {
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) =>
    routes.push({ method, pattern, handler, auth });
  const webAssets = loadWebAssets(logger);

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
      scheduler: scheduler?.status() ?? { enabled: false },
      // 只报来源,不报值。轮换后 .env 里那个就失效了,免得日后看着文件判断错
      apiTokenSource: settings.apiTokenSource,
      webPasswordSet: settings.webPasswordSet
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

  // ---- WebUI 会话与设置。路径带 /api/web 前缀,避免与既有端点撞名 ----

  // 页面加载时探测状态:是否需要初始设置、当前是否已登录
  route(
    "GET",
    /^\/api\/web\/session$/,
    async (_m, _b, ctx) => ({
      needsSetup: !settings.webPasswordSet,
      authenticated: !!ctx.session,
      csrfToken: ctx.session?.csrf_token ?? null
    }),
    { auth: false }
  );

  // 初始设置:库里还没密码时用 Bearer 令牌设第一个密码。
  // 这样唯一的引导凭据仍是 .env 里那个令牌,不新增第二个长期密码进配置文件。
  route(
    "POST",
    /^\/api\/web\/setup$/,
    async (_m, body) => {
      if (settings.webPasswordSet) {
        throw Object.assign(new Error("密码已设置,请用改密接口"), { status: 409 });
      }
      settings.setWebPassword(body?.password);
      return { ok: true };
    },
    { auth: "bearer" }
  );

  route(
    "POST",
    /^\/api\/web\/login$/,
    async (_m, body, ctx) => {
      if (settings.loginLocked(ctx.ip)) {
        throw Object.assign(new Error("登录失败次数过多,请 15 分钟后再试"), { status: 429 });
      }
      if (!settings.webPasswordSet) {
        throw Object.assign(new Error("尚未设置 WebUI 密码"), { status: 409 });
      }
      if (!settings.verifyWebPassword(body?.password)) {
        settings.recordLoginFailure(ctx.ip);
        logger.error(`[web] 登录失败,来源 ${ctx.ip}`);
        throw Object.assign(new Error("密码错误"), { status: 401 });
      }
      settings.clearLoginFailures(ctx.ip);
      const { token, csrfToken } = settings.createSession();
      ctx.res.setHeader(
        "set-cookie",
        sessionCookie(token, { secure: config.webSecureCookie, maxAgeSeconds: config.webSessionHours * 3600 })
      );
      return { csrfToken };
    },
    { auth: false }
  );

  route(
    "POST",
    /^\/api\/web\/logout$/,
    async (_m, _b, ctx) => {
      settings.destroySession(ctx.sessionToken);
      ctx.res.setHeader("set-cookie", sessionCookie("", { secure: config.webSecureCookie, maxAgeSeconds: 0 }));
      return { ok: true };
    },
    { auth: false }
  );

  // 改 WebUI 密码。须验旧密码 —— 会话被劫持也不能直接换掉密码把人锁在外面。
  route("POST", /^\/api\/web\/password$/, async (_m, body, ctx) => {
    if (!settings.verifyWebPassword(body?.currentPassword)) {
      throw Object.assign(new Error("当前密码错误"), { status: 401 });
    }
    settings.setWebPassword(body?.newPassword);
    settings.destroyOtherSessions(ctx.sessionToken);
    return { ok: true, otherSessionsRevoked: true };
  });

  // 轮换 API 令牌。须验 WebUI 密码,因为这会立即让所有 agent 的旧令牌失效。
  route("POST", /^\/api\/web\/api-token$/, async (_m, body) => {
    if (!settings.webPasswordSet) {
      throw Object.assign(new Error("请先设置 WebUI 密码"), { status: 409 });
    }
    if (!settings.verifyWebPassword(body?.currentPassword)) {
      throw Object.assign(new Error("WebUI 密码错误"), { status: 401 });
    }
    const token = body?.token ? String(body.token) : generateToken();
    settings.setApiToken(token);
    logger.log("[web] API 令牌已轮换,旧令牌立即失效");
    // 明文只在这一次响应里出现,之后无法再读出
    return { token, warning: "旧令牌已失效,请同步更新 agent 配置。.env 里的旧值不再生效,若已泄露请手动删除。" };
  });

  const server = createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      return fail(res, 400, "无效请求 URL");
    }
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // 静态资源:免鉴权。页面本身不含机密,数据全靠后续带凭据的 XHR 取。
    const asset = req.method === "GET" ? webAssets.get(path) : undefined;
    if (asset) {
      res.writeHead(200, {
        "content-type": asset.contentType,
        "content-length": asset.body.length,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff"
      });
      return res.end(asset.body);
    }

    const match = routes.find((r) => r.method === req.method && r.pattern.test(path));

    if (!match) {
      const pathExists = routes.some((r) => r.pattern.test(path));
      return fail(res, pathExists ? 405 : 404, pathExists ? "方法不允许" : "端点不存在");
    }

    const sessionToken = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const ctx = { req, res, ip: clientIp(req), sessionToken, session: null };

    if (match.auth) {
      const header = req.headers.authorization ?? "";
      const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
      const bearerOk = !!bearer && tokenMatches(bearer, settings.apiToken);

      if (!bearerOk && match.auth !== "bearer") {
        ctx.session = settings.getSession(ctx.sessionToken);
      }
      if (!bearerOk && !ctx.session) {
        res.setHeader("www-authenticate", 'Bearer realm="placegame-bot"');
        return fail(res, 401, match.auth === "bearer" ? "缺少或无效的 Bearer 令牌" : "缺少或无效的凭据");
      }
      // 会话路径的写操作要防 CSRF。SameSite=Strict 已是主防线,这里再叠一层
      // double-submit:攻击者站点即便诱导浏览器发请求,也读不到会话里的 csrf_token。
      if (!bearerOk && ctx.session && req.method !== "GET" && req.method !== "HEAD") {
        const provided = req.headers["x-csrf-token"] ?? "";
        if (!provided || provided !== ctx.session.csrf_token) {
          return fail(res, 403, "CSRF 令牌缺失或不匹配");
        }
      }
    } else {
      // 公开端点也要认会话,/api/web/session 靠它判断是否已登录
      ctx.session = settings.getSession(ctx.sessionToken);
    }

    try {
      const body = req.method === "GET" || req.method === "HEAD" ? {} : await readJsonBody(req);
      const data = await match.handler(path.match(match.pattern), body, ctx);
      return ok(res, data);
    } catch (err) {
      const status = errorStatus(err);
      if (status >= 500) logger.error(`[http] ${req.method} ${path} -> ${status}:`, err.message);
      return fail(res, status, err.message, err.code ? { code: err.code } : undefined);
    }
  });

  return server;
}

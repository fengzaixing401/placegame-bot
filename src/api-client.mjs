import { unwrap } from "./util.mjs";

// 核心 HTTP 客户端:镜像官方 CLI 的 GameApiClient,加入自动重登。
// 端点/必带头/版本闸门/错误契约均源自 placegame-cli.mjs 规格书。
export class ApiError extends Error {
  constructor(message, { status, code, details, data } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.data = data;
  }
}

export class AuthError extends ApiError {
  constructor(message, details, data) {
    super(message, { status: 401, code: "AUTH", details, data });
    this.name = "AuthError";
  }
}

export class UpdateRequiredError extends ApiError {
  constructor(message) {
    super(message, { status: 426, code: "UPDATE_REQUIRED" });
    this.name = "UpdateRequiredError";
  }
}

const DEFAULT_HEADERS = {
  accept: "application/json"
};

// 退避重试的间隔。两次足够跨过游戏服务端的瞬时抖动(实测会返 Cloudflare 502
// origin_bad_gateway,自带 retryable: true),再多重试只是拖长整轮排程。
const RETRY_BACKOFF_MS = [800, 2000];

// 只有"重发同一请求结果可能不同"的错误才值得重试:超时、连不上、服务端 5xx。
// 4xx 与坏 JSON 重发结果一样,401/403 走的是另一条重登路径。
function isRetryable(err) {
  if (!(err instanceof ApiError) || err instanceof AuthError) return false;
  if (err.code === "TIMEOUT" || err.code === "NETWORK") return true;
  return err.code === "SERVER" && typeof err.status === "number" && err.status >= 500;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class GameApiClient {
  constructor({ baseUrl, version, deviceId, username, password, fetchImpl = globalThis.fetch, timeoutMs = 15000, onLogin }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.version = version;
    this.deviceId = deviceId;
    this.username = username;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sessionToken = null;
    this._onLogin = onLogin;
    this._loginPromise = null;
  }

  setSession(token) {
    this.sessionToken = token || null;
  }

  get authed() {
    return !!this.sessionToken;
  }

  // 显式登录,返回 sessionToken。并发调用共享同一次登录。
  async login({ token } = {}) {
    if (token) {
      this.setSession(token);
      return token;
    }
    if (!this.username || !this.password) {
      throw new AuthError("缺少登录凭据。请用 POST /accounts/:id/credentials 写入。");
    }
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = this.#doLogin().finally(() => {
      this._loginPromise = null;
    });
    return this._loginPromise;
  }

  async #doLogin() {
    const payload = await this.requestRaw("/api/auth/login", {
      method: "POST",
      body: { username: this.username, password: this.password },
      responseState: "omit",
      skipAuth: true
    });
    const result = unwrap(payload);
    const token = result?.sessionToken;
    if (!token) throw new ApiError("登录响应缺少 sessionToken。", { status: 200, code: "BAD_RESPONSE", data: payload });
    this.setSession(token);
    // expiresAt 是毫秒时间戳,落库统一存 ISO
    const expiresAt = typeof result.expiresAt === "number" ? new Date(result.expiresAt).toISOString() : null;
    if (this._onLogin) await this._onLogin(token, expiresAt);
    return token;
  }

  // 通用请求。两条重试路径互不干扰:
  //   ① 会话失效(401/403)-> 重登后重试一次
  //   ② 瞬时故障(超时/连不上/5xx)-> 按 RETRY_BACKOFF_MS 退避重试
  // ② 的默认次数按方法分野:GET 只读,重发安全;POST 会真扣次数/门票、真拆装备,
  // 默认一次都不重试,需要的调用方显式传 retries 才开。
  async request(path, opts = {}) {
    const { method = "GET", body, responseState = "omit", authed = true, retry = true, timeoutMs, retries } = opts;
    const send = () => this.requestRaw(path, { method, body, responseState, authed, timeoutMs });
    const budget = typeof retries === "number" ? retries : method === "GET" ? RETRY_BACKOFF_MS.length : 0;

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send();
      } catch (err) {
        if (err instanceof AuthError && authed && retry && this.username && this.password) {
          // 会话失效 -> 重登后重试一次
          try {
            await this.login();
            return await send();
          } catch {
            throw err;
          }
        }
        if (attempt >= budget || !isRetryable(err)) throw err;
        await sleep(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
      }
    }
  }

  async requestRaw(path, { method = "GET", body, responseState = "omit", authed = true, skipAuth = false, timeoutMs } = {}) {
    if (authed && !skipAuth && !this.sessionToken) {
      await this.login();
    }
    const isGet = method === "GET";
    const url = isGet && body ? `${this.baseUrl}${appendQuery(path, body)}` : `${this.baseUrl}${path}`;
    const headers = {
      ...DEFAULT_HEADERS,
      "content-type": "application/json",
      "x-placegame-client-version": this.version,
      "x-placegame-client-platform": "cli",
      "x-placegame-response-state": responseState
    };
    if (this.deviceId) headers["x-placegame-device-id"] = this.deviceId;
    if (this.sessionToken) headers.authorization = `Bearer ${this.sessionToken}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal
      });
    } catch (err) {
      if (err?.name === "AbortError") throw new ApiError("请求超时。", { status: "timeout", code: "TIMEOUT" });
      throw new ApiError(`无法连接游戏服务器:${err.message}`, { code: "NETWORK" });
    } finally {
      clearTimeout(timer);
    }

    const payload = await parsePayload(response);
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(payload?.error ?? "登录状态无效。", this.normalizeData(payload), payload);
    }
    if (response.status === 426) {
      throw new UpdateRequiredError(payload?.error ?? "客户端版本过低。");
    }
    if (!response.ok || payload?.ok === false) {
      throw new ApiError(payload?.error ?? `请求失败:HTTP ${response.status}`, {
        status: response.status,
        code: "SERVER",
        data: this.normalizeData(payload)
      });
    }
    return payload;
  }

  normalizeData(payload) {
    const d = unwrap(payload);
    return d === undefined ? payload : d;
  }
}

async function parsePayload(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`服务器返回了无效 JSON(HTTP ${response.status})`, { status: response.status, code: "BAD_JSON" });
  }
}

function appendQuery(apiPath, body) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(body ?? {})) {
    if (value !== undefined && value !== null) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${apiPath}?${suffix}` : apiPath;
}
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

  // 通用请求,失败时可选自动重登重试一次
  async request(path, opts = {}) {
    const { method = "GET", body, responseState = "omit", authed = true, retry = true, timeoutMs } = opts;
    try {
      return await this.requestRaw(path, { method, body, responseState, authed, timeoutMs });
    } catch (err) {
      const isAuth = err instanceof AuthError;
      if (isAuth && authed && retry && this.username && this.password) {
        // 会话失效 -> 重登后重试一次
        try {
          await this.login();
          return await this.requestRaw(path, { method, body, responseState, authed, timeoutMs });
        } catch {
          throw err;
        }
      }
      throw err;
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
import { GameApiClient, AuthError } from "../api-client.mjs";
import { publicView } from "./store.mjs";

const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const AUTH_FAILURE_THRESHOLD = 5;

export class AccountDisabledError extends Error {
  constructor(label, reason) {
    super(`账号 ${label} 已停用${reason ? `:${reason}` : ""}`);
    this.name = "AccountDisabledError";
    this.code = "ACCOUNT_DISABLED";
  }
}

// 按账号维护 GameApiClient 实例:独立 device-id、独立会话。
// 会话令牌加密落库,重启后复用;失效由 api-client 自动重登并回写。
export class AccountService {
  constructor({ store, baseUrl, version, fetchImpl, timeoutMs = 15000 }) {
    this.store = store;
    this.baseUrl = baseUrl;
    this.version = version;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.clients = new Map();
  }

  list(opts) {
    return this.store.list(opts).map(publicView);
  }

  view(idOrLabel) {
    return publicView(this.store.resolve(idOrLabel));
  }

  create(input) {
    if (!input?.gameUsername || !input?.password) {
      throw new Error("创建账号需要 gameUsername 与 password");
    }
    if (this.store.getByLabel(input.label)) {
      throw new Error(`账号标签已存在:${input.label}`);
    }
    return publicView(this.store.create(input));
  }

  remove(idOrLabel) {
    const row = this.store.resolve(idOrLabel);
    if (!row) return false;
    this.clients.delete(row.id);
    return this.store.remove(row.id);
  }

  setEnabled(idOrLabel, enabled, reason) {
    const row = this.#require(idOrLabel);
    this.store.setEnabled(row.id, enabled, reason);
    if (enabled) this.store.resetAuthFailure(row.id);
    else this.clients.delete(row.id);
    return publicView(this.store.get(row.id));
  }

  setRules(idOrLabel, rules) {
    const row = this.#require(idOrLabel);
    this.store.setRules(row.id, rules);
    return publicView(this.store.get(row.id));
  }

  // 取得可用的 API 客户端。停用账号直接拒绝,避免排程继续打服务端。
  async clientFor(idOrLabel) {
    const row = this.#require(idOrLabel);
    if (row.enabled !== 1) throw new AccountDisabledError(row.label, row.paused_reason);

    const cached = this.clients.get(row.id);
    if (cached) return cached;

    const secrets = this.store.secrets(row.id);
    const client = new GameApiClient({
      baseUrl: this.baseUrl,
      version: this.version,
      deviceId: row.device_id,
      username: secrets.gameUsername,
      password: secrets.password,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      onLogin: (token, expiresAt = null) => {
        this.store.setSession(row.id, token, expiresAt);
        this.store.resetAuthFailure(row.id);
      }
    });
    if (secrets.sessionToken) client.setSession(secrets.sessionToken);
    this.clients.set(row.id, client);
    return client;
  }

  // 统一的动作入口:注入客户端、记录成功/失败、认证失败累计到阈值即熔断停用。
  async run(idOrLabel, fn) {
    const row = this.#require(idOrLabel);
    const client = await this.clientFor(row.id);
    try {
      const result = await fn(client, row);
      this.store.markSuccess(row.id);
      return result;
    } catch (err) {
      this.store.markError(row.id, err.message);
      if (err instanceof AuthError) {
        this.clients.delete(row.id);
        const count = this.store.bumpAuthFailure(row.id, AUTH_FAILURE_WINDOW_MS);
        if (count >= AUTH_FAILURE_THRESHOLD) {
          this.store.setEnabled(row.id, false, `连续 ${count} 次认证失败,已自动停用`);
        }
      }
      throw err;
    }
  }

  async verify(idOrLabel) {
    return this.run(idOrLabel, async (client) => {
      const token = await client.login();
      return { authed: !!token };
    });
  }

  #require(idOrLabel) {
    const row = this.store.resolve(idOrLabel);
    if (!row) {
      const err = new Error(`账号不存在:${idOrLabel}`);
      err.code = "ACCOUNT_NOT_FOUND";
      throw err;
    }
    return row;
  }
}

export { AUTH_FAILURE_THRESHOLD, AUTH_FAILURE_WINDOW_MS };

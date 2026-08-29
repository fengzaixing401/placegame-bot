import { randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { encryptedAad } from "./crypto.mjs";
import { nowIso } from "./db.mjs";

// 服务级可变设置:API 令牌与 WebUI 密码。账号相关的一律走 accounts/store.mjs。
// 令牌落库加密(复用主密钥),密码只存 scrypt 哈希 —— 单向,不可解出明文。

const KEY_API_TOKEN = "api_token";
const KEY_WEB_PASSWORD = "web_password";

// scrypt 参数。N=2^15 需 >32MB,故显式抬高 maxmem;登录不是热路径,慢一点无妨。
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

const SESSION_BYTES = 32;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
// 上限防止分布式撞库把内存撑爆;超限后清掉最老的一批
const LOGIN_TRACKER_MAX = 4096;

function hashPassword(password) {
  const salt = randomBytes(16);
  const dk = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  // 自描述格式,日后调参不作废旧哈希
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${dk.toString("base64url")}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, saltB64, dkB64] = parts;
  const salt = Buffer.from(saltB64, "base64url");
  const expected = Buffer.from(dkB64, "base64url");
  let actual;
  try {
    actual = scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem
    });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

const sha256 = (v) => createHash("sha256").update(v).digest("hex");

export function generateToken() {
  return randomBytes(32).toString("base64url");
}

export class SettingsStore {
  constructor(db, box, { envApiToken = "", sessionHours = 12 } = {}) {
    this.db = db;
    this.box = box;
    this.envApiToken = envApiToken;
    this.sessionMs = sessionHours * 3600 * 1000;
    this._loginFailures = new Map();
    this._tokenCache = undefined;
  }

  #read(key) {
    return this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
  }

  #write(key, value) {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value, nowIso());
  }

  // 生效令牌:库里有用库里的,否则回落 env。库是空的首启只能靠 env 进来。
  get apiToken() {
    if (this._tokenCache !== undefined) return this._tokenCache;
    const blob = this.#read(KEY_API_TOKEN);
    this._tokenCache = blob
      ? this.box.decrypt(blob, { aad: encryptedAad("settings", KEY_API_TOKEN, "value") })
      : this.envApiToken;
    return this._tokenCache;
  }

  get apiTokenSource() {
    return this.#read(KEY_API_TOKEN) ? "db" : "env";
  }

  setApiToken(token) {
    if (typeof token !== "string" || token.length < 16) {
      throw Object.assign(new Error("API 令牌至少 16 个字符"), { status: 400 });
    }
    this.#write(KEY_API_TOKEN, this.box.encrypt(token, { aad: encryptedAad("settings", KEY_API_TOKEN, "value") }));
    this._tokenCache = token;
    return token;
  }

  get webPasswordSet() {
    return !!this.#read(KEY_WEB_PASSWORD);
  }

  setWebPassword(password) {
    if (typeof password !== "string" || password.length < 12) {
      throw Object.assign(new Error("WebUI 密码至少 12 个字符"), { status: 400 });
    }
    this.#write(KEY_WEB_PASSWORD, hashPassword(password));
  }

  verifyWebPassword(password) {
    const stored = this.#read(KEY_WEB_PASSWORD);
    if (!stored || typeof password !== "string") return false;
    return verifyPassword(password, stored);
  }

  // ---- 会话 ----

  createSession() {
    this.pruneSessions();
    const token = randomBytes(SESSION_BYTES).toString("base64url");
    const csrfToken = randomBytes(SESSION_BYTES).toString("base64url");
    const now = Date.now();
    this.db
      .prepare("INSERT INTO web_sessions (id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sha256(token), csrfToken, new Date(now).toISOString(), new Date(now + this.sessionMs).toISOString());
    return { token, csrfToken };
  }

  getSession(token) {
    if (!token) return null;
    const row = this.db.prepare("SELECT * FROM web_sessions WHERE id = ?").get(sha256(token));
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.db.prepare("DELETE FROM web_sessions WHERE id = ?").run(row.id);
      return null;
    }
    return row;
  }

  destroySession(token) {
    if (token) this.db.prepare("DELETE FROM web_sessions WHERE id = ?").run(sha256(token));
  }

  // 改密后作废其他会话,当前这条留着,免得改完就被踢出去
  destroyOtherSessions(keepToken) {
    this.db.prepare("DELETE FROM web_sessions WHERE id != ?").run(keepToken ? sha256(keepToken) : "");
  }

  pruneSessions() {
    this.db.prepare("DELETE FROM web_sessions WHERE expires_at <= ?").run(nowIso());
  }

  // ---- 登录失败熔断(按来源 IP,不做全局锁定:否则谁都能把管理员锁在门外)----

  loginLocked(ip) {
    const rec = this._loginFailures.get(ip);
    if (!rec) return false;
    if (Date.now() - rec.windowStart > LOGIN_WINDOW_MS) {
      this._loginFailures.delete(ip);
      return false;
    }
    return rec.count >= LOGIN_MAX_FAILURES;
  }

  recordLoginFailure(ip) {
    const now = Date.now();
    const rec = this._loginFailures.get(ip);
    if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) {
      this._loginFailures.set(ip, { count: 1, windowStart: now });
    } else {
      rec.count += 1;
    }
    if (this._loginFailures.size > LOGIN_TRACKER_MAX) {
      for (const [k] of [...this._loginFailures].slice(0, LOGIN_TRACKER_MAX / 2)) {
        this._loginFailures.delete(k);
      }
    }
  }

  clearLoginFailures(ip) {
    this._loginFailures.delete(ip);
  }
}

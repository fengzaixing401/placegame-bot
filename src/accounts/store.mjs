import { randomUUID, randomBytes } from "node:crypto";
import { encryptedAad } from "../crypto.mjs";
import { nowIso } from "../db.mjs";

const ENCRYPTED_COLUMNS = {
  gameUsername: "game_username_enc",
  password: "password_enc",
  sessionToken: "session_token_enc"
};

const TABLE = "game_accounts";

// 账号 CRUD。加密列的明文只经由 secrets/setSecret 出入,行对象本身永不含明文。
export class AccountStore {
  constructor(db, secretBox) {
    this.db = db;
    this.box = secretBox;
  }

  create({ label, gameUsername, password, sessionToken, gameAccountId, rules, enabled = true }) {
    if (!label) throw new Error("label 必填");
    const id = randomUUID();
    const ts = nowIso();
    const row = {
      id,
      label,
      game_account_id: gameAccountId ?? null,
      auth_mode: "password",
      device_id: `device_${randomBytes(24).toString("hex")}`,
      game_username_enc: this.#enc(id, "gameUsername", gameUsername),
      password_enc: this.#enc(id, "password", password),
      session_token_enc: this.#enc(id, "sessionToken", sessionToken),
      session_expires_at: null,
      enabled: enabled ? 1 : 0,
      rules_json: rules ? JSON.stringify(rules) : null,
      created_at: ts,
      updated_at: ts
    };
    this.db
      .prepare(
        `INSERT INTO ${TABLE}
         (id,label,game_account_id,auth_mode,device_id,game_username_enc,password_enc,
          session_token_enc,session_expires_at,enabled,rules_json,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        row.id, row.label, row.game_account_id, row.auth_mode, row.device_id,
        row.game_username_enc, row.password_enc, row.session_token_enc,
        row.session_expires_at, row.enabled, row.rules_json, row.created_at, row.updated_at
      );
    return this.get(id);
  }

  get(id) {
    return this.db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id) ?? null;
  }

  getByLabel(label) {
    return this.db.prepare(`SELECT * FROM ${TABLE} WHERE label = ?`).get(label) ?? null;
  }

  // id 或 label 都能定位账号,方便 REST 调用方
  resolve(idOrLabel) {
    return this.get(idOrLabel) ?? this.getByLabel(idOrLabel);
  }

  list({ enabledOnly = false } = {}) {
    const sql = enabledOnly
      ? `SELECT * FROM ${TABLE} WHERE enabled = 1 ORDER BY label`
      : `SELECT * FROM ${TABLE} ORDER BY label`;
    return this.db.prepare(sql).all();
  }

  remove(id) {
    const info = this.db.prepare(`DELETE FROM ${TABLE} WHERE id = ?`).run(id);
    return info.changes > 0;
  }

  // 读取解密后的明文凭据。调用方用完即弃,不要放进响应体。
  secrets(id) {
    const row = this.get(id);
    if (!row) return null;
    return {
      gameUsername: this.#dec(id, "gameUsername", row.game_username_enc),
      password: this.#dec(id, "password", row.password_enc),
      sessionToken: this.#dec(id, "sessionToken", row.session_token_enc)
    };
  }

  setSecret(id, field, value) {
    const column = ENCRYPTED_COLUMNS[field];
    if (!column) throw new Error(`未知加密字段:${field}`);
    this.db
      .prepare(`UPDATE ${TABLE} SET ${column} = ?, updated_at = ? WHERE id = ?`)
      .run(this.#enc(id, field, value), nowIso(), id);
  }

  setSession(id, token, expiresAt = null) {
    this.db
      .prepare(
        `UPDATE ${TABLE} SET session_token_enc = ?, session_expires_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(this.#enc(id, "sessionToken", token), expiresAt, nowIso(), id);
  }

  setEnabled(id, enabled, pausedReason = null) {
    this.db
      .prepare(`UPDATE ${TABLE} SET enabled = ?, paused_reason = ?, updated_at = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, enabled ? null : pausedReason, nowIso(), id);
  }

  setRules(id, rules) {
    this.db
      .prepare(`UPDATE ${TABLE} SET rules_json = ?, updated_at = ? WHERE id = ?`)
      .run(rules ? JSON.stringify(rules) : null, nowIso(), id);
  }

  markSuccess(id) {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE ${TABLE}
         SET last_success_at = ?, updated_at = ?, last_error = NULL,
             auth_failure_count = 0, auth_failure_window_started_at = NULL
         WHERE id = ?`
      )
      .run(ts, ts, id);
  }

  markError(id, message) {
    const ts = nowIso();
    this.db
      .prepare(`UPDATE ${TABLE} SET last_error_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .run(ts, String(message).slice(0, 500), ts, id);
  }

  // 认证失败计数带滑动窗口:窗口过期则重新计数,避免历史失败永久累积。
  bumpAuthFailure(id, windowMs) {
    const row = this.get(id);
    if (!row) return 0;
    const ts = Date.now();
    const started = row.auth_failure_window_started_at
      ? Date.parse(row.auth_failure_window_started_at)
      : null;
    const withinWindow = started !== null && ts - started < windowMs;
    const count = withinWindow ? row.auth_failure_count + 1 : 1;
    const windowStart = withinWindow ? row.auth_failure_window_started_at : new Date(ts).toISOString();
    this.db
      .prepare(
        `UPDATE ${TABLE}
         SET auth_failure_count = ?, auth_failure_window_started_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(count, windowStart, nowIso(), id);
    return count;
  }

  resetAuthFailure(id) {
    this.db
      .prepare(
        `UPDATE ${TABLE}
         SET auth_failure_count = 0, auth_failure_window_started_at = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(nowIso(), id);
  }

  #enc(id, field, value) {
    if (value === undefined || value === null || value === "") return null;
    return this.box.encrypt(String(value), { aad: encryptedAad(TABLE, id, ENCRYPTED_COLUMNS[field]) });
  }

  #dec(id, field, blob) {
    if (!blob) return null;
    return this.box.decrypt(blob, { aad: encryptedAad(TABLE, id, ENCRYPTED_COLUMNS[field]) });
  }
}

// 对外可见的账号视图:剔除全部密文与明文凭据,只保留运维需要的状态。
export function publicView(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    gameAccountId: row.game_account_id,
    authMode: row.auth_mode,
    enabled: row.enabled === 1,
    pausedReason: row.paused_reason,
    hasCredentials: !!row.password_enc,
    hasSession: !!row.session_token_enc,
    sessionExpiresAt: row.session_expires_at,
    authFailureCount: row.auth_failure_count,
    rules: row.rules_json ? JSON.parse(row.rules_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSuccessAt: row.last_success_at,
    lastErrorAt: row.last_error_at,
    lastError: row.last_error
  };
}

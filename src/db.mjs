import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 多账号存储。凭据/会话列存 AESGCM 密文(见 crypto.mjs),明文只在内存中短暂存在。
// 字段对齐 Python 版 placegame-mcp 的 GameAccount 模型,保持两版心智一致。
const SCHEMA = `
CREATE TABLE IF NOT EXISTS game_accounts (
  id                             TEXT PRIMARY KEY,
  label                          TEXT NOT NULL UNIQUE,
  game_account_id                TEXT,
  auth_mode                      TEXT NOT NULL DEFAULT 'password',
  device_id                      TEXT NOT NULL,
  game_username_enc              TEXT,
  password_enc                   TEXT,
  session_token_enc              TEXT,
  session_expires_at             TEXT,
  enabled                        INTEGER NOT NULL DEFAULT 1,
  paused_reason                  TEXT,
  policy_version                 INTEGER NOT NULL DEFAULT 1,
  rules_json                     TEXT,
  auth_failure_count             INTEGER NOT NULL DEFAULT 0,
  auth_failure_window_started_at TEXT,
  created_at                     TEXT NOT NULL,
  updated_at                     TEXT NOT NULL,
  last_success_at                TEXT,
  last_error_at                  TEXT,
  last_error                     TEXT
);

CREATE TABLE IF NOT EXISTS job_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id      TEXT NOT NULL,
  job_key         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  result_json     TEXT,
  error           TEXT,
  UNIQUE (account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_job_runs_account_job
  ON job_runs (account_id, job_key, started_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- id 是会话令牌的 SHA-256,不存令牌本身:库泄露也无法复用会话
CREATE TABLE IF NOT EXISTS web_sessions (
  id         TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_expires
  ON web_sessions (expires_at);
`;

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  return db;
}

export function nowIso() {
  return new Date().toISOString();
}

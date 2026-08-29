import { nowIso } from "./db.mjs";
import { rulesFor } from "./config.mjs";
import { compactForStore } from "./util.mjs";

const TICK_MS = 60 * 1000;

// 时区换算:取指定 IANA 时区下的日期与分钟数。排程必须按 Asia/Shanghai 判断
// 游戏的时间窗口(世界首领 10-11/16-17/20-21 点、每日刷新),不能用容器本地时区。
export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(date)) parts[type] = value;
  const hour = parts.hour === "24" ? 0 : Number(parts.hour);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour,
    minute: Number(parts.minute),
    minutes: hour * 60 + Number(parts.minute)
  };
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

// 世界首领窗口:返回当前所处窗口的标识(用于幂等键),不在窗口内返回 null
export function activeWindow(parts, windows) {
  for (const w of windows ?? []) {
    const start = toMinutes(w.start);
    const end = toMinutes(w.end);
    if (parts.minutes >= start && parts.minutes < end) return `${w.start}-${w.end}`;
  }
  return null;
}

// 幂等键决定"同一件事不重复做":
// - interval 型:用 UTC 时间片编号(floor(now/间隔)),同一时间片内只跑一次
// - daily 型:用账号时区的日期
// - window 型:用日期 + 窗口标识
export class Scheduler {
  constructor({ db, store, service, config, actions, logger = console }) {
    this.db = db;
    this.store = store;
    this.service = service;
    this.config = config;
    this.actions = actions;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    this.lastTickAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.error("[scheduler] tick 失败:", err.message));
    }, TICK_MS);
    this.timer.unref?.();
    this.tick().catch((err) => this.logger.error("[scheduler] 首次 tick 失败:", err.message));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // 单实例串行执行,避免上一轮未完成时并发触发同一任务
  async tick(now = new Date()) {
    if (this.running) return { skipped: "busy" };
    this.running = true;
    this.lastTickAt = now.toISOString();
    try {
      const accounts = this.store.list({ enabledOnly: true });
      const results = [];
      for (const account of accounts) {
        // 单账号失败不影响其他账号
        try {
          results.push(...(await this.#runAccount(account, now)));
        } catch (err) {
          this.logger.error(`[scheduler] 账号 ${account.label} 处理失败:`, err.message);
        }
      }
      return { ran: results };
    } finally {
      this.running = false;
    }
  }

  async #runAccount(account, now) {
    const rules = rulesFor(this.config, account.rules_json ? JSON.parse(account.rules_json) : null);
    const parts = zonedParts(now, this.config.timezone);
    const jobs = this.plannedJobs(rules, parts, now);
    const ran = [];
    for (const job of jobs) {
      // 单任务失败不影响该账号的其他任务
      try {
        const outcome = await this.#runJob(account, job);
        if (outcome) ran.push({ account: account.label, job: job.key, status: outcome.status });
      } catch (err) {
        this.logger.error(`[scheduler] ${account.label}/${job.key} 失败:`, err.message);
      }
    }
    return ran;
  }

  // 产出本 tick 应当尝试的任务(带幂等键)。是否真正执行由 job_runs 唯一约束裁决。
  plannedJobs(rules, parts, now) {
    const jobs = [];
    const slot = (hours) => Math.floor(now.getTime() / (hours * 3600 * 1000));

    if (rules.collect?.enabled) {
      jobs.push({ key: "collect", idem: `collect:${slot(rules.collect.intervalHours)}` });
    }
    if (rules.inventory?.enabled) {
      jobs.push({ key: "inventory", idem: `inventory:${slot(rules.inventory.intervalHours)}` });
    }
    if (rules.profession?.enabled) {
      jobs.push({ key: "profession", idem: `profession:${slot(rules.profession.intervalHours)}` });
    }
    if (rules.guild?.enabled) {
      jobs.push({ key: "guild", idem: `guild:${slot(rules.guild.intervalHours)}` });
    }
    if (rules.boss?.enabled) {
      jobs.push({ key: "boss.map", idem: `boss.map:${slot(rules.boss.mapIntervalHours)}` });
      const win = activeWindow(parts, rules.boss.worldWindows);
      if (win) jobs.push({ key: "boss.world", idem: `boss.world:${parts.date}:${win}` });
    }
    if (rules.activity?.enabled && parts.minutes >= toMinutes(rules.activity.dailyAt)) {
      jobs.push({ key: "activity", idem: `activity:${parts.date}` });
    }
    return jobs;
  }

  // 幂等落库:先抢占 job_runs 行(UNIQUE 冲突 = 已跑过),再执行动作。
  async #runJob(account, job) {
    const action = this.actions[job.key];
    if (!action) return null;

    let runId;
    try {
      const info = this.db
        .prepare(
          `INSERT INTO job_runs (account_id, job_key, idempotency_key, status, started_at)
           VALUES (?,?,?,'running',?)`
        )
        .run(account.id, job.key, job.idem, nowIso());
      runId = info.lastInsertRowid;
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) return null; // 本时间片已执行
      throw err;
    }

    try {
      const result = await this.service.run(account.id, (client) => action(client, account));
      this.db
        .prepare(`UPDATE job_runs SET status='ok', finished_at=?, result_json=? WHERE id=?`)
        .run(nowIso(), this.#storableResult(result), runId);
      this.logger.log(`[scheduler] ${account.label}/${job.key} 完成`);
      return { status: "ok", result };
    } catch (err) {
      this.db
        .prepare(`UPDATE job_runs SET status='error', finished_at=?, error=? WHERE id=?`)
        .run(nowIso(), String(err.message).slice(0, 500), runId);
      throw err;
    }
  }

  // 结果行既要有界又必须是合法 JSON。先按常规档裁剪,仍超限就再狠裁一次;
  // 最坏情况只存一句说明,也绝不存半截 JSON。
  #storableResult(result) {
    const attempts = [
      { maxString: 400, maxArray: 20, maxDepth: 8 },
      { maxString: 120, maxArray: 5, maxDepth: 4 }
    ];
    for (const opts of attempts) {
      const text = JSON.stringify(compactForStore(result ?? null, opts));
      if (text !== undefined && text.length <= 60000) return text;
    }
    return JSON.stringify({ note: "结果过大,已省略。请用对应 REST 端点重新取回。" });
  }

  recentRuns({ accountId, limit = 50 } = {}) {
    const sql = accountId
      ? `SELECT * FROM job_runs WHERE account_id = ? ORDER BY started_at DESC LIMIT ?`
      : `SELECT * FROM job_runs ORDER BY started_at DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    return accountId ? stmt.all(accountId, limit) : stmt.all(limit);
  }

  status() {
    return {
      enabled: !!this.timer,
      running: this.running,
      lastTickAt: this.lastTickAt,
      timezone: this.config.timezone
    };
  }
}

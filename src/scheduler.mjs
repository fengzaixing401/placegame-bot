import { nowIso } from "./db.mjs";
import { rulesFor } from "./config.mjs";
import { compactForStore } from "./util.mjs";
import { isBenignError } from "./labels.mjs";

const TICK_MS = 60 * 1000;

// 动作把每步失败收进 result.errors 而不抛出(features/*.mjs 的约定),这样一个面板挂了
// 不影响其他面板。副作用是"一步都没成功"的任务也会正常返回,于是被记成 ok ——
// 实测踩到过:版本闸门把所有游戏接口打回 426 时,boss.map / boss.world / profession
// 三条任务在面板上全是绿的,实际一步都没成。真正的故障被绿色盖住了。
//
// 这里只认"非良性"的失败:游戏把每日上限也当错误返回(「今日已领取」「次数已用尽」),
// 那些不该让任务显示成有问题 —— 词表与日志渲染器共用一份(labels.mjs)。
// daily-run 的结果是嵌套的(每个子任务各带一份 errors),所以递归收集。
export function collectRealFailures(result, out = [], depth = 0) {
  if (!result || typeof result !== "object" || depth > 4) return out;
  if (Array.isArray(result)) {
    for (const item of result) collectRealFailures(item, out, depth + 1);
    return out;
  }
  if (Array.isArray(result.errors)) {
    for (const e of result.errors) {
      const msg = typeof e === "string" ? e : e?.error ?? e?.message;
      if (msg && !isBenignError(String(msg))) out.push(String(msg));
    }
  }
  for (const [key, value] of Object.entries(result)) {
    if (key === "errors") continue;
    if (value && typeof value === "object") collectRealFailures(value, out, depth + 1);
  }
  return out;
}

// 失败摘要写进 job_runs.error 列,长度上限与异常分支保持一致(500)。
function summarizeFailures(messages) {
  const uniq = [...new Set(messages)];
  const head = uniq.slice(0, 3).join(";");
  const more = uniq.length > 3 ? ` …等共 ${uniq.length} 项` : "";
  return `${uniq.length} 项失败:${head}${more}`.slice(0, 500);
}

// 地图首领刷新后等多久才发起挑战。服务端自报 refreshText「地图首领每 2 小时刷新」,
// 刷新边界是**绝对周期**(与北京时间的偶数点重合),所以起跑时刻固定取「边界 + 这个余量」。
// 3 分钟足够盖住服务端刷新的抖动;贴着边界(0 余量)发起会有一半轮次整轮被拦。
const MAP_REFRESH_MARGIN_MS = 3 * 60 * 1000;

// 时区换算:取指定 IANA 时区下的日期与分钟数。排程必须按 Asia/Shanghai 判断
// 游戏的时间窗口(世界首领 10-11 / 14-15 / 20-21 点、每日刷新),不能用容器本地时区。
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
// - aligned 型:用"边界 + 余量"折算出的格子序号,同一个刷新格子里只跑一次
//   (地图首领 —— 服务端的刷新是绝对周期,起跑时刻要对齐到它)
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
  // lastRunOf(jobKey) 给出该任务上一轮的起跑时刻(ISO,没跑过给 null)。
  // 现在只有测试还在传它 —— 地图首领改对齐排程后,排程不再依赖"上一轮什么时候跑的"。
  plannedJobs(rules, parts, now, lastRunOf = () => null) {
    const jobs = [];
    const slot = (hours) => Math.floor(now.getTime() / (hours * 3600 * 1000));

    // 对齐型:按**绝对周期**排,起跑时刻固定在「格子边界 + 余量」,而不是从上一轮往后推。
    //
    // 地图首领的刷新就是绝对周期(服务端自报「地图首领每 2 小时刷新」),所以起跑时刻该
    // 对齐到刷新格子。早先用的是滚动排程(上一轮 + 2 小时 + 3 分钟余量):每轮多漂 3 分钟,
    // 相位绕 2 小时格子转一圈约 3.3 天 —— 转到贴着边界的那一轮就撞上"服务端还没刷完",
    // 整轮白跑;离边界远的那几轮又白等。对齐之后每轮都稳定落在刷新之后。
    //
    // 余量由调用方给(地图首领用 MAP_REFRESH_MARGIN_MS)。幂等键取格子序号,
    // 所以一个格子里只会跑一轮,重启或手动 tick 都不会重复。
    const aligned = (key, hours, marginMs) => {
      const period = hours * 3600 * 1000;
      jobs.push({ key, idem: `${key}:slot-${Math.floor((now.getTime() - marginMs) / period)}` });
    };

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
      // 地图首领不受每日次数限制,只受刷新时间限制(服务端自报),所以按刷新格子对齐排
      aligned("boss.map", rules.boss.mapIntervalHours, MAP_REFRESH_MARGIN_MS);
      // 个人首领要显式开 challengePersonal 才排程:每日免费次数有限,
      // 用完服务端就自动扣门票,不该默认自动消耗。
      // 免费次数按北京时间每日重置,所以按"每天到点打一次"排,幂等键取当天日期。
      // 早先按 personalIntervalHours 切绝对时间片,24 小时片的片界落在 UTC 00:00
      // (北京 08:00),与游戏的重置时刻错开,实际起跑时刻会随时区漂。
      if (rules.boss.challengePersonal === true && parts.minutes >= toMinutes(rules.boss.personalAt ?? "09:00")) {
        jobs.push({ key: "boss.personal", idem: `boss.personal:${parts.date}` });
      }
      const win = activeWindow(parts, rules.boss.worldWindows);
      if (win) jobs.push({ key: "boss.world", idem: `boss.world:${parts.date}:${win}` });
    }
    if (rules.activity?.enabled && parts.minutes >= toMinutes(rules.activity.dailyAt)) {
      jobs.push({ key: "activity", idem: `activity:${parts.date}` });
    }
    return jobs;
  }

  // 某任务上一轮的起跑时刻。取"任意结果"的最近一轮(含 error 与空转)——
  // 只认成功会让一次报错把该任务永久卡住:键不变,到期判断也不前进。
  // started_at 是定长 UTC ISO,字典序即时间序,可直接排序取首行。
  //
  // 现在排程本身不再用它(地图首领改对齐排程后,没有任务依赖"上一轮什么时候跑的"),
  // 但保留着 —— 排查时想按任务看最近一轮很方便,删了反而要现写 SQL。
  #lastRunAt(accountId, jobKey) {
    const row = this.db
      .prepare(`SELECT started_at FROM job_runs WHERE account_id=? AND job_key=? ORDER BY started_at DESC LIMIT 1`)
      .get(accountId, jobKey);
    return row?.started_at ?? null;
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
      // 动作正常返回不等于成功:失败被收在 result.errors 里(见 collectRealFailures)。
      // 有真失败就不记 ok —— 记 partial 并把摘要写进 error 列,免得绿色盖住故障。
      const failures = collectRealFailures(result);
      if (failures.length > 0) {
        const summary = summarizeFailures(failures);
        this.db
          .prepare(`UPDATE job_runs SET status='partial', finished_at=?, result_json=?, error=? WHERE id=?`)
          .run(nowIso(), this.#storableResult(result), summary, runId);
        this.logger.error(`[scheduler] ${account.label}/${job.key} 有失败:${summary}`);
        return { status: "partial", result };
      }
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

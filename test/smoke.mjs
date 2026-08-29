import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/config.mjs";

// 端到端冒烟:用假游戏服务器驱动全栈(配置→加密→账号→客户端→features→REST),
// 不接触真实游戏服务端。断言失败即退出非 0。
const DB = join(ROOT, "data", "test-e2e.db");
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });

process.env.PLACEGAME_MASTER_KEY_B64 = randomBytes(32).toString("base64url");
process.env.PLACEGAME_API_TOKEN = "test-token-abc";
process.env.PLACEGAME_DB_PATH = DB;
process.env.PLACEGAME_SCHEDULER = "false";
// 测试走明文 HTTP,Secure cookie 会让真实浏览器拒收;这里也顺带覆盖该配置分支
process.env.PLACEGAME_WEB_SECURE_COOKIE = "false";

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

// ---- 假游戏服务器 ----
const calls = [];
function fakeFetch(url, opts = {}) {
  const path = new URL(url).pathname;
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ path, method: opts.method ?? "GET", body, headers: opts.headers });

  const reply = (data, status = 200) =>
    Promise.resolve({
      ok: status < 400,
      status,
      text: () => Promise.resolve(JSON.stringify({ ok: status < 400, data }))
    });

  switch (path) {
    case "/api/auth/login":
      // expiresAt 是毫秒时间戳
      if (body?.username === "fzx401" && body?.password === "secret") return reply({ sessionToken: "sess_ok", expiresAt: 1893456000000 });
      return Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve(JSON.stringify({ ok: false, error: "凭据错误" })) });

    case "/api/battle/idle-collect":
      // 第一次回冒险选项,第二次(带 key)才结算 —— 验证两阶段流程
      if (!body?.adventureOptionKey) return reply({ adventure: { options: [{ key: "opt_a", label: "A" }, { key: "opt_b" }] } });
      return reply({ rewardPreview: { exp: 100, gold: 50 }, chosen: body.adventureOptionKey });

    case "/api/client/idle-summary":
      return reply({ idlePreview: { validSeconds: 39600, exp: 900, gold: 400 } });

    case "/api/client/dynamic-view":
      return reply({
        maps: [{ key: "map_1", name: "森林", current: true }],
        bosses: [
          { key: "boss_map_1", type: "map", name: "地图首领", available: true, remainingAttemptCount: 2 },
          { key: "boss_map_2", type: "map", name: "次数用尽", available: true, remainingAttemptCount: 0 },
          { key: "boss_map_3", type: "map", name: "被封锁", available: false, blockedReason: "等级不足" },
          // 真实服务端用空字符串表示"无阻挡原因",仍必须被 available:false 挡住
          { key: "boss_map_4", type: "map", name: "封锁但无原因", available: false, blockedReason: "" },
          { key: "boss_w", type: "world", name: "世界首领", available: true }
        ],
        quests: [
          { questKey: "q1", canClaim: true },
          { questKey: "q2", claimed: true },
          { questKey: "q3", canClaim: true, available: false }
        ],
        achievements: [{ achievementKey: "a1", completed: true }]
      });

    case "/api/equipment/list":
      return reply({
        equipment: [
          { id: "e1", status: "in_bag", locked: false, quality: "common" },
          { id: "e2", status: "in_bag", locked: true, quality: "common" },
          { id: "e3", status: "equipped", locked: false, quality: "rare" },
          { id: "e4", status: "in_warehouse", locked: false, quality: "common" }
        ]
      });

    case "/api/equipment/decompose":
      return reply({ decomposed: body.equipmentIds, gained: { gold: 10 } });
    case "/api/equipment/auto-decompose":
      return reply({ decomposedCount: 4, gained: { gold: 40 } });
    case "/api/professions/settle":
      return reply({ settled: true });
    case "/api/professions/queue/enqueue":
      return reply({ queued: body.actionKey, count: body.count });
    case "/api/professions/select":
      return reply({ selected: body.professionKey });
    case "/api/guild/redeem":
      return reply({ redeemed: body.itemKey, amount: body.amount });
    case "/api/guild/donate":
      return reply({ donated: body.itemId, amount: body.amount });
    case "/api/guild/claim-dividend":
      return reply({ dividend: 500 });
    case "/api/boss/challenge":
      return reply({ battle: { win: true }, rewards: { summary: ["金币"] } });
    case "/api/boss/assist":
      return reply({ assisted: body.bossKey });
    case "/api/boss/claim-reward":
      return reply({ claimed: true });
    case "/api/boss/world-status":
      return reply({ status: "open", currentHp: 900, maxHp: 1000, remainingAttemptCount: 3 });
    case "/api/quests/claim":
      return reply({ claimed: body.questKey });
    case "/api/achievements/claim":
      return reply({ claimed: body.achievementKey });
    case "/api/retention/sign-in":
      return reply({ signedIn: true });
    case "/api/mail/claim-all":
      return reply({ claimedCount: 3 });
    default:
      return reply({ path }, 404);
  }
}

// ---- 组装 ----
const { loadConfig } = await import("../src/config.mjs");
const { openDb } = await import("../src/db.mjs");
const { SecretBox } = await import("../src/crypto.mjs");
const { AccountStore } = await import("../src/accounts/store.mjs");
const { AccountService } = await import("../src/accounts/service.mjs");
const { Scheduler } = await import("../src/scheduler.mjs");
const { createHttpServer } = await import("../src/http-server.mjs");
const { SettingsStore } = await import("../src/settings.mjs");
const { buildActions } = await import("../src/actions.mjs");
const { unwrap } = await import("../src/util.mjs");

console.log("\n[1] 配置与密钥校验");
const config = await loadConfig();
check("加载配置", config.dbPath === DB && config.timezone === "Asia/Shanghai");
try {
  const saved = process.env.PLACEGAME_MASTER_KEY_B64;
  delete process.env.PLACEGAME_MASTER_KEY_B64;
  await loadConfig();
  check("缺主密钥应报错", false, "未抛异常");
  process.env.PLACEGAME_MASTER_KEY_B64 = saved;
} catch {
  process.env.PLACEGAME_MASTER_KEY_B64 = randomBytes(32).toString("base64url");
  check("缺主密钥应报错", true);
}

// .env.example 里的变量名必须真被代码读到,否则用户照文档配置会被静默忽略
{
  const { readFileSync } = await import("node:fs");
  const documented = [...readFileSync(join(ROOT, ".env.example"), "utf8").matchAll(/^(PLACEGAME_\w+)=/gm)].map((m) => m[1]);
  // compose 也算消费方:宿主机端口只被 compose 读,不被 Node 读
  const src = ["config.mjs", "index.mjs", "http-server.mjs", "version.mjs"]
    .map((f) => readFileSync(join(ROOT, "src", f), "utf8"))
    .concat(readFileSync(join(ROOT, "docker-compose.yml"), "utf8"))
    .join("\n");
  const orphans = documented.filter((v) => !src.includes(v));
  check("env 文档与代码一致", orphans.length === 0, `代码未读取:${orphans.join(", ")}`);
  // 反向:代码读了但文档没写,用户根本不知道有这个开关
  const used = new Set([...src.matchAll(/PLACEGAME_[A-Z0-9_]+/g)].map((m) => m[0]));
  const undocumented = [...used].filter((v) => !documented.includes(v));
  check("代码读到的变量都有文档", undocumented.length === 0, `文档缺失:${undocumented.join(", ")}`);
}

console.log("\n[2] unwrap 处理 patch 包装");
check("omit 直取 data", unwrap({ ok: true, data: { a: 1 } }).a === 1);
check("patch 取 data.result", unwrap({ ok: true, data: { result: { a: 2 }, statePatch: {} } }).a === 2);
check("不误伤只有 result 的载荷", unwrap({ ok: true, data: { result: { a: 3 } } }).result.a === 3);

console.log("\n[3] 账号与动作");
const db = openDb(config.dbPath);
const store = new AccountStore(db, new SecretBox(config.masterKeyB64));
const service = new AccountService({ store, baseUrl: config.baseUrl, version: "0.2.50", fetchImpl: fakeFetch });
const actions = buildActions(config);
const scheduler = new Scheduler({ db, store, service, config, actions, logger: { log() {}, error() {} } });

service.create({
  label: "fzx401",
  gameUsername: "fzx401",
  password: "secret",
  rules: { profession: { professionKey: "fishing", enqueue: { fish_1: 5 } }, guild: { redeem: [{ itemKey: "k1", amount: 2 }], donate: [{ itemId: "i1" }] } }
});
check("账号创建", service.list().length === 1);
check("登录验证", (await service.verify("fzx401")).authed === true);
check("会话已加密落库", !!store.getByLabel("fzx401").session_token_enc);
check("会话过期时间落库", store.getByLabel("fzx401").session_expires_at === new Date(1893456000000).toISOString(), String(store.getByLabel("fzx401").session_expires_at));

const col = await service.run("fzx401", (api, row) => actions.collect(api, row));
check("收益两阶段冒险流程", col.adventureResolved === true && col.adventureOptionKey === "opt_a", JSON.stringify(col.collected));

const inv = await service.run("fzx401", (api, row) => actions.inventory(api, row, { mode: "explicit" }));
check("分解只选 in_bag 未锁(e1)", inv.decomposed === 1 && inv.equipmentIds[0] === "e1", JSON.stringify(inv.equipmentIds));

const prof = await service.run("fzx401", (api, row) => actions.profession(api, row));
check("副职 settle+select+enqueue", prof.settled && prof.selected?.selected === "fishing" && prof.enqueued[0]?.count === 5);

const g = await service.run("fzx401", (api, row) => actions.guild(api, row));
check("公会 redeem 用 itemKey", g.redeemed[0]?.result?.redeemed === "k1");
check("公会 donate 用 itemId", g.donated[0]?.result?.donated === "i1");
check("公会分红", g.dividend?.dividend === 500);

const bm = await service.run("fzx401", (api, row) => actions["boss.map"](api, row));
check("首领跳过次数用尽与被封锁", bm.attempted.length === 1 && bm.skipped.length === 3, JSON.stringify(bm.skipped.map((s) => s.reason)));
check("blockedReason 为空串也算阻挡", bm.skipped.some((s) => s.bossKey === "boss_map_4" && !!s.reason), JSON.stringify(bm.skipped));
check("首领挑战后领奖", bm.claimed?.claimed === true);

const act = await service.run("fzx401", (api, row) => actions.activity(api, row));
check("任务只领可领的(q1)", act.quests.length === 1 && act.quests[0].questKey === "q1", JSON.stringify(act.quests));
check("成就 completed 可领", act.achievements.length === 1);
check("签到与邮件", act.signIn?.signedIn === true && act.mail?.claimedCount === 3);

const st = await service.run("fzx401", (api, row) => actions.status(api, row));
check("状态汇总", st.idle?.validSeconds === 39600 && st.bosses === 5, JSON.stringify({ bosses: st.bosses }));

console.log("\n[4] 必带请求头");
const c = calls.find((x) => x.path === "/api/battle/idle-collect");
check("client-version", c.headers["x-placegame-client-version"] === "0.2.50");
check("client-platform=cli", c.headers["x-placegame-client-platform"] === "cli");
check("device-id 格式", /^device_[a-f0-9]{48}$/.test(c.headers["x-placegame-device-id"]));
check("response-state 合法", ["omit", "patch", "full"].includes(c.headers["x-placegame-response-state"]));
check("Bearer 会话", c.headers.authorization === "Bearer sess_ok");

console.log("\n[5] 认证失败熔断");
store.setSecret(store.getByLabel("fzx401").id, "password", "wrong");
store.setSession(store.getByLabel("fzx401").id, null);
service.clients.delete(store.getByLabel("fzx401").id);
for (let i = 0; i < 5; i++) {
  await service.verify("fzx401").catch(() => {});
}
check("连续失败后自动停用", store.getByLabel("fzx401").enabled === 0, `enabled=${store.getByLabel("fzx401").enabled}`);
check("停用原因已记录", !!store.getByLabel("fzx401").paused_reason);
service.setEnabled("fzx401", true);
store.setSecret(store.getByLabel("fzx401").id, "password", "secret");
check("恢复后失败计数清零", store.getByLabel("fzx401").auth_failure_count === 0);

console.log("\n[6] REST 接口");
const settings = new SettingsStore(db, new SecretBox(config.masterKeyB64), {
  envApiToken: config.apiToken,
  sessionHours: config.webSessionHours
});
const server = createHttpServer({ config, service, store, settings, scheduler, actions, version: "0.2.50", logger: { log() {}, error() {} } });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, path, { token = config.apiToken, body, cookie, csrf, ip } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      // 登录限流按 IP 计数,各用例用不同 IP 才不会互相污染
      ...(ip ? { "x-real-ip": ip } : {}),
      "content-type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, json: await res.json(), setCookie: res.headers.getSetCookie?.() ?? [] };
};

check("健康检查免鉴权", (await call("GET", "/health/live", { token: null })).status === 200);
const ready = await call("GET", "/health/ready", { token: null });
check("ready 含账号数", ready.json.data.accounts === 1 && ready.json.data.version === "0.2.50");
check("无令牌 401", (await call("GET", "/accounts", { token: null })).status === 401);
check("错误令牌 401", (await call("GET", "/accounts", { token: "bad" })).status === 401);
check("长度不同的令牌 401", (await call("GET", "/accounts", { token: "x" })).status === 401);
const accs = await call("GET", "/accounts");
check("列账号", accs.status === 200 && accs.json.data[0].label === "fzx401");
check("响应无凭据泄漏", !JSON.stringify(accs.json).match(/secret|sess_ok|_enc/));
check("不存在账号 404", (await call("GET", "/accounts/nope")).status === 404);
check("删除需 confirm", (await call("DELETE", "/accounts/fzx401", { body: {} })).status === 400);
check("方法不允许 405", (await call("PUT", "/accounts")).status === 405);
check("未知端点 404", (await call("GET", "/nope")).status === 404);
const restCollect = await call("POST", "/accounts/fzx401/collect", { body: {} });
check("REST 触发收益", restCollect.status === 200 && restCollect.json.data.adventureResolved === true);
const dr = await call("POST", "/accounts/fzx401/daily-run", { body: {} });
check("一键日常各步骤", Object.keys(dr.json.data.ran).length === 6, JSON.stringify(Object.keys(dr.json.data.ran)));
check("一键日常无错", dr.json.data.errors.length === 0, JSON.stringify(dr.json.data.errors));
check("默认走服务端 auto 分解", dr.json.data.ran.inventory?.mode === "auto", JSON.stringify(dr.json.data.ran.inventory));
const dis = await call("POST", "/accounts/fzx401/disable", { body: { reason: "维护" } });
check("停用账号", dis.json.data.enabled === false);
check("停用后动作 409", (await call("POST", "/accounts/fzx401/collect", { body: {} })).status === 409);
await call("POST", "/accounts/fzx401/enable");
const tasks = await call("GET", "/tasks");
check("排程状态", tasks.status === 200 && tasks.json.data.scheduler.timezone === "Asia/Shanghai");

console.log("\n[7] WebUI 鉴权与设置");
const WEB_PW = "correct-horse-battery-staple";

for (const [path, type] of [["/", "text/html"], ["/app.js", "javascript"], ["/style.css", "text/css"]]) {
  const res = await fetch(`${base}${path}`);
  check(`静态资源 ${path}`, res.status === 200 && res.headers.get("content-type").includes(type));
}

const sess0 = await call("GET", "/api/web/session", { token: null });
check("未设密码时提示需初始化", sess0.json.data.needsSetup === true && sess0.json.data.authenticated === false);
check("ready 报令牌来源为 env", ready.json.data.apiTokenSource === "env" && ready.json.data.webPasswordSet === false);

check("初始设置需令牌", (await call("POST", "/api/web/setup", { token: null, body: { password: WEB_PW } })).status === 401);
check("初始设置拒短密码", (await call("POST", "/api/web/setup", { body: { password: "short" } })).status === 400);
check("初始设置成功", (await call("POST", "/api/web/setup", { body: { password: WEB_PW } })).status === 200);
check("重复初始设置 409", (await call("POST", "/api/web/setup", { body: { password: WEB_PW } })).status === 409);

// 登录:错密码不给会话,对密码给会话
const badLogin = await call("POST", "/api/web/login", { token: null, ip: "10.0.0.1", body: { password: "wrong" } });
check("错密码 401", badLogin.status === 401 && badLogin.setCookie.length === 0);

const login = await call("POST", "/api/web/login", { token: null, ip: "10.0.0.2", body: { password: WEB_PW } });
const rawCookie = login.setCookie[0] ?? "";
check("登录返回会话 cookie", login.status === 200 && rawCookie.includes("pg_session="));
check("cookie 带 HttpOnly/SameSite", rawCookie.includes("HttpOnly") && rawCookie.includes("SameSite=Strict"), rawCookie);
check("测试环境不加 Secure", !rawCookie.includes("Secure"), rawCookie);
const cookie = rawCookie.split(";")[0];
const csrf = login.json.data.csrfToken;
check("登录返回 csrfToken", typeof csrf === "string" && csrf.length > 20);

// 会话可访问受保护端点,且 GET 不需要 CSRF
const byCookie = await call("GET", "/accounts", { token: null, cookie });
check("会话可列账号", byCookie.status === 200 && byCookie.json.data.length === 1);
check("会话被识别", (await call("GET", "/api/web/session", { token: null, cookie })).json.data.authenticated === true);
check("伪造 cookie 401", (await call("GET", "/accounts", { token: null, cookie: "pg_session=forged" })).status === 401);

// 写操作必须带 CSRF 头
check(
  "会话写操作缺 CSRF 403",
  (await call("POST", "/accounts/fzx401/collect", { token: null, cookie, body: {} })).status === 403
);
check(
  "错 CSRF 403",
  (await call("POST", "/accounts/fzx401/collect", { token: null, cookie, csrf: "nope", body: {} })).status === 403
);
check(
  "带 CSRF 可写",
  (await call("POST", "/accounts/fzx401/collect", { token: null, cookie, csrf, body: {} })).status === 200
);
// Bearer 走 agent 通道,本就无 cookie 可被诱导,不该被 CSRF 拦
check("Bearer 写操作免 CSRF", (await call("POST", "/accounts/fzx401/collect", { body: {} })).status === 200);

// 每 IP 独立限流:同一 IP 连错 5 次锁定,换 IP 不受影响
for (let i = 0; i < 5; i++) await call("POST", "/api/web/login", { token: null, ip: "10.0.0.9", body: { password: "wrong" } });
const locked = await call("POST", "/api/web/login", { token: null, ip: "10.0.0.9", body: { password: WEB_PW } });
check("同 IP 连错 5 次锁定", locked.status === 429, String(locked.status));
check(
  "锁定不影响其他 IP",
  (await call("POST", "/api/web/login", { token: null, ip: "10.0.0.10", body: { password: WEB_PW } })).status === 200
);

// 轮换令牌:旧令牌立刻失效,新令牌可用,来源转为 db
const rotated = await call("POST", "/api/web/api-token", {
  token: null,
  cookie,
  csrf,
  body: { currentPassword: WEB_PW }
});
check("轮换令牌成功", rotated.status === 200 && typeof rotated.json.data.token === "string");
const newToken = rotated.json.data.token;
check("新令牌够长", newToken.length >= 40, String(newToken.length));
check("旧令牌失效", (await call("GET", "/accounts", { token: "test-token-abc" })).status === 401);
check("新令牌可用", (await call("GET", "/accounts", { token: newToken })).status === 200);
check(
  "ready 报令牌来源转为 db",
  (await call("GET", "/health/ready", { token: null })).json.data.apiTokenSource === "db"
);
check(
  "轮换需密码",
  (await call("POST", "/api/web/api-token", { token: null, cookie, csrf, body: { currentPassword: "wrong" } })).status === 401
);

// 改密:验旧密码,且作废其他会话
const other = await call("POST", "/api/web/login", { token: null, ip: "10.0.0.11", body: { password: WEB_PW } });
const otherCookie = (other.setCookie[0] ?? "").split(";")[0];
check("第二个会话可用", (await call("GET", "/accounts", { token: null, cookie: otherCookie })).status === 200);
check(
  "改密需旧密码",
  (await call("POST", "/api/web/password", { token: null, cookie, csrf, body: { currentPassword: "wrong", newPassword: "a".repeat(12) } })).status === 401
);
const NEW_PW = "another-long-password-99";
const changed = await call("POST", "/api/web/password", {
  token: null,
  cookie,
  csrf,
  body: { currentPassword: WEB_PW, newPassword: NEW_PW }
});
check("改密成功", changed.status === 200);
check("其他会话被作废", (await call("GET", "/accounts", { token: null, cookie: otherCookie })).status === 401);
check("本会话仍有效", (await call("GET", "/accounts", { token: null, cookie })).status === 200);
check("旧密码登录失败", (await call("POST", "/api/web/login", { token: null, ip: "10.0.0.12", body: { password: WEB_PW } })).status === 401);
check("新密码登录成功", (await call("POST", "/api/web/login", { token: null, ip: "10.0.0.13", body: { password: NEW_PW } })).status === 200);

// 登出后会话立即不可用
await call("POST", "/api/web/logout", { token: null, cookie, csrf });
check("登出后会话失效", (await call("GET", "/accounts", { token: null, cookie })).status === 401);

// 密码哈希与会话令牌都不该以明文落库
{
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const dump = JSON.stringify(rows);
  check("库中无明文密码", !dump.includes(NEW_PW) && !dump.includes(WEB_PW));
  check("库中无明文令牌", !dump.includes(newToken));
  const ids = db.prepare("SELECT id FROM web_sessions").all().map((r) => r.id);
  check("会话表只存哈希", ids.every((id) => /^[0-9a-f]{64}$/.test(id)), JSON.stringify(ids));
}

server.close();
db.close();
rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });

console.log(`\n${failed === 0 ? "全部通过" : "存在失败"}:${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);

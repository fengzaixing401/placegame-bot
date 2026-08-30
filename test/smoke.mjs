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
// 可变状态:用例要分别覆盖"免费次数还有"与"免费次数用尽"两种门票场景
let freeAttempts = 3;
// world-status 只是展示用的场次信息。协作闸门在首领行的 assistBlockedReason /
// worldInstance 上,不在这个接口 —— 真号 7 个世界首领全是这样。
let worldStatusRows = [
  { instanceId: "wb_boss_w_fixed_20", bossKey: "boss_w", status: "active",
    maxHp: 1000, currentHp: 900, hpPercent: 90, participantCount: 12, maxAttemptCount: 3 }
];
// 世界首领行的协作闸门,用例要分别覆盖"可协作"与"场次已结束"
let worldAssistBlocked = "";

// 难度档。真号每个首领都带 difficultyOptions 三档,门票消耗按类型分野:
// 个人首领三档全 0(扣的是 personalAttemptPool),地图/世界 普通 0 / 困难 1 / 噩梦 2。
// 缺了这个字段,useTickets:false 时后端会按"读不到门票消耗"整批跳过 —— 那是刻意的保守行为。
const diffs = (kind, chance = 95) => {
  const tickets = kind === "personal" ? [0, 0, 0] : [0, 1, 2];
  return [
    { key: "normal", name: "普通", ticketCost: tickets[0], chance, predictedWin: chance >= 50 },
    { key: "hard", name: "困难", ticketCost: tickets[1], chance, predictedWin: chance >= 50 },
    { key: "nightmare", name: "噩梦", ticketCost: tickets[2], chance, predictedWin: chance >= 50 }
  ];
};
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
        // 字段照真号形状造:可挑战 = blockedReason 为空串;顶层没有 available,
        // 也没有 remainingAttemptCount(21 个首领的字段全集里都没有这两个)。
        bosses: [
          { key: "boss_map_1", type: "map", name: "地图首领", blockedReason: "", difficultyOptions: diffs("map") },
          { key: "boss_map_2", type: "map", name: "次数用尽", blockedReason: "", difficultyOptions: diffs("map") },
          { key: "boss_map_3", type: "map", name: "被封锁", blockedReason: "等级不足", difficultyOptions: diffs("map") },
          // 困难档单独封锁(材料不够),行级却是放行的 —— 只看行级会漏掉这种
          { key: "boss_map_4", type: "map", name: "困难档材料不够", blockedReason: "",
            difficultyOptions: [
              { key: "normal", name: "普通", ticketCost: 0, chance: 95, predictedWin: true },
              { key: "hard", name: "困难", ticketCost: 1, chance: 95, predictedWin: true, blockedReason: "解毒草不足" },
              { key: "nightmare", name: "噩梦", ticketCost: 2, chance: 95, predictedWin: true }
            ] },
          // 可挑战但胜率不足,用来验证胜率闸门确实会拦
          { key: "boss_low", type: "map", name: "胜率不足", blockedReason: "", difficultyOptions: diffs("map", 30) },
          // 个人首领:默认必须完全不碰(野猪王回归用例)。免费次数在行级 personalAttemptPool 上
          { key: "boss_pig", type: "personal", name: "野猪王", blockedReason: "",
            difficultyOptions: diffs("personal"),
            personalAttemptPool: { freeRemaining: freeAttempts, freeLimit: 5, ticketUsed: 0, ticketLimit: 5, nextTicketCost: 0 } },
          { key: "boss_w", type: "world", name: "世界首领", blockedReason: "",
            difficultyOptions: diffs("world"),
            assistBlockedReason: worldAssistBlocked,
            worldInstance: { instanceId: "wb_boss_w_fixed_20", bossKey: "boss_w", status: "active",
              hpPercent: 90, participantCount: 12, remainingAttemptCount: 3 } }
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
    case "/api/boss/preview":
      // boss_low 故意给低胜率,验证闸门会拦下
      return body?.bossKey === "boss_low"
        ? reply({ predictedWin: false, chance: 30 })
        : reply({ predictedWin: true, chance: 95 });
    case "/api/boss/challenge":
      return reply({ battle: { win: true }, rewards: { summary: ["金币"] } });
    case "/api/boss/assist":
      return reply({ assisted: body.bossKey });
    case "/api/boss/claim-reward":
      return reply({ claimed: true });
    // 真实服务端返回的是实例数组(每项自带 status),不是单个对象。
    // 早先这里照单对象造假数据,把「窗口外跳过」读不到状态的 bug 一直遮住了。
    case "/api/boss/world-status":
      return reply(worldStatusRows);
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
const bossFeature = await import("../src/features/boss.mjs");

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

// explicit 必须带收紧条件,这里按品质筛 common:e1 拆,e2 锁着、e3 穿着、e4 在仓库都留
const inv = await service.run("fzx401", (api, row) =>
  actions.inventory(api, row, { mode: "explicit", conditions: { qualities: ["common"] } })
);
check("分解只选 in_bag 未锁(e1)", inv.equipmentIds?.length === 1 && inv.equipmentIds[0] === "e1", JSON.stringify(inv.equipmentIds));
check("逐件给出保留原因", inv.kept.some((k) => k.equipmentId === "e2" && /锁/.test(k.reason)), JSON.stringify(inv.kept));

// 一个收紧条件都不给会拆光背包,必须在发请求前就被拦下
let allBagGuard = null;
try {
  await service.run("fzx401", (api, row) => actions.inventory(api, row, { mode: "explicit", conditions: {} }));
} catch (err) {
  allBagGuard = err.message;
}
check("explicit 无条件被拦下", /至少要设一个收紧条件/.test(allBagGuard ?? ""), String(allBagGuard));

// keepRareRank 只保护极品,不构成收紧条件,同样要被拦
let rareOnlyGuard = null;
try {
  await service.run("fzx401", (api, row) =>
    actions.inventory(api, row, { mode: "explicit", conditions: { keepRareRank: true } })
  );
} catch (err) {
  rareOnlyGuard = err.message;
}
check("只勾保留极品不算收紧条件", /至少要设一个收紧条件/.test(rareOnlyGuard ?? ""), String(rareOnlyGuard));

// auto 没有预览端点,dryRun 必须报错而不是静默真拆
let autoPreviewGuard = null;
try {
  await service.run("fzx401", (api, row) => actions.inventory(api, row, { mode: "auto", dryRun: true }));
} catch (err) {
  autoPreviewGuard = err.message;
}
check("auto 模式拒绝预览", /没有预览端点/.test(autoPreviewGuard ?? ""), String(autoPreviewGuard));

// maxScore:0 能骗过收紧条件校验(typeof 0 === "number"),却筛不中任何一件 ——
// 静默拆不动东西比报错更难查。前端空输入必须读成 null 而不是 Number("")===0,
// 这条测试守的是"0 不等于不限制"这个语义。
const zeroCond = await service.run("fzx401", (api, row) =>
  actions.inventory(api, row, { mode: "explicit", conditions: { maxScore: 0 } })
);
check("maxScore:0 一件都不拆", zeroCond.matched === 0, JSON.stringify(zeroCond.matched));
// 原本唯一会被拆的 e1 现在也留下了,原因落在评分条件上
check(
  "maxScore:0 让 e1 因评分被留下",
  /评分/.test(zeroCond.kept.find((k) => k.equipmentId === "e1")?.reason ?? ""),
  JSON.stringify(zeroCond.kept.map((k) => `${k.equipmentId}:${k.reason}`))
);

// 页面存规则时"没填"落库为 null(不是 0)。null 必须被当成没设这个条件:
// 既不参与收紧条件判定,也不参与筛选。这是 WebUI 实际写进库的形状。
const nullCond = await service.run("fzx401", (api, row) =>
  actions.inventory(api, row, {
    mode: "explicit",
    conditions: { maxScore: null, maxLevel: null, qualities: ["common"], keepRareRank: true, keepAttrs: [] }
  })
);
check("null 条件不影响筛选,仍按品质拆 e1", nullCond.equipmentIds?.length === 1 && nullCond.equipmentIds[0] === "e1", JSON.stringify(nullCond.equipmentIds));

// 只有 null 条件、没有品质时,等于什么都没设,必须被拦下
let nullOnlyGuard = null;
try {
  await service.run("fzx401", (api, row) =>
    actions.inventory(api, row, { mode: "explicit", conditions: { maxScore: null, maxLevel: null, qualities: [] } })
  );
} catch (err) {
  nullOnlyGuard = err.message;
}
check("全 null 条件被拦下", /至少要设一个收紧条件/.test(nullOnlyGuard ?? ""), String(nullOnlyGuard));

const prof = await service.run("fzx401", (api, row) => actions.profession(api, row));
check("副职 settle+select+enqueue", prof.settled && prof.selected?.selected === "fishing" && prof.enqueued[0]?.count === 5);

const g = await service.run("fzx401", (api, row) => actions.guild(api, row));
check("公会 redeem 用 itemKey", g.redeemed[0]?.result?.redeemed === "k1");
check("公会 donate 用 itemId", g.donated[0]?.result?.donated === "i1");
check("公会分红", g.dividend?.dividend === 500);

const bm = await service.run("fzx401", (api, row) => actions["boss.map"](api, row));
const bmSkip = (key) => bm.skipped.find((s) => s.bossKey === key);
// 普通档不扣门票,所以 useTickets:false 也能打;被拦的只该是行级封锁与胜率不足那两个
check(
  "只打得动的才打",
  bm.attempted.length === 3 &&
    ["boss_map_1", "boss_map_2", "boss_map_4"].every((k) => bm.attempted.some((x) => x.bossKey === k)),
  JSON.stringify({ a: bm.attempted.map((x) => x.bossKey), s: bm.skipped.map((s) => `${s.bossKey}:${s.reason}`) })
);
// blockedReason 为空串是"可挑战"(真号 21 个首领全是空串),不能反过来当阻挡
check("空串 blockedReason 不算阻挡", !bmSkip("boss_map_1") && !bmSkip("boss_map_4"), JSON.stringify(bm.skipped.map((s) => s.bossKey)));
check("行级封锁被拦下", /等级不足/.test(bmSkip("boss_map_3")?.reason ?? ""), JSON.stringify(bmSkip("boss_map_3")));
check("胜率不足被闸门拦下", /胜率|预测会输/.test(bmSkip("boss_low")?.reason ?? ""), JSON.stringify(bmSkip("boss_low")));
check("挑战前先调 preview", calls.some((x) => x.path === "/api/boss/preview" && x.body?.bossKey === "boss_map_1"));

// 难度档自带的封锁只在该档体现,行级是放行的 —— 选到那档才该被拦
const bmHard = await service.run("fzx401", (api, row) => actions["boss.map"](api, row, { rules: { difficulty: "hard", useTickets: true } }));
check(
  "困难档材料不足只在该档被拦",
  /解毒草不足/.test(bmHard.skipped.find((s) => s.bossKey === "boss_map_4")?.reason ?? ""),
  JSON.stringify(bmHard.skipped.map((s) => `${s.bossKey}:${s.reason}`))
);
// 困难档要扣 1 张门票,禁用门票时必须整批停手(旧代码只查个人首领,这里门票照扣)
const bmHardNoTicket = await service.run("fzx401", (api, row) => actions["boss.map"](api, row, { rules: { difficulty: "hard", useTickets: false } }));
check(
  "禁用门票时困难档一律不打",
  bmHardNoTicket.attempted.length === 0 &&
    bmHardNoTicket.skipped.some((s) => /要扣 1 张门票/.test(s.reason)),
  JSON.stringify(bmHardNoTicket.skipped.map((s) => `${s.bossKey}:${s.reason}`))
);
check("难度写进输出", bm.difficulty === "normal", String(bm.difficulty));
// 野猪王回归:默认配置下个人首领连候选都不该进,skipped 里也不该出现
check(
  "个人首领默认完全不碰",
  !bm.attempted.some((x) => x.bossKey === "boss_pig") && !bm.skipped.some((s) => s.bossKey === "boss_pig"),
  JSON.stringify({ a: bm.attempted.map((x) => x.bossKey), s: bm.skipped.map((x) => x.bossKey) })
);
check("首领挑战后领奖", bm.claimed?.claimed === true);

// 走 boss.personal 动作而不是裸调 runBosses:类型闸门写在动作里(types: [personal]),
// 绕过它就测不到"这个动作只碰个人首领"。个人首领读的是 personalDifficulty,不是 difficulty。
// challengePersonal 只管要不要自动排程(见 scheduler.mjs),不拦手动执行,故这里不传。
const runPersonal = (over) =>
  service.run("fzx401", (api, row) =>
    actions["boss.personal"](api, row, {
      rules: { personalDifficulty: "normal", minWinChance: 80, requirePredictedWin: true, ...over }
    })
  );

const bpOpen = await runPersonal({ personalBosses: [] });
check(
  "开了个人首领但未点名仍不打",
  !bpOpen.attempted.some((x) => x.bossKey === "boss_pig") &&
    bpOpen.skipped.some((s) => s.bossKey === "boss_pig" && /未在 personalBosses/.test(s.reason)),
  JSON.stringify(bpOpen.skipped)
);

freeAttempts = 0;
const bpNoFree = await runPersonal({ personalBosses: ["boss_pig"], useTickets: false });
check(
  "免费次数用尽且禁用门票则不打",
  !bpNoFree.attempted.some((x) => x.bossKey === "boss_pig") &&
    bpNoFree.skipped.some((s) => s.bossKey === "boss_pig" && /免费次数已用尽/.test(s.reason)),
  JSON.stringify({ free: bpNoFree.freeAttemptsLeft, s: bpNoFree.skipped })
);

const bpTicket = await runPersonal({ personalBosses: ["boss_pig"], useTickets: true });
check("允许门票时才打", bpTicket.attempted.some((x) => x.bossKey === "boss_pig"), JSON.stringify(bpTicket.skipped));

freeAttempts = 3;
const bpFree = await runPersonal({ personalBosses: ["boss_pig"], useTickets: false });
check("免费次数够则正常打", bpFree.attempted.some((x) => x.bossKey === "boss_pig"), JSON.stringify(bpFree.skipped));

// 世界首领:只参与协作讨伐 + 领奖,不主动挑战 —— 主攻会按困难/噩梦档扣门票,与本意相反。
// 协作闸门在首领行的 assistBlockedReason / worldInstance 上,不在 world-status 接口。
const callsBeforeOpen = calls.length;
const wbOpen = await service.run("fzx401", (api, row) => actions["boss.world"](api, row));
const wbOpenPaths = calls.slice(callsBeforeOpen).map((c) => c.path);
check(
  "可协作时走 assist 并记下中文名",
  wbOpen.assisted.length === 1 &&
    wbOpen.assisted[0].bossKey === "boss_w" &&
    wbOpen.assisted[0].name === "世界首领" &&
    wbOpen.skipped.length === 0,
  JSON.stringify({ assisted: wbOpen.assisted, skipped: wbOpen.skipped })
);
check("世界首领不主动挑战也不调 preview", !wbOpenPaths.includes("/api/boss/challenge") && !wbOpenPaths.includes("/api/boss/preview"), JSON.stringify(wbOpenPaths));
check("协作成功后领奖", wbOpen.claimed?.claimed === true, JSON.stringify(wbOpen.claimed));
check("场次信息照原样带出供页面显示", Array.isArray(wbOpen.status) && wbOpen.status[0]?.status === "active", JSON.stringify(wbOpen.status));

// 服务端给了协作阻挡原因就必须停手,且一次 assist 都不发
worldAssistBlocked = "当前世界首领场次未开放或已经结束。";
const callsBeforeBlocked = calls.length;
const wbBlocked = await service.run("fzx401", (api, row) => actions["boss.world"](api, row));
check(
  "被服务端拦下时不发 assist 也不领奖",
  wbBlocked.assisted.length === 0 &&
    /场次未开放或已经结束/.test(wbBlocked.skipped[0]?.reason ?? "") &&
    wbBlocked.claimed === null &&
    !calls.slice(callsBeforeBlocked).some((c) => c.path === "/api/boss/assist" || c.path === "/api/boss/claim-reward"),
  JSON.stringify({ skipped: wbBlocked.skipped, paths: calls.slice(callsBeforeBlocked).map((c) => c.path) })
);
worldAssistBlocked = "";

// 点了名就只协作名单里那几个
const wbNamed = await service.run("fzx401", (api) => bossFeature.runWorldBoss(api, { rules: { worldBosses: ["别的首领"] } }));
check("点名后不在名单里的不协作", wbNamed.assisted.length === 0 && wbNamed.skipped.length === 0, JSON.stringify(wbNamed.assisted));

worldStatusRows = [
  { instanceId: "wb_boss_w_fixed_20", bossKey: "boss_w", status: "active",
    maxHp: 1000, currentHp: 900, hpPercent: 90, participantCount: 12, maxAttemptCount: 3 }
];

const act = await service.run("fzx401", (api, row) => actions.activity(api, row));
check("任务只领可领的(q1)", act.quests.length === 1 && act.quests[0].questKey === "q1", JSON.stringify(act.quests));
check("成就 completed 可领", act.achievements.length === 1);
check("签到与邮件", act.signIn?.signedIn === true && act.mail?.claimedCount === 3);

const st = await service.run("fzx401", (api, row) => actions.status(api, row));
check("状态汇总", st.idle?.validSeconds === 39600 && st.bosses === 7, JSON.stringify({ bosses: st.bosses }));

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
// 长度不设下限(用户要求可随意设置),但空密码仍必须拒 —— 那等于没有密码。
// 短密码能不能设在下面用改密接口验(setup 只能成功一次)
check("初始设置拒空密码", (await call("POST", "/api/web/setup", { body: { password: "" } })).status === 400);
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

// 密码长度不设下限(用户要求可随意设置),但空密码仍必须拒 —— 那等于没有密码。
// 放在这里而不是 setup 段:setup 只能成功一次,改密可以反复调,能真正走通"设短密码再用它登录"。
const SHORT_PW = "abc";
check(
  "改密拒空密码",
  (await call("POST", "/api/web/password", { token: null, cookie, csrf, body: { currentPassword: NEW_PW, newPassword: "" } })).status === 400
);
check(
  "短密码可以设",
  (await call("POST", "/api/web/password", { token: null, cookie, csrf, body: { currentPassword: NEW_PW, newPassword: SHORT_PW } })).status === 200
);
check("短密码能登录", (await call("POST", "/api/web/login", { token: null, ip: "10.0.0.14", body: { password: SHORT_PW } })).status === 200);
// 改回长密码,让后面"库中无明文密码"查的是当前生效的那个
check(
  "短密码可以改回",
  (await call("POST", "/api/web/password", { token: null, cookie, csrf, body: { currentPassword: SHORT_PW, newPassword: NEW_PW } })).status === 200
);

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

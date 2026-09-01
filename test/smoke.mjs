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
// dynamic-view 连续失败几次。取首领名单就靠这个端点,它抖一下整轮首领任务就没了 ——
// 真号上有一轮 boss.world 整个任务 status=error、result_json 为空,7 个首领一个都没打。
let viewFailures = 0;

// 协作场次的可变状态。真号实测每场次 maxAttemptCount=3,assist 响应自带 worldBoss 段,
// 循环协作就是靠它驱动的 —— 假响应少了这段,循环会走"读不到次数就停手",
// 于是"每个首领只协作一次"的老 bug 在测试里照样全绿。
// frozen: 服务端不把这次算进去(remainingAttemptCount 不往下走),用来测空转停手。
let assistState = { my: 0, max: 3, status: "active", frozen: false };
const resetAssist = (over = {}) => {
  assistState = { my: 0, max: 3, status: "active", frozen: false, ...over };
};

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
      // 注入快照失败:503 会一路穿过 api-client 的退避重试抛成 ApiError,
      // 正是真号上"请求超时"那一轮的形状
      if (viewFailures > 0) {
        viewFailures -= 1;
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve(JSON.stringify({ ok: false, error: "请求超时。" }))
        });
      }
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
    // 真号形状:顶层 damage,场次进度在 worldBoss 段。没有 cost 字段 —— 协作不扣门票。
    case "/api/boss/assist": {
      if (!assistState.frozen) assistState.my += 1;
      const left = Math.max(0, assistState.max - assistState.my);
      return reply({
        damage: 529852,
        worldBoss: {
          instanceId: "wb_boss_w_fixed_20",
          bossKey: body.bossKey,
          maxHp: 1000,
          currentHp: 900,
          hpPercent: 90,
          status: assistState.status,
          maxAttemptCount: assistState.max,
          myDamage: 529852 * assistState.my,
          myDamagePercent: 0.7771 * assistState.my,
          myAttemptCount: assistState.my,
          remainingAttemptCount: left,
          rewardStatus: "pending"
        }
      });
    }
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
const { Scheduler, zonedParts } = await import("../src/scheduler.mjs");
const { createHttpServer } = await import("../src/http-server.mjs");
const { SettingsStore } = await import("../src/settings.mjs");
const { buildActions } = await import("../src/actions.mjs");
const { unwrap } = await import("../src/util.mjs");
const { GameApiClient } = await import("../src/api-client.mjs");
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
// 普通档不扣门票,所以 useTickets:false 也能打;被拦的只该是行级封锁与胜率不足那两个。
// boss_w 也在里面:游戏里「地图首领」那一栏是 12 个 = type=map 5 个 + type=world 7 个,
// 那 7 个在这一栏是可挑战目标(受地图规则约束),在世界首领面板才是协作目标。
check(
  "只打得动的才打",
  bm.attempted.length === 4 &&
    ["boss_map_1", "boss_map_2", "boss_map_4", "boss_w"].every((k) => bm.attempted.some((x) => x.bossKey === k)),
  JSON.stringify({ a: bm.attempted.map((x) => x.bossKey), s: bm.skipped.map((s) => `${s.bossKey}:${s.reason}`) })
);
// 这一条单拎出来:早先 boss.map 只传 types:[MAP],12 个里那 7 个从没被挑战过 ——
// 这就是"地图首领没有全部挑战"的真因,不是刷新时间也不是次数限制。
check(
  "世界首领在地图这一栏会被当挑战目标",
  bm.attempted.some((x) => x.bossKey === "boss_w") && !bmSkip("boss_w"),
  JSON.stringify({ a: bm.attempted.map((x) => x.bossKey), s: bm.skipped.map((s) => `${s.bossKey}:${s.reason}`) })
);
// 协作闸门不该干扰挑战:boss_w 的 assistBlockedReason 是有值的(场次未开放),
// 但那只拦协作。拿它拦挑战会让这 7 个又整批消失。
check(
  "协作闸门不影响挑战判定",
  bm.attempted.some((x) => x.bossKey === "boss_w"),
  JSON.stringify({ assistBlocked: worldAssistBlocked, a: bm.attempted.map((x) => x.bossKey) })
);
// blockedReason 为空串是"可挑战"(真号 21 个首领全是空串),不能反过来当阻挡
check("空串 blockedReason 不算阻挡", !bmSkip("boss_map_1") && !bmSkip("boss_map_4"), JSON.stringify(bm.skipped.map((s) => s.bossKey)));
check("行级封锁被拦下", /等级不足/.test(bmSkip("boss_map_3")?.reason ?? ""), JSON.stringify(bmSkip("boss_map_3")));
check("胜率不足被闸门拦下", /胜率|预测会输/.test(bmSkip("boss_low")?.reason ?? ""), JSON.stringify(bmSkip("boss_low")));
check("挑战前先调 preview", calls.some((x) => x.path === "/api/boss/preview" && x.body?.bossKey === "boss_map_1"));

// 次数上限每类首领各一个键。早先三类共用 maxChallengesPerRun,在个人首领面板
// 填 10 会把地图首领也卡在 10(而这一栏有 12 个),两边设置互相干扰。
const bmCap = await service.run("fzx401", (api, row) => actions["boss.map"](api, row, { rules: { mapMaxPerRun: 2 } }));
check(
  "地图首领吃 mapMaxPerRun 的上限",
  bmCap.attempted.length === 2,
  JSON.stringify(bmCap.attempted.map((x) => x.bossKey))
);
// 反向:个人首领的次数键不该被地图那个键左右
const bpCap = await service.run("fzx401", (api, row) =>
  actions["boss.personal"](api, row, { rules: { personalBosses: ["boss_pig"], personalMaxPerDay: 3, mapMaxPerRun: 1 } })
);
check(
  "个人首领不受 mapMaxPerRun 影响",
  bpCap.attempted.length === 3,
  JSON.stringify({ a: bpCap.attempted.map((x) => x.bossKey), s: bpCap.skipped.map((s) => `${s.bossKey}:${s.reason}`) })
);

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
resetAssist();
const callsBeforeOpen = calls.length;
const wbOpen = await service.run("fzx401", (api, row) => actions["boss.world"](api, row));
const wbOpenPaths = calls.slice(callsBeforeOpen).map((c) => c.path);
// 每场次 maxAttemptCount=3,必须协作到次数用尽 —— 只打 1 次等于白丢 2/3 的伤害贡献
check(
  "协作到本场次次数用尽",
  wbOpen.assisted.length === 3 &&
    wbOpen.assisted.every((a) => a.bossKey === "boss_w" && a.name === "世界首领") &&
    wbOpen.assisted.map((a) => a.remainingAttemptCount).join(",") === "2,1,0" &&
    wbOpen.skipped.length === 0,
  JSON.stringify({ assisted: wbOpen.assisted, skipped: wbOpen.skipped })
);
// 判定与展示字段都要在浅层:深层 result.worldBoss.* 会被落库裁剪掉,整个 result 又渲不出东西
check(
  "每次协作只记浅层战果,不存整个响应",
  wbOpen.assisted[0].result === undefined &&
    wbOpen.assisted[0].damage === 529852 &&
    wbOpen.assisted[2].myAttemptCount === 3 &&
    wbOpen.assisted[2].maxAttemptCount === 3 &&
    wbOpen.assisted[0].round === 1,
  JSON.stringify(wbOpen.assisted[0])
);
check("世界首领不主动挑战也不调 preview", !wbOpenPaths.includes("/api/boss/challenge") && !wbOpenPaths.includes("/api/boss/preview"), JSON.stringify(wbOpenPaths));
check("协作成功后领奖", wbOpen.claimed?.claimed === true, JSON.stringify(wbOpen.claimed));
check("场次信息照原样带出供页面显示", Array.isArray(wbOpen.status) && wbOpen.status[0]?.status === "active", JSON.stringify(wbOpen.status));

// 血条被全服打空(defeated)/场次时间到(ended):次数还剩也打不了了,必须立刻收手
resetAssist({ status: "defeated" });
const wbDefeated = await service.run("fzx401", (api, row) => actions["boss.world"](api, row));
check(
  "场次已不是 active 就停手",
  wbDefeated.assisted.length === 1 && wbDefeated.assisted[0].status === "defeated",
  JSON.stringify(wbDefeated.assisted)
);

// 服务端没把这次算进去(剩余次数不往下走),再发只是空转 —— 必须停,否则是死循环
resetAssist({ frozen: true });
const wbFrozen = await service.run("fzx401", (api, row) => actions["boss.world"](api, row));
check(
  "剩余次数不推进就停手,不空转",
  wbFrozen.assisted.length === 2 && wbFrozen.errors.length === 0,
  JSON.stringify({ assisted: wbFrozen.assisted.length, errors: wbFrozen.errors })
);
resetAssist();

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

// ---- 取首领名单失败时的兜底 ----
// 真号上有一轮 boss.world 整个任务 status=error、result_json 为空,7 个首领一个都没打,
// 就因为取名单那个 GET 超时了。api-client 已经退避重试过两次(前后约 3 秒),
// 但游戏服务端抽风往往比这更久,所以隔一段时间再补试一次。
//
// 这几条要跑的路径带 12 秒补试等待与 800/2000ms 退避,真睡下来这一节要空等半分钟。
// 换成"立刻回调"。阈值卡在 13 秒:要盖住 12 秒的补试,又必须留住客户端 15 秒的 abort
// 计时器 —— 那条也走 setTimeout,一起加速就等于每个请求都立刻 abort。
const unpatchedTimer = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) =>
  ms > 0 && ms < 13000 ? unpatchedTimer(fn, 0, ...rest) : unpatchedTimer(fn, ms, ...rest);

resetAssist();
// 3 次 = 头一轮的 1 次 + 2 次退避重试全用光,补试那次才拿到名单
viewFailures = 3;
const callsBeforeFlaky = calls.length;
const wbFlaky = await service.run("fzx401", (api) => bossFeature.runWorldBoss(api, { rules: {} }));
const flakyViews = calls.slice(callsBeforeFlaky).filter((c) => c.path === "/api/client/dynamic-view").length;
check(
  "取名单先失败后补试成功,整轮照常协作",
  flakyViews === 4 &&
    viewFailures === 0 &&
    wbFlaky.assisted.length === 3 &&
    !wbFlaky.errors.some((e) => e.step === "listBosses"),
  JSON.stringify({ views: flakyViews, assisted: wbFlaky.assisted.length, errors: wbFlaky.errors })
);

// 补试也失败:必须带着错误正常返回。抛出去会让整个任务 status=error、result_json 为空,
// 日志上只剩一句"请求超时",看不出这一轮到底做了什么。
resetAssist();
viewFailures = 6;
let wbDead;
let wbThrew = null;
try {
  wbDead = await service.run("fzx401", (api) => bossFeature.runWorldBoss(api, { rules: {} }));
} catch (err) {
  wbThrew = err.message;
}
// 这一条只管"不抛、记错误",不连带断言补试了几次 —— 补试次数由上一条守。
check(
  "取名单两次都失败不抛异常,只记错误",
  wbThrew === null &&
    wbDead?.errors.some((e) => e.step === "listBosses") &&
    wbDead.assisted.length === 0,
  JSON.stringify({ threw: wbThrew, result: wbDead })
);

// 地图首领走的是另一个入口(runBosses),同样不能把异常扔给排程
viewFailures = 6;
let bmDead;
let bmThrew = null;
try {
  bmDead = await service.run("fzx401", (api, row) => actions["boss.map"](api, row));
} catch (err) {
  bmThrew = err.message;
}
check(
  "地图首领取名单失败同样不抛",
  bmThrew === null &&
    bmDead?.errors.some((e) => e.step === "listBosses") &&
    bmDead.attempted.length === 0,
  JSON.stringify({ threw: bmThrew, result: bmDead })
);
viewFailures = 0;
globalThis.setTimeout = unpatchedTimer;
resetAssist();

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

// ---- 排程触发时机 ----
// plannedJobs 只决定"这一 tick 要不要排",真正的去重交给 job_runs 的唯一约束。
// 第四个参数就是"上一轮起跑时刻"的注入点,所以这里不必碰私有 #lastRunAt,也不必等真实时间。
// 地图首领是唯一改成滚动型的任务:绝对时间片的片界固定(2 小时片落在偶数点整)、
// 与游戏的刷新周期同频,每轮都贴着刷新边界发起,实测约一半轮次整轮被服务端拦掉。
const planRules = {
  collect: { enabled: true, intervalHours: 2 },
  boss: { enabled: true, mapIntervalHours: 2, challengePersonal: false, worldWindows: [] }
};
const planAt = (iso, last = {}) => {
  const now = new Date(iso);
  return scheduler.plannedJobs(planRules, zonedParts(now, config.timezone), now, (k) => last[k] ?? null);
};
const planKeys = (iso, last) => planAt(iso, last).map((j) => j.key);
const planIdem = (iso, key, last) => planAt(iso, last).find((j) => j.key === key)?.idem ?? null;

const LAST_MAP = "2026-08-31T02:00:00.000Z";
check(
  "地图首领没跑过就立刻排",
  planKeys("2026-08-31T02:00:00.000Z").includes("boss.map") &&
    planIdem("2026-08-31T02:00:00.000Z", "boss.map") === "boss.map:init",
  JSON.stringify(planAt("2026-08-31T02:00:00.000Z"))
);
check(
  "刚跑过就不排",
  !planKeys("2026-08-31T02:30:00.000Z", { "boss.map": LAST_MAP }).includes("boss.map"),
  JSON.stringify(planAt("2026-08-31T02:30:00.000Z", { "boss.map": LAST_MAP }))
);
// 核心一条:整 2 小时到了但余量没满就是不排。老方案恰恰在这个时刻发起,
// 而一轮里首领是依次打的、发起时刻本身还带 tick 抖动,于是整轮贴边被拦。
check(
  "满 2 小时但没满 3 分钟余量,仍然不排",
  !planKeys("2026-08-31T04:00:00.000Z", { "boss.map": LAST_MAP }).includes("boss.map") &&
    !planKeys("2026-08-31T04:02:59.000Z", { "boss.map": LAST_MAP }).includes("boss.map"),
  JSON.stringify(planAt("2026-08-31T04:00:00.000Z", { "boss.map": LAST_MAP }))
);
check(
  "凑够 2 小时 3 分就排,幂等键取上一轮时刻",
  planIdem("2026-08-31T04:03:00.000Z", "boss.map", { "boss.map": LAST_MAP }) === `boss.map:${LAST_MAP}`,
  JSON.stringify(planAt("2026-08-31T04:03:00.000Z", { "boss.map": LAST_MAP }))
);
// job_runs 的唯一约束是 (account_id, idempotency_key),不含 job_key ——
// 幂等键不自带任务前缀,不同任务就会互相顶掉。
check(
  "幂等键都自带任务前缀",
  planAt("2026-08-31T04:03:00.000Z", { "boss.map": LAST_MAP }).every((j) => j.idem.startsWith(`${j.key}:`)),
  JSON.stringify(planAt("2026-08-31T04:03:00.000Z", { "boss.map": LAST_MAP }))
);
// 上一轮时刻只喂给滚动型任务,interval 型的键仍是绝对时间片编号
check(
  "interval 型任务不受滚动改动影响",
  planIdem("2026-08-31T04:03:00.000Z", "collect", { "boss.map": LAST_MAP, collect: LAST_MAP }) ===
    `collect:${Math.floor(Date.parse("2026-08-31T04:03:00.000Z") / (2 * 3600 * 1000))}`,
  JSON.stringify(planAt("2026-08-31T04:03:00.000Z", { collect: LAST_MAP }))
);
// 落库时刻坏掉(手工改库/时钟回拨写进脏值)就当没跑过照常排,而不是永久卡住
check(
  "上一轮时刻不可解析时按没跑过处理",
  planIdem("2026-08-31T04:03:00.000Z", "boss.map", { "boss.map": "坏值" }) === "boss.map:坏值",
  JSON.stringify(planAt("2026-08-31T04:03:00.000Z", { "boss.map": "坏值" }))
);

// 个人首领按"每天到点打一次"排,不再按间隔切绝对时间片:免费次数是北京时间每日重置的,
// 24 小时片的片界落在 UTC 00:00(北京 08:00),与重置时刻错开。
// personalAt 是北京时间,zonedParts 已按 Asia/Shanghai 折算,所以 09:00 = UTC 01:00。
const perRules = {
  boss: {
    enabled: true,
    mapIntervalHours: 2,
    challengePersonal: true,
    personalAt: "09:00",
    worldWindows: []
  }
};
const perAt = (iso) => {
  const now = new Date(iso);
  return scheduler.plannedJobs(perRules, zonedParts(now, config.timezone), now, () => null);
};
const perKeys = (iso) => perAt(iso).map((j) => j.key);
check(
  "没到点不排个人首领",
  !perKeys("2026-08-31T00:30:00.000Z").includes("boss.personal"),
  JSON.stringify(perAt("2026-08-31T00:30:00.000Z"))
);
check(
  "到点就排,幂等键按当天日期(一天只跑一轮)",
  perAt("2026-08-31T01:00:00.000Z").find((j) => j.key === "boss.personal")?.idem === "boss.personal:2026-08-31",
  JSON.stringify(perAt("2026-08-31T01:00:00.000Z"))
);
check(
  "同一天晚些时候幂等键不变",
  perAt("2026-08-31T15:00:00.000Z").find((j) => j.key === "boss.personal")?.idem === "boss.personal:2026-08-31",
  JSON.stringify(perAt("2026-08-31T15:00:00.000Z"))
);
check(
  "没开 challengePersonal 就一直不排",
  !scheduler
    .plannedJobs(
      { boss: { ...perRules.boss, challengePersonal: false } },
      zonedParts(new Date("2026-08-31T15:00:00.000Z"), config.timezone),
      new Date("2026-08-31T15:00:00.000Z"),
      () => null
    )
    .map((j) => j.key)
    .includes("boss.personal")
);

// 个人首领的次数是整轮预算 —— 服务端的池子是共享一池(实测免费 5 + 门票 5)。
// 早先"点名的每个首领各打一次"让只点了一个首领的账号每天只用掉 1 次。
const poolRow = (over = {}) => [
  { personalAttemptPool: { freeRemaining: 5, freeLimit: 5, ticketUsed: 0, ticketLimit: 5, ...over } }
];
const budget = (rows, rules, useTickets) => bossFeature.personalBudget(rows, rules, useTickets);
check(
  "预算取用户设的次数",
  budget(poolRow(), { personalMaxPerDay: 3 }, false) === 3
);
check(
  "不允许用票时,预算封顶在剩余免费次数",
  budget(poolRow({ freeRemaining: 2 }), { personalMaxPerDay: 10 }, false) === 2
);
check(
  "允许用票时,免费加门票一起算容量",
  budget(poolRow({ freeRemaining: 2 }), { personalMaxPerDay: 10 }, true) === 7
);
check(
  "门票已用掉一部分就不重复计入",
  budget(poolRow({ freeRemaining: 0, ticketUsed: 3 }), { personalMaxPerDay: 10 }, true) === 2
);
check(
  "免费用尽且不许用票时预算为 0",
  budget(poolRow({ freeRemaining: 0 }), { personalMaxPerDay: 5 }, false) === 0
);
// 读不到池子就不猜次数,退回老行为打一次
check("读不到池子时预算为 1", budget([{}], {}, false) === 1);
check("没设次数时按池子容量吃满", budget(poolRow(), {}, false) === 5);

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

console.log("\n[6] 请求重试与退避");
// 这一节最要紧的一条是"POST 默认不重试"。decompose 重发会把已经拆掉的装备再拆一批,
// challenge 重发会重复扣次数与门票 —— 那种错误在真号上不可逆,所以默认值必须有断言守着。
//
// 退避真睡 800ms + 2000ms,整节跑下来要好几秒。这里把 setTimeout 换成"小延时立刻回调、
// 顺手记下时长",既不拖慢测试,又能顺带验证退避间隔本身。abort 计时器也走 setTimeout,
// 所以客户端统一给 30 秒超时:只加速 5 秒以下的延时,abort 那条不受影响。
const realSetTimeout = globalThis.setTimeout;
let sleeps = [];
globalThis.setTimeout = (fn, ms, ...rest) =>
  ms > 0 && ms < 5000 ? (sleeps.push(ms), realSetTimeout(fn, 0, ...rest)) : realSetTimeout(fn, ms, ...rest);

// 按脚本逐次作答的假 fetch。每项对应一次请求:
//   "timeout" -> AbortError(客户端译成 code=TIMEOUT)
//   "network" -> 连不上(code=NETWORK)
//   数字      -> 该状态码的失败响应(5xx 走 code=SERVER)
//   "badjson" -> 200 但正文不是 JSON(code=BAD_JSON)
//   "ok"      -> 正常响应;登录端点额外给 sessionToken
function scriptedClient(script) {
  const seen = [];
  const client = new GameApiClient({
    baseUrl: "http://127.0.0.1:1",
    version: "0.2.50",
    deviceId: "device_" + "0".repeat(48),
    username: "fzx401",
    password: "secret",
    timeoutMs: 30000,
    fetchImpl: (url, opts = {}) => {
      const path = new URL(url).pathname;
      seen.push({ path, method: opts.method ?? "GET" });
      const step = script[seen.length - 1] ?? "ok";
      if (step === "timeout") {
        const err = new Error("aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      }
      if (step === "network") return Promise.reject(new Error("ECONNREFUSED"));
      if (step === "badjson") {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("<html>502</html>") });
      }
      if (typeof step === "number") {
        return Promise.resolve({
          ok: false,
          status: step,
          text: () => Promise.resolve(JSON.stringify({ ok: false, error: `HTTP ${step}` }))
        });
      }
      const data = path === "/api/auth/login" ? { sessionToken: "sess_retry", expiresAt: 1893456000000 } : { fine: true };
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ ok: true, data })) });
    }
  });
  client.setSession("sess_pre"); // 预置会话,免得每个用例都先打一次登录
  return { client, seen };
}
const attempt = async (script, path, opts) => {
  sleeps = [];
  const { client, seen } = scriptedClient(script);
  const out = await client.request(path, opts).then(
    () => ({ ok: true }),
    (err) => ({ ok: false, code: err.code, message: err.message })
  );
  return { ...out, calls: seen.length, paths: seen.map((s) => s.path), sleeps: [...sleeps] };
};

// 核心安全性质:POST 默认预算 0。谁把这个默认值改开了,这条就会红。
const postTimeout = await attempt(["timeout"], "/api/equipment/decompose", { method: "POST", body: { equipmentIds: ["e1"] } });
check(
  "POST 默认一次都不重试",
  postTimeout.ok === false && postTimeout.calls === 1 && postTimeout.code === "TIMEOUT",
  JSON.stringify(postTimeout)
);
// 分解与挑战是不可逆的,连"传了 retries 才重试"都得确认它们没传
const postBudget = await attempt([500, "ok"], "/api/boss/challenge", { method: "POST", body: { bossKey: "b" } });
check("POST 遇 5xx 也不自动重发", postBudget.ok === false && postBudget.calls === 1, JSON.stringify(postBudget));

// GET 只读,重发安全,默认吃满 RETRY_BACKOFF_MS 两次
const getRecovers = await attempt(["timeout", 502, "ok"], "/api/client/dynamic-view");
check(
  "GET 默认重试 2 次,退避 800/2000ms",
  getRecovers.ok === true && getRecovers.calls === 3 && JSON.stringify(getRecovers.sleeps) === "[800,2000]",
  JSON.stringify(getRecovers)
);
const getExhausted = await attempt(["timeout", "network", 503, "ok"], "/api/client/dynamic-view");
check(
  "GET 预算用尽就抛,不无限重试",
  getExhausted.ok === false && getExhausted.calls === 3 && getExhausted.code === "SERVER",
  JSON.stringify(getExhausted)
);

// assist 走的就是这条:世界首领协作不扣门票也不扣次数,重发是安全的,所以显式开了 2 次
const assistRetry = await attempt(["timeout", "ok"], "/api/boss/assist", { method: "POST", body: { bossKey: "b" }, retries: 2 });
check(
  "POST 显式传 retries 才重试",
  assistRetry.ok === true && assistRetry.calls === 2 && JSON.stringify(assistRetry.sleeps) === "[800]",
  JSON.stringify(assistRetry)
);
// 不只验 request 的预算,连 assist 这条真实调用路径一起验:R15 丢掉的那个首领
// 就是 assist 撞上超时后整个首领被跳过的
sleeps = [];
const assistPath = scriptedClient(["timeout", "ok"]);
const assistOut = await bossFeature.assist(assistPath.client, "boss_w").then(
  () => ({ ok: true }),
  (err) => ({ ok: false, message: err.message })
);
check(
  "assist 撞上超时会自己重发,不丢首领",
  assistOut.ok === true && assistPath.seen.length === 2 && assistPath.seen[1].path === "/api/boss/assist",
  JSON.stringify({ ...assistOut, calls: assistPath.seen.length })
);

// 重发结果不会变的错误一律不重试:4xx 是入参/状态问题,坏 JSON 再要一次还是坏的
for (const [name, script, code] of [
  ["4xx 不重试", [400, "ok"], "SERVER"],
  ["404 不重试", [404, "ok"], "SERVER"],
  ["坏 JSON 不重试", ["badjson", "ok"], "BAD_JSON"]
]) {
  const r = await attempt(script, "/api/client/dynamic-view");
  check(name, r.ok === false && r.calls === 1 && r.code === code, JSON.stringify(r));
}

// 401 走的是另一条路径:重登后只重试一次,且不进退避循环
const reauth = await attempt([401, "ok", "ok"], "/api/client/dynamic-view");
check(
  "401 重登后重试一次就成功",
  reauth.ok === true && reauth.calls === 3 && reauth.paths[1] === "/api/auth/login" && reauth.sleeps.length === 0,
  JSON.stringify(reauth)
);
// 一直 401 时不能变成"重登-重试"的死循环,也不该退避空转
const reauthDead = await attempt([401, "ok", 401], "/api/client/dynamic-view");
check(
  "一直 401 就抛原错,不循环重登",
  reauthDead.ok === false && reauthDead.code === "AUTH" && reauthDead.calls === 3 && reauthDead.sleeps.length === 0,
  JSON.stringify(reauthDead)
);

globalThis.setTimeout = realSetTimeout;

console.log("\n[7] REST 接口");
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

console.log("\n[8] WebUI 鉴权与设置");
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
// 400 而不是 401:请求带着有效会话,只是密码填错了。页面上的 guarded() 把 401/403
// 当会话过期处理(清 csrf、跳回登录页),用 401 会把"密码错误"显示成"登录已失效"。
check(
  "轮换需密码,密码错返 400 而非 401",
  (await call("POST", "/api/web/api-token", { token: null, cookie, csrf, body: { currentPassword: "wrong" } })).status === 400
);

// 改密:验旧密码,且作废其他会话
const other = await call("POST", "/api/web/login", { token: null, ip: "10.0.0.11", body: { password: WEB_PW } });
const otherCookie = (other.setCookie[0] ?? "").split(";")[0];
check("第二个会话可用", (await call("GET", "/accounts", { token: null, cookie: otherCookie })).status === 200);
check(
  "改密需旧密码,密码错返 400 而非 401",
  (await call("POST", "/api/web/password", { token: null, cookie, csrf, body: { currentPassword: "wrong", newPassword: "a".repeat(12) } })).status === 400
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

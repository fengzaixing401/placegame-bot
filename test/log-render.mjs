// 日志渲染器测试。log.js 是浏览器脚本,这里用最小 DOM 替身把它跑起来,
// 断言"页面上不出现 JSON"以及关键行的措辞。
// 用真号落库记录的等价样本喂进去 —— 字段名与取值全部来自 job_runs 实测。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import vm from "node:vm";
import { browserScript } from "../src/labels.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 极简 DOM:只实现 log.js 用到的那几个方法
function fakeDoc() {
  const make = (tag) => ({
    // 真 DOM 的 tagName 是大写,替身要照做,否则测出来的行为跟浏览器里不一致
    tagName: String(tag).toUpperCase(), className: "", style: {}, children: [], _text: "",
    set textContent(v) { this._text = String(v); this.children.length = 0; },
    get textContent() {
      return this.children.length
        ? this.children.map((c) => c.textContent).join("\n")
        : this._text;
    },
    appendChild(c) { this.children.push(c); return c; }
  });
  return { createElement: make };
}

export function loadPGLog() {
  // 用 vm 而不是 new Function:浏览器里 window 就是全局对象本身,所以 labels.js 的
  // window.PGL=... 会落成真正的全局,log.js 里那些裸 PGL 才找得到。
  // 拿普通对象当 window 传进 new Function 做不到这一点 —— PGL 仍未定义,
  // 每个渲染器都掉进 catch,整份测试变成在断言"日志渲染出错"的措辞。
  const context = vm.createContext({ document: fakeDoc() });
  vm.runInContext("var window = globalThis;", context);
  // 按 index.html 的顺序装:labels.js → log.js。
  // 顺带把 browserScript() 纳入常规测试 —— 那段代码在模板字符串里,node --check 看不进去。
  vm.runInContext(browserScript(), context);
  vm.runInContext(readFileSync(join(ROOT, "src/web/log.js"), "utf8"), context);
  return { PGLog: context.window.PGLog, PGL: context.window.PGL, doc: context.document };
}

const { PGLog, doc } = loadPGLog();
const text = (data, key) => PGLog.lines(data, key).map((l) => l.t).join("\n");

// ---- 样本:字段与取值取自真号 job_runs ----
export const SAMPLES = {
  collect: {
    before: {
      validSeconds: 8126.529, efficiency: 1.55, exp: 464836, gold: 654746, killCount: 797,
      rareCoinFragments: 3, dropCount: 18,
      foodBonus: { itemKey: "travel_ration", name: "行旅鱼饭", coveredSeconds: 7200, bonusAmount: 23241, stat: "exp", consume: 1 }
    },
    collected: { rewardPreview: { validSeconds: 0, efficiency: 1.55, exp: 0, gold: 0, killCount: 0 } },
    adventureResolved: false
  },
  inventory: {
    mode: "auto",
    result: {
      equipmentChanges: [], removedEquipmentIds: ["eq_a", "eq_b", "eq_c"], removedItemsIds: [],
      itemsChanges: [
        { id: "it_1", itemKey: "strengthen_stone", name: "强化石", itemType: "material", quality: "green", amount: 74, status: "in_bag" },
        { id: "it_2", itemKey: "relic_shard", name: "遗迹碎片", itemType: "material", quality: "purple", amount: 1560, status: "in_bag" }
      ]
    }
  },
  profession: {
    settled: {
      result: { completed: [{ actionKey: "gather_starroot", amount: 4 }], elapsedSeconds: 3595, pauseReason: "" },
      view: {
        professions: [{ key: "herbalism", name: "采药" }],
        actions: [{ key: "gather_starroot", name: "采集星根" }, { key: "gather_dawn_herb", name: "采集晨露草" }],
        supplies: {
          foods: [{ key: "travel_ration", owned: 24, name: "行旅鱼饭", stat: "exp", bonus: 0.05 }],
          bossPotions: [{ key: "boss_potion", owned: 3, name: "首领药剂" }]
        }
      }
    },
    selected: null, enqueued: [], errors: []
  },
  guild: {
    redeemed: [], donated: [], equipmentDonated: [], dividend: null, progress: [],
    errors: [{ step: "claimDividend", error: "今日完成捐献后才能领取公会分红。" }]
  },
  // 形状对着真实 runBosses 的输出核过(用 _bosses.json 的 21 个真号首领行跑出来的):
  // 顶层 attempted/claimed/difficulty/errors/freeAttemptsLeft/gate/personalDifficulty/skipped,
  // attempted 行 bossKey/difficulty/dryRun/forecast/name/result/win,skipped 行 bossKey/difficulty/name/reason。
  // freeAttemptsLeft 是快照里所有个人首领免费次数的最小值 —— 快照不按类型过滤,
  // 所以打地图首领时它照样是个数字,不会是 null。
  "boss.map": {
    difficulty: "nightmare",
    personalDifficulty: "normal",
    gate: { minWinChance: 80, requirePredictedWin: true, useTickets: true },
    freeAttemptsLeft: 5,
    attempted: [{
      bossKey: "nightmare_treant", name: "梦魇古树", difficulty: "nightmare", dryRun: false, win: true,
      forecast: { chance: 98, predictedWin: true },
      result: {
        player: { hp: 1, gold: 2 },
        notices: [{ message: "分解 21 件装备,获得 12144074 金币、遗迹碎片 x156。", createdAt: 1787983186979 }],
        battle: {
          win: true, winChance: 98, rounds: 39, durationSeconds: 9.75,
          playerHp: 59807, playerHpRemaining: 59807, bossHp: 155763, bossHpRemaining: 0,
          powerBottleneck: "survival"
        },
        cost: { ticketCost: 2, goldCost: 7020, materialCost: 8, materialName: "幽暗木材", ownedTickets: 4256, ownedMaterial: 945 },
        rewards: {
          exp: 5760, gold: 0,
          summary: ["经验 5760", "传说毒牙刃 x1", "高级强化石 x8", "洗练石 x12", "定向洗练符 x3", "保护符 x3", "遗迹碎片 x4"],
          drops: [{ id: "eq_1", name: "传说龙纹刃", quality: "red", level: 87, score: 4300, rareRank: "极品" }]
        }
      }
    }],
    skipped: [
      { bossKey: "eclipse_king", name: "日蚀君王", difficulty: "nightmare", reason: "预测会输", forecast: { chance: 12, predictedWin: false } },
      { bossKey: "frostfire_king", name: "霜火君王", difficulty: "nightmare", reason: "预测会输", forecast: { chance: 4, predictedWin: false } }
    ],
    claimed: { claimed: false, message: "首领奖励在挑战胜利时即时发放。" },
    errors: [{ bossKey: "boar_king", name: "野猪王", error: "今日个人首领门票追加次数已用尽。" }]
  },
  activity: {
    quests: [], achievements: [], codex: [], daily: [], signIn: null, mail: {},
    errors: [{ step: "signIn", error: "今日签到奖励已领取。" }]
  }
};

// 直接 node 跑才执行断言;被 import 时只提供 loadPGLog / SAMPLES
if (process.argv[1] && fileURLToPath(import.meta.url) !== process.argv[1]) {
  // 被当模块引用,跳过断言
} else {

let pass = 0;
const check = (name, fn) => {
  fn();
  pass += 1;
  console.log(`  ok  ${name}`);
};

console.log("日志渲染:");

check("collect 报出收取前的真实到手数量", () => {
  const t = text(SAMPLES.collect, "collect");
  assert.match(t, /经验 464,836/);
  assert.match(t, /金币 654,746/);
  assert.match(t, /击杀 797/);
  assert.match(t, /2 小时 15 分/); // 8126s
  assert.match(t, /行旅鱼饭/);
  assert.doesNotMatch(t, /经验 0/); // 清零后的累加器不能当成到手数量
});

check("collect 没有快照时说清楚说不出到手数量,而不是报 0", () => {
  const t = text({ collected: { rewardPreview: { exp: 0, gold: 0 } }, adventureResolved: false }, "collect");
  assert.match(t, /没读到收取前的收益概览/);
  assert.doesNotMatch(t, /经验 0 /);
});

check("inventory auto 报件数,并说明材料数是存量不是增量", () => {
  const t = text(SAMPLES.inventory, "inventory");
  assert.match(t, /已分解装备 3 件/);
  assert.match(t, /不是这次获得数/);
  assert.match(t, /强化石 现有 74/);
});

check("inventory explicit 逐件给出拆与留的原因", () => {
  const t = text({
    mode: "explicit", dryRun: true,
    conditions: { maxScore: 3000, maxLevel: 80, qualities: ["green", "blue"], keepRareRank: true, keepAttrs: ["attack"] },
    scanned: 40, matched: 1, keptCount: 1,
    targets: [{ equipmentId: "eq_1", name: "精良短剑", quality: "blue", level: 60, score: 1200, rareRank: null }],
    kept: [{ equipmentId: "eq_2", name: "传说龙纹刃", quality: "red", level: 87, score: 4300, rareRank: "极品", reason: "极品词条 极品" }],
    result: null
  }, "inventory");
  assert.match(t, /仅预览,没有真的分解/);
  assert.match(t, /评分低于 3,000/);
  // 品质一律显示游戏内档位名。条件行还要按档位从低到高排,不跟着入参顺序 ——
  // 规则可能是 REST/agent 存进来的,顺序任意。
  assert.match(t, /品质 优秀\/精良/);
  assert.match(t, /将分解 精良短剑\(精良 · 60 级 · 评分 1,200\)/);
  assert.match(t, /传说龙纹刃.*极品词条/);
  assert.doesNotMatch(t, /极品 极品品/);
  // 英文色名一个都不该露出来
  assert.doesNotMatch(t, /blue|red|green/);
});

check("profession 用响应里的中文动作名,不用 key", () => {
  const t = text(SAMPLES.profession, "profession");
  assert.match(t, /采集星根 x4/);
  assert.doesNotMatch(t, /gather_starroot/);
  assert.match(t, /行旅鱼饭 x24/);
});

check("boss 用游戏自己的 summary,不碰收件箱 notices", () => {
  const t = text(SAMPLES["boss.map"], "boss.map");
  assert.match(t, /挑战 梦魇古树\(噩梦\):胜利/);
  assert.match(t, /获得 经验 5760、传说毒牙刃 x1/);
  assert.match(t, /39 回合/);
  assert.match(t, /门票 2\(剩 4,256\)/);
  assert.match(t, /极品掉落 传说龙纹刃/);
  assert.match(t, /日蚀君王 —— 预测会输\(预测胜率 12%\)/);
  assert.match(t, /首领奖励在挑战胜利时即时发放。/);
  // 免费次数只在读到数字时才渲染(log.js 只认 typeof number),样本从前是 null,
  // 这一行一直没被任何测试走到过
  assert.match(t, /剩余免费次数 5/);
  // 难度记在每条结果上,且显示游戏内档位名 —— 个人与地图首领各有自己那档,
  // 只在开头写一次会张冠李戴
  assert.match(t, /噩梦/);
  assert.doesNotMatch(t, /nightmare/);
  // 收件箱里别的动作产生的通知,绝不能算进这次战斗
  assert.doesNotMatch(t, /分解 21 件装备/);
  // 玩家整体快照不该出现
  assert.doesNotMatch(t, /"hp"/);
});

check("每日上限归到提示,不算失败", () => {
  for (const k of ["boss.map", "guild", "activity"]) {
    const t = text(SAMPLES[k], k);
    assert.match(t, /提示\(每日上限之类,不算失败\)/, k);
    assert.doesNotMatch(t, /失败 \d+ 项/, k);
  }
});

check("落库裁剪标记被说成裁剪,不当数据渲染", () => {
  const t = text({
    mode: "explicit", conditions: { maxScore: 100 }, scanned: 30, matched: 2, keptCount: 28,
    targets: [{ name: "短剑", quality: "green" }, "…另有 5 项"],
    kept: [], result: null
  }, "inventory");
  assert.match(t, /另有 5 项未记录\(落库时已裁剪\)/);
  assert.doesNotMatch(t, /…另有 5 项$/m);
});

// 真号 boss.world 的实际落库形状:battle 被裁成标记字符串,且没有 win 字段。
// 旧渲染把标记当对象读,渲出「 回合 · 耗时 0 秒 · 胜率 %」「我方生命 / · 首领生命 /」,
// 还因为读不到 win 就默认判「失败」——那是编造战果。
check("battle 被裁剪时不编造战果、不渲空壳", () => {
  const worldCut = {
    status: { status: "open" },
    assisted: [],
    attempted: [
      { bossKey: "golden_goblet_guard", name: "金樽守卫", result: { battle: "[对象,超出深度]" } }
    ],
    claimed: { message: "首领奖励在挑战胜利时即时发放。" },
    errors: []
  };
  const t = text(worldCut, "boss.world");
  assert.match(t, /挑战 金樽守卫:战果未记录/);
  assert.match(t, /战斗详情内容嵌套过深,未记录/);
  // 空值骨架:标签后面直接跟分隔符或单位
  assert.doesNotMatch(t, /挑战 金樽守卫:失败/);
  assert.doesNotMatch(t, /^\s*回合/m);
  assert.doesNotMatch(t, /胜率 %/);
  assert.doesNotMatch(t, /生命 \//);
  assert.doesNotMatch(t, /耗时 0 秒/);
  // 摘要不能把"没记录"算成失败
  assert.doesNotMatch(PGLog.oneLine(worldCut, "boss.world"), /项失败/);
});

check("battle 字段缺一半时只写读到的那部分", () => {
  const t = text({
    attempted: [
      { bossKey: "x", name: "半残首领", win: false, result: { battle: { win: false, rounds: 12, bossHp: 500 } } }
    ]
  }, "boss.world");
  assert.match(t, /挑战 半残首领:失败/);
  assert.match(t, /12 回合/);
  assert.doesNotMatch(t, /胜率/);   // winChance 缺失
  assert.doesNotMatch(t, /耗时/);   // durationSeconds 缺失
  assert.match(t, /首领生命上限 500/);
  assert.doesNotMatch(t, /我方生命/); // 我方两个字段都缺
});

// worldStatus 实测返回实例数组,旧写法按单对象读 d.status.status,这行从来没渲染过
check("世界首领状态按数组渲染,并借 attempted 的中文名", () => {
  const t = text({
    status: [
      { bossKey: "golden_goblet_guard", status: "active", hpPercent: 90.02, participantCount: 12 },
      { bossKey: "no_data_boss" }
    ],
    attempted: [{ bossKey: "golden_goblet_guard", name: "金樽守卫", win: true, result: { battle: { win: true, rounds: 3 } } }]
  }, "boss.world");
  assert.match(t, /金樽守卫:进行中 · 剩余血量 90\.02% · 12 人参战/);
  assert.doesNotMatch(t, /golden_goblet_guard/); // 有中文名就不露键
  assert.doesNotMatch(t, /no_data_boss:/);       // 一个字段都读不到就整行不出
});

// 真号实测:每个世界首领会协作到本场次次数用尽(maxAttemptCount=3),assisted 里每次一条,
// 存的是浅层战果而不是整个响应 —— 深层 result.worldBoss.* 会被落库裁剪掉,
// 而 resultNote 只读 message/msg、协作响应两个键都没有,存了也一个字渲不出来。
check("世界首领按首领归并协作次数,不平铺每一次", () => {
  const shared = { bossKey: "scarlet_duke", name: "猩红公爵", maxAttemptCount: 3, hpPercent: 95.29, status: "active" };
  const t = text({
    assisted: [
      { ...shared, round: 1, damage: 529852, myDamagePercent: 0.7771, myAttemptCount: 1, remainingAttemptCount: 2 },
      { ...shared, round: 2, damage: 512300, myDamagePercent: 1.53, myAttemptCount: 2, remainingAttemptCount: 1 },
      { ...shared, round: 3, damage: 500000, myDamagePercent: 2.26, myAttemptCount: 3, remainingAttemptCount: 0 }
    ],
    attempted: []
  }, "boss.world");
  assert.match(t, /协作讨伐 1 个世界首领,共 3 次/);
  assert.match(t, /猩红公爵:协作 3\/3 次/);   // 次数取服务端自报的,含手动打的那几次
  assert.match(t, /累计伤害 1,542,152/);      // 三次相加,不是只取最后一次
  assert.match(t, /伤害占比 2\.26%/);
  assert.match(t, /首领剩余血量 95\.29%/);
  assert.doesNotMatch(t, /scarlet_duke/);      // 有中文名就不露键
  assert.doesNotMatch(t, /协作讨伐世界首领 3 次/); // 旧抬头:首领数与次数混为一谈
});

// R16:服务端拦地图首领时给的原话是「今日挑战次数已用尽。」,但实测地图首领
// 不受每日次数限制、只受刷新时间限制。原话照登不改写,后面附服务端自报的刷新规则。
check("跳过原因保留服务端原话,并附上刷新规则", () => {
  const t = text({
    attempted: [],
    skipped: [
      {
        bossKey: "nightmare_treant",
        name: "梦魇古树",
        difficulty: "normal",
        reason: "今日挑战次数已用尽。",
        refreshText: "地图首领每 2 小时刷新"
      }
    ]
  }, "boss.map");
  assert.match(t, /梦魇古树 —— 今日挑战次数已用尽。\(地图首领每 2 小时刷新\)/);
});

check("未知结构也不吐 JSON", () => {
  const t = text({ 未知字段: { 深层: [1, 2, { a: "b" }] }, name: "测试" }, "collect");
  assert.doesNotMatch(t, /[{}[\]]/);
});

check("所有样本渲染结果里没有 JSON 括号", () => {
  for (const [k, v] of Object.entries(SAMPLES)) {
    const t = text(v, k);
    assert.doesNotMatch(t, /[{}]/, `${k} 渲染结果含 JSON 花括号`);
    assert.doesNotMatch(t, /^\s*\[/m, `${k} 渲染结果含 JSON 方括号`);
  }
});

check("renderInto 把原始数据放进折叠区", () => {
  const host = doc.createElement("div");
  PGLog.renderInto(host, SAMPLES["boss.map"], "boss.map");
  const kinds = host.children.map((c) => c.tagName);
  assert.deepEqual(kinds, ["DIV", "DETAILS"]);
  assert.equal(host.children[1].children[0].textContent, "原始数据");
  assert.match(host.children[1].children[1].textContent, /"bossKey"/);
});

check("一行摘要取战果而不是配置回显", () => {
  // 列表里要看的是打赢没、分解了几件。跟着战果一起出的难度是这一场实际用的那档
  // (记在结果行上),不是开头那行配置回显 —— 后者只在压根没战果时才兜底。
  assert.match(PGLog.oneLine(SAMPLES["boss.map"], "boss.map"), /挑战 梦魇古树\(噩梦\):胜利/);
  assert.match(PGLog.oneLine(SAMPLES.inventory, "inventory"), /已分解装备 3 件/);
  // 三类首领三个动作三个名字:合成一个名字会让列表里分不出这条打的是哪类,
  // 而个人首领次数有限,认错类型代价最大
  assert.equal(PGLog.label("boss.personal"), "个人首领");
  assert.equal(PGLog.label("boss.map"), "地图首领");
  assert.equal(PGLog.label("boss.world"), "世界首领");
});

check("步骤名译成中文,不露 camelCase 键", () => {
  assert.match(text(SAMPLES.guild, "guild"), /公会分红:今日完成捐献后/);
  assert.match(text(SAMPLES.activity, "activity"), /每日签到:今日签到奖励已领取/);
  assert.doesNotMatch(text(SAMPLES.guild, "guild"), /claimDividend/);
  assert.doesNotMatch(text(SAMPLES.activity, "activity"), /signIn/);
});

check("dailyRun 逐段套用对应渲染器", () => {
  const t = text({ ran: { collect: SAMPLES.collect, "boss.map": SAMPLES["boss.map"] }, skipped: ["guild"], errors: [] }, "dailyRun");
  assert.match(t, /【收挂机收益】/);
  assert.match(t, /【地图首领】/);
  assert.match(t, /跳过:公会日常/);
});

check("渲染器抛错时说明白,不吞结果", () => {
  const broken = { get mode() { throw new Error("炸了"); } };
  const t = text(broken, "inventory");
  assert.match(t, /日志渲染出错:炸了/);
});

console.log(`\n日志渲染:${pass} 项全部通过`);

}

// 日志渲染器测试。log.js 是浏览器脚本,这里用最小 DOM 替身把它跑起来,
// 断言"页面上不出现 JSON"以及关键行的措辞。
// 用真号落库记录的等价样本喂进去 —— 字段名与取值全部来自 job_runs 实测。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

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
  const src = readFileSync(join(ROOT, "src/web/log.js"), "utf8");
  const sandbox = { window: {}, document: fakeDoc() };
  // log.js 是普通脚本(非模块),用 Function 注入 window/document 即可
  new Function("window", "document", src)(sandbox.window, sandbox.document);
  return { PGLog: sandbox.window.PGLog, doc: sandbox.document };
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
  "boss.map": {
    difficulty: "nightmare",
    gate: { minWinChance: 80, requirePredictedWin: true, useTickets: true },
    freeAttemptsLeft: null,
    attempted: [{
      bossKey: "nightmare_treant", name: "梦魇古树", dryRun: false, win: true,
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
      { bossKey: "eclipse_king", name: "日蚀君王", reason: "预测会输", forecast: { chance: 12, predictedWin: false } },
      { bossKey: "frostfire_king", name: "霜火君王", reason: "预测会输", forecast: { chance: 4, predictedWin: false } }
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
  assert.match(t, /将分解 精良短剑\(blue · 60 级 · 评分 1,200\)/);
  assert.match(t, /传说龙纹刃.*极品词条/);
  assert.doesNotMatch(t, /极品 极品品/);
});

check("profession 用响应里的中文动作名,不用 key", () => {
  const t = text(SAMPLES.profession, "profession");
  assert.match(t, /采集星根 x4/);
  assert.doesNotMatch(t, /gather_starroot/);
  assert.match(t, /行旅鱼饭 x24/);
});

check("boss 用游戏自己的 summary,不碰收件箱 notices", () => {
  const t = text(SAMPLES["boss.map"], "boss.map");
  assert.match(t, /挑战 梦魇古树:胜利/);
  assert.match(t, /获得 经验 5760、传说毒牙刃 x1/);
  assert.match(t, /39 回合/);
  assert.match(t, /门票 2\(剩 4,256\)/);
  assert.match(t, /极品掉落 传说龙纹刃/);
  assert.match(t, /日蚀君王 —— 预测会输\(预测胜率 12%\)/);
  assert.match(t, /首领奖励在挑战胜利时即时发放。/);
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
  // 列表里要看的是打赢没、分解了几件,不是用了什么难度
  assert.match(PGLog.oneLine(SAMPLES["boss.map"], "boss.map"), /挑战 梦魇古树:胜利/);
  assert.match(PGLog.oneLine(SAMPLES.inventory, "inventory"), /已分解装备 3 件/);
  assert.equal(PGLog.label("boss.map"), "地图/个人首领");
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
  assert.match(t, /【地图\/个人首领】/);
  assert.match(t, /跳过:公会日常/);
});

check("渲染器抛错时说明白,不吞结果", () => {
  const broken = { get mode() { throw new Error("炸了"); } };
  const t = text(broken, "inventory");
  assert.match(t, /日志渲染出错:炸了/);
});

console.log(`\n日志渲染:${pass} 项全部通过`);

}

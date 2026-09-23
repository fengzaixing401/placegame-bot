import { rulesFor } from "./config.mjs";
import * as collectFeature from "./features/collect.mjs";
import * as inventory from "./features/inventory.mjs";
import * as profession from "./features/profession.mjs";
import * as guild from "./features/guild.mjs";
import * as boss from "./features/boss.mjs";
import * as activity from "./features/activity.mjs";

// 动作表:键名同时用于排程任务与 REST 端点,两边行为一致。
// 每个动作签名 (client, accountRow, args) —— 账号级 rules 覆盖全局默认。
//
// 本模块只做两件事:把 args 与账号 rules 合成一次调用参数、把结果原样回传。
// 具体玩法(怎么筛、什么闸门、发什么字段)都在 features/* 里,别往这里堆业务判断。
export function buildActions(config, { redeemTotals = null } = {}) {
  const rules = (row) => rulesFor(config, row?.rules_json ? JSON.parse(row.rules_json) : null);

  // WebUI 的操作面板执行时把当前表单值作为本次覆盖发进来,不落库。
  // 整块替换而非深合并:否则页面上取消勾选某项永远生效不了。
  const withOverride = (base, override) =>
    override && typeof override === "object" && !Array.isArray(override) ? { ...base, ...override } : base;

  const actions = {
    async collect(api, row, args = {}) {
      return collectFeature.collect(api, { adventureOptionKey: args?.adventureOptionKey });
    },

    async changeMap(api, _row, args = {}) {
      return collectFeature.changeMap(api, args?.mapKey);
    },

    async inventory(api, row, args = {}) {
      const r = rules(row).inventory;
      return inventory.decompose(api, {
        mode: args?.mode ?? r.mode,
        equipmentIds: args?.equipmentIds,
        // 整块替换而非逐字段合并:页面面板每次都发全套条件,
        // 逐字段兜底会让"清空某个条件"永远生效不了。
        conditions: args?.conditions ?? r.conditions ?? {},
        dryRun: args?.dryRun === true
      });
    },

    async profession(api, row, args = {}) {
      const r = rules(row).profession;
      return profession.settleAndEnqueue(api, {
        professionKey: args?.professionKey ?? r.professionKey,
        enqueue: args?.enqueue ?? r.enqueue
      });
    },

    async guild(api, row, args = {}) {
      const r = rules(row).guild;
      return guild.dailyRoutine(api, {
        donate: args?.donate ?? r.donate,
        equipmentDonate: args?.equipmentDonate ?? r.equipmentDonate ?? [],
        claimDividend: args?.claimDividend ?? r.claimDividend,
        claimProgressRewards: args?.claimProgressRewards ?? r.claimProgressRewards ?? true,
        claimProgressPoints: args?.claimProgressPoints ?? r.claimProgressPoints ?? []
      });
    },

    // 公会共享仓库兑换。**独立任务**,不跟 20 小时那一轮绑在一起 ——
    // 它要按秒级间隔反复查库存、按累计目标慢慢换,节奏完全不同。
    //
    // 规则里的数量是**累计目标**而不是每轮数量:目标 2000 就每轮看库存继续换,
    // 累计到 2000 才停。所以每轮都要问本地账本"已经换过多少"。
    "guild.redeem": async (api, row, args = {}) => {
      const r = rules(row).guild;
      return guild.redeemByStock(api, {
        entries: args?.redeem ?? r.redeem,
        totals: redeemTotals,
        accountId: row?.id,
        maxPerCall: args?.redeemMaxPerCall ?? r.redeemMaxPerCall
      });
    },

    // 三类首领三个动作,各自只碰自己那类 —— 页面上是三个面板,难度与名单都不共用。
    // types 写死成本类型:否则一个动作会顺带打掉另一类的次数。
    // 地图首领这一栏在游戏里是 12 个:接口 type=map 的 5 个,加上 type=world 的 7 个。
    // 那 7 个在两种玩法里各受一套规则约束 —— 在地图首领这边是"挑战"(带难度、胜率、门票,
    // blockedReason 判闸),在世界首领那边是"协作"(assistBlockedReason 判闸,没有难度)。
    // 实测这 7 个的 blockedReason 为空、attempts=1、difficulties 三档齐全且票价 0/1/2,
    // 与地图首领完全同构;早先只打 type=map 的 5 个,等于 12 个里 7 个从没挑战过。
    "boss.map": async (api, row, args = {}) => {
      const r = withOverride(rules(row).boss, args?.rules);
      return boss.runBosses(api, {
        types: [boss.BOSS_TYPE.MAP, boss.BOSS_TYPE.WORLD],
        rules: r,
        maxChallenges: args?.maxChallenges ?? r.mapMaxPerRun,
        dryRun: args?.dryRun === true
      });
    },

    // 个人首领:安全闸门是 personalBosses 必须点名,空名单一个都不打。
    // challengePersonal 只管"要不要自动排程",由 scheduler 判断,不在这里拦手动执行 ——
    // 用户点开这个面板按确定执行,意图已经很明确了。
    "boss.personal": async (api, row, args = {}) => {
      const r = withOverride(rules(row).boss, args?.rules);
      return boss.runBosses(api, {
        types: [boss.BOSS_TYPE.PERSONAL],
        rules: r,
        // 个人首领的上限就是用户设的每日次数,不跟地图首领共用一个键。
        // runBosses 里的 personalBudget 还会按池子余量与门票闸门再封一次顶。
        maxChallenges: args?.maxChallenges ?? r.personalMaxPerDay,
        dryRun: args?.dryRun === true
      });
    },

    // 世界首领只参与协作,没有难度也没有胜率闸门
    "boss.world": async (api, row, args = {}) => {
      const r = withOverride(rules(row).boss, args?.rules);
      return boss.runWorldBoss(api, { rules: r });
    },

    async activity(api, row, args = {}) {
      const r = rules(row).activity;
      return activity.claimAll(api, {
        quests: args?.quests ?? r.quests,
        achievements: args?.achievements ?? r.achievements,
        daily: args?.daily ?? r.daily,
        signIn: args?.signIn ?? r.signIn,
        mail: args?.mail ?? r.mail,
        codex: args?.codex ?? r.codex ?? false,
        // null = 交给 claimAll 自己按活跃点解档;显式传数组才按名单领(空数组 = 一档都不领)。
        dailyPoints: args?.dailyPoints ?? r.dailyPoints ?? null
      });
    },

    // 只读:给 WebUI 表单喂真实可选项,避免让用户手写 key。
    // 每个面板各自兜错(见各 feature 的 viewForOptions),单项失败不影响其余,
    // 表单能渲染多少算多少 —— 所以这里不 try/catch 整块。
    // 返回结构就是前端契约,显式逐字段列出,不用展开运算符 —— 免得面板内部的
    // error 之类的辅助字段悄悄漏进响应。
    async options(api, row) {
      const [bossPanel, guildPanel, equipmentPanel, professionPanel, activityPanel, idlePanel] = await Promise.all([
        boss.viewForOptions(api),
        guild.viewForOptions(api),
        inventory.viewForOptions(api),
        profession.viewForOptions(api),
        activity.viewForOptions(api),
        collectFeature.viewForOptions(api)
      ]);

      return {
        // 首领:平铺一份给"全部"视图,再按类型分三份给三个面板
        bosses: bossPanel.bosses,
        bossesByType: bossPanel.bossesByType,
        difficulties: bossPanel.difficulties,
        challengeOptions: bossPanel.challengeOptions,
        freeAttemptsLeft: bossPanel.freeAttemptsLeft,
        // 公会:兑换用仓库清单、捐献用背包清单 —— 两套不同的东西,接口收的字段也不同
        donatableItems: guildPanel.donatableItems,
        redeemableItems: guildPanel.redeemableItems,
        // 兑换进度(已兑换 / 目标)存在本地账本里,面板要显示"还差多少"。
        // 账本按账号隔离,所以这里必须拿到 row —— options 的调用方是传了的(见 http-server)。
        guild: {
          ...guildPanel.guild,
          redeemProgress: redeemTotals && row?.id ? redeemTotals.all(row.id) : {}
        },
        // 副职
        professions: professionPanel.professions,
        selectedProfession: professionPanel.selectedProfession,
        professionActions: professionPanel.professionActions,
        // 分解条件表单用:品质取值+件数、属性键全集、可分解件数
        equipment: equipmentPanel.summary,
        // 活跃宝箱:活跃点、七项任务进度、五档各自可领与否。面板据此显示「哪档能领、哪档还差多少」
        activity: activityPanel.status,
        // 挂机概览:面板显示已攒时长与预计收益,收之前先让人看见
        idle: idlePanel.idle,
        errors: [
          bossPanel.error,
          equipmentPanel.error,
          professionPanel.error,
          ...guildPanel.errors,
          activityPanel.error,
          idlePanel.error
        ].filter(Boolean)
      };
    },

    // 只读状态汇总,供 agent 查看账号当前情况
    async status(api) {
      const [idle, view] = await Promise.all([
        collectFeature.idleSummary(api).catch((err) => ({ error: err.message })),
        collectFeature.dynamicView(api).catch((err) => ({ error: err.message }))
      ]);
      return {
        idle,
        character: view?.character ?? view?.profile ?? null,
        maps: Array.isArray(view?.maps) ? view.maps.length : 0,
        bosses: Array.isArray(view?.bosses) ? view.bosses.length : 0
      };
    }
  };

  // 一键全部日常:逐项独立执行,单项失败不影响其余,便于 agent 一次调用完成所有事。
  actions.dailyRun = async (api, row, args = {}) => {
    const r = rules(row);
    const steps = [
      ["collect", r.collect?.enabled, () => actions.collect(api, row, args)],
      ["inventory", r.inventory?.enabled, () => actions.inventory(api, row, args)],
      ["profession", r.profession?.enabled, () => actions.profession(api, row, args)],
      ["guild", r.guild?.enabled, () => actions.guild(api, row, args)],
      ["boss.map", r.boss?.enabled, () => actions["boss.map"](api, row, args)],
      // 个人首领另有开关:次数有限,不能被"一键日常"顺带打光
      [
        "boss.personal",
        r.boss?.enabled && r.boss?.challengePersonal === true,
        () => actions["boss.personal"](api, row, args)
      ],
      ["activity", r.activity?.enabled, () => actions.activity(api, row, args)]
    ];
    const out = { ran: {}, skipped: [], errors: [] };
    for (const [name, enabled, fn] of steps) {
      if (!enabled) {
        out.skipped.push(name);
        continue;
      }
      try {
        out.ran[name] = await fn();
      } catch (err) {
        out.errors.push({ step: name, error: err.message });
      }
    }
    return out;
  };

  return actions;
}

import { rulesFor } from "./config.mjs";
import * as collectFeature from "./features/collect.mjs";
import * as inventory from "./features/inventory.mjs";
import * as profession from "./features/profession.mjs";
import * as guild from "./features/guild.mjs";
import * as boss from "./features/boss.mjs";
import * as activity from "./features/activity.mjs";

// 动作表:键名同时用于排程任务与 REST 端点,两边行为一致。
// 每个动作签名 (client, accountRow, args) —— 账号级 rules 覆盖全局默认。
export function buildActions(config) {
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
        redeem: args?.redeem ?? r.redeem,
        donate: args?.donate ?? r.donate,
        equipmentDonate: args?.equipmentDonate ?? r.equipmentDonate ?? [],
        claimDividend: args?.claimDividend ?? r.claimDividend,
        claimProgressPoints: args?.claimProgressPoints ?? r.claimProgressPoints ?? []
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
        maxChallenges: args?.maxChallenges ?? r.maxChallengesPerRun,
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
        maxChallenges: args?.maxChallenges ?? r.maxChallengesPerRun,
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
    // 单项失败不影响其余,表单能渲染多少算多少。
    async options(api) {
      const [snapshot, bag, equipment, profView, guildView, activityView, idleView] = await Promise.all([
        boss.bossSnapshot(api).catch((err) => ({ error: err.message, bosses: [] })),
        guild.donatableItems(api).catch((err) => ({ error: err.message })),
        // 品质与属性名都取自真实背包,不写死枚举 —— 见 inventory.equipmentSummary
        inventory.equipmentSummary(api).catch((err) => ({ error: err.message })),
        profession.view(api).catch((err) => ({ error: err.message })),
        // 兑换清单来自公会仓库,页面据此渲染下拉,不让用户手写商店 key
        guild.redeemableItems(api).catch((err) => ({ error: err.message })),
        // 活跃宝箱进度:阈值是客户端常量,进度靠 bootstrap.daily 现算
        activity.activityStatus(api).catch((err) => ({ error: err.message })),
        // 挂机概览:面板上要先让人看见「攒了多久、多少收益」再决定收不收
        collectFeature.idleSummary(api).catch((err) => ({ error: err.message }))
      ]);
      const bosses = snapshot.bosses ?? [];
      // 每个首领只送页面用得上的字段。整行直接透传会把 21 份战斗预测和参与者榜单
      // 一起塞进响应,页面一个也用不到。
      const bossView = (b) => {
        const view = {
          bossKey: b.key ?? b.bossKey ?? null,
          name: b.name ?? null,
          type: b.type ?? null,
          mapName: b.mapName ?? null,
          requiredLevel: typeof b.requiredLevel === "number" ? b.requiredLevel : null,
          // 服务端自报的刷新规则与当前可挑战次数。三类首领的限制根本不同 ——
          // 地图「每 2 小时刷新」(attempts 恒为 1,不受每日次数限制)、
          // 个人「共享每日 5 次免费,门票最多追加 5 次」、世界则是三个固定场次时段。
          // 面板照抄服务端原话,不本地推断,免得把三套限制讲成一套。
          refreshText: b.refreshText ?? null,
          attempts: typeof b.attempts === "number" ? b.attempts : null,
          // 各难度自带胜率与消耗,与游戏内难度选择界面同源
          difficulties: (b.difficultyOptions ?? []).map((o) => ({
            key: o.key,
            name: o.name ?? o.key,
            chance: typeof o.chance === "number" ? o.chance : null,
            predictedWin: typeof o.predictedWin === "boolean" ? o.predictedWin : null,
            ticketCost: typeof o.ticketCost === "number" ? o.ticketCost : null,
            goldCost: typeof o.goldCost === "number" ? o.goldCost : null,
            materialName: o.materialName ?? null,
            materialCost: typeof o.materialCost === "number" ? o.materialCost : null,
            ownedMaterial: typeof o.ownedMaterial === "number" ? o.ownedMaterial : null,
            rewardPreview: Array.isArray(o.rewardPreview) ? o.rewardPreview : [],
            blockedReason: (o.blockedReason ?? "").trim() || null
          })),
          blockedReason: boss.blockedReason(b)
        };
        if (b.type === "personal") view.attemptPool = boss.attemptPool(b);
        // 世界首领只协作:送协作闸门与本场次进度,不送难度相关的胜率判断
        if (b.type === "world") {
          view.assistBlockedReason = boss.assistBlockedReason(b);
          const inst = b.worldInstance;
          view.instance = inst
            ? {
                status: inst.status ?? null,
                hpPercent: typeof inst.hpPercent === "number" ? inst.hpPercent : null,
                participantCount: typeof inst.participantCount === "number" ? inst.participantCount : null,
                myAttemptCount: typeof inst.myAttemptCount === "number" ? inst.myAttemptCount : null,
                maxAttemptCount: typeof inst.maxAttemptCount === "number" ? inst.maxAttemptCount : null,
                remainingAttemptCount:
                  typeof inst.remainingAttemptCount === "number" ? inst.remainingAttemptCount : null,
                rewardStatus: inst.rewardStatus ?? null
              }
            : null;
        }
        return view;
      };

      // 按类型分组:页面上三类首领是三个面板,数量也不同(实测个人 9 / 地图 5 / 世界 7)。
      // 不硬编码数量 —— 等级与场次都会影响服务端返回哪些。
      const byType = { personal: [], map: [], world: [] };
      for (const b of bosses) {
        const list = byType[b.type];
        if (list) list.push(bossView(b));
      }

      return {
        bosses: bosses.map(bossView),
        bossesByType: byType,
        // 查不到就只有 "normal" 可信 —— 不猜难度枚举
        difficulties: boss.difficultyOptions(bosses),
        // 技能/战术/词缀/目标部位,服务端自带中文名
        challengeOptions: boss.challengeOptions(bosses),
        freeAttemptsLeft: boss.freeAttemptsLeft(bosses),
        donatableItems: Array.isArray(bag) ? bag : [],
        // 兑换用公会仓库清单;捐献用背包清单 —— 两套不同的东西,接口收的字段也不同
        redeemableItems: Array.isArray(guildView?.items) ? guildView.items : [],
        guild: {
          equipmentDonationMinQuality: guildView?.equipmentDonationMinQuality ?? null,
          canDonate: guildView?.canDonate !== false,
          donationBlockedReason: guildView?.donationBlockedReason ?? null
        },
        // 副职:优先用游戏返回的中文名(采药/垂钓/烹饪/炼金),读不到才回落到本地键名。
        // 本地 PROFESSIONS 只是校验白名单,直接拿它当下拉项会让页面显示英文键。
        professions: Array.isArray(profView?.professions) && profView.professions.length
          ? profView.professions
              .map((p) => ({
                key: p.key ?? null,
                name: p.name ?? p.key ?? null,
                level: typeof p.level === "number" ? p.level : null
              }))
              .filter((p) => p.key)
          : profession.PROFESSIONS.map((key) => ({ key, name: key, level: null })),
        selectedProfession: profView?.selectedProfessionKey ?? null,
        // 副职动作:18 个动作横跨 4 个副职,必须带 professionKey 才能在页面上分组 ——
        // 混成一个下拉会让人选到别的副职的动作,要等运行时才失败。
        professionActions: Array.isArray(profView?.actions)
          ? profView.actions
              .map((a) => ({
                key: a.key ?? a.actionKey ?? null,
                name: a.name ?? null,
                professionKey: a.professionKey ?? null,
                requiredLevel: typeof a.requiredLevel === "number" ? a.requiredLevel : null,
                unlocked: a.unlocked !== false,
                blockedReason: (a.blockedReason ?? "").trim() || null
              }))
              .filter((a) => a.key)
          : [],
        // 分解条件表单用:品质取值+件数、属性键全集、可分解件数
        equipment: equipment?.error ? { total: 0, disposable: 0, qualities: [], attrKeys: [], rareRanks: [] } : equipment,
        // 活跃宝箱:活跃点、七项任务进度、五档各自可领与否。面板据此显示「哪档能领、哪档还差多少」
        activity: activityView?.error ? null : activityView,
        // 挂机概览:面板显示已攒时长与预计收益,收之前先让人看见
        idle: idleView?.error ? null : idleView,
        errors: [
          snapshot.error,
          bag?.error,
          equipment?.error,
          profView?.error,
          guildView?.error,
          activityView?.error,
          idleView?.error
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

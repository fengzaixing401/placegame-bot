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

    // types 不在这里兜底:交给 runBosses 按 challengePersonal 决定,
    // 免得这里写死 PERSONAL 把"个人首领默认不打"的设置绕过去
    "boss.map": async (api, row, args = {}) => {
      const r = withOverride(rules(row).boss, args?.rules);
      return boss.runBosses(api, {
        types: args?.types,
        rules: r,
        maxChallenges: args?.maxChallenges ?? r.maxChallengesPerRun,
        dryRun: args?.dryRun === true
      });
    },

    "boss.world": async (api, row, args = {}) => {
      const r = withOverride(rules(row).boss, args?.rules);
      return boss.runWorldBoss(api, { rules: r, assistOnly: args?.assistOnly === true });
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
        dailyPoints: args?.dailyPoints ?? r.dailyPoints ?? []
      });
    },

    // 只读:给 WebUI 表单喂真实可选项,避免让用户手写 key。
    // 单项失败不影响其余,表单能渲染多少算多少。
    async options(api) {
      const [snapshot, bag, equipment, profView] = await Promise.all([
        boss.bossSnapshot(api).catch((err) => ({ error: err.message, bosses: [] })),
        guild.donatableItems(api).catch((err) => ({ error: err.message })),
        // 品质与属性名都取自真实背包,不写死枚举 —— 见 inventory.equipmentSummary
        inventory.equipmentSummary(api).catch((err) => ({ error: err.message })),
        profession.view(api).catch((err) => ({ error: err.message }))
      ]);
      const bosses = snapshot.bosses ?? [];
      return {
        bosses: bosses.map((b) => ({
          bossKey: b.key ?? b.bossKey ?? null,
          name: b.name ?? null,
          type: b.type ?? null,
          available: b.available !== false,
          blockedReason: boss.blockedReason(b),
          remainingAttemptCount: b.remainingAttemptCount ?? null
        })),
        // 查不到就只有 "normal" 可信 —— 不猜难度枚举
        difficulties: boss.difficultyOptions(bosses),
        personalAttempts: snapshot.personalAttempts ?? null,
        freeAttemptsLeft: boss.freeAttemptsLeft(snapshot.personalAttempts),
        donatableItems: Array.isArray(bag) ? bag : [],
        professions: profession.PROFESSIONS,
        // 副职动作:排队表单用,取游戏返回的 key+中文名,避免让用户手写 key
        professionActions: Array.isArray(profView?.actions)
          ? profView.actions.map((a) => ({ key: a.key ?? a.actionKey ?? null, name: a.name ?? null })).filter((a) => a.key)
          : [],
        // 分解条件表单用:品质取值+件数、属性键全集、可分解件数
        equipment: equipment?.error ? { total: 0, disposable: 0, qualities: [], attrKeys: [], rareRanks: [] } : equipment,
        errors: [snapshot.error, bag?.error, equipment?.error, profView?.error].filter(Boolean)
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

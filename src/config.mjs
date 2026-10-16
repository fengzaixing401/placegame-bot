import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 服务级配置。账号不在此定义 —— 账号存 SQLite,通过 REST 管理(见 accounts/store.mjs)。
// 这里的 defaultRules 是全局默认策略,每个账号可用 rules_json 覆盖。
const DEFAULTS = {
  baseUrl: "https://api.placegame.cn",
  port: 8080,
  host: "0.0.0.0",
  dataDir: join(ROOT, "data"),
  dbPath: "",
  rulesFile: "",
  timezone: "Asia/Shanghai",
  requestTimeoutMs: 15000,
  schedulerEnabled: true,
  // 每个账号的默认策略,账号级 rules 会深合并覆盖
  defaultRules: {
    collect: {
      enabled: true,
      intervalHours: 11 // 挂机收益上限 12h,留 1h 余量
    },
    inventory: {
      enabled: true,
      mode: "explicit", // auto = 用服务端 auto-decompose 规则;explicit = 按下面 conditions 挑选
      intervalHours: 11,
      // explicit 模式的分解条件。
      //
      // 2026-10-16 起默认值按用户要求固化:**成色评分低于 86 的全拆**。
      // 86 这个数不是拍的 —— 服务端 rareScore 实测:极品 53~69 / 大极品 70~93 /
      // 神装 86.06~94.81,神装档的下沿正好压在 86。所以这条等价于"只留神装"。
      //
      // 注意 maxRareScore 读的是 rareScore(**成色**评分,判极品/大极品/神装),
      // 不是 score(**战力**评分,实测 223~85881)。两者差了三个数量级,
      // 写错就会得到"没有一件装备符合条件"。
      conditions: {
        maxRareScore: 86, // 成色评分低于此值才拆(null = 不看成色)
        maxScore: null, // 战力评分低于此值才拆(null = 不看战力)
        maxLevel: null, // 装备等级不高于此值才拆(null = 不看等级)
        qualities: [], // 可分解品质白名单,空 = 不按品质筛
        // 必须显式 false:成色档位(极品/大极品/神装)几乎人人都有,
        // 开着 true 会把上面的成色条件整个架空(全被"保留极品词条"拦下)。
        keepRareRank: false,
        keepAttrs: [] // 命中这些属性名就保留
      }
    },
    profession: {
      enabled: true,
      professionKey: "",
      enqueue: {}, // actionKey -> count
      intervalHours: 6
    },
    guild: {
      enabled: true,
      // 公会共享仓库兑换。**数量是「累计目标」,不是每轮数量** ——
      // 目标 2000 就每轮看库存继续换,累计到 2000 才停(每轮不会重复换 2000)。
      // 已换过多少存在本地账本里(db 的 guild_redeem_totals),因为兑换日志只留最近 120 条。
      redeem: [], // [{itemKey, total}]
      // 兑换单独排程,间隔以秒为单位(但排程 tick 是 60 秒,实际最小粒度就是 60 秒)。
      // 共享仓库先到先得,跑得越勤越容易抢到;默认 5 分钟。
      redeemIntervalSeconds: 300,
      // 游戏单次兑换上限。超过会被服务端拒,所以要拆成多次调用。
      redeemMaxPerCall: 999,
      // [{itemKey, amount}] —— 捐献接口收的是背包实例 itemId(会变),
      // 所以规则里存稳定的 itemKey,运行时再查背包换成 itemId
      donate: [],
      claimDividend: true,
      // 贡献奖励(游戏里叫「进度奖励」)。**默认按服务端的 canClaim 领,不用点名档位** ——
      // 档位随贡献点解锁,写死一串序号迟早追不上。实测四档:30/60/90/120 点。
      claimProgressRewards: true,
      intervalHours: 20
    },
    boss: {
      enabled: true,
      // 地图首领。难度与个人首领各存一份:页面上是两个面板,共用一个字段会互相覆盖
      difficulty: "normal",
      // 留空 = 打列表里所有可挑战的
      mapBosses: [],
      mapIntervalHours: 2, // 地图首领刷新周期
      // 个人首领。默认不排程,否则会把野猪王之类的每日次数打光
      challengePersonal: false,
      personalDifficulty: "normal",
      // 留空 = 一个都不打(与地图首领相反)。这是个人首领的安全闸门
      personalBosses: [],
      // 每天几点打。免费次数按北京时间每日重置,所以按时刻排比按间隔排更贴合
      personalAt: "09:00",
      // 一天打几次。这是整轮预算,不是每个首领各算 —— 服务端的
      // personalAttemptPool 是共享一池(免费 5 + 门票 5)。
      // 默认 5 = 只用完免费次数,不碰门票;要动门票就填到 5 以上
      personalMaxPerDay: 5,
      // 世界首领:只参与协作讨伐,没有难度也没有胜率预测。留空 = 全部参与
      worldBosses: [],
      worldWindows: [
        // 北京时间。**以游戏自报的 refreshText 为准** —— 首领行上那句
        // 「每天 10:00–11:00 / 14:00–15:00 / 20:00–21:00」就是权威值。
        // 这里曾经写的是 16:00–17:00,而游戏是 14:00–15:00:于是 16:00 那一轮
        // 拿到的还是 14:00 那场(15:00 已结束),整轮 7 个首领全报
        // 「世界首领场次已变化、门票不足或攻击失败。」—— 白白跑一轮还漏掉了 14:00 窗口。
        // 游戏改时间时,先 GET /accounts/:id/options 看 refreshText,再同步这里。
        { start: "10:00", end: "11:00" },
        { start: "14:00", end: "15:00" },
        { start: "20:00", end: "21:00" }
      ],
      // 窗口开始后等几分钟才起跑(每个窗口都适用)。
      //
      // 为什么要等:窗口最开始那几分钟最挤 —— 10:00 是游戏**日重置**时刻,全服玩家
      // 同时上线,再加上同一 tick 里 collect/inventory/boss.map 排队串行,
      // 实测 10-15 的 10:00 场拖到 10:00:59 才起跑,一进去正撞服务端最堵的时候
      // (那天 10:00 场只协作 10 个、错 7 个;而 14:00 场稳定 21/0)。
      // 等 2 分钟能明显避开开场洪峰,代价是每轮少 2 分钟预算 —— 对一小时窗口可以忽略。
      worldStartDelayMinutes: 2,
      // 门票有两条扣除路径:难度档自带 ticketCost(地图困难 1 张/噩梦 2 张),
      // 以及个人首领免费次数用尽后服务端自动扣票。为假时两条都拦。
      useTickets: false,
      // 胜率闸门,只作用于个人/地图首领。先看难度档自带的胜率,过了再 preview 确认
      minWinChance: 80,
      requirePredictedWin: true,
      selectedSkillKeys: [],
      buffKey: "",
      affixKey: "",
      useMaterialBoost: false,
      // 地图首领每轮最多挑战几个。防跑飞的刹车,不是玩法上限 ——
      // 真正的限制由服务端 blockedReason 决定。**这个数要跟得上游戏加首领**:
      // 2026-09-22 实测这一栏已是 26 个(type=map 12 + type=world 14),
      // 而默认值还停在 14,等于每轮静默漏掉 2 个能打的首领 ——
      // 实测当天 12 轮全是「打 14 跳 2」,新加的深渊熔炉领主/熔界终焉一次都没轮到。
      // 填小于实际能打的数量就会截掉后面几个。
      //
      // 2026-10-16 又核对一次:候选仍是 26,而值也是 26 —— **零余量**。
      // 每轮「尝试18 跳8」正好 26,天天顶格,只是那 8 个转生门槛的天然被跳过才没触发截断。
      // 游戏再加一个首领(它一直在加:个人首领已到 16 个)就会开始丢。
      // 所以抬到 40 留出余量:多出来的额度不会白费(没有候选时自然空转),
      // 却能让"游戏加首领"这件事不再需要我们改配置。
      //
      // 与个人首领的 personalMaxPerDay 是两个独立的键:三类首领玩法不同、
      // 数量不同,共用一个上限会让一边的设置卡住另一边(早先就是共用的,
      // 在个人首领面板填 10 会把地图首领也卡在 10)。
      mapMaxPerRun: 40
    },
    activity: {
      enabled: true,
      quests: true,
      achievements: true,
      daily: true,
      signIn: true,
      mail: true,
      // 邮件是分批领的:服务端一批 25 封,返回 remainingCount + batchStatus=partial,
      // 需要反复调直到领完。这里给单轮的批数上限(20 批 = 500 封),
      // 一是应付长期不领的号,二是防服务端异常永远回 partial 时死循环。
      mailMaxBatches: 20,
      dailyAt: "09:10" // 每天领取时刻(账号时区 = 服务时区)
    }
  }
};

function envStr(key, fallback = "") {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : String(v);
}

function envNum(key, fallback) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

function envBool(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

export async function loadConfig(overrides = {}) {
  const cfg = structuredClone(DEFAULTS);

  cfg.baseUrl = envStr("PLACEGAME_BASE_URL", cfg.baseUrl);
  cfg.port = envNum("PLACEGAME_PORT", cfg.port);
  cfg.host = envStr("PLACEGAME_HOST", cfg.host);
  cfg.dataDir = envStr("PLACEGAME_DATA_DIR", cfg.dataDir);
  cfg.rulesFile = envStr("PLACEGAME_RULES_FILE", cfg.rulesFile);
  cfg.timezone = envStr("PLACEGAME_TZ", cfg.timezone);
  cfg.requestTimeoutMs = envNum("PLACEGAME_REQUEST_TIMEOUT_MS", cfg.requestTimeoutMs);
  cfg.schedulerEnabled = envBool("PLACEGAME_SCHEDULER", cfg.schedulerEnabled);
  cfg.dbPath = envStr("PLACEGAME_DB_PATH", "") || join(cfg.dataDir, "accounts.db");

  // 主密钥只从 env 读,绝不落配置文件也绝不可改
  cfg.masterKeyB64 = envStr("PLACEGAME_MASTER_KEY_B64", "");
  // API 令牌是引导值:库里存了轮换后的值就以库为准(见 settings.mjs)
  cfg.apiToken = envStr("PLACEGAME_API_TOKEN", "");
  // 会话 cookie 的 Secure 属性。默认开(生产走 HTTPS 反代);本机 HTTP 调试需置 false 才能登录
  cfg.webSecureCookie = envBool("PLACEGAME_WEB_SECURE_COOKIE", true);
  cfg.webSessionHours = envNum("PLACEGAME_WEB_SESSION_HOURS", 12);

  if (cfg.rulesFile) {
    const rules = JSON.parse(await readFile(cfg.rulesFile, "utf8"));
    deepMerge(cfg, rules);
  }
  deepMerge(cfg, overrides);

  if (!cfg.masterKeyB64) {
    throw new Error(
      "缺少 PLACEGAME_MASTER_KEY_B64(32 字节 base64url 主密钥)。生成:node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\""
    );
  }
  // apiToken 不在此校验:库里可能存着轮换后的令牌,此时 env 允许为空。
  // 两处都没有才是致命的,那个检查在 index.mjs 开库之后做。
  return cfg;
}

// 深合并:用于 rules 文件/账号级 rules 覆盖默认策略。数组整体替换,不逐项合并。
export function deepMerge(target, source) {
  if (source === undefined) return target;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return source;
  const base = target && typeof target === "object" && !Array.isArray(target) ? target : {};
  for (const key of Object.keys(source)) {
    base[key] = deepMerge(base[key], source[key]);
  }
  return base;
}

// 账号级 rules 覆盖全局默认
export function rulesFor(cfg, accountRules) {
  const merged = structuredClone(cfg.defaultRules);
  return accountRules ? deepMerge(merged, accountRules) : merged;
}

export { ROOT, DEFAULTS };

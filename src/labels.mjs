// 游戏内枚举 → 中文名。全项目唯一手写来源:后端直接 import,前端经 /labels.js 取 window.PGLabels。
//
// 为什么需要这份表:服务端从不返回品质中文名。真号抓包里 4200+ 处 quality 全是英文色名,
// 中文名只存在于游戏客户端。凡是服务端自带中文名的字段(mapName / itemName / 副职动作 name /
// difficultyOptions[].name / rareRank 等)一律直接用服务端的值,不进这张表。

// 品质。取自真号 2024 件装备的「名字前缀 × quality」交叉验证,零例外:
//   普通×white 67 件 / 优秀×green 21 / 精良×blue 16 / 稀有×purple 12 / 传说×red 27 / 神话×gold 1881
// orange 一档在装备里没有样本(只见于技能书与遗迹碎片,名字不带品质前缀),
// 按两条独立证据定为「史诗」:① CLI 的档位顺序里它在 purple 与 red 之间;
// ② 用户列举的游戏内品质词是「传说史诗神话」,史诗是上述实测六档里唯一缺的那个。
//
// 注意:官方 CLI 0.2.50 自带的 QUALITY_LABELS 已整档错位(没有 gold,把 blue 标成"稀有"),
// 服务端后来插入 gold 档使中文名整体下移一位。不要拿 CLI 那份当权威。
export const QUALITY = {
  white: "普通",
  green: "优秀",
  blue: "精良",
  purple: "稀有",
  orange: "史诗",
  red: "传说",
  gold: "神话"
};

// 品质从低到高。用于把复选框按游戏内顺序排列,而不是按背包件数排。
export const QUALITY_ORDER = ["white", "green", "blue", "purple", "orange", "red", "gold"];

// 装备部位。取自真号 challengeOptions.targetSlots 与背包实测计数;
// CLI 那份多一个实测零命中的 shoulder、缺了 medal(实测 190 件)。
export const SLOT = {
  weapon: "武器",
  armor: "衣服",
  helmet: "头盔",
  necklace: "项链",
  ring: "戒指",
  belt: "腰带",
  boots: "鞋子",
  bracelet: "手镯",
  talisman: "护符",
  medal: "勋章"
};

// 首领类型(dynamic-view 的 bosses[].type)
export const BOSS_TYPE = { personal: "个人首领", map: "地图首领", world: "世界首领" };

// 挑战难度。取值与中文名都来自真号 difficultyOptions(三档,零例外)。
// 例外地进这张表:表单里能直接用服务端给的 name,但任务结果只记了 key
// (见 boss.mjs 的 label 对象),日志渲染时手边没有那份 name。
export const DIFFICULTY = { normal: "普通", hard: "困难", nightmare: "噩梦" };

// 世界首领场次状态。真号实测只出现过 defeated 与 ended;
// 另外三个取自官方 CLI,留着做前瞻兜底 —— label() 遇到表外取值会回落原值。
export const WORLD_INSTANCE_STATUS = {
  pending: "未开放",
  active: "进行中",
  defeated: "已击败",
  ended: "已结束",
  closed: "已关闭"
};

// 装备所在位置(/api/equipment/list 的 status,取值实测只有这三个)
export const EQUIP_STATUS = { in_bag: "背包", equipped: "已穿戴", on_market: "出售中" };

export const JOB = { warrior: "战士", mage: "法师", summoner: "召唤师" };

// 未知取值一律回落显示原值。服务端加档位比客户端更新快 —— gold 就是这么漏掉的,
// 静默丢弃会让页面上凭空少一个复选框,用户根本不知道自己漏筛了什么。
export function label(table, value, fallback) {
  if (value === null || value === undefined || value === "") return fallback ?? "";
  return table?.[value] ?? String(value);
}

export const quality = (v) => label(QUALITY, v);
export const slot = (v) => label(SLOT, v);
export const bossType = (v) => label(BOSS_TYPE, v);
export const difficulty = (v) => label(DIFFICULTY, v);

// 品质按游戏内档位排序,表里没有的(服务端新增)排在最后并保留原值。
export function sortQualities(list, keyOf = (x) => x) {
  return [...list].sort((a, b) => {
    const ia = QUALITY_ORDER.indexOf(keyOf(a));
    const ib = QUALITY_ORDER.indexOf(keyOf(b));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

// 送给前端的整份表。前端只读,故直接序列化;新增表记得加进来。
export function browserBundle() {
  return { QUALITY, QUALITY_ORDER, SLOT, BOSS_TYPE, DIFFICULTY, WORLD_INSTANCE_STATUS, EQUIP_STATUS, JOB };
}

// /labels.js 的全文。表随 browserBundle 序列化过去,取值函数在这里用文本写一遍 ——
// 前端那两个文件是传统脚本,拿不到 ESM 导出。
// 只有查表逻辑重复(各一行),真正怕漂移的中文名表仍然只有上面那一份。
export function browserScript() {
  return `window.PGLabels=${JSON.stringify(browserBundle())};
window.PGL={
  tables: window.PGLabels,
  label(table, value, fallback) {
    if (value === null || value === undefined || value === "") return fallback ?? "";
    return table?.[value] ?? String(value);
  },
  quality(v) { return this.label(window.PGLabels.QUALITY, v); },
  slot(v) { return this.label(window.PGLabels.SLOT, v); },
  bossType(v) { return this.label(window.PGLabels.BOSS_TYPE, v); },
  difficulty(v) { return this.label(window.PGLabels.DIFFICULTY, v); },
  worldStatus(v) { return this.label(window.PGLabels.WORLD_INSTANCE_STATUS, v); },
  equipStatus(v) { return this.label(window.PGLabels.EQUIP_STATUS, v); },
  job(v) { return this.label(window.PGLabels.JOB, v); },
  sortQualities(list, keyOf) {
    const key = keyOf ?? ((x) => x);
    const order = window.PGLabels.QUALITY_ORDER;
    return [...list].sort((a, b) => {
      const ia = order.indexOf(key(a));
      const ib = order.indexOf(key(b));
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }
};
`;
}

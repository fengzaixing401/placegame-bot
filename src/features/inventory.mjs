import { pickList, pickKey, num, text } from "../util.mjs";

// 装备状态枚举。取值来自真号 /api/equipment/list 实测,不是 CLI 的标签表 ——
// CLI 那份写的是 listed/in_warehouse,真实服务端给的是 on_market,且没有仓库态。
// 2026-10-16 实测又有 in_storage(仓库态),同样不在 CLI 表里。
export const STATUS = { IN_BAG: "in_bag", EQUIPPED: "equipped", ON_MARKET: "on_market", IN_STORAGE: "in_storage" };

// 硬保护:与用户在面板上怎么配、规则里存了什么一概无关,任何分解路径都必须先过这一关。
// 不分解当前穿戴的装备 —— 拆掉身上的东西不可逆,这是唯一一条真正不能碰的红线。
//
// 【2026-10-16 变更】等级硬上限(原 HARD_MAX_LEVEL = 160)已按要求**整条移除**。
// 原因:该账号全部装备都是 level 200,硬上限会把 231 件全拦下,评分条件形同虚设。
// 移除后等级只由 conditions.maxLevel 控制(用户自己填),不再有不可放宽的天花板。
// auto 模式原先靠这条上限做前置安全检查,一并去掉 —— 见下方 auto 分支的说明。
export const EMPTY_SUMMARY = {
  total: 0,
  disposable: 0,
  qualities: [],
  attrKeys: [],
  rareRanks: []
};

// 命中硬保护返回原因字符串,没命中返回 null。
//
// 穿戴判定要同时看两个字段:status === "equipped" 是服务端的主口径,
// item.equipped 是布尔口径。官方 CLI 的 equipmentStatus() 正是
// `item.status === "equipped" || item.equipped` —— 只认一个,两者不一致时就漏判,
// 而漏判的代价是拆掉身上正穿着的装备,不可逆。
export function hardProtection(row) {
  if (!row) return "行数据缺失";
  if (row.status === STATUS.EQUIPPED || row.equipped === true) return "当前穿戴中";
  if (row.locked === true) return "已上锁";
  return null;
}

// 可分解 = 在背包中、未上锁、且未命中硬保护。已穿戴/已上架的靠 status 白名单排除。
export function isDisposable(row) {
  if (!row) return false;
  if (hardProtection(row)) return false;
  return row.status === STATUS.IN_BAG;
}

// 词条名在 baseAttrs 与 extraAttrs 两个对象里(键为属性名,不是数组)。
export function attrKeys(row) {
  return [...Object.keys(row?.baseAttrs ?? {}), ...Object.keys(row?.extraAttrs ?? {})];
}

// 成色评分字段名。服务端还返回一个 score —— 那是**战力评分**(实测 223~85881),
// 与"成色"(极品/大极品/神装)完全无关。判成色必须用 rareScore(实测 53~95),
// 阈值 86 正好是神装档的下沿(实测神装最低 86.06)。早期版本把 maxScore 读成
// row.score 是错的,会把"成色低于 86"判成"战力低于 86",永远匹配不到任何装备。
export const RARE_SCORE_FIELD = "rareScore";
export const COMBAT_SCORE_FIELD = "score";

// 分解条件判定。返回 {ok:true} 表示该拆,{ok:false,reason} 表示留着。
// 读不到评分/等级的装备在设了对应条件时按"留着"处理 ——
// 条件判不了就不能拆,宁可漏拆不能误拆。
export function matchesDecomposeRules(row, cond = {}) {
  // 硬保护先行:用户条件只能在其之上继续收紧,永远不能把它放宽
  const hard = hardProtection(row);
  if (hard) return { ok: false, reason: hard };

  if (row?.status === STATUS.ON_MARKET) return { ok: false, reason: "已上架" };
  if (row?.status !== STATUS.IN_BAG) return { ok: false, reason: `不在背包(status=${row?.status ?? "未知"})` };

  // 默认关掉:成色档位(极品/大极品/神装)几乎人人都有,开着会把全部装备都保护下来,
  // 评分条件就再也筛不动任何东西。只有显式写 true 才开。
  if (cond.keepRareRank === true && row.rareRank) {
    return { ok: false, reason: `极品词条 ${row.rareRank}` };
  }

  const quals = [].concat(cond.qualities ?? []);
  if (quals.length > 0 && !quals.includes(row.quality)) {
    return { ok: false, reason: `品质 ${row.quality} 不在可分解名单` };
  }

  // 成色评分条件:只拆成色评分**低于** maxRareScore 的。
  if (typeof cond.maxRareScore === "number") {
    const rs = num(row[RARE_SCORE_FIELD]);
    if (rs === null) return { ok: false, reason: "读不到成色评分,未按成色条件处理" };
    if (rs >= cond.maxRareScore) {
      return { ok: false, reason: `成色评分 ${rs} 不低于 ${cond.maxRareScore}` };
    }
  }

  // 战力评分条件(独立于成色)。只拆战力评分**低于** maxScore 的。
  if (typeof cond.maxScore === "number") {
    const score = num(row[COMBAT_SCORE_FIELD]);
    if (score === null) return { ok: false, reason: "读不到战力评分,未按评分条件处理" };
    if (score >= cond.maxScore) return { ok: false, reason: `战力评分 ${score} 不低于 ${cond.maxScore}` };
  }

  if (typeof cond.maxLevel === "number") {
    const level = num(row.level);
    if (level === null) return { ok: false, reason: "读不到等级,未按等级条件处理" };
    if (level > cond.maxLevel) return { ok: false, reason: `等级 ${level} 高于 ${cond.maxLevel}` };
  }

  const keep = [].concat(cond.keepAttrs ?? []);
  if (keep.length > 0) {
    const hit = attrKeys(row).find((k) => keep.includes(k));
    if (hit) return { ok: false, reason: `命中保留属性 ${hit}` };
  }

  return { ok: true };
}

// 至少要有一个"正向收紧"的条件。全空时 explicit 模式会把背包里所有未锁未穿的装备
// 一次拆光 —— 那是灾难而不是功能,所以在发请求前就拦下。
// keepRareRank 不算:它只保护极品,不限制其余任何一件。
// 【2026-10-16】去掉了等级硬上限后,maxLevel 成了唯一能拦住"200 级装备"的条件,
// 但它仍然只是"可选条件"之一 —— 有它就算收紧,没它也不算违规。
export function hasNarrowingCondition(cond = {}) {
  if (typeof cond.maxRareScore === "number") return true;
  if (typeof cond.maxScore === "number") return true;
  if (typeof cond.maxLevel === "number") return true;
  return [].concat(cond.qualities ?? []).length > 0;
}

// 逐件明细。落库要经 compactForStore 裁剪,所以每件只留能拼出人话日志的字段。
// score 是战力评分、rareScore 是成色评分 —— 两个都带上,日志里能一眼分辨是谁在起作用。
function digest(row, reason) {
  return {
    equipmentId: pickKey(row),
    name: row?.name ?? null,
    quality: row?.quality ?? null,
    level: row?.level ?? null,
    score: row?.score ?? null,
    rareScore: row?.[RARE_SCORE_FIELD] ?? null,
    rareRank: row?.rareRank ?? null,
    ...(reason ? { reason } : {})
  };
}

export async function listEquipment(api) {
  const data = await api.get("/api/equipment/list");
  return pickList(data, "equipment");
}

export async function listInventory(api) {
  const data = await api.get("/api/inventory/list");
  return { equipment: pickList(data?.equipment, "equipment"), items: pickList(data?.items, "items") };
}

// ② 背包一键分解。
// auto 模式走服务端自己的 auto-decompose 规则(条件在游戏里配,本程序无从预览);
// explicit 模式按 conditions 在本地筛,能逐件给出拆/留的原因。
// 三条路径都必须先过硬保护:穿戴中的装备、等级高于 160 的装备一律不拆。
export async function decompose(api, { mode = "auto", equipmentIds, conditions = {}, dryRun = false } = {}) {
  // 调用方点名了具体装备。这条路径不套 conditions,但绝不能因此绕过硬保护 ——
  // 它能从 REST 直接触达(POST /accounts/:label/inventory/decompose 带 equipmentIds),
  // 不校验就等于开了一个"把身上装备和高级装备交出去"的后门。
  // 所以先拉一次装备列表逐件核对,查无此 id 的也一并拒绝(宁可少拆)。
  if (Array.isArray(equipmentIds) && equipmentIds.length > 0) {
    const all = await listEquipment(api);
    const byId = new Map(all.map((row) => [pickKey(row), row]));
    const allowed = [];
    const refused = [];
    for (const id of equipmentIds) {
      const row = byId.get(id);
      if (!row) {
        refused.push({ equipmentId: id, reason: "不在装备列表(可能已消失或 id 有误)" });
        continue;
      }
      const hard = hardProtection(row);
      if (hard) {
        refused.push(digest(row, hard));
        continue;
      }
      allowed.push(id);
    }
    const out = {
      mode: "explicit",
      dryRun,
      scanned: equipmentIds.length,
      matched: allowed.length,
      refusedCount: refused.length,
      targets: allowed.map((id) => digest(byId.get(id))),
      refused
    };
    // 全被拦下时一个请求都不发 —— 不为"拆 0 件"去打一次写接口
    if (allowed.length === 0) return { ...out, equipmentIds: [], result: null };
    return { ...out, ...(await runDecompose(api, allowed, dryRun)) };
  }

  if (mode === "auto") {
    // 服务端只有 auto-decompose,没有它的预览端点。此处若退化成真分解,
    // 页面上的"预览"按钮就成了真拆装备 —— 必须显式拒绝而不是静默执行。
    if (dryRun) {
      throw new Error("auto 模式没有预览端点(游戏侧只提供直接执行)。要预览请切到 explicit 模式,或改用 auto 模式的「确定执行」。");
    }
    // 【2026-10-16】原先这里有一道前置检查:背包里只要有"等级读不到或高于 160"的装备就拒绝。
    // 那是为了在看不到游戏侧规则的前提下,兜住"不拆高级装备"这条约束。
    // 等级硬上限本身就移除后,这道检查失去依据(不再有"高级"这个不可放宽的定义),
    // 且实测该账号全部装备都是 200 级 —— 保留它会让 auto 模式永远不可用。
    // 现在 auto 直接交给游戏侧规则,穿戴中/已上锁的保护仍由 explicit 路径保证。
    // **注意**:auto 拆哪些完全由游戏内配置决定,本程序看不到、也拦不住。
    return { mode: "auto", result: await api.post("/api/equipment/auto-decompose", {}) };
  }

  if (!hasNarrowingCondition(conditions)) {
    throw new Error("explicit 模式至少要设一个收紧条件(成色评分上限 / 战力评分上限 / 等级上限 / 可分解品质),否则会把背包里所有未锁未穿的装备全部分解。");
  }

  const all = await listEquipment(api);
  const targets = [];
  const kept = [];
  for (const row of all) {
    const verdict = matchesDecomposeRules(row, conditions);
    if (verdict.ok) targets.push(row);
    else kept.push(digest(row, verdict.reason));
  }

  const ids = targets.map(pickKey).filter(Boolean);
  const out = {
    mode: "explicit",
    dryRun,
    conditions,
    scanned: all.length,
    matched: ids.length,
    keptCount: kept.length,
    targets: targets.map((r) => digest(r)),
    kept
  };
  if (ids.length === 0) return { ...out, result: null };
  const { result } = await runDecompose(api, ids, dryRun);
  return { ...out, equipmentIds: ids, result };
}

async function runDecompose(api, equipmentIds, dryRun) {
  const path = dryRun ? "/api/equipment/decompose-preview" : "/api/equipment/decompose";
  return { dryRun, equipmentIds, result: await api.post(path, { equipmentIds }) };
}

// 背包装备摘要,供 WebUI 渲染分解条件表单。
// 品质与属性名都从真实背包取,不写死枚举 —— 品质取值只确认了 red/gold/purple 三个,
// 猜出来的复选框会误导人;游戏日后加品质,这里也会自动跟上。
export async function equipmentSummary(api) {
  const all = await listEquipment(api);
  const qualities = new Map();
  const attrs = new Set();
  const rareRanks = new Map();
  let disposable = 0;
  // 成色评分的实际范围。前端拿它做输入框的上下界与提示,比自己猜一个区间靠谱。
  const rareScores = [];

  for (const row of all) {
    if (isDisposable(row)) disposable += 1;
    const q = row?.quality ?? "未知";
    qualities.set(q, (qualities.get(q) ?? 0) + 1);
    for (const k of attrKeys(row)) attrs.add(k);
    if (row?.rareRank) rareRanks.set(String(row.rareRank), (rareRanks.get(String(row.rareRank)) ?? 0) + 1);
    const rs = num(row[RARE_SCORE_FIELD]);
    if (rs !== null) rareScores.push(rs);
  }

  const sorted = [...rareScores].sort((a, b) => a - b);
  return {
    total: all.length,
    disposable,
    qualities: [...qualities].map(([quality, count]) => ({ quality, count })).sort((a, b) => b.count - a.count),
    attrKeys: [...attrs].sort(),
    // 成色档位按件数排序,前端能显示"神装 90 件 / 大极品 138 件"
    rareRanks: [...rareRanks].map(([rank, count]) => ({ rank, count })).sort((a, b) => b.count - a.count),
    // 成色评分范围;没有装备带这个字段时给 null,前端据此隐藏成色输入框
    rareScore: sorted.length
      ? { min: sorted[0], max: sorted[sorted.length - 1], count: sorted.length }
      : null
  };
}

// WebUI 分解面板的数据。拿不到背包时退回空摘要 —— 面板能渲染多少算多少,
// 不因为一个端点失败就把整页顶掉。错误单独回传,不混进摘要本身。
export async function viewForOptions(api) {
  try {
    return { summary: await equipmentSummary(api), error: null };
  } catch (err) {
    return { summary: EMPTY_SUMMARY, error: err.message };
  }
}

// 服务端自动分解规则。patch 结构 CLI 未展开(原样透传用户 JSON),故此处也不做校验。
export async function setAutoDecomposeRules(api, patch) {
  if (!patch || typeof patch !== "object") throw new Error("setAutoDecomposeRules 需要 patch 对象");
  return api.post("/api/equipment/auto-decompose-rules", { patch });
}

// 注意这是"切换"语义,不接受目标状态布尔值
export async function toggleLock(api, equipmentId) {
  if (!equipmentId) throw new Error("toggleLock 需要 equipmentId");
  return api.post("/api/equipment/toggle-lock", { equipmentId });
}

export async function recycleItem(api, itemId, amount = 1) {
  if (!itemId) throw new Error("recycleItem 需要 itemId");
  return api.post("/api/inventory/recycle", { itemId, amount });
}

// 供 guild 复用的物品行字段。服务端同义字段多,集中在这里挑。
export const ITEM_KEY_FIELDS = ["itemKey", "key", "templateKey", "itemTemplateKey"];
export const ITEM_ID_FIELDS = ["itemId", "id", "instanceId"];

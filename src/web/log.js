// 执行结果 → 中文日志行。页面上不再出现 JSON 数组。
//
// 取值优先级:
//   1. 游戏自己返回的中文串(rewards.summary[]、result.message)—— 最接近游戏内日志
//   2. 已在真号上验证过的字段名拼句子
//   3. 都对不上时退化成"带中文标签的缩进结构"(仍然不是 JSON)
// 所有键名均来自真号实测,没有猜的字段。原始数据留在折叠区,渲染器漏字段时用户仍能查证。
//
// 注意:游戏的 notices[] 是玩家的通知收件箱(实测首领响应里混着上一次分解产生的通知),
// 不是本次调用的产物,所以这里一律不拿 notices 当动作结果,只用 per-call 的 rewards.summary。
//
// 这是普通脚本不是模块(index.html 用 <script src> 直接加载),对外只挂 window.PGLog。
(function () {
  "use strict";

  var L = function (text, kind, indent) {
    return { t: text, k: kind || "", i: indent || 0 };
  };
  var asArr = function (v) {
    return Array.isArray(v) ? v : [];
  };

  var N = function (v) {
    if (typeof v !== "number" || !Number.isFinite(v)) return String(v == null ? "" : v);
    var n = Number.isInteger(v) ? v : Number(v.toFixed(2));
    return n.toLocaleString("zh-CN");
  };

  var dur = function (sec) {
    var s = Math.round(Number(sec) || 0);
    if (s <= 0) return "0 秒";
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var r = s % 60;
    var bits = [];
    if (h) bits.push(h + " 小时");
    if (m) bits.push(m + " 分");
    if (r && !h) bits.push(r + " 秒");
    return bits.length ? bits.join(" ") : "0 秒";
  };

  // compactForStore 落库时留下的裁剪标记。识别出来照实说"被裁剪了",
  // 不能当数据渲染,也不能假装数据完整。
  var CUT = [
    [/^…另有 (\d+) 项$/, "另有 $1 项未记录(落库时已裁剪)"],
    [/^\[数组 (\d+) 项,超出深度\]$/, "$1 项嵌套过深,未记录"],
    [/^\[对象,超出深度\]$/, "内容嵌套过深,未记录"]
  ];
  var cutNote = function (v) {
    if (typeof v !== "string") return null;
    for (var i = 0; i < CUT.length; i++) {
      var m = CUT[i][0].exec(v);
      if (m) return CUT[i][1].replace("$1", m[1]);
    }
    return null;
  };

  // 数组尾部可能是裁剪标记,不能当数据渲染
  var each = function (arr, out, indent, fn) {
    var rows = asArr(arr);
    for (var i = 0; i < rows.length; i++) {
      var note = cutNote(rows[i]);
      if (note) out.push(L(note, "muted", indent));
      else fn(rows[i], i);
    }
  };

  // 布尔字段的中文说法。没列到的一律"是/否"
  var BOOL_WORDS = {
    win: ["胜利", "失败"],
    predictedWin: ["预测能赢", "预测打不过"],
    claimed: ["已领取", "未领取"],
    canAfford: ["够", "不够"],
    outputReady: ["达标", "不达标"],
    survivalReady: ["达标", "不达标"],
    dryRun: ["仅预览", "实际执行"],
    locked: ["已上锁", "未上锁"],
    available: ["可挑战", "不可挑战"]
  };
  var PCT_KEYS = { chance: 1, winChance: 1, minWinChance: 1 };
  var SEC_KEYS = { validSeconds: 1, durationSeconds: 1, elapsedSeconds: 1, coveredSeconds: 1 };

  var scalar = function (v, key) {
    if (v === null || v === undefined || v === "") return "无";
    if (typeof v === "boolean") {
      var w = BOOL_WORDS[key];
      return w ? (v ? w[0] : w[1]) : v ? "是" : "否";
    }
    if (typeof v === "number") {
      if (PCT_KEYS[key]) return N(v) + "%";
      if (SEC_KEYS[key]) return dur(v);
      if (key === "efficiency") return N(v) + " 倍";
      return N(v);
    }
    // 长字符串可能带 …(共 N 字) 尾巴,原样显示就是诚实的
    return String(v);
  };

  // 兜底渲染用的字段中文名。只收真号上见过的键。
  var LABEL = {
    name: "名称", quality: "品质", level: "等级", score: "评分", rareRank: "极品词条",
    amount: "数量", count: "数量", exp: "经验", gold: "金币", killCount: "击杀",
    efficiency: "效率", validSeconds: "有效挂机", dropCount: "掉落件数",
    rareCoinFragments: "稀有币碎片", message: "说明", reason: "原因", error: "错误",
    step: "步骤", status: "状态", itemKey: "物品", itemType: "类型", equipmentId: "装备",
    bossKey: "首领", difficulty: "难度", rounds: "回合", winChance: "胜率",
    durationSeconds: "耗时", playerHp: "我方生命", bossHp: "首领生命",
    playerDamage: "我方输出", bossDamage: "首领输出", combatPower: "战力",
    powerBottleneck: "短板", goldCost: "金币消耗", ticketCost: "门票消耗",
    materialName: "材料", materialCost: "材料消耗", ownedGold: "现有金币",
    ownedTickets: "现有门票", ownedMaterial: "现有材料", drops: "掉落",
    summary: "获得", actionKey: "动作", professionKey: "副职", key: "标识",
    pauseReason: "暂停原因", elapsedSeconds: "已用时", point: "积分", stat: "属性",
    bonusAmount: "加成", coveredSeconds: "覆盖时长", createdAt: "时间"
  };

  // 玩家整体快照,和"这次做了什么"无关,渲染时一律丢掉
  var DROP = {
    player: 1, equipped: 1, bossAttempts: 1, itemAmounts: 1, rebirthBonuses: 1,
    notices: 1, statePatch: 1, id: 1, bindStatus: 1
  };

  // 对不上专用渲染器时的兜底:带中文标签的缩进结构。
  // 要求是"页面上不出现 JSON",不是"未知数据就不显示"。
  var generic = function (node, out, indent, depth) {
    depth = depth || 0;
    if (depth > 5) { out.push(L("(更深层内容已省略,见下方原始数据)", "muted", indent)); return; }
    var note = cutNote(node);
    if (note) { out.push(L(note, "muted", indent)); return; }
    if (node === null || node === undefined) { out.push(L("无", "muted", indent)); return; }
    if (typeof node !== "object") { out.push(L(scalar(node), "", indent)); return; }

    if (Array.isArray(node)) {
      if (node.length === 0) { out.push(L("(空)", "muted", indent)); return; }
      each(node, out, indent, function (item) {
        if (item === null || typeof item !== "object") out.push(L("· " + scalar(item), "", indent));
        else generic(item, out, indent, depth + 1);
      });
      return;
    }

    var keys = Object.keys(node);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (DROP[k]) continue;
      var v = node[k];
      var label = LABEL[k] || k;
      if (v === null || typeof v !== "object") { out.push(L(label + ":" + scalar(v, k), "", indent)); continue; }
      if (Array.isArray(v) && v.every(function (x) { return x === null || typeof x !== "object"; })) {
        out.push(L(label + ":" + (v.map(function (x) { return scalar(x); }).join("、") || "(空)"), "", indent));
        continue;
      }
      out.push(L(label + ":", "muted", indent));
      generic(v, out, indent + 1, depth + 1);
    }
  };

  // 装备一行式描述。品质保留游戏内部取值(red / orange / …):
  // 只有 red=传说 在真号掉落里得到确认,其余没验证过,写成中文名等于骗人 ——
  // 分解是不可逆操作,这里宁可丑一点也不能标错。
  var eqName = function (r) {
    if (!r || typeof r !== "object") return String(r == null ? "未知装备" : r);
    var bits = [];
    if (r.quality) bits.push(String(r.quality));
    if (typeof r.level === "number") bits.push(r.level + " 级");
    if (typeof r.score === "number") bits.push("评分 " + N(r.score));
    // rareRank 的取值本身就是「极品」,别再加前缀凑成"极品 极品"
    if (r.rareRank) bits.push(String(r.rareRank).indexOf("极品") >= 0 ? String(r.rareRank) : "极品 " + r.rareRank);
    var head = r.name || r.equipmentId || "未知装备";
    return bits.length ? head + "(" + bits.join(" · ") + ")" : head;
  };

  // 分解条件 → 一句话
  var condLine = function (c) {
    if (!c || typeof c !== "object") return "条件:未设置";
    var bits = [];
    if (typeof c.maxScore === "number") bits.push("评分低于 " + N(c.maxScore));
    if (typeof c.maxLevel === "number") bits.push("等级不高于 " + N(c.maxLevel));
    var q = asArr(c.qualities);
    if (q.length) bits.push("品质 " + q.join("/"));
    if (c.keepRareRank !== false) bits.push("保留极品词条");
    var ka = asArr(c.keepAttrs);
    if (ka.length) bits.push("命中 " + ka.join("/") + " 则保留");
    return "条件:" + (bits.length ? bits.join(" · ") : "未设置");
  };

  // 子结果里游戏自己给的说明,有就带上
  var resultNote = function (res) {
    if (!res || typeof res !== "object") return "";
    var m = res.message || res.msg;
    return typeof m === "string" && m ? " —— " + m : "";
  };

  // errors[].step 是本程序自己起的步骤名(features/*.mjs 里写死的),不是游戏返回值,
  // 所以可以放心译成中文。游戏返回的 name / itemKey 一律照原样显示。
  var STEP = {
    quest: "任务奖励", achievement: "成就奖励", codex: "图鉴奖励", daily: "每日活跃",
    signIn: "每日签到", mail: "邮件领取",
    redeem: "公会兑换", donate: "公会捐献", equipmentDonate: "捐献装备",
    claimDividend: "公会分红", claimProgress: "公会活跃奖励",
    settle: "副职结算", select: "选择副职动作", enqueue: "副职排队",
    claimReward: "领取首领奖励", worldStatus: "世界首领状态"
  };

  var errText = function (e) {
    if (typeof e === "string") return e;
    var step = e && e.step ? STEP[e.step] || e.step : "";
    var who = (e && (e.name || e.bossKey || e.itemKey || e.equipmentId)) || step || "";
    var msg = (e && e.error) || "未知错误";
    return who ? who + ":" + msg : String(msg);
  };

  // 游戏的「今日已领取」「次数已用尽」不是故障而是每日上限,
  // 混在失败里会让人以为程序坏了 —— 单独归到提示。
  var BENIGN = /(已领取|已用尽|已完成|完成捐献后|未开放|尚未开放|已达上限|上限|不足|冷却)/;
  var errLines = function (errors, out, base) {
    base = base || 0;
    var rows = asArr(errors);
    if (rows.length === 0) return;
    var benign = [], real = [];
    for (var i = 0; i < rows.length; i++) {
      var note = cutNote(rows[i]);
      if (note) { out.push(L(note, "muted", base)); continue; }
      (BENIGN.test(errText(rows[i])) ? benign : real).push(rows[i]);
    }
    if (benign.length) {
      out.push(L("提示(每日上限之类,不算失败):", "muted", base));
      for (var j = 0; j < benign.length; j++) out.push(L(errText(benign[j]), "muted", base + 1));
    }
    if (real.length) {
      out.push(L("失败 " + real.length + " 项:", "bad", base));
      for (var k = 0; k < real.length; k++) out.push(L(errText(real[k]), "bad", base + 1));
    }
  };

  // 先收集再渲染:裁剪提示得跟在数据后面,不能插到标题前面去
  var take = function (arr) {
    var rows = [], notes = [];
    var src = asArr(arr);
    for (var i = 0; i < src.length; i++) {
      var n = cutNote(src[i]);
      if (n) notes.push(n);
      else rows.push(src[i]);
    }
    return { rows: rows, notes: notes };
  };

  // 把子渲染器的输出整体缩进一级(一键日常里嵌套用)
  var sub = function (fn, data, out, base) {
    var tmp = [];
    fn(data, tmp);
    for (var i = 0; i < tmp.length; i++) out.push(L(tmp[i].t, tmp[i].k, tmp[i].i + base));
  };

  var STAT = { exp: "经验", gold: "金币", killCount: "击杀" };

  var R = {};

  // ① 收挂机收益。到手数量只能靠收取前的概览快照 ——
  // idle-collect 响应里的 rewardPreview 是收完清零后的累加器(真号实测全 0)。
  R.collect = function (d, out) {
    var b = d && d.before;
    if (b && (b.exp || b.gold || b.killCount || b.validSeconds)) {
      out.push(L("收下挂机收益:经验 " + N(b.exp || 0) + " · 金币 " + N(b.gold || 0) + " · 击杀 " + N(b.killCount || 0), "ok"));
      out.push(L("挂机 " + dur(b.validSeconds) + ",效率 " + N(b.efficiency || 1) + " 倍", "muted", 1));
      if (b.dropCount) out.push(L("掉落 " + N(b.dropCount) + " 件装备", "", 1));
      if (b.rareCoinFragments) out.push(L("稀有币碎片 " + N(b.rareCoinFragments), "", 1));
      var fb = b.foodBonus;
      if (fb && fb.name) {
        out.push(L(fb.name + " 生效:" + (STAT[fb.stat] || fb.stat || "收益") + " +" + N(fb.bonusAmount) +
          "(覆盖 " + dur(fb.coveredSeconds) + ")", "muted", 1));
      }
    } else if (b) {
      out.push(L("没有可收取的挂机收益(收取前概览为空)", "muted"));
    } else {
      out.push(L("已提交收取请求,但没读到收取前的收益概览,说不出这次到手多少", "warn"));
    }
    if (d && d.adventureResolved) {
      out.push(L("顺带处理了冒险事件,选了 " + (d.adventureOptionKey || "第一个选项"), "ok"));
    } else if (d && asArr(d.options).length) {
      out.push(L("触发冒险事件但没处理(" + asArr(d.options).length + " 个选项),收益可能没落袋", "warn"));
    }
  };

  // ② 背包分解
  R.inventory = function (d, out) {
    if (!d) { out.push(L("服务端没有返回分解结果", "muted")); return; }
    if (d.mode === "auto") {
      out.push(L("按游戏内的自动分解规则执行(条件在游戏里配,本程序无从预览)", "head"));
    } else {
      out.push(L("按本程序的条件筛选" + (d.dryRun ? "(仅预览,没有真的分解)" : ""), "head"));
      out.push(L(condLine(d.conditions), "muted"));
      out.push(L("扫描 " + N(d.scanned || 0) + " 件,命中 " + N(d.matched || 0) + " 件,保留 " + N(d.keptCount || 0) + " 件",
        d.matched ? "ok" : "muted"));
      each(d.targets, out, 1, function (r) { out.push(L((d.dryRun ? "将分解 " : "分解 ") + eqName(r), "", 1)); });
      var kept = [];
      each(d.kept, out, 1, function (r) { kept.push(r); });
      if (kept.length) {
        out.push(L("保留原因:", "muted"));
        for (var i = 0; i < kept.length && i < 12; i++) {
          out.push(L(eqName(kept[i]) + " —— " + (kept[i].reason || "未记录"), "muted", 1));
        }
        if (kept.length > 12) out.push(L("…其余 " + (kept.length - 12) + " 件同理", "muted", 1));
      }
    }
    invChanges(d.result, out, d.mode === "auto");
  };

  var invChanges = function (res, out, auto) {
    if (!res) {
      if (!auto) out.push(L("没有装备需要分解", "muted"));
      return;
    }
    var remEq = asArr(res.removedEquipmentIds), remIt = asArr(res.removedItemsIds);
    var eqCh = asArr(res.equipmentChanges), itCh = asArr(res.itemsChanges);
    if (remEq.length) out.push(L("已分解装备 " + N(remEq.length) + " 件", "ok"));
    if (remIt.length) out.push(L("已消耗物品 " + N(remIt.length) + " 项", "ok"));
    if (itCh.length) {
      // amount 是变动后的绝对存量,不是这次的增量 —— 说成"获得多少"就是编数字
      out.push(L("材料存量变化(下面是变动后的总数,不是这次获得数):", "muted"));
      each(itCh, out, 1, function (it) {
        out.push(L((it.name || it.itemKey || "未知物品") + " 现有 " + N(it.amount), "", 1));
      });
    }
    if (eqCh.length) {
      out.push(L("装备变动:", "muted"));
      each(eqCh, out, 1, function (r) { out.push(L(eqName(r), "", 1)); });
    }
    if (!remEq.length && !remIt.length && !itCh.length && !eqCh.length) {
      out.push(L("服务端没报任何变动,可能没有符合条件的装备", "muted"));
    }
  };

  // ③ 副职结算 + 排队。动作的中文名直接取响应里的 view.actions,不维护映射表
  R.profession = function (d, out) {
    var view = d && d.settled && d.settled.view;
    var names = {};
    take(view && view.actions).rows.forEach(function (a) { if (a && a.key) names[a.key] = a.name || a.key; });
    take(view && view.professions).rows.forEach(function (p) { if (p && p.key) names[p.key] = p.name || p.key; });
    var nameOf = function (k) { return names[k] || k || "未知动作"; };

    var res = d && d.settled && d.settled.result;
    if (res) {
      var done = take(res.completed);
      if (done.rows.length) {
        out.push(L("副职结算:完成 " + done.rows.length + " 项", "ok"));
        for (var i = 0; i < done.rows.length; i++) {
          out.push(L(nameOf(done.rows[i].actionKey) + " x" + N(done.rows[i].amount), "", 1));
        }
      } else {
        out.push(L("副职结算:这次没有完成的动作", "muted"));
      }
      done.notes.forEach(function (n) { out.push(L(n, "muted", 1)); });
      if (res.elapsedSeconds) out.push(L("累计挂了 " + dur(res.elapsedSeconds), "muted", 1));
      if (res.pauseReason) out.push(L("已暂停:" + res.pauseReason, "warn", 1));
    }

    var sel = d && d.selected;
    if (sel) out.push(L("切换到副职:" + (sel.name || sel.key || "未知"), "ok"));

    var q = take(d && d.enqueued);
    if (q.rows.length) {
      out.push(L("排入队列 " + q.rows.length + " 项", "ok"));
      for (var j = 0; j < q.rows.length; j++) {
        var e = q.rows[j];
        out.push(L(nameOf(e.actionKey) + " x" + N(e.count != null ? e.count : e.amount) + resultNote(e.result), "", 1));
      }
      q.notes.forEach(function (n) { out.push(L(n, "muted", 1)); });
    }

    // 存粮/药水存量顺手报一下,这是每天要盯的东西
    var sup = view && view.supplies;
    if (sup) {
      var foods = asArr(sup.foods).filter(function (f) { return f && f.owned; });
      if (foods.length) {
        out.push(L("存粮:" + foods.map(function (f) { return (f.name || f.key) + " x" + N(f.owned); }).join("、"), "muted"));
      }
      var pots = asArr(sup.bossPotions).filter(function (p) { return p && p.owned; });
      if (pots.length) {
        out.push(L("首领药水:" + pots.map(function (p) { return (p.name || p.key) + " x" + N(p.owned); }).join("、"), "muted"));
      }
    }
    errLines(d && d.errors, out);
  };

  // ④ 公会日常
  R.guild = function (d, out) {
    if (!d) { out.push(L("服务端没有返回公会结果", "muted")); return; }
    var any = false;
    var group = function (rows, title, fmt) {
      var got = take(rows);
      if (!got.rows.length) return;
      any = true;
      out.push(L(title + " " + got.rows.length + " 项", "ok"));
      for (var i = 0; i < got.rows.length; i++) out.push(L(fmt(got.rows[i]) + resultNote(got.rows[i].result), "", 1));
      got.notes.forEach(function (n) { out.push(L(n, "muted", 1)); });
    };
    group(d.redeemed, "公会兑换", function (r) { return (r.name || r.itemKey || "未知") + " x" + N(r.amount); });
    group(d.donated, "公会捐献", function (r) { return (r.name || r.itemKey || "未知") + " x" + N(r.amount); });
    group(d.equipmentDonated, "捐献装备", function (r) { return eqName(r.equipment || r) ; });
    group(d.progress, "领取进度奖励", function (r) { return N(r.point) + " 点档位"; });
    if (d.dividend) {
      any = true;
      var m = d.dividend.message;
      out.push(L(typeof m === "string" && m ? "公会分红:" + m : "已领取公会分红", "ok"));
    }
    if (!any) out.push(L("公会日常:这次没有可执行的项(规则里没配兑换/捐献)", "muted"));
    errLines(d.errors, out);
  };

  // 单场战斗。奖励优先用 rewards.summary —— 那是游戏自己写好的中文串,
  // 且是本次调用的产物;notices 是收件箱,会混进别的动作的结果,不能用。
  var bossAttempt = function (a, out) {
    var name = (a && (a.name || a.bossKey)) || "未知首领";
    if (a && a.dryRun) {
      var f = a.forecast || {};
      var verdict = f.predictedWin === true ? "预测能赢" : f.predictedWin === false ? "预测打不过" : "预测结果未知";
      out.push(L("预览 " + name + ":" + verdict + (f.chance != null ? " · 胜率 " + N(f.chance) + "%" : ""), "muted"));
      return;
    }
    var b = (a && a.result && a.result.battle) || null;
    var won = (a && a.win === true) || (b && b.win === true);
    out.push(L("挑战 " + name + ":" + (won ? "胜利" : "失败"), won ? "ok" : "bad"));

    var rw = (a && a.result && a.result.rewards) || null;
    var sum = take(rw && rw.summary).rows.filter(function (x) { return typeof x === "string" && x; });
    if (sum.length) out.push(L("获得 " + sum.join("、"), "", 1));
    else if (rw && (rw.exp || rw.gold)) out.push(L("获得 经验 " + N(rw.exp || 0) + " · 金币 " + N(rw.gold || 0), "", 1));

    take(rw && rw.drops).rows.forEach(function (dr) {
      if (dr && dr.rareRank) out.push(L("极品掉落 " + eqName(dr), "ok", 1));
    });

    if (b) {
      out.push(L(N(b.rounds) + " 回合 · 耗时 " + dur(b.durationSeconds) + " · 胜率 " + N(b.winChance) + "%", "muted", 1));
      out.push(L("我方生命 " + N(b.playerHpRemaining) + "/" + N(b.playerHp) +
        " · 首领生命 " + N(b.bossHpRemaining) + "/" + N(b.bossHp), "muted", 1));
      if (!won && b.powerBottleneck) out.push(L("短板:" + b.powerBottleneck, "warn", 1));
    }

    var c = (a && a.result && a.result.cost) || null;
    if (c && (c.ticketCost || c.goldCost || c.materialCost)) {
      var parts = [];
      if (c.ticketCost) parts.push("门票 " + N(c.ticketCost) + "(剩 " + N(c.ownedTickets) + ")");
      if (c.goldCost) parts.push("金币 " + N(c.goldCost));
      if (c.materialCost) parts.push((c.materialName || c.materialKey || "材料") + " " + N(c.materialCost) + "(剩 " + N(c.ownedMaterial) + ")");
      out.push(L("消耗 " + parts.join(" · "), "muted", 1));
    }
  };

  // ⑤ 首领。地图/个人首领与世界首领共用一个渲染器,字段各取所需
  R.boss = function (d, out) {
    if (!d) { out.push(L("服务端没有返回首领结果", "muted")); return; }
    var g = d.gate;
    if (g) {
      out.push(L("难度 " + (d.difficulty || "未知") +
        " · 只打胜率不低于 " + N(g.minWinChance || 0) + "% 的" + (g.requirePredictedWin ? "、且预测必胜的" : "") +
        " · " + (g.useTickets ? "允许消耗门票" : "不消耗门票"), "head"));
    }
    if (typeof d.freeAttemptsLeft === "number") out.push(L("剩余免费次数 " + N(d.freeAttemptsLeft), "muted"));

    var att = take(d.attempted);
    att.rows.forEach(function (a) { bossAttempt(a, out); });
    att.notes.forEach(function (n) { out.push(L(n, "muted")); });

    // 世界首领是协助语义,没有胜负
    var asst = take(d.assisted);
    if (asst.rows.length) {
      out.push(L("协助世界首领 " + asst.rows.length + " 次", "ok"));
      asst.rows.forEach(function (a) {
        out.push(L((a.bossKey || "未知首领") + (a.reason ? " —— 打不过,改为协助(" + a.reason + ")" : "") + resultNote(a.result), "", 1));
      });
    }
    if (d.status && d.status.status) out.push(L("世界首领状态:" + d.status.status, "muted"));

    if (typeof d.skipped === "string") {
      out.push(L(d.skipped, "muted"));
    } else {
      var sk = take(d.skipped);
      if (sk.rows.length) {
        out.push(L("跳过 " + sk.rows.length + " 个首领:", "muted"));
        sk.rows.forEach(function (s) {
          var chance = s.forecast && s.forecast.chance != null ? "(预测胜率 " + N(s.forecast.chance) + "%)" : "";
          out.push(L((s.name || s.bossKey || "未知首领") + " —— " + (s.reason || "未记录原因") + chance, "muted", 1));
        });
      }
    }

    if (d.claimed) {
      var m = d.claimed.message;
      if (typeof m === "string" && m) out.push(L("领奖:" + m, d.claimed.claimed ? "ok" : "muted"));
      else out.push(L(d.claimed.claimed ? "首领奖励已领取" : "没有可领的首领奖励", d.claimed.claimed ? "ok" : "muted"));
    }
    if (!att.rows.length && !asst.rows.length) {
      out.push(L("这次一个首领都没打", typeof d.skipped === "string" || take(d.skipped).rows.length ? "muted" : "warn"));
    }
    errLines(d.errors, out);
  };

  // ⑥ 活动/日志奖励。领取项服务端只回 key,没有中文名,原样显示;
  // 具体领到什么在 result 里,由 resultNote 带出游戏自己的说明。
  R.activity = function (d, out) {
    if (!d) { out.push(L("服务端没有返回活动奖励结果", "muted")); return; }
    var any = false;
    var group = function (rows, title, idKey, suffix) {
      var got = take(rows);
      if (!got.rows.length) return;
      any = true;
      out.push(L(title + " " + got.rows.length + " 项", "ok"));
      got.rows.forEach(function (r) {
        var id = r[idKey];
        out.push(L((id == null ? "未知" : String(id)) + (suffix || "") + resultNote(r.result), "", 1));
      });
      got.notes.forEach(function (n) { out.push(L(n, "muted", 1)); });
    };
    group(d.quests, "领取任务奖励", "questKey");
    group(d.achievements, "领取成就奖励", "achievementKey");
    group(d.codex, "领取图鉴奖励", "rewardKey");
    group(d.daily, "领取日常积分奖励", "point", " 点档位");
    if (d.signIn) {
      any = true;
      var sm = d.signIn.message;
      out.push(L(typeof sm === "string" && sm ? "签到:" + sm : "已签到", "ok"));
    }
    if (d.mail && (typeof d.mail !== "object" || Object.keys(d.mail).length)) {
      any = true;
      var mm = d.mail.message;
      out.push(L(typeof mm === "string" && mm ? "邮件:" + mm : "已一键领取邮件奖励", "ok"));
    }
    if (!any) out.push(L("活动奖励:这次没有可领取的项", "muted"));
    errLines(d.errors, out);
  };

  var JOB_LABEL = {
    collect: "收挂机收益",
    inventory: "背包分解",
    profession: "副职结算",
    guild: "公会日常",
    "boss.map": "地图/个人首领",
    "boss.world": "世界首领",
    activity: "活动奖励",
    dailyRun: "一键全部日常",
    changeMap: "切换挂机地图",
    status: "账号状态"
  };

  // 动作 → 渲染器。boss.map 与 boss.world 共用
  var RENDER_BY_JOB = {
    collect: "collect", inventory: "inventory", profession: "profession", guild: "guild",
    "boss.map": "boss", "boss.world": "boss", activity: "activity", dailyRun: "dailyRun"
  };

  // 一键全部日常:逐段套用对应渲染器
  R.dailyRun = function (d, out) {
    if (!d) { out.push(L("服务端没有返回执行结果", "muted")); return; }
    var ran = (d.ran && typeof d.ran === "object") ? d.ran : {};
    var keys = Object.keys(ran);
    if (!keys.length) out.push(L("没有任何步骤被执行", "warn"));
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      out.push(L("【" + (JOB_LABEL[k] || k) + "】", "head"));
      var fn = R[RENDER_BY_JOB[k]];
      if (fn) sub(fn, ran[k], out, 1);
      else generic(ran[k], out, 1);
    }
    var sk = take(d.skipped);
    if (sk.rows.length) {
      out.push(L("规则里没启用,跳过:" + sk.rows.map(function (k2) { return JOB_LABEL[k2] || k2; }).join("、"), "muted"));
    }
    errLines(d.errors, out);
  };

  // key 可以是排程任务键(boss.map)也可以是渲染器名(boss),两种都认
  var lines = function (data, key) {
    var out = [];
    try {
      var fn = R[RENDER_BY_JOB[key] || key];
      if (fn) fn(data, out);
      else generic(data, out, 0);
    } catch (err) {
      // 渲染器出错不能把结果吞掉 —— 说明白,原始数据仍在折叠区
      out.push(L("日志渲染出错:" + err.message + "(下方原始数据不受影响)", "bad"));
      try { generic(data, out, 0); } catch (e2) { /* 原始数据兜底已经在折叠区,这里放弃 */ }
    }
    if (!out.length) out.push(L("服务端没有返回任何内容", "muted"));
    return out;
  };

  // 任务列表的「结果」列:一行摘要。
  // 优先取战果(ok)而不是配置回显(head)—— 列表里想看的是"打赢没""分解了几件",
  // 不是"用了什么难度";配置只有在压根没战果时才拿来兜底。
  var oneLine = function (data, key) {
    var rows = lines(data, key);
    var win = null, cfg = null, plain = null, bad = 0;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.k === "bad") bad += 1;
      if (!win && r.k === "ok") win = r.t;
      if (!cfg && r.k === "head") cfg = r.t;
      if (!plain && r.i === 0) plain = r.t;
    }
    var head = win || plain || cfg || "已执行";
    return bad ? head + "(" + bad + " 项失败)" : head;
  };

  // 全程 textContent:游戏返回的名称是不可信输入,绝不能拼进 innerHTML
  var renderInto = function (host, data, key) {
    if (!host) return;
    host.textContent = "";
    var box = document.createElement("div");
    box.className = "log";
    var rows = lines(data, key);
    for (var i = 0; i < rows.length; i++) {
      var div = document.createElement("div");
      div.className = "log-line" + (rows[i].k ? " log-" + rows[i].k : "");
      if (rows[i].i) div.style.paddingLeft = rows[i].i * 1.2 + "em";
      div.textContent = rows[i].t;
      box.appendChild(div);
    }
    host.appendChild(box);

    // 原始数据折叠留底:渲染器万一漏字段,用户仍能自己查证
    var det = document.createElement("details");
    det.className = "log-raw";
    var sum = document.createElement("summary");
    sum.textContent = "原始数据";
    var pre = document.createElement("pre");
    try {
      pre.textContent = JSON.stringify(data, null, 2);
    } catch (err) {
      pre.textContent = "无法序列化:" + err.message;
    }
    det.appendChild(sum);
    det.appendChild(pre);
    host.appendChild(det);
  };

  window.PGLog = {
    lines: lines,
    oneLine: oneLine,
    renderInto: renderInto,
    JOB_LABEL: JOB_LABEL,
    label: function (key) { return JOB_LABEL[key] || key || ""; }
  };
})();

import { nowIso } from "./db.mjs";

// 个人首领「定向装备部位」的轮换游标。
//
// 个人首领可以带 targetSlot 指定这一场掉哪个部位的**定向可交易装备**
// (challengeOptions.targetSlots,实测 10 个)。用户要的语义是:
// **每次获得的装备轮流选择** —— 每次挑战用下一个部位,一天 10 次正好走完一圈,
// 第二天接着往下走而不是重置,这样十个部位都会被补齐。
//
// 游标记的是 `next_index`(取模用),不是"上次用了哪个" ——
// 前者天然处理了"槽位总数变多/变少"(游戏可能加部位),后者要对齐位置容易错位。
//
// 为什么必须持久化:一轮跑 10 次是一个循环体内的连续调用,但**跨轮次**必须接得上;
// 进程重启(每次部署都会重建容器)也不能从头开始,否则永远只打前几个部位。
export class BossSlotCursor {
  constructor(db) {
    this.db = db;
  }

  // 下一场该用的下标。没记过就是 0(从第一个部位开始)。
  nextIndex(accountId, bossKey) {
    const row = this.db
      .prepare(`SELECT next_index FROM boss_slot_cursor WHERE account_id=? AND boss_key=?`)
      .get(accountId, bossKey);
    return row?.next_index ?? 0;
  }

  // 推进一格。传槽位总数,取模后存回去 —— 这样槽位列表长度变化时不会越界。
  advance(accountId, bossKey, slotCount) {
    if (!Number.isFinite(slotCount) || slotCount <= 0) return 0;
    const next = (this.nextIndex(accountId, bossKey) + 1) % Math.floor(slotCount);
    this.set(accountId, bossKey, next);
    return next;
  }

  // 直接把游标写成一个已知的下标。挑战循环在内存里逐次推进、结束时一次性落库,
  // 所以需要一个"不取模、不依赖当前库值"的写法。
  set(accountId, bossKey, index) {
    const n = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
    this.db
      .prepare(
        `INSERT INTO boss_slot_cursor (account_id, boss_key, next_index, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, boss_key) DO UPDATE SET
           next_index = excluded.next_index,
           updated_at = excluded.updated_at`
      )
      .run(accountId, bossKey, n, nowIso());
    return n;
  }

  // 面板上显示用:当前游标 + 下一个会用的部位。没有记录说明还没开始。
  state(accountId, slots = []) {
    const rows = this.db
      .prepare(`SELECT boss_key, next_index, updated_at FROM boss_slot_cursor WHERE account_id=?`)
      .all(accountId);
    const n = slots.length;
    return rows.map((r) => ({
      bossKey: r.boss_key,
      nextIndex: r.next_index,
      // 槽位总数未知时不猜下一个是什么,只说下标
      nextSlot: n > 0 ? (slots[r.next_index % n] ?? null) : null,
      updatedAt: r.updated_at
    }));
  }

  reset(accountId, bossKey = null) {
    if (bossKey) {
      this.db.prepare(`DELETE FROM boss_slot_cursor WHERE account_id=? AND boss_key=?`).run(accountId, bossKey);
    } else {
      this.db.prepare(`DELETE FROM boss_slot_cursor WHERE account_id=?`).run(accountId);
    }
  }
}

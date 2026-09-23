import { nowIso } from "./db.mjs";

// 公会兑换的累计计数。
//
// 规则里的数量是「累计目标」而不是「每轮数量」—— 用户要的语义是:目标 2000,
// 每轮按库存继续换,累计到 2000 就停。所以必须跨轮记住"已经换过多少"。
//
// 为什么不从 /api/guild/redemption-logs 反推:那份日志只保留最近 120 条
// (实测 pagination.total=120),算不出长期累计,而且分页里也不保证有自己那几条。
export class RedeemTotals {
  constructor(db) {
    this.db = db;
  }

  // 某账号某项已累计兑换的数量,没记过就是 0
  get(accountId, itemKey) {
    const row = this.db
      .prepare(`SELECT redeemed FROM guild_redeem_totals WHERE account_id=? AND item_key=?`)
      .get(accountId, itemKey);
    return row?.redeemed ?? 0;
  }

  // 整账号的进度,供面板显示。返回 {itemKey: redeemed}
  all(accountId) {
    const rows = this.db.prepare(`SELECT item_key, redeemed FROM guild_redeem_totals WHERE account_id=?`).all(accountId);
    return Object.fromEntries(rows.map((r) => [r.item_key, r.redeemed]));
  }

  // 累加。**只记成功的那些** —— 失败的不算,否则目标会被虚报成已达成。
  add(accountId, itemKey, delta) {
    if (!Number.isFinite(delta) || delta <= 0) return this.get(accountId, itemKey);
    this.db
      .prepare(
        `INSERT INTO guild_redeem_totals (account_id, item_key, redeemed, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id, item_key) DO UPDATE SET
           redeemed = redeemed + excluded.redeemed,
           updated_at = excluded.updated_at`
      )
      .run(accountId, itemKey, Math.floor(delta), nowIso());
    return this.get(accountId, itemKey);
  }

  // 清零。传 itemKey 只清那一项,不传清整账号(面板上的「重来」)。
  reset(accountId, itemKey = null) {
    if (itemKey) {
      this.db.prepare(`DELETE FROM guild_redeem_totals WHERE account_id=? AND item_key=?`).run(accountId, itemKey);
    } else {
      this.db.prepare(`DELETE FROM guild_redeem_totals WHERE account_id=?`).run(accountId);
    }
  }
}

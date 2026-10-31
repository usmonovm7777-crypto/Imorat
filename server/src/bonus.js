import { HttpError, bad, readJson } from "./http.js";
import { randomBytes } from "node:crypto";

/* Bonus points: 1 point = 1 so'm.
   Earned when a shipment reaches the buyer (more for masters/foremen), spent at checkout up to a share of the goods.
   Referral: a friend who enters your code gets a welcome bonus; you get a bonus when the friend's first order arrives. */
export function createBonus({ db, cfg, log = console }) {
  const B = cfg.bonus;
  const add = (userId, delta, reason, ref = null) => {
    if (!delta) return;
    db.run("UPDATE users SET points=MAX(0, points+?) WHERE id=?", delta, userId);
    db.run("INSERT INTO points_log(user_id,delta,reason,ref,created_at) VALUES(?,?,?,?,?)", userId, delta, reason, ref, Date.now());
  };
  const has = (userId, ref) => !!db.get("SELECT 1 FROM points_log WHERE user_id=? AND ref=?", userId, ref);
  function codeFor(u) {
    if (u.ref_code) return u.ref_code;
    const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let i = 0; i < 20; i++) {
      const c = "IM" + [...randomBytes(5)].map(b => A[b % A.length]).join("");
      if (!db.get("SELECT 1 FROM users WHERE ref_code=?", c)) { db.run("UPDATE users SET ref_code=? WHERE id=?", c, u.id); return c; }
    }
    throw new Error("could not create a referral code");
  }
  /* how many points may be spent on this order */
  const spendable = (goods, balance, wanted) => Math.max(0, Math.min(Math.floor(Number(wanted) || 0), balance || 0, Math.floor(goods * B.maxShare)));
  return {
    add, codeFor, spendable,
    /* a shipment reached the buyer: cashback, then the referral reward on the friend's first delivery */
    shipDone(ship) {
      const o = db.get("SELECT * FROM orders WHERE id=?", ship.order_id); if (!o) return;
      const u = db.get("SELECT * FROM users WHERE id=?", o.user_id); if (!u) return;
      const ref = "ship:" + ship.id;
      // No cashback on a store's own orders (the owner cannot "sell to himself" for points), and never more than the cap per shipment
      const own = db.get("SELECT owner_id FROM stores WHERE id=?", ship.store_id)?.owner_id === u.id;
      if (!has(u.id, ref) && !own) {
        const goods = JSON.parse(ship.lines).reduce((a, l) => a + l.price * l.q, 0);
        add(u.id, Math.min(B.maxCashback, Math.floor(goods * (u.role === "pro" ? B.ratePro : B.rate))), "cashback", ref);
      }
      // Referral: the friend's welcome bonus and the inviter's reward arrive with the friend's first real delivery
      if (u.ref_by && !u.ref_paid && !own) {
        db.run("UPDATE users SET ref_paid=1 WHERE id=?", u.id);
        add(u.id, B.welcome, "welcome", "welcome:" + u.ref_by);
        add(u.ref_by, B.referral, "referral", "ref:" + u.id);
      }
    },
    /* the whole order was cancelled: give back the points spent on it */
    orderCancelled(orderId) {
      const o = db.get("SELECT * FROM orders WHERE id=?", orderId);
      if (!o || !o.points_used) return;
      const ref = "refund:" + o.id;
      if (has(o.user_id, ref)) return;
      // parts already refunded for single shipments are not refunded twice
      const partial = db.get("SELECT COALESCE(SUM(delta),0) s FROM points_log WHERE user_id=? AND ref LIKE ?", o.user_id, "refund:" + o.id + ":%").s;
      const left = o.points_used - partial;
      if (left > 0) add(o.user_id, left, "refund", ref);
    },
    /* one shipment of a multi-store order was cancelled while the rest goes on: its share of the points comes back */
    shipCancelled(sh) {
      const o = db.get("SELECT * FROM orders WHERE id=?", sh.order_id);
      if (!o || !o.points_used || !o.goods) return 0;
      const ref = `refund:${o.id}:${sh.id}`;
      if (has(o.user_id, ref)) return 0;
      const part = JSON.parse(sh.lines).reduce((a, l) => a + l.price * l.q, 0);
      const pts = Math.min(o.points_used, Math.round(o.points_used * part / o.goods));
      if (pts > 0) add(o.user_id, pts, "refund", ref);
      return pts;
    },
    routes(r, need, lim) {
      r.get("/api/me/bonus", req => {
        const u = need(req), code = codeFor(u);
        const fresh = db.get("SELECT points, ref_by FROM users WHERE id=?", u.id);
        return {
          points: fresh.points, code, rate: B.rate, rate_pro: B.ratePro, referral: B.referral, welcome: B.welcome, max_share: B.maxShare,
          invited: db.get("SELECT COUNT(*) n FROM users WHERE ref_by=?", u.id).n, invited_paid: db.get("SELECT COUNT(*) n FROM users WHERE ref_by=? AND ref_paid=1", u.id).n,
          has_ref: !!fresh.ref_by, can_enter: !fresh.ref_by && !db.get("SELECT 1 FROM orders WHERE user_id=?", u.id),
          log: db.all("SELECT delta, reason, ref, created_at FROM points_log WHERE user_id=? ORDER BY id DESC LIMIT 30", u.id)
        };
      });
      r.post("/api/me/bonus/referral", async req => {
        const u = need(req), b = await readJson(req);
        lim.hit("refcode:" + u.id, 10, 3600_000);
        const code = String(b.code || "").trim().toUpperCase();
        const owner = code && db.get("SELECT id FROM users WHERE ref_code=?", code);
        if (!owner) throw bad("bad_code", "No such code");
        if (owner.id === u.id) throw bad("own_code", "This is your own code");
        if (u.ref_by) throw new HttpError(409, "already_used", "A friend's code is already applied");
        if (db.get("SELECT 1 FROM orders WHERE user_id=?", u.id)) throw new HttpError(409, "not_new", "The code works only before the first order");
        if (db.get("SELECT COUNT(*) n FROM users WHERE ref_by=? AND created_at>?", owner.id, Date.now() - 30 * 86400_000).n >= B.maxInvites) throw new HttpError(409, "code_limit", "This code has reached its monthly limit");
        // The welcome bonus is credited when the friend's first order is delivered (see shipDone), not on entering the code
        db.run("UPDATE users SET ref_by=? WHERE id=?", owner.id, u.id);
        return { points: db.get("SELECT points FROM users WHERE id=?", u.id).points, pending_welcome: B.welcome };
      });
    }
  };
}

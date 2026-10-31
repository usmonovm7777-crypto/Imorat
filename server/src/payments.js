/* Online card payments: the whole order — goods, services and delivery — is charged at checkout, so the buyer
   pays nothing to the courier or the store. Two providers, both without extra libraries:
   - Payme (Merchant API, JSON-RPC callbacks)  https://developer.help.paycom.uz/
   - Click  (SHOP API, prepare/complete callbacks) https://docs.click.uz/
   An online order is held as "unpaid": the store does not see it until the money arrives; unpaid orders expire. */
import { createHash } from "node:crypto";
import { readBody } from "./http.js";

const PAYME_ERR = {
  auth: [-32504, "Недостаточно привилегий", "Yetarli huquq yo‘q", "Insufficient privileges"],
  method: [-32601, "Метод не найден", "Metod topilmadi", "Method not found"],
  parse: [-32700, "Ошибка разбора JSON", "JSON xatosi", "Parse error"],
  order: [-31050, "Заказ не найден", "Buyurtma topilmadi", "Order not found"],
  amount: [-31001, "Неверная сумма", "Noto‘g‘ri summa", "Wrong amount"],
  cannot: [-31008, "Заказ нельзя оплатить", "Buyurtmani to‘lab bo‘lmaydi", "Order cannot be paid"],
  trans: [-31003, "Транзакция не найдена", "Tranzaksiya topilmadi", "Transaction not found"],
  nocancel: [-31007, "Заказ уже выполняется, отмена невозможна", "Buyurtma bajarilmoqda, bekor qilib bo‘lmaydi", "Order is in progress, cannot cancel"]
};
const PAYME_TTL = 12 * 3600000; // a created but unperformed Payme transaction lives 12 hours

export function createPayments({ db, cfg, log = console, onPaid, cancelOrder }) {
  const payme = cfg.payme, click = cfg.click;
  const providers = [];
  if (payme.id && payme.key) providers.push("payme");
  if (click.serviceId && click.secret) providers.push("click");
  const available = p => providers.includes(p);
  const returnUrl = num => `${cfg.siteUrl}?paid=${encodeURIComponent(num)}`;

  /* checkout link the buyer is sent to */
  function payUrl(o) {
    if (o.pay === "payme" && available("payme")) {
      const lang = (JSON.parse(o.form || "{}").lang || "ru").replace(/[^a-z]/g, "").slice(0, 2) || "ru";
      const p = `m=${payme.id};ac.order=${o.num};a=${o.total * 100};c=${returnUrl(o.num)};l=${lang}`;
      return `${payme.url}/${Buffer.from(p, "utf8").toString("base64")}`;
    }
    if (o.pay === "click" && available("click")) {
      const q = new URLSearchParams({ service_id: click.serviceId, merchant_id: click.merchantId, amount: String(o.total), transaction_param: o.num, return_url: returnUrl(o.num) });
      return `https://my.click.uz/services/pay?${q}`;
    }
    return null;
  }

  const orderByNum = num => db.get("SELECT * FROM orders WHERE num=?", String(num || ""));
  /* an order that can still be paid: online payment, nothing received yet, not cancelled */
  const payable = o => o && !["store", "cash"].includes(o.pay) && o.pay_status === "pending" && o.status !== "cancelled";

  function markPaid(o, provider, pid) {
    db.run("UPDATE orders SET pay_status='paid', paid_at=?, pay_ref=? WHERE id=? AND pay_status='pending'", Date.now(), `${provider}:${pid}`, o.id);
    log.info(`[pay] ${o.num} paid via ${provider} (${pid}), ${o.total} so'm`);
    try { onPaid(o.id); } catch (e) { log.error("[pay] onPaid", e); }
  }
  /* money back: only while nothing has left the store */
  function refund(o, provider) {
    const ok = cancelOrder(o, "refund");
    if (ok) { db.run("UPDATE orders SET pay_status='refunded' WHERE id=?", o.id); log.info(`[pay] ${o.num} refunded via ${provider}`); }
    return ok;
  }

  /* ---------- Payme Merchant API (JSON-RPC 2.0) ---------- */
  const pErr = (id, key, data) => ({ jsonrpc: "2.0", id, error: { code: PAYME_ERR[key][0], message: { ru: PAYME_ERR[key][1], uz: PAYME_ERR[key][2], en: PAYME_ERR[key][3] }, ...(data ? { data } : {}) } });
  const pOk = (id, result) => ({ jsonrpc: "2.0", id, result });
  const pRow = pid => db.get("SELECT * FROM payments WHERE provider='payme' AND pid=?", String(pid));
  const pOut = t => ({ create_time: t.create_time, perform_time: t.perform_time || 0, cancel_time: t.cancel_time || 0, transaction: String(t.id), state: t.state, reason: t.reason ?? null });
  function paymeAuth(req) {
    const h = String(req.headers.authorization || "");
    if (!h.startsWith("Basic ")) return false;
    const [user, ...rest] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":"), key = rest.join(":");
    return user === "Paycom" && key && (key === payme.key || (payme.testKey && key === payme.testKey));
  }
  function paymeCheck(params) {
    const o = orderByNum(params?.account?.order);
    if (!o) return pErr(null, "order", "order");
    if (!payable(o) || o.pay !== "payme") return pErr(null, "cannot");
    if (Number(params.amount) !== o.total * 100) return pErr(null, "amount");
    return o;
  }
  async function paymeHandler(req, res) {
    const buf = await readBody(req, 64 * 1024);
    let body; try { body = JSON.parse(buf.toString("utf8")); } catch { return pErr(null, "parse"); }
    const id = body.id ?? null, params = body.params || {}, now = Date.now();
    if (!paymeAuth(req)) return pErr(id, "auth");
    switch (body.method) {
      case "CheckPerformTransaction": {
        const o = paymeCheck(params); if (o.error) return { ...o, id };
        return pOk(id, { allow: true });
      }
      case "CreateTransaction": {
        const t = pRow(params.id);
        if (t) {
          if (t.state !== 1) return pErr(id, "cannot");
          if (now - t.create_time > PAYME_TTL) { db.run("UPDATE payments SET state=-1, cancel_time=?, reason=4 WHERE id=?", now, t.id); return pErr(id, "cannot"); }
          return pOk(id, { create_time: t.create_time, transaction: String(t.id), state: 1 });
        }
        const o = paymeCheck(params); if (o.error) return { ...o, id };
        if (db.get("SELECT 1 FROM payments WHERE order_id=? AND state=1", o.id)) return pErr(id, "cannot"); // one open transaction per order
        const ins = db.run("INSERT INTO payments(provider,pid,order_id,amount,state,create_time) VALUES('payme',?,?,?,1,?)", String(params.id), o.id, Number(params.amount), Number(params.time) || now);
        return pOk(id, { create_time: Number(params.time) || now, transaction: String(ins.lastInsertRowid), state: 1 });
      }
      case "PerformTransaction": {
        const t = pRow(params.id); if (!t) return pErr(id, "trans");
        if (t.state === 2) return pOk(id, { transaction: String(t.id), perform_time: t.perform_time, state: 2 });
        if (t.state !== 1) return pErr(id, "cannot");
        if (now - t.create_time > PAYME_TTL) { db.run("UPDATE payments SET state=-1, cancel_time=?, reason=4 WHERE id=?", now, t.id); return pErr(id, "cannot"); }
        const o = db.get("SELECT * FROM orders WHERE id=?", t.order_id);
        if (!payable(o)) { db.run("UPDATE payments SET state=-1, cancel_time=?, reason=3 WHERE id=?", now, t.id); return pErr(id, "cannot"); }
        db.run("UPDATE payments SET state=2, perform_time=? WHERE id=?", now, t.id);
        markPaid(o, "payme", params.id);
        return pOk(id, { transaction: String(t.id), perform_time: now, state: 2 });
      }
      case "CancelTransaction": {
        const t = pRow(params.id); if (!t) return pErr(id, "trans");
        const reason = Number(params.reason) || 0;
        if (t.state === 1) { db.run("UPDATE payments SET state=-1, cancel_time=?, reason=? WHERE id=?", now, reason, t.id); return pOk(id, { transaction: String(t.id), cancel_time: now, state: -1 }); }
        if (t.state === 2) {
          const o = db.get("SELECT * FROM orders WHERE id=?", t.order_id);
          if (!refund(o, "payme")) return pErr(id, "nocancel");
          db.run("UPDATE payments SET state=-2, cancel_time=?, reason=? WHERE id=?", now, reason, t.id);
          return pOk(id, { transaction: String(t.id), cancel_time: now, state: -2 });
        }
        return pOk(id, { transaction: String(t.id), cancel_time: t.cancel_time, state: t.state });
      }
      case "CheckTransaction": {
        const t = pRow(params.id); if (!t) return pErr(id, "trans");
        return pOk(id, pOut(t));
      }
      case "GetStatement": {
        const rows = db.all("SELECT p.*, o.num FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.provider='payme' AND p.create_time>=? AND p.create_time<=? ORDER BY p.create_time", Number(params.from) || 0, Number(params.to) || now);
        return pOk(id, { transactions: rows.map(t => ({ id: t.pid, time: t.create_time, amount: t.amount, account: { order: t.num }, ...pOut(t), receivers: null })) });
      }
      default: return pErr(id, "method");
    }
  }

  /* ---------- Click SHOP API (prepare = action 0, complete = action 1) ---------- */
  const md5 = s => createHash("md5").update(s).digest("hex");
  const cRes = (b, error, error_note, extra = {}) => ({ click_trans_id: Number(b.click_trans_id) || 0, merchant_trans_id: String(b.merchant_trans_id || ""), error, error_note, ...extra });
  async function clickHandler(req) {
    const buf = await readBody(req, 64 * 1024), txt = buf.toString("utf8");
    let b = {};
    if ((req.headers["content-type"] || "").includes("json")) { try { b = JSON.parse(txt); } catch { b = {}; } }
    else b = Object.fromEntries(new URLSearchParams(txt));
    const action = Number(b.action);
    if (String(b.service_id) !== String(click.serviceId)) return cRes(b, -8, "Error in request from click");
    const base = action === 1 ? `${b.click_trans_id}${b.service_id}${click.secret}${b.merchant_trans_id}${b.merchant_prepare_id}${b.amount}${b.action}${b.sign_time}` : `${b.click_trans_id}${b.service_id}${click.secret}${b.merchant_trans_id}${b.amount}${b.action}${b.sign_time}`;
    if (md5(base) !== String(b.sign_string || "").toLowerCase()) return cRes(b, -1, "SIGN CHECK FAILED!");
    const o = orderByNum(b.merchant_trans_id);
    if (!o || o.pay !== "click") return cRes(b, -5, "Order not found");
    if (o.pay_status === "paid") return cRes(b, -4, "Already paid");
    if (Math.round(Number(b.amount)) !== o.total) return cRes(b, -2, "Incorrect parameter amount");
    const now = Date.now();
    if (action === 0) {
      if (!payable(o)) return cRes(b, -9, "Transaction cancelled");
      let t = db.get("SELECT * FROM payments WHERE provider='click' AND pid=?", String(b.click_trans_id));
      if (!t) { const ins = db.run("INSERT INTO payments(provider,pid,order_id,amount,state,create_time) VALUES('click',?,?,?,1,?)", String(b.click_trans_id), o.id, o.total, now); t = { id: Number(ins.lastInsertRowid) }; }
      return cRes(b, 0, "Success", { merchant_prepare_id: t.id });
    }
    if (action === 1) {
      const t = db.get("SELECT * FROM payments WHERE provider='click' AND id=? AND order_id=?", Number(b.merchant_prepare_id), o.id);
      if (!t) return cRes(b, -6, "Transaction does not exist");
      if (Number(b.error) < 0) { db.run("UPDATE payments SET state=-1, cancel_time=?, reason=? WHERE id=?", now, Number(b.error), t.id); return cRes(b, -9, "Transaction cancelled"); }
      if (t.state === 2) return cRes(b, 0, "Success", { merchant_confirm_id: t.id });
      if (!payable(o)) return cRes(b, -9, "Transaction cancelled");
      db.run("UPDATE payments SET state=2, perform_time=? WHERE id=?", now, t.id);
      markPaid(o, "click", String(b.click_trans_id));
      return cRes(b, 0, "Success", { merchant_confirm_id: t.id });
    }
    return cRes(b, -3, "Action not found");
  }

  function routes(r) {
    r.post("/api/pay/payme", (req, res) => paymeHandler(req, res));
    r.post("/api/pay/click", req => clickHandler(req));
    r.post("/api/pay/click/prepare", req => clickHandler(req));
    r.post("/api/pay/click/complete", req => clickHandler(req));
  }
  /* unpaid online orders expire: stock goes back, the buyer may order again */
  function sweep(now = Date.now()) {
    for (const o of db.all("SELECT * FROM orders WHERE pay_status='pending' AND pay NOT IN ('store','cash') AND status<>'cancelled' AND created_at<?", now - cfg.payTimeoutMin * 60000)) {
      if (cancelOrder(o, "unpaid")) log.info(`[pay] ${o.num} cancelled: not paid in ${cfg.payTimeoutMin} min`);
    }
  }
  return { providers, available, payUrl, routes, sweep, markPaid };
}


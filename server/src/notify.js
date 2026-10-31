import { escHtml as h } from "./telegram.js";

/* All outgoing notifications in one place: Telegram, Web Push and SMS.
   Failures never break the order flow; they are only logged. */
const money = n => Math.round(n).toLocaleString("ru-RU").replace(/ /g, " ") + " сум";
const WHEN = { asap: "как можно скорее", slot: "завтра 10:00–14:00", vip: "к точному часу" };
const BUYER_TEXT = {
  assembling: (o, s) => `Магазин ${s.name} принял заказ ${o.num} и собирает его.`,
  searching: o => `Заказ ${o.num} собран, вызываем курьера Яндекс.`,
  to_store: o => `Курьер едет в магазин за заказом ${o.num}.`,
  on_way: o => `Курьер забрал заказ ${o.num} и едет к вам.`,
  delivered: o => `Заказ ${o.num} доставлен. Оцените магазин на сайте — это помогает другим покупателям.`,
  ready: (o, s) => `Заказ ${o.num} готов к выдаче: ${s.name}, ${s.addr}. Часы работы: ${s.hours}.`,
  picked: o => `Заказ ${o.num} выдан. Спасибо! Оцените магазин на сайте.`
};
const CANCEL_TEXT = {
  not_accepted: "магазин не подтвердил заказ вовремя",
  out_of_stock: "товара не оказалось в наличии",
  not_shipped: "магазин не передал заказ вовремя",
  buyer: "вы отменили заказ",
  unpaid: "оплата картой не поступила вовремя; товар снова в продаже, можно оформить заново",
  refund: "платёж отменён банком или вами, деньги вернутся на карту"
};
export const sellerButtons = s => {
  if (s.status === "new") return [[{ text: "✅ Принять · Qabul qilish", callback_data: `acc:${s.id}` }], [{ text: "❌ Нет в наличии · Mavjud emas", callback_data: `oos:${s.id}` }]];
  if (s.status === "assembling") return [[s.tariff ? { text: "🚚 Готов, вызвать курьера · Kuryer chaqirish", callback_data: `rdy:${s.id}` } : { text: "📦 Готов к выдаче · Tayyor", callback_data: `rdy:${s.id}` }]];
  if (s.status === "ready") return [[{ text: "🤝 Выдан покупателю · Topshirildi", callback_data: `pick:${s.id}` }]];
  return [];
};
const STATUS_RU = { new: "🆕 Новый", assembling: "🛠 Собирается", searching: "🚚 Ищем курьера", to_store: "🚚 Курьер едет", on_way: "🚚 В пути", delivered: "✅ Доставлен", ready: "📦 Готов к выдаче", picked: "✅ Выдан", cancelled: "❌ Отменён" };

export function createNotify({ db, cfg, tg, push, sms, ref, log = console }) {
  const D = Object.fromEntries(ref.districts.map(d => [d.id, d]));
  const ctx = shipId => {
    const s = db.get("SELECT * FROM shipments WHERE id=?", shipId);
    const o = s && db.get("SELECT * FROM orders WHERE id=?", s.order_id);
    const st = s && db.get("SELECT * FROM stores WHERE id=?", s.store_id);
    const owner = st?.owner_id && db.get("SELECT * FROM users WHERE id=?", st.owner_id);
    const buyer = o && db.get("SELECT * FROM users WHERE id=?", o.user_id);
    return { s, o, st, owner, buyer, f: o ? JSON.parse(o.form) : {} };
  };
  const safe = p => Promise.resolve(p).catch(e => log.warn("[notify]", e.message));
  function sellerText({ s, o, st, f }) {
    const lines = JSON.parse(s.lines).map(l => `• ${h(l.name)} × ${l.q} — ${money(l.price * l.q)}`).join("\n");
    const goods = JSON.parse(s.lines).reduce((a, l) => a + l.price * l.q, 0);
    const where = s.tariff ? `Яндекс Доставка → ${h(D[f.district]?.ru || "")} р-н, ${h(f.street)}${f.flat ? ", кв. " + h(f.flat) : ""}${f.floor > 1 ? `, этаж ${f.floor}` : ""}` : "Самовывоз из магазина";
    const deadline = s.status === "new" ? `\n⏱ Примите в течение ${cfg.timers.cancel} минут${s.start_at > Date.now() + 60000 ? ` (отсчёт с ${new Date(s.start_at + 5 * 3600000).toISOString().slice(11, 16)}, когда магазин откроется)` : ""}, иначе заказ отменится.` : "";
    return `<b>${STATUS_RU[s.status] || s.status} заказ ${h(o.num)}</b> · ${h(st.name)}\n\n${lines}\n<b>Итого: ${money(goods)}</b>\n\n${where}\nКогда: ${WHEN[f.when] || f.when}${f.when === "vip" ? ` (${f.hour}:00)` : ""}\nПокупатель: ${h(f.name)}, +${h(String(f.phone).replace(/\D/g, ""))}${f.comment ? `\nКомментарий: «${h(f.comment)}»` : ""}\nОплата: ${o.pay === "store" || o.pay === "cash" ? "покупатель платит магазину при получении" : o.pay_status === "paid" ? "💳 оплачен картой полностью, включая доставку — выдавайте без оплаты" : "ожидает оплаты"}${deadline}`;
  }
  const cabinet = `${cfg.siteUrl}#seller`;
  return {
    async shipmentNew(shipId) {
      const c = ctx(shipId); if (!c.s || !c.st) return;
      if (c.owner?.tg_chat) {
        const m = await safe(tg.send(c.owner.tg_chat, sellerText(c), sellerButtons(c.s)));
        if (m?.message_id) db.run("UPDATE shipments SET tg_msg=? WHERE id=?", JSON.stringify({ chat: c.owner.tg_chat, id: m.message_id }), c.s.id);
      }
      if (c.owner) safe(push.toUser(c.owner.id, { title: `Новый заказ ${c.o.num}`, body: `${JSON.parse(c.s.lines).length} поз. · примите за ${cfg.timers.cancel} мин`, url: cabinet, tag: "ship-" + c.s.id }));
    },
    async sellerRefresh(shipId) {
      const c = ctx(shipId); if (!c.s?.tg_msg) return;
      const m = JSON.parse(c.s.tg_msg);
      await safe(tg.edit(m.chat, m.id, sellerText(c), sellerButtons(c.s)));
    },
    async remind(shipId) {
      const c = ctx(shipId); if (!c.s || !c.owner) return;
      const left = Math.max(1, Math.round(cfg.timers.cancel - (Date.now() - (c.s.start_at || c.s.status_at)) / 60000));
      if (c.owner.tg_chat) safe(tg.send(c.owner.tg_chat, `⏰ <b>Заказ ${h(c.o.num)} ждёт подтверждения</b>\nОсталось ${left} мин, потом он отменится и снизит рейтинг магазина.`, sellerButtons(c.s)));
      safe(push.toUser(c.owner.id, { title: `⏰ Примите заказ ${c.o.num}`, body: `Осталось ${left} мин`, url: cabinet, tag: "ship-" + c.s.id }));
    },
    async smsSeller(shipId) {
      const c = ctx(shipId); if (!c.s || !c.st) return;
      const phone = c.st.phone || c.owner?.phone; if (!phone) return;
      await safe(sms.sendText(phone, cfg.smsSellerTemplate.replace("{num}", c.o.num)));
    },
    /* card payment received: the buyer learns the order is now with the store */
    async paid(shipId) {
      const c = ctx(shipId); if (!c.s || !c.buyer) return;
      const text = `Оплата по заказу ${c.o.num} получена (${c.o.total.toLocaleString("ru-RU")} сум, включая доставку). Магазин ${c.st.name} получил заказ.`;
      if (c.buyer.tg_chat) safe(tg.send(c.buyer.tg_chat, h(text)));
      safe(push.toUser(c.buyer.id, { title: `Imorat Go · ${c.o.num}`, body: text, url: `${cfg.siteUrl}#orders`, tag: "order-" + c.o.num }));
    },
    async status(shipId) {
      const c = ctx(shipId); if (!c.s) return;
      this.sellerRefresh(shipId);
      const text = c.s.status === "cancelled"
        ? `Заказ ${c.o.num} из магазина ${c.st.name} отменён: ${CANCEL_TEXT[c.s.cancel_reason] || "отмена"}.${c.s.cancel_reason !== "buyer" ? " Оплачивать ничего не нужно. Попробуйте заказать этот товар в другом магазине." : ""}`
        : BUYER_TEXT[c.s.status]?.(c.o, c.st);
      if (!text || !c.buyer || c.s.cancel_reason === "buyer") return;
      if (c.buyer.tg_chat) safe(tg.send(c.buyer.tg_chat, h(text)));
      safe(push.toUser(c.buyer.id, { title: `Imorat Go · ${c.o.num}`, body: text, url: `${cfg.siteUrl}#orders`, tag: "order-" + c.o.num }));
    },
    async admins(text) {
      for (const a of db.all(`SELECT * FROM users WHERE tg_chat IS NOT NULL AND phone IN (${cfg.admins.map(() => "?").join(",") || "''"})`, ...cfg.admins)) safe(tg.send(a.tg_chat, text));
    }
  };
}

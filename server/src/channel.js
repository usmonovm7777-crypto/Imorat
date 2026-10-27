import { HttpError, bad, readJson } from "./http.js";
import { escHtml as h } from "./telegram.js";

/* Telegram channel autoposts (bot must be an admin of the channel, TELEGRAM_CHANNEL=@name or -100…):
   every day at CHANNEL_HOUR (Tashkent time) — the product of the day, new products and price drops;
   right away — a new store approved by the moderator. Posts are bilingual: Russian, then Uzbek. */
const money = n => Math.round(n).toLocaleString("ru-RU").replace(/\s/g, " ");
const tashDay = t => new Date(t + 5 * 3600000).toISOString().slice(0, 10);
const uzNew = t => String(t || "").replace(/O[‘ʻ'`]/g, "Ö").replace(/o[‘ʻ'`]/g, "ö").replace(/G[‘ʻ'`]/g, "Ğ").replace(/g[‘ʻ'`]/g, "ğ").replace(/SH|Sh/g, "Ş").replace(/sh/g, "ş").replace(/CH|Ch/g, "Ç").replace(/ch/g, "ç");

export function createChannel({ db, cfg, tg, log = console }) {
  const C = cfg.channel, on = () => !!(tg.enabled && C.chat);
  const site = cfg.siteUrl, img = p => (!p ? null : p.startsWith("http") ? p : p.startsWith("/uploads/") ? (cfg.publicUrl ? cfg.publicUrl + p : null) : site + p.replace(/^\//, ""));
  const link = id => `${site}#p-${id}`;
  const offers = () => db.all(`SELECT p.id, p.ru, p.uz, p.img, p.cat, p.hit, p.created_at, p.store_id, MIN(o.price) mn, COUNT(*) n, SUM(o.stock>0) instock
    FROM products p JOIN offers o ON o.product_id=p.id JOIN stores s ON s.id=o.store_id AND s.status='active' WHERE p.active=1 GROUP BY p.id`);
  const posted = (kind, pid, days) => !!db.get("SELECT 1 FROM channel_posts WHERE kind=? AND product_id IS ? AND created_at>?", kind, pid ?? null, Date.now() - days * 86400000);
  const record = (kind, pid, msg) => db.run("INSERT INTO channel_posts(kind,product_id,msg_id,created_at) VALUES(?,?,?,?)", kind, pid ?? null, msg?.message_id ?? null, Date.now());
  const btn = (url, ru = "Открыть на Imorat · Imoratda ochish") => [[{ text: ru, url }]];

  function productOfDay() {
    const list = offers().filter(p => p.instock > 0 && !posted("day", p.id, 45));
    if (!list.length) return null;
    // most stores compete on it, hits first; rotate by the day so it changes every day
    const score = p => p.n * 3 + (p.hit ? 4 : 0);
    const top = list.sort((a, b) => score(b) - score(a)).slice(0, 15), p = top[Number(tashDay(Date.now()).replace(/-/g, "")) % top.length];
    const cheapest = db.get("SELECT s.name FROM offers o JOIN stores s ON s.id=o.store_id AND s.status='active' WHERE o.product_id=? ORDER BY o.price LIMIT 1", p.id)?.name || "";
    const text = `🔥 <b>Товар дня</b>\n<b>${h(p.ru)}</b>\nот ${money(p.mn)} сум${p.n > 1 ? ` · ${p.n} магазинов, дешевле всего в «${h(cheapest)}»` : ""}\nДоставка Яндекс по Ташкенту.\n\n🔥 <b>Kun mahsuloti</b>\n<b>${h(uzNew(p.uz))}</b>\n${money(p.mn)} so‘mdan${p.n > 1 ? ` · ${p.n} ta do‘kon` : ""}`;
    return { kind: "day", pid: p.id, text, photo: img(p.img), buttons: btn(link(p.id), "Купить · Sotib olish") };
  }
  function newProducts(sinceMs) {
    const list = offers().filter(p => p.created_at && p.created_at > sinceMs && !posted("new", p.id, 365)).slice(0, 8);
    if (!list.length) return null;
    const lines = list.map(p => `• <a href="${h(link(p.id))}">${h(p.ru)}</a> — от ${money(p.mn)} сум`).join("\n");
    return { kind: "new", pids: list.map(p => p.id), text: `🆕 <b>Новинки на Imorat · Yangi mahsulotlar</b>\n\n${lines}`, buttons: btn(site + "#catalog", "Весь каталог · Butun katalog") };
  }
  function priceDrops() {
    const now = offers(), drops = [];
    for (const p of now) {
      const prev = db.get("SELECT min_price FROM price_snap WHERE product_id=?", p.id)?.min_price;
      if (prev && p.mn <= prev * (1 - C.dropPct)) drops.push({ ...p, prev });
    }
    db.tx(() => { for (const p of now) db.run("INSERT INTO price_snap(product_id,min_price,day) VALUES(?,?,?) ON CONFLICT(product_id) DO UPDATE SET min_price=excluded.min_price, day=excluded.day", p.id, p.mn, tashDay(Date.now())); });
    if (!drops.length) return null;
    const list = drops.sort((a, b) => (b.prev - b.mn) / b.prev - (a.prev - a.mn) / a.prev).slice(0, 8);
    const lines = list.map(p => `• <a href="${h(link(p.id))}">${h(p.ru)}</a>: <s>${money(p.prev)}</s> → <b>${money(p.mn)}</b> сум (−${Math.round((p.prev - p.mn) * 100 / p.prev)}%)`).join("\n");
    return { kind: "drop", pids: list.map(p => p.id), text: `📉 <b>Цены снизились · Narxlar tushdi</b>\n\n${lines}` };
  }
  async function send(post) {
    if (!post || !on()) return null;
    const m = post.photo ? await tg.sendPhoto(C.chat, post.photo, post.text, post.buttons) || await tg.send(C.chat, post.text, post.buttons) : await tg.send(C.chat, post.text, post.buttons);
    if (m) { if (post.pids) post.pids.forEach(id => record(post.kind, id, m)); else record(post.kind, post.pid, m); }
    return m;
  }
  /* daily run: once a day after CHANNEL_HOUR */
  async function daily(now = Date.now(), force = false) {
    const d = tashDay(now), hour = new Date(now + 5 * 3600000).getUTCHours();
    if (!force && (db.meta("channel_day") === d || hour < C.hour)) return [];
    db.setMeta("channel_day", d);
    const since = Number(db.meta("channel_new_since") || now); // first run: nothing counts as new yet
    db.setMeta("channel_new_since", now);
    const out = [];
    for (const post of [productOfDay(), newProducts(since), priceDrops()]) if (post) { await send(post); out.push(post.kind); }
    return out;
  }
  return {
    enabled: on, daily, send, productOfDay, newProducts, priceDrops,
    async storeApproved(store) {
      if (!on() || posted("store:" + store.id, null, 3650)) return;
      const m = await tg.send(C.chat, `🏪 <b>Новый магазин на Imorat · Yangi do‘kon</b>\n<b>${h(store.name)}</b>\n${h(store.descr || "").slice(0, 200)}\n📍 ${h(store.addr || "")}`, btn(site + "#catalog", "Смотреть товары · Mahsulotlarni ko‘rish"));
      if (m) record("store:" + store.id, null, m);
    },
    routes(r, needAdmin) {
      r.get("/api/admin/channel", req => {
        needAdmin(req);
        const prev = [productOfDay(), newProducts(Date.now() - 7 * 86400000)].filter(Boolean).map(p => ({ kind: p.kind, text: p.text, photo: p.photo || null }));
        return { enabled: on(), chat: C.chat || null, hour: C.hour, last: db.all("SELECT kind, product_id, created_at FROM channel_posts ORDER BY id DESC LIMIT 10"), preview: prev };
      });
      r.post("/api/admin/channel/post", async req => {
        needAdmin(req); const b = await readJson(req);
        if (!on()) throw new HttpError(409, "channel_off", "Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL and add the bot to the channel as an admin");
        const post = b.kind === "day" ? productOfDay() : b.kind === "new" ? newProducts(Date.now() - 7 * 86400000) : b.kind === "drop" ? priceDrops() : null;
        if (!["day", "new", "drop"].includes(b.kind)) throw bad("bad_kind", "kind: day, new or drop");
        if (!post) return { posted: false, reason: "nothing_to_post" };
        const m = await send(post);
        if (!m) throw new HttpError(502, "telegram_failed", "Telegram did not accept the post; check that the bot is an admin of the channel");
        return { posted: true, kind: post.kind };
      });
    }
  };
}

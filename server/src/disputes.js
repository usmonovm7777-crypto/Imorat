import { HttpError, bad, readJson, readBody, str, int } from "./http.js";
import { escHtml as h } from "./telegram.js";

/* "Problem with the order": the buyer reports (reason, text, up to 3 photos), the store answers,
   a moderator resolves. Everyone involved is told in Telegram / push. */
export const REASONS = ["not_delivered", "missing", "damaged", "wrong", "quality", "other"];
const REASON_RU = { not_delivered: "не привезли", missing: "привезли не всё", damaged: "повреждено / брак", wrong: "не тот товар", quality: "плохое качество", other: "другое" };
const STATUS_RU = { open: "открыта", answered: "магазин ответил", resolved: "решена", rejected: "отклонена" };

export function registerDisputes({ r, db, cfg, need, needSeller, needAdmin, isAdmin, audit, lim, tg, push, saveImage, mediaUrl, log }) {
  const safe = p => Promise.resolve(p).catch(e => log.warn("[disputes]", e.message));
  const out = d => ({ id: d.id, order: d.num, ship_id: d.ship_id, store: d.store_id, store_name: d.store_name, reason: d.reason, text: d.text, photos: JSON.parse(d.photos || "[]").map(mediaUrl),
    status: d.status, seller_reply: d.seller_reply, resolution: d.resolution, created: d.created_at, updated: d.updated_at, buyer: d.buyer_name, phone: d.buyer_phone });
  const q = `SELECT d.*, o.num, s.name store_name, u.name buyer_name, u.phone buyer_phone FROM disputes d JOIN orders o ON o.id=d.order_id JOIN stores s ON s.id=d.store_id LEFT JOIN users u ON u.id=d.user_id`;
  const tell = (userId, text, url) => {
    const u = userId && db.get("SELECT * FROM users WHERE id=?", userId); if (!u) return;
    if (u.tg_chat) safe(tg.send(u.tg_chat, text));
    safe(push.toUser(u.id, { title: "Imorat", body: text.replace(/<[^>]+>/g, "").slice(0, 160), url }));
  };
  const admins = text => { for (const a of db.all(`SELECT tg_chat FROM users WHERE tg_chat IS NOT NULL AND phone IN (${cfg.admins.map(() => "?").join(",") || "''"})`, ...cfg.admins)) safe(tg.send(a.tg_chat, text)); };

  r.post("/api/orders/:num/problems", async (req, res, p) => {
    const u = need(req), b = await readJson(req);
    lim.hit("dispute:" + u.id, 10, 86400_000);
    const o = db.get("SELECT * FROM orders WHERE num=? AND user_id=?", p.num, u.id);
    if (!o) throw new HttpError(404, "not_found", "Order not found");
    const sh = db.get("SELECT * FROM shipments WHERE id=? AND order_id=?", int(b.ship_id, 1, 1e12), o.id);
    if (!sh) throw bad("bad_shipment", "Choose the store the problem is about");
    if (!REASONS.includes(b.reason)) throw bad("bad_reason", "Choose what went wrong");
    const text = str(b.text, 1500);
    if (text.length < 5) throw bad("bad_text", "Describe the problem in a few words");
    if (db.get("SELECT 1 FROM disputes WHERE ship_id=? AND status IN ('open','answered')", sh.id)) throw new HttpError(409, "already_open", "There is already an open problem for this store");
    const now = Date.now();
    const id = Number(db.run("INSERT INTO disputes(order_id,ship_id,store_id,user_id,reason,text,photos,status,created_at,updated_at) VALUES(?,?,?,?,?,?,'[]','open',?,?)", o.id, sh.id, sh.store_id, u.id, b.reason, text, now, now).lastInsertRowid);
    audit(req, "dispute.open", id, { order: o.num, store: sh.store_id });
    const st = db.get("SELECT * FROM stores WHERE id=?", sh.store_id);
    tell(st?.owner_id, `⚠️ <b>Жалоба по заказу ${h(o.num)}</b>: ${REASON_RU[b.reason]}\n«${h(text)}»\n\nОтветьте покупателю в кабинете продавца — модератор Imorat тоже видит жалобу.`, `${cfg.siteUrl}#seller`);
    admins(`⚠️ Жалоба #${id} · заказ ${h(o.num)} · ${h(st?.name || "")}: ${REASON_RU[b.reason]}\n«${h(text.slice(0, 300))}»`);
    return { problem: out(db.get(q + " WHERE d.id=?", id)) };
  });
  r.post("/api/problems/:id/photo", async (req, res, p) => {
    const u = need(req), d = db.get("SELECT * FROM disputes WHERE id=? AND user_id=?", Number(p.id), u.id);
    if (!d) throw new HttpError(404, "not_found", "Problem not found");
    const photos = JSON.parse(d.photos || "[]");
    if (photos.length >= 3) throw bad("too_many_photos", "Up to 3 photos");
    const path = saveImage(await readBody(req, 5 * 1024 * 1024), "d" + d.id);
    photos.push(path); db.run("UPDATE disputes SET photos=?, updated_at=? WHERE id=?", JSON.stringify(photos), Date.now(), d.id);
    return { photos: photos.map(mediaUrl) };
  });
  r.get("/api/me/problems", req => { const u = need(req); return { problems: db.all(q + " WHERE d.user_id=? ORDER BY d.id DESC LIMIT 50", u.id).map(out).map(({ buyer, phone, ...x }) => x) }; });
  r.get("/api/seller/problems", req => { const { s } = needSeller(req); return { problems: db.all(q + " WHERE d.store_id=? ORDER BY d.status IN ('open','answered') DESC, d.id DESC LIMIT 50", s.id).map(out) }; });
  r.post("/api/seller/problems/:id/reply", async (req, res, p) => {
    const { s } = needSeller(req), b = await readJson(req);
    const d = db.get("SELECT * FROM disputes WHERE id=? AND store_id=?", Number(p.id), s.id);
    if (!d) throw new HttpError(404, "not_found", "Problem not found");
    if (!["open", "answered"].includes(d.status)) throw new HttpError(409, "closed", "The problem is already closed");
    const text = str(b.text, 1500); if (text.length < 2) throw bad("bad_text", "Write an answer");
    db.run("UPDATE disputes SET seller_reply=?, status='answered', updated_at=? WHERE id=?", text, Date.now(), d.id);
    const o = db.get("SELECT num FROM orders WHERE id=?", d.order_id);
    tell(d.user_id, `Магазин «${h(s.name)}» ответил на вашу жалобу по заказу ${h(o.num)}:\n«${h(text)}»`, `${cfg.siteUrl}#orders`);
    return { problem: out(db.get(q + " WHERE d.id=?", d.id)) };
  });
  r.get("/api/admin/problems", req => { needAdmin(req); return { problems: db.all(q + " ORDER BY d.status IN ('open','answered') DESC, d.id DESC LIMIT 100").map(out) }; });
  r.patch("/api/admin/problems/:id", async (req, res, p) => {
    needAdmin(req); const b = await readJson(req);
    const d = db.get("SELECT * FROM disputes WHERE id=?", Number(p.id));
    if (!d) throw new HttpError(404, "not_found", "Problem not found");
    if (!["resolved", "rejected", "open"].includes(b.status)) throw bad("bad_status", "resolved, rejected or open");
    const res2 = str(b.resolution, 1000);
    db.run("UPDATE disputes SET status=?, resolution=?, updated_at=? WHERE id=?", b.status, res2 || d.resolution, Date.now(), d.id);
    audit(req, "dispute." + b.status, d.id, { resolution: res2 });
    const o = db.get("SELECT num FROM orders WHERE id=?", d.order_id), st = db.get("SELECT * FROM stores WHERE id=?", d.store_id);
    const msg = `Жалоба по заказу ${h(o.num)}: ${STATUS_RU[b.status]}.${res2 ? `\nРешение модератора: «${h(res2)}»` : ""}`;
    tell(d.user_id, msg, `${cfg.siteUrl}#orders`); tell(st?.owner_id, msg, `${cfg.siteUrl}#seller`);
    return { problem: out(db.get(q + " WHERE d.id=?", d.id)) };
  });
}

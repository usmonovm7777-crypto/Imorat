import { HttpError, bad, readJson, str } from "./http.js";
import { escHtml as h } from "./telegram.js";

/* Support chat with the Imorat Go team. A signed-in person writes from any page; everyone who runs the place
   (owner and helpers) sees the threads in the panel and answers; the person hears the answer in Telegram / push
   and sees it in the chat. One thread per person; messages are plain text, at most 1000 characters. */
export const SUPPORT_TOPICS = ["order", "cancel", "payment", "delivery", "seller", "other"];
export function registerSupport({ r, db, cfg, need, needAdmin, lim, tg, push, notify, log }) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS support_msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, staff_id TEXT, text TEXT NOT NULL, topic TEXT, order_num TEXT, created_at INTEGER NOT NULL, seen_user INTEGER NOT NULL DEFAULT 0, seen_staff INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS support_msgs_u ON support_msgs(user_id, id);`);
  const safe = p => Promise.resolve(p).catch(e => log.warn("[support]", e.message));
  const out = m => ({ id: m.id, from: m.staff_id ? "staff" : "user", text: m.text, topic: m.topic, order: m.order_num, at: m.created_at, staff_name: m.staff_id ? (m.sname || "Imorat Go") : null });
  const thread = uid => db.all("SELECT m.*, s.name sname FROM support_msgs m LEFT JOIN users s ON s.id=m.staff_id WHERE m.user_id=? ORDER BY m.id DESC LIMIT 200", uid).reverse().map(out);
  const text = b => { const t = str(b?.text, 1000); if (t.length < 2) throw bad("bad_text", "Write a message"); return t; };

  /* the person's own thread; opening it marks the team's answers as read */
  r.get("/api/support", req => {
    const u = need(req);
    const unread = db.get("SELECT COUNT(*) n FROM support_msgs WHERE user_id=? AND staff_id IS NOT NULL AND seen_user=0", u.id).n;
    if (new URL(req.url, "http://x").searchParams.get("peek") !== "1") db.run("UPDATE support_msgs SET seen_user=1 WHERE user_id=? AND staff_id IS NOT NULL AND seen_user=0", u.id);
    return { messages: thread(u.id), unread };
  });
  r.post("/api/support", async req => {
    const u = need(req), b = await readJson(req);
    lim.hit("sup:" + u.id, 20, 3600_000);
    const t = text(b), topic = SUPPORT_TOPICS.includes(b.topic) ? b.topic : null;
    const num = typeof b.order === "string" && /^IM-\d{4,8}$/.test(b.order) && db.get("SELECT 1 FROM orders WHERE num=? AND user_id=?", b.order, u.id) ? b.order : null;
    const first = !db.get("SELECT 1 FROM support_msgs WHERE user_id=? AND created_at>?", u.id, Date.now() - 30 * 60000);
    db.run("INSERT INTO support_msgs(user_id,text,topic,order_num,created_at,seen_user) VALUES(?,?,?,?,?,1)", u.id, t, topic, num, Date.now());
    // the team hears every message of a new conversation and then at most one alert every 30 minutes per person
    if (first) notify.admins(`💬 <b>Поддержка</b> · ${h(u.name || "без имени")}${u.phone ? " · +" + h(u.phone) : ""}${num ? " · заказ " + h(num) : ""}\n«${h(t.slice(0, 400))}»\nОтветить: ${cfg.siteUrl}#admin`);
    return { messages: thread(u.id) };
  });

  /* ---- the team ---- */
  r.get("/api/admin/support", req => {
    needAdmin(req);
    const rows = db.all(`SELECT m.user_id, MAX(m.id) last_id, SUM(m.staff_id IS NULL AND m.seen_staff=0) unread, u.name, u.phone FROM support_msgs m LEFT JOIN users u ON u.id=m.user_id GROUP BY m.user_id ORDER BY unread>0 DESC, last_id DESC LIMIT 100`);
    return { threads: rows.map(x => { const l = db.get("SELECT * FROM support_msgs WHERE id=?", x.last_id); return { user: x.user_id, name: x.name || "", phone: x.phone || "", unread: x.unread || 0, last: { text: l.text.slice(0, 160), from: l.staff_id ? "staff" : "user", at: l.created_at } }; }) };
  });
  r.get("/api/admin/support/:uid", (req, res, p) => {
    needAdmin(req);
    const u = db.get("SELECT id, name, phone, created_at FROM users WHERE id=?", p.uid); if (!u) throw new HttpError(404, "not_found", "No such person");
    db.run("UPDATE support_msgs SET seen_staff=1 WHERE user_id=? AND staff_id IS NULL AND seen_staff=0", u.id);
    const orders = db.all("SELECT num, status, created_at, total FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 5", u.id);
    return { user: { id: u.id, name: u.name || "", phone: u.phone || "", since: u.created_at }, orders, messages: thread(u.id) };
  });
  r.post("/api/admin/support/:uid", async (req, res, p) => {
    const a = needAdmin(req), b = await readJson(req);
    const u = db.get("SELECT * FROM users WHERE id=?", p.uid); if (!u) throw new HttpError(404, "not_found", "No such person");
    if (!db.get("SELECT 1 FROM support_msgs WHERE user_id=?", u.id)) throw new HttpError(409, "no_thread", "This person has not written to support");
    const t = text(b);
    db.run("INSERT INTO support_msgs(user_id,staff_id,text,created_at,seen_staff) VALUES(?,?,?,?,1)", u.id, a.id, t, Date.now());
    db.run("UPDATE support_msgs SET seen_staff=1 WHERE user_id=? AND staff_id IS NULL", u.id);
    const msg = `💬 Поддержка Imorat Go:\n${t}\n\nОтветить можно на сайте: ${cfg.siteUrl}#support`;
    if (u.tg_chat) safe(tg.send(u.tg_chat, h(msg)));
    safe(push.toUser(u.id, { title: "Поддержка Imorat Go", body: t.slice(0, 140), url: `${cfg.siteUrl}#support`, tag: "support" }));
    return { messages: thread(u.id) };
  });
}

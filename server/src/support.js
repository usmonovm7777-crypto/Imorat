import { HttpError, bad, readJson, str } from "./http.js";
import { escHtml as h } from "./telegram.js";
import { createHash } from "node:crypto";

/* Support chat with the Quriliş Go team. A signed-in person writes from any page; everyone who runs the place
   (owner and helpers) sees the threads in the panel and answers; the person hears the answer in Telegram / push
   and sees it in the chat. One thread per person; messages are plain text, at most 1000 characters. */
export const SUPPORT_TOPICS = ["order", "cancel", "payment", "delivery", "seller", "other"];
export function registerSupport({ r, db, cfg, need, needAdmin, lim, tg, push, notify, log }) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS support_guests(id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS support_msgs(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, staff_id TEXT, text TEXT NOT NULL, topic TEXT, order_num TEXT, created_at INTEGER NOT NULL, seen_user INTEGER NOT NULL DEFAULT 0, seen_staff INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS support_msgs_u ON support_msgs(user_id, id);`);
  const safe = p => Promise.resolve(p).catch(e => log.warn("[support]", e.message));
  const out = m => ({ id: m.id, from: m.staff_id ? "staff" : "user", text: m.text, topic: m.topic, order: m.order_num, at: m.created_at, staff_name: m.staff_id ? (m.sname || "Quriliş Go") : null });
  const thread = uid => db.all("SELECT m.*, s.name sname FROM support_msgs m LEFT JOIN users s ON s.id=m.staff_id WHERE m.user_id=? ORDER BY m.id DESC LIMIT 200", uid).reverse().map(out);
  /* a visitor without an account writes too: the page keeps a random key, the server keeps only its hash as the thread id */
  const guestId = tok => typeof tok === "string" && /^[A-Za-z0-9_-]{24,64}$/.test(tok) ? "g_" + createHash("sha256").update(tok).digest("hex").slice(0, 32) : null;
  const staffUsers = () => db.all(`SELECT u.id FROM users u LEFT JOIN staff s ON s.user_id=u.id WHERE u.phone IN (${cfg.admins.map(() => "?").join(",") || "''"}) OR (s.user_id IS NOT NULL AND s.disabled=0)`, ...cfg.admins);
  const alertTeam = (who, num, t) => {
    notify.admins(`💬 <b>Поддержка</b> · ${h(who)}${num ? " · заказ " + h(num) : ""}\n«${h(t.slice(0, 400))}»\nОтветить: ${cfg.siteUrl}#admin`);
    for (const a of staffUsers()) safe(push.toUser(a.id, { title: "💬 Поддержка: " + who, body: t.slice(0, 140), url: `${cfg.siteUrl}#admin`, tag: "support-team" }));
  };
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
    const num = typeof b.order === "string" && /^(QG|IM)-\d{4,8}$/.test(b.order) && db.get("SELECT 1 FROM orders WHERE num=? AND user_id=?", b.order, u.id) ? b.order : null;
    const first = !db.get("SELECT 1 FROM support_msgs WHERE user_id=? AND created_at>?", u.id, Date.now() - 30 * 60000);
    db.run("INSERT INTO support_msgs(user_id,text,topic,order_num,created_at,seen_user) VALUES(?,?,?,?,?,1)", u.id, t, topic, num, Date.now());
    // the team hears every message of a new conversation and then at most one alert every 30 minutes per person
    if (first) alertTeam(`${u.name || "без имени"}${u.phone ? " · +" + u.phone : ""}`, num, t);
    return { messages: thread(u.id) };
  });
  /* the visitor's side without an account: read (POST so the key never sits in a URL) and write */
  r.post("/api/support/guest", async req => {
    const b = await readJson(req), id = guestId(b.guest); if (!id) throw bad("bad_guest", "Bad chat key");
    const unread = db.get("SELECT COUNT(*) n FROM support_msgs WHERE user_id=? AND staff_id IS NOT NULL AND seen_user=0", id).n;
    if (b.peek !== true) db.run("UPDATE support_msgs SET seen_user=1 WHERE user_id=? AND staff_id IS NOT NULL AND seen_user=0", id);
    return { messages: thread(id), unread };
  });
  r.post("/api/support/guest/send", async req => {
    const b = await readJson(req), id = guestId(b.guest); if (!id) throw bad("bad_guest", "Bad chat key");
    lim.hit("supg-ip:" + req.ip, 30, 3600_000); lim.hit("supg:" + id, 20, 3600_000);
    const t = text(b), g = db.get("SELECT * FROM support_guests WHERE id=?", id);
    const name = str(b.name, 60), phone = String(b.phone || "").replace(/\D/g, "").slice(-12);
    if (!g) { if (name.length < 2) throw bad("bad_name", "Your name"); if (phone.length < 9) throw bad("bad_phone", "A phone number to call you back"); db.run("INSERT INTO support_guests(id,name,phone,created_at) VALUES(?,?,?,?)", id, name, phone.length === 9 ? "998" + phone : phone, Date.now()); }
    const gg = db.get("SELECT * FROM support_guests WHERE id=?", id);
    const first = !db.get("SELECT 1 FROM support_msgs WHERE user_id=? AND created_at>?", id, Date.now() - 30 * 60000);
    db.run("INSERT INTO support_msgs(user_id,text,topic,created_at,seen_user) VALUES(?,?,?,?,1)", id, t, SUPPORT_TOPICS.includes(b.topic) ? b.topic : null, Date.now());
    if (first) alertTeam(`${gg.name} (без входа) · +${gg.phone}`, null, t);
    return { messages: thread(id) };
  });

  /* ---- the team ---- */
  r.get("/api/admin/support", req => {
    needAdmin(req);
    const rows = db.all(`SELECT m.user_id, MAX(m.id) last_id, SUM(m.staff_id IS NULL AND m.seen_staff=0) unread, COALESCE(u.name, g.name) name, COALESCE(u.phone, g.phone) phone, g.id gid FROM support_msgs m LEFT JOIN users u ON u.id=m.user_id LEFT JOIN support_guests g ON g.id=m.user_id GROUP BY m.user_id ORDER BY unread>0 DESC, last_id DESC LIMIT 100`);
    return { threads: rows.map(x => { const l = db.get("SELECT * FROM support_msgs WHERE id=?", x.last_id); return { user: x.user_id, name: x.name || "", phone: x.phone || "", guest: !!x.gid, unread: x.unread || 0, last: { text: l.text.slice(0, 160), from: l.staff_id ? "staff" : "user", at: l.created_at } }; }) };
  });
  r.get("/api/admin/support/:uid", (req, res, p) => {
    needAdmin(req);
    const u = db.get("SELECT id, name, phone, created_at FROM users WHERE id=?", p.uid) || db.get("SELECT id, name, phone, created_at, 1 guest FROM support_guests WHERE id=?", p.uid); if (!u) throw new HttpError(404, "not_found", "No such person");
    db.run("UPDATE support_msgs SET seen_staff=1 WHERE user_id=? AND staff_id IS NULL AND seen_staff=0", u.id);
    const orders = db.all("SELECT num, status, created_at, total FROM orders WHERE user_id=? ORDER BY id DESC LIMIT 5", u.id);
    return { user: { id: u.id, name: u.name || "", phone: u.phone || "", since: u.created_at, guest: !!u.guest }, orders, messages: thread(u.id) };
  });
  r.post("/api/admin/support/:uid", async (req, res, p) => {
    const a = needAdmin(req), b = await readJson(req);
    const u = db.get("SELECT * FROM users WHERE id=?", p.uid) || db.get("SELECT id, name, phone FROM support_guests WHERE id=?", p.uid); if (!u) throw new HttpError(404, "not_found", "No such person");
    if (!db.get("SELECT 1 FROM support_msgs WHERE user_id=?", u.id)) throw new HttpError(409, "no_thread", "This person has not written to support");
    const t = text(b);
    db.run("INSERT INTO support_msgs(user_id,staff_id,text,created_at,seen_staff) VALUES(?,?,?,?,1)", u.id, a.id, t, Date.now());
    db.run("UPDATE support_msgs SET seen_staff=1 WHERE user_id=? AND staff_id IS NULL", u.id);
    const msg = `💬 Поддержка Quriliş Go:\n${t}\n\nОтветить можно на сайте: ${cfg.siteUrl}#support`;
    if (u.tg_chat) safe(tg.send(u.tg_chat, h(msg)));
    if (!String(u.id).startsWith("g_")) safe(push.toUser(u.id, { title: "Поддержка Quriliş Go", body: t.slice(0, 140), url: `${cfg.siteUrl}#support`, tag: "support" }));
    return { messages: thread(u.id) };
  });
}

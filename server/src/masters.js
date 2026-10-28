import { HttpError, bad, readJson, int, str } from "./http.js";
import { escHtml as h } from "./telegram.js";

/* Masters (tilers, electricians, plumbers…): public profiles approved by a moderator,
   requests from buyers, and reviews after the job is done. The master's phone is shown to the
   buyer only after the master accepts the request; the buyer's phone goes to the master with the request. */
export const SPECS = ["tile", "elec", "plumb", "paint", "floor", "drywall", "weld", "roof", "furn", "ac", "door"];
export const PRICE_UNITS = ["job", "m2", "hour", "day", "pt"];
const REQ_MOVES = { master: { new: ["accepted", "declined"], accepted: ["done"] }, buyer: { new: ["cancelled"], accepted: ["cancelled"] } };

export function registerMasters({ r, db, cfg, ref, need, needAdmin, audit, lim, tg, push, sms, log }) {
  const D = new Set(ref.districts.map(d => d.id));
  const safe = p => Promise.resolve(p).catch(e => log.warn("[masters]", e.message));
  const stats = () => Object.fromEntries(db.all(`SELECT master_id, AVG(stars) a, COUNT(stars) n, SUM(status='done') done FROM master_requests GROUP BY master_id`)
    .map(x => [x.master_id, { stars: x.n ? Math.round(x.a * 10) / 10 : null, reviews: x.n || 0, done: x.done || 0 }]));
  const pub = (m, st = {}) => ({ id: m.id, name: m.name, specs: JSON.parse(m.specs), districts: JSON.parse(m.districts), exp: m.exp, price: m.price, price_unit: m.price_unit, about: m.about,
    status: m.status, note: m.note, created: m.created_at, busy: !!m.busy, stars: st.stars ?? null, reviews: st.reviews || 0, done: st.done || 0 });
  const mine = u => db.get("SELECT * FROM masters WHERE user_id=?", u.id);
  const firstName = n => String(n || "").split(" ")[0];
  const digits = v => String(v || "").replace(/\D/g, "");
  const lang = u => (u?.lang === "uz" ? "uz" : "ru");
  const T = (u, ru, uz) => (lang(u) === "uz" ? uz : ru);
  /* the master's message about a request, with buttons that work right inside Telegram */
  function masterCard(q) {
    const dn = ref.districts.find(d => d.id === q.district);
    const st = { new: "🆕 Новая заявка · Yangi ariza", accepted: "✅ Вы приняли · Qabul qildingiz", declined: "❌ Отказались · Rad etildi", done: "🏁 Выполнено · Bajarildi", cancelled: "🚫 Клиент отменил · Mijoz bekor qildi" }[q.status] || q.status;
    const text = `🧰 <b>${st}</b> · №${q.id}\n\n${h(q.text)}\n\n🕒 ${h(q.when_txt)}${dn ? `\n📍 ${h(dn.ru)} р-н${q.street ? ", " + h(q.street) : ""}` : ""}\n👤 ${h(q.name || "")}${["new", "accepted", "done"].includes(q.status) ? `, +${h(digits(q.phone))}` : ""}${q.stars ? `\n${"⭐".repeat(q.stars)}${q.review ? " «" + h(q.review) + "»" : ""}` : ""}`;
    const buttons = q.status === "new" ? [[{ text: "✅ Принять · Qabul qilish", callback_data: `mr:acc:${q.id}` }], [{ text: "❌ Не смогу · Ololmayman", callback_data: `mr:dec:${q.id}` }]]
      : q.status === "accepted" ? [[{ text: "🏁 Работа выполнена · Ish bajarildi", callback_data: `mr:done:${q.id}` }]] : [];
    return { text, buttons };
  }
  function createRequest(u, m, { text, when, district, street }) {
    const now = Date.now();
    const id = Number(db.run("INSERT INTO master_requests(master_id,user_id,text,when_txt,district,street,phone,name,status,created_at,status_at) VALUES(?,?,?,?,?,?,?,?,'new',?,?)",
      m.id, u.id, text, when, district, street, u.phone, u.name || "", now, now).lastInsertRowid);
    const owner = db.get("SELECT * FROM users WHERE id=?", m.user_id);
    if (owner?.tg_chat) { const c = masterCard(db.get("SELECT * FROM master_requests WHERE id=?", id)); safe(tg.send(owner.tg_chat, c.text + "\n\nПримите заявку — клиент увидит ваш номер. · Qabul qiling — mijoz raqamingizni ko‘radi.", c.buttons)); }
    if (owner) safe(push.toUser(owner.id, { title: "Новая заявка мастеру", body: text.slice(0, 120), url: `${cfg.siteUrl}#masters`, tag: "mreq-" + id }));
    if (m.phone && cfg.smsMasterTemplate) safe(sms.sendText(m.phone, cfg.smsMasterTemplate));
    return id;
  }
  /* status change by the master (accepted / declined / done) or the buyer (cancelled); the other side is told */
  function moveRequest(q, role, status) {
    db.run("UPDATE master_requests SET status=?, status_at=? WHERE id=?", status, Date.now(), q.id);
    if (role === "master") {
      const buyer = db.get("SELECT * FROM users WHERE id=?", q.user_id);
      const text = status === "accepted" ? T(buyer, `✅ Мастер ${q.mname} принял вашу заявку. Телефон мастера: +${digits(q.mphone)}`, `✅ Usta ${q.mname} arizangizni qabul qildi. Usta telefoni: +${digits(q.mphone)}`)
        : status === "declined" ? T(buyer, `Мастер ${q.mname} не сможет взяться за заявку. Выберите другого мастера — /masters`, `Usta ${q.mname} bu ishni ololmaydi. Boshqa ustani tanlang — /masters`)
        : T(buyer, `🏁 Мастер ${q.mname} отметил работу выполненной. Как всё прошло? Оценка поможет другим людям.`, `🏁 Usta ${q.mname} ishni bajarilgan deb belgiladi. Qanday o‘tdi? Bahoyingiz boshqalarga yordam beradi.`);
      const rate = status === "done" ? [[1, 2, 3, 4, 5].map(n => ({ text: `${n} ⭐`, callback_data: `rv:${q.id}:${n}` }))] : null;
      if (buyer?.tg_chat) safe(tg.send(buyer.tg_chat, h(text), rate));
      if (buyer) safe(push.toUser(buyer.id, { title: "Imorat Go · мастер", body: text, url: `${cfg.siteUrl}#masters`, tag: "mreq-" + q.id }));
    } else {
      const owner = db.get("SELECT tg_chat FROM users WHERE id=?", q.muid);
      if (owner?.tg_chat) safe(tg.send(owner.tg_chat, `🚫 Клиент отменил заявку №${q.id} · Mijoz arizani bekor qildi`));
    }
  }
  function reviewed(id) {
    const q = db.get("SELECT q.*, m.user_id muid FROM master_requests q JOIN masters m ON m.id=q.master_id WHERE q.id=?", id);
    const owner = q && db.get("SELECT tg_chat FROM users WHERE id=?", q.muid);
    if (owner?.tg_chat) safe(tg.send(owner.tg_chat, `${"⭐".repeat(q.stars)} Новая оценка по заявке №${q.id} · Yangi baho${q.review ? `\n«${h(q.review)}»` : ""}`));
  }

  r.get("/api/masters", (req, res, p, url) => {
    const st = stats(), spec = url.searchParams.get("spec"), district = url.searchParams.get("district");
    let list = db.all("SELECT * FROM masters WHERE status='active' AND busy=0 ORDER BY created_at DESC").map(m => pub(m, st[m.id]));
    if (spec) list = list.filter(m => m.specs.includes(spec));
    if (district) list = list.filter(m => m.districts.includes(district));
    return { masters: list.map(({ note, status, ...m }) => m) };
  });
  r.get("/api/masters/me", req => {
    const u = need(req), m = mine(u);
    if (!m) return { master: null, requests: [] };
    const requests = db.all("SELECT * FROM master_requests WHERE master_id=? ORDER BY id DESC LIMIT 100", m.id)
      .map(x => ({ id: x.id, text: x.text, when: x.when_txt, district: x.district, street: x.street, phone: x.phone, name: x.name, status: x.status, stars: x.stars, review: x.review, created: x.created_at }));
    return { master: pub(m, stats()[m.id]), requests };
  });
  r.get("/api/masters/:id", (req, res, p) => {
    const m = db.get("SELECT * FROM masters WHERE id=? AND status='active'", p.id);
    if (!m) throw new HttpError(404, "not_found", "Master not found");
    const reviews = db.all("SELECT q.stars, q.review, q.status_at, u.name FROM master_requests q LEFT JOIN users u ON u.id=q.user_id WHERE q.master_id=? AND q.stars IS NOT NULL ORDER BY q.status_at DESC LIMIT 30", m.id)
      .map(x => ({ stars: x.stars, text: x.review, t: x.status_at, name: firstName(x.name) }));
    const { note, ...out } = pub(m, stats()[m.id]);
    return { master: out, reviews };
  });
  r.post("/api/masters/me", async req => {
    const u = need(req), b = await readJson(req), old = mine(u);
    const name = str(b.name, 80) || u.name || "", specs = [...new Set((Array.isArray(b.specs) ? b.specs : []).filter(s => SPECS.includes(s)))].slice(0, 6);
    const districts = [...new Set((Array.isArray(b.districts) ? b.districts : []).filter(d => D.has(d)))];
    const exp = int(b.exp ?? 0, 0, 60), price = int(b.price ?? 0, 0, 1e9), unit = PRICE_UNITS.includes(b.price_unit) ? b.price_unit : "job", about = str(b.about, 1000);
    if (name.length < 2) throw bad("bad_name", "Enter your name");
    if (!specs.length) throw bad("bad_specs", "Choose at least one kind of work");
    if (!districts.length) throw bad("bad_districts", "Choose the districts where you work");
    if (exp === null || price === null) throw bad("bad_numbers", "Experience and price must be numbers");
    const now = Date.now();
    if (old) db.run("UPDATE masters SET name=?, specs=?, districts=?, exp=?, price=?, price_unit=?, about=?, updated_at=? WHERE id=?", name, JSON.stringify(specs), JSON.stringify(districts), exp, price, unit, about, now, old.id);
    else {
      lim.hit("master-new:" + u.id, 3, 86400_000);
      db.run("INSERT INTO masters(id,user_id,name,specs,districts,exp,price,price_unit,about,phone,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?)",
        "m" + now.toString(36), u.id, name, JSON.stringify(specs), JSON.stringify(districts), exp, price, unit, about, u.phone, now, now);
      audit(req, "master.new", u.id);
      for (const a of db.all(`SELECT tg_chat FROM users WHERE tg_chat IS NOT NULL AND phone IN (${cfg.admins.map(() => "?").join(",") || "''"})`, ...cfg.admins)) safe(tg.send(a.tg_chat, `🧰 Новая анкета мастера: <b>${h(name)}</b> (${specs.join(", ")}). Проверьте в кабинете модератора.`));
    }
    return { master: pub(mine(u), stats()[mine(u).id]) };
  });
  r.post("/api/masters/:id/requests", async (req, res, p) => {
    const u = need(req), b = await readJson(req);
    const m = db.get("SELECT * FROM masters WHERE id=? AND status='active'", p.id);
    if (!m) throw new HttpError(404, "not_found", "Master not found");
    if (m.user_id === u.id) throw bad("own_profile", "You cannot send a request to yourself");
    lim.hit("mreq:" + u.id, 10, 86400_000);
    const text = str(b.text, 1000), when = str(b.when, 80) || "как можно скорее", district = D.has(b.district) ? b.district : null, street = str(b.street, 200);
    if (text.length < 5) throw bad("bad_text", "Describe the job in a few words");
    if (!u.phone) throw bad("phone_required", "Add a phone number so the master can call you");
    const id = createRequest(u, m, { text, when, district, street });
    return { request: { id, status: "new" } };
  });
  r.get("/api/me/master-requests", req => {
    const u = need(req);
    return { requests: db.all("SELECT q.*, m.name mname, m.phone mphone, m.specs FROM master_requests q JOIN masters m ON m.id=q.master_id WHERE q.user_id=? ORDER BY q.id DESC LIMIT 50", u.id)
      .map(x => ({ id: x.id, master_id: x.master_id, master: x.mname, specs: JSON.parse(x.specs), phone: ["accepted", "done"].includes(x.status) ? x.mphone : null, text: x.text, when: x.when_txt, status: x.status, stars: x.stars, review: x.review, created: x.created_at })) };
  });
  r.patch("/api/masters/requests/:id", async (req, res, p) => {
    const u = need(req), b = await readJson(req);
    const q = db.get("SELECT q.*, m.user_id muid, m.name mname, m.phone mphone FROM master_requests q JOIN masters m ON m.id=q.master_id WHERE q.id=?", Number(p.id));
    if (!q) throw new HttpError(404, "not_found", "Request not found");
    const role = q.muid === u.id ? "master" : q.user_id === u.id ? "buyer" : null;
    if (!role) throw new HttpError(403, "forbidden", "Not your request");
    if (!(REQ_MOVES[role][q.status] || []).includes(b.status)) throw new HttpError(409, "bad_move", `Cannot change status from ${q.status} to ${b.status}`);
    moveRequest(q, role, b.status);
    return { request: { id: q.id, status: b.status } };
  });
  r.post("/api/masters/requests/:id/review", async (req, res, p) => {
    const u = need(req), b = await readJson(req);
    const q = db.get("SELECT * FROM master_requests WHERE id=? AND user_id=?", Number(p.id), u.id);
    if (!q) throw new HttpError(404, "not_found", "Request not found");
    if (q.status !== "done") throw new HttpError(409, "not_done", "You can review after the job is done");
    if (q.stars) throw new HttpError(409, "already_reviewed", "You have already reviewed this job");
    const stars = int(b.stars, 1, 5); if (!stars) throw bad("bad_stars", "Stars from 1 to 5");
    db.run("UPDATE master_requests SET stars=?, review=? WHERE id=?", stars, str(b.text, 1000), q.id);
    reviewed(q.id);
    return { ok: true };
  });
  r.get("/api/admin/masters", req => {
    needAdmin(req); const st = stats();
    return { masters: db.all("SELECT m.*, u.phone uphone FROM masters m LEFT JOIN users u ON u.id=m.user_id ORDER BY m.status='pending' DESC, m.created_at DESC").map(m => ({ ...pub(m, st[m.id]), phone: m.phone || m.uphone })) };
  });
  r.patch("/api/admin/masters/:id", async (req, res, p) => {
    needAdmin(req); const b = await readJson(req);
    const m = db.get("SELECT * FROM masters WHERE id=?", p.id); if (!m) throw new HttpError(404, "not_found", "Master not found");
    if (!["active", "pending", "rejected", "blocked"].includes(b.status)) throw bad("bad_status", "Unknown status");
    db.run("UPDATE masters SET status=?, note=? WHERE id=?", b.status, b.note != null ? str(b.note, 300) : m.note, m.id);
    audit(req, "master." + b.status, m.id, { note: b.note });
    const ow = db.get("SELECT tg_chat FROM users WHERE id=?", m.user_id);
    if (ow?.tg_chat) safe(tg.send(ow.tg_chat, b.status === "active" ? `🎉 Ваша анкета мастера одобрена — клиенты видят её в разделе «Мастера» на Imorat Go.` : `Статус анкеты мастера: ${b.status}.${b.note ? " " + h(str(b.note, 300)) : ""}`));
    return { master: pub(db.get("SELECT * FROM masters WHERE id=?", m.id)) };
  });
  return { createRequest, moveRequest, reviewed, masterCard, REQ_MOVES, stats, pub };
}

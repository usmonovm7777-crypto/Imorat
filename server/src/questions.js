import { HttpError, bad, readJson, str, int } from "./http.js";
import { escHtml as h } from "./telegram.js";

/* Questions to a store ("is this colour in stock?"). The store answers in the cabinet;
   the buyer gets the answer in Telegram / push, and answered questions are shown on the store page. */
export function registerQuestions({ r, db, cfg, need, needSeller, lim, tg, push, log }) {
  const safe = p => Promise.resolve(p).catch(e => log.warn("[questions]", e.message));
  const row = x => ({ id: x.id, store: x.store_id, product_id: x.product_id, product: x.pru || null, text: x.text, answer: x.answer, created: x.created_at, answered: x.answered_at, name: (x.uname || "").split(" ")[0] });
  const q = "SELECT x.*, p.ru pru, u.name uname, u.phone uphone FROM store_questions x LEFT JOIN products p ON p.id=x.product_id LEFT JOIN users u ON u.id=x.user_id";
  r.post("/api/stores/:id/questions", async (req, res, p) => {
    const u = need(req), b = await readJson(req);
    lim.hit("sq:" + u.id, 10, 86400_000);
    const s = db.get("SELECT * FROM stores WHERE id=? AND status='active'", p.id);
    if (!s) throw new HttpError(404, "not_found", "Store not found");
    const text = str(b.text, 800); if (text.length < 4) throw bad("bad_text", "Write your question");
    const pid = b.product_id ? int(b.product_id, 1, 1e9) : null;
    if (pid && !db.get("SELECT 1 FROM offers WHERE product_id=? AND store_id=?", pid, s.id)) throw bad("bad_product", "The store does not sell this product");
    const now = Date.now();
    const id = Number(db.run("INSERT INTO store_questions(store_id,product_id,user_id,text,created_at) VALUES(?,?,?,?,?)", s.id, pid, u.id, text, now).lastInsertRowid);
    const owner = s.owner_id && db.get("SELECT * FROM users WHERE id=?", s.owner_id), pr = pid && db.get("SELECT ru FROM products WHERE id=?", pid);
    if (owner?.tg_chat) safe(tg.send(owner.tg_chat, `❓ <b>Вопрос покупателя</b>${pr ? ` о товаре «${h(pr.ru)}»` : ""}\n«${h(text)}»\n\nОтветьте в кабинете продавца — ответ увидят все покупатели.`));
    if (owner) safe(push.toUser(owner.id, { title: "Вопрос покупателя", body: text.slice(0, 140), url: `${cfg.siteUrl}#seller`, tag: "sq-" + id }));
    return { question: row(db.get(q + " WHERE x.id=?", id)) };
  });
  r.get("/api/stores/:id/questions", (req, res, p) => ({ questions: db.all(q + " WHERE x.store_id=? AND x.answer IS NOT NULL ORDER BY x.answered_at DESC LIMIT 30", p.id).map(row) }));
  r.get("/api/me/questions", req => { const u = need(req); return { questions: db.all(q + " WHERE x.user_id=? ORDER BY x.id DESC LIMIT 50", u.id).map(row) }; });
  r.get("/api/seller/questions", req => { const { s } = needSeller(req); return { questions: db.all(q + " WHERE x.store_id=? ORDER BY x.answer IS NOT NULL, x.id DESC LIMIT 50", s.id).map(x => ({ ...row(x), phone: x.uphone })) }; });
  r.post("/api/seller/questions/:id/answer", async (req, res, p) => {
    const { s } = needSeller(req), b = await readJson(req);
    const x = db.get("SELECT * FROM store_questions WHERE id=? AND store_id=?", Number(p.id), s.id);
    if (!x) throw new HttpError(404, "not_found", "Question not found");
    const text = str(b.text, 800); if (text.length < 1) throw bad("bad_text", "Write the answer");
    db.run("UPDATE store_questions SET answer=?, answered_at=? WHERE id=?", text, Date.now(), x.id);
    const u = db.get("SELECT * FROM users WHERE id=?", x.user_id);
    const msg = `Магазин «${s.name}» ответил на ваш вопрос:\n«${x.text}»\n→ ${text}`;
    if (u?.tg_chat) safe(tg.send(u.tg_chat, h(msg)));
    if (u) safe(push.toUser(u.id, { title: s.name, body: text.slice(0, 140), url: `${cfg.siteUrl}#store-${s.id}`, tag: "sq-" + x.id }));
    return { question: row(db.get(q + " WHERE x.id=?", x.id)) };
  });
}

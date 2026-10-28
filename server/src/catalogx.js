import { HttpError, bad, readJson, readBody, str, int } from "./http.js";
import { escHtml as h } from "./telegram.js";

/* Back-in-stock alerts and product reviews with a photo (only from buyers who received the product). */
export function registerCatalogExtras({ r, db, cfg, need, lim, tg, push, saveImage, mediaUrl, log }) {
  const safe = p => Promise.resolve(p).catch(e => log.warn("[catalogx]", e.message));
  /* ---- back in stock ---- */
  r.get("/api/me/stock-watch", req => { const u = need(req); return { ids: db.all("SELECT product_id FROM stock_watch WHERE user_id=?", u.id).map(x => x.product_id) }; });
  r.post("/api/products/:id/stock-watch", (req, res, p) => {
    const u = need(req), pid = int(p.id, 1, 1e9);
    if (!pid || !db.get("SELECT 1 FROM products WHERE id=? AND active=1", pid)) throw new HttpError(404, "not_found", "Product not found");
    lim.hit("sw:" + u.id, 60, 86400_000);
    db.run("INSERT OR IGNORE INTO stock_watch(user_id,product_id,created_at) VALUES(?,?,?)", u.id, pid, Date.now());
    return { ok: true };
  });
  r.del("/api/products/:id/stock-watch", (req, res, p) => { const u = need(req); db.run("DELETE FROM stock_watch WHERE user_id=? AND product_id=?", u.id, Number(p.id)); return { ok: true }; });
  function stockSweep() {
    const back = db.all(`SELECT DISTINCT w.product_id pid, p.ru FROM stock_watch w JOIN products p ON p.id=w.product_id
      JOIN offers o ON o.product_id=w.product_id JOIN stores s ON s.id=o.store_id AND s.status='active' WHERE o.stock>0 AND p.active=1`);
    for (const b of back) {
      const users = db.all("SELECT u.* FROM stock_watch w JOIN users u ON u.id=w.user_id WHERE w.product_id=?", b.pid);
      db.run("DELETE FROM stock_watch WHERE product_id=?", b.pid);
      for (const u of users) {
        const text = `✅ Снова в наличии: «${b.ru}». Успейте заказать на Imorat Go.`;
        if (u.tg_chat) safe(tg.send(u.tg_chat, h(text), [[{ text: "Открыть · Ochish", url: `${cfg.siteUrl}#p-${b.pid}` }]]));
        safe(push.toUser(u.id, { title: "Снова в наличии", body: b.ru, url: `${cfg.siteUrl}#p-${b.pid}`, tag: "stock-" + b.pid }));
      }
    }
    return back.length;
  }
  /* ---- reviews ---- */
  const bought = (uid, pid) => db.all(`SELECT sh.lines FROM shipments sh JOIN orders o ON o.id=sh.order_id WHERE o.user_id=? AND sh.status IN ('delivered','picked')`, uid)
    .some(s => JSON.parse(s.lines).some(l => l.id === pid));
  r.get("/api/products/:id/reviews", (req, res, p) => {
    const pid = Number(p.id), u = req.user;
    const list = db.all("SELECT r.*, u.name FROM product_reviews r LEFT JOIN users u ON u.id=r.user_id WHERE r.product_id=? ORDER BY r.created_at DESC LIMIT 50", pid)
      .map(x => ({ id: x.id, stars: x.stars, text: x.text, photo: x.photo ? mediaUrl(x.photo) : null, t: x.created_at, name: (x.name || "").split(" ")[0], mine: !!u && x.user_id === u.id }));
    const agg = db.get("SELECT AVG(stars) a, COUNT(*) n FROM product_reviews WHERE product_id=?", pid);
    return { reviews: list, stars: agg.n ? Math.round(agg.a * 10) / 10 : null, count: agg.n, can_review: !!u && !list.some(x => x.mine) && bought(u.id, pid) };
  });
  r.post("/api/products/:id/reviews", async (req, res, p) => {
    const u = need(req), b = await readJson(req), pid = Number(p.id);
    lim.hit("prv:" + u.id, 20, 86400_000);
    if (!bought(u.id, pid)) throw new HttpError(403, "not_bought", "You can review products you have received");
    const stars = int(b.stars, 1, 5); if (!stars) throw bad("bad_stars", "Stars from 1 to 5");
    if (db.get("SELECT 1 FROM product_reviews WHERE product_id=? AND user_id=?", pid, u.id)) throw new HttpError(409, "already_reviewed", "You have already reviewed this product");
    const id = Number(db.run("INSERT INTO product_reviews(product_id,user_id,stars,text,created_at) VALUES(?,?,?,?,?)", pid, u.id, stars, str(b.text, 1500), Date.now()).lastInsertRowid);
    return { review: { id } };
  });
  r.post("/api/product-reviews/:id/photo", async (req, res, p) => {
    const u = need(req), rv = db.get("SELECT * FROM product_reviews WHERE id=? AND user_id=?", Number(p.id), u.id);
    if (!rv) throw new HttpError(404, "not_found", "Review not found");
    const path = saveImage(await readBody(req, 5 * 1024 * 1024), "r" + rv.id);
    db.run("UPDATE product_reviews SET photo=? WHERE id=?", path, rv.id);
    return { photo: mediaUrl(path) };
  });
  return { stockSweep };
}

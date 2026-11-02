import { HttpError, bad, readJson, str } from "./http.js";
import { escHtml as h } from "./telegram.js";

/* Everything a store or a buyer publishes passes the team first:
   - a product a store creates (by hand or from a price list) waits as products.review='pending' — not in the catalogue,
     not orderable — until the owner or a helper approves it; a rejection carries a note back to the store;
   - the text and photo of a review wait as mod='pending' (stars from a real order count at once; the words appear after approval).
   The team gets one Telegram message per batch; the store hears the decision in Telegram and push. */
export function registerModeration({ r, db, cfg, needAdmin, tg, push, notify, bumpCatalog, mediaUrl, log, audit }) {
  const safe = p => Promise.resolve(p).catch(e => log.warn("[moderation]", e.message));
  const ownerOf = sid => { const s = db.get("SELECT * FROM stores WHERE id=?", sid); return { s, u: s?.owner_id && db.get("SELECT * FROM users WHERE id=?", s.owner_id) }; };
  /* called by the seller routes after products were created */
  function productsAdded(storeId, ids) {
    if (!ids.length) return;
    const { s } = ownerOf(storeId), names = db.all(`SELECT ru FROM products WHERE id IN (${ids.map(() => "?").join(",")}) LIMIT 5`, ...ids).map(x => "• " + h(x.ru)).join("\n");
    notify.admins(`🆕 <b>Новые товары на проверке</b> · ${h(s?.name || storeId)} · ${ids.length} шт.\n${names}${ids.length > 5 ? "\n…" : ""}\nПроверить: ${cfg.siteUrl}#admin`);
  }
  function reviewAdded(kind, id, text) {
    notify.admins(`💬 <b>Отзыв на проверке</b> (${kind === "store" ? "о магазине" : "о товаре"})\n«${h(String(text).slice(0, 300))}»\nПроверить: ${cfg.siteUrl}#admin`);
  }
  r.get("/api/admin/moderation", req => {
    needAdmin(req);
    const products = db.all(`SELECT p.id, p.ru, p.uz, p.cat, p.sub, p.unit, p.kg, p.img, p.descr, p.created_at, p.store_id, s.name store_name, o.price, o.stock
      FROM products p LEFT JOIN stores s ON s.id=p.store_id LEFT JOIN offers o ON o.product_id=p.id AND o.store_id=p.store_id WHERE p.review='pending' ORDER BY p.created_at LIMIT 200`)
      .map(x => ({ ...x, img: x.img ? mediaUrl(x.img) : "" }));
    const reviews = [
      ...db.all("SELECT r.id, r.stars, r.text, r.created_at, r.store_id, s.name target, u.name FROM reviews r LEFT JOIN stores s ON s.id=r.store_id LEFT JOIN users u ON u.id=r.user_id WHERE r.mod='pending' ORDER BY r.id LIMIT 100").map(x => ({ kind: "store", ...x })),
      ...db.all("SELECT r.id, r.stars, r.text, r.photo, r.created_at, p.ru target, u.name FROM product_reviews r LEFT JOIN products p ON p.id=r.product_id LEFT JOIN users u ON u.id=r.user_id WHERE r.mod='pending' ORDER BY r.id LIMIT 100").map(x => ({ kind: "product", ...x, photo: x.photo ? mediaUrl(x.photo) : null }))
    ].sort((a, b) => a.created_at - b.created_at);
    return { products, reviews };
  });
  r.post("/api/admin/products/:id/review", async (req, res, p) => {
    needAdmin(req); const b = await readJson(req);
    const pr = db.get("SELECT * FROM products WHERE id=?", Number(p.id)); if (!pr) throw new HttpError(404, "not_found", "Product not found");
    if (pr.review !== "pending") throw new HttpError(409, "already_decided", "This product was already checked");
    const ok = b.ok === true, note = str(b.note, 300);
    if (!ok && note.length < 3) throw bad("note_required", "Tell the store what to fix");
    db.run("UPDATE products SET review=?, review_note=? WHERE id=?", ok ? "ok" : "rejected", ok ? null : note, pr.id);
    audit(req, ok ? "product.approve" : "product.reject", String(pr.id), { note });
    if (ok) bumpCatalog();
    const { u } = ownerOf(pr.store_id);
    const text = ok ? `✅ Товар «${pr.ru}» прошёл проверку и виден покупателям на Quriliş Go.` : `❌ Товар «${pr.ru}» не прошёл проверку: ${note}\nИсправьте и добавьте заново в кабинете.`;
    if (u?.tg_chat) safe(tg.send(u.tg_chat, h(text)));
    if (u) safe(push.toUser(u.id, { title: ok ? "Товар одобрен" : "Товар не прошёл проверку", body: text.slice(0, 160), url: `${cfg.siteUrl}#seller`, tag: "prod-" + pr.id }));
    return { ok: true };
  });
  r.post("/api/admin/reviews/:kind/:id", async (req, res, p) => {
    needAdmin(req); const b = await readJson(req);
    const table = p.kind === "store" ? "reviews" : p.kind === "product" ? "product_reviews" : null; if (!table) throw new HttpError(404, "not_found", "Unknown kind");
    const rv = db.get(`SELECT * FROM ${table} WHERE id=?`, Number(p.id)); if (!rv) throw new HttpError(404, "not_found", "Review not found");
    db.run(`UPDATE ${table} SET mod=? WHERE id=?`, b.ok === true ? "ok" : "rejected", rv.id);
    audit(req, b.ok === true ? "review.approve" : "review.reject", p.kind + ":" + rv.id);
    return { ok: true };
  });
  return { productsAdded, reviewAdded };
}

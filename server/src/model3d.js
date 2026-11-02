import { HttpError, bad, readJson } from "./http.js";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync, copyFileSync } from "node:fs";
import { join, extname } from "node:path";

/* AI 3D model of a store's product, made from the seller's own photo.
   Provider: Stability AI image-to-3D (official docs: https://docs.stability.ai/api-reference/3d/stable-point-aware-3d and
   .../3d/stable-fast-3d): POST {url}/v2beta/3d/<endpoint>, multipart/form-data with the image, "authorization: Bearer <key>";
   the answer is the model itself (model/gltf-binary, synchronous). Failed generations are not charged.
   The key lives only in the server's .env (STABILITY_API_KEY); without it the feature reports that it is off — nothing is faked.
   States on the product: working → ready (the seller looks at it) → used (buyers see it, the card shows its still) | failed. */
export function registerModel3d({ r, db, cfg, needSeller, lim, mediaUrl, bumpCatalog, log }) {
  const M = cfg.model3d;
  const on = () => !!M.key;
  const running = new Set();
  const ERR = { 400: "bad_image", 402: "no_credits", 403: "moderated", 413: "too_big", 422: "bad_image", 429: "busy" };
  const dropFile = p => { if (typeof p === "string" && p.startsWith("/uploads/")) { try { unlinkSync(join(cfg.uploadsDir, p.slice(9).replace(/[^\w.-]/g, ""))); } catch {} } };
  const out = p => ({ state: p.m3d_state || null, url: p.m3d ? mediaUrl(p.m3d) : null, err: p.m3d_err || null, at: p.m3d_at || null });
  const IMG = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

  /* Starts a model for the product's current photo (the photo route calls it after every new photo). Returns at once;
     the result lands on the product. A second start for the same product while one runs is ignored. */
  function start(prod, storeId) {
    if (!on() || !prod?.img?.startsWith("/uploads/") || running.has(prod.id)) return false;
    lim.hit("m3d:" + storeId, M.perDay, 86400_000); // each model costs the owner money: a daily cap per store
    running.add(prod.id);
    const photo = prod.img, prev = prod.m3d ? prod.m3d_state : null; // a model made earlier for this same photo stays until a new one is ready
    db.run("UPDATE products SET m3d_state='working', m3d_err=NULL, m3d_at=? WHERE id=?", Date.now(), prod.id);
    (async () => {
      let err = "error", file = null;
      try {
        const name = photo.slice(9).replace(/[^\w.-]/g, ""), buf = readFileSync(join(cfg.uploadsDir, name));
        const fd = new FormData();
        fd.append("image", new Blob([buf], { type: IMG[extname(name)] || "image/jpeg" }), name);
        fd.append("texture_resolution", "1024");
        const res = await fetch(`${M.url}/v2beta/3d/${M.endpoint}`, { method: "POST", headers: { authorization: "Bearer " + M.key }, body: fd, signal: AbortSignal.timeout(M.timeoutMs) });
        const body = Buffer.from(await res.arrayBuffer());
        if (res.status === 200 && body.length > 20 && body.slice(0, 4).toString() === "glTF") {
          file = `/uploads/m${prod.id}-${randomBytes(5).toString("hex")}.glb`;
          writeFileSync(join(cfg.uploadsDir, file.slice(9)), body);
          err = null;
        } else { err = ERR[res.status] || "error"; log.warn(`[3d] product ${prod.id}: HTTP ${res.status} ${body.slice(0, 200).toString()}`); }
      } catch (e) { err = e.name === "TimeoutError" ? "timeout" : "error"; log.warn(`[3d] product ${prod.id}: ${e.message}`); }
      running.delete(prod.id);
      const now = db.get("SELECT img, m3d FROM products WHERE id=?", prod.id);
      if (!now || now.img !== photo) { if (file) dropFile(file); return; } // the photo changed meanwhile: this model is for the old one
      if (file) { dropFile(now.m3d); db.run("UPDATE products SET m3d=?, m3d_state='ready', m3d_err=NULL, m3d_at=? WHERE id=?", file, Date.now(), prod.id); }
      else if (now.m3d && prev && prev !== "working") db.run("UPDATE products SET m3d_state=?, m3d_err=?, m3d_at=? WHERE id=?", prev, err, Date.now(), prod.id); // the earlier model stays
      else db.run("UPDATE products SET m3d=NULL, m3d_state='failed', m3d_err=?, m3d_at=? WHERE id=?", err, Date.now(), prod.id);
      if (prev === "used") bumpCatalog();
    })();
    return true;
  }
  /* a new photo from the seller (not the still made from the model) makes the old model wrong: it goes, and a new one starts */
  function photoChanged(prod, storeId, fromModel) {
    if (fromModel) return;
    if (prod.m3d || prod.m3d_state) { dropFile(prod.m3d); db.run("UPDATE products SET m3d=NULL, m3d_state=NULL, m3d_err=NULL WHERE id=?", prod.id); if (prod.m3d_state === "used") bumpCatalog(); }
    const fresh = db.get("SELECT * FROM products WHERE id=?", prod.id);
    try { start(fresh, storeId); } catch (e) { if (e.status !== 429) throw e; db.run("UPDATE products SET m3d_state='failed', m3d_err='limit' WHERE id=?", prod.id); }
  }
  const own = (req, pid) => {
    const { s } = needSeller(req), prod = db.get("SELECT * FROM products WHERE id=?", Number(pid));
    if (!prod || prod.store_id !== s.id) throw new HttpError(403, "forbidden", "Only your own products");
    return { s, prod };
  };
  r.get("/api/seller/products/:pid/model3d", (req, res, p) => { const { prod } = own(req, p.pid); return { model3d: out(prod), enabled: on() }; });
  /* make (again) from the current photo */
  r.post("/api/seller/products/:pid/model3d", (req, res, p) => {
    const { s, prod } = own(req, p.pid);
    if (!on()) throw new HttpError(503, "model3d_off", "3D models are not connected on this server (STABILITY_API_KEY)");
    if (!prod.img?.startsWith("/uploads/")) throw bad("no_photo", "Upload a photo of the product first");
    if (!start(prod, s.id)) return { model3d: out(prod) };
    return { model3d: out(db.get("SELECT * FROM products WHERE id=?", prod.id)) };
  });
  /* the seller decides: show the model to buyers (the card then shows the still the seller's browser uploaded) or keep the photo */
  r.post("/api/seller/products/:pid/model3d/use", async (req, res, p) => {
    const { prod } = own(req, p.pid), b = await readJson(req);
    if (!prod.m3d || !["ready", "used"].includes(prod.m3d_state)) throw bad("no_model", "There is no finished model for this product");
    db.run("UPDATE products SET m3d_state=? WHERE id=?", b.use === false ? "ready" : "used", prod.id);
    bumpCatalog();
    return { model3d: out(db.get("SELECT * FROM products WHERE id=?", prod.id)) };
  });
  /* The library of finished looks: a product photographed (and modelled) once can be put up again at once — no new photo, no new
     paid model. It offers any store's product whose model buyers already see (approved), and the seller's own products with a photo. */
  const words = t => String(t || "").toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
  function lookSource(id, storeId) {
    const p = db.get("SELECT * FROM products WHERE id=?", Number(id));
    if (!p || !p.img?.startsWith("/uploads/")) return null;
    const shared = p.active && (!p.review || p.review === "ok") && p.m3d && p.m3d_state === "used";
    return p.store_id === storeId || shared ? p : null;
  }
  r.get("/api/seller/look-library", req => {
    const { s } = needSeller(req), q = words(new URL(req.url, "http://x").searchParams.get("q")).slice(0, 8);
    if (!q.length) return { items: [] };
    const rows = db.all(`SELECT p.id, p.ru, p.uz, p.img, p.m3d, p.m3d_state, p.store_id, st.name store_name FROM products p LEFT JOIN stores st ON st.id=p.store_id
      WHERE p.img LIKE '/uploads/%' AND (p.store_id=? OR (p.active=1 AND (p.review IS NULL OR p.review='ok') AND p.m3d IS NOT NULL AND p.m3d_state='used'))
      ORDER BY p.id DESC LIMIT 3000`, s.id);
    const items = rows.map(p => { const w = words(p.ru + " " + p.uz); return { p, sc: q.filter(t => w.some(x => x.startsWith(t))).length / q.length + (p.m3d_state === "used" ? 0.05 : 0) }; })
      .filter(x => x.sc >= 0.6).sort((a, b) => b.sc - a.sc).slice(0, 6)
      .map(({ p }) => ({ id: p.id, ru: p.ru, uz: p.uz, img: mediaUrl(p.img), m3d: p.m3d && ["ready", "used"].includes(p.m3d_state) ? mediaUrl(p.m3d) : null, own: p.store_id === s.id, store_name: p.store_id === s.id ? null : p.store_name }));
    return { items };
  });
  /* the new product gets its own copies of the files (the source may change its photo later), the model in the same state */
  function copyLook(src, pid) {
    const dup = (path, prefix) => { const name = path.slice(9).replace(/[^\w.-]/g, ""), to = `${prefix}-${randomBytes(5).toString("hex")}${extname(name)}`; copyFileSync(join(cfg.uploadsDir, name), join(cfg.uploadsDir, to)); return "/uploads/" + to; };
    const hasModel = !!src.m3d && ["ready", "used"].includes(src.m3d_state);
    const img = dup(src.img, "p" + pid), m3d = hasModel ? dup(src.m3d, "m" + pid) : null;
    db.run("UPDATE products SET img=?, m3d=?, m3d_state=?, m3d_err=NULL, m3d_at=? WHERE id=?", img, m3d, hasModel ? src.m3d_state : null, Date.now(), pid);
    bumpCatalog();
    return db.get("SELECT * FROM products WHERE id=?", pid);
  }
  return { start, photoChanged, out, on, lookSource, copyLook, catalogUrl: p => (p.m3d && p.m3d_state === "used" ? mediaUrl(p.m3d) : undefined) };
}

import { HttpError, bad, readJson, readBody } from "./http.js";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { writeFileSync, unlinkSync, copyFileSync, createReadStream, statSync } from "node:fs";
import { join, extname } from "node:path";

/* AI 3D model of a store's product from ONE photo — made by our own AI worker, no paid API.
   The worker (server/ai3d/worker.py) runs TripoSR (MIT, VAST-AI-Research/TripoSR) on any machine — the owner's MacBook (MPS/CPU)
   or a separate server — and PULLS jobs from this API over HTTPS with a secret token (MODEL3D_WORKER_TOKEN), so it needs no open
   ports and can be moved without touching the site. The heavy work never runs inside an HTTP request here.

   Job:      pending → processing → completed | failed   (table m3d_jobs; one active job per product; a stuck job goes back to the queue)
   Product:  m3d_state = pending | processing | completed (the seller checks it) | published (buyers see it) | failed;  m3d = the .glb
   The original photo is never touched. A model reaches buyers only after the seller presses «Сохранить 3D».
   Without a worker token the feature is off and says so; the site never pretends a model is being made.

   AI photo studio (kind 'cutout' on the same queue and worker): the worker only builds a MASK of the product (segmentation) and copies
   the photo's own pixels onto pure white (#FFFFFF) — nothing about the product is generated, recoloured or retouched. The result must be
   a lossless image (PNG or lossless WebP), so the product's pixels arrive unchanged. The original stays: products.img_orig keeps it
   while the white version is shown, «Вернуть оригинал» puts it back. A hand touching the product comes back as a warning. */
export function registerModel3d({ r, db, cfg, needSeller, lim, mediaUrl, bumpCatalog, log }) {
  const M = cfg.model3d;
  const on = () => !!M.workerToken;
  db.raw.exec(`CREATE TABLE IF NOT EXISTS m3d_jobs(id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, store_id TEXT NOT NULL, photo TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', err TEXT, attempts INTEGER NOT NULL DEFAULT 0, worker TEXT, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
    CREATE INDEX IF NOT EXISTS m3d_jobs_q ON m3d_jobs(status, id);`);
  if (!db.raw.prepare("PRAGMA table_info(m3d_jobs)").all().some(c => c.name === "kind")) db.raw.exec("ALTER TABLE m3d_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'm3d'");
  const KINDS = ["m3d", "cutout"];
  const srcPhoto = p => p.img_orig || p.img; // jobs always start from the seller's original photo
  let workerSeen = 0, workerName = "";
  const workerOnline = () => Date.now() - workerSeen < 90_000;
  const dropFile = p => { if (typeof p === "string" && p.startsWith("/uploads/")) { try { unlinkSync(join(cfg.uploadsDir, p.slice(9).replace(/[^\w.-]/g, ""))); } catch {} } };
  const activeJob = (pid, kind = "m3d") => db.get("SELECT * FROM m3d_jobs WHERE product_id=? AND kind=? AND status IN ('pending','processing') ORDER BY id DESC LIMIT 1", pid, kind);
  const queuePos = job => job && job.status === "pending" ? db.get("SELECT COUNT(*) n FROM m3d_jobs WHERE status='pending' AND id<=?", job.id).n : 0;
  const out = p => { const j = activeJob(p.id); return { state: p.m3d_state || null, url: p.m3d ? mediaUrl(p.m3d) : null, err: p.m3d_err || null, at: p.m3d_at || null, queue: queuePos(j), worker_online: workerOnline() }; };
  const setState = (pid, state, err = null) => db.run("UPDATE products SET m3d_state=?, m3d_err=?, m3d_at=? WHERE id=?", state, err, Date.now(), pid);
  const setCut = (pid, state, err = null) => db.run("UPDATE products SET cut_state=?, cut_err=?, cut_at=? WHERE id=?", state, err, Date.now(), pid);
  const setKind = (j, state, err = null) => (j.kind === "cutout" ? setCut : setState)(j.product_id, state, err);
  const outCut = p => { const j = activeJob(p.id, "cutout"); return { state: p.cut_state || null, url: p.cut_img ? mediaUrl(p.cut_img) : null, orig: srcPhoto(p) ? mediaUrl(srcPhoto(p)) : null, applied: p.cut_state === "applied", warn: p.cut_warn || null, err: p.cut_err || null, queue: queuePos(j), worker_online: workerOnline() }; };

  /* a processing job whose worker went quiet goes back to the queue (or fails after 3 tries) */
  function sweep() {
    const old = db.all("SELECT * FROM m3d_jobs WHERE status='processing' AND started_at < ?", Date.now() - M.jobTimeoutMs);
    for (const j of old) {
      if (j.attempts >= 3) { db.run("UPDATE m3d_jobs SET status='failed', err='timeout', finished_at=? WHERE id=?", Date.now(), j.id); setKind(j, "failed", "timeout"); }
      else { db.run("UPDATE m3d_jobs SET status='pending', worker=NULL WHERE id=?", j.id); setKind(j, "pending"); }
    }
    // temporary leftovers: finished jobs older than 30 days are forgotten
    db.run("DELETE FROM m3d_jobs WHERE status IN ('completed','failed','cancelled') AND finished_at < ?", Date.now() - 30 * 86400_000);
  }

  /* seller: queue a model for the current photo; the same product never has two jobs at once */
  function enqueue(prod, storeId, kind = "m3d") {
    if (!on()) throw new HttpError(503, "model3d_off", "The AI worker is not connected on this server (MODEL3D_WORKER_TOKEN)");
    const photo = srcPhoto(prod);
    if (!photo?.startsWith("/uploads/")) throw bad("no_photo", "Upload a photo of the product first");
    const act = activeJob(prod.id, kind);
    if (act && act.photo === photo) return act;
    if (act) db.run("UPDATE m3d_jobs SET status='cancelled', finished_at=? WHERE id=?", Date.now(), act.id);
    if (db.get("SELECT COUNT(*) n FROM m3d_jobs WHERE status='pending'").n >= M.maxQueue) throw new HttpError(429, "queue_full", "The AI queue is full, try again later");
    lim.hit((kind === "m3d" ? "m3d:" : "cut:") + storeId, M.perDay, 86400_000); // the worker's time is shared: a daily cap per store
    const id = Number(db.run("INSERT INTO m3d_jobs(product_id, store_id, photo, kind, created_at) VALUES(?,?,?,?,?)", prod.id, storeId, photo, kind, Date.now()).lastInsertRowid);
    (kind === "cutout" ? setCut : setState)(prod.id, "pending");
    return db.get("SELECT * FROM m3d_jobs WHERE id=?", id);
  }
  /* a new photo makes the old model wrong: it goes (and an unfinished job is cancelled); a new one is made only when the seller asks */
  function photoChanged(prod) {
    for (const k of KINDS) { const act = activeJob(prod.id, k); if (act) db.run("UPDATE m3d_jobs SET status='cancelled', finished_at=? WHERE id=?", Date.now(), act.id); }
    if (prod.m3d || prod.m3d_state) { dropFile(prod.m3d); db.run("UPDATE products SET m3d=NULL, m3d_state=NULL, m3d_err=NULL WHERE id=?", prod.id); if (prod.m3d_state === "published") bumpCatalog(); }
    // the photo studio's files belong to the old photo: the original and the white version go (the caller already removed prod.img)
    if (prod.img_orig && prod.img_orig !== prod.img) dropFile(prod.img_orig);
    if (prod.cut_img && prod.cut_img !== prod.img) dropFile(prod.cut_img);
    if (prod.img_orig || prod.cut_img || prod.cut_state) db.run("UPDATE products SET img_orig=NULL, cut_img=NULL, cut_state=NULL, cut_err=NULL, cut_warn=NULL WHERE id=?", prod.id);
  }
  const own = (req, pid) => {
    const { s } = needSeller(req), prod = db.get("SELECT * FROM products WHERE id=?", Number(pid));
    if (!prod || prod.store_id !== s.id) throw new HttpError(403, "forbidden", "Only your own products");
    return { s, prod };
  };
  const fresh = id => db.get("SELECT * FROM products WHERE id=?", id);
  r.get("/api/seller/products/:pid/model3d", (req, res, p) => { const { prod } = own(req, p.pid); return { model3d: out(prod), enabled: on() }; });
  r.post("/api/seller/products/:pid/model3d", (req, res, p) => { const { s, prod } = own(req, p.pid); sweep(); enqueue(prod, s.id, "m3d"); return { model3d: out(fresh(prod.id)) }; });
  /* «Сохранить 3D» (publish: buyers get the 3D view) or take it off the shelf */
  r.post("/api/seller/products/:pid/model3d/publish", async (req, res, p) => {
    const { prod } = own(req, p.pid), b = await readJson(req);
    if (!prod.m3d || !["completed", "published"].includes(prod.m3d_state)) throw bad("no_model", "There is no finished model for this product");
    setState(prod.id, b.publish === false ? "completed" : "published");
    bumpCatalog();
    return { model3d: out(fresh(prod.id)) };
  });
  /* «Удалить 3D»: the model and any unfinished job go; the photo stays */
  r.del("/api/seller/products/:pid/model3d", (req, res, p) => {
    const { prod } = own(req, p.pid), act = activeJob(prod.id);
    if (act) db.run("UPDATE m3d_jobs SET status='cancelled', finished_at=? WHERE id=?", Date.now(), act.id);
    dropFile(prod.m3d); db.run("UPDATE products SET m3d=NULL, m3d_state=NULL, m3d_err=NULL WHERE id=?", prod.id);
    if (prod.m3d_state === "published") bumpCatalog();
    return { model3d: out(fresh(prod.id)) };
  });

  /* ---------- AI photo studio: white background, the product untouched ---------- */
  r.get("/api/seller/products/:pid/cutout", (req, res, p) => { const { prod } = own(req, p.pid); return { cutout: outCut(prod), enabled: on() }; });
  r.post("/api/seller/products/:pid/cutout", (req, res, p) => { const { s, prod } = own(req, p.pid); sweep(); enqueue(prod, s.id, "cutout"); return { cutout: outCut(fresh(prod.id)) }; });
  /* «Использовать белый фон»: the white version becomes the card photo; the original is kept aside in img_orig */
  r.post("/api/seller/products/:pid/cutout/apply", (req, res, p) => {
    const { prod } = own(req, p.pid);
    if (!prod.cut_img || !["ready", "applied"].includes(prod.cut_state)) throw bad("no_cutout", "There is no finished white-background photo");
    db.run("UPDATE products SET img_orig=?, img=?, cut_state='applied', cut_at=? WHERE id=?", srcPhoto(prod), prod.cut_img, Date.now(), prod.id);
    bumpCatalog();
    return { cutout: outCut(fresh(prod.id)), img: mediaUrl(prod.cut_img) };
  });
  /* «Вернуть оригинал»: the untouched photo goes back on the card (the white version is kept, it can be used again) */
  r.post("/api/seller/products/:pid/cutout/revert", (req, res, p) => {
    const { prod } = own(req, p.pid);
    if (prod.img_orig) { db.run("UPDATE products SET img=?, img_orig=NULL, cut_state=?, cut_at=? WHERE id=?", prod.img_orig, prod.cut_img ? "ready" : null, Date.now(), prod.id); bumpCatalog(); }
    const f = fresh(prod.id);
    return { cutout: outCut(f), img: mediaUrl(f.img) };
  });
  /* «Оставить оригинал» / remove: the white version and any unfinished job go; the original is on the card */
  r.del("/api/seller/products/:pid/cutout", (req, res, p) => {
    const { prod } = own(req, p.pid), act = activeJob(prod.id, "cutout");
    if (act) db.run("UPDATE m3d_jobs SET status='cancelled', finished_at=? WHERE id=?", Date.now(), act.id);
    if (prod.img_orig) { db.run("UPDATE products SET img=?, img_orig=NULL WHERE id=?", prod.img_orig, prod.id); bumpCatalog(); }
    dropFile(prod.cut_img);
    db.run("UPDATE products SET cut_img=NULL, cut_state=NULL, cut_err=NULL, cut_warn=NULL WHERE id=?", prod.id);
    const f = fresh(prod.id);
    return { cutout: outCut(f), img: mediaUrl(f.img) };
  });

  /* ---------- the worker's side (Authorization: Bearer MODEL3D_WORKER_TOKEN) ---------- */
  const tokenHash = t => createHash("sha256").update(String(t)).digest();
  const needWorker = req => {
    const got = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!on() || !got || !timingSafeEqual(tokenHash(got), tokenHash(M.workerToken))) throw new HttpError(401, "bad_worker_token", "Worker token required");
    workerSeen = Date.now(); workerName = String(req.headers["x-worker"] || "").slice(0, 60);
  };
  /* take the oldest waiting job (one at a time per call); answers {job:null} when there is nothing to do */
  r.post("/api/worker/model3d/next", async req => {
    needWorker(req); sweep();
    const b = await readJson(req).catch(() => ({}));
    const kinds = (Array.isArray(b?.kinds) ? b.kinds : ["m3d"]).filter(k => KINDS.includes(k)); // an older worker asks for 3D jobs only
    if (!kinds.length) return { job: null };
    const job = db.tx(() => {
      const j = db.get(`SELECT * FROM m3d_jobs WHERE status='pending' AND kind IN (${kinds.map(() => "?").join(",")}) ORDER BY id LIMIT 1`, ...kinds); if (!j) return null;
      db.run("UPDATE m3d_jobs SET status='processing', started_at=?, attempts=attempts+1, worker=? WHERE id=?", Date.now(), workerName, j.id);
      return j;
    });
    if (!job) return { job: null };
    setKind(job, "processing");
    const p = fresh(job.product_id);
    return { job: { id: job.id, kind: job.kind, product_id: job.product_id, name: p?.ru || "", photo_url: `/api/worker/model3d/${job.id}/photo` } };
  });
  r.get("/api/worker/model3d/:id/photo", (req, res, p) => {
    needWorker(req);
    const j = db.get("SELECT * FROM m3d_jobs WHERE id=?", Number(p.id)); if (!j || j.status !== "processing") throw new HttpError(404, "not_found", "No such job");
    const name = j.photo.slice(9).replace(/[^\w.-]/g, ""), path = join(cfg.uploadsDir, name);
    let size; try { size = statSync(path).size; } catch { throw new HttpError(404, "not_found", "Photo is gone"); }
    res.writeHead(200, { "Content-Type": { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" }[extname(name)] || "application/octet-stream", "Content-Length": size });
    createReadStream(path).pipe(res);
  });
  /* the finished model: checked to be a real binary glTF 2.0 with a mesh before it is stored (a broken file is never published) */
  r.post("/api/worker/model3d/:id/result", async (req, res, p) => {
    needWorker(req);
    const j = db.get("SELECT * FROM m3d_jobs WHERE id=?", Number(p.id)); if (!j || j.status !== "processing") throw new HttpError(409, "not_processing", "This job is not being processed");
    if (j.kind === "cutout") return cutResult(req, j);
    const buf = await readBody(req, M.maxGlbMb * 1024 * 1024);
    const why = glbProblem(buf);
    if (why) { db.run("UPDATE m3d_jobs SET status='failed', err=?, finished_at=? WHERE id=?", "bad_glb:" + why, Date.now(), j.id); setState(j.product_id, "failed", "bad_glb"); throw bad("bad_glb", "Not a valid GLB: " + why); }
    const prod = fresh(j.product_id);
    db.run("UPDATE m3d_jobs SET status='completed', finished_at=? WHERE id=?", Date.now(), j.id);
    if (!prod || srcPhoto(prod) !== j.photo) return { ok: true, discarded: true }; // the photo changed meanwhile: this model is for the old one
    const file = `/uploads/m${prod.id}-${randomBytes(5).toString("hex")}.glb`;
    writeFileSync(join(cfg.uploadsDir, file.slice(9)), buf);
    dropFile(prod.m3d);
    const wasPublished = prod.m3d_state === "published";
    db.run("UPDATE products SET m3d=?, m3d_state='completed', m3d_err=NULL, m3d_at=? WHERE id=?", file, Date.now(), prod.id);
    if (wasPublished) bumpCatalog();
    log.info(`[3d] product ${prod.id}: model ready (${Math.round(buf.length / 1024)} KB, job ${j.id}, ${workerName || "worker"})`);
    return { ok: true, url: mediaUrl(file) };
  });
  /* the white-background photo: only a lossless PNG or lossless WebP is accepted, so the product's pixels cannot have been re-encoded */
  async function cutResult(req, j) {
    const buf = await readBody(req, 25 * 1024 * 1024);
    const kind = losslessImage(buf);
    if (!kind) { db.run("UPDATE m3d_jobs SET status='failed', err='bad_image_file', finished_at=? WHERE id=?", Date.now(), j.id); setCut(j.product_id, "failed", "error"); throw bad("bad_cutout", "Send a lossless PNG or lossless WebP"); }
    const prod = fresh(j.product_id);
    db.run("UPDATE m3d_jobs SET status='completed', finished_at=? WHERE id=?", Date.now(), j.id);
    if (!prod || srcPhoto(prod) !== j.photo) return { ok: true, discarded: true };
    const warn = ["hand", "edge"].find(w => String(req.headers["x-cutout-warn"] || "").split(",").includes(w)) || null;
    const file = `/uploads/c${prod.id}-${randomBytes(5).toString("hex")}.${kind}`;
    writeFileSync(join(cfg.uploadsDir, file.slice(9)), buf);
    if (prod.cut_img && prod.cut_img !== prod.img) dropFile(prod.cut_img);
    const applied = prod.cut_state === "applied" && prod.img === prod.cut_img; // a new white version while the old one is shown: the original goes back first
    db.run("UPDATE products SET cut_img=?, cut_state='ready', cut_warn=?, cut_err=NULL, cut_at=?" + (applied ? ", img=img_orig, img_orig=NULL" : "") + " WHERE id=?", file, warn, Date.now(), prod.id);
    if (applied) { dropFile(prod.cut_img); bumpCatalog(); }
    log.info(`[cutout] product ${prod.id}: white background ready (${Math.round(buf.length / 1024)} KB${warn ? ", warning " + warn : ""})`);
    return { ok: true, url: mediaUrl(file) };
  }
  r.post("/api/worker/model3d/:id/fail", async (req, res, p) => {
    needWorker(req);
    const j = db.get("SELECT * FROM m3d_jobs WHERE id=?", Number(p.id)); if (!j || j.status !== "processing") throw new HttpError(409, "not_processing", "This job is not being processed");
    const b = await readJson(req), err = String(b.error || "error").slice(0, 300), retry = b.retry !== false && j.attempts < 3;
    if (retry) { db.run("UPDATE m3d_jobs SET status='pending', err=?, worker=NULL WHERE id=?", err, j.id); setKind(j, "pending"); }
    else { db.run("UPDATE m3d_jobs SET status='failed', err=?, finished_at=? WHERE id=?", err, Date.now(), j.id); setKind(j, "failed", /bad_image|no_object|background/.test(err) ? "bad_image" : "error"); }
    log.warn(`[3d] job ${j.id} (product ${j.product_id}) failed: ${err}${retry ? " — back in the queue" : ""}`);
    return { ok: true, retry };
  });
  r.get("/api/worker/model3d/ping", req => { needWorker(req); return { ok: true, pending: db.get("SELECT COUNT(*) n FROM m3d_jobs WHERE status='pending'").n }; });

  /* The library of finished looks: a product photographed (and modelled) once can be put up again at once — no new photo, no new
     model. It offers any store's product whose model buyers already see (published, approved), and the seller's own products with a photo. */
  const words = t => String(t || "").toLowerCase().replace(/ё/g, "е").split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 2);
  function lookSource(id, storeId) {
    const p = db.get("SELECT * FROM products WHERE id=?", Number(id));
    if (!p || !p.img?.startsWith("/uploads/")) return null;
    const shared = p.active && (!p.review || p.review === "ok") && p.m3d && p.m3d_state === "published";
    return p.store_id === storeId || shared ? p : null;
  }
  r.get("/api/seller/look-library", req => {
    const { s } = needSeller(req), q = words(new URL(req.url, "http://x").searchParams.get("q")).slice(0, 8);
    if (!q.length) return { items: [] };
    const rows = db.all(`SELECT p.id, p.ru, p.uz, p.img, p.m3d, p.m3d_state, p.store_id, st.name store_name FROM products p LEFT JOIN stores st ON st.id=p.store_id
      WHERE p.img LIKE '/uploads/%' AND (p.store_id=? OR (p.active=1 AND (p.review IS NULL OR p.review='ok') AND p.m3d IS NOT NULL AND p.m3d_state='published'))
      ORDER BY p.id DESC LIMIT 3000`, s.id);
    const items = rows.map(p => { const w = words(p.ru + " " + p.uz); return { p, sc: q.filter(t => w.some(x => x.startsWith(t))).length / q.length + (p.m3d_state === "published" ? 0.05 : 0) }; })
      .filter(x => x.sc >= 0.6).sort((a, b) => b.sc - a.sc).slice(0, 6)
      .map(({ p }) => ({ id: p.id, ru: p.ru, uz: p.uz, img: mediaUrl(p.img), m3d: p.m3d && ["completed", "published"].includes(p.m3d_state) ? mediaUrl(p.m3d) : null, own: p.store_id === s.id, store_name: p.store_id === s.id ? null : p.store_name }));
    return { items };
  });
  /* the new product gets its own copies of the files (the source may change its photo later), the model in the same state */
  function copyLook(src, pid) {
    const dup = (path, prefix) => { const name = path.slice(9).replace(/[^\w.-]/g, ""), to = `${prefix}-${randomBytes(5).toString("hex")}${extname(name)}`; copyFileSync(join(cfg.uploadsDir, name), join(cfg.uploadsDir, to)); return "/uploads/" + to; };
    const hasModel = !!src.m3d && ["completed", "published"].includes(src.m3d_state);
    const img = dup(src.img, "p" + pid), m3d = hasModel ? dup(src.m3d, "m" + pid) : null;
    db.run("UPDATE products SET img=?, m3d=?, m3d_state=?, m3d_err=NULL, m3d_at=? WHERE id=?", img, m3d, hasModel ? src.m3d_state : null, Date.now(), pid);
    bumpCatalog();
    return fresh(pid);
  }
  return { photoChanged, out, outCut, on, workerOnline, lookSource, copyLook, sweep, catalogUrl: p => (p.m3d && p.m3d_state === "published" ? mediaUrl(p.m3d) : undefined) };
}

/* A lossless image: a PNG (signature + IHDR) or a WebP whose first chunk is VP8L (lossless) — a lossy WebP (VP8) or a JPEG would
   have re-encoded the product's pixels. Returns "png" | "webp" | null. */
export function losslessImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return null;
  if (buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a && buf.toString("latin1", 12, 16) === "IHDR") return "png";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") {
    let o = 12; // VP8L may follow a VP8X header chunk (and ICC/EXIF chunks)
    while (o + 8 <= buf.length) { const t = buf.toString("latin1", o, o + 4), n = buf.readUInt32LE(o + 4); if (t === "VP8L") return "webp"; if (t === "VP8 " || t === "ALPH") return null; o += 8 + n + (n & 1); }
  }
  return null;
}

/* A binary glTF 2.0 file: "glTF" magic, version 2, the stated length, a JSON chunk that parses and has at least one mesh with
   POSITION data, and a BIN chunk inside the file. Returns what is wrong, or null. */
export function glbProblem(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 28) return "too_small";
  if (buf.toString("latin1", 0, 4) !== "glTF") return "magic";
  if (buf.readUInt32LE(4) !== 2) return "version";
  if (buf.readUInt32LE(8) !== buf.length) return "length";
  const jl = buf.readUInt32LE(12); if (buf.readUInt32LE(16) !== 0x4e4f534a || 20 + jl > buf.length) return "json_chunk";
  let j; try { j = JSON.parse(buf.toString("utf8", 20, 20 + jl)); } catch { return "json"; }
  if (!Array.isArray(j.meshes) || !j.meshes.some(m => (m.primitives || []).some(pr => pr.attributes && pr.attributes.POSITION != null))) return "no_mesh";
  if ((j.extensionsRequired || []).length) return "extensions";
  if (Array.isArray(j.buffers) && j.buffers.length) { const off = 20 + jl; if (off + 8 > buf.length || buf.readUInt32LE(off + 4) !== 0x004e4942) return "bin_chunk"; if (off + 8 + buf.readUInt32LE(off) > buf.length) return "bin_length"; }
  return null;
}

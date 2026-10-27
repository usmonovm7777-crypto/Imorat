import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, phone TEXT UNIQUE, name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  google_sub TEXT UNIQUE, apple_sub TEXT UNIQUE, role TEXT NOT NULL DEFAULT 'buyer', district TEXT NOT NULL DEFAULT 'mirob',
  vip INTEGER NOT NULL DEFAULT 0, store_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS otp(
  phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER NOT NULL, window_start INTEGER NOT NULL, window_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS stores(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, district TEXT NOT NULL, addr TEXT NOT NULL DEFAULT '', addr_uz TEXT NOT NULL DEFAULT '',
  hours TEXT NOT NULL DEFAULT '', ru TEXT NOT NULL DEFAULT '', uz TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  la REAL, lo REAL, owner_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL,
  descr TEXT NOT NULL DEFAULT '', cats TEXT NOT NULL DEFAULT '[]', landmark TEXT NOT NULL DEFAULT '', telegram TEXT NOT NULL DEFAULT '',
  loc_src TEXT NOT NULL DEFAULT 'district', review_note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS products(
  id INTEGER PRIMARY KEY, cat TEXT NOT NULL, sub TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'box', ru TEXT NOT NULL, uz TEXT NOT NULL,
  unit TEXT NOT NULL, kg REAL NOT NULL, img TEXT NOT NULL DEFAULT '', grp INTEGER, hit INTEGER NOT NULL DEFAULT 0,
  is_new INTEGER NOT NULL DEFAULT 0, key TEXT, rating REAL NOT NULL DEFAULT 0, reviews INTEGER NOT NULL DEFAULT 0,
  country TEXT NOT NULL DEFAULT '[]', warranty INTEGER NOT NULL DEFAULT 0, descr TEXT NOT NULL DEFAULT '',
  store_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS offers(
  product_id INTEGER NOT NULL REFERENCES products(id), store_id TEXT NOT NULL REFERENCES stores(id),
  price INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(product_id, store_id));
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, num TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', pay TEXT NOT NULL, pay_status TEXT NOT NULL DEFAULT 'pending', form TEXT NOT NULL,
  goods INTEGER NOT NULL, del INTEGER NOT NULL, svc INTEGER NOT NULL, disc INTEGER NOT NULL, promo_disc INTEGER NOT NULL,
  total INTEGER NOT NULL, cash INTEGER NOT NULL, promo TEXT, services TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS shipments(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), store_id TEXT NOT NULL,
  tariff TEXT, price INTEGER NOT NULL, kg REAL NOT NULL, dist REAL NOT NULL DEFAULT 0, lines TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', status_at INTEGER NOT NULL, history TEXT NOT NULL DEFAULT '[]', claim_id TEXT, courier TEXT);
CREATE TABLE IF NOT EXISTS promo_uses(user_id TEXT NOT NULL, code TEXT NOT NULL, order_id INTEGER, PRIMARY KEY(user_id, code));
CREATE TABLE IF NOT EXISTS reviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ship_id INTEGER UNIQUE NOT NULL, order_id INTEGER NOT NULL, store_id TEXT NOT NULL, user_id TEXT NOT NULL,
  stars INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', reply TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settlements(id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL, amount INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '', admin_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL, target TEXT, details TEXT, ip TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS push_subs(endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS masters(id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, specs TEXT NOT NULL, districts TEXT NOT NULL, exp INTEGER NOT NULL DEFAULT 0, price INTEGER NOT NULL DEFAULT 0, price_unit TEXT NOT NULL DEFAULT 'job', about TEXT NOT NULL DEFAULT '', phone TEXT, status TEXT NOT NULL DEFAULT 'pending', note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS master_requests(id INTEGER PRIMARY KEY AUTOINCREMENT, master_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, when_txt TEXT NOT NULL, district TEXT, street TEXT, phone TEXT NOT NULL, name TEXT, status TEXT NOT NULL DEFAULT 'new', stars INTEGER, review TEXT, created_at INTEGER NOT NULL, status_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS master_requests_m ON master_requests(master_id);
CREATE INDEX IF NOT EXISTS master_requests_u ON master_requests(user_id);
CREATE TABLE IF NOT EXISTS points_log(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS points_log_u ON points_log(user_id, ref);
CREATE TABLE IF NOT EXISTS events_daily(day TEXT NOT NULL, product_id INTEGER NOT NULL, store_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, product_id, store_id, kind));
CREATE TABLE IF NOT EXISTS channel_posts(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, product_id INTEGER, msg_id INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS price_snap(product_id INTEGER PRIMARY KEY, min_price INTEGER NOT NULL, day TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS disputes(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, ship_id INTEGER NOT NULL, store_id TEXT NOT NULL, user_id TEXT NOT NULL, reason TEXT NOT NULL, text TEXT NOT NULL, photos TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', seller_reply TEXT, resolution TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS store_questions(id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL, product_id INTEGER, user_id TEXT NOT NULL, text TEXT NOT NULL, answer TEXT, created_at INTEGER NOT NULL, answered_at INTEGER);
CREATE TABLE IF NOT EXISTS stock_watch(user_id TEXT NOT NULL, product_id INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(user_id, product_id));
CREATE TABLE IF NOT EXISTS product_reviews(id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL, user_id TEXT NOT NULL, stars INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', photo TEXT, created_at INTEGER NOT NULL, UNIQUE(product_id, user_id));
CREATE TABLE IF NOT EXISTS team_projects(id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, name TEXT NOT NULL, items TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS team_members(project_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY(project_id, user_id));
CREATE TABLE IF NOT EXISTS tg_links(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reviews_store ON reviews(store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ship_store ON shipments(store_id, status_at DESC);
CREATE INDEX IF NOT EXISTS ship_order ON shipments(order_id);
CREATE INDEX IF NOT EXISTS offers_store ON offers(store_id);
`;

export function openDb(path, catalogPath) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  raw.exec(SCHEMA);
  // Columns added after the first release (safe to run on an existing database)
  const addCol = (t, c, def) => { if (!raw.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c)) raw.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  addCol("users", "tg_chat", "TEXT"); addCol("users", "token_ver", "INTEGER NOT NULL DEFAULT 0");
  addCol("users", "points", "INTEGER NOT NULL DEFAULT 0"); addCol("users", "ref_code", "TEXT"); addCol("users", "ref_by", "TEXT"); addCol("users", "ref_paid", "INTEGER NOT NULL DEFAULT 0");
  addCol("stores", "verified", "INTEGER NOT NULL DEFAULT 0");
  addCol("orders", "points_used", "INTEGER NOT NULL DEFAULT 0");
  addCol("users", "totp_secret", "TEXT"); addCol("users", "totp_on", "INTEGER NOT NULL DEFAULT 0");
  addCol("shipments", "accepted_at", "INTEGER"); addCol("shipments", "start_at", "INTEGER"); addCol("shipments", "reminded", "INTEGER NOT NULL DEFAULT 0");
  addCol("shipments", "sms_sent", "INTEGER NOT NULL DEFAULT 0"); addCol("shipments", "cancel_reason", "TEXT"); addCol("shipments", "tg_msg", "TEXT");
  addCol("shipments", "goods", "INTEGER NOT NULL DEFAULT 0"); addCol("shipments", "commission", "INTEGER NOT NULL DEFAULT 0");
  const cache = new Map();
  const st = sql => { let s = cache.get(sql); if (!s) { s = raw.prepare(sql); cache.set(sql, s); } return s; };
  const clean = p => p.map(v => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v));
  const db = {
    raw,
    all: (sql, ...p) => st(sql).all(...clean(p)),
    get: (sql, ...p) => st(sql).get(...clean(p)),
    run: (sql, ...p) => st(sql).run(...clean(p)),
    tx(fn) {
      raw.exec("BEGIN IMMEDIATE");
      try { const r = fn(); raw.exec("COMMIT"); return r; } catch (e) { raw.exec("ROLLBACK"); throw e; }
    },
    meta: k => db.get("SELECT v FROM meta WHERE k=?", k)?.v,
    setMeta: (k, v) => db.run("INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, String(v))
  };
  const ref = JSON.parse(readFileSync(catalogPath, "utf8"));
  if (!db.meta("seeded")) seed(db, ref);
  else addNewProducts(db, ref);
  db.ref = ref;
  return db;
}

/* Later releases add products to catalog.json: insert the ones the database does not have yet */
function addNewProducts(db, ref) {
  const have = new Set(db.all("SELECT id FROM products").map(r => r.id)), now = Date.now();
  const fresh = ref.products.filter(p => !have.has(p.id));
  if (!fresh.length) return;
  db.tx(() => {
    for (const p of fresh) {
      db.run(`INSERT INTO products(id,cat,sub,icon,ru,uz,unit,kg,img,grp,hit,is_new,key,rating,reviews,country,warranty,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
        p.id, p.cat, p.sub, p.icon, p.ru, p.uz, p.unit, p.kg, p.img, p.group, p.hit, p.isNew, p.key, p.rating, p.reviews, JSON.stringify(p.country), p.warranty, now);
      for (const o of p.offers) if (db.get("SELECT 1 FROM stores WHERE id=?", o.store)) db.run("INSERT OR IGNORE INTO offers(product_id,store_id,price,stock,updated_at) VALUES(?,?,?,?,?)", p.id, o.store, o.price, o.stock, now);
    }
    db.setMeta("catalog_rev", now);
  });
}

/* First start: load stores, products and offers from data/catalog.json (exported from the website). */
function seed(db, ref) {
  const D = Object.fromEntries(ref.districts.map(d => [d.id, d]));
  const now = Date.now();
  db.tx(() => {
    for (const s of ref.stores) {
      db.run("INSERT OR IGNORE INTO stores(id,name,district,addr,addr_uz,hours,ru,uz,la,lo,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?, 'active', ?)",
        s.id, s.name, s.d, s.addr, s.addrUz, s.hours, s.ru, s.uz, D[s.d]?.la, D[s.d]?.lo, now);
    }
    for (const p of ref.products) {
      db.run(`INSERT OR IGNORE INTO products(id,cat,sub,icon,ru,uz,unit,kg,img,grp,hit,is_new,key,rating,reviews,country,warranty,active,created_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
        p.id, p.cat, p.sub, p.icon, p.ru, p.uz, p.unit, p.kg, p.img, p.group, p.hit, p.isNew, p.key, p.rating, p.reviews, JSON.stringify(p.country), p.warranty, now);
      for (const o of p.offers) db.run("INSERT OR IGNORE INTO offers(product_id,store_id,price,stock,updated_at) VALUES(?,?,?,?,?)", p.id, o.store, o.price, o.stock, now);
    }
    db.setMeta("seeded", now);
    db.setMeta("catalog_rev", now);
  });
}

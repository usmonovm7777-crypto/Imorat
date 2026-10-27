import { createHmac, createHash, timingSafeEqual, createPublicKey, verify as cryptoVerify, randomInt, randomBytes } from "node:crypto";
import { HttpError, bad } from "./http.js";

const b64u = b => Buffer.from(b).toString("base64url");
const unb64u = s => Buffer.from(s, "base64url");

/* ---------- Session tokens (JWT HS256) ---------- */
export function signJwt(payload, secret, ttlSec) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify({ ...payload, iat: now, exp: now + ttlSec }));
  const s = createHmac("sha256", secret).update(h + "." + p).digest("base64url");
  return `${h}.${p}.${s}`;
}
export function verifyJwt(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const want = createHmac("sha256", secret).update(h + "." + p).digest();
  const got = unb64u(s);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const head = JSON.parse(unb64u(h)); if (head.alg !== "HS256") return null;
    const body = JSON.parse(unb64u(p));
    if (!body.exp || body.exp < Date.now() / 1000) return null;
    return body;
  } catch { return null; }
}

/* ---------- Phone numbers ---------- */
const OPS = /^998(20|33|50|55|71|77|88|90|91|93|94|95|97|98|99)\d{7}$/;
export function parsePhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.length === 9) d = "998" + d;
  if (!OPS.test(d)) throw bad("bad_phone", "Phone must be an Uzbek mobile number: +998 XX XXX XX XX");
  return d;
}
export const prettyPhone = d => `+${d.slice(0, 3)} ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8, 10)} ${d.slice(10)}`;

/* ---------- One-time SMS codes ---------- */
const OTP_TTL = 5 * 60_000, RESEND_MS = 60_000, MAX_PER_HOUR = 5, MAX_ATTEMPTS = 5;
const hashCode = (secret, phone, code) => createHash("sha256").update(`${secret}:${phone}:${code}`).digest("hex");

export function issueOtp(db, secret, phone) {
  const now = Date.now();
  const row = db.get("SELECT * FROM otp WHERE phone=?", phone);
  if (row && now - row.sent_at < RESEND_MS) throw new HttpError(429, "otp_wait", "Wait before requesting a new code", { retry_in: Math.ceil((RESEND_MS - (now - row.sent_at)) / 1000) });
  let ws = row ? row.window_start : now, wc = row ? row.window_count : 0;
  if (now - ws > 3600_000) { ws = now; wc = 0; }
  if (wc >= MAX_PER_HOUR) throw new HttpError(429, "otp_hourly", "Too many codes for this number, try again in an hour", { retry_in: Math.ceil((ws + 3600_000 - now) / 1000) });
  const code = String(randomInt(100000, 1000000));
  db.run(`INSERT INTO otp(phone,code_hash,expires_at,attempts,sent_at,window_start,window_count) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0,
          sent_at=excluded.sent_at, window_start=excluded.window_start, window_count=excluded.window_count`,
    phone, hashCode(secret, phone, code), now + OTP_TTL, 0, now, ws, wc + 1);
  return code;
}

export function checkOtp(db, secret, phone, code) {
  const row = db.get("SELECT * FROM otp WHERE phone=?", phone);
  if (!row || row.expires_at < Date.now()) throw bad("otp_expired", "The code has expired, request a new one");
  if (row.attempts >= MAX_ATTEMPTS) throw bad("otp_attempts", "Too many wrong attempts, request a new code");
  const want = Buffer.from(row.code_hash, "hex"), got = Buffer.from(hashCode(secret, phone, String(code || "").replace(/\D/g, "")), "hex");
  if (!timingSafeEqual(want, got)) {
    db.run("UPDATE otp SET attempts=attempts+1 WHERE phone=?", phone);
    throw bad("otp_wrong", "Wrong code", { left: MAX_ATTEMPTS - row.attempts - 1 });
  }
  db.run("DELETE FROM otp WHERE phone=?", phone);
}

/* ---------- Google / Apple ID tokens (RS256, keys from the provider's JWKS) ---------- */
const jwksCache = new Map();
async function getKeys(url) {
  const c = jwksCache.get(url);
  if (c && c.until > Date.now()) return c.keys;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new HttpError(502, "jwks_unavailable", "Could not load sign-in keys");
  const keys = (await r.json()).keys || [];
  const age = Number((r.headers.get("cache-control") || "").match(/max-age=(\d+)/)?.[1]) || 3600;
  jwksCache.set(url, { keys, until: Date.now() + Math.min(age, 86400) * 1000 });
  return keys;
}
export async function verifyIdToken(token, { jwksUrl, issuers, audience }) {
  if (!audience) throw new HttpError(503, "provider_not_configured", "This sign-in method is not configured on the server");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw bad("bad_token", "Invalid sign-in token");
  let head, body;
  try { head = JSON.parse(unb64u(parts[0])); body = JSON.parse(unb64u(parts[1])); } catch { throw bad("bad_token", "Invalid sign-in token"); }
  if (head.alg !== "RS256") throw bad("bad_token", "Unsupported token algorithm");
  let jwk = (await getKeys(jwksUrl)).find(k => k.kid === head.kid);
  if (!jwk) { jwksCache.delete(jwksUrl); jwk = (await getKeys(jwksUrl)).find(k => k.kid === head.kid); }
  if (!jwk) throw bad("bad_token", "Unknown signing key");
  const ok = cryptoVerify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), createPublicKey({ key: jwk, format: "jwk" }), unb64u(parts[2]));
  if (!ok) throw bad("bad_token", "Token signature is invalid");
  const now = Date.now() / 1000;
  if (!issuers.includes(body.iss)) throw bad("bad_token", "Wrong token issuer");
  const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
  if (!aud.includes(audience)) throw bad("bad_token", "Token is for another app");
  if (!body.exp || body.exp < now - 60) throw bad("token_expired", "Sign-in token has expired, try again");
  return body;
}

/* ---------- Users ---------- */
export const newUserId = () => "u" + Date.now().toString(36) + randomBytes(3).toString("hex");
export function publicUser(u, admins = []) {
  if (!u) return null;
  return {
    id: u.id, name: u.name, phone: u.phone ? prettyPhone(u.phone) : "", email: u.email, role: u.role, district: u.district,
    vip: !!u.vip, store_id: u.store_id || null, via: u.google_sub ? "google" : u.apple_sub ? "apple" : "phone",
    admin: !!u.phone && admins.includes(u.phone), created: u.created_at
  };
}

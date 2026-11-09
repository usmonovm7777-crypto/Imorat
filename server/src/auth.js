import { createHmac, createHash, timingSafeEqual, createPublicKey, verify as cryptoVerify, randomInt, randomBytes, scryptSync } from "node:crypto";
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

export function issueOtp(db, secret, phone, fixedCode = null) {
  const now = Date.now();
  const row = db.get("SELECT * FROM otp WHERE phone=?", phone);
  if (row && now - row.sent_at < RESEND_MS) throw new HttpError(429, "otp_wait", "Wait before requesting a new code", { retry_in: Math.ceil((RESEND_MS - (now - row.sent_at)) / 1000) });
  let ws = row ? row.window_start : now, wc = row ? row.window_count : 0;
  if (now - ws > 3600_000) { ws = now; wc = 0; }
  if (wc >= MAX_PER_HOUR) throw new HttpError(429, "otp_hourly", "Too many codes for this number, try again in an hour", { retry_in: Math.ceil((ws + 3600_000 - now) / 1000) });
  const code = fixedCode || String(randomInt(100000, 1000000)); // fixedCode: the reviewers' account from REVIEW_ACCOUNTS
  db.run(`INSERT INTO otp(phone,code_hash,expires_at,attempts,sent_at,window_start,window_count) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=CASE WHEN ${fixedCode ? 1 : 0} THEN otp.attempts ELSE 0 END,
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

/* ---------- Passwords (staff accounts: the owner and the helpers the owner adds) ----------
   scrypt with a random salt; the stored string carries its own parameters, so they can be raised later without breaking old hashes.
   The owner's hash lives in server/.env (OWNER_PASSWORD_HASH), never in the repository; helpers' hashes live in the database. */
const SCRYPT = { N: 32768, r: 8, p: 1, len: 32, maxmem: 128 * 1024 * 1024 }; // ~90 ms on a small VPS; maxmem must grow with N or scrypt throws
export function hashPassword(password, min = 10) { // staff: 10+ characters; buyers, masters and sellers: 8+
  if (typeof password !== "string") throw bad("weak_password", `Password must be a string of at least ${min} characters`);
  const pw = password;
  if (pw.length < min || pw.length > 256) throw bad("weak_password", `Password must be ${min} to 256 characters`);
  const salt = randomBytes(16);
  const key = scryptSync(pw.normalize("NFKC"), salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
/* What makes a chosen password too easy to guess (the same rules as the sign-up form in the app). Returns a reason code or "".
   short — fewer than `min` characters; mix — no letter or no digit; same — mostly one character (11111111, aaaa1111);
   run — five or more characters in a row of the alphabet, digits or keyboard (12345, abcde, qwert, йцуке) or four of the same;
   common — a well-known password or one built on such a word (password1, parol123, qwerty12, toshkent2024);
   personal — contains the phone number or the name. Temporary passwords made by the server are not checked (they are random). */
const PW_ROWS = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl", "zxcvbnm", "йцукенгшщзхъ", "фывапролджэ", "ячсмитьбю", "абвгдеёжзийклмнопрстуфхцчшщъыьэюя", "1qaz2wsx3edc", "qazwsxedc"];
const PW_WORDS = ["password", "passw0rd", "parol", "parol1", "qwerty", "qwertyui", "admin", "administrator", "iloveyou", "letmein", "welcome", "monkey", "dragon", "master", "sunshine", "football", "baseball", "superman", "batman", "princess", "starwars", "secret", "login", "user", "test", "guest", "uzbekistan", "ozbekiston", "o‘zbekiston", "tashkent", "toshkent", "samarkand", "samarqand", "qurilish", "quriliş", "qurilishgo", "imorat", "imoratgo", "usta", "sevgi", "lyubov", "parolparol", "пароль", "любовь", "привет", "йцукен", "qwertyuiop", "zaq12wsx", "1q2w3e4r", "1q2w3e", "q1w2e3r4", "123qwe", "qwe123", "asdf", "asdfgh", "zxcvbn"];
const PW_TR = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "x", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "i", ь: "", э: "e", ю: "yu", я: "ya", ў: "o", қ: "q", ғ: "g", ҳ: "h" };
const pwNameForms = name => { const out = new Set(); for (const w of String(name || "").normalize("NFKC").toLowerCase().split(/[\s.-]+/)) { if (w.length < 3) continue; out.add(w); const t = [...w].map(c => PW_TR[c] ?? c).join(""); out.add(t); out.add(t.replace(/x/g, "h")); out.add(t.replace(/j/g, "zh")); } return [...out].filter(w => w.length >= 3); }; // Азиз → aziz, Шерзод → sherzod, Хуршид → xurshid / hurshid
export function passwordProblem(pw, { min = 8, phone = "", name = "" } = {}) {
  if (typeof pw !== "string" || pw.length < min) return "short";
  if (pw.length > 256) return "long";
  const s = pw.normalize("NFKC").toLowerCase();
  const uniq = new Set(s).size; if (uniq < 4 || uniq * 3 < s.length || /^(.+?)\1{2,}$/u.test(s)) return "same";
  if (/(.)\1{3}/u.test(s)) return "run";
  for (const row of PW_ROWS) for (const r of [row, [...row].reverse().join("")]) for (let i = 0; i + 5 <= r.length; i++) if (s.includes(r.slice(i, i + 5))) return "run";
  if (!/\p{L}/u.test(s) || !/\p{N}/u.test(s)) return "mix";
  const core = s.replace(/[^\p{L}]+/gu, "");
  if (PW_WORDS.includes(s) || (core.length >= 4 && PW_WORDS.includes(core))) return "common";
  const digits = String(phone || "").replace(/\D/g, ""); if (digits.length >= 7 && s.replace(/\D/g, "").includes(digits.slice(-7))) return "personal";
  if (pwNameForms(name).some(w => s.includes(w))) return "personal";
  return "";
}
const PW_SAY = { short: "Password must be at least %d characters", long: "Password must be at most 256 characters", mix: "Use both letters and digits", same: "Too many repeated characters", run: "Avoid runs like 12345, abcde, qwerty or 1111", common: "This password is too common", personal: "Do not use your phone number or name in the password" };
export function assertStrongPassword(pw, opts = {}) { const why = passwordProblem(pw, opts); if (why) throw bad("weak_password", PW_SAY[why].replace("%d", opts.min || 8), { reason: why }); }
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${Buffer.alloc(16, 7).toString("base64url")}$${Buffer.alloc(32, 9).toString("base64url")}`;
export function verifyPassword(password, stored) {
  // an unknown login is checked against a dummy hash, so "no such login" and "wrong password" take the same time
  const m = String(stored || DUMMY_HASH).match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/);
  if (!m) return false;
  const [, N, r, p, salt, hash] = m, want = Buffer.from(hash, "base64url");
  if (typeof password !== "string" || password.length > 256) return false;
  let got; try { got = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64url"), want.length, { N: +N, r: +r, p: +p, maxmem: Math.max(SCRYPT.maxmem, 128 * +N * +r * 2) }); } catch { return false; }
  return !!stored && got.length === want.length && timingSafeEqual(got, want);
}
/* a temporary password for a new helper: 14 characters from an unambiguous alphabet, shown once */
export function tempPassword() { const A = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; return Array.from({ length: 14 }, () => A[randomInt(A.length)]).join(""); }

/* ---------- Users ---------- */
export const newUserId = () => "u" + Date.now().toString(36) + randomBytes(3).toString("hex");
/* role: "owner" (the person who runs Quriliş Go: everything), "admin" (a helper: moderation and orders, no money or analytics) or null */
export function publicUser(u, admins = [], staff = null) {
  if (!u) return null;
  const role = staff && !staff.disabled ? staff.role : (!!u.phone && admins.includes(u.phone) ? "owner" : null);
  return {
    id: u.id, name: u.name, phone: u.phone ? prettyPhone(u.phone) : "", email: u.email, role: u.role, district: u.district,
    store_id: u.store_id || null, via: staff ? "password" : u.google_sub ? "google" : u.apple_sub ? "apple" : "phone",
    admin: !!role, owner: role === "owner", staff: staff ? { login: staff.login, role: staff.role, must_change: !!staff.must_change, env: !!staff.from_env } : null,
    created: u.created_at, points: u.points || 0, has_password: !!u.pw_hash
  };
}

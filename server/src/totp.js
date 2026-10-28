import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/* TOTP (RFC 6238) for the second login step of admins: Google Authenticator, Apple Passwords, etc. */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newSecret() {
  const b = randomBytes(20); let bits = "", out = "";
  for (const x of b) bits += x.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function fromB32(s) {
  let bits = ""; for (const ch of s.replace(/=+$/, "").toUpperCase()) { const v = B32.indexOf(ch); if (v < 0) continue; bits += v.toString(2).padStart(5, "0"); }
  const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totp(secret, t = Date.now(), step = 30) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / step)));
  const h = createHmac("sha1", fromB32(secret)).update(c).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, "0");
}
export function checkTotp(secret, code, t = Date.now()) {
  const c = String(code || "").replace(/\D/g, "");
  if (c.length !== 6) return false;
  return [-30000, 0, 30000].some(d => timingSafeEqual(Buffer.from(totp(secret, t + d)), Buffer.from(c)));
}
export const otpauthUrl = (secret, label) => `otpauth://totp/${encodeURIComponent("Imorat Go:" + label)}?secret=${secret}&issuer=Imorat Go&digits=6&period=30`;

import { generateKeyPairSync, createPrivateKey, createECDH, randomBytes, hkdfSync, createCipheriv, sign } from "node:crypto";

/* Web Push without libraries: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291 / 8188).
   Works for the installed site (PWA) on Android and on iPhone (iOS 16.4+, added to Home Screen). */
const b64u = b => Buffer.from(b).toString("base64url");

export function loadVapid(db, env = process.env) {
  if (env.VAPID_PRIVATE_JWK) return JSON.parse(env.VAPID_PRIVATE_JWK);
  let jwk = db.meta("vapid_jwk");
  if (!jwk) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    jwk = JSON.stringify(privateKey.export({ format: "jwk" }));
    db.setMeta("vapid_jwk", jwk);
  }
  return JSON.parse(jwk);
}
export const vapidPublic = jwk => b64u(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]));

function vapidJwt(jwk, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const h = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const p = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }));
  const sig = sign("sha256", Buffer.from(h + "." + p), { key: createPrivateKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${b64u(sig)}`;
}

export function encryptPayload(payload, p256dh, authSecret) {
  const ua = Buffer.from(p256dh, "base64url"), auth = Buffer.from(authSecret, "base64url");
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const asPub = ecdh.getPublicKey(), shared = ecdh.computeSecret(ua);
  const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua, asPub]), 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const c = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const head = Buffer.alloc(21); salt.copy(head, 0); head.writeUInt32BE(4096, 16); head[20] = asPub.length;
  return Buffer.concat([head, asPub, body]);
}

export function createPush(db, subject, log = console) {
  const jwk = loadVapid(db);
  const pub = vapidPublic(jwk);
  async function sendOne(sub, data) {
    try {
      const r = await fetch(sub.endpoint, {
        method: "POST", signal: AbortSignal.timeout(10000),
        headers: { TTL: "86400", Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: `vapid t=${vapidJwt(jwk, sub.endpoint, subject)}, k=${pub}` },
        body: encryptPayload(JSON.stringify(data), sub.p256dh, sub.auth)
      });
      if (r.status === 404 || r.status === 410) db.run("DELETE FROM push_subs WHERE endpoint=?", sub.endpoint);
      else if (!r.ok) log.warn("[push]", r.status, (await r.text().catch(() => "")).slice(0, 120));
    } catch (e) { log.warn("[push] failed:", e.message); }
  }
  return {
    publicKey: pub,
    async toUser(userId, data) {
      const subs = db.all("SELECT * FROM push_subs WHERE user_id=?", userId);
      await Promise.all(subs.map(s => sendOne(s, data)));
      return subs.length;
    }
  };
}

/* Native push for the Android / iPhone app, without libraries:
   - Android: Firebase Cloud Messaging HTTP v1. Needs a Firebase project and a service-account key (JSON) with the
     "Firebase Cloud Messaging API" enabled: FCM_SERVICE_ACCOUNT_FILE=/path/key.json (or FCM_SERVICE_ACCOUNT_JSON).
   - iPhone: APNs over HTTP/2 with a token (JWT ES256). Needs an Apple Developer account: an APNs auth key (.p8) —
     APNS_KEY_FILE (or APNS_KEY_P8), its APNS_KEY_ID, the APNS_TEAM_ID and the app's bundle id (APNS_BUNDLE_ID,
     default uz.imorat.app). APNS_ENV=sandbox for builds from Xcode, production for TestFlight / App Store.
   Without the keys the module is off: devices are still registered, nothing is sent, and the log says why once.
   Device tokens live in the devices table (one row per app install, bound to the signed-in user). A token the
   provider reports as dead (FCM UNREGISTERED / 404, APNs 410 or BadDeviceToken) is deleted. */
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import http2 from "node:http2";

const b64u = b => Buffer.from(b).toString("base64url");
const jwt = (alg, header, payload, key) => {
  const h = b64u(JSON.stringify({ alg, typ: "JWT", ...header })), p = b64u(JSON.stringify(payload));
  const s = sign(alg === "ES256" ? "sha256" : "RSA-SHA256", Buffer.from(h + "." + p), alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key);
  return `${h}.${p}.${b64u(s)}`;
};
const readMaybeFile = (inline, file) => { if (inline) return inline; if (file) { try { return readFileSync(file, "utf8"); } catch { return ""; } } return ""; };

export function loadNativePushConfig(env = process.env) {
  let sa = null;
  const saText = readMaybeFile(env.FCM_SERVICE_ACCOUNT_JSON, env.FCM_SERVICE_ACCOUNT_FILE);
  if (saText) { try { sa = JSON.parse(saText); } catch { sa = null; } }
  const fcm = sa?.client_email && sa?.private_key && sa?.project_id
    ? { email: sa.client_email, key: sa.private_key, project: sa.project_id, tokenUrl: env.FCM_TOKEN_URL || sa.token_uri || "https://oauth2.googleapis.com/token", url: (env.FCM_URL || "https://fcm.googleapis.com").replace(/\/$/, "") }
    : null;
  const p8 = readMaybeFile(env.APNS_KEY_P8 && env.APNS_KEY_P8.replace(/\\n/g, "\n"), env.APNS_KEY_FILE);
  const apns = p8 && env.APNS_KEY_ID && env.APNS_TEAM_ID
    ? { key: p8, keyId: env.APNS_KEY_ID, teamId: env.APNS_TEAM_ID, bundleId: env.APNS_BUNDLE_ID || "uz.imorat.app", url: env.APNS_URL || (env.APNS_ENV === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com") }
    : null;
  return { fcm, apns };
}

export function createNativePush({ db, cfg, log = console }) {
  const C = cfg.nativePush || { fcm: null, apns: null };
  const dead = token => db.run("DELETE FROM devices WHERE token=?", token);
  let warned = false;
  const offNote = platform => { if (!warned) { warned = true; log.info(`[push-native] no ${platform} keys configured: app push is off (see .env.example FCM_* / APNS_*)`); } };

  /* ---- FCM HTTP v1: OAuth2 access token from the service account, cached ~50 minutes ---- */
  let fcmTok = { value: "", until: 0 };
  async function fcmAccessToken() {
    if (fcmTok.until > Date.now()) return fcmTok.value;
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt("RS256", {}, { iss: C.fcm.email, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: C.fcm.tokenUrl, iat: now, exp: now + 3600 }, createPrivateKey(C.fcm.key));
    const r = await fetch(C.fcm.tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }), signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`fcm token ${r.status} ${JSON.stringify(j).slice(0, 120)}`);
    fcmTok = { value: j.access_token, until: Date.now() + Math.min(3300, (j.expires_in || 3600) - 300) * 1000 };
    return fcmTok.value;
  }
  async function sendFcm(dev, n) {
    const token = await fcmAccessToken();
    const message = {
      token: dev.token,
      notification: { title: n.title, body: n.body },
      data: { url: String(n.url || ""), tag: String(n.tag || "") },
      // the "orders" channel is created by the app at start-up (Android drops notifications for an unknown channel)
      android: { priority: "high", notification: { channel_id: "orders", tag: String(n.tag || "imorat"), sound: "default" } }
    };
    const r = await fetch(`${C.fcm.url}/v1/projects/${C.fcm.project}/messages:send`, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ message }), signal: AbortSignal.timeout(10000) });
    if (r.ok) return true;
    const txt = await r.text().catch(() => "");
    if (r.status === 404 || /UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT.*token/i.test(txt)) { dead(dev.token); log.info(`[push-native] fcm token dropped (${r.status})`); }
    else log.warn("[push-native] fcm", r.status, txt.slice(0, 160));
    return false;
  }

  /* ---- APNs HTTP/2 with a provider token (one JWT per ~50 minutes, as Apple asks) ---- */
  let apnsTok = { value: "", until: 0 };
  const apnsJwt = () => {
    if (apnsTok.until > Date.now()) return apnsTok.value;
    apnsTok = { value: jwt("ES256", { kid: C.apns.keyId }, { iss: C.apns.teamId, iat: Math.floor(Date.now() / 1000) }, createPrivateKey(C.apns.key)), until: Date.now() + 50 * 60000 };
    return apnsTok.value;
  };
  function sendApns(dev, n) {
    return new Promise(resolve => {
      let session; const done = ok => { try { session?.close(); } catch {} resolve(ok); };
      try { session = http2.connect(C.apns.url); } catch (e) { log.warn("[push-native] apns connect", e.message); return resolve(false); }
      session.on("error", e => { log.warn("[push-native] apns", e.message); done(false); });
      const body = JSON.stringify({ aps: { alert: { title: n.title, body: n.body }, sound: "default", "thread-id": String(n.tag || "imorat"), "mutable-content": 0 }, url: String(n.url || ""), tag: String(n.tag || "") });
      const req = session.request({ ":method": "POST", ":path": `/3/device/${dev.token}`, authorization: "bearer " + apnsJwt(), "apns-topic": C.apns.bundleId, "apns-push-type": "alert", "apns-priority": "10", "apns-expiration": String(Math.floor(Date.now() / 1000) + 86400), "content-type": "application/json" });
      let status = 0, chunks = "";
      req.setTimeout(10000, () => { req.close(); done(false); });
      req.on("response", h => { status = h[":status"]; });
      req.on("data", c => { chunks += c; });
      req.on("error", e => { log.warn("[push-native] apns", e.message); done(false); });
      req.on("end", () => {
        if (status === 200) return done(true);
        if (status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(chunks)) { dead(dev.token); log.info(`[push-native] apns token dropped (${status})`); }
        else log.warn("[push-native] apns", status, chunks.slice(0, 160));
        done(false);
      });
      req.end(body);
    });
  }

  return {
    enabled: { android: !!C.fcm, ios: !!C.apns },
    /* one notification to every app install of a user; returns how many were delivered to the provider */
    async toUser(userId, n) {
      const devs = db.all("SELECT * FROM devices WHERE user_id=?", userId);
      let sent = 0;
      for (const d of devs) {
        try {
          if (d.platform === "android") { if (!C.fcm) { offNote("FCM"); continue; } if (await sendFcm(d, n)) sent++; }
          else if (d.platform === "ios") { if (!C.apns) { offNote("APNs"); continue; } if (await sendApns(d, n)) sent++; }
        } catch (e) { log.warn("[push-native]", d.platform, e.message); }
      }
      return sent;
    }
  };
}

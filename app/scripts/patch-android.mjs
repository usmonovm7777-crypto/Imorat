/* Applies Imorat Go's native settings to the generated Android project (android/ is created by `npx cap add android`
   and is not committed). Safe to run again — every change checks whether it is already there.
   - version:   versionCode / versionName from version.json
   - deep link: imoratgo://… (the way back from the bank page) and the notification permission for Android 13+
   - signing:   a release signingConfig is added only when the keystore is given through the environment:
                ANDROID_KEYSTORE_FILE, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
                (CI decodes the keystore from a secret into a temp file; nothing is ever written into the repository)
   - push:      google-services.json from GOOGLE_SERVICES_JSON (raw or base64) when provided — without it the app
                builds and runs, only native push stays off on Android */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const app = join(dirname(fileURLToPath(import.meta.url)), ".."), android = join(app, "android");
const version = JSON.parse(readFileSync(join(app, "version.json"), "utf8"));
const changed = [];
const edit = (file, fn) => { const p = join(android, file); if (!existsSync(p)) { console.error(`✗ ${file} not found — run "npx cap add android" first`); process.exit(2); } const before = readFileSync(p, "utf8"), after = fn(before); if (after !== before) { writeFileSync(p, after); changed.push(file); } };

/* ---- app/build.gradle: version, release signing ---- */
edit("app/build.gradle", g => {
  g = g.replace(/versionCode\s+\d+/, `versionCode ${version.versionCode}`).replace(/versionName\s+"[^"]*"/, `versionName "${version.versionName}"`);
  const ks = process.env.ANDROID_KEYSTORE_FILE;
  if (ks && existsSync(ks)) {
    if (!/signingConfigs\s*\{/.test(g)) {
      g = g.replace(/\n(\s*)buildTypes\s*\{/, `\n$1// release signing: the keystore and its passwords come from the environment at build time, never from the repository\n$1signingConfigs {\n$1    release {\n$1        storeFile file(System.getenv("ANDROID_KEYSTORE_FILE"))\n$1        storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")\n$1        keyAlias System.getenv("ANDROID_KEY_ALIAS")\n$1        keyPassword System.getenv("ANDROID_KEY_PASSWORD")\n$1    }\n$1}\n$1buildTypes {`);
    }
    if (!/release\s*\{[^}]*signingConfig signingConfigs\.release/s.test(g)) g = g.replace(/(buildTypes\s*\{\s*release\s*\{)/, `$1\n            signingConfig signingConfigs.release`);
  } else if (process.env.APP_RELEASE === "1") { console.error("✗ APP_RELEASE=1 but ANDROID_KEYSTORE_FILE is missing: a store build must be signed with the release key"); process.exit(2); }
  return g;
});

/* ---- AndroidManifest.xml: deep link + notification permission ---- */
edit("app/src/main/AndroidManifest.xml", m => {
  if (!/android:scheme="imoratgo"/.test(m)) {
    m = m.replace(/(\n(\s*)<\/activity>)/, `\n$2    <!-- the way back into the app from the bank page: imoratgo://paid/IM-123456 -->\n$2    <intent-filter>\n$2        <action android:name="android.intent.action.VIEW" />\n$2        <category android:name="android.intent.category.DEFAULT" />\n$2        <category android:name="android.intent.category.BROWSABLE" />\n$2        <data android:scheme="imoratgo" />\n$2    </intent-filter>$1`);
  }
  if (!/android\.permission\.POST_NOTIFICATIONS/.test(m)) m = m.replace(/(\n\s*)<\/manifest>/, `$1<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />$1</manifest>`);
  return m;
});

/* ---- google-services.json for Firebase Cloud Messaging ---- */
const gs = process.env.GOOGLE_SERVICES_JSON;
if (gs) {
  const txt = gs.trim().startsWith("{") ? gs : Buffer.from(gs, "base64").toString("utf8");
  try { JSON.parse(txt); } catch { console.error("✗ GOOGLE_SERVICES_JSON is not valid JSON (raw or base64)"); process.exit(2); }
  const p = join(android, "app", "google-services.json");
  if (!existsSync(p) || readFileSync(p, "utf8") !== txt) { writeFileSync(p, txt); changed.push("app/google-services.json"); }
} else console.log("· google-services.json not provided: the Android build works, native push stays off until Firebase is set up");

console.log(changed.length ? `android project patched: ${changed.join(", ")}` : "android project already up to date");

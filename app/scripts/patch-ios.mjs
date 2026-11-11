/* Applies Quriliş Go's native settings to the generated iOS project (ios/ is created by `npx cap add ios` on a Mac
   and is not committed). Safe to run again. What it does and why:
   - Info.plist usage descriptions — iOS terminates an app that touches the camera, photos or location without them.
     The site uses them: photo search and product photos (camera / photo library), "detect my location" at checkout.
   - CFBundleURLTypes imoratgo:// — the way back from the bank page into the app.
   - ITSAppUsesNonExemptEncryption = NO — only HTTPS is used, so the export-compliance question is answered in the build.
   - PrivacyInfo.xcprivacy — the privacy manifest App Store Connect requires since May 2024: data the app collects
     (matches the privacy policy) and the "required reason" APIs the web view / Capacitor touch.
   - App.entitlements with aps-environment — push notifications. The capability must ALSO be switched on for the
     App ID in Apple Developer and in Xcode → Signing & Capabilities → "+ Push Notifications" (that step edits the
     project file and is done once, by hand, on the Mac).
   Build numbers: CFBundleShortVersionString / CFBundleVersion from version.json (MARKETING_VERSION in the project
   is left as Xcode manages it; the plist values win for the archive). */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const app = join(dirname(fileURLToPath(import.meta.url)), ".."), ios = join(app, "ios", "App", "App");
const version = JSON.parse(readFileSync(join(app, "version.json"), "utf8"));
const plistPath = join(ios, "Info.plist");
if (!existsSync(plistPath)) { console.error("✗ ios/App/App/Info.plist not found — run \"npx cap add ios\" (on a Mac) first"); process.exit(2); }
let plist = readFileSync(plistPath, "utf8"), changed = [];
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const setString = (key, value) => {
  const re = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`);
  if (re.test(plist)) { const next = plist.replace(re, `$1${esc(value)}$2`); if (next !== plist) { plist = next; changed.push(key); } }
  else { plist = plist.replace(/(\s*)<\/dict>\s*<\/plist>\s*$/, `\n\t<key>${key}</key>\n\t<string>${esc(value)}</string>$1</dict>\n</plist>\n`); changed.push(key); }
};
const setRaw = (key, xml) => { if (new RegExp(`<key>${key}</key>`).test(plist)) return; plist = plist.replace(/(\s*)<\/dict>\s*<\/plist>\s*$/, `\n\t<key>${key}</key>\n\t${xml}$1</dict>\n</plist>\n`); changed.push(key); };

setString("CFBundleShortVersionString", version.versionName);
setString("CFBundleVersion", String(version.versionCode));
setString("NSCameraUsageDescription", "Quriliş Go использует камеру, чтобы сфотографировать товар для поиска или для сообщения о проблеме с заказом. Quriliş Go tovarni qidirish yoki buyurtma muammosi haqida xabar berish uchun kameradan foydalanadi.");
setString("NSPhotoLibraryUsageDescription", "Quriliş Go открывает фото, чтобы найти товар по снимку или приложить его к заказу. Quriliş Go rasm bo‘yicha tovar topish yoki uni buyurtmaga qo‘shish uchun suratlarni ochadi.");
setString("NSLocationWhenInUseUsageDescription", "Quriliş Go определяет ваше местоположение, когда вы открываете карту адреса доставки или магазина, чтобы поставить метку туда, где вы находитесь. Quriliş Go yetkazish manzili yoki do‘kon xaritasini ochganingizda belgini turgan joyingizga qo‘yish uchun joylashuvingizni aniqlaydi.");
setRaw("ITSAppUsesNonExemptEncryption", "<false/>");
setRaw("CFBundleURLTypes", `<array>\n\t\t<dict>\n\t\t\t<key>CFBundleURLName</key>\n\t\t\t<string>uz.imorat.app</string>\n\t\t\t<key>CFBundleURLSchemes</key>\n\t\t\t<array>\n\t\t\t\t<string>imoratgo</string>\n\t\t\t</array>\n\t\t</dict>\n\t</array>`);
writeFileSync(plistPath, plist);

/* privacy manifest: created when the template has none, left alone when it exists */
const privacyPath = join(ios, "PrivacyInfo.xcprivacy");
if (!existsSync(privacyPath)) {
  const type = (t, linked, purposes) => `\t\t<dict>\n\t\t\t<key>NSPrivacyCollectedDataType</key>\n\t\t\t<string>${t}</string>\n\t\t\t<key>NSPrivacyCollectedDataTypeLinked</key>\n\t\t\t<${linked ? "true" : "false"}/>\n\t\t\t<key>NSPrivacyCollectedDataTypeTracking</key>\n\t\t\t<false/>\n\t\t\t<key>NSPrivacyCollectedDataTypePurposes</key>\n\t\t\t<array>\n${purposes.map(p => `\t\t\t\t<string>${p}</string>`).join("\n")}\n\t\t\t</array>\n\t\t</dict>`;
  const api = (t, reasons) => `\t\t<dict>\n\t\t\t<key>NSPrivacyAccessedAPIType</key>\n\t\t\t<string>${t}</string>\n\t\t\t<key>NSPrivacyAccessedAPITypeReasons</key>\n\t\t\t<array>\n${reasons.map(r => `\t\t\t\t<string>${r}</string>`).join("\n")}\n\t\t\t</array>\n\t\t</dict>`;
  const F = "NSPrivacyCollectedDataTypePurposeAppFunctionality";
  writeFileSync(privacyPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>NSPrivacyTracking</key>
\t<false/>
\t<key>NSPrivacyTrackingDomains</key>
\t<array/>
\t<key>NSPrivacyCollectedDataTypes</key>
\t<array>
${[type("NSPrivacyCollectedDataTypePhoneNumber", true, [F]), type("NSPrivacyCollectedDataTypeName", true, [F]), type("NSPrivacyCollectedDataTypePhysicalAddress", true, [F]), type("NSPrivacyCollectedDataTypePreciseLocation", true, [F]), type("NSPrivacyCollectedDataTypePurchaseHistory", true, [F]), type("NSPrivacyCollectedDataTypePhotosorVideos", true, [F]), type("NSPrivacyCollectedDataTypeUserID", true, [F]), type("NSPrivacyCollectedDataTypeDeviceID", true, [F])].join("\n")}
\t</array>
\t<key>NSPrivacyAccessedAPITypes</key>
\t<array>
${[api("NSPrivacyAccessedAPICategoryUserDefaults", ["CA92.1"]), api("NSPrivacyAccessedAPICategoryFileTimestamp", ["C617.1"])].join("\n")}
\t</array>
</dict>
</plist>
`);
  changed.push("PrivacyInfo.xcprivacy");
}

/* push entitlement file (the capability itself is added in Xcode once; see the header comment) */
const entPath = join(ios, "App.entitlements");
if (!existsSync(entPath)) {
  writeFileSync(entPath, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>aps-environment</key>
\t<string>development</string>
</dict>
</plist>
`);
  changed.push("App.entitlements");
}
/* The project must point at the entitlements file — that is what "+ Push Notifications" does in Xcode. Cloud builds create the
   project anew every time, so the build setting is written here (both configurations of the App target). */
const pbxPath = join(app, "ios", "App", "App.xcodeproj", "project.pbxproj");
if (existsSync(pbxPath)) {
  const pbx = readFileSync(pbxPath, "utf8");
  if (!pbx.includes("CODE_SIGN_ENTITLEMENTS")) {
    const next = pbx.replace(/(\n([ \t]*)INFOPLIST_FILE = App\/Info\.plist;)/g, "$1\n$2CODE_SIGN_ENTITLEMENTS = App/App.entitlements;");
    if (next !== pbx) { writeFileSync(pbxPath, next); changed.push("project.pbxproj: CODE_SIGN_ENTITLEMENTS"); }
    else console.warn("! INFOPLIST_FILE = App/Info.plist not found in project.pbxproj — the entitlements file is not wired; add Push Notifications in Xcode");
  }
}
console.log(changed.length ? `ios project patched: ${changed.join(", ")}` : "ios project already up to date");

#!/usr/bin/env bash
# Creates the Android release keystore ONCE, on your own computer (needs Java's keytool — comes with Android Studio),
# and prints what to put into the GitHub secrets. Keep the .jks file and the passwords in a password manager:
# Google Play's "Play App Signing" keeps the final key, but this upload key is what every store build is signed with.
set -euo pipefail
OUT=${1:-imorat-upload.jks}; ALIAS=${2:-imorat}
[ -e "$OUT" ] && { echo "$OUT already exists — not overwriting"; exit 1; }
read -r -s -p "Keystore password (12+ characters): " P1; echo
keytool -genkeypair -v -keystore "$OUT" -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 -storepass "$P1" -keypass "$P1" -dname "CN=Quriliş Go, O=Quriliş Go, L=Tashkent, C=UZ"
echo; echo "GitHub → Settings → Secrets and variables → Actions → New repository secret:"
echo "  ANDROID_KEYSTORE_BASE64   = (contents of $OUT.base64 below)"
echo "  ANDROID_KEYSTORE_PASSWORD = the password you typed"
echo "  ANDROID_KEY_ALIAS         = $ALIAS"
echo "  ANDROID_KEY_PASSWORD      = the same password"
base64 -w0 "$OUT" > "$OUT.base64" 2>/dev/null || base64 -i "$OUT" -o "$OUT.base64"
echo "  → $OUT.base64 written ($(wc -c < "$OUT.base64") chars). Delete it after pasting."
echo; echo "SHA-256 of the upload certificate (Play Console asks for it for App Links / Firebase):"
keytool -list -v -keystore "$OUT" -alias "$ALIAS" -storepass "$P1" | grep SHA256

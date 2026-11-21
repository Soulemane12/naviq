#!/bin/bash
# Builds WornHUD.apk without Gradle (javac + d8 + aapt2), so no 800 MB Gradle sync on venue Wi-Fi.
set -euo pipefail
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$(brew --prefix)/share/android-commandlinetools}"
BT="$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)"
JAR="$SDK/platforms/android-28/android.jar"
[ -f "$JAR" ] || { echo "missing $JAR: run  sdkmanager 'platforms;android-28' 'build-tools;34.0.0'"; exit 1; }

rm -rf build && mkdir -p build/classes
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest AndroidManifest.xml \
  --min-sdk-version 24 --target-sdk-version 28 --version-code 1 --version-name 1.0
javac -nowarn --release 11 -cp "$JAR" -d build/classes $(find src -name '*.java') 2>&1 | grep -v "^warning:\|^Note:" || true
"$BT/d8" --min-api 24 --lib "$JAR" --output build $(find build/classes -name '*.class')
(cd build && zip -qj base.apk classes.dex)
"$BT/zipalign" -f 4 build/base.apk build/aligned.apk
[ -f debug.keystore ] || keytool -genkeypair -keystore debug.keystore -storepass android -alias androiddebugkey \
  -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
"$BT/apksigner" sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android --out WornHUD.apk build/aligned.apk
echo "built $(pwd)/WornHUD.apk"

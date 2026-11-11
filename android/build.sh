#!/usr/bin/env bash
# Сборка APK без Gradle. Нужны: JDK 17+, Android SDK (build-tools 35, platform 35).
#   ANDROID_SDK=/путь/к/sdk KEYSTORE=/путь/к/ключу.jks android/build.sh
# Ключ подписи в репозиторий не кладём: если его нет, создаётся новый.
set -euo pipefail
cd "$(dirname "$0")/.."
SDK="${ANDROID_SDK:?укажи ANDROID_SDK}"
BT="$SDK/build-tools/35.0.0"; JAR="$SDK/platforms/android-35/android.jar"
KS="${KEYSTORE:-android/build/debug.jks}"
OUT=android/build; rm -rf "$OUT/obj" "$OUT/stage"; mkdir -p "$OUT/obj" "$OUT/stage/assets/game" "$OUT/gen"
CODE=$(git rev-list --count HEAD); SHA=$(git log -1 --format=%H -- game)

# игра, зашитая в APK (работает без интернета)
cp -r game/. "$OUT/stage/assets/game/"
echo -n "$SHA" > "$OUT/stage/assets/game/version.txt"

"$BT/aapt2" compile --dir android/res -o "$OUT/res.zip"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" --manifest android/AndroidManifest.xml \
  --min-sdk-version 24 --target-sdk-version 35 --version-code "$CODE" --version-name "0.1.$CODE" \
  --java "$OUT/gen" -A "$OUT/stage/assets" "$OUT/res.zip"
javac -nowarn -source 8 -target 8 -cp "$JAR" -d "$OUT/obj" $(find android/src "$OUT/gen" -name '*.java') 2>&1 | grep -v 'warning\|^Note' || true
"$BT/d8" --release --min-api 24 --lib "$JAR" --output "$OUT" $(find "$OUT/obj" -name '*.class')
(cd "$OUT" && zip -q -j base.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/base.apk" "$OUT/aligned.apk"
[ -f "$KS" ] || keytool -genkeypair -keystore "$KS" -storepass android -keypass android -alias key \
  -keyalg RSA -keysize 2048 -validity 20000 -dname "CN=Bezdna" >/dev/null 2>&1
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android --out "$OUT/bezdna.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/bezdna.apk" && ls -la "$OUT/bezdna.apk"

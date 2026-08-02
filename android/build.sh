#!/usr/bin/env bash
# Сборка KARAT.apk из Kotlin-исходников без Android Studio и без Gradle.
# Нужен только JDK 17+ и интернет (инструменты тянутся с GitHub/npm в ./.tools).
# Запуск: bash build.sh            → android/out/KARAT-3.1.apk
#         bash build.sh test       → только JVM-проверки ядра (без сборки APK)
set -euo pipefail
export LANG=C.UTF-8 LC_ALL=C.UTF-8
cd "$(dirname "$0")"
ROOT=$(pwd)
T="$ROOT/.tools"
OUT="$ROOT/out"
B="$ROOT/build"
mkdir -p "$T" "$OUT" "$B"

KOTLIN_VER=2.4.10       # npm-пакет kotlin-compiler (полный дистрибутив kotlinc)
APKTOOL_VER=3.0.3
SIGNER_VER=1.3.0
PROGUARD_VER=7.9.1
ANDROID_API=34

fetch() { # fetch <url> <файл>
  [ -s "$2" ] || { echo "· качаю $(basename "$2")"; curl -fsSL -o "$2" "$1"; }
}

# ---------------------------------------------------------------- инструменты
fetch "https://registry.npmjs.org/kotlin-compiler/-/kotlin-compiler-$KOTLIN_VER.tgz" "$T/kotlinc.tgz"
[ -x "$T/package/bin/kotlinc" ] || { tar xzf "$T/kotlinc.tgz" -C "$T"; chmod +x "$T"/package/bin/*; }
KOTLINC="$T/package/bin/kotlinc"
STDLIB="$T/package/lib/kotlin-stdlib.jar"

fetch "https://raw.githubusercontent.com/Sable/android-platforms/master/android-$ANDROID_API/android.jar" "$T/android.jar"
fetch "https://github.com/iBotPeaches/Apktool/releases/download/v$APKTOOL_VER/apktool_$APKTOOL_VER.jar" "$T/apktool.jar"
fetch "https://github.com/patrickfav/uber-apk-signer/releases/download/v$SIGNER_VER/uber-apk-signer-$SIGNER_VER.jar" "$T/uber-apk-signer.jar"
fetch "https://github.com/Guardsquare/proguard/releases/download/v$PROGUARD_VER/proguard-$PROGUARD_VER.zip" "$T/proguard.zip"
[ -f "$T/proguard-$PROGUARD_VER/lib/proguard.jar" ] || unzip -qo "$T/proguard.zip" -d "$T"
PROGUARD="$T/proguard-$PROGUARD_VER/lib/proguard.jar"

# dx (Java→DEX) собирается из исходников AOSP: готовых сборок в доступе нет
if [ ! -d "$T/dx-classes" ]; then
  echo "· собираю dx из aosp-mirror/platform_dalvik"
  [ -d "$T/platform_dalvik" ] || git clone -q --depth 1 https://github.com/aosp-mirror/platform_dalvik "$T/platform_dalvik"
  mkdir -p "$T/dx-classes"
  (cd "$T/platform_dalvik/dx" && find src -name '*.java' > "$T/dx.list" &&
   javac -nowarn -source 8 -target 8 -d "$T/dx-classes" "@$T/dx.list" 2>/dev/null)
fi

# stdlib для dx: без module-info и multi-release — dx их не понимает
if [ ! -d "$B/stdlib-clean" ]; then
  mkdir -p "$B/stdlib-clean"
  unzip -qo "$STDLIB" -d "$B/stdlib-clean" -x 'META-INF/versions/*' 'module-info.class'
  rm -rf "$B/stdlib-clean/META-INF/versions" "$B/stdlib-clean/module-info.class"
fi

# ---------------------------------------------------------------- JVM-тесты ядра
if [ "${1:-}" = "test" ]; then
  echo "== тесты ядра (толстый jar)"
  "$KOTLINC" src/core/*.kt src/test/TestMain.kt -include-runtime -d "$B/core-test.jar" 2>&1 | grep -v '^warning:' || true
  K20_JAR="$B/core-test.jar" python3 tests/check_core.py
  exit $?
fi

# ---------------------------------------------------------------- компиляция
echo "== kotlinc"
[ -f src/app/Config.kt ] || { echo "нет src/app/Config.kt — скопируйте из Config.example.kt"; exit 1; }
rm -rf "$B/classes" && "$KOTLINC" -classpath "$T/android.jar" \
  -jvm-target 1.8 -Xlambdas=class -Xsam-conversions=class \
  src/core/*.kt src/app/Config.kt src/app/MainActivity.kt -d "$B/classes" 2>&1 | grep -v '^warning:' || true

# ---------------------------------------------------------------- шринк
# без него dex ~2.7 МБ (вся kotlin-stdlib), с ним ~160 КБ
echo "== proguard"
sed "s#<android_jar>#$T/android.jar#" proguard.cfg > "$B/pg.cfg"
rm -f "$B/app-shrunk.jar"
java -jar "$PROGUARD" @"$B/pg.cfg" -injars "$B/classes" -injars "$B/stdlib-clean" -outjars "$B/app-shrunk.jar"

# ---------------------------------------------------------------- dex
echo "== dx"
java -Xmx3g -cp "$T/dx-classes" com.android.dx.command.Main \
  --dex --min-sdk-version=30 --output="$B/classes.dex" "$B/app-shrunk.jar"

# ---------------------------------------------------------------- упаковка и подпись
echo "== apktool + подпись"
rm -rf "$B/proj" && cp -r apk "$B/proj" && cp "$B/classes.dex" "$B/proj/classes.dex"
java -jar "$T/apktool.jar" b "$B/proj" -o "$B/unsigned.apk"

KEY_DIR="$ROOT/../keys"
[ -f "$KEY_DIR/apk.key" ] || { echo "нет $KEY_DIR/apk.crt|apk.key"; exit 1; }
openssl pkcs12 -export -in "$KEY_DIR/apk.crt" -inkey "$KEY_DIR/apk.key" \
  -name k20 -out "$B/ks.p12" -passout pass:k20pass
rm -rf "$B/signed"
java -jar "$T/uber-apk-signer.jar" --apks "$B/unsigned.apk" --ks "$B/ks.p12" \
  --ksAlias k20 --ksPass k20pass --ksKeyPass k20pass --out "$B/signed"
cp "$B/signed"/*-aligned-signed.apk "$OUT/KARAT-3.1.apk"
rm -f "$B/ks.p12"
echo "готово: out/KARAT-3.1.apk ($(stat -c%s "$OUT/KARAT-3.1.apk") байт)"

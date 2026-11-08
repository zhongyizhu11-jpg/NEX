#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ "$(uname -s)" != Darwin ]]; then
  echo "IPA builds require macOS and Xcode 26+. Use the iOS IPA GitHub Actions workflow." >&2
  exit 1
fi
VERSION="$(node -p "require('./package.json').version")"
BUILD_NUMBER="${IOS_BUILD_NUMBER:-1}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Invalid app version' >&2; exit 1; }
[[ "$BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid build number' >&2; exit 1; }
test -f ios/App/App/public/index.html
xcrun swift scripts/prepare-ios-assets.swift "$ROOT"
mkdir -p ios/build
STAGING="$(mktemp -d "$ROOT/ios/build/ipa.XXXXXX")"
ARCHIVE="$STAGING/NEX.xcarchive"
OUTPUT="$ROOT/ios/build/forwardx-ios-v$VERSION-unsigned.ipa"

# 先单独解析 Swift 包。GitHub 的 macOS 机器上 xcodebuild 解析时会报「failed downloading
# …xcframework.zip … already exists in file system」（2.3.522 的 PR 上 Intel、Apple Silicon 两台都这样）：
# SwiftPM 的二进制包缓存里已经有同名文件，可能是机器镜像里留的旧文件，也可能是同一个包被两处同时下载。
# CI 上先清掉这份缓存；解析失败再试，第二次一般直接用上第一次已经下好的那份。本机打包不清缓存。
if [[ "${CI:-}" == "true" ]]; then
  rm -rf "$HOME/Library/Caches/org.swift.swiftpm"
fi
resolved=false
for attempt in 1 2 3; do
  if xcodebuild -project ios/App/App.xcodeproj -scheme App \
    -derivedDataPath "$STAGING/DerivedData" -resolvePackageDependencies; then
    resolved=true
    break
  fi
  echo "Swift package resolution failed (attempt $attempt of 3)" >&2
  sleep 5
done
[[ "$resolved" == true ]] || { echo 'Swift package resolution failed' >&2; exit 1; }

xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" -derivedDataPath "$STAGING/DerivedData" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  DEVELOPMENT_TEAM= MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  archive

APP="$ARCHIVE/Products/Applications/App.app"
test -f "$APP/Info.plist"
PLIST=/usr/libexec/PlistBuddy
[[ "$("$PLIST" -c 'Print :CFBundleSupportedPlatforms:0' "$APP/Info.plist")" == iPhoneOS ]]
[[ "$("$PLIST" -c 'Print :CFBundleShortVersionString' "$APP/Info.plist")" == "$VERSION" ]]
EXECUTABLE="$("$PLIST" -c 'Print :CFBundleExecutable' "$APP/Info.plist")"
xcrun lipo "$APP/$EXECUTABLE" -verify_arch arm64
test ! -f "$APP/embedded.mobileprovision"
mkdir -p "$STAGING/Payload"
ditto "$APP" "$STAGING/Payload/App.app"
# This is intentionally not an App Store export: the recipient signs the entire app.
ditto -c -k --sequesterRsrc --keepParent "$STAGING/Payload" "$OUTPUT"
unzip -t "$OUTPUT"
(cd ios/build && shasum -a 256 "$(basename "$OUTPUT")" > "$(basename "$OUTPUT").sha256")
echo "Unsigned IPA (re-sign before installing): $OUTPUT"

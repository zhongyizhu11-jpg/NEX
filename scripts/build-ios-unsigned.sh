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

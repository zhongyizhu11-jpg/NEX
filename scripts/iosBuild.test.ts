import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import config from '../capacitor.config';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('client module names do not collide on case-insensitive macOS filesystems', () => {
  const names = new Map<string, string>();
  for (const path of readdirSync(new URL('../client/src', import.meta.url), { recursive: true })) {
    const name = String(path);
    if (!/\.tsx?$/.test(name)) continue;
    const key = name.replace(/\.tsx?$/, '').toLowerCase();
    assert.ok(!names.has(key), `${name} conflicts with ${names.get(key)}`);
    names.set(key, name);
  }
});

test('iOS and Android retain the same app identity and web assets', () => {
  assert.equal(config.appId, 'com.forwardx.app');
  assert.equal(config.webDir, 'client/dist');
  assert.equal(config.server?.androidScheme, 'http');
  assert.equal(config.ios?.contentInset, 'never');
  assert.match(read('ios/App/App/ForwardXViewController.swift'), /allowsBackForwardNavigationGestures = true/);
  assert.match(read('index.html'), /viewport-fit=cover/);
  assert.match(read('index.html'), /maximum-scale=1/);
});

test('iOS runtime is pinned to the existing Capacitor runtime', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = read('pnpm-lock.yaml');
  assert.equal(pkg.dependencies['@capacitor/ios'], '8.4.3');
  assert.match(lock, /'@capacitor\/ios@8\.4\.3\(@capacitor\/core@8\.4\.3\)'/);
  assert.match(read('ios/App/CapApp-SPM/Package.swift'), /exact: "8\.4\.3"/);
  assert.match(read('ios/App/CapApp-SPM/Package.swift'), /CapacitorPreferences/);
});

test('IPA script archives a device app without credentials and validates its contents', () => {
  const script = read('scripts/build-ios-unsigned.sh');
  assert.equal(spawnSync('bash', ['-n', 'scripts/build-ios-unsigned.sh']).status, 0);
  for (const expected of ['generic/platform=iOS', 'CODE_SIGNING_ALLOWED=NO',
    'lipo "$APP/$EXECUTABLE" -verify_arch arm64', 'CFBundleSupportedPlatforms:0', 'embedded.mobileprovision',
    'Payload/App.app', 'unzip -t', 'shasum -a 256']) {
    assert.ok(script.includes(expected), expected);
  }
  assert.doesNotMatch(script, /allowProvisioningUpdates|exportArchive/);
});

test('iOS credentials and build outputs are never committed', () => {
  const workflow = read('.github/workflows/ios-ipa.yml');
  assert.doesNotMatch(workflow, /secrets\./);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /if: github.ref_type == 'tag'/);
  assert.match(read('ios/.gitignore'), /App\/App\/public/);
  assert.match(read('.gitignore'), /ios\/build\//);
});

test('network exception is WebView-only and Preferences privacy reason is included', () => {
  const plist = read('ios/App/App/Info.plist');
  assert.match(plist, /NSAllowsArbitraryLoadsInWebContent/);
  assert.doesNotMatch(plist, /<key>NSAllowsArbitraryLoads<\/key>/);
  assert.match(plist, /NSLocalNetworkUsageDescription/);
  assert.match(read('ios/App/App/PrivacyInfo.xcprivacy'), /CA92\.1/);
  assert.match(read('ios/App/App.xcodeproj/project.pbxproj'), /PrivacyInfo.xcprivacy in Resources/);
});

test('ProMotion: the app may draw above 60Hz and asks WebKit not to cap page updates at 60fps', () => {
  assert.match(read('ios/App/App/Info.plist'), /<key>CADisableMinimumFrameDurationOnPhone<\/key>\s*<true\/>/);
  const controller = read('ios/App/App/ForwardXViewController.swift');
  assert.match(controller, /_setPreferPageRenderingUpdatesNear60FPSEnabled:/);
  // private setter must be guarded so an older / newer WebKit without it cannot crash the app
  assert.match(controller, /responds\(to: selector\)/);
});
